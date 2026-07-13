import { EventRef, Notice, TFile } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { StellaScenario, StellaScenarioExtension } from "../types/scenario";
import type { LorebookListItem } from "../util/scan-lorebooks";
import { uuidv4 } from "../util/uuid";
import { EditGuard } from "./edit-guard";
import {
  renderEditableTitle,
  renderEditorCover,
  renderIconActionButton,
} from "./editor-cover";
import { type FieldDef, renderForm } from "./form-renderer";
import { ConfirmModal, ScenarioSessionCopyModal } from "./modals";
import { parseTalkativeness } from "../util/group-speaker";

const SAVE_DEBOUNCE_MS = 400;

const SCENARIO_FIELDS: FieldDef[] = [
  // 이름은 상단 헤더(클릭 편집)에서 다룬다 — 폼에서는 제외.
  { kind: "text", key: "description", label: "설명 / 캐릭터 정의", rows: 5 },
  { kind: "text", key: "personality", label: "성격", rows: 4 },
  { kind: "text", key: "scenario", label: "시나리오", rows: 5 },
  { kind: "text", key: "first_mes", label: "첫 메시지 / 시작 장면", rows: 8 },
  { kind: "text", key: "mes_example", label: "예시 대화", rows: 6 },
  {
    kind: "text",
    key: "system_prompt",
    label: "시스템 프롬프트",
    rows: 4,
    hint: "SillyTavern/캐릭터 카드 호환 필드입니다. 프롬프트 세트가 이 값을 참조할 때 사용됩니다.",
  },
  {
    kind: "text",
    key: "post_history_instructions",
    label: "포스트 히스토리 지시문",
    rows: 4,
  },
  { kind: "text", key: "creator_notes", label: "제작자 노트", rows: 4 },
  { kind: "text", key: "creator", label: "제작자" },
  { kind: "text", key: "character_version", label: "버전" },
  { kind: "tags", key: "tags", label: "태그" },
];

export interface ScenarioEditorSectionOpts {
  /** 삭제 후 편집 페이지를 벗어날 때(대시보드 뒤로가기 등). */
  onClose: () => void;
}

/**
 * 시나리오 편집기 — 대시보드 내부 페이지로 임베드되는 편집 섹션.
 *
 * 예전 ScenarioEditorView(별도 뷰) 의 편집/자동 저장 로직을 그대로 옮기되, 상단 nav 는
 * 대시보드가 소유하므로 여기서 그리지 않는다. 라우트 이동/뷰 종료 시 dispose() 가
 * 구독 해제 + 미저장 편집 flush 를 책임진다 (UserEditorSection 과 같은 임베드 패턴).
 */
export class ScenarioEditorSection {
  private root: HTMLElement;
  private scenarioFile: string | null;
  private scenario: StellaScenario | null = null;
  private lorebooks: LorebookListItem[] = [];
  private saveTimer: number | null = null;
  private dirty = false;
  /** 조합/포커스/자기저장 공용 가드 — 복붙 금지, edit-guard.ts 참조. */
  private guard = new EditGuard();
  private eventRefs: EventRef[] = [];

  private isEditing(): boolean {
    return this.guard.isEditing();
  }

  private visibilityHandler = (): void => {
    if (document.visibilityState === "hidden") void this.flushNow();
    else if (!this.dirty && !this.isEditing()) void this.reloadAndRender();
  };
  private blurHandler = (): void => void this.flushNow();
  private focusHandler = (): void => {
    if (!this.dirty && !this.isEditing()) void this.reloadAndRender();
  };

  constructor(
    container: HTMLElement,
    private plugin: StellaEnginePlugin,
    scenarioFile: string,
    private opts: ScenarioEditorSectionOpts
  ) {
    this.root = container.createDiv({
      cls: "ggai-scenario-editor ggai-editor-embed",
    });
    this.scenarioFile = scenarioFile;
    // root 는 render() 에서 empty() 될 뿐 교체되지 않아 리스너가 살아남는다.
    this.guard.attach(this.root);
  }

  async load(): Promise<void> {
    await this.reloadAndRender();
    this.eventRefs.push(
      this.plugin.store.on("scenarios-changed", () => {
        if (!this.scenarioFile || this.guard.isSavingSelf || this.dirty) return;
        if (this.isEditing()) return;
        void this.reloadAndRender();
      })
    );
    this.eventRefs.push(
      this.plugin.store.on("lorebooks-changed", () => {
        if (this.isEditing()) return;
        void this.reloadLorebooks();
      })
    );
    document.addEventListener("visibilitychange", this.visibilityHandler);
    window.addEventListener("blur", this.blurHandler);
    window.addEventListener("focus", this.focusHandler);
  }

  /** 라우트 이동/뷰 종료 시 호출 — 구독 해제 + 미저장 편집 확정. */
  async dispose(): Promise<void> {
    for (const ref of this.eventRefs) this.plugin.store.offref(ref);
    this.eventRefs = [];
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    window.removeEventListener("blur", this.blurHandler);
    window.removeEventListener("focus", this.focusHandler);
    await this.flushNow();
  }

  private async reloadAndRender(): Promise<void> {
    if (!this.scenarioFile) {
      this.scenario = null;
      this.render();
      return;
    }
    const scenarios = await this.plugin.store.refreshScenarios();
    const item = scenarios.find((s) => s.scenarioFile === this.scenarioFile);
    this.scenario = item?.scenario ?? null;
    this.lorebooks = await this.plugin.store.refreshLorebooks().catch(() => []);
    this.dirty = false;
    this.render();
  }

  private async reloadLorebooks(): Promise<void> {
    this.lorebooks = await this.plugin.store.refreshLorebooks().catch(() => []);
    this.render();
  }

  private render(): void {
    this.root.empty();
    if (!this.scenario || !this.scenarioFile) {
      this.root.createDiv({
        cls: "ggai-detail-empty",
        text: this.scenarioFile
          ? "시나리오를 읽을 수 없습니다."
          : "편집할 시나리오를 선택하세요.",
      });
      return;
    }

    const data = this.scenario.data as Record<string, any>;
    const header = this.root.createDiv({ cls: "ggai-editor-header is-hero" });
    this.renderCover(header);
    renderEditableTitle(header, data.name || "이름 없는 시나리오", (next) => {
      data.name = next;
      this.queueSave();
      this.render();
    });

    const actions = header.createDiv({ cls: "ggai-editor-actions" });
    renderIconActionButton(actions, {
      icon: "braces",
      label: "JSON 파일 열기",
      onClick: () => void this.openJsonFile(),
    });
    renderIconActionButton(actions, {
      icon: "copy",
      label: "복제",
      onClick: () => void this.handleDuplicate(),
    });
    renderIconActionButton(actions, {
      icon: "trash-2",
      label: "삭제",
      danger: true,
      onClick: () => this.handleDelete(),
    });

    const formWrap = this.root.createDiv({ cls: "ggai-scenario-editor-form" });
    renderForm(
      formWrap,
      SCENARIO_FIELDS,
      data,
      (key, value) => {
        data[key] = value;
        this.queueSave();
      },
      () => void this.flushNow()
    );

    this.renderAlternateGreetings(data);
    this.renderTalkativeness(data);
    this.renderLorebookLinks();
  }

  /** 수다스러움 (그룹 채팅) — data.extensions.talkativeness (ST 호환, 0~1). */
  private renderTalkativeness(data: Record<string, any>): void {
    const ext = (data.extensions ??= {}) as Record<string, any>;
    const wrap = this.root.createDiv({ cls: "ggai-text-field" });
    wrap.createDiv({
      cls: "ggai-text-field-label",
      text: "수다스러움 (그룹 채팅)",
    });
    wrap.createDiv({
      cls: "ggai-text-field-hint",
      text: "그룹 채팅에서 이 캐릭터가 얼마나 자주 먼저 나서는지. 낮으면 이름을 불러야 말하고, 높으면 적극적으로 끼어듭니다. SillyTavern talkativeness와 호환됩니다.",
    });
    const row = wrap.createDiv({ cls: "ggai-talkativeness-row" });
    const slider = row.createEl("input", { type: "range" });
    slider.min = "0";
    slider.max = "100";
    slider.step = "5";
    slider.value = String(Math.round(parseTalkativeness(ext.talkativeness) * 100));
    const valEl = row.createSpan({ cls: "ggai-talkativeness-value" });
    const label = (v: number): string => {
      const pct = Math.round(v * 100);
      const word =
        v < 0.2 ? "조용함" : v < 0.4 ? "낮음" : v < 0.65 ? "보통" : v < 0.85 ? "높음" : "활발함";
      return `${pct}% · ${word}`;
    };
    valEl.setText(label(parseTalkativeness(ext.talkativeness)));
    slider.addEventListener("input", () => {
      const v = Number(slider.value) / 100;
      ext.talkativeness = v;
      valEl.setText(label(v));
      this.queueSave();
    });
    slider.addEventListener("change", () => void this.flushNow());
  }

  private renderCover(parent: HTMLElement): void {
    if (!this.scenario || !this.scenarioFile) return;
    const rel = this.scenario.data.extensions?.stella?.thumbnail;
    const folder = this.scenarioFile.replace(/\/scenario\.json$/, "");
    const path = rel ? `${folder}/${rel}` : null;
    renderEditorCover(this.plugin.app, parent, {
      imagePath: path,
      altText: this.scenario.data.name,
      fallbackIcon: "scroll-text",
      onPick: async (bytes, ext) => {
        if (!this.scenarioFile) return;
        try {
          await this.plugin.store.setScenarioThumbnail(
            this.scenarioFile,
            bytes,
            ext
          );
          await this.reloadAndRender();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`표지 저장 실패: ${msg}`);
        }
      },
    });
  }

  private renderAlternateGreetings(data: Record<string, any>): void {
    const wrap = this.root.createDiv({ cls: "ggai-text-field" });
    wrap.createDiv({
      cls: "ggai-text-field-label",
      text: "대체 첫 메시지 / 시작 장면",
    });
    wrap.createDiv({
      cls: "ggai-text-field-hint",
      text: "각 항목은 여러 줄 장면으로 저장합니다. SillyTavern alternate_greetings와 호환됩니다.",
    });
    const greetings: string[] = Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.filter(
          (s: unknown): s is string => typeof s === "string"
        )
      : [];
    data.alternate_greetings = greetings;

    const list = wrap.createDiv({ cls: "ggai-alternate-greetings" });
    const renderGreeting = (value: string, index: number) => {
      const item = list.createDiv({ cls: "ggai-alternate-greeting" });
      const head = item.createDiv({ cls: "ggai-card-row" });
      head.createDiv({
        cls: "ggai-folder-hint",
        text: `대체 시작 장면 ${index + 1}`,
      });
      const removeBtn = head.createEl("button", {
        cls: "ggai-btn",
        text: "삭제",
      });
      removeBtn.addEventListener("click", () => {
        greetings.splice(index, 1);
        data.alternate_greetings = greetings;
        this.queueSave();
        this.render();
      });

      const ta = item.createEl("textarea", { cls: "ggai-text-field-input" });
      ta.rows = 8;
      ta.value = value;
      ta.addEventListener("input", () => {
        greetings[index] = ta.value;
        data.alternate_greetings = greetings.filter((s) => s.trim().length > 0);
        this.queueSave();
      });
      ta.addEventListener("blur", () => void this.flushNow());
    };

    greetings.forEach(renderGreeting);

    const addBtn = wrap.createEl("button", {
      cls: "ggai-btn",
      text: "대체 시작 장면 추가",
    });
    addBtn.addEventListener("click", () => {
      greetings.push("");
      data.alternate_greetings = greetings;
      this.queueSave();
      this.render();
    });
  }

  private renderLorebookLinks(): void {
    const scenario = this.scenario;
    if (!scenario) return;
    const ext = ensureStellaExt(scenario);
    const wrap = this.root.createDiv({ cls: "ggai-scenario-lorebooks" });
    wrap.createDiv({ cls: "ggai-section-title", text: "연결 로어북" });

    const defWrap = wrap.createDiv({ cls: "ggai-text-field" });
    defWrap.createDiv({ cls: "ggai-text-field-label", text: "기본 로어북" });
    const select = defWrap.createEl("select", { cls: "ggai-select" });
    const none = select.createEl("option", { text: "(없음)" });
    none.value = "";
    if (!ext.defaultLorebookId) none.selected = true;
    for (const item of this.lorebooks) {
      const opt = select.createEl("option", {
        text: item.lorebook.meta.name || item.folderName,
      });
      opt.value = item.lorebook.meta.id;
      if (item.lorebook.meta.id === ext.defaultLorebookId) opt.selected = true;
    }
    select.addEventListener("change", () => {
      ext.defaultLorebookId = select.value || undefined;
      if (ext.defaultLorebookId && Array.isArray(ext.extraLorebookIds)) {
        ext.extraLorebookIds = ext.extraLorebookIds.filter(
          (id) => id !== ext.defaultLorebookId
        );
      }
      this.queueSave();
      this.render();
    });

    wrap.createDiv({ cls: "ggai-text-field-label", text: "추가 로어북" });
    const list = wrap.createDiv({ cls: "ggai-lorebook-checklist" });
    const extra = new Set(ext.extraLorebookIds ?? []);
    const candidates = this.lorebooks.filter(
      (l) => l.lorebook.meta.id !== ext.defaultLorebookId
    );
    if (candidates.length === 0) {
      list.createDiv({
        cls: "ggai-detail-empty",
        text: "추가할 로어북이 없습니다.",
      });
      return;
    }
    for (const item of candidates) {
      const meta = item.lorebook.meta;
      const row = list.createDiv({ cls: "ggai-lorebook-checklist-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = extra.has(meta.id);
      const label = row.createSpan({
        cls: "ggai-lorebook-checklist-label",
        text: meta.name || item.folderName,
      });
      const update = () => {
        if (cb.checked) extra.add(meta.id);
        else extra.delete(meta.id);
        ext.extraLorebookIds = extra.size > 0 ? Array.from(extra) : undefined;
        this.queueSave();
      };
      cb.addEventListener("change", update);
      label.addEventListener("click", () => {
        cb.checked = !cb.checked;
        update();
      });
    }
  }

  private queueSave(): void {
    this.dirty = true;
    if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private async flushNow(): Promise<void> {
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.scenarioFile || !this.scenario) return;
    const file = this.scenarioFile;
    const scenario = this.scenario;
    try {
      await this.guard.runSave(() =>
        this.plugin.store.saveScenario(file, scenario)
      );
      this.dirty = false;
    } catch (err) {
      console.warn("[GGAI Stella] scenario editor save failed:", err);
      new Notice(
        `시나리오 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async openJsonFile(): Promise<void> {
    if (!this.scenarioFile) return;
    await this.flushNow();
    const file = this.plugin.app.vault.getAbstractFileByPath(this.scenarioFile);
    if (file instanceof TFile) {
      await this.plugin.app.workspace.getLeaf(true).openFile(file);
    } else {
      new Notice(`파일을 찾을 수 없습니다: ${this.scenarioFile}`);
    }
  }

  private async handleDuplicate(): Promise<void> {
    const scenarioFile = this.scenarioFile;
    const scenario = this.scenario;
    if (!scenarioFile || !scenario) return;
    await this.flushNow();
    const folder = scenarioFile.replace(/\/scenario\.json$/, "");
    const sessions = await this.plugin.store.getSessions(folder).catch(() => []);
    new ScenarioSessionCopyModal(
      this.plugin.app,
      scenario.data.name || "시나리오",
      sessions,
      async (selected) => {
        try {
          const result = await this.plugin.store.copyScenario(
            scenarioFile,
            selected
          );
          await this.plugin.openStellaEditor(
            "scenario",
            result.newScenarioFile
          );
          new Notice(`시나리오 복사 완료: ${selected.length}개 세션 포함`);
        } catch (err) {
          new Notice(
            `시나리오 복사 실패: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    ).open();
  }

  private handleDelete(): void {
    const scenarioFile = this.scenarioFile;
    const scenario = this.scenario;
    if (!scenarioFile || !scenario) return;
    const folder = scenarioFile.replace(/\/scenario\.json$/, "");
    new ConfirmModal(
      this.plugin.app,
      "시나리오 삭제",
      `"${scenario.data.name || "이 시나리오"}" 폴더를 휴지통으로 옮깁니다. 계속할까요?`,
      "삭제",
      (confirmed) => {
        if (!confirmed) return;
        void (async () => {
          try {
            this.dirty = false;
            await this.plugin.store.deleteScenario(folder);
            new Notice(`삭제됨: ${folder} · 휴지통에서 복구할 수 있어요`);
            this.opts.onClose();
          } catch (err) {
            new Notice(
              `삭제 실패: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })();
      }
    ).open();
  }
}

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
