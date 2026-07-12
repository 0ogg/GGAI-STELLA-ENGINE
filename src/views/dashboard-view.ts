import {
  ItemView,
  Menu,
  Notice,
  WorkspaceLeaf,
  debounce,
  setIcon,
} from "obsidian";
import { VIEW_TYPE_DASHBOARD } from "../constants";
import type StellaEnginePlugin from "../main";
import { StellaStore, type SessionChangeDetail } from "../state/store";
import type { LorebookListItem } from "../util/scan-lorebooks";
import type { PromptListItem } from "../util/scan-prompts";
import {
  buildDefaultPromptPreset,
  NEW_PRESET_BASE_NAME,
} from "../util/default-prompt-preset";
import type { ScenarioListItem } from "../util/scan-scenarios";
import type { SessionListItem } from "../util/scan-sessions";
import type { UserListItem } from "../util/scan-users";
import { formatRelativeTime } from "../util/relative-time";
import { renderThumb } from "../util/render-thumb";
import { PressMenuController } from "../util/press-menu";
import {
  latestIllustrationVariant,
  removeIllustrationVariant,
  toggleIllustrationFavorite,
} from "../util/illustrations";
import { getDeepestLatestDescendant } from "../util/session-tree";
import { IllustrationGalleryModal, type GalleryItem } from "./gallery-modal";
import { openImageLightbox } from "./image-lightbox";
import {
  collectScenarioTags,
  compareBy,
  getFavorite,
  pickRecommendedScenarios,
  scenarioTags,
  sessionMetaLabel,
  sessionRecentTime,
  type SortKey,
} from "../util/scenario-list-helpers";
import {
  confirmDeleteLorebook,
  confirmDeleteScenario,
  confirmDeleteSession,
  confirmDeleteUser,
  copyScenarioWithPrompt,
  createAndOpenSession,
  exportPromptPreset,
  openGroupCreator,
  openSessionByPath,
  promptNewLorebook,
  promptNewScenario,
  promptNewUser,
  runImportPicker,
} from "./entity-actions";
import { buildSessionMenu } from "./session-menu";
import { BranchSection } from "./detail/branch-section";
import { PromptSetEditorSection } from "./detail/prompt-set-editor-section";
import { UserEditorSection } from "./user-editor-section";
import { ScenarioEditorSection } from "./scenario-editor-section";
import { LorebookEditorSection } from "./lorebook-editor-section";
import { ConfirmModal } from "./modals";

export type DashboardTab =
  | "home"
  | "scenario"
  | "session"
  | "gallery"
  | "user"
  | "lorebook"
  | "prompt";

/** 대시보드 내부 편집 페이지 종류. */
export type EditorKind = "user" | "prompt" | "scenario" | "lorebook";
export interface EditorRoute {
  kind: EditorKind;
  file: string;
}

/** 대시보드 내부 라우트 — 뒤로가기 스택 한 칸. */
interface DashRoute {
  tab: DashboardTab;
  detailFolder: string | null;
  branchSessionFile: string | null;
  editorRoute: EditorRoute | null;
  scrollTop: number;
}

/** 홈 상단에 크게 보여줄 최근 세션(히어로) 수. */
const HERO_SESSION_LIMIT = 2;
/** 최근 세션 수집 시 살펴볼 최근 플레이 시나리오 수 (전체 vault 스캔 방지). */
const RECENT_SCENARIO_SCAN_LIMIT = 8;
/** 홈 추천 카드 수. */
const RECOMMEND_LIMIT = 6;
/** 홈 "최근 삽화" 스트립에 넣을 삽화 수. */
const HOME_ILLUST_LIMIT = 12;
/** 홈 캐러셀 자동 넘김 주기(ms). */
const CAROUSEL_INTERVAL_MS = 4000;
/** 손으로 조작한 뒤 자동 넘김을 다시 켜기까지 대기(ms). */
const CAROUSEL_RESUME_MS = 5000;
/** 세션 탭 한 번에 그리는 세션 수(더 보기로 증가). */
const SESSION_TAB_PAGE = 30;

interface RecentSessionItem {
  session: SessionListItem;
  scenario: ScenarioListItem;
  /** 세션의 최신 삽화 경로 — 없으면 null(시나리오 표지를 배경으로 쓴다). */
  illustrationPath: string | null;
}

/** 갤러리 탭 — 한 삽화 variant 를 세션/시나리오 귀속과 함께. */
interface GalleryEntry {
  src: string;
  sessionFile: string;
  scenarioName: string;
  scenarioFolder: string;
  nodeId: string;
  variantId: string;
  createdAt: number;
  favorite: boolean;
}

/** 갤러리 분류 칩 필터 — "" 전체 / "__fav__" 즐겨찾기 / 그 외 시나리오 folder. */
const GALLERY_FAVORITE_FILTER = "__fav__";

/**
 * DashboardView — Stella 패널의 로비 (대문).
 *
 * 탭 4개: 홈(이어서 하기/추천/미리보기) · 시나리오(검색/정렬/태그 탐색 + 전체 관리)
 * · 페르소나 · 로어북. 항목이 많아도 탭별 검색/필터로 탐색하고, 생성/임포트/이름변경/
 * 삭제까지 사이드바 없이 처리할 수 있는 메인 창구.
 *
 * 데이터는 전부 store 캐시/이벤트 경유. 탭 툴바(검색창 등)는 탭 전환 때만 다시
 * 만들고, store 이벤트는 목록 영역만 국소 갱신해 입력 포커스/스크롤을 보존한다.
 */
export class DashboardView extends ItemView {
  private plugin: StellaEnginePlugin;
  private store: StellaStore;
  private pressMenu = new PressMenuController();

  private scenarios: ScenarioListItem[] = [];
  private recentSessions: RecentSessionItem[] = [];
  /** 세션 탭 — 모든 시나리오의 세션을 최근 플레이순으로. */
  private allSessions: Array<{
    session: SessionListItem;
    scenario: ScenarioListItem;
  }> = [];
  private sessionDisplayLimit = SESSION_TAB_PAGE;
  /** 세션 탭 "시리즈 보기" 토글 — 다음화로 연결된 세션들을 시리즈 단위로 묶어 보기. */
  private sessionSeriesView = false;
  private users: UserListItem[] = [];
  private lorebooks: LorebookListItem[] = [];
  private promptPresets: PromptListItem[] = [];

  /** 갤러리 탭 집계(전 세션 삽화) — null 이면 아직/다시 로드해야 함. */
  private galleryEntries: GalleryEntry[] | null = null;
  /** 갤러리 분류 필터 — "" 전체 / "__fav__" 즐겨찾기 / 그 외 시나리오 folder. */
  private galleryFilter = "";
  /** 갤러리 정렬 — 최신순/오래된순. */
  private gallerySort: "new" | "old" = "new";
  /** 홈 캐러셀 자동 넘김 타이머 — 홈 재렌더/탭 이탈 때 정리. */
  private carouselTimers: number[] = [];

  private activeTab: DashboardTab = "home";
  private scenarioQuery = "";
  private scenarioSort: SortKey = "recent";
  private selectedTags = new Set<string>();
  private userQuery = "";
  private loreQuery = "";
  private promptQuery = "";

  /** 시나리오 상세(세션 관리) 페이지가 열려 있으면 그 시나리오 폴더. */
  private detailFolder: string | null = null;
  private detailSessions: SessionListItem[] = [];
  private detailListEl: HTMLElement | null = null;
  /** 세션 일괄 삭제용 선택 집합 (상세 페이지). */
  private sessionSelection = new Set<string>();
  private selectMode = false;
  /** 인라인 분기(노드/가지치기) 화면이 열려 있으면 그 세션 파일. */
  private branchSessionFile: string | null = null;
  private branch: BranchSection | null = null;
  /** 편집 페이지(페르소나/프롬프트 세트)가 열려 있으면 그 라우트. */
  private editorRoute: EditorRoute | null = null;
  private editorSection:
    | UserEditorSection
    | PromptSetEditorSection
    | ScenarioEditorSection
    | LorebookEditorSection
    | null = null;

  /** 대시보드 내부 뒤로가기 스택. */
  private navStack: DashRoute[] = [];
  /** 앞으로가기 스택 — 뒤로 간 뒤 마우스 앞으로 버튼으로 복귀. 새 이동 시 비운다. */
  private fwdStack: DashRoute[] = [];

  private tabEls: Partial<Record<DashboardTab, HTMLElement>> = {};
  private pageEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private tagChipsEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: StellaEnginePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
  }

  getViewType(): string {
    return VIEW_TYPE_DASHBOARD;
  }

  getDisplayText(): string {
    return "Stella Dashboard";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ggai-stella-dashboard");
    // 일반 Obsidian 테마가 편집창 본문(배경 등)으로 스타일링하도록 기본 편집창 클래스 부여.
    root.addClass("markdown-source-view");

    this.activeTab = this.plugin.data.lastDashboardTab ?? "home";
    // 편집기/세션에서 홈 버튼으로 돌아오면 마지막 상세 페이지를 복원한다.
    this.detailFolder = this.plugin.data.lastDashboardDetail ?? null;
    this.editorRoute = this.plugin.data.lastDashboardEditor ?? null;
    // 편집 페이지로 바로 열린 경우(사이드바에서 세션 중 새 탭), 뒤로가기가 그 항목
    // 목록으로 돌아가도록 기반 탭 라우트를 히스토리에 한 칸 심는다.
    if (this.editorRoute) {
      this.activeTab = this.baseTabForEditor(this.editorRoute.kind);
      this.navStack.push({
        tab: this.activeTab,
        detailFolder: null,
        branchSessionFile: null,
        editorRoute: null,
        scrollTop: 0,
      });
    }

    this.renderChrome(root);
    await this.refreshScenarioData();
    await this.refreshUserData();
    await this.refreshLoreData();
    await this.refreshPromptData();
    this.renderPage();

    const debouncedScenarios = debounce(
      () => void this.refreshScenarioData().then(() => this.refreshSurface()),
      150,
      false
    );
    const debouncedRecent = debounce(
      () => void this.refreshRecentData().then(() => this.refreshSurface()),
      150,
      false
    );
    this.registerEvent(this.store.on("scenarios-changed", debouncedScenarios));
    this.registerEvent(this.store.on("sessions-changed", debouncedScenarios));
    this.registerEvent(
      this.store.on(
        "session-changed",
        (_file: string, detail?: SessionChangeDetail) => {
          // 활성 설정만 바뀐 저장은 홈 히어로/세션 목록 표시와 무관 —
          // 이미지가 있는 카드를 다시 그리지 않는다 (표지 깜빡임 방지).
          if (detail?.kinds?.every((k) => k === "settings")) return;
          debouncedRecent();
        }
      )
    );
    this.registerEvent(
      this.store.on("session-illustrations-changed", debouncedRecent)
    );
    // 안 읽음 뱃지 갱신 (홈 히어로 카드 / 세션 탭 / 시나리오 상세 세션 줄).
    this.registerEvent(this.store.on("session-unread-changed", debouncedRecent));
    this.registerEvent(
      this.store.on("users-changed", () =>
        void this.refreshUserData().then(() => this.refreshSurface())
      )
    );
    this.registerEvent(
      this.store.on("lorebooks-changed", () =>
        void this.refreshLoreData().then(() => this.refreshSurface())
      )
    );
    this.registerEvent(
      this.store.on("session-translations-changed", (file: string) => {
        if (this.branchSessionFile === file) void this.branch?.onTranslationsChanged();
      })
    );

    this.registerEvent(
      this.store.on("prompt-presets-changed", () => {
        void this.refreshPromptData().then(() => this.refreshSurface());
      })
    );

    // AI 연결/프로필 변화 → 홈의 AI 배너·시작 가이드만 다시 그린다.
    const onAiChange = (): void => {
      if (
        this.activeTab === "home" &&
        !this.detailFolder &&
        !this.branchSessionFile &&
        !this.editorRoute
      ) {
        this.renderHome();
      }
    };
    this.registerEvent(this.plugin.ai.on("core-availability-changed", onAiChange));
    this.registerEvent(this.plugin.ai.on("profiles-changed", onAiChange));

    // 마우스 뒤로(3)/앞으로(4) 버튼 → 대시보드 내부 히스토리 이동. 내부 스택이 있을
    // 때만 가로채고(preventDefault), 비어 있으면 옵시디언 기본 탭 히스토리에 넘긴다.
    // 옵시디언 기본 핸들러보다 먼저 잡도록 capture 단계에서, 실행은 pointerup/auxclick
    // 한 곳에서만(중복 방지).
    const suppressNav = (e: MouseEvent): boolean => {
      if (e.button === 3 && this.navStack.length > 0) return true;
      if (e.button === 4 && this.fwdStack.length > 0) return true;
      return false;
    };
    const guard = (e: MouseEvent): void => {
      if (suppressNav(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    this.registerDomEvent(this.contentEl, "mousedown", guard, { capture: true });
    this.registerDomEvent(this.contentEl, "auxclick", guard, { capture: true });
    this.registerDomEvent(this.contentEl, "mouseup", (e: MouseEvent) => {
      if (!suppressNav(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 3) this.goBack();
      else if (e.button === 4) this.goForward();
    }, { capture: true });

    // 모바일 하드웨어/제스처 뒤로 (Capacitor 'backbutton') — 대시보드 내부 히스토리가
    // 있을 때만 가로채 내부 뒤로가기로 쓴다. 내부 스택이 비면 옵시디언 기본 동작에
    // 넘겨(preventDefault 안 함) 앱 탐색을 방해하지 않는다. 데스크톱에선 이 이벤트가
    // 발생하지 않으므로 무해하다.
    const onHwBack = (e: Event): void => {
      if (this.navStack.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.goBack();
    };
    document.addEventListener("backbutton", onHwBack, { capture: true });
    this.register(() =>
      document.removeEventListener("backbutton", onHwBack, { capture: true })
    );
  }

  getState(): Record<string, unknown> {
    return { stellaPanel: true };
  }

  async onClose(): Promise<void> {
    this.stopCarousels();
    // 편집 페이지가 열려 있으면 미저장 편집을 확정한다.
    await this.disposeEditor();
  }

  /** 진행 중인 홈 캐러셀 자동 넘김 타이머를 모두 멈춘다. */
  private stopCarousels(): void {
    for (const t of this.carouselTimers) window.clearInterval(t);
    this.carouselTimers = [];
  }

  /** 외부(우측 프롬프트 섹션 "새 탭에서 편집" 등)에서 특정 탭으로 이동. */
  async jumpToTab(tab: DashboardTab): Promise<void> {
    await this.setTab(tab);
  }

  /** 편집 섹션 정리 — 구독 해제 + 미저장 편집 flush. 라우트 이동/뷰 종료 시 호출. */
  private async disposeEditor(): Promise<void> {
    if (!this.editorSection) return;
    const section = this.editorSection;
    this.editorSection = null;
    await section.dispose();
  }

  /** 편집 페이지 종류에 대응하는 기반 목록 탭 (뒤로가기 기본 도착지). */
  private baseTabForEditor(kind: EditorKind): DashboardTab {
    switch (kind) {
      case "user":
        return "user";
      case "prompt":
        return "prompt";
      case "scenario":
        return "scenario";
      case "lorebook":
        return "lorebook";
    }
  }

  /**
   * 외부(사이드바/자기 목록)에서 편집 페이지로 진입 — 대시보드 내부 라우트로 연다.
   * 현재 화면을 히스토리에 쌓아 뒤로가기로 돌아올 수 있게 한다.
   */
  navigateToEditor(kind: EditorKind, file: string): void {
    this.pushHistory();
    this.detailFolder = null;
    this.branchSessionFile = null;
    this.editorRoute = { kind, file };
    this.selectMode = false;
    this.sessionSelection.clear();
    this.updateTabChrome();
    this.renderPage();
    this.contentEl.scrollTop = 0;
    void this.persistRoute();
  }

  /**
   * store 변경 후 현재 화면 갱신. 인라인 분기 화면일 때는 BranchSection 을
   * 통째로 다시 만들지 않고 제자리 refresh 해서 확대/펼침 상태를 보존한다.
   * 편집 페이지는 섹션이 자체 구독으로 갱신하므로 여기서 다시 그리지 않는다.
   */
  private refreshSurface(): void {
    if (this.editorRoute) return;
    if (this.branchSessionFile) {
      void this.branch?.refresh();
      return;
    }
    this.renderListOnly();
  }

  // ─── data ─────────────────────────────────────────────

  private async refreshScenarioData(): Promise<void> {
    this.scenarios = await this.store.refreshScenarios().catch(() => []);
    await this.refreshRecentData();
  }

  private async refreshRecentData(): Promise<void> {
    this.recentSessions = await this.loadRecentSessions();
    this.allSessions = await this.loadAllSessions();
    // 삽화/세션이 바뀌었으니 갤러리 집계는 다음 렌더에서 다시 만든다.
    this.galleryEntries = null;
  }

  /** 모든 시나리오의 세션을 모아 최근 플레이순으로. 세션 탭/갤러리 공통 소스. */
  private async loadAllSessions(): Promise<
    Array<{ session: SessionListItem; scenario: ScenarioListItem }>
  > {
    const flat: Array<{ session: SessionListItem; scenario: ScenarioListItem }> =
      [];
    for (const scenario of this.scenarios) {
      if (scenario.sessionCount === 0) continue;
      const sessions = await this.store.getSessions(scenario.folder).catch(() => []);
      for (const session of sessions) flat.push({ session, scenario });
    }
    flat.sort(
      (a, b) => sessionRecentTime(b.session) - sessionRecentTime(a.session)
    );
    return flat;
  }

  private async refreshUserData(): Promise<void> {
    this.users = await this.store.refreshUsers().catch(() => []);
  }

  private async refreshLoreData(): Promise<void> {
    this.lorebooks = await this.store.refreshLorebooks().catch(() => []);
  }

  private async refreshPromptData(): Promise<void> {
    this.promptPresets = await this.store.getPromptPresets().catch(() => []);
  }

  /** 최근 플레이한 시나리오 몇 개의 세션만 모아 최신순 상위 N 개 + 카드 썸네일 결정. */
  private async loadRecentSessions(): Promise<RecentSessionItem[]> {
    const candidates = this.scenarios
      .filter((s) => s.sessionCount > 0)
      .sort((a, b) => (b.lastSessionAt ?? 0) - (a.lastSessionAt ?? 0))
      .slice(0, RECENT_SCENARIO_SCAN_LIMIT);

    const flat: Array<{ session: SessionListItem; scenario: ScenarioListItem }> = [];
    for (const scenario of candidates) {
      const sessions = await this.store.getSessions(scenario.folder).catch(() => []);
      for (const session of sessions) flat.push({ session, scenario });
    }
    flat.sort((a, b) => sessionRecentTime(b.session) - sessionRecentTime(a.session));

    const out: RecentSessionItem[] = [];
    for (const { session, scenario } of flat.slice(0, HERO_SESSION_LIMIT)) {
      out.push({
        session,
        scenario,
        illustrationPath: await this.resolveSessionIllustration(session),
      });
    }
    return out;
  }

  /** 세션의 최신 삽화 경로 — 없으면 null. */
  private async resolveSessionIllustration(
    session: SessionListItem
  ): Promise<string | null> {
    try {
      const illustrations = await this.store.getSessionIllustrations(
        session.sessionFile
      );
      const latest = latestIllustrationVariant(illustrations);
      if (latest) {
        const path = `${session.folder}/${latest.path}`;
        if (this.app.vault.getAbstractFileByPath(path)) return path;
      }
    } catch (err) {
      console.warn("[GGAI Stella] 세션 삽화 썸네일 결정 실패:", err);
    }
    return null;
  }

  // ─── chrome (탭 바) ───────────────────────────────────

  private renderChrome(root: HTMLElement): void {
    const topbar = root.createDiv({ cls: "ggai-dash-topbar" });
    const bar = topbar.createDiv({ cls: "ggai-dash-topbar-inner" });

    // 상단 고정 뒤로가기 버튼은 두지 않는다 — 마우스/하드웨어 뒤로 + 각 페이지의
    // 뒤로 헤더(목록으로)로 이동한다.
    const tabs = bar.createDiv({ cls: "ggai-dash-tabs" });
    tabs.setAttr("role", "tablist");
    const defs: Array<{ tab: DashboardTab; label: string; icon: string }> = [
      { tab: "home", label: "홈", icon: "sparkles" },
      { tab: "scenario", label: "시나리오", icon: "scroll-text" },
      { tab: "session", label: "세션", icon: "history" },
      { tab: "gallery", label: "갤러리", icon: "image" },
      { tab: "user", label: "페르소나", icon: "user" },
      { tab: "lorebook", label: "로어북", icon: "book-open" },
      { tab: "prompt", label: "프롬프트", icon: "list-tree" },
    ];
    for (const def of defs) {
      const el = tabs.createDiv({ cls: "ggai-dash-tab" });
      if (def.tab === "home") {
        el.addClass("ggai-dash-tab-home");
        el.setAttr("aria-label", def.label);
        const logo = el.createDiv({ cls: "ggai-dash-tab-logo" });
        const comet = logo.createDiv({ cls: "comet" });
        comet.createDiv({ cls: "trail" });
        comet.createDiv({ cls: "star" });
        const holo = logo.createDiv({ cls: "ggai-dash-tab-holo2" });
        holo.createSpan({ cls: "a", text: "STELLA" });
        holo.createSpan({ cls: "b", text: "ENGINE" });
      } else {
        const icon = el.createSpan({ cls: "ggai-dash-tab-icon" });
        setIcon(icon, def.icon);
        el.createSpan({ text: def.label });
      }
      el.setAttr("role", "tab");
      el.setAttr("tabindex", "0");
      el.addEventListener("click", () => void this.setTab(def.tab));
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        void this.setTab(def.tab);
      });
      this.tabEls[def.tab] = el;
    }
    this.updateTabChrome();

    this.pageEl = root.createDiv({ cls: "ggai-dash-page" });
  }

  private updateTabChrome(): void {
    for (const tab of [
      "home",
      "scenario",
      "session",
      "gallery",
      "user",
      "lorebook",
      "prompt",
    ] as DashboardTab[]) {
      const el = this.tabEls[tab];
      if (!el) continue;
      const active =
        this.activeTab === tab &&
        !this.detailFolder &&
        !this.branchSessionFile &&
        !this.editorRoute;
      el.toggleClass("is-active", active);
      el.setAttr("aria-selected", String(active));
    }
  }

  /** 지금 보고 있는 라우트를 스냅샷으로. */
  private captureRoute(): DashRoute {
    return {
      tab: this.activeTab,
      detailFolder: this.detailFolder,
      branchSessionFile: this.branchSessionFile,
      editorRoute: this.editorRoute,
      scrollTop: this.contentEl.scrollTop,
    };
  }

  /** 스냅샷 라우트를 적용해 화면 전환. */
  private applyRoute(route: DashRoute): void {
    this.activeTab = route.tab;
    this.detailFolder = route.detailFolder;
    this.branchSessionFile = route.branchSessionFile;
    this.editorRoute = route.editorRoute;
    this.selectMode = false;
    this.sessionSelection.clear();
    this.updateTabChrome();
    this.renderPage();
    this.contentEl.scrollTop = route.scrollTop;
    void this.persistRoute();
  }

  /** 현재 라우트를 히스토리에 쌓는다 (이동 직전 호출). 새 이동이므로 앞으로가기는 비운다. */
  private pushHistory(): void {
    this.navStack.push(this.captureRoute());
    this.fwdStack = [];
  }

  /** 대시보드 내부 뒤로가기 — 한 단계 전 라우트로. */
  private goBack(): void {
    const prev = this.navStack.pop();
    if (!prev) return;
    this.fwdStack.push(this.captureRoute());
    this.applyRoute(prev);
  }

  /** 대시보드 내부 앞으로가기 — 뒤로 간 걸 되돌린다 (마우스 앞으로 버튼). */
  private goForward(): void {
    const next = this.fwdStack.pop();
    if (!next) return;
    this.navStack.push(this.captureRoute());
    this.applyRoute(next);
  }

  private async persistRoute(): Promise<void> {
    await this.plugin.savePluginData({
      lastDashboardTab: this.activeTab,
      lastDashboardDetail: this.detailFolder,
      lastDashboardEditor: this.editorRoute,
    });
  }

  private async setTab(next: DashboardTab): Promise<void> {
    if (
      this.activeTab === next &&
      !this.detailFolder &&
      !this.branchSessionFile &&
      !this.editorRoute
    ) {
      return;
    }
    this.pushHistory();
    this.detailFolder = null;
    this.branchSessionFile = null;
    this.editorRoute = null;
    this.selectMode = false;
    this.sessionSelection.clear();
    this.activeTab = next;
    this.updateTabChrome();
    this.renderPage();
    this.contentEl.scrollTop = 0;
    await this.persistRoute();
  }

  // ─── page render ──────────────────────────────────────

  /** 활성 탭의 페이지 전체(툴바 + 목록)를 다시 만든다 — 탭 전환/최초에만. */
  private renderPage(): void {
    const page = this.pageEl;
    if (!page) return;
    this.stopCarousels();
    // 이전 편집 섹션이 있으면 정리(구독 해제 + 미저장 편집 flush) 후 화면을 비운다.
    void this.disposeEditor();
    page.empty();
    this.listEl = null;
    this.tagChipsEl = null;
    this.detailListEl = null;
    this.branch = null;

    // 편집 페이지(페르소나 등) — 탭 위에 얹히는 별도 페이지.
    if (this.editorRoute) {
      this.listEl = page.createDiv({ cls: "ggai-dash-editor" });
      this.renderEditorPage();
      return;
    }
    // 인라인 분기(노드/가지치기) — 탭 위에 얹히는 전체 화면.
    if (this.branchSessionFile) {
      this.listEl = page.createDiv({ cls: "ggai-dash-branch" });
      this.renderListOnly();
      return;
    }
    // 시나리오 상세(세션 관리)는 탭 위에 얹히는 별도 페이지.
    if (this.detailFolder) {
      this.listEl = page.createDiv({ cls: "ggai-dash-detail" });
      this.renderListOnly();
      return;
    }

    switch (this.activeTab) {
      case "home":
        this.listEl = page.createDiv({ cls: "ggai-dash-home" });
        break;
      case "scenario":
        this.renderScenarioToolbar(page);
        this.tagChipsEl = page.createDiv({ cls: "ggai-dash-chips" });
        this.listEl = page.createDiv({ cls: "ggai-dash-grid" });
        break;
      case "session":
        this.listEl = page.createDiv({ cls: "ggai-dash-session-tab" });
        break;
      case "gallery":
        this.listEl = page.createDiv({ cls: "ggai-dash-gallery-tab" });
        break;
      case "user":
        this.renderUserToolbar(page);
        this.listEl = page.createDiv({ cls: "ggai-dash-user-grid" });
        break;
      case "lorebook":
        this.renderLoreToolbar(page);
        this.listEl = page.createDiv({ cls: "ggai-dash-lore-grid" });
        break;
      case "prompt":
        this.renderPromptToolbar(page);
        this.listEl = page.createDiv({ cls: "ggai-dash-prompt-list" });
        break;
    }
    this.renderListOnly();
  }

  /** 목록 영역만 국소 갱신 — 검색 입력/스크롤 보존. */
  private renderListOnly(): void {
    // 편집 페이지는 섹션이 자체 구독으로 갱신하므로 국소 갱신에서 손대지 않는다.
    if (this.editorRoute) return;
    if (this.branchSessionFile) {
      this.renderBranchPage();
      return;
    }
    if (this.detailFolder) {
      this.renderScenarioDetail();
      return;
    }
    switch (this.activeTab) {
      case "home":
        this.renderHome();
        break;
      case "scenario":
        this.renderTagChips();
        this.renderScenarioList();
        break;
      case "session":
        this.renderSessionTab();
        break;
      case "gallery":
        this.renderGalleryTab();
        break;
      case "user":
        this.renderUserList();
        break;
      case "lorebook":
        this.renderLoreList();
        break;
      case "prompt":
        this.renderPromptList();
        break;
    }
  }

  // ─── 프롬프트 탭 (세트 라이브러리 — 세션과 무관) ────────

  private renderPromptToolbar(page: HTMLElement): void {
    const bar = page.createDiv({ cls: "ggai-dash-toolbar" });
    const search = bar.createEl("input", {
      cls: "ggai-dash-search",
      type: "search",
    });
    search.placeholder = "프롬프트 세트 검색";
    search.value = this.promptQuery;
    search.addEventListener("input", () => {
      this.promptQuery = search.value;
      this.renderPromptList();
    });
    const addBtn = this.renderToolbarButton(bar, "plus", "새 세트", () =>
      void this.createAndOpenPromptSet()
    );
    addBtn.addClass("mod-cta");
    this.renderToolbarButton(bar, "download", "임포트", () =>
      runImportPicker(this.plugin)
    );
  }

  private renderPromptList(): void {
    const body = this.listEl;
    if (!body || this.activeTab !== "prompt") return;
    body.empty();

    const q = this.promptQuery.trim().toLowerCase();
    const visible = this.promptPresets.filter((p) => {
      if (!q) return true;
      const n = (p.preset.meta.name ?? "").toLowerCase();
      return n.includes(q) || p.folderName.toLowerCase().includes(q);
    });
    if (visible.length === 0) {
      this.renderEmpty(
        body,
        this.promptPresets.length === 0
          ? "프롬프트 세트가 없습니다. [새 세트] 또는 [임포트]로 시작하세요."
          : "검색 결과가 없습니다."
      );
      return;
    }

    for (const item of visible) {
      const name = item.preset.meta.name || item.folderName;
      const row = body.createDiv({ cls: "ggai-dash-prompt-row" });

      const icon = row.createDiv({ cls: "ggai-dash-prompt-icon" });
      setIcon(icon, item.preset.meta.favorite ? "star" : "list-tree");

      const text = row.createDiv({ cls: "ggai-dash-prompt-text" });
      text.createDiv({ cls: "ggai-dash-prompt-name", text: name });
      text.createDiv({
        cls: "ggai-dash-prompt-meta",
        text: `${item.preset.prompts.length} 항목`,
      });

      this.makePressable(row, () =>
        this.navigateToEditor("prompt", item.presetFile)
      );
      this.pressMenu.attachContextMenu(
        row,
        (e) => this.promptMenu(item).showAtMouseEvent(e),
        (x, y) => this.promptMenu(item).showAtPosition({ x, y })
      );
    }
  }

  private promptMenu(item: PromptListItem): Menu {
    const menu = new Menu();
    menu.addItem((mi) =>
      mi
        .setTitle("편집")
        .setIcon("pencil")
        .onClick(() => this.navigateToEditor("prompt", item.presetFile))
    );
    menu.addItem((mi) =>
      mi
        .setTitle(item.preset.meta.favorite ? "즐겨찾기 해제" : "즐겨찾기")
        .setIcon("star")
        .onClick(() => void this.store.togglePromptFavorite(item.presetFile))
    );
    menu.addItem((mi) =>
      mi
        .setTitle("내보내기")
        .setIcon("upload")
        .onClick(() => void exportPromptPreset(this.plugin, item.presetFile))
    );
    menu.addItem((mi) =>
      mi
        .setTitle("삭제")
        .setIcon("trash-2")
        .onClick(() => this.confirmDeletePromptSet(item))
    );
    return menu;
  }

  private confirmDeletePromptSet(item: PromptListItem): void {
    const name = item.preset.meta.name || item.folderName;
    new ConfirmModal(
      this.plugin.app,
      "프롬프트 세트 삭제",
      `"${name}" 세트를 삭제할까요? (되돌릴 수 없습니다)`,
      "삭제",
      (confirmed) => {
        if (!confirmed) return;
        void (async () => {
          try {
            await this.store.deletePromptPreset(item.presetFile);
            new Notice(`프롬프트 세트 삭제: ${name}`);
          } catch (err) {
            new Notice(
              `삭제 실패: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })();
      }
    ).open();
  }

  private async createAndOpenPromptSet(): Promise<void> {
    try {
      const init = buildDefaultPromptPreset(NEW_PRESET_BASE_NAME);
      const result = await this.store.createPromptPreset(
        NEW_PRESET_BASE_NAME,
        init
      );
      await this.refreshPromptData();
      this.navigateToEditor("prompt", result.presetFile);
    } catch (err) {
      new Notice(
        `세트 생성 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ─── 홈 탭 ────────────────────────────────────────────

  private renderHome(): void {
    const body = this.listEl;
    if (!body) return;
    this.stopCarousels();
    body.empty();

    // 상단: 활성 페르소나 + [임포트][새 시나리오] 한 줄.
    this.renderHomeTopline(body);

    // 첫 설치(시나리오 0개) — AI 연결 상태를 반영한 시작 가이드.
    if (this.scenarios.length === 0) {
      this.renderOnboarding(body);
      return;
    }

    // 이미 쓰던 사용자인데 AI 가 연결 안 됐으면 상단에 안내 배너.
    if (this.aiStatus() !== "ready") this.renderAiBanner(body);

    // 1. 이어하기 — 최근 세션 히어로 2장.
    if (this.recentSessions.length > 0) {
      const section = this.renderSection(body, "이어하기");
      const row = section.createDiv({ cls: "ggai-dash-hero-row" });
      const activeFile = this.plugin.getActiveOrLastSessionFile();
      for (const item of this.recentSessions.slice(0, HERO_SESSION_LIMIT)) {
        this.renderHeroCard(row, item, activeFile);
      }
    }

    // 2. 시나리오 추천 — 히어로에 뜬 시나리오를 빼고, 안 해봤거나 오래 쉰 시나리오. 캐러셀.
    const excludeFolders = new Set(
      this.recentSessions.slice(0, HERO_SESSION_LIMIT).map((r) => r.scenario.folder)
    );
    const recs = pickRecommendedScenarios(this.scenarios, {
      excludeFolders,
      limit: RECOMMEND_LIMIT,
    });
    if (recs.length > 0) {
      const section = this.renderSection(body, "시나리오 추천");
      const row = section.createDiv({ cls: "ggai-dash-hstrip" });
      for (const rec of recs) {
        const card = this.renderScenarioPoster(row, rec.item, { compact: true });
        card.createDiv({ cls: "ggai-dash-reason-badge", text: rec.reason });
      }
      this.setupCarousel(row);
    }

    // 3. 최근 삽화 — 캐러셀.
    this.renderHomeIllustrationStrip(body);

    // 4. 내 서재 — 요약 카운트.
    this.renderHomeStats(body);
  }

  /** 홈 상단 한 줄 — 활성 페르소나(클릭 시 페르소나 탭) + [임포트][새 시나리오]. */
  private renderHomeTopline(body: HTMLElement): void {
    const line = body.createDiv({ cls: "ggai-dash-home-topline" });

    const persona = line.createDiv({ cls: "ggai-dash-home-persona" });
    const p = this.resolveActivePersona();
    const av = persona.createDiv({ cls: "ggai-dash-home-avatar" });
    renderThumb(this.app, av, p.thumbPath, p.name || "Persona", "user");
    const meta = persona.createDiv({ cls: "ggai-dash-home-persona-meta" });
    meta.createDiv({ cls: "ggai-dash-home-persona-label", text: "플레이 중" });
    meta.createDiv({
      cls: "ggai-dash-home-persona-name",
      text: p.name || "페르소나 없음",
    });
    this.makePressable(persona, () => void this.setTab("user"));

    const actions = line.createDiv({ cls: "ggai-dash-home-actions" });
    this.renderToolbarButton(actions, "download", "임포트", () =>
      runImportPicker(this.plugin)
    );
    this.renderToolbarButton(actions, "users", "그룹 만들기", () =>
      void openGroupCreator(this.plugin)
    );
    const add = this.renderToolbarButton(actions, "plus", "새 시나리오", () =>
      promptNewScenario(this.plugin)
    );
    add.addClass("mod-cta");
  }

  /** 활성 페르소나 표지/이름 — 세션과 무관한 현재 활성 유저. */
  private resolveActivePersona(): { thumbPath: string | null; name: string } {
    const active = this.activeUserProfileFile();
    const u =
      this.users.find((x) => x.userFile === active) ??
      this.users.find((x) => x.profile.id === "default") ??
      this.users[0];
    if (!u) return { thumbPath: null, name: "" };
    return { thumbPath: u.thumbnailPath, name: u.profile.name };
  }

  /** 홈 "최근 삽화" 가로 스트립(캐러셀). 갤러리 집계가 없으면 로드만 걸고 건너뛴다. */
  private renderHomeIllustrationStrip(body: HTMLElement): void {
    if (this.galleryEntries === null) {
      void this.loadGalleryEntries();
      return;
    }
    if (this.galleryEntries.length === 0) return;
    const recent = this.galleryEntries
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, HOME_ILLUST_LIMIT);

    const section = this.renderSection(body, "최근 삽화");
    const row = section.createDiv({ cls: "ggai-dash-hstrip" });
    recent.forEach((entry, i) => {
      const cell = row.createDiv({ cls: "ggai-dash-home-illust" });
      const img = cell.createEl("img");
      img.src = entry.src;
      img.loading = "lazy";
      this.makePressable(cell, () =>
        openImageLightbox(
          recent.map((e) => ({ src: e.src })),
          i
        )
      );
    });
    this.setupCarousel(row);
  }

  /** 홈 "내 서재" — 시나리오/세션/삽화/페르소나 개수. */
  private renderHomeStats(body: HTMLElement): void {
    const section = this.renderSection(body, "내 서재");
    const grid = section.createDiv({ cls: "ggai-dash-stats" });
    const add = (n: string, label: string, tab: DashboardTab): void => {
      const c = grid.createDiv({ cls: "ggai-dash-stat" });
      c.createDiv({ cls: "ggai-dash-stat-n", text: n });
      c.createDiv({ cls: "ggai-dash-stat-l", text: label });
      setIcon(c.createSpan({ cls: "ggai-dash-stat-go" }), "chevron-right");
      this.makePressable(c, () => void this.setTab(tab));
    };
    add(String(this.scenarios.length), "시나리오", "scenario");
    add(String(this.allSessions.length), "세션", "session");
    add(
      this.galleryEntries === null ? "…" : String(this.galleryEntries.length),
      "삽화",
      "gallery"
    );
    add(String(this.users.length), "페르소나", "user");
  }

  /** AI 준비 상태 — Core 미설치 / 프로필 없음 / 준비됨. */
  private aiStatus(): "no-core" | "no-profile" | "ready" {
    if (!this.plugin.ai.isAvailable()) return "no-core";
    if (this.plugin.ai.listGenerationProfiles().length === 0) return "no-profile";
    return "ready";
  }

  /** 이미 시나리오가 있는데 AI 가 연결 안 됐을 때 상단 안내 배너. */
  private renderAiBanner(body: HTMLElement): void {
    const status = this.aiStatus();
    const banner = body.createDiv({ cls: "ggai-dash-ai-banner" });
    setIcon(banner.createDiv({ cls: "ggai-dash-ai-icon" }), "plug");
    const main = banner.createDiv({ cls: "ggai-dash-ai-main" });
    main.createDiv({
      cls: "ggai-dash-ai-title",
      text:
        status === "no-core"
          ? "AI가 아직 연결되지 않았습니다"
          : "사용할 모델이 없습니다",
    });
    main.createDiv({
      cls: "ggai-dash-ai-desc",
      text:
        status === "no-core"
          ? "생성은 GGAI Core를 통해 이뤄집니다. 설치·활성화하세요."
          : "GGAI Core에서 사용할 모델(프로필)을 하나 추가하세요.",
    });
    const btn = banner.createEl("button", {
      cls: "ggai-btn ggai-dash-tool-btn mod-cta",
    });
    setIcon(btn, "settings");
    btn.createSpan({ text: "설정 열기" });
    btn.addEventListener("click", () => this.openCoreSettings());
  }

  /** 첫 설치 시작 가이드 — AI 연결 상태를 반영한 3단계 체크리스트. */
  private renderOnboarding(body: HTMLElement): void {
    const ready = this.aiStatus() === "ready";
    const section = this.renderSection(body, "시작하기");
    const steps = section.createDiv({ cls: "ggai-dash-onboard" });

    this.renderOnboardStep(steps, {
      n: 1,
      done: ready,
      title: "AI 연결",
      desc: ready ? "모델 프로필 준비됨" : "GGAI Core에서 모델 프로필 준비",
      action: ready ? null : () => this.openCoreSettings(),
    });
    this.renderOnboardStep(steps, {
      n: 2,
      done: this.scenarios.length > 0,
      title: "시나리오 가져오기 또는 만들기",
      desc: "실리태번·NovelAI 파일 임포트 / 새로 만들기",
      action: () => runImportPicker(this.plugin),
    });
    this.renderOnboardStep(steps, {
      n: 3,
      done: this.allSessions.length > 0,
      title: "새 세션 시작",
      desc: "첫 이야기 쓰기",
      action: null,
    });
  }

  private renderOnboardStep(
    parent: HTMLElement,
    opts: {
      n: number;
      done: boolean;
      title: string;
      desc: string;
      action: (() => void) | null;
    }
  ): void {
    const step = parent.createDiv({ cls: "ggai-dash-onboard-step" });
    step.toggleClass("is-done", opts.done);
    const badge = step.createDiv({ cls: "ggai-dash-onboard-n" });
    if (opts.done) setIcon(badge, "check");
    else badge.setText(String(opts.n));
    const main = step.createDiv({ cls: "ggai-dash-onboard-main" });
    main.createDiv({ cls: "ggai-dash-onboard-title", text: opts.title });
    main.createDiv({ cls: "ggai-dash-onboard-desc", text: opts.desc });
    if (opts.action && !opts.done) {
      const go = step.createEl("button", { cls: "ggai-dash-onboard-go" });
      setIcon(go, "arrow-right");
      go.setAttr("aria-label", opts.title);
      go.addEventListener("click", opts.action);
    }
  }

  /** GGAI Core 설정 탭을 연다(가능하면 ggai-core 탭으로). */
  private openCoreSettings(): void {
    const setting = (this.plugin.app as any).setting;
    if (!setting?.open) {
      new Notice("설정 화면을 열 수 없습니다.");
      return;
    }
    setting.open();
    try {
      setting.openTabById?.("ggai-core");
    } catch {
      // 구버전 옵시디언은 openTabById 미지원 — 일반 설정창에 머무름.
    }
  }

  /**
   * 가로 스트립을 일정 주기로 한 칸씩 자동으로 넘긴다.
   *  - 마우스 hover / 터치 / 휠 조작 중에는 멈추고, 잠시 뒤 다시 켠다.
   *  - "동작 줄이기" 설정이면 자동 넘김을 아예 켜지 않는다(수동 스크롤은 그대로).
   */
  private setupCarousel(strip: HTMLElement): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let hovering = false;
    let touching = false;
    let manualUntil = 0;

    strip.addEventListener("pointerenter", () => (hovering = true));
    strip.addEventListener("pointerleave", () => (hovering = false));
    strip.addEventListener("pointerdown", () => (touching = true));
    const release = (): void => {
      touching = false;
      manualUntil = Date.now() + CAROUSEL_RESUME_MS;
    };
    strip.addEventListener("pointerup", release);
    strip.addEventListener("pointercancel", release);
    strip.addEventListener(
      "wheel",
      () => (manualUntil = Date.now() + CAROUSEL_RESUME_MS),
      { passive: true }
    );

    const timer = window.setInterval(() => {
      if (!strip.isConnected) {
        window.clearInterval(timer);
        return;
      }
      if (hovering || touching || Date.now() < manualUntil) return;
      const first = strip.firstElementChild as HTMLElement | null;
      if (!first) return;
      const step = first.getBoundingClientRect().width + 12;
      const maxScroll = strip.scrollWidth - strip.clientWidth;
      if (maxScroll <= 0) return;
      const next =
        strip.scrollLeft >= maxScroll - 2 ? 0 : strip.scrollLeft + step;
      strip.scrollTo({ left: Math.min(next, maxScroll), behavior: "smooth" });
    }, CAROUSEL_INTERVAL_MS);
    this.carouselTimers.push(timer);
  }

  /** 히어로에 표시할 페르소나 — 세션이 기억한 것 우선, 없으면 현재 활성(최소 기본). */
  private resolveHeroPersona(
    session: SessionListItem["session"]
  ): { thumbPath: string | null; name: string } {
    const file = session.meta.personaFile;
    let u = file ? this.users.find((x) => x.userFile === file) : undefined;
    if (!u) {
      const active = this.activeUserProfileFile();
      u =
        this.users.find((x) => x.userFile === active) ??
        this.users.find((x) => x.profile.id === "default") ??
        this.users[0];
    }
    if (!u) return { thumbPath: null, name: "" };
    return { thumbPath: u.thumbnailPath, name: u.profile.name };
  }

  /**
   * 홈 히어로 카드 — 배경은 세션 최신 삽화(없으면 시나리오 표지),
   * 그 위에 페르소나 표지(항상) + 삽화 배경일 때만 시나리오 표지를 작게 얹는다.
   */
  private renderHeroCard(
    parent: HTMLElement,
    item: RecentSessionItem,
    activeFile: string | null
  ): void {
    const card = parent.createDiv({ cls: "ggai-dash-hero-card" });
    card.toggleClass("is-active", item.session.sessionFile === activeFile);

    const scenarioName =
      item.scenario.scenario.data.name || item.scenario.folderName;
    const hasIllust = !!item.illustrationPath;

    const bg = card.createDiv({ cls: "ggai-dash-hero-bg" });
    renderThumb(
      this.app,
      bg,
      hasIllust ? item.illustrationPath : item.scenario.thumbnailPath,
      scenarioName,
      "scroll-text"
    );
    card.createDiv({ cls: "ggai-dash-card-shade" });

    // 표지 오버레이 — 페르소나는 항상, 시나리오 표지는 삽화가 배경일 때만.
    const covers = card.createDiv({ cls: "ggai-dash-hero-covers" });
    const persona = this.resolveHeroPersona(item.session.session);
    const pCover = covers.createDiv({
      cls: "ggai-dash-hero-cover is-persona",
    });
    renderThumb(this.app, pCover, persona.thumbPath, persona.name || "Persona", "user");
    if (hasIllust) {
      const sCover = covers.createDiv({
        cls: "ggai-dash-hero-cover is-scenario",
      });
      renderThumb(this.app, sCover, item.scenario.thumbnailPath, scenarioName, "scroll-text");
    }

    const info = card.createDiv({ cls: "ggai-dash-hero-info" });
    const titleEl = info.createDiv({ cls: "ggai-dash-hero-session" });
    titleEl.createSpan({
      text: item.session.session.meta.name || item.session.folderName,
    });
    this.appendUnreadBadge(titleEl, item.session.sessionFile);
    const timeLabel = formatRelativeTime(sessionRecentTime(item.session));
    const metaBits = [scenarioName];
    if (persona.name) metaBits.push(persona.name);
    if (timeLabel) metaBits.push(timeLabel);
    info.createDiv({
      cls: "ggai-dash-hero-meta",
      text: metaBits.join(" · "),
    });
    // 부재중 도착한 응답의 첫 줄 미리보기 — 카톡 목록처럼 "무슨 말이 왔는지"를 보여준다.
    const unread = this.plugin.getSessionUnread(item.session.sessionFile);
    if (unread?.preview) {
      info.createDiv({ cls: "ggai-dash-hero-preview", text: unread.preview });
    }

    this.makePressable(card, () =>
      void openSessionByPath(this.plugin, item.session.sessionFile)
    );
    this.pressMenu.attachContextMenu(
      card,
      (e) => this.sessionMenu(item.session).showAtMouseEvent(e),
      (x, y) => this.sessionMenu(item.session).showAtPosition({ x, y })
    );
  }

  private renderSection(
    parent: HTMLElement,
    title: string,
    onHead?: (head: HTMLElement) => void
  ): HTMLElement {
    const section = parent.createEl("section", { cls: "ggai-dash-section" });
    const head = section.createDiv({ cls: "ggai-dash-section-head" });
    head.createSpan({ cls: "ggai-dash-section-title", text: title });
    onHead?.(head);
    return section;
  }

  private renderEmpty(parent: HTMLElement, text: string): void {
    parent.createDiv({ cls: "ggai-dash-empty", text });
  }

  // ─── 세션 탭 ──────────────────────────────────────────

  private renderSessionTab(): void {
    const body = this.listEl;
    if (!body) return;
    body.empty();

    // 상단 툴바 — 시리즈 보기 토글 (다음화로 연결된 세션들을 시리즈 단위로 묶어 보기).
    const bar = body.createDiv({ cls: "ggai-dash-session-bar" });
    const seriesBtn = bar.createEl("button", { cls: "ggai-btn" });
    seriesBtn.toggleClass("is-active", this.sessionSeriesView);
    setIcon(seriesBtn.createSpan(), "layers");
    seriesBtn.createSpan({ text: "시리즈 보기" });
    seriesBtn.addEventListener("click", () => {
      this.sessionSeriesView = !this.sessionSeriesView;
      this.renderSessionTab();
    });

    if (this.allSessions.length === 0) {
      this.renderEmpty(
        body,
        "아직 플레이한 세션이 없습니다. 시나리오에서 새 세션을 시작하세요."
      );
      return;
    }

    const activeFile = this.plugin.getActiveOrLastSessionFile();
    if (this.sessionSeriesView) {
      this.renderSeriesGrouped(body, activeFile);
      return;
    }

    const list = body.createDiv({ cls: "ggai-dash-session-cards" });
    const shown = this.allSessions.slice(0, this.sessionDisplayLimit);
    for (const { session, scenario } of shown) {
      this.renderSessionCard(list, session, scenario, activeFile);
    }
    const remaining = this.allSessions.length - shown.length;
    if (remaining > 0) {
      const more = body.createEl("button", {
        cls: "ggai-dash-more-btn ggai-dash-session-more",
      });
      more.createSpan({ text: `더 보기 (${remaining})` });
      more.addEventListener("click", () => {
        this.sessionDisplayLimit += SESSION_TAB_PAGE;
        this.renderSessionTab();
      });
    }
  }

  /**
   * 시리즈 보기 — 다음화로 연결된 세션들을 시리즈(series.id) 단위로 묶어 화 순서대로
   * 보여준다. 이미 로드된 allSessions 를 그룹핑만 해서 재사용(세션 카드도 그대로 재사용).
   */
  private renderSeriesGrouped(body: HTMLElement, activeFile: string | null): void {
    const groups = new Map<
      string,
      {
        name: string;
        scenarioName: string;
        items: Array<{ session: SessionListItem; scenario: ScenarioListItem }>;
      }
    >();
    for (const it of this.allSessions) {
      const s = it.session.session.meta.series;
      if (!s) continue;
      let g = groups.get(s.id);
      if (!g) {
        g = {
          name: s.name,
          scenarioName: it.scenario.scenario.data.name || it.scenario.folderName,
          items: [],
        };
        groups.set(s.id, g);
      }
      g.items.push(it);
    }

    if (groups.size === 0) {
      this.renderEmpty(
        body,
        "아직 시리즈로 연결된 세션이 없습니다. 세션 메뉴(⋮)나 우측 [시나리오] 탭의 시리즈 섹션에서 [다음화 만들기]로 시작하세요."
      );
      return;
    }

    const ordered = Array.from(groups.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const g of ordered) {
      const section = body.createDiv({ cls: "ggai-dash-series-group" });
      const head = section.createDiv({ cls: "ggai-dash-series-group-head" });
      head.createSpan({ cls: "ggai-dash-series-group-name", text: g.name });
      head.createSpan({
        cls: "ggai-dash-series-group-scenario",
        text: g.scenarioName,
      });
      g.items.sort(
        (a, b) =>
          (a.session.session.meta.series?.index ?? 0) -
          (b.session.session.meta.series?.index ?? 0)
      );
      const list = section.createDiv({ cls: "ggai-dash-session-cards" });
      for (const { session, scenario } of g.items) {
        this.renderSessionCard(list, session, scenario, activeFile);
      }
    }
  }

  private renderSessionCard(
    parent: HTMLElement,
    session: SessionListItem,
    scenario: ScenarioListItem,
    activeFile: string | null
  ): void {
    const scenarioName = scenario.scenario.data.name || scenario.folderName;
    const card = parent.createDiv({ cls: "ggai-dash-session-card" });
    card.toggleClass("is-active", session.sessionFile === activeFile);

    const thumb = card.createDiv({ cls: "ggai-dash-session-card-thumb" });
    renderThumb(this.app, thumb, scenario.thumbnailPath, scenarioName, "scroll-text");

    const main = card.createDiv({ cls: "ggai-dash-session-card-main" });
    main.createDiv({
      cls: "ggai-dash-session-card-scenario",
      text: scenarioName,
    });
    const nameEl = main.createDiv({ cls: "ggai-dash-session-card-name" });
    nameEl.createSpan({
      text: session.session.meta.name || session.folderName,
    });
    this.appendSeriesBadge(nameEl, session);
    this.appendUnreadBadge(nameEl, session.sessionFile);
    const time = formatRelativeTime(sessionRecentTime(session));
    const nodeCount = Object.keys(session.session.nodes ?? {}).length;
    main.createDiv({
      cls: "ggai-dash-session-card-meta",
      text: time ? `${time} · 노드 ${nodeCount}` : `노드 ${nodeCount}`,
    });

    const actions = card.createDiv({ cls: "ggai-dash-session-card-actions" });
    this.renderIconAction(actions, "play", "이어하기", () =>
      void openSessionByPath(this.plugin, session.sessionFile)
    );
    this.renderIconAction(actions, "image", "갤러리", () =>
      void this.openSessionGallery(session)
    );
    this.renderIconAction(actions, "git-branch", "분기 관리", () =>
      void this.openBranch(session)
    );
    const del = this.renderIconAction(actions, "trash-2", "삭제", () =>
      confirmDeleteSession(this.plugin, session)
    );
    del.addClass("ggai-dash-session-card-del");
    // ⋮ 메뉴 — 우클릭/롱프레스와 같은 메뉴를 항상 보이는 버튼으로.
    const moreBtn = actions.createEl("button", {
      cls: "ggai-dash-icon-btn is-plain",
    });
    setIcon(moreBtn, "more-vertical");
    moreBtn.setAttr("aria-label", "세션 메뉴");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.sessionMenu(session).showAtMouseEvent(e);
    });

    this.makePressable(card, () =>
      void openSessionByPath(this.plugin, session.sessionFile)
    );
    this.pressMenu.attachContextMenu(
      card,
      (e) => this.sessionMenu(session).showAtMouseEvent(e),
      (x, y) => this.sessionMenu(session).showAtPosition({ x, y })
    );
  }

  /** 안 읽은 응답이 있으면 이름 옆에 개수 뱃지. 세션을 열면 자동으로 사라진다. */
  private appendUnreadBadge(parent: HTMLElement, sessionFile: string): void {
    const unread = this.plugin.getSessionUnread(sessionFile);
    if (!unread) return;
    const badge = parent.createSpan({
      cls: "ggai-unread-badge",
      text: String(unread.count),
    });
    badge.title = "안 읽은 AI 응답";
  }

  /** 시리즈 세션이면 이름 옆에 "N화" 배지 — 목록만 봐도 시리즈임을 알 수 있게. */
  private appendSeriesBadge(parent: HTMLElement, s: SessionListItem): void {
    const series = s.session.meta.series;
    if (!series) return;
    const badge = parent.createSpan({
      cls: "ggai-series-badge",
      text: `${series.index}화`,
    });
    badge.title = `${series.name} 시리즈`;
  }

  private renderIconAction(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLElement {
    const btn = parent.createEl("button", { cls: "ggai-dash-icon-btn is-plain" });
    setIcon(btn, icon);
    btn.setAttr("aria-label", label);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  // ─── 갤러리 (세션별 팝업 · 공용) ──────────────────────

  /** 세션 하나의 삽화를 갤러리 팝업으로. 세션 탭 [갤러리] 버튼용. */
  private async openSessionGallery(session: SessionListItem): Promise<void> {
    const items = await this.buildGalleryItems(session);
    if (items.length === 0) {
      new Notice("이 세션에 생성된 삽화가 없습니다.");
      return;
    }
    const illus = await this.store
      .getSessionIllustrations(session.sessionFile)
      .catch(() => null);
    new IllustrationGalleryModal(this.app, {
      items,
      onJump: (nodeId) =>
        void this.jumpToIllustrationBranch(session.sessionFile, nodeId),
      onDelete: (nodeId, variantId) =>
        this.deleteSessionIllustration(session.sessionFile, nodeId, variantId),
      onToggleFavorite: (nodeId, variantId) => {
        if (!illus) return false;
        const next = toggleIllustrationFavorite(illus, nodeId, variantId);
        void this.store.saveSessionIllustrations(session.sessionFile, illus);
        return next;
      },
    }).open();
  }

  private async buildGalleryItems(
    session: SessionListItem
  ): Promise<GalleryItem[]> {
    const out: GalleryItem[] = [];
    const illus = await this.store
      .getSessionIllustrations(session.sessionFile)
      .catch(() => null);
    if (!illus) return [];
    for (const [nodeId, entry] of Object.entries(illus.nodes)) {
      for (const v of Object.values(entry.variants)) {
        const path = `${session.folder}/${v.path}`;
        if (!this.app.vault.getAbstractFileByPath(path)) continue;
        out.push({
          src: this.app.vault.adapter.getResourcePath(path),
          nodeId,
          variantId: v.id,
          favorite: v.favorite,
          createdAt: v.createdAt,
        });
      }
    }
    return out;
  }

  /**
   * 삽화의 원문 노드로 활성 경로를 옮긴 뒤 세션을 연다("이 분기로 이동").
   * 원래 놀던 자리는 세션창/분기의 "최근 생성 노드로 이동"으로 되돌아갈 수 있다.
   */
  private async jumpToIllustrationBranch(
    sessionFile: string,
    nodeId: string
  ): Promise<void> {
    try {
      const session = await this.store.getSession(sessionFile);
      if (session && session.nodes[nodeId]) {
        const leaf =
          getDeepestLatestDescendant(session, nodeId) ?? session.nodes[nodeId];
        if (session.meta.activeLeafId !== leaf.id) {
          session.meta.activeLeafId = leaf.id;
          await this.store.saveSession(sessionFile, session);
        }
      }
      await openSessionByPath(this.plugin, sessionFile, {
        focusIllustrationNode: nodeId,
      });
    } catch (err) {
      new Notice(
        `이동 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async deleteSessionIllustration(
    sessionFile: string,
    nodeId: string,
    variantId: string
  ): Promise<void> {
    const illus = await this.store
      .getSessionIllustrations(sessionFile)
      .catch(() => null);
    if (!illus) return;
    const removed = removeIllustrationVariant(illus, nodeId, variantId);
    if (!removed) return;
    await this.store.saveSessionIllustrations(sessionFile, illus);
    await this.store.deleteSessionAsset(sessionFile, removed.path);
  }

  // ─── 갤러리 탭 ────────────────────────────────────────

  private renderGalleryTab(): void {
    const body = this.listEl;
    if (!body) return;
    body.empty();

    if (this.galleryEntries === null) {
      body.createDiv({ cls: "ggai-dash-empty", text: "삽화를 불러오는 중…" });
      void this.loadGalleryEntries();
      return;
    }
    if (this.galleryEntries.length === 0) {
      this.renderEmpty(
        body,
        "아직 생성한 삽화가 없습니다. 세션에서 삽화를 만들면 여기 모입니다."
      );
      return;
    }

    // 분류 칩 — 전체 / 즐겨찾기 / 시나리오별 (시나리오 탭 태그 칩과 같은 UI, 단일 선택).
    const scenarioNames = new Map<string, string>();
    for (const e of this.galleryEntries) {
      if (!scenarioNames.has(e.scenarioFolder)) {
        scenarioNames.set(e.scenarioFolder, e.scenarioName);
      }
    }
    if (
      this.galleryFilter &&
      this.galleryFilter !== GALLERY_FAVORITE_FILTER &&
      !scenarioNames.has(this.galleryFilter)
    ) {
      this.galleryFilter = "";
    }
    const favoriteCount = this.galleryEntries.filter((e) => e.favorite).length;

    const chips = body.createDiv({ cls: "ggai-dash-chips ggai-dash-gallery-chips" });
    const allChip = chips.createEl("button", { cls: "ggai-dash-chip", text: "전체" });
    allChip.toggleClass("is-selected", this.galleryFilter === "");
    allChip.addEventListener("click", () => {
      this.galleryFilter = "";
      this.renderGalleryTab();
    });

    const favChip = chips.createEl("button", { cls: "ggai-dash-chip" });
    favChip.createSpan({ text: "즐겨찾기" });
    favChip.createSpan({ cls: "ggai-dash-chip-count", text: String(favoriteCount) });
    favChip.toggleClass("is-selected", this.galleryFilter === GALLERY_FAVORITE_FILTER);
    favChip.addEventListener("click", () => {
      this.galleryFilter = GALLERY_FAVORITE_FILTER;
      this.renderGalleryTab();
    });

    for (const [folder, name] of scenarioNames) {
      const count = this.galleryEntries.filter(
        (e) => e.scenarioFolder === folder
      ).length;
      const chip = chips.createEl("button", { cls: "ggai-dash-chip" });
      chip.createSpan({ text: name });
      chip.createSpan({ cls: "ggai-dash-chip-count", text: String(count) });
      chip.toggleClass("is-selected", this.galleryFilter === folder);
      chip.addEventListener("click", () => {
        this.galleryFilter = folder;
        this.renderGalleryTab();
      });
    }

    const filtered =
      this.galleryFilter === GALLERY_FAVORITE_FILTER
        ? this.galleryEntries.filter((e) => e.favorite)
        : this.galleryFilter
          ? this.galleryEntries.filter((e) => e.scenarioFolder === this.galleryFilter)
          : this.galleryEntries;
    const visible = filtered.slice().sort((a, b) =>
      this.gallerySort === "new"
        ? b.createdAt - a.createdAt
        : a.createdAt - b.createdAt
    );

    const bar = body.createDiv({ cls: "ggai-dash-gallery-bar" });
    bar.createSpan({
      cls: "ggai-dash-gallery-count",
      text: `${visible.length}장`,
    });
    const sort = bar.createEl("select", { cls: "ggai-dash-sort" });
    sort.style.marginLeft = "auto";
    for (const opt of [
      { value: "new", label: "최신순" },
      { value: "old", label: "오래된순" },
    ]) {
      const el = sort.createEl("option", { text: opt.label, value: opt.value });
      if (opt.value === this.gallerySort) el.selected = true;
    }
    sort.addEventListener("change", () => {
      this.gallerySort = sort.value as "new" | "old";
      this.renderGalleryTab();
    });

    const grid = body.createDiv({ cls: "ggai-dash-gallery-grid" });
    visible.forEach((entry, i) => {
      const cell = grid.createDiv({ cls: "ggai-dash-gallery-cell" });
      const img = cell.createEl("img", { cls: "ggai-dash-gallery-img" });
      img.src = entry.src;
      img.loading = "lazy";
      img.addEventListener("click", () =>
        openImageLightbox(
          visible.map((e) => ({ src: e.src })),
          i
        )
      );

      const fav = cell.createEl("button", { cls: "ggai-dash-gallery-fav" });
      setIcon(fav, "star");
      fav.toggleClass("is-favorited", entry.favorite);
      fav.setAttr("aria-label", "즐겨찾기");
      fav.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.toggleGalleryEntryFavorite(entry);
      });

      const actions = cell.createDiv({ cls: "ggai-dash-gallery-cell-actions" });
      const jump = actions.createEl("button", {
        cls: "ggai-dash-gallery-cell-btn",
      });
      setIcon(jump, "locate-fixed");
      jump.setAttr("aria-label", "이 분기로 이동");
      jump.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.jumpToIllustrationBranch(entry.sessionFile, entry.nodeId);
      });
      const del = actions.createEl("button", {
        cls: "ggai-dash-gallery-cell-btn is-danger",
      });
      setIcon(del, "trash-2");
      del.setAttr("aria-label", "삭제");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.deleteGalleryEntry(entry);
      });

      cell.createDiv({
        cls: "ggai-dash-gallery-cell-label",
        text: entry.scenarioName,
      });
    });
  }

  private async loadGalleryEntries(): Promise<void> {
    const entries: GalleryEntry[] = [];
    for (const { session, scenario } of this.allSessions) {
      const illus = await this.store
        .getSessionIllustrations(session.sessionFile)
        .catch(() => null);
      if (!illus) continue;
      const scenarioName = scenario.scenario.data.name || scenario.folderName;
      for (const [nodeId, entry] of Object.entries(illus.nodes)) {
        for (const v of Object.values(entry.variants)) {
          const path = `${session.folder}/${v.path}`;
          if (!this.app.vault.getAbstractFileByPath(path)) continue;
          entries.push({
            src: this.app.vault.adapter.getResourcePath(path),
            sessionFile: session.sessionFile,
            scenarioName,
            scenarioFolder: scenario.folder,
            nodeId,
            variantId: v.id,
            createdAt: v.createdAt,
            favorite: !!v.favorite,
          });
        }
      }
    }
    entries.sort((a, b) => b.createdAt - a.createdAt);
    this.galleryEntries = entries;
    // 아직 갤러리/홈 탭을 보고 있으면 다시 그린다(삽화 스트립·서재 카운트 반영).
    if (!this.detailFolder && !this.branchSessionFile) {
      if (this.activeTab === "gallery") this.renderGalleryTab();
      else if (this.activeTab === "home") this.renderHome();
    }
  }

  private async toggleGalleryEntryFavorite(entry: GalleryEntry): Promise<void> {
    const illus = await this.store
      .getSessionIllustrations(entry.sessionFile)
      .catch(() => null);
    if (!illus) return;
    const next = toggleIllustrationFavorite(illus, entry.nodeId, entry.variantId);
    await this.store.saveSessionIllustrations(entry.sessionFile, illus);
    entry.favorite = next;
    this.renderGalleryTab();
  }

  private async deleteGalleryEntry(entry: GalleryEntry): Promise<void> {
    await this.deleteSessionIllustration(
      entry.sessionFile,
      entry.nodeId,
      entry.variantId
    );
    // 집계에서 즉시 제거하고 다시 그린다(이벤트로도 무효화되지만 즉각 반영).
    if (this.galleryEntries) {
      this.galleryEntries = this.galleryEntries.filter(
        (e) => e.variantId !== entry.variantId
      );
      this.renderGalleryTab();
    }
  }

  // ─── 시나리오 탭 ──────────────────────────────────────

  private renderScenarioToolbar(page: HTMLElement): void {
    const bar = page.createDiv({ cls: "ggai-dash-toolbar" });

    const search = bar.createEl("input", {
      cls: "ggai-dash-search",
      type: "search",
    });
    search.placeholder = "시나리오 검색 (이름/설명/태그)";
    search.value = this.scenarioQuery;
    search.addEventListener("input", () => {
      this.scenarioQuery = search.value;
      this.renderScenarioList();
    });

    const sort = bar.createEl("select", { cls: "ggai-dash-sort" });
    const options: Array<{ value: SortKey; label: string }> = [
      { value: "recent", label: "최근 플레이순" },
      { value: "alpha", label: "알파벳순" },
      { value: "most-played", label: "최다 플레이순" },
    ];
    for (const opt of options) {
      const el = sort.createEl("option", { text: opt.label, value: opt.value });
      if (opt.value === this.scenarioSort) el.selected = true;
    }
    sort.addEventListener("change", () => {
      this.scenarioSort = sort.value as SortKey;
      this.renderScenarioList();
    });

    const addBtn = this.renderToolbarButton(bar, "plus", "새 시나리오", () =>
      promptNewScenario(this.plugin)
    );
    addBtn.addClass("mod-cta");
    this.renderToolbarButton(bar, "download", "임포트", () =>
      runImportPicker(this.plugin)
    );
  }

  private renderToolbarButton(
    bar: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLElement {
    const btn = bar.createEl("button", { cls: "ggai-btn ggai-dash-tool-btn" });
    setIcon(btn, icon);
    btn.createSpan({ text: label });
    btn.addEventListener("click", onClick);
    return btn;
  }

  /** 태그 칩 — 다중 선택 AND 필터. 태그가 하나도 없으면 줄 자체를 숨긴다. */
  private renderTagChips(): void {
    const chips = this.tagChipsEl;
    if (!chips) return;
    chips.empty();

    const tags = collectScenarioTags(this.scenarios);
    // 사라진 태그가 선택에 남아 목록이 영영 비는 것 방지.
    for (const t of Array.from(this.selectedTags)) {
      if (!tags.some((x) => x.tag === t)) this.selectedTags.delete(t);
    }
    chips.toggleClass("is-hidden", tags.length === 0);
    if (tags.length === 0) return;

    const allChip = chips.createEl("button", {
      cls: "ggai-dash-chip",
      text: "전체",
    });
    allChip.toggleClass("is-selected", this.selectedTags.size === 0);
    allChip.addEventListener("click", () => {
      this.selectedTags.clear();
      this.renderTagChips();
      this.renderScenarioList();
    });

    for (const { tag, count } of tags) {
      const chip = chips.createEl("button", { cls: "ggai-dash-chip" });
      chip.createSpan({ text: tag });
      chip.createSpan({ cls: "ggai-dash-chip-count", text: String(count) });
      chip.toggleClass("is-selected", this.selectedTags.has(tag));
      chip.addEventListener("click", () => {
        if (this.selectedTags.has(tag)) this.selectedTags.delete(tag);
        else this.selectedTags.add(tag);
        this.renderTagChips();
        this.renderScenarioList();
      });
    }
  }

  private renderScenarioList(): void {
    const body = this.listEl;
    if (!body || this.activeTab !== "scenario") return;
    body.empty();

    const visible = this.filteredScenarios();
    if (visible.length === 0) {
      this.renderEmpty(
        body,
        this.scenarios.length === 0
          ? "아직 시나리오가 없습니다. [새 시나리오] 또는 [임포트]로 시작하세요."
          : "검색/태그 조건에 맞는 시나리오가 없습니다."
      );
      return;
    }
    for (const item of visible) this.renderScenarioPoster(body, item, {});
  }

  private filteredScenarios(): ScenarioListItem[] {
    const q = this.scenarioQuery.trim().toLowerCase();
    let filtered = this.scenarios.slice();
    if (q) {
      filtered = filtered.filter((i) => {
        const n = (i.scenario.data.name ?? "").toLowerCase();
        const f = i.folderName.toLowerCase();
        const d = (i.scenario.data.description ?? "").toLowerCase();
        if (n.includes(q) || f.includes(q) || d.includes(q)) return true;
        return scenarioTags(i).some((t) => t.toLowerCase().includes(q));
      });
    }
    if (this.selectedTags.size > 0) {
      filtered = filtered.filter((i) => {
        const tags = scenarioTags(i);
        return Array.from(this.selectedTags).every((t) => tags.includes(t));
      });
    }
    return filtered.sort(compareBy(this.scenarioSort));
  }

  /** 시나리오 포스터 카드 — 그리드/가로 스트립 공용. compact 는 홈 스트립용 축소판. */
  private renderScenarioPoster(
    parent: HTMLElement,
    item: ScenarioListItem,
    opts: { compact?: boolean }
  ): HTMLElement {
    const card = parent.createDiv({ cls: "ggai-dash-scenario-card" });
    if (opts.compact) card.addClass("is-compact");
    const name = item.scenario.data.name || item.folderName;

    const poster = card.createDiv({ cls: "ggai-dash-poster" });
    renderThumb(this.app, poster, item.thumbnailPath, name, "scroll-text");
    poster.createDiv({ cls: "ggai-dash-card-shade" });

    const actions = poster.createDiv({ cls: "ggai-dash-card-actions" });
    const starBtn = actions.createEl("button", { cls: "ggai-dash-icon-btn" });
    setIcon(starBtn, "star");
    starBtn.toggleClass("is-favorited", getFavorite(item));
    starBtn.setAttr("aria-label", "시나리오 즐겨찾기");
    starBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.toggleScenarioFavorite(item);
    });

    const text = poster.createDiv({ cls: "ggai-dash-poster-text" });
    text.createDiv({ cls: "ggai-dash-poster-name", text: name });
    text.createDiv({
      cls: "ggai-dash-poster-meta",
      text: sessionMetaLabel(item.sessionCount, item.lastSessionAt),
    });

    // 시나리오 클릭 = 개요 + 세션 목록(관리) 페이지. 바로 플레이는 상세의 [이어하기].
    this.makePressable(card, () => void this.openScenarioDetail(item.folder));
    this.pressMenu.attachContextMenu(
      card,
      (e) => this.scenarioMenu(item).showAtMouseEvent(e),
      (x, y) => this.scenarioMenu(item).showAtPosition({ x, y })
    );
    return card;
  }

  // ─── 시나리오 상세 (세션 관리) ────────────────────────

  private async openScenarioDetail(folder: string): Promise<void> {
    this.pushHistory();
    this.detailFolder = folder;
    this.branchSessionFile = null;
    this.editorRoute = null;
    this.detailSessions = [];
    this.selectMode = false;
    this.sessionSelection.clear();
    this.updateTabChrome();
    this.renderPage();
    this.contentEl.scrollTop = 0;
    await this.persistRoute();
  }

  private renderScenarioDetail(): void {
    const body = this.listEl;
    if (!body) return;
    body.empty();

    const item = this.scenarios.find((s) => s.folder === this.detailFolder);
    if (!item) {
      // 시나리오가 사라졌으면 시나리오 탭으로 빠져나온다.
      void this.setTab("scenario");
      return;
    }
    const name = item.scenario.data.name || item.folderName;

    // 뒤로 — 히스토리가 있으면 직전 화면으로, 없으면 시나리오 목록으로.
    const back = body.createEl("button", { cls: "ggai-dash-back-btn" });
    setIcon(back.createSpan({ cls: "ggai-dash-back-icon" }), "chevron-left");
    back.createSpan({ text: "시나리오 목록" });
    back.addEventListener("click", () => {
      if (this.navStack.length > 0) this.goBack();
      else void this.setTab("scenario");
    });

    // 헤더 — 표지 + 이름/태그/설명 + 액션
    const header = body.createDiv({ cls: "ggai-dash-detail-header" });
    const cover = header.createDiv({ cls: "ggai-dash-detail-cover" });
    renderThumb(this.app, cover, item.thumbnailPath, name, "scroll-text");

    const info = header.createDiv({ cls: "ggai-dash-detail-info" });
    info.createDiv({ cls: "ggai-dash-detail-name", text: name });

    const tags = scenarioTags(item);
    if (tags.length > 0) {
      const tagRow = info.createDiv({ cls: "ggai-dash-detail-tags" });
      for (const tag of tags) {
        const chip = tagRow.createEl("button", {
          cls: "ggai-dash-chip",
          text: tag,
        });
        // 태그 클릭 = 그 태그로 필터한 시나리오 탭으로.
        chip.addEventListener("click", () => {
          this.selectedTags = new Set([tag]);
          void this.setTab("scenario");
        });
      }
    }
    const desc = item.scenario.data.description?.trim();
    if (desc) {
      info.createDiv({ cls: "ggai-dash-detail-desc", text: desc });
    }

    const actions = info.createDiv({ cls: "ggai-dash-detail-actions" });
    const playBtn = actions.createEl("button", {
      cls: "ggai-btn mod-cta ggai-dash-tool-btn",
    });
    setIcon(playBtn, "play");
    playBtn.createSpan({ text: "이어하기" });
    playBtn.addEventListener("click", () => void this.openScenario(item));
    const newBtn = this.renderToolbarButton(actions, "plus", "새 세션", () =>
      void createAndOpenSession(this.plugin, item, { mode: "ask" })
    );
    newBtn.removeClass("mod-cta");
    this.renderToolbarButton(actions, "pencil", "시나리오 편집", () =>
      void this.openScenarioEditor(item)
    );
    const delBtn = this.renderToolbarButton(actions, "trash-2", "시나리오 삭제", () =>
      confirmDeleteScenario(this.plugin, item)
    );
    delBtn.addClass("ggai-btn-danger");

    // 세션 목록 헤더 + 선택 삭제 토글
    const listHead = body.createDiv({ cls: "ggai-dash-detail-sessions-head" });
    listHead.createSpan({
      cls: "ggai-dash-detail-sessions-title",
      text: "세션",
    });
    this.detailListEl = body.createDiv({ cls: "ggai-dash-session-list" });
    // 헤더의 선택 컨트롤은 세션 목록을 그린 뒤 상태에 맞춰 렌더.
    this.detailSelectHeadEl = listHead;
    void this.loadDetailSessions();
  }

  private detailSelectHeadEl: HTMLElement | null = null;

  private renderSelectControls(item: ScenarioListItem): void {
    const head = this.detailSelectHeadEl;
    if (!head) return;
    head.querySelector(".ggai-dash-select-controls")?.remove();
    if (this.detailSessions.length === 0) return;
    const wrap = head.createDiv({ cls: "ggai-dash-select-controls" });

    if (!this.selectMode) {
      const btn = wrap.createEl("button", {
        cls: "ggai-btn ggai-btn-small",
        text: "선택",
      });
      btn.addEventListener("click", () => {
        this.selectMode = true;
        this.sessionSelection.clear();
        this.renderDetailSessions();
      });
      return;
    }

    const count = this.sessionSelection.size;
    const delBtn = wrap.createEl("button", {
      cls: "ggai-btn ggai-btn-small ggai-btn-danger",
      text: count > 0 ? `선택 삭제 (${count})` : "선택 삭제",
    });
    delBtn.disabled = count === 0;
    delBtn.addEventListener("click", () => this.confirmBulkDeleteSessions(item));
    const cancel = wrap.createEl("button", {
      cls: "ggai-btn ggai-btn-small",
      text: "취소",
    });
    cancel.addEventListener("click", () => {
      this.selectMode = false;
      this.sessionSelection.clear();
      this.renderDetailSessions();
    });
  }

  private confirmBulkDeleteSessions(item: ScenarioListItem): void {
    const targets = this.detailSessions.filter((s) =>
      this.sessionSelection.has(s.sessionFile)
    );
    if (targets.length === 0) return;
    new ConfirmModal(
      this.app,
      "세션 일괄 삭제",
      `선택한 세션 ${targets.length}개를 휴지통으로 옮깁니다. 계속할까요?`,
      "삭제",
      (confirmed) => {
        if (!confirmed) return;
        void (async () => {
          for (const s of targets) {
            try {
              await this.store.deleteSession(s.folder);
            } catch (err) {
              new Notice(
                `삭제 실패: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
          this.selectMode = false;
          this.sessionSelection.clear();
          new Notice(`세션 ${targets.length}개 삭제됨 · 휴지통에서 복구 가능`);
          void this.loadDetailSessions();
        })();
      }
    ).open();
  }

  private async loadDetailSessions(): Promise<void> {
    if (!this.detailFolder) return;
    this.detailSessions = await this.store
      .getSessions(this.detailFolder)
      .catch(() => []);
    // 사라진 세션이 선택에 남지 않게 정리.
    const live = new Set(this.detailSessions.map((s) => s.sessionFile));
    for (const f of Array.from(this.sessionSelection)) {
      if (!live.has(f)) this.sessionSelection.delete(f);
    }
    this.renderDetailSessions();
  }

  private renderDetailSessions(): void {
    const list = this.detailListEl;
    if (!list) return;
    list.empty();

    const item = this.scenarios.find((s) => s.folder === this.detailFolder);
    if (item) this.renderSelectControls(item);

    if (this.detailSessions.length === 0) {
      this.renderEmpty(list, "아직 세션이 없습니다. [새 세션]으로 시작하세요.");
      return;
    }

    const activeFile = this.plugin.getActiveOrLastSessionFile();
    const sorted = this.detailSessions
      .slice()
      .sort((a, b) => sessionRecentTime(b) - sessionRecentTime(a));

    for (const s of sorted) {
      const row = list.createDiv({ cls: "ggai-dash-session-row" });
      row.toggleClass("is-active", s.sessionFile === activeFile);

      if (this.selectMode) {
        const checked = this.sessionSelection.has(s.sessionFile);
        const check = row.createEl("button", { cls: "ggai-dash-session-check" });
        setIcon(check, checked ? "check-square" : "square");
        check.toggleClass("is-checked", checked);
        check.setAttr("aria-label", "세션 선택");
      } else {
        const favBtn = row.createEl("button", { cls: "ggai-dash-session-fav" });
        setIcon(favBtn, "star");
        favBtn.toggleClass("is-favorited", s.session.meta.favorite === true);
        favBtn.setAttr("aria-label", "세션 즐겨찾기");
        favBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.toggleSessionFavorite(s);
        });
      }

      const main = row.createDiv({ cls: "ggai-dash-session-main" });
      const nameEl = main.createDiv({ cls: "ggai-dash-session-name" });
      nameEl.createSpan({ text: s.session.meta.name || s.folderName });
      this.appendSeriesBadge(nameEl, s);
      const time = formatRelativeTime(sessionRecentTime(s));
      const nodeCount = Object.keys(s.session.nodes ?? {}).length;
      main.createDiv({
        cls: "ggai-dash-session-meta",
        text: time ? `${time} · 노드 ${nodeCount}` : `노드 ${nodeCount}`,
      });

      if (!this.selectMode) {
        // 노드/가지치기 — 인라인 화면으로.
        const branchBtn = row.createEl("button", {
          cls: "ggai-dash-icon-btn is-plain",
        });
        setIcon(branchBtn, "git-branch");
        branchBtn.setAttr("aria-label", "노드 · 가지치기");
        branchBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.openBranch(s);
        });
        // 더보기 메뉴
        const moreBtn = row.createEl("button", {
          cls: "ggai-dash-icon-btn is-plain",
        });
        setIcon(moreBtn, "more-vertical");
        moreBtn.setAttr("aria-label", "세션 메뉴");
        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.sessionMenu(s).showAtMouseEvent(e);
        });
      }

      this.makePressable(row, () => {
        if (this.selectMode) {
          this.toggleSessionSelected(s);
          return;
        }
        void openSessionByPath(this.plugin, s.sessionFile);
      });
      this.pressMenu.attachContextMenu(
        row,
        (e) => this.sessionMenu(s).showAtMouseEvent(e),
        (x, y) => this.sessionMenu(s).showAtPosition({ x, y })
      );
    }
  }

  private toggleSessionSelected(s: SessionListItem): void {
    if (this.sessionSelection.has(s.sessionFile)) {
      this.sessionSelection.delete(s.sessionFile);
    } else {
      this.sessionSelection.add(s.sessionFile);
    }
    this.renderDetailSessions();
  }

  // ─── 인라인 분기 (노드 · 가지치기) ────────────────────

  private async openBranch(s: SessionListItem): Promise<void> {
    this.pushHistory();
    this.editorRoute = null;
    this.branchSessionFile = s.sessionFile;
    this.updateTabChrome();
    this.renderPage();
    this.contentEl.scrollTop = 0;
  }

  /** 편집 페이지(페르소나/프롬프트 세트) 렌더 — 상단 뒤로가기 헤더 + 편집 섹션. */
  private renderEditorPage(): void {
    const body = this.listEl;
    if (!body || !this.editorRoute) return;
    body.empty();
    const kind = this.editorRoute.kind;
    const labels: Record<EditorKind, { back: string; title: string }> = {
      prompt: { back: "프롬프트 목록", title: "프롬프트 세트 편집" },
      user: { back: "페르소나 목록", title: "페르소나 편집" },
      scenario: { back: "시나리오 목록", title: "시나리오 편집" },
      lorebook: { back: "로어북 목록", title: "로어북 편집" },
    };

    const head = body.createDiv({ cls: "ggai-dash-branch-head" });
    const back = head.createEl("button", { cls: "ggai-dash-back-btn" });
    setIcon(back.createSpan({ cls: "ggai-dash-back-icon" }), "chevron-left");
    back.createSpan({ text: labels[kind].back });
    back.addEventListener("click", () => this.goBack());
    head.createSpan({
      cls: "ggai-dash-branch-title",
      text: labels[kind].title,
    });

    const host = body.createDiv({ cls: "ggai-dash-editor-host" });
    const file = this.editorRoute.file;
    const onClose = () => this.goBack();
    switch (kind) {
      case "prompt":
        this.editorSection = new PromptSetEditorSection(host, this.plugin, file, {
          onClose,
        });
        break;
      case "user":
        this.editorSection = new UserEditorSection(host, this.plugin, file, {
          onClose,
        });
        break;
      case "scenario":
        this.editorSection = new ScenarioEditorSection(host, this.plugin, file, {
          onClose,
        });
        break;
      case "lorebook":
        this.editorSection = new LorebookEditorSection(host, this.plugin, file, {
          onClose,
        });
        break;
    }
    void this.editorSection.load();
  }

  private renderBranchPage(): void {
    const body = this.listEl;
    if (!body || !this.branchSessionFile) return;
    body.empty();

    const s =
      this.detailSessions.find(
        (x) => x.sessionFile === this.branchSessionFile
      ) ??
      this.allSessions.find(
        (x) => x.session.sessionFile === this.branchSessionFile
      )?.session;
    const title = s?.session.meta.name || s?.folderName || "노드 · 가지치기";
    const head = body.createDiv({ cls: "ggai-dash-branch-head" });
    const back = head.createEl("button", { cls: "ggai-dash-back-btn" });
    setIcon(back.createSpan({ cls: "ggai-dash-back-icon" }), "chevron-left");
    back.createSpan({ text: "세션 목록" });
    back.addEventListener("click", () => this.goBack());
    head.createSpan({ cls: "ggai-dash-branch-title", text: `${title} · 노드` });

    // 우측 디테일 [분기]탭과 같은 BranchSection 을 전체 맵 모드로 인라인 로딩.
    const host = body.createDiv({ cls: "ggai-dash-branch-host" });
    this.branch = new BranchSection(host, this.plugin, this.branchSessionFile, {
      initialMode: "map",
      autoCenterCurrent: true,
    });
    void this.branch.load();
  }

  // ─── 페르소나 탭 ──────────────────────────────────────────

  private renderUserToolbar(page: HTMLElement): void {
    const bar = page.createDiv({ cls: "ggai-dash-toolbar" });
    const search = bar.createEl("input", {
      cls: "ggai-dash-search",
      type: "search",
    });
    search.placeholder = "페르소나 검색";
    search.value = this.userQuery;
    search.addEventListener("input", () => {
      this.userQuery = search.value;
      this.renderUserList();
    });
    const addBtn = this.renderToolbarButton(bar, "plus", "새 페르소나", () =>
      promptNewUser(this.plugin)
    );
    addBtn.addClass("mod-cta");
  }

  private renderUserList(): void {
    const body = this.listEl;
    if (!body || this.activeTab !== "user") return;
    body.empty();

    const q = this.userQuery.trim().toLowerCase();
    const visible = this.sortedUsers().filter((u) => {
      if (!q) return true;
      return (
        u.profile.name.toLowerCase().includes(q) ||
        u.profile.description.toLowerCase().includes(q)
      );
    });
    if (visible.length === 0) {
      this.renderEmpty(
        body,
        this.users.length === 0
          ? "페르소나가 없습니다. [새 페르소나]로 만들어주세요."
          : "검색 결과가 없습니다."
      );
      return;
    }

    const activeFile = this.activeUserProfileFile();
    for (const item of visible) {
      const card = body.createDiv({ cls: "ggai-dash-user-card" });
      card.toggleClass("is-active", item.userFile === activeFile);

      // 폴라로이드형 — 큰 사진 위에 활성 배지/편집 버튼을 얹고, 아래 캡션에 이름.
      const avatar = card.createDiv({ cls: "ggai-dash-avatar" });
      renderThumb(this.app, avatar, item.thumbnailPath, item.profile.name, "user");
      if (item.userFile === activeFile) {
        avatar.createSpan({ cls: "ggai-dash-active-badge", text: "활성" });
      }

      const editBtn = card.createEl("button", {
        cls: "ggai-dash-icon-btn is-plain ggai-dash-user-edit",
      });
      setIcon(editBtn, "pencil");
      editBtn.setAttr("aria-label", "페르소나 편집");
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.openUserEditor(item);
      });

      const text = card.createDiv({ cls: "ggai-dash-user-card-text" });
      const nameRow = text.createDiv({ cls: "ggai-dash-user-card-name" });
      nameRow.createSpan({ text: item.profile.name || "User" });
      if (item.profile.description) {
        text.createDiv({
          cls: "ggai-dash-user-card-desc",
          text: item.profile.description,
        });
      }

      this.makePressable(card, () => void this.activateUser(item));
      this.pressMenu.attachContextMenu(
        card,
        (e) => this.userMenu(item).showAtMouseEvent(e),
        (x, y) => this.userMenu(item).showAtPosition({ x, y })
      );
    }
  }

  private sortedUsers(): UserListItem[] {
    return this.users.slice().sort((a, b) => {
      if (a.profile.id === "default") return -1;
      if (b.profile.id === "default") return 1;
      const fa = a.profile.favorite ? 1 : 0;
      const fb = b.profile.favorite ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return a.profile.name.localeCompare(b.profile.name);
    });
  }

  // ─── 로어북 탭 ────────────────────────────────────────

  private renderLoreToolbar(page: HTMLElement): void {
    const bar = page.createDiv({ cls: "ggai-dash-toolbar" });
    const search = bar.createEl("input", {
      cls: "ggai-dash-search",
      type: "search",
    });
    search.placeholder = "로어북 검색 (이름/키워드/내용)";
    search.value = this.loreQuery;
    search.addEventListener("input", () => {
      this.loreQuery = search.value;
      this.renderLoreList();
    });
    const addBtn = this.renderToolbarButton(bar, "plus", "새 로어북", () =>
      promptNewLorebook(this.plugin)
    );
    addBtn.addClass("mod-cta");
    this.renderToolbarButton(bar, "download", "임포트", () =>
      runImportPicker(this.plugin)
    );
  }

  private renderLoreList(): void {
    const body = this.listEl;
    if (!body || this.activeTab !== "lorebook") return;
    body.empty();

    const q = this.loreQuery.trim().toLowerCase();
    const visible = this.lorebooks.filter((l) => {
      if (!q) return true;
      const n = (l.lorebook.meta.name ?? "").toLowerCase();
      const f = l.folderName.toLowerCase();
      if (n.includes(q) || f.includes(q)) return true;
      return l.lorebook.entries.some((e) => {
        if (e.content.toLowerCase().includes(q)) return true;
        if ((e.name ?? "").toLowerCase().includes(q)) return true;
        return e.keys.some((k) => k.toLowerCase().includes(q));
      });
    });
    if (visible.length === 0) {
      this.renderEmpty(
        body,
        this.lorebooks.length === 0
          ? "로어북이 없습니다. [새 로어북] 또는 [임포트]로 시작하세요."
          : "검색 결과가 없습니다."
      );
      return;
    }

    for (const item of visible) {
      const card = body.createDiv({ cls: "ggai-dash-lore-card" });
      const name = item.lorebook.meta.name || item.folderName;

      const thumb = card.createDiv({ cls: "ggai-dash-lore-thumb" });
      renderThumb(this.app, thumb, this.lorebookThumbPath(item), name, "book-open");

      const text = card.createDiv({ cls: "ggai-dash-lore-text" });
      text.createDiv({ cls: "ggai-dash-lore-name", text: name });
      text.createDiv({
        cls: "ggai-dash-lore-meta",
        text: `${item.lorebook.entries.length} 항목`,
      });

      this.makePressable(card, () => void this.openLorebookEditor(item));
      this.pressMenu.attachContextMenu(
        card,
        (e) => this.lorebookMenu(item).showAtMouseEvent(e),
        (x, y) => this.lorebookMenu(item).showAtPosition({ x, y })
      );
    }
  }

  private lorebookThumbPath(item: LorebookListItem): string | null {
    const thumbName = item.lorebook.meta.thumbnail;
    if (!thumbName) return null;
    const path = `${item.folder.path}/${thumbName}`;
    return this.app.vault.getAbstractFileByPath(path) ? path : null;
  }

  // ─── 공용 헬퍼/액션 ───────────────────────────────────

  /** 카드에 클릭 + 키보드(Enter/Space) 활성화를 붙인다. */
  private makePressable(el: HTMLElement, onActivate: () => void): void {
    el.setAttr("tabindex", "0");
    el.setAttr("role", "button");
    el.addEventListener("click", (e) => {
      if (this.pressMenu.consumeSuppressedClick(e)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("button")) return;
      onActivate();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onActivate();
    });
  }

  private activeUserProfileFile(): string {
    return this.plugin.data.activeUserProfileFile ?? "GGAI/USERS/default.json";
  }

  /** 시나리오 카드 클릭 = 가장 최근 세션으로 돌입, 세션이 없으면 새 세션 생성. */
  private async openScenario(item: ScenarioListItem): Promise<void> {
    try {
      const sessions = await this.store.getSessions(item.folder);
      const recent = sessions
        .slice()
        .sort((a, b) => sessionRecentTime(b) - sessionRecentTime(a))[0];
      if (recent) {
        await openSessionByPath(this.plugin, recent.sessionFile);
        return;
      }
      await createAndOpenSession(this.plugin, item);
    } catch (err) {
      new Notice(
        `세션 열기 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async openScenarioEditor(item: ScenarioListItem): Promise<void> {
    // 대시보드 안에서는 편집 페이지를 내부 라우트로 연다(뒤로가기 히스토리 유지).
    this.navigateToEditor("scenario", item.scenarioFile);
  }

  private async openUserEditor(item: UserListItem): Promise<void> {
    // 대시보드 안에서는 편집 페이지를 내부 라우트로 연다(뒤로가기 히스토리 유지).
    this.navigateToEditor("user", item.userFile);
  }

  private async openLorebookEditor(item: LorebookListItem): Promise<void> {
    // 대시보드 안에서는 편집 페이지를 내부 라우트로 연다(뒤로가기 히스토리 유지).
    this.navigateToEditor("lorebook", item.lorebookFile);
  }

  private async toggleScenarioFavorite(item: ScenarioListItem): Promise<void> {
    try {
      await this.store.toggleScenarioFavorite(item.scenarioFile);
    } catch (err) {
      new Notice(
        `즐겨찾기 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async toggleUserFavorite(item: UserListItem): Promise<void> {
    try {
      await this.store.toggleUserFavorite(item.userFile);
    } catch (err) {
      new Notice(
        `즐겨찾기 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async toggleSessionFavorite(s: SessionListItem): Promise<void> {
    try {
      await this.store.toggleSessionFavorite(s.sessionFile);
    } catch (err) {
      new Notice(
        `세션 즐겨찾기 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async activateUser(item: UserListItem): Promise<void> {
    await this.plugin.selectActivePersona(item.userFile);
    this.renderListOnly();
  }

  // ─── 메뉴 ─────────────────────────────────────────────

  private scenarioMenu(item: ScenarioListItem): Menu {
    return new Menu()
      .addItem((mi) =>
        mi
          .setTitle("세션 관리")
          .setIcon("layers")
          .onClick(() => void this.openScenarioDetail(item.folder))
      )
      .addItem((mi) =>
        mi
          .setTitle("새 세션")
          .setIcon("plus")
          .onClick(() => void createAndOpenSession(this.plugin, item, { mode: "ask" }))
      )
      .addItem((mi) =>
        mi
          .setTitle("편집")
          .setIcon("pencil")
          .onClick(() => void this.openScenarioEditor(item))
      )
      .addItem((mi) =>
        mi
          .setTitle("복제")
          .setIcon("copy")
          .onClick(() => void copyScenarioWithPrompt(this.plugin, item))
      )
      .addItem((mi) =>
        mi
          .setTitle(getFavorite(item) ? "즐겨찾기 해제" : "즐겨찾기")
          .setIcon("star")
          .onClick(() => void this.toggleScenarioFavorite(item))
      )
      .addSeparator()
      .addItem((mi) =>
        mi
          .setTitle("삭제")
          .setIcon("trash-2")
          .onClick(() => confirmDeleteScenario(this.plugin, item))
      );
  }

  /** 세션 공용 메뉴 — 항목 구성은 session-menu.ts 한 곳에서만 관리한다. */
  private sessionMenu(s: SessionListItem): Menu {
    return buildSessionMenu(this.plugin, s, {
      onBranch: () => void this.openBranch(s),
    });
  }

  private userMenu(item: UserListItem): Menu {
    const menu = new Menu()
      .addItem((mi) =>
        mi
          .setTitle("편집")
          .setIcon("pencil")
          .onClick(() => void this.openUserEditor(item))
      )
      .addItem((mi) =>
        mi
          .setTitle(item.profile.favorite ? "즐겨찾기 해제" : "즐겨찾기")
          .setIcon("star")
          .onClick(() => void this.toggleUserFavorite(item))
      );
    if (item.profile.id !== "default") {
      menu
        .addSeparator()
        .addItem((mi) =>
          mi
            .setTitle("삭제")
            .setIcon("trash-2")
            .onClick(() => confirmDeleteUser(this.plugin, item))
        );
    }
    return menu;
  }

  private lorebookMenu(item: LorebookListItem): Menu {
    return new Menu()
      .addItem((mi) =>
        mi
          .setTitle("편집")
          .setIcon("pencil")
          .onClick(() => void this.openLorebookEditor(item))
      )
      .addSeparator()
      .addItem((mi) =>
        mi
          .setTitle("삭제")
          .setIcon("trash-2")
          .onClick(() => confirmDeleteLorebook(this.plugin, item))
      );
  }
}
