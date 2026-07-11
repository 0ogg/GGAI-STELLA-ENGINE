import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { VIEW_TYPE_DETAIL } from "../constants";
import type StellaEnginePlugin from "../main";
import type { SessionChangeDetail } from "../state/store";
import type { ActiveSettings } from "../types/preset";
import { BranchSection } from "./detail/branch-section";
import { ExpandSection, type ExpandSectionUiState } from "./detail/expand-section";
import { ModelSection } from "./detail/model-section";
import { ParamsSection } from "./detail/params-section";
import { PresetSection } from "./detail/preset-section";
import {
  PromptsSection,
  type PromptsSectionUiState,
} from "./detail/prompts-section";
import {
  ScenarioSection,
  type ScenarioSectionUiState,
} from "./detail/scenario-section";
import { isSessionHostView } from "./session-host";

/**
 * DetailView — 우측 사이드바 편집기.
 *
 * R3: 빈 컨테이너 + 두 탭(`기본` / `시나리오`).
 * R4a~b: 기본 탭에 preset / model / params 섹션.
 * R4e2: 활성 설정(modelProfileId / params / promptSetId) 을 활성 세션 또는 PluginData.current
 *       에서 직접 읽어 model/params 섹션에 주입. 프리셋은 그 위 단순 북마크.
 * R4c (예정): 기본 탭에 prompts-section 추가.
 * R5 (예정): 시나리오 탭 내용.
 */

type DetailTab = "basic" | "scenario" | "branch" | "expand";

interface BasicTabUiState {
  presetCollapsed?: boolean;
  modelCollapsed?: boolean;
  paramsCollapsed?: boolean;
  prompts?: Partial<PromptsSectionUiState>;
}

export class DetailView extends ItemView {
  private activeSessionFile: string | null = null;
  private activeTab: DetailTab = "basic";
  private reloadSeq = 0;

  private tabHeaderEls: Record<DetailTab, HTMLElement> = {
    basic: null as unknown as HTMLElement,
    scenario: null as unknown as HTMLElement,
    branch: null as unknown as HTMLElement,
    expand: null as unknown as HTMLElement,
  };
  private tabContentEl!: HTMLElement;

  private presetSection: PresetSection | null = null;
  private modelSection: ModelSection | null = null;
  private paramsSection: ParamsSection | null = null;
  private promptsSection: PromptsSection | null = null;
  private scenarioSection: ScenarioSection | null = null;
  private branchSection: BranchSection | null = null;
  private expandSection: ExpandSection | null = null;

  private basicUiState: BasicTabUiState = {};
  private scenarioUiState: Partial<ScenarioSectionUiState> = {};
  private expandUiState: Partial<ExpandSectionUiState> = {};
  private tabScrollTop: Record<DetailTab, number> = {
    basic: 0,
    scenario: 0,
    branch: 0,
    expand: 0,
  };

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: StellaEnginePlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_DETAIL;
  }

  getDisplayText(): string {
    return "Stella 세부";
  }

  getIcon(): string {
    return "panel-right";
  }

  /** visibilitychange 핸들러 — 모바일 백그라운드 진입 시 모든 펜딩 저장. */
  private visibilityHandler = () => {
    if (document.visibilityState === "hidden") {
      this.paramsSection?.flush();
      this.scenarioSection?.flush();
    } else {
      void this.refreshVisibleSectionsFromDisk();
    }
  };

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("ggai-detail");

    this.activeTab = this.plugin.data.lastDetailTab ?? "basic";
    this.basicUiState =
      (this.plugin.data.detailUi?.basic as BasicTabUiState) ?? {};
    this.scenarioUiState =
      (this.plugin.data.detailUi?.scenario as Partial<ScenarioSectionUiState>) ??
      {};
    this.expandUiState =
      (this.plugin.data.detailUi?.expand as Partial<ExpandSectionUiState>) ?? {};
    this.activeSessionFile = this.captureActiveSessionFile();

    this.renderShell(root as HTMLElement);

    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.registerDomEvent(window, "blur", () => {
      this.captureVisibleUiState();
      this.paramsSection?.flush();
      this.scenarioSection?.flush();
    });
    this.registerDomEvent(window, "focus", () => void this.refreshVisibleSectionsFromDisk());

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        // detail view 자신이나 사이드바 등 세션 뷰가 아닌 leaf 가 active 되어도
        // 마지막 세션 뷰를 유지한다. 단, 모든 세션 뷰 leaf 가 닫혔으면 null.
        let next: string | null = this.activeSessionFile;
        if (isSessionHostView(leaf?.view)) {
          next = leaf.view.getSessionFile();
        } else {
          next = this.plugin.getActiveOrLastSessionFile();
        }
        this.reloadActiveSessionFile(next);
      })
    );
    // SessionView 의 setState 가 onOpen 후에 비동기로 끝날 수 있고, 사이드바 진입은
    // 항상 active-leaf-change 를 트리거하지 않는다. layout-change 로 한 번 더 보정.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        const captured = this.captureActiveSessionFile();
        if (captured) this.reloadActiveSessionFile(captured);
      })
    );

    // 프리셋 변경(다른 곳에서 저장 / 외부 편집기) 구독
    this.registerEvent(
      this.plugin.store.on("presets-changed", () => {
        void this.presetSection?.refresh();
      })
    );
    // 프롬프트 세트 목록/내용 변경
    this.registerEvent(
      this.plugin.store.on("prompt-presets-changed", () => {
        void this.promptsSection?.refresh();
      })
    );
    // 활성 세션이 바뀐 경우 (같은 세션 뷰 leaf 안의 setState 전환 포함 — active-leaf-change 가
    // 안 터지는 경로를 보강). 모든 탭이 새 세션으로 실시간 전환된다.
    this.registerEvent(
      this.plugin.store.on("active-session-changed", (file: string) => {
        this.reloadActiveSessionFile(file);
      })
    );
    // 현재 세션의 번역(translations.json)이 바뀌면 분기 탭 번역 표시를 실시간 갱신.
    this.registerEvent(
      this.plugin.store.on("session-translations-changed", (file: string) => {
        if (file === this.activeSessionFile && this.activeTab === "branch") {
          void this.branchSection?.onTranslationsChanged();
        }
      })
    );
    // 현재 세션의 요약(summaries.json)이 바뀌면 요약 패널만 다시 그려 "현재 요약 컨텍스트" 갱신.
    this.registerEvent(
      this.plugin.store.on("session-summaries-changed", (file: string) => {
        if (file === this.activeSessionFile) {
          this.expandSection?.refreshPanel("stella:summary");
        }
      })
    );
    // 확장 탭 설정 패널이 등록/해제되면(외부 플러그인 포함) 패널 목록을 다시 구성.
    this.registerEvent(
      this.plugin.store.on("settings-panels-changed", () => {
        if (this.activeTab === "expand") this.expandSection?.rebuildPanels();
      })
    );
    // 활성 세션 메타가 외부에서 갱신된 경우
    this.registerEvent(
      this.plugin.store.on(
        "session-changed",
        (file: string, detail?: SessionChangeDetail) => {
          if (file !== this.activeSessionFile) return;
          this.plugin.rememberActiveSessionFile(file);
          if (detail?.kinds?.every((k) => k === "settings")) {
            // 활성 설정만 바뀜 — 섹션 DOM 을 부수지 않고 값만 제자리 동기화.
            // (구 동작: 현재 탭 전체 refresh → 설정 하나에 모든 섹션이 깔짝거림)
            void this.refreshActiveSettings();
            if (this.activeTab === "expand") void this.expandSection?.refresh();
            return;
          }
          this.reloadActiveSessionFile(file, true);
        }
      )
    );
    this.registerEvent(
      this.plugin.store.on("session-deleted", (file: string) => {
        if (file === this.activeSessionFile) {
          this.reloadActiveSessionFile(null, true);
        }
      })
    );
    // 시나리오 변경 (이름/메타) → 시나리오 탭 다시 그림
    this.registerEvent(
      this.plugin.store.on("scenarios-changed", () => {
        if (this.activeTab === "scenario" && this.scenarioSection) {
          this.scenarioSection.setActiveSessionFile(this.activeSessionFile);
        }
      })
    );
    // 세션 목록 변경 (다음화 생성/이름변경 등) → 시나리오 탭 시리즈 화 목록만 부분 갱신.
    this.registerEvent(
      this.plugin.store.on("sessions-changed", () => {
        if (this.activeTab === "scenario") {
          void this.scenarioSection?.renderSeriesArea();
        }
      })
    );
    // 로어북 목록 변경 → 시나리오 탭의 로어북 영역만 부분 갱신.
    this.registerEvent(
      this.plugin.store.on("lorebooks-changed", () => {
        void this.scenarioSection?.refreshLorebooks();
      })
    );
    // Core 프로필 목록 변경 → model 섹션 갱신 + params 섹션도 (allowedParams 변경 가능).
    this.registerEvent(
      this.plugin.ai.on("profiles-changed", () => {
      this.modelSection?.refresh();
      this.expandSection?.refreshModels();
      void this.refreshActiveSettings();
    })
    );
  }

  async onClose(): Promise<void> {
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.captureVisibleUiState();
    this.paramsSection?.flush();
    this.scenarioSection?.flush();
  }

  // ─── 렌더 ────────────────────────────────────────────────────────────

  private renderShell(root: HTMLElement): void {
    const tabs = root.createDiv({ cls: "ggai-detail-tabs" });
    this.tabHeaderEls.basic = tabs.createDiv({
      cls: "ggai-detail-tab",
      text: "기본",
    });
    this.tabHeaderEls.scenario = tabs.createDiv({
      cls: "ggai-detail-tab",
      text: "시나리오",
    });
    this.tabHeaderEls.branch = tabs.createDiv({
      cls: "ggai-detail-tab",
      text: "분기",
    });
    this.tabHeaderEls.expand = tabs.createDiv({
      cls: "ggai-detail-tab",
      text: "확장",
    });
    this.tabHeaderEls.basic.addEventListener("click", () =>
      void this.setTab("basic")
    );
    this.tabHeaderEls.scenario.addEventListener("click", () =>
      void this.setTab("scenario")
    );
    this.tabHeaderEls.branch.addEventListener("click", () =>
      void this.setTab("branch")
    );
    this.tabHeaderEls.expand.addEventListener("click", () =>
      void this.setTab("expand")
    );

    this.tabContentEl = root.createDiv({ cls: "ggai-detail-content" });

    this.renderTabHeaders();
    this.renderTabContent();
  }

  private renderTabHeaders(): void {
    const sessionMissing = this.activeSessionFile == null;
    for (const tab of ["basic", "scenario", "branch", "expand"] as DetailTab[]) {
      const el = this.tabHeaderEls[tab];
      el.toggleClass("is-active", this.activeTab === tab);
      el.toggleClass(
        "is-disabled",
        (tab === "scenario" || tab === "branch" || tab === "expand") && sessionMissing
      );
    }
  }

  private renderTabContent(): void {
    this.tabContentEl.empty();
    this.presetSection = null;
    this.modelSection = null;
    this.paramsSection = null;
    this.promptsSection = null;
    this.scenarioSection = null;
    this.branchSection = null;
    this.expandSection = null;

    if (this.activeTab === "basic") {
      this.presetSection = new PresetSection(
        this.tabContentEl,
        this.plugin,
        this.activeSessionFile,
        () => void this.refreshActiveSettings(),
        this.basicUiState.presetCollapsed
      );
      this.modelSection = new ModelSection(
        this.tabContentEl,
        this.plugin,
        () => void this.refreshActiveSettings(),
        this.basicUiState.modelCollapsed
      );
      this.paramsSection = new ParamsSection(
        this.tabContentEl,
        this.plugin,
        this.basicUiState.paramsCollapsed
      );
      this.promptsSection = new PromptsSection(
        this.tabContentEl,
        this.plugin,
        this.activeSessionFile,
        this.basicUiState.prompts
      );
      this.renderCollapseAllFooter("basic");
      const seq = this.reloadSeq;
      void Promise.all([
        this.presetSection.load(),
        this.promptsSection.load(),
        this.refreshActiveSettings(),
      ]).finally(() => this.scheduleRestoreScroll("basic", seq));
      this.scheduleRestoreScroll("basic", seq);
      return;
    }

    if (this.activeTab === "branch") {
      this.branchSection = new BranchSection(
        this.tabContentEl,
        this.plugin,
        this.activeSessionFile,
        { autoCenterCurrent: true }
      );
      const seq = this.reloadSeq;
      void this.branchSection
        .load()
        .finally(() => this.scheduleRestoreScroll("branch", seq));
      this.scheduleRestoreScroll("branch", seq);
      return;
    }

    if (this.activeTab === "expand") {
      this.expandSection = new ExpandSection(
        this.tabContentEl,
        this.plugin,
        this.activeSessionFile,
        this.expandUiState
      );
      const seq = this.reloadSeq;
      void this.expandSection
        .load()
        .finally(() => {
          this.renderCollapseAllFooter("expand");
          this.scheduleRestoreScroll("expand", seq);
        });
      return;
    }

    // scenario
    this.scenarioSection = new ScenarioSection(
      this.tabContentEl,
      this.plugin,
      this.activeSessionFile,
      this.scenarioUiState
    );
    const seq = this.reloadSeq;
    void this.scenarioSection
      .load()
      .finally(() => {
        this.renderCollapseAllFooter("scenario");
        this.scheduleRestoreScroll("scenario", seq);
      });
  }

  /**
   * 탭 맨 아래 "전체 접기/펼치기" 버튼 — 스크롤이 길어질 때 모든 섹션을 한 번에
   * 접고 원하는 항목만 펼쳐 본다. 접힘 상태는 기존 detailUi 경로로 영속된다.
   */
  private renderCollapseAllFooter(tab: DetailTab): void {
    // 시나리오/확장 탭은 세션이 없으면 빈 안내만 뜨므로 접기 버튼을 두지 않는다.
    if (tab !== "basic" && !this.activeSessionFile) return;
    const footer = this.tabContentEl.createDiv({
      cls: "ggai-detail-collapse-footer",
    });
    const btn = footer.createEl("button", {
      cls: "ggai-btn ggai-collapse-all-btn",
    });
    const iconEl = btn.createSpan({ cls: "ggai-collapse-all-icon" });
    const labelEl = btn.createSpan();
    const sync = () => {
      const allCollapsed = this.areAllCollapsed(tab);
      setIcon(iconEl, allCollapsed ? "chevrons-up-down" : "chevrons-down-up");
      labelEl.setText(allCollapsed ? "전체 펼치기" : "전체 접기");
    };
    btn.addEventListener("click", () => {
      const collapse = !this.areAllCollapsed(tab);
      this.setAllCollapsed(tab, collapse);
      this.captureVisibleUiState();
      sync();
    });
    sync();
  }

  private setAllCollapsed(tab: DetailTab, v: boolean): void {
    if (tab === "basic") {
      this.presetSection?.setCollapsed(v);
      this.modelSection?.setCollapsed(v);
      this.paramsSection?.setCollapsed(v);
      this.promptsSection?.setCollapsed(v);
    } else if (tab === "scenario") {
      this.scenarioSection?.setCollapsed(v);
    } else if (tab === "expand") {
      this.expandSection?.setCollapsed(v);
    }
  }

  private areAllCollapsed(tab: DetailTab): boolean {
    if (tab === "basic") {
      return (
        (this.presetSection?.isCollapsed() ?? true) &&
        (this.modelSection?.isCollapsed() ?? true) &&
        (this.paramsSection?.isCollapsed() ?? true) &&
        (this.promptsSection?.getUiState().collapsed ?? true)
      );
    }
    if (tab === "scenario") {
      const s = this.scenarioSection?.getUiState();
      return (
        !!s &&
        s.sessionFieldsCollapsed &&
        s.sessionLorebookCollapsed &&
        s.formCollapsed &&
        s.seriesCollapsed
      );
    }
    if (tab === "expand") {
      return this.expandSection?.isAllCollapsed() ?? false;
    }
    return false;
  }

  private async setTab(next: DetailTab): Promise<void> {
    if (this.activeTab === next) return;
    this.captureVisibleUiState();
    this.paramsSection?.flush();
    this.scenarioSection?.flush();
    this.activeTab = next;
    this.renderTabHeaders();
    this.renderTabContent();
    await this.plugin.savePluginData({ lastDetailTab: next });
  }

  /** 활성 설정을 다시 lookup 해서 model/params/prompts 섹션에 주입. */
  private async refreshActiveSettings(): Promise<void> {
    // active-leaf-change 가 안 도는 경로(사이드바 진입 / 초기 timing) 보정 — 매번 재캡처 시도.
    const captured = this.captureActiveSessionFile();
    if (captured && captured !== this.activeSessionFile) {
      this.reloadActiveSessionFile(captured);
    }
    const seq = this.reloadSeq;
    const settings: ActiveSettings = await this.plugin.resolveActiveSettings(
      this.activeSessionFile
    );
    if (seq !== this.reloadSeq) return;
    this.modelSection?.setActive(settings.modelProfileId, this.activeSessionFile);
    // params 섹션은 활성 모델의 allowedParams 게이트를 적용해야 하므로 모델 id 도 주입.
    this.paramsSection?.setActive(
      settings.params,
      this.activeSessionFile,
      settings.modelProfileId
    );
    void this.promptsSection?.syncActiveSettings(
      settings.promptSetId,
      settings.naiFormat,
      settings.continueAnchor
    );
    void this.updateChatSessionClass();
  }

  /** 활성 세션이 챗이면 루트 클래스 토글 — 소설 전용 항목(이음새 보정 등)을 CSS 로 숨긴다. */
  private async updateChatSessionClass(): Promise<void> {
    let isChat = false;
    if (this.activeSessionFile) {
      try {
        const session = await this.plugin.store.getSession(this.activeSessionFile);
        isChat = session?.meta.mode === "chat";
      } catch {
        isChat = false;
      }
    }
    this.containerEl.toggleClass("ggai-detail-chat-session", isChat);
  }

  private async refreshVisibleSectionsFromDisk(): Promise<void> {
    this.captureVisibleUiState();
    if (this.activeSessionFile) {
      await this.plugin.store.refreshSession(this.activeSessionFile);
    }
    await this.refreshVisibleSections();
  }

  /** activeSessionFile 변경을 현재 탭 전체 reload 로 반영한다. */
  private reloadActiveSessionFile(next: string | null, force = false): void {
    const sameSession = next === this.activeSessionFile;
    if (!force && sameSession) return;
    this.captureVisibleUiState();
    this.paramsSection?.flush();
    this.scenarioSection?.flush();
    this.activeSessionFile = next;
    this.reloadSeq++;
    this.renderTabHeaders();
    if (force && sameSession) {
      void this.refreshVisibleSections();
      return;
    }
    this.renderTabContent();
  }

  // ─── 활성 세션 캡처 ──────────────────────────────────────────────────

  private captureVisibleUiState(): void {
    if (this.tabContentEl) {
      this.tabScrollTop[this.activeTab] = this.tabContentEl.scrollTop;
    }
    if (this.activeTab === "basic") {
      if (this.presetSection) {
        this.basicUiState.presetCollapsed = this.presetSection.isCollapsed();
      }
      if (this.modelSection) {
        this.basicUiState.modelCollapsed = this.modelSection.isCollapsed();
      }
      if (this.paramsSection) {
        this.basicUiState.paramsCollapsed = this.paramsSection.isCollapsed();
      }
      if (this.promptsSection) {
        this.basicUiState.prompts = this.promptsSection.getUiState();
      }
    }
    if (this.activeTab === "scenario" && this.scenarioSection) {
      this.scenarioUiState = this.scenarioSection.getUiState();
    }
    if (this.activeTab === "expand" && this.expandSection) {
      this.expandUiState = this.expandSection.getUiState();
    }
    this.persistUiStateIfChanged();
  }

  /** 섹션 접힘 등 UI 상태를 PluginData 에 영속화 (변경 시에만 저장). */
  private lastUiStateJson = "";
  private persistUiStateIfChanged(): void {
    const detailUi = {
      basic: this.basicUiState as Record<string, unknown>,
      scenario: this.scenarioUiState as Record<string, unknown>,
      expand: this.expandUiState as Record<string, unknown>,
    };
    const json = JSON.stringify(detailUi);
    if (json === this.lastUiStateJson) return;
    this.lastUiStateJson = json;
    void this.plugin.savePluginData({ detailUi });
  }

  private async refreshVisibleSections(): Promise<void> {
    const seq = this.reloadSeq;
    if (this.activeTab === "basic") {
      this.presetSection?.setActiveSessionFile(this.activeSessionFile);
      this.promptsSection?.setActiveSessionFile(this.activeSessionFile);
      await Promise.all([
        this.presetSection?.refresh() ?? Promise.resolve(),
        this.promptsSection?.refresh() ?? Promise.resolve(),
        this.refreshActiveSettings(),
      ]);
    } else if (this.activeTab === "scenario") {
      if (!this.scenarioSection) {
        this.renderTabContent();
        return;
      }
      await this.scenarioSection.refreshSession();
    } else if (this.activeTab === "branch") {
      if (!this.branchSection) {
        this.renderTabContent();
        return;
      }
      await this.branchSection.refresh();
    } else if (this.activeTab === "expand") {
      if (!this.expandSection) {
        this.renderTabContent();
        return;
      }
      await this.expandSection.refresh();
    }
    this.scheduleRestoreScroll(this.activeTab, seq);
  }

  private scheduleRestoreScroll(tab: DetailTab, seq: number): void {
    const top = this.tabScrollTop[tab] ?? 0;
    window.requestAnimationFrame(() => {
      if (this.activeTab !== tab || this.reloadSeq !== seq) return;
      this.tabContentEl.scrollTop = top;
      window.requestAnimationFrame(() => {
        if (this.activeTab !== tab || this.reloadSeq !== seq) return;
        this.tabContentEl.scrollTop = top;
      });
    });
  }

  private captureActiveSessionFile(): string | null {
    return this.plugin.getActiveOrLastSessionFile();
  }
}
