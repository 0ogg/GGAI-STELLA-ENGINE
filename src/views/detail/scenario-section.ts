import { Menu, Notice, setIcon } from "obsidian";
import type StellaEnginePlugin from "../../main";
import type {
  StellaScenario,
  StellaScenarioExtension,
} from "../../types/scenario";
import type { StellaSession } from "../../types/session";
import { buildSessionContextDryRun } from "../../util/build-session-context";
import type { LorebookListItem } from "../../util/scan-lorebooks";
import { uuidv4 } from "../../util/uuid";
import { ContextPreviewModal } from "../context-preview-modal";
import { collectSeriesRoute, openSessionByPath } from "../entity-actions";
import { NextEpisodeModal } from "../next-episode-modal";
import type { SessionListItem } from "../../util/scan-sessions";
import { EditGuard } from "../edit-guard";
import { LorebookSelectModal } from "../lorebook-select-modal";
import { getSessionHostLeaves, isSessionHostView } from "../session-host";

const DEBOUNCE_MS = 400;

export interface ScenarioSectionUiState {
  sessionFieldsCollapsed: boolean;
  sessionLorebookCollapsed: boolean;
  formCollapsed: boolean;
  seriesCollapsed: boolean;
}

/**
 * ScenarioSection — 우측 사이드바 "시나리오" 탭.
 *
 *  - 메모리 / 작가노트 (세션 메타) — 메인. textarea, debounced 자동 저장.
 *  - 세션 로어북 — 접힘. 시나리오 연결 로어북 on/off + 세션 전용 로어북 추가.
 *
 * 활성 세션 의존: 세션이 없으면 "세션을 열어주세요" placeholder 만 노출.
 */
export class ScenarioSection {
  private root: HTMLElement;

  private activeSessionFile: string | null;
  private scenarioFile: string | null = null;
  private scenario: StellaScenario | null = null;
  private session: StellaSession | null = null;

  private memoryEl: HTMLTextAreaElement | null = null;
  private authorNoteEl: HTMLTextAreaElement | null = null;
  private sessionFieldsCollapsed = false;
  private sessionFieldsBodyEl: HTMLElement | null = null;
  private formEls: Partial<Record<ScenarioField, HTMLTextAreaElement>> = {};
  private formCollapsed = true;
  private formBodyEl: HTMLElement | null = null;
  private formHeaderEl: HTMLElement | null = null;
  private sessionLorebookCollapsed = true;
  private sessionLorebookBodyEl: HTMLElement | null = null;
  private seriesCollapsed = false;
  private seriesBodyEl: HTMLElement | null = null;
  /** 시리즈 화 목록 영역 — 부분 갱신용. */
  private seriesAreaEl: HTMLElement | null = null;

  /** 시나리오 폼 안의 로어북 영역 — 부분 갱신용. */
  private lorebookAreaEl: HTMLElement | null = null;
  /** 메모리/작가노트 옆의 "이 세션의 로어북" 영역 — 부분 갱신용. */
  private sessionLorebookAreaEl: HTMLElement | null = null;
  private lorebooks: LorebookListItem[] = [];

  private sessionSaveTimer: number | null = null;
  private sessionPending: { memory?: string; authorNote?: string } = {};
  private scenarioSaveTimer: number | null = null;
  private scenarioPending: Partial<Record<ScenarioField, string>> = {};
  /** 조합/포커스/자기저장 공용 가드 — 복붙 금지, edit-guard.ts 참조. */
  private guard = new EditGuard();

  constructor(
    container: HTMLElement,
    private plugin: StellaEnginePlugin,
    activeSessionFile: string | null,
    uiState?: Partial<ScenarioSectionUiState>
  ) {
    this.root = container.createDiv({ cls: "ggai-scenario-section" });
    this.guard.attach(this.root);
    this.activeSessionFile = activeSessionFile;
    if (uiState?.sessionFieldsCollapsed !== undefined) {
      this.sessionFieldsCollapsed = uiState.sessionFieldsCollapsed;
    }
    if (uiState?.sessionLorebookCollapsed !== undefined) {
      this.sessionLorebookCollapsed = uiState.sessionLorebookCollapsed;
    }
    if (uiState?.formCollapsed !== undefined) {
      this.formCollapsed = uiState.formCollapsed;
    }
    if (uiState?.seriesCollapsed !== undefined) {
      this.seriesCollapsed = uiState.seriesCollapsed;
    }
  }

  getUiState(): ScenarioSectionUiState {
    return {
      sessionFieldsCollapsed: this.sessionFieldsCollapsed,
      sessionLorebookCollapsed: this.sessionLorebookCollapsed,
      formCollapsed: this.formCollapsed,
      seriesCollapsed: this.seriesCollapsed,
    };
  }

  /** 전체 접기/펼치기 — 세션/로어북/시리즈/시나리오 접이식 섹션을 함께 접거나 편다. */
  setCollapsed(v: boolean): void {
    this.sessionFieldsCollapsed = v;
    this.sessionLorebookCollapsed = v;
    this.formCollapsed = v;
    this.seriesCollapsed = v;
    for (const body of [
      this.sessionFieldsBodyEl,
      this.sessionLorebookBodyEl,
      this.formBodyEl,
      this.seriesBodyEl,
    ]) {
      if (!body) continue;
      body.toggleClass("is-collapsed", v);
      const header = body.parentElement?.querySelector(".ggai-section-header");
      header?.setAttr("aria-expanded", String(!v));
    }
  }

  async load(): Promise<void> {
    await this.resolveActive();
    this.render();
  }

  setActiveSessionFile(file: string | null): void {
    this.flush();
    const same = file === this.activeSessionFile;
    this.activeSessionFile = file;
    void (async () => {
      await this.resolveActive();
      if (same) {
        this.renderLorebookArea();
        this.renderSessionLorebookArea();
      } else {
        this.render();
      }
    })();
  }

  async refreshSession(): Promise<void> {
    if (!this.activeSessionFile) return;
    // 자기 저장이 발행한 session-changed 는 건드리지 않는다. IME 조합 중에도
    // textarea 를 덮어쓰지 않는다 (조합 중 포커스가 순간 흔들려 activeElement
    // 체크만으로는 못 막음 — EditGuard 공용 가드).
    if (this.guard.isSavingSelf || this.guard.isComposing) return;
    const session = await this.plugin.store.getSession(this.activeSessionFile);
    if (!session) return;
    this.session = session;
    this.syncTextArea(
      this.memoryEl,
      session.meta.memory ?? "",
      this.sessionPending.memory
    );
    this.syncTextArea(
      this.authorNoteEl,
      session.meta.authorNote ?? "",
      this.sessionPending.authorNote
    );
    this.renderSessionLorebookArea();
    void this.renderSeriesArea();
  }

  /** 미적용 debounce 즉시 저장. */
  flush(): void {
    if (this.sessionSaveTimer != null) {
      window.clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
      void this.persistSessionNow();
    }
    if (this.scenarioSaveTimer != null) {
      window.clearTimeout(this.scenarioSaveTimer);
      this.scenarioSaveTimer = null;
      void this.persistScenarioNow();
    }
  }

  // ─── load ──────────────────────────────────────────────────────────

  private async resolveActive(): Promise<void> {
    this.scenarioFile = null;
    this.scenario = null;
    this.session = null;
    if (!this.activeSessionFile) return;
    const sf = scenarioFileOfSessionFile(this.activeSessionFile);
    if (sf) {
      const scenarios = await this.plugin.store.refreshScenarios();
      const item = scenarios.find((i) => i.scenarioFile === sf);
      if (item) {
        this.scenarioFile = sf;
        this.scenario = item.scenario;
      }
    }
    this.session = await this.plugin.store.refreshSession(this.activeSessionFile);
    this.lorebooks = await this.plugin.store.refreshLorebooks().catch(() => []);
  }

  /**
   * 외부 변경을 textarea 에 반영 — 편집을 지키는 쪽이 우선이다.
   * 포커스 중이거나, 아직 저장 안 된 입력(pending)이 있으면 디스크 값으로 덮지 않는다.
   */
  private syncTextArea(
    el: HTMLTextAreaElement | null,
    value: string,
    pending: string | undefined
  ): void {
    if (!el || document.activeElement === el) return;
    if (pending !== undefined) return;
    if (el.value !== value) el.value = value;
  }

  /** 외부에서 로어북 목록이 바뀌었을 때 — 두 영역 모두 부분 갱신. */
  async refreshLorebooks(): Promise<void> {
    this.lorebooks = await this.plugin.store.refreshLorebooks().catch(() => []);
    this.renderLorebookArea();
    this.renderSessionLorebookArea();
  }

  // ─── render ────────────────────────────────────────────────────────

  private render(): void {
    this.root.empty();
    this.memoryEl = null;
    this.authorNoteEl = null;
    this.sessionFieldsBodyEl = null;
    this.formEls = {};
    this.formBodyEl = null;
    this.formHeaderEl = null;
    this.sessionLorebookAreaEl = null;
    this.sessionLorebookBodyEl = null;
    this.lorebookAreaEl = null;
    this.seriesBodyEl = null;
    this.seriesAreaEl = null;

    if (!this.activeSessionFile) {
      this.root.createDiv({
        cls: "ggai-detail-empty",
        text: "세션을 열어주세요.",
      });
      return;
    }

    this.renderSessionFields();
    this.renderSessionLorebookSection();
    this.renderSeriesSection();
  }

  /**
   * 시리즈 섹션 — 시나리오 탭 맨 아래 접이식 섹션 (다른 섹션과 같은 형식).
   * 이 세션이 속한 시리즈의 화 목록(1화·2화·…)을 순서대로 보여주고 클릭으로 이동,
   * [다음화 만들기]는 세부 설정·인계 안내가 있는 NextEpisodeModal 을 연다.
   */
  private renderSeriesSection(): void {
    if (!this.session || !this.activeSessionFile) return;
    const sessionFile = this.activeSessionFile;
    const section = this.root.createDiv({
      cls: "ggai-series-section ggai-collapsible",
    });
    const header = section.createDiv({ cls: "ggai-section-header is-clickable" });
    header.createSpan({ cls: "ggai-section-title", text: "시리즈" });
    header.setAttr("role", "button");
    header.setAttr("tabindex", "0");
    header.setAttr("aria-expanded", String(!this.seriesCollapsed));
    const toggle = () => {
      this.seriesCollapsed = !this.seriesCollapsed;
      this.seriesBodyEl?.toggleClass("is-collapsed", this.seriesCollapsed);
      header.setAttr("aria-expanded", String(!this.seriesCollapsed));
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    });
    const body = section.createDiv({ cls: "ggai-series-body" });
    body.toggleClass("is-collapsed", this.seriesCollapsed);
    this.seriesBodyEl = body;

    this.seriesAreaEl = body.createDiv({ cls: "ggai-series-area" });
    void this.renderSeriesArea();

    const actions = body.createDiv({ cls: "ggai-series-actions" });
    const btn = actions.createEl("button", { cls: "ggai-btn" });
    setIcon(btn.createSpan(), "book-plus");
    btn.createSpan({ text: "다음화 만들기" });
    btn.addEventListener("click", () => {
      new NextEpisodeModal(this.plugin.app, this.plugin, sessionFile).open();
    });
    body.createDiv({
      cls: "ggai-series-hint",
      text: "세션이 길어져 무거워지면, 누적 요약과 최근 본문을 물려받은 다음 화로 가볍게 이어가세요.",
    });
  }

  /** 화 목록만 부분 갱신 — 새 화 생성/이름변경 등 sessions-changed 반영용. */
  async renderSeriesArea(): Promise<void> {
    const el = this.seriesAreaEl;
    if (!el || !this.session || !this.activeSessionFile) return;
    el.empty();
    const series = this.session.meta.series;
    if (!series) {
      el.createDiv({
        cls: "ggai-series-empty",
        text: "아직 단독 세션입니다. 다음화를 만들면 이 세션이 1화가 됩니다.",
      });
      return;
    }
    const scenarioFolder = this.activeSessionFile.split("/SESSIONS/")[0];
    const siblings = await this.plugin.store
      .getSessions(scenarioFolder)
      .catch((): SessionListItem[] => []);
    const episodes = siblings.filter(
      (it) => it.session.meta.series?.id === series.id
    );
    // 현재 세션이 속한 루트만 화 순서대로 — 같은 화 번호가 여럿(루트 분기)이면
    // 칩에 개수를 표시하고, 클릭 시 루트 선택 메뉴를 연다.
    const route = collectSeriesRoute(this.activeSessionFile, episodes);
    const byIndex = new Map<number, SessionListItem[]>();
    for (const ep of episodes) {
      const idx = ep.session.meta.series?.index ?? 0;
      const list = byIndex.get(idx) ?? [];
      list.push(ep);
      byIndex.set(idx, list);
    }
    el.createDiv({ cls: "ggai-series-name", text: series.name });
    const chips = el.createDiv({ cls: "ggai-series-chips" });
    for (const ep of route) {
      const idx = ep.session.meta.series?.index ?? 0;
      const alts = byIndex.get(idx) ?? [ep];
      const isCurrent = ep.sessionFile === this.activeSessionFile;
      const chip = chips.createEl("button", { cls: "ggai-series-chip" });
      chip.createSpan({ text: `${idx}화` });
      if (isCurrent) chip.addClass("is-current");
      if (alts.length > 1) {
        chip.createSpan({
          cls: "ggai-series-chip-count",
          text: String(alts.length),
        });
        chip.title = `${ep.session.meta.name || ep.folderName} — 루트 ${alts.length}개, 클릭해서 선택`;
        chip.addEventListener("click", (e) => {
          const menu = new Menu();
          for (const alt of alts) {
            const onRoute = alt.sessionFile === ep.sessionFile;
            menu.addItem((mi) => {
              mi.setTitle(alt.session.meta.name || alt.folderName).setChecked(
                onRoute
              );
              if (alt.sessionFile !== this.activeSessionFile) {
                mi.onClick(() =>
                  void openSessionByPath(this.plugin, alt.sessionFile)
                );
              }
            });
          }
          menu.showAtMouseEvent(e);
        });
      } else {
        chip.title = ep.session.meta.name || ep.folderName;
        if (isCurrent) {
          chip.disabled = true;
        } else {
          chip.addEventListener("click", () =>
            void openSessionByPath(this.plugin, ep.sessionFile)
          );
        }
      }
    }
  }

  private renderSessionFields(): void {
    const session = this.session;
    if (!session) return;

    const section = this.root.createDiv({
      cls: "ggai-session-meta-section ggai-collapsible",
    });
    const header = section.createDiv({ cls: "ggai-section-header is-clickable" });
    header.createSpan({ cls: "ggai-section-title", text: "세션" });
    header.setAttr("role", "button");
    header.setAttr("tabindex", "0");
    header.setAttr("aria-expanded", String(!this.sessionFieldsCollapsed));
    const toggle = () => {
      this.sessionFieldsCollapsed = !this.sessionFieldsCollapsed;
      this.sessionFieldsBodyEl?.toggleClass(
        "is-collapsed",
        this.sessionFieldsCollapsed
      );
      header.setAttr("aria-expanded", String(!this.sessionFieldsCollapsed));
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    });
    const body = section.createDiv({ cls: "ggai-session-meta-body" });
    body.toggleClass("is-collapsed", this.sessionFieldsCollapsed);
    this.sessionFieldsBodyEl = body;

    // [현재 컨텍스트 확인] — 메모리 위에 단독 버튼.
    const ctxBtnRow = body.createDiv({ cls: "ggai-ctx-button-row" });
    const ctxBtn = ctxBtnRow.createEl("button", {
      cls: "ggai-btn",
    });
    setIcon(ctxBtn, "search");
    ctxBtn.createSpan({ text: "현재 컨텍스트 확인" });
    ctxBtn.title = "AI 에 보낼 최종 메시지를 미리 봅니다.";
    ctxBtn.addEventListener("click", () => void this.handleShowContext());

    const roleWrap = body.createDiv({ cls: "ggai-text-field ggai-role-mode-field" });
    roleWrap.createDiv({
      cls: "ggai-text-field-label",
      text: "챗컴플리션 본문 롤",
    });
    roleWrap.createDiv({
      cls: "ggai-text-field-hint",
      text: "끄면 NovelAI처럼 본문을 하나로 합치고, 켜면 assistant/user 롤을 나눠 보냅니다.",
    });
    const roleRow = roleWrap.createDiv({ cls: "ggai-lorebook-checklist-row" });
    const roleCb = roleRow.createEl("input", { type: "checkbox" });
    roleCb.checked = session.meta.novelChatRoleMode === "split";
    const roleLabel = roleRow.createSpan({
      cls: "ggai-lorebook-checklist-label",
      text: "assistant/user 롤 분리",
    });
    const roleHandler = () =>
      void this.handleToggleNovelChatRoleMode(roleCb.checked);
    roleCb.addEventListener("change", roleHandler);
    roleLabel.addEventListener("click", () => {
      roleCb.checked = !roleCb.checked;
      roleHandler();
    });

    this.memoryEl = this.makeTextField(
      body,
      "메모리",
      "chatHistory 앞에 system 으로 삽입.",
      session.meta.memory ?? "",
      (v) => this.queueSession({ memory: v })
    );
    this.authorNoteEl = this.makeTextField(
      body,
      "작가노트",
      "본문 끝에서 4번째 문단 앞에 system 으로 삽입 (본문이 4문단 이하면 맨 앞).",
      session.meta.authorNote ?? "",
      (v) => this.queueSession({ authorNote: v })
    );
  }

  /**
   * "이 세션의 로어북" 영역 컨테이너 + 첫 렌더.
   * 시나리오에서 온 책들 (default + extra) 을 토글로 끄거나, 시나리오와 무관한 책을 추가할 수 있다.
   */
  private renderSessionLorebookSection(): void {
    if (!this.session) return;
    if (!this.sessionLorebookAreaEl) {
      this.sessionLorebookAreaEl = this.root.createDiv({
        cls: "ggai-session-lorebook-section ggai-collapsible",
      });
    }
    this.sessionLorebookAreaEl.empty();
    const header = this.sessionLorebookAreaEl.createDiv({
      cls: "ggai-section-header is-clickable",
    });
    header.createSpan({ cls: "ggai-section-title", text: "이 세션의 로어북" });
    header.setAttr("role", "button");
    header.setAttr("tabindex", "0");
    header.setAttr("aria-expanded", String(!this.sessionLorebookCollapsed));
    const toggle = () => {
      this.sessionLorebookCollapsed = !this.sessionLorebookCollapsed;
      this.sessionLorebookBodyEl?.toggleClass(
        "is-collapsed",
        this.sessionLorebookCollapsed
      );
      header.setAttr("aria-expanded", String(!this.sessionLorebookCollapsed));
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    });
    this.sessionLorebookBodyEl = this.sessionLorebookAreaEl.createDiv({
      cls: "ggai-session-lorebook-body",
    });
    this.sessionLorebookBodyEl.toggleClass(
      "is-collapsed",
      this.sessionLorebookCollapsed
    );
    this.renderSessionLorebookArea();
  }

  /** 세션 로어북 영역 부분 갱신 — textarea 포커스 보존. */
  private renderSessionLorebookArea(): void {
    const wrap = this.sessionLorebookBodyEl;
    const session = this.session;
    const scenario = this.scenario;
    if (!wrap || !session) return;
    wrap.empty();

    const stella = scenario?.data?.extensions?.stella;
    const scenarioIds: string[] = [];
    if (stella?.defaultLorebookId) scenarioIds.push(stella.defaultLorebookId);
    for (const id of stella?.extraLorebookIds ?? []) {
      if (!scenarioIds.includes(id)) scenarioIds.push(id);
    }
    const disabled = new Set(session.meta.disabledScenarioLorebookIds ?? []);
    const sessionExtra = new Set(session.meta.extraLorebookIds ?? []);

    // ─── 시나리오에서 온 책들 (on/off 토글) ───
    const fromScenarioWrap = wrap.createDiv({
      cls: "ggai-session-lorebook-group",
    });
    fromScenarioWrap.createDiv({
      cls: "ggai-text-field-label",
      text: "시나리오에서",
    });
    const scenarioListEl = fromScenarioWrap.createDiv({
      cls: "ggai-lorebook-checklist",
    });
    if (scenarioIds.length === 0) {
      scenarioListEl.createDiv({
        cls: "ggai-detail-empty",
        text: "시나리오에 연결된 로어북이 없습니다.",
      });
    } else {
      for (const id of scenarioIds) {
        const item = this.lorebooks.find((l) => l.lorebook.meta.id === id);
        const name = item?.lorebook.meta.name ?? "(삭제됨)";
        const row = scenarioListEl.createDiv({ cls: "ggai-lorebook-checklist-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = !disabled.has(id);
        if (!item) cb.disabled = true;
        const label = row.createSpan({
          cls: "ggai-lorebook-checklist-label",
          text: name,
        });
        if (!item) label.addClass("is-faint");
        const handler = () =>
          void this.handleToggleScenarioLorebook(id, cb.checked);
        cb.addEventListener("change", handler);
        if (item) {
          label.addEventListener("click", () => {
            cb.checked = !cb.checked;
            handler();
          });
        }
      }
    }

    // ─── 시나리오와 무관한 책 추가 — 클릭하면 모달에서 선택 ───
    const addWrap = wrap.createDiv({ cls: "ggai-session-lorebook-group" });
    addWrap.createDiv({
      cls: "ggai-text-field-label",
      text: "이 세션만 추가",
    });
    const count = sessionExtra.size;
    const btn = addWrap.createEl("button", {
      cls: "ggai-preset-btn ggai-media-lorebook-btn",
      text: count > 0 ? `로어북 ${count}개 선택됨` : "로어북 선택",
    });
    if (count > 0) btn.addClass("is-active");
    btn.addEventListener("click", () => {
      void LorebookSelectModal.open(this.plugin, [...sessionExtra], {
        title: "이 세션에 추가할 로어북",
        excludeIds: scenarioIds,
      }).then((ids) => {
        if (ids) void this.handleSetSessionExtraLorebooks(ids);
      });
    });

    this.renderMediaLorebookGroups(wrap);
  }

  /**
   * 번역/삽화 확장용 로어북 — **시나리오에 저장되어 이 시나리오의 모든 세션이 공유**한다.
   * 각 기능 사용이 켜져 있을 때만 노출. 실행 시 확장 설정 패널의 로어북 선택
   * (활성 설정)과 합쳐(중복 제거) 적용된다.
   */
  private renderMediaLorebookGroups(wrap: HTMLElement): void {
    const session = this.session;
    const scenario = this.scenario;
    if (!session || !scenario) return;
    const stella = scenario.data?.extensions?.stella;

    const groups: Array<{
      key: "translationLorebookIds" | "illustrationLorebookIds";
      label: string;
      enabled: boolean;
      ids: string[];
    }> = [
      {
        key: "translationLorebookIds",
        label: "번역 로어북",
        enabled: session.meta.translation?.enabled === true,
        ids: stella?.translationLorebookIds ?? [],
      },
      {
        key: "illustrationLorebookIds",
        label: "삽화 로어북",
        enabled: session.meta.illustration?.enabled === true,
        ids: stella?.illustrationLorebookIds ?? [],
      },
    ];

    for (const g of groups) {
      if (!g.enabled) continue;
      const groupEl = wrap.createDiv({ cls: "ggai-session-lorebook-group" });
      groupEl.createDiv({
        cls: "ggai-text-field-label",
        text: `${g.label} (시나리오 공유)`,
      });
      const btn = groupEl.createEl("button", {
        cls: "ggai-preset-btn ggai-media-lorebook-btn",
        text: g.ids.length > 0 ? `로어북 ${g.ids.length}개 선택됨` : "로어북 선택",
      });
      if (g.ids.length > 0) btn.addClass("is-active");
      btn.addEventListener("click", () => {
        void LorebookSelectModal.open(this.plugin, [...g.ids], {
          title: `${g.label} 선택 (이 시나리오의 모든 세션 공유)`,
        }).then((ids) => {
          if (ids) void this.handleSetScenarioMediaLorebooks(g.key, ids);
        });
      });
    }
  }

  private async handleSetScenarioMediaLorebooks(
    key: "translationLorebookIds" | "illustrationLorebookIds",
    ids: string[]
  ): Promise<void> {
    const file = this.scenarioFile;
    const scenario = this.scenario;
    if (!file || !scenario) return;
    const ext = ensureStellaExt(scenario);
    ext[key] = ids.length > 0 ? ids : undefined;
    try {
      await this.plugin.store.saveScenario(file, scenario);
      this.renderSessionLorebookArea(); // 버튼 카운트 갱신
    } catch (err) {
      console.warn("[GGAI Stella] 미디어 로어북 저장 실패:", err);
      new Notice(`저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleToggleScenarioLorebook(
    id: string,
    on: boolean
  ): Promise<void> {
    const file = this.activeSessionFile;
    if (!file) return;
    try {
      const session = await this.plugin.store.getSession(file);
      if (!session) return;
      const set = new Set(session.meta.disabledScenarioLorebookIds ?? []);
      // on = 활성 = disabled 에서 제거. off = 비활성 = disabled 에 추가.
      if (on) set.delete(id);
      else set.add(id);
      session.meta.disabledScenarioLorebookIds =
        set.size > 0 ? Array.from(set) : undefined;
      await this.plugin.store.saveSession(file, session);
      this.session = session;
    } catch (err) {
      console.warn("[GGAI Stella] 시나리오 로어북 토글 실패:", err);
      new Notice(`저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleSetSessionExtraLorebooks(ids: string[]): Promise<void> {
    const file = this.activeSessionFile;
    if (!file) return;
    try {
      const session = await this.plugin.store.getSession(file);
      if (!session) return;
      session.meta.extraLorebookIds = ids.length > 0 ? ids : undefined;
      await this.plugin.store.saveSession(file, session);
      this.session = session;
      this.renderSessionLorebookArea(); // 버튼 카운트 갱신
    } catch (err) {
      console.warn("[GGAI Stella] 세션 추가 로어북 저장 실패:", err);
      new Notice(`저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private renderScenarioForm(): void {
    const form = this.root.createDiv({ cls: "ggai-collapsible" });

    const header = form.createDiv({ cls: "ggai-section-header is-clickable" });
    header.createSpan({ cls: "ggai-section-title", text: "시나리오" });
    header.setAttr("role", "button");
    header.setAttr("tabindex", "0");
    header.setAttr("aria-expanded", String(!this.formCollapsed));
    const toggle = () => {
      this.formCollapsed = !this.formCollapsed;
      this.formBodyEl?.toggleClass("is-collapsed", this.formCollapsed);
      header.setAttr("aria-expanded", String(!this.formCollapsed));
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    });
    this.formHeaderEl = header;

    const body = form.createDiv({ cls: "ggai-scenario-form-body" });
    body.toggleClass("is-collapsed", this.formCollapsed);
    this.formBodyEl = body;

    if (!this.scenario || !this.scenarioFile) {
      body.createDiv({
        cls: "ggai-detail-empty",
        text: "시나리오를 찾을 수 없습니다.",
      });
      return;
    }

    // 복사 버튼
    const actions = body.createDiv({ cls: "ggai-scenario-form-actions" });
    const copyBtn = actions.createEl("button", {
      cls: "ggai-btn",
      text: "복제 (현재 세션을 새 시나리오로)",
    });
    copyBtn.addEventListener("click", () => void this.handleCopy());

    // 로어북 영역 — 기본 1개 + 추가 N개. 부분 갱신을 위해 별도 컨테이너.
    this.lorebookAreaEl = body.createDiv({ cls: "ggai-scenario-lorebooks" });
    this.renderLorebookArea();

    const data = this.scenario.data;
    for (const f of SCENARIO_FIELDS) {
      const initial = ((data as any)[f.key] as string | undefined) ?? "";
      const el = this.makeTextField(
        body,
        f.label,
        null,
        initial,
        (v) => this.queueScenario(f.key, v),
        f.rows
      );
      this.formEls[f.key] = el;
    }
  }

  /**
   * 시나리오 폼 안의 "기본 로어북" 드롭다운 + "추가 로어북" 체크리스트.
   * 기본으로 선택된 책은 추가 리스트에서 제외 (중복 방지 + UX 단순).
   */
  private renderLorebookArea(): void {
    const wrap = this.lorebookAreaEl;
    if (!wrap || !this.scenario) return;
    wrap.empty();

    const ext = this.scenario.data.extensions?.stella;
    const defaultId = ext?.defaultLorebookId ?? "";
    const extraIds = new Set(ext?.extraLorebookIds ?? []);

    // 기본 로어북 드롭다운
    const defWrap = wrap.createDiv({ cls: "ggai-text-field" });
    defWrap.createDiv({ cls: "ggai-text-field-label", text: "기본 로어북" });
    const select = defWrap.createEl("select", { cls: "ggai-select" });
    const noneOpt = select.createEl("option", { text: "(없음)" });
    noneOpt.value = "";
    if (!defaultId) noneOpt.selected = true;
    for (const item of this.lorebooks) {
      const meta = item.lorebook.meta;
      const opt = select.createEl("option", {
        text: meta.name || "(이름 없음)",
      });
      opt.value = meta.id;
      if (meta.id === defaultId) opt.selected = true;
    }
    select.addEventListener("change", () =>
      void this.handleSetDefaultLorebook(select.value)
    );

    // 추가 로어북 — 클릭하면 모달에서 선택 (기본 로어북은 제외).
    wrap.createDiv({ cls: "ggai-text-field-label", text: "추가 로어북" });
    const count = extraIds.size;
    const btn = wrap.createEl("button", {
      cls: "ggai-preset-btn ggai-media-lorebook-btn",
      text: count > 0 ? `로어북 ${count}개 선택됨` : "로어북 선택",
    });
    if (count > 0) btn.addClass("is-active");
    btn.addEventListener("click", () => {
      void LorebookSelectModal.open(this.plugin, [...extraIds], {
        title: "추가 로어북 선택",
        excludeIds: defaultId ? [defaultId] : [],
      }).then((ids) => {
        if (ids) void this.handleSetExtraLorebooks(ids);
      });
    });
  }

  private async handleSetDefaultLorebook(id: string): Promise<void> {
    const file = this.scenarioFile;
    const scenario = this.scenario;
    if (!file || !scenario) return;
    const ext = ensureStellaExt(scenario);
    ext.defaultLorebookId = id || undefined;
    // default 로 옮긴 책이 extra 에 있었다면 제거 (중복 방지).
    if (id && Array.isArray(ext.extraLorebookIds)) {
      ext.extraLorebookIds = ext.extraLorebookIds.filter((x) => x !== id);
    }
    try {
      await this.plugin.store.saveScenario(file, scenario);
      this.renderLorebookArea(); // 추가 리스트에서 default 제외 반영
    } catch (err) {
      console.warn("[GGAI Stella] 기본 로어북 저장 실패:", err);
      new Notice(`저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleSetExtraLorebooks(ids: string[]): Promise<void> {
    const file = this.scenarioFile;
    const scenario = this.scenario;
    if (!file || !scenario) return;
    const ext = ensureStellaExt(scenario);
    ext.extraLorebookIds = ids.length > 0 ? ids : undefined;
    try {
      await this.plugin.store.saveScenario(file, scenario);
      this.renderLorebookArea(); // 버튼 카운트 갱신
    } catch (err) {
      console.warn("[GGAI Stella] 추가 로어북 저장 실패:", err);
      new Notice(`저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private makeTextField(
    parent: HTMLElement,
    label: string,
    hint: string | null,
    initial: string,
    onChange: (value: string) => void,
    rows = 4
  ): HTMLTextAreaElement {
    const wrap = parent.createDiv({ cls: "ggai-text-field" });
    wrap.createDiv({ cls: "ggai-text-field-label", text: label });
    if (hint) wrap.createDiv({ cls: "ggai-text-field-hint", text: hint });
    const ta = wrap.createEl("textarea", {
      cls: "ggai-text-field-input",
    });
    ta.value = initial;
    ta.rows = rows;

    // IME 조합 중에는 onChange(저장 큐)를 보류하고 조합이 끝날 때 확정값을 넘긴다.
    // (조합 중 저장이 돌면 자기-이벤트/재렌더 경쟁으로 입력이 깨진다.)
    let compositionActive = false;
    ta.addEventListener("compositionstart", () => {
      compositionActive = true;
    });
    ta.addEventListener("compositionend", () => {
      compositionActive = false;
      onChange(ta.value);
    });
    ta.addEventListener("input", () => {
      if (compositionActive) return;
      onChange(ta.value);
    });
    ta.addEventListener("blur", () => {
      if (compositionActive) {
        compositionActive = false;
        onChange(ta.value);
      }
      this.flush();
    });
    return ta;
  }

  // ─── 현재 컨텍스트 확인 (CTX) ──────────────────────────────────────

  private async handleShowContext(): Promise<void> {
    const file = this.activeSessionFile;
    if (!file) {
      new Notice("세션이 없습니다.");
      return;
    }
    // 전 과정을 try 로 감싼다 — flush 단계에서 터져도 조용히 죽지 않고
    // Notice 로 드러나게 (버튼이 "아무 반응 없음"이 되는 경로 차단).
    try {
      // 펜딩 저장 먼저 — 미저장 메모리/작가노트가 컨텍스트에 반영되도록.
      this.flush();
      // 세션창의 미저장 본문 편집도 커밋 — 미리보기 = 실제 전송본 불변식.
      await this.plugin.flushSessionEdits(file);
      const result = await buildSessionContextDryRun(this.plugin, file);
      if ("error" in result) {
        new Notice(result.error);
        return;
      }
      new ContextPreviewModal(this.plugin.app, result).open();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[GGAI Stella] 컨텍스트 미리보기 실패:", err);
      new Notice(`컨텍스트 미리보기 실패: ${msg}`);
    }
  }

  // ─── session field save (memory / authorNote) ──────────────────────

  private async handleToggleNovelChatRoleMode(split: boolean): Promise<void> {
    const file = this.activeSessionFile;
    if (!file) return;
    this.flush();
    try {
      const session = await this.plugin.store.getSession(file);
      if (!session) return;
      if (split) session.meta.novelChatRoleMode = "split";
      else delete session.meta.novelChatRoleMode;
      await this.plugin.store.saveSession(file, session);
      this.session = session;
    } catch (err) {
      console.warn("[GGAI Stella] chat role mode save failed:", err);
      new Notice(`본문 롤 설정 저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private queueSession(patch: { memory?: string; authorNote?: string }): void {
    Object.assign(this.sessionPending, patch);
    if (this.sessionSaveTimer != null) window.clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = window.setTimeout(() => {
      this.sessionSaveTimer = null;
      void this.persistSessionNow();
    }, DEBOUNCE_MS);
  }

  private async persistSessionNow(): Promise<void> {
    const file = this.activeSessionFile;
    if (!file) return;
    const patch = this.sessionPending;
    this.sessionPending = {};
    if (patch.memory === undefined && patch.authorNote === undefined) return;
    try {
      await this.guard.runSave(async () => {
        const session = await this.plugin.store.getSession(file);
        if (!session) return;
        if (patch.memory !== undefined) session.meta.memory = patch.memory;
        if (patch.authorNote !== undefined) session.meta.authorNote = patch.authorNote;
        await this.plugin.store.saveSession(file, session);
      });
    } catch (err) {
      console.warn("[GGAI Stella] 세션 메타 저장 실패:", err);
      new Notice(`세션 저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── scenario field save ───────────────────────────────────────────

  private queueScenario(key: ScenarioField, value: string): void {
    this.scenarioPending[key] = value;
    if (this.scenarioSaveTimer != null) window.clearTimeout(this.scenarioSaveTimer);
    this.scenarioSaveTimer = window.setTimeout(() => {
      this.scenarioSaveTimer = null;
      void this.persistScenarioNow();
    }, DEBOUNCE_MS);
  }

  private async persistScenarioNow(): Promise<void> {
    const file = this.scenarioFile;
    const scenario = this.scenario;
    const patch = this.scenarioPending;
    this.scenarioPending = {};
    if (!file || !scenario) return;
    if (Object.keys(patch).length === 0) return;
    try {
      for (const [k, v] of Object.entries(patch)) {
        (scenario.data as any)[k] = v;
      }
      await this.plugin.store.saveScenario(file, scenario);
    } catch (err) {
      console.warn("[GGAI Stella] 시나리오 저장 실패:", err);
      new Notice(`시나리오 저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── 복사 (deep copy + session move) ─────────────────────────────

  private async handleCopy(): Promise<void> {
    this.flush();
    const sourceFile = this.scenarioFile;
    const sessionFile = this.activeSessionFile;
    if (!sourceFile || !sessionFile) return;

    try {
      const result = await this.plugin.store.copyScenarioForSession(
        sourceFile,
        sessionFile
      );
      this.retargetSessionViews(sessionFile, result.newSessionFile);

      new Notice(`시나리오 복사 완료: ${result.newFolder.split("/").pop()}`);
    } catch (err) {
      console.error("[GGAI Stella] 시나리오 복사 실패:", err);
      new Notice(`복사 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 같은 sessionFile 을 들고 있는 세션 호스트 leaf 들의 state 를 새 경로로 setState. */
  private retargetSessionViews(oldFile: string, newFile: string): void {
    for (const leaf of getSessionHostLeaves(this.plugin.app.workspace)) {
      const view = leaf.view;
      if (isSessionHostView(view) && view.getSessionFile() === oldFile) {
        void leaf.setViewState({
          type: leaf.view.getViewType(),
          state: { sessionFile: newFile },
        });
      }
    }
  }
}

/**
 * 우측 사이드바에서 편집 가능한 시나리오 필드.
 * **컨텍스트 빌더가 실제로 사용하는 필드만 포함** — context-builder.ts 의 scenario 입력 / macros.ts 의
 * {{char}}/{{description}}/{{personality}}/{{scenario}}/{{first_message}}/{{example_dialogue}} 와 1:1 대응.
 *
 * 컨텍스트에 영향 없는 메타(tags, creator, system_prompt, alternate_greetings 등) 는 의도적으로 제외
 * — 편집할 일이 있으면 scenario.json 직접 수정.
 */
type ScenarioField =
  | "name"
  | "description"
  | "personality"
  | "scenario"
  | "first_mes"
  | "mes_example";

interface ScenarioFieldSpec {
  key: ScenarioField;
  label: string;
  rows: number;
}

const SCENARIO_FIELDS: ScenarioFieldSpec[] = [
  { key: "name", label: "이름", rows: 1 },
  { key: "description", label: "설명 (description)", rows: 4 },
  { key: "personality", label: "성격 (personality)", rows: 4 },
  { key: "scenario", label: "시나리오 (scenario)", rows: 4 },
  { key: "first_mes", label: "첫 메시지 (first_mes)", rows: 6 },
  { key: "mes_example", label: "예시 대화 (mes_example)", rows: 6 },
];

// ─── helpers ─────────────────────────────────────────────────────────


/** 시나리오의 stella extension 을 보장하고 반환. 없으면 기본값으로 채움. */
function ensureStellaExt(scenario: StellaScenario): StellaScenarioExtension {
  const data: any = scenario.data;
  if (!data.extensions) data.extensions = {};
  if (!data.extensions.stella) {
    data.extensions.stella = {
      id: uuidv4(),
      favorite: false,
      lastPlayedAt: 0,
      playCount: 0,
      thumbnail: null,
    };
  }
  return data.extensions.stella as StellaScenarioExtension;
}

function scenarioFileOfSessionFile(sessionFile: string): string | null {
  const parts = sessionFile.split("/");
  if (parts.length < 6 || parts[parts.length - 3] !== "SESSIONS") return null;
  return parts.slice(0, -3).join("/") + "/scenario.json";
}

