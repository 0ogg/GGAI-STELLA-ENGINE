import {
  AbstractInputSuggest,
  App,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";
import {
  VIEW_TYPE_CHAT_SESSION,
  VIEW_TYPE_DASHBOARD,
  VIEW_TYPE_DETAIL,
  VIEW_TYPE_ILLUSTRATION_OUTPUT,
  VIEW_TYPE_SESSION,
  VIEW_TYPE_SIDEBAR,
} from "./constants";
import { AIService } from "./services/ai-service";
import { installFocusForensics } from "./services/focus-forensics";
import { TranslationService } from "./services/translation-service";
import { SummaryService } from "./services/summary-service";
import { IllustrationService } from "./services/illustration-service";
import { ParagraphRegenService } from "./services/paragraph-regen-service";
import {
  SettingsPanelRegistry,
  type SettingsPanel,
} from "./services/settings-panel-registry";
import { StellaExtensionRegistry } from "./services/extension-registry";
import { registerSummaryExtension } from "./extensions/summary-extension";
import { registerTranslationExtension } from "./extensions/translation-extension";
import { registerIllustrationExtension } from "./extensions/illustration-extension";
import {
  canVibrate,
  getOsNotificationStatus,
  playNotifySound,
  playNotifyVibration,
  registerNotificationExtension,
  requestAndTestOsNotification,
  sendTestWebhookPush,
  type OsNotificationStatus,
} from "./extensions/notification-extension";
import { StellaStore } from "./state/store";
import type { ActiveSettings, MediaPromptLibrary, StellaPreset } from "./types/preset";
import type { StellaUserProfile } from "./types/user";
import { presetToActiveSettings } from "./types/preset";
import {
  buildDefaultPromptPreset,
  buildNovelAIDefaultPromptPreset,
  DEFAULT_PRESET_NAME,
  NOVELAI_PRESET_NAME,
} from "./util/default-prompt-preset";
import { MODEL_KIND_DEFAULTS } from "./util/model-kind-policy";
import type { SessionScrollAnchor } from "./util/session-anchor";
import { clampSessionViewStyle, type SessionViewStyle } from "./util/view-style";
import { ensureBaseFolders } from "./util/ensure-folders";
import {
  DashboardView,
  type DashboardTab,
  type EditorKind,
  type EditorRoute,
} from "./views/dashboard-view";
import { DetailView } from "./views/detail-view";
import { installGlobalImeTracker } from "./views/edit-guard";
import { IllustrationOutputView } from "./views/illustration-output-view";
import { ChatSessionView } from "./views/chat-session-view";
import {
  getSessionHostLeaves,
  isSessionHostView,
  SESSION_HOST_VIEW_TYPES,
} from "./views/session-host";
import { SessionView, type SessionViewCommand } from "./views/session-view";
import { SidebarView } from "./views/sidebar-view";

/**
 * 플러그인 영속 데이터.
 *  - current: 활성 세션이 없을 때 사이드바가 조작하는 활성 설정. 새 세션 만들 때 상속.
 *  - lastActivePresetId: 사용자가 마지막에 적용한 프리셋(=PRESETS/<id>) — 활성 표시용.
 *  - lastActivePromptPresetId (deprecated): R4e 이전 호환만. 무시 가능.
 *  - lastDetailTab: 우측 detail view 의 마지막 활성 탭.
 */
export interface StellaPluginData {
  current?: ActiveSettings;
  mediaPrompts?: MediaPromptLibrary;
  /** 문단 재생성 패널에서 마지막으로 선택한 프롬프트 id. */
  paragraphRegenPromptId?: string;
  activeUserProfileFile?: string;
  lastActivePresetId?: string;
  /** 이어쓸 때마다 즐겨찾기한 프리셋으로 자동 순환할지 (문체 고착/반복 방지). */
  presetRotationEnabled?: boolean;
  /** "Default (NovelAI)" 기본 세트를 기존 vault 에 1회 시드했는지 (재생성 방지). */
  novelaiDefaultSeeded?: boolean;
  /** @deprecated R4e 이전 의미. */
  lastActivePromptPresetId?: string;
  lastDetailTab?: "basic" | "scenario" | "branch" | "expand";
  /** 좌측 사이드바의 마지막 활성 탭 (L3a). */
  lastSidebarTab?: "scenario" | "user" | "lorebook";
  /** 대시보드(로비)의 마지막 활성 탭. */
  lastDashboardTab?: DashboardTab;
  /** 대시보드에서 마지막으로 열어둔 시나리오 상세 폴더 (편집기/세션에서 복귀용). */
  lastDashboardDetail?: string | null;
  /** 대시보드에서 마지막으로 열어둔 편집 페이지(페르소나 등) 라우트. */
  lastDashboardEditor?: EditorRoute | null;
  sidebarCardLayout?: "compact" | "cover";
  lastActiveSessionFile?: string | null;
  /** 분기(노드) 화면 번역 표시 토글 — 전역 영속(다시 열어도 유지). */
  branchShowTranslation?: boolean;
  /** 세션별 마지막 읽던 위치 — 보던 노드 기준 앵커. key = sessionFile. 재실행 복원용. */
  sessionAnchor?: Record<string, SessionScrollAnchor>;
  /** 세션별 안 읽은 AI 응답 — 보고 있지 않을 때 생성이 끝나면 쌓이고, 세션을 보면 지워진다. key = sessionFile. */
  sessionUnread?: Record<string, SessionUnread>;
  /** 우측 디테일 뷰 UI 상태(섹션 접힘 등) 영속. */
  detailUi?: {
    basic?: Record<string, unknown>;
    scenario?: Record<string, unknown>;
    expand?: Record<string, unknown>;
  };
  /**
   * 확장 탭 설정 패널 전용 저장 칸 — 패널 id → (세션 파일 경로 | "_global") → 임의 데이터.
   * 스텔라 본체 `ActiveSettings` 와 격리되어 있어 외부 확장이 써도 서로 덮어쓰지 않는다.
   */
  extensionPanelData?: Record<string, Record<string, unknown>>;
  /** 2분할 번역 보기의 좌측(원문) 너비 비율 0~1. */
  translationSplitRatio?: number;
  /** 2분할 번역 보기의 원문·번역 스크롤 체인 on/off (기본 on, 분할바 사슬 버튼). */
  translationScrollChain?: boolean;
  /** 세션창 본문 보기 스타일(문단 간격/들여쓰기/최대폭/폰트 배율) — 전역, 모든 세션 공통. */
  viewStyle?: SessionViewStyle;
  settings?: StellaPluginSettings;
  /** 최초 설치 온보딩(좌우 사이드바 배치 + 대시보드 자동 오픈)을 이미 보여줬는지. */
  installOnboardingShown?: boolean;
}

/**
 * 세션 하나의 안 읽음 상태 (N0). 알림 확장(notification-extension)이 기록하고,
 * 사용자가 그 세션을 보면(`rememberActiveSessionFile`/창 포커스 복귀) 지워진다.
 */
export interface SessionUnread {
  /** 안 읽은 AI 응답 수. */
  count: number;
  /** 마지막 도착 시각 (epoch ms). */
  lastAt: number;
  /** 마지막 도착분 앞부분 — 홈 히어로 카드 미리보기용. */
  preview?: string;
}

export interface StellaPluginSettings {
  autoGenerateSessionTitle?: boolean;
  /** 모바일에서 세션 조작 패널을 시스템 내비게이션 바 위로 띄우는 추가 여백(px). PC 미적용. */
  toolbarBottomGap?: number;
  /** 읽기 모드 내보내기(.md) 저장 폴더. 비면 vault 루트에 만든다. */
  exportFolder?: string;
  /**
   * 응답 도착 푸시 웹훅 URL (선택). 설정하면 안 보고 있는 세션의 생성 완료를
   * 이 주소로 POST 한다 — ntfy(https://ntfy.sh/<주제>)를 넣으면 휴대폰 실제 푸시.
   */
  notifyWebhookUrl?: string;
  /** 응답 도착 알림음 (기본 켜짐). OS 알림 권한과 무관하게 앱이 직접 재생. */
  notifySound?: boolean;
  /** 응답 도착 진동 (기본 켜짐). 모바일(안드로이드)에서만 동작. */
  notifyVibrate?: boolean;
}

/**
 * StellaEnginePlugin — GGAI Stella Engine 진입점.
 *
 * 핵심 책임:
 *  1. vault 에 GGAI/ 및 하위 기본 폴더 멱등 생성
 *  2. StellaStore (단일 진실 소스) 생성 + vault 이벤트 바인딩
 *  3. AIService — GGAI Core 래퍼
 *  4. 좌측 사이드바 / 세션 뷰 / 우측 detail 뷰 등록 — 모두 plugin 인스턴스를 주입받아 store / ai 접근
 *  5. 최초 레이아웃 로드 시 좌측 뷰 자동 꽂기 + 리본 아이콘
 *  6. PluginData 영속화 (loadData/saveData)
 *
 * View 에 주입되는 인터페이스: `plugin.store`, `plugin.ai`, `plugin.data` (둘 다 Events 확장체).
 *
 * 데이터 규약:
 *  - 모든 데이터 mutation 은 `this.store` 를 통한다. View 에서 vault 직접 호출 금지.
 *  - 모든 AI 호출은 `this.ai` 를 통한다. Core API 직접 접근 금지.
 *  - View 는 `store.on(...)` / `ai.on(...)` 로 변경을 구독해 자체 갱신.
 */
/**
 * 예전 버전이 등록했다가 제거된 스텔라 뷰 타입들. 편집기 4종은 대시보드 내부
 * 라우트로 편입되며 별도 워크스페이스 뷰가 폐기됐다. 이 타입으로 저장돼 있던
 * 탭은 지금 플러그인이 등록하지 않으므로 옵시디언이 "유령 탭"(No view of type …)
 * 으로 복원하고, 어떤 코드도 정리하지 못해 재시작해도 영원히 남는다. 로드 시
 * 저장된 상태 타입으로 찾아 닫는다.
 */
const DEPRECATED_STELLA_VIEW_TYPES = [
  "ggai-stella-scenario-editor",
  "ggai-stella-lorebook-editor",
  "ggai-stella-user-editor",
  "ggai-stella-prompts-editor",
] as const;

export default class StellaEnginePlugin extends Plugin {
  /** 데이터 단일 진실 소스. View 등록 전에 반드시 초기화. */
  store!: StellaStore;
  /** GGAI Core 래퍼 — Core 미설치 시에도 안전. */
  ai!: AIService;
  /** 세션 노드 번역 실행기 — 트리거 UI 가 translateNode() 를 호출한다. */
  translation!: TranslationService;
  /** 세션 요약 실행기 — 생성 완료 후 자동 요약이 summarizeIfNeeded() 를 호출한다. */
  summary!: SummaryService;
  /** 노드 삽화 생성 실행기. */
  illustration!: IllustrationService;
  /** 문단 재생성 실행기 — 세션창 문단 선택 모드의 재생성 패널이 호출한다. */
  paragraphRegen!: ParagraphRegenService;
  /** 확장 탭 설정 패널 레지스트리. 내장/외부 패널 모두 `registerSettingsPanel()` 로 등록. */
  settingsPanels!: SettingsPanelRegistry;
  /** 확장 모듈 레지스트리 — 컨텍스트 기여 / 생성-완료 훅 / 로어북 선택 대체. */
  extensions!: StellaExtensionRegistry;
  /** 영속 플러그인 설정. onload 초반에 loadData 로 채움. */
  data!: StellaPluginData;
  private stellaPanelLeaf: WorkspaceLeaf | null = null;

  async onload(): Promise<void> {
    // 0. 영속 데이터
    this.data = ((await this.loadData()) as StellaPluginData) ?? {};
    // 저장된 데이터가 전혀 없으면 처음 설치한 상태 — 최초 1회 온보딩(대시보드 자동 오픈) 트리거.
    const isFreshInstall = Object.keys(this.data).length === 0;
    this.applyToolbarBottomGap();

    // 1. 기본 폴더
    const result = await ensureBaseFolders(this.app.vault);
    if (result.errors.length > 0) {
      const first = result.errors[0];
      console.warn("[GGAI Stella] 폴더 초기화 일부 실패:", result.errors);
      new Notice(
        `GGAI Stella: 폴더 초기화 실패 — ${first.path} (${first.message})`
      );
    }

    // 2. Store — view 팩토리가 호출되기 전에 만들어야 한다.
    this.store = new StellaStore(this.app.vault);
    this.store.bindVaultEvents((ref) => this.registerEvent(ref));

    // 전역 IME 조합 추적 — 조합 중 배경 뷰의 DOM/선택영역 개입을 미루는 기준.
    installGlobalImeTracker((cleanup) => this.register(cleanup));

    // 모바일 홈버튼 바 높이를 키보드 없는 순간에 측정해 고정한다(세션 툴바 여백용).
    this.installHomeBarInsetTracker();

    // [임시 진단] 입력 포커스 소실 추적 — GGAI/focus-log.txt 에 기록. 원인 확정 후 제거.
    installFocusForensics(this);

    // 3. AI service (Core 미설치 시에도 객체는 만들고 isAvailable=false)
    this.ai = new AIService(this.app);
    this.ai.start();
    this.translation = new TranslationService(this);
    this.summary = new SummaryService(this);
    this.illustration = new IllustrationService(this);
    this.paragraphRegen = new ParagraphRegenService(this);
    this.settingsPanels = new SettingsPanelRegistry(() =>
      this.store.trigger("settings-panels-changed")
    );
    this.extensions = new StellaExtensionRegistry(this);
    // 내장 확장 등록 — 번역/삽화/요약(확장 + 설정 패널). 외부 플러그인도 같은 API 로 꽂는다.
    registerTranslationExtension(this);
    registerIllustrationExtension(this);
    registerSummaryExtension(this);
    registerNotificationExtension(this);
    this.addSettingTab(new StellaSettingTab(this.app, this));

    // 4. View 등록 (plugin 인스턴스 주입 — view 가 store/ai 접근)
    this.registerView(
      VIEW_TYPE_SIDEBAR,
      (leaf: WorkspaceLeaf) => new SidebarView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_SESSION,
      (leaf: WorkspaceLeaf) => new SessionView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_CHAT_SESSION,
      (leaf: WorkspaceLeaf) => new ChatSessionView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_DASHBOARD,
      (leaf: WorkspaceLeaf) => new DashboardView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_DETAIL,
      (leaf: WorkspaceLeaf) => new DetailView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_ILLUSTRATION_OUTPUT,
      (leaf: WorkspaceLeaf) => new IllustrationOutputView(leaf, this)
    );

    // 5. 명령 — 전역(어디서나) 열기 커맨드
    this.addCommand({
      id: "open-stella-dashboard",
      name: "대시보드(로비) 열기",
      callback: () => void this.openStellaPanel(),
    });
    this.addCommand({
      id: "open-stella-sidebar",
      name: "시나리오 목록(사이드바) 열기",
      callback: () => void this.revealSidebar(),
    });
    this.addCommand({
      id: "open-stella-detail-pane",
      name: "우측 상세 패널 열기",
      callback: () => void this.revealDetail(),
    });
    this.addCommand({
      id: "open-stella-illustration-output",
      name: "삽화 출력 창 열기",
      callback: () => void this.revealIllustrationOutput(),
    });
    // 최근에 하던 세션으로 바로 복귀 (로비를 거치지 않는 단축키).
    this.addCommand({
      id: "resume-last-session",
      name: "최근 세션 이어하기",
      checkCallback: (checking: boolean) => {
        const sessionFile = this.getActiveOrLastSessionFile();
        if (!sessionFile) return false;
        if (!checking) void this.openStellaSession(sessionFile);
        return true;
      },
    });

    // 세션 진행 중 자주 쓰는 액션 — 하단 툴바/뷰어 바 버튼과 같은 동작을
    // 커맨드/단축키로도 노출. (활성 세션창이 있을 때만 동작.)
    this.registerSessionCommands();

    // 업데이트 뒤 옵시디언 도크에 남은 스텔라 유령/중복 탭을 즉시 정리.
    this.addCommand({
      id: "cleanup-stella-ghost-tabs",
      name: "유령 탭 정리",
      callback: () => this.reconcileStellaLeaves(),
    });

    // 6. 리본 아이콘 — 실행용 아이콘 하나만 둔다(나머지 진입은 전부 커맨드).
    // 업데이트/핫리로드로 이전 버전 리본이 쌓이지 않게 먼저 전부 제거하고 다시 단다.
    this.removeStaleRibbonIcons();
    this.addRibbonIcon("sparkles", "GGAI Stella", () => {
      void this.revealSidebar();
    });

    // 7. 최초 레이아웃 준비 시 좌우 뷰 + Default 프롬프트 세트 보장
    this.app.workspace.onLayoutReady(() => {
      // 탐색기/디테일 싱글턴 정리 + 삽화 출력·옛 편집기 유령 탭 정리.
      this.reconcileStellaLeaves();
      // 지연 로드된 유령 탭은 레이아웃 준비 직후엔 아직 안 나타날 수 있어 한 번 더.
      this.registerInterval(
        window.setTimeout(() => this.reconcileStellaLeaves(), 1200)
      );
      void this.ensureDefaultPromptPreset();
      this.updateStellaPanelActiveClass(this.app.workspace.activeLeaf);
      if (isFreshInstall) {
        void this.savePluginData({ installOnboardingShown: true });
        void this.openStellaPanel();
      } else if (this.data.installOnboardingShown !== true) {
        void this.savePluginData({ installOnboardingShown: true });
      }
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (isSessionHostView(leaf?.view)) {
          this.rememberActiveSessionFile(leaf.view.getSessionFile());
        }
        // 여러 Stella 패널(로비)이 열려 있을 때, 지금 보고 있는 그 패널을
        // "현재 패널"로 삼는다 → 그 안에서 세션/편집기를 열면 같은 탭에서 열린다.
        if (leaf && this.isMarkedStellaPanelLeaf(leaf)) {
          this.stellaPanelLeaf = leaf;
        }
        this.updateStellaPanelActiveClass(leaf ?? null);
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.updateStellaPanelActiveClass(this.app.workspace.activeLeaf);
      })
    );
    this.registerEvent(
      this.store.on("session-deleted", (file: string) => {
        const patch: Partial<StellaPluginData> = {};
        if (this.data.lastActiveSessionFile === file) {
          patch.lastActiveSessionFile = null;
        }
        if (this.data.sessionAnchor?.[file] !== undefined) {
          const map = { ...this.data.sessionAnchor };
          delete map[file];
          patch.sessionAnchor = map;
        }
        if (this.data.sessionUnread?.[file] !== undefined) {
          const map = { ...this.data.sessionUnread };
          delete map[file];
          patch.sessionUnread = map;
        }
        if (Object.keys(patch).length > 0) void this.savePluginData(patch);
      })
    );
    this.registerEvent(
      this.store.on("session-renamed", (oldFile: string, newFile: string) => {
        const patch: Partial<StellaPluginData> = {};
        const prevAnchor = this.data.sessionAnchor?.[oldFile];
        if (prevAnchor !== undefined) {
          const map = { ...this.data.sessionAnchor };
          delete map[oldFile];
          map[newFile] = prevAnchor;
          patch.sessionAnchor = map;
        }
        const prevUnread = this.data.sessionUnread?.[oldFile];
        if (prevUnread !== undefined) {
          const map = { ...this.data.sessionUnread };
          delete map[oldFile];
          map[newFile] = prevUnread;
          patch.sessionUnread = map;
        }
        if (Object.keys(patch).length > 0) void this.savePluginData(patch);
      })
    );
    // 안 읽음은 "그 세션을 보는 순간" 지워진다. 같은 세션 탭을 켜둔 채 창만 벗어났다
    // 돌아오는 경우 active-leaf-change 가 안 터지므로 창 포커스 복귀에서도 확인한다.
    this.registerDomEvent(window, "focus", () => {
      const view = this.app.workspace.activeLeaf?.view;
      if (isSessionHostView(view)) {
        const f = view.getSessionFile();
        if (f) void this.clearSessionUnread(f);
      }
    });
  }

  /**
   * 기본 프롬프트 세트 2개(Default / Default (NovelAI)) 보장.
   *  - PROMPTS/ 가 비어있으면 둘 다 생성하고, 활성 세트 미지정이면 NovelAI 를 기본 활성으로.
   *  - 이미 세트가 있는 vault 에는 NovelAI 세트가 없으면 **한 번만** 추가한다
   *    (novelaiDefaultSeeded 플래그 — 사용자가 지우면 다시 만들지 않는다).
   * 동시 호출이 와도 같은 결과를 만들도록 한 promise 로 직렬화.
   */
  private defaultEnsuringPromise: Promise<void> | null = null;
  async ensureDefaultPromptPreset(): Promise<void> {
    if (this.defaultEnsuringPromise) return this.defaultEnsuringPromise;
    this.defaultEnsuringPromise = (async () => {
      try {
        const list = await this.store.getPromptPresets();
        if (list.length === 0) {
          await this.store.createPromptPreset(
            DEFAULT_PRESET_NAME,
            buildDefaultPromptPreset(DEFAULT_PRESET_NAME)
          );
          const novel = await this.store.createPromptPreset(
            NOVELAI_PRESET_NAME,
            buildNovelAIDefaultPromptPreset(NOVELAI_PRESET_NAME)
          );
          if (!this.data.current?.promptSetId) {
            await this.patchActiveSettings(
              { promptSetId: novel.preset.meta.id },
              null
            );
          }
          await this.savePluginData({ novelaiDefaultSeeded: true });
          console.debug("[GGAI Stella] 기본 프롬프트 세트 2개 자동 생성");
          return;
        }
        // 기존 vault 마이그레이션: NovelAI 기본 세트 1회 시드.
        if (
          !this.data.novelaiDefaultSeeded &&
          !list.some((p) => p.preset.meta.name === NOVELAI_PRESET_NAME)
        ) {
          await this.store.createPromptPreset(
            NOVELAI_PRESET_NAME,
            buildNovelAIDefaultPromptPreset(NOVELAI_PRESET_NAME)
          );
          console.debug("[GGAI Stella] Default (NovelAI) 프롬프트 세트 시드");
        }
        if (!this.data.novelaiDefaultSeeded) {
          await this.savePluginData({ novelaiDefaultSeeded: true });
        }
      } catch (err) {
        console.warn("[GGAI Stella] 기본 프롬프트 세트 생성 실패:", err);
      } finally {
        this.defaultEnsuringPromise = null;
      }
    })();
    return this.defaultEnsuringPromise;
  }

  /**
   * 모델 종류(chat/text)에 맞춰 "NAI 형식으로 보내기"를 자동 토글한다.
   * 텍스트 컴플리션 모델이면 켜고(역할 토큰으로 감싸기), 채팅 모델이면 끈다.
   * 프롬프트 세트 자체는 건드리지 않는다.
   */
  async setNaiFormatForModel(
    kind: "chat" | "text",
    sessionFile: string | null
  ): Promise<void> {
    try {
      await this.patchActiveSettings(
        { naiFormat: MODEL_KIND_DEFAULTS[kind].naiFormat },
        sessionFile
      );
    } catch (err) {
      console.warn("[GGAI Stella] NAI 형식 자동 토글 실패:", err);
    }
  }

  /** PluginData 부분 갱신 + 영속화. */
  async savePluginData(patch: Partial<StellaPluginData>): Promise<void> {
    Object.assign(this.data, patch);
    await this.saveData(this.data);
  }

  /** 모바일 세션 조작 패널 하단 여백(px)을 CSS 변수로 반영 (styles.css 가 body.is-mobile 에서만 사용). */
  applyToolbarBottomGap(): void {
    const gap = this.data.settings?.toolbarBottomGap ?? 0;
    document.body.style.setProperty("--ggai-toolbar-bottom-gap", `${gap}px`);
  }

  /**
   * 모바일 홈버튼 바(시스템 내비게이션) 높이를 --ggai-home-inset 에 고정한다.
   *
   * 왜 필요한가: 이 기기의 안드로이드 옵시디언은 웹 표준 env(safe-area-inset-bottom) 을
   * 0 으로 두고, 자체 주입 변수 --safe-area-inset-bottom 에만 값을 넣는다. 그런데 그 변수는
   * 소프트키보드가 뜨면 키보드 높이까지 커져(그대로 쓰면 툴바가 이중으로 뜸), 안 쓰면(env 만)
   * 홈버튼 바 여백이 아예 없어 툴바가 홈 바 뒤로 숨는다.
   *
   * 해법: 키보드가 없는 순간에만 --safe-area-inset-bottom 을 읽어(=순수 홈바 높이)
   * --ggai-home-inset 으로 고정하고, 키보드가 떠 있는 동안엔 갱신하지 않는다. 키보드
   * 판정은 visualViewport 축소로 한다(레이아웃을 통째로 줄이는 기기·덮는 기기 모두 커버).
   */
  private installHomeBarInsetTracker(): void {
    if (!Platform.isMobile) return;
    const sample = () => {
      const raw = getComputedStyle(document.body)
        .getPropertyValue("--safe-area-inset-bottom")
        .trim();
      const px = parseFloat(raw);
      if (Number.isFinite(px) && px >= 0) {
        document.body.style.setProperty("--ggai-home-inset", `${px}px`);
      }
    };
    // 시작 직후 몇 차례 재시도 — 옵시디언이 변수를 늦게 채우는 경우 대비.
    for (const delay of [0, 300, 1000, 2500]) window.setTimeout(sample, delay);

    const vv = window.visualViewport;
    if (!vv) return;
    let baseW = vv.width;
    let baseH = vv.height;
    const update = () => {
      if (vv.width !== baseW) {
        baseW = vv.width;
        baseH = vv.height;
      } else {
        baseH = Math.max(baseH, vv.height);
      }
      const keyboardOpen = baseH - vv.height > 100;
      // 키보드가 없을 때(=변수에 홈바 값만 있을 때)만 다시 측정해 고정.
      if (!keyboardOpen) sample();
    };
    vv.addEventListener("resize", update);
    this.register(() => vv.removeEventListener("resize", update));
  }

  /** 세션별 마지막 읽던 노드 앵커 조회 (없으면 null). */
  getSessionAnchor(sessionFile: string): SessionScrollAnchor | null {
    return this.data.sessionAnchor?.[sessionFile] ?? null;
  }

  /** 세션별 읽던 노드 앵커 기록 + 영속화. null 이면 항목 제거 (기본값으로 회귀). */
  async setSessionAnchor(
    sessionFile: string,
    anchor: SessionScrollAnchor | null
  ): Promise<void> {
    const map = { ...(this.data.sessionAnchor ?? {}) };
    if (anchor) map[sessionFile] = anchor;
    else delete map[sessionFile];
    await this.savePluginData({ sessionAnchor: map });
  }

  /** 세션별 안 읽음 상태 조회 (없으면 null). */
  getSessionUnread(sessionFile: string): SessionUnread | null {
    return this.data.sessionUnread?.[sessionFile] ?? null;
  }

  /** 안 읽은 AI 응답 1건 누적 + 영속화. 뱃지 갱신용 store 이벤트 발행. */
  async markSessionUnread(sessionFile: string, preview?: string): Promise<void> {
    const map = { ...(this.data.sessionUnread ?? {}) };
    const prev = map[sessionFile];
    map[sessionFile] = {
      count: (prev?.count ?? 0) + 1,
      lastAt: Date.now(),
      preview: preview || prev?.preview,
    };
    await this.savePluginData({ sessionUnread: map });
    this.store.trigger("session-unread-changed", sessionFile);
  }

  /** 세션 안 읽음 해제 (읽은 것으로 처리). 상태가 없으면 아무것도 안 함. */
  async clearSessionUnread(sessionFile: string): Promise<void> {
    if (this.data.sessionUnread?.[sessionFile] === undefined) return;
    const map = { ...this.data.sessionUnread };
    delete map[sessionFile];
    await this.savePluginData({ sessionUnread: map });
    this.store.trigger("session-unread-changed", sessionFile);
  }

  /** 세션창 본문 보기 스타일 조회 (기본값 병합 + 범위 clamp). */
  getViewStyle(): SessionViewStyle {
    return clampSessionViewStyle(this.data.viewStyle);
  }

  /** 세션창 본문 보기 스타일 부분 갱신 + 영속화. clamp 된 최종값을 돌려준다. */
  async saveViewStyle(patch: Partial<SessionViewStyle>): Promise<SessionViewStyle> {
    const next = clampSessionViewStyle({ ...this.data.viewStyle, ...patch });
    await this.savePluginData({ viewStyle: next });
    return next;
  }

  /**
   * 활성 설정 (modelProfileId / params / promptSetId) 을 결정.
   *  - 세션 있음 → 세션 메타에서 직접.
   *  - 세션 없음 → PluginData.current 에서.
   */
  async resolveActiveSettings(sessionFile: string | null): Promise<ActiveSettings> {
    if (sessionFile) {
      const session = await this.store.getSession(sessionFile);
      if (session) {
        return {
          modelProfileId: session.meta.modelProfileId,
          params: session.meta.params,
          promptSetId: session.meta.promptSetId,
          translation: session.meta.translation ? { ...session.meta.translation } : undefined,
          illustration: session.meta.illustration ? { ...session.meta.illustration } : undefined,
          summarize: session.meta.summarize ? { ...session.meta.summarize } : undefined,
          naiFormat: session.meta.naiFormat,
          continueAnchor: session.meta.continueAnchor,
        };
      }
    }
    return this.data.current ?? {};
  }

  /**
   * 활성 설정 부분 갱신 (값이 undefined 면 그 키는 건드리지 않음).
   * 세션 있으면 세션 메타에, 없으면 PluginData.current 에 박는다.
   */
  async patchActiveSettings(
    patch: Partial<ActiveSettings>,
    sessionFile: string | null
  ): Promise<void> {
    if (sessionFile) {
      const session = await this.store.getSession(sessionFile);
      if (!session) return;
      applyActiveSettingsPatch(session.meta, patch);
      await this.store.saveSession(sessionFile, session);
      const current = { ...(this.data.current ?? {}) };
      applyActiveSettingsPatch(current, patch);
      await this.savePluginData({ current });
      return;
    }
    const current = { ...(this.data.current ?? {}) };
    applyActiveSettingsPatch(current, patch);
    await this.savePluginData({ current });
  }

  /**
   * 확장 탭에 설정 패널을 등록한다 (내장/외부 플러그인 공용 진입점).
   * 반환된 함수를 호출하면 해제된다. 자세한 규약은 `확장 패널 스펙.md` 참고.
   */
  registerSettingsPanel(panel: SettingsPanel): () => void {
    return this.settingsPanels.register(panel);
  }

  /**
   * 프리셋의 묶음을 활성 설정에 통째 적용.
   * opts.silent 면 lastActivePresetId(=프리셋 그리드의 "선택됨" 표시)를 건드리지
   * 않는다 — 자동 순환처럼 사용자가 직접 고른 게 아닌 적용에 쓴다.
   */
  async applyPreset(
    preset: StellaPreset,
    sessionFile: string | null,
    opts?: { silent?: boolean }
  ): Promise<void> {
    await this.patchActiveSettings(presetToActiveSettings(preset), sessionFile);
    // 프리셋은 NAI 형식 여부를 안 들고 있으므로 모델 종류로 재유도 — 이전 모델의
    // 체크 상태가 그대로 남아 "텍스트인데 꺼짐/챗인데 켜짐"이 되는 것을 방지.
    if (preset.modelProfileId) {
      const profile = this.ai.getProfileById(preset.modelProfileId);
      if (profile) await this.setNaiFormatForModel(profile.kind, sessionFile);
    }
    // 사용자가 직접 고른 설정 — 랜덤 순환이 켜져 있어도 다음 1회 생성은 이대로.
    this.notePresetRotationManualChoice();
    if (!opts?.silent) {
      await this.savePluginData({ lastActivePresetId: preset.id });
    }
  }

  /** 사용자가 프리셋/모델을 직접 고른 직후 — 다음 1회 생성은 순환을 건너뛴다. */
  private presetRotationSkipOnce = false;

  notePresetRotationManualChoice(): void {
    this.presetRotationSkipOnce = true;
  }

  /**
   * 프리셋 자동 순환 — 켜져 있으면 즐겨찾기한 프리셋 중 하나를 무작위로 골라(주사위
   * 굴리기) **그 프리셋 객체만 돌려준다**. 활성 설정/세션/PluginData/UI 에는 아무것도
   * 쓰지 않는다 — 호출자(세션창 생성)가 전송 1회용 오버라이드로만 쓴다
   * (presetToGenerationOverride → planSessionRequest.settingsOverride).
   * 사용자가 프리셋/모델을 직접 고른 직후 1회는 건너뛰어 그 선택 그대로 생성한다.
   */
  async pickRotationPreset(): Promise<StellaPreset | null> {
    if (!this.data.presetRotationEnabled) return null;
    if (this.presetRotationSkipOnce) {
      this.presetRotationSkipOnce = false;
      return null;
    }
    const items = await this.store.getPresets();
    const favs = items.filter((i) => i.preset.favorite);
    if (favs.length === 0) return null;
    return favs[Math.floor(Math.random() * favs.length)].preset;
  }

  // ─── R4e 이전 호환 (UI 가 R4e2 에서 새 헬퍼로 옮겨가면 제거) ────────

  /** @deprecated resolveActiveSettings 로 대체 예정. */
  async setActiveUserProfileFile(userFile: string): Promise<void> {
    await this.savePluginData({ activeUserProfileFile: userFile });
  }

  async resolveActiveUserProfile(): Promise<{ userFile: string; profile: StellaUserProfile }> {
    const configured = this.data.activeUserProfileFile;
    if (configured) {
      const profile = await this.store.getUserProfile(configured);
      if (profile) return { userFile: configured, profile };
    }

    const users = await this.store.getUsers();
    const fallback = users.find((u) => u.profile.id === "default") ?? users[0];
    if (fallback) {
      if (configured !== fallback.userFile) {
        void this.savePluginData({ activeUserProfileFile: fallback.userFile });
      }
      return { userFile: fallback.userFile, profile: fallback.profile };
    }

    const profile = await this.store.getDefaultUserProfile();
    const userFile = "GGAI/USERS/default.json";
    if (configured !== userFile) {
      void this.savePluginData({ activeUserProfileFile: userFile });
    }
    return { userFile, profile };
  }

  async resolveActivePromptPresetId(
    sessionFile: string | null
  ): Promise<string | undefined> {
    if (sessionFile) {
      const session = await this.store.getSession(sessionFile);
      if (session?.meta.promptPresetId) return session.meta.promptPresetId;
    }
    return this.data.lastActivePromptPresetId;
  }

  /** @deprecated applyPreset 로 대체 예정. */
  async setActivePromptPresetId(
    presetId: string,
    sessionFile: string | null
  ): Promise<void> {
    await this.savePluginData({ lastActivePromptPresetId: presetId });
    if (sessionFile) {
      const session = await this.store.getSession(sessionFile);
      if (session && session.meta.promptPresetId !== presetId) {
        session.meta.promptPresetId = presetId;
        await this.store.saveSession(sessionFile, session);
      }
    }
  }

  /**
   * 세션을 열 때 활성 페르소나를 결정한다.
   * 우선순위: (1) 세션이 기억하는 페르소나 → (2) 시나리오 전용 페르소나 → (3) 현재 활성 유지.
   * 세션 시작/열기 진입점(openSessionByPath)에서 호출한다.
   */
  async activateSessionPersona(sessionFile: string): Promise<void> {
    try {
      const session = await this.store.getSession(sessionFile);
      if (!session) return;

      // (1) 세션이 기억하는 페르소나 — 파일이 살아 있으면 그것으로.
      const remembered = session.meta.personaFile;
      if (remembered) {
        const profile = await this.store.getUserProfile(remembered);
        if (profile) {
          if (this.data.activeUserProfileFile !== remembered) {
            await this.setActiveUserProfileFile(remembered);
          }
          return;
        }
      }

      // (2) 시나리오 전용 페르소나.
      const scenarioId = session.meta.scenarioId;
      if (!scenarioId) return;
      const users = await this.store.getUsers();
      const match = users.find((u) => u.profile.scenarioIds?.includes(scenarioId));
      if (match && this.data.activeUserProfileFile !== match.userFile) {
        await this.setActiveUserProfileFile(match.userFile);
      }
      // (3) 매칭 없으면 현재 활성 유지 — 아무것도 하지 않는다.
    } catch (err) {
      console.warn("[GGAI Stella] 세션 페르소나 활성화 실패:", err);
    }
  }

  /**
   * 사용자가 페르소나를 명시적으로 선택(사이드바/대시보드/홈) — 활성으로 지정하고,
   * 세션 뷰가 열려 있으면 그 세션이 이 페르소나를 기억하게 한다(마지막 선택만 유지).
   */
  async selectActivePersona(userFile: string): Promise<void> {
    await this.setActiveUserProfileFile(userFile);
    const sessionFile = this.getOpenSessionFile();
    if (!sessionFile) return;
    try {
      const session = await this.store.getSession(sessionFile);
      if (session && session.meta.personaFile !== userFile) {
        session.meta.personaFile = userFile;
        await this.store.saveSession(sessionFile, session);
      }
    } catch (err) {
      console.warn("[GGAI Stella] 세션 페르소나 기억 실패:", err);
    }
  }

  /** 지금 워크스페이스에 열려 있는 세션 뷰의 파일 — "세션 중"인지 판별용(없으면 null). */
  private getOpenSessionFile(): string | null {
    const active = this.app.workspace.activeLeaf;
    if (isSessionHostView(active?.view)) {
      const f = active.view.getSessionFile();
      if (f) return f;
    }
    for (const leaf of getSessionHostLeaves(this.app.workspace)) {
      if (isSessionHostView(leaf.view)) {
        const f = leaf.view.getSessionFile();
        if (f) return f;
      }
    }
    return null;
  }

  rememberActiveSessionFile(sessionFile: string | null): void {
    if (!sessionFile) return;
    // 세션이 활성화됐다 = 사용자가 보기 시작했다 → 안 읽음 해제.
    void this.clearSessionUnread(sessionFile);
    if (this.data.lastActiveSessionFile === sessionFile) return;
    void this.savePluginData({ lastActiveSessionFile: sessionFile });
    // 같은 세션 뷰 leaf 안에서 세션을 바꾸면 active-leaf-change 가 안 터진다.
    // 활성 세션 변경의 단일 지점에서 이벤트를 발행해 DetailView 등이 실시간 반영하게 한다.
    this.store.trigger("active-session-changed", sessionFile);
  }

  /**
   * 열려 있는 세션 뷰의 미저장 본문 편집을 store 에 커밋한다.
   * "현재 컨텍스트 확인"처럼 전송본을 외부에서 만들기 직전에 호출해, 방금 친
   * 문단까지 컨텍스트에 포함되도록 한다 (미리보기 = 전송본 불변식).
   */
  async flushSessionEdits(sessionFile: string): Promise<void> {
    for (const leaf of getSessionHostLeaves(this.app.workspace)) {
      const view = leaf.view;
      if (isSessionHostView(view) && view.getSessionFile() === sessionFile) {
        await view.flushPendingEdits();
      }
    }
  }

  /**
   * 열려 있는 세션 뷰를 해당 노드 위치로 스크롤한다 (분기는 바꾸지 않는다).
   * 세션이 열려 있지 않거나 그 노드가 활성 경로에 없으면 false.
   */
  scrollOpenSessionToNode(sessionFile: string, nodeId: string): boolean {
    for (const leaf of getSessionHostLeaves(this.app.workspace)) {
      const view = leaf.view;
      if (isSessionHostView(view) && view.getSessionFile() === sessionFile) {
        return view.scrollToNode(nodeId);
      }
    }
    return false;
  }

  getActiveOrLastSessionFile(): string | null {
    const active = this.app.workspace.activeLeaf;
    if (isSessionHostView(active?.view)) {
      const activeSession = active.view.getSessionFile();
      if (activeSession) return activeSession;
    }

    if (this.data.lastActiveSessionFile) return this.data.lastActiveSessionFile;

    for (const leaf of getSessionHostLeaves(this.app.workspace)) {
      if (isSessionHostView(leaf.view)) {
        const sessionFile = leaf.view.getSessionFile();
        if (sessionFile) return sessionFile;
      }
    }
    return null;
  }

  /** 지금 활성 탭이 소설 세션창이면 그 뷰 (세션 커맨드 checkCallback 대상). */
  private getActiveNovelSessionView(): SessionView | null {
    return this.app.workspace.getActiveViewOfType(SessionView);
  }

  /**
   * 세션 진행 액션을 옵시디언 커맨드로 등록한다. 각 커맨드는 활성 소설 세션창이
   * 있고 그 액션이 지금 가능할 때만 동작한다(checkCallback → 단축키 게이트).
   * 실제 동작은 SessionView.runSessionCommand — 하단 툴바/뷰어 바 버튼과 단일 소스.
   */
  private registerSessionCommands(): void {
    const cmds: Array<{ id: string; name: string; action: SessionViewCommand }> =
      [
        { id: "session-continue", name: "세션: 이어쓰기 / 생성 중단", action: "continue" },
        { id: "session-regenerate", name: "세션: 재생성", action: "regenerate" },
        {
          id: "session-toggle-translation",
          name: "세션: 원문 ↔ 번역 전환",
          action: "toggle-translation",
        },
        { id: "session-prev-branch", name: "세션: 이전 분기", action: "prev-branch" },
        { id: "session-next-branch", name: "세션: 다음 분기", action: "next-branch" },
        {
          id: "session-quicksave",
          name: "세션: 이 지점 저장(즐겨찾기)",
          action: "quicksave",
        },
        {
          id: "session-batch-translate",
          name: "세션: 번역 안 된 문단 모두 번역",
          action: "batch-translate",
        },
        {
          id: "session-illustrate",
          name: "세션: 현재 지점 삽화 생성",
          action: "illustrate",
        },
        { id: "session-open-gallery", name: "세션: 삽화 갤러리 열기", action: "gallery" },
        { id: "session-go-lobby", name: "세션: 나가기(로비로)", action: "lobby" },
      ];
    for (const { id, name, action } of cmds) {
      this.addCommand({
        id,
        name,
        checkCallback: (checking: boolean) => {
          const view = this.getActiveNovelSessionView();
          if (!view || !view.sessionCommandAvailable(action)) return false;
          if (!checking) void view.runSessionCommand(action);
          return true;
        },
      });
    }
  }

  /**
   * Stella 패널(로비/대시보드)을 **새 탭으로** 연다. 매번 새 로비를 띄워
   * 여러 개를 동시에 둘 수 있다 — 한쪽에서 세션을 진행하며 다른 쪽에서
   * 자료를 정리하는 멀티태스킹 지원. (세션창 안 홈 버튼은 그 세션 탭을
   * 제자리에서 로비로 되돌린다 — 그건 goToLobby 담당.)
   */
  async openStellaPanel(): Promise<void> {
    // 좌측 사이드바 "패널 열기"는 항상 홈에서 시작한다 — 마지막으로 보던 탭/상세가
    // 아니라 로비 첫 화면을 연다(세션/편집기에서 돌아오는 back 경로와 구분).
    await this.savePluginData({
      lastDashboardTab: "home",
      lastDashboardDetail: null,
      lastDashboardEditor: null,
    });
    const leaf = this.app.workspace.getLeaf("tab");
    this.stellaPanelLeaf = leaf;
    await leaf.setViewState({
      type: VIEW_TYPE_DASHBOARD,
      active: true,
      state: { stellaPanel: true },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async openStellaSession(
    sessionFile: string,
    opts?: { focusIllustrationNode?: string }
  ): Promise<void> {
    this.rememberActiveSessionFile(sessionFile);
    const viewType = await this.resolveSessionViewType(sessionFile);
    const panel = this.getStellaPanelLeaf();
    const leaf = panel ?? this.findReusableSessionLeaf() ?? this.app.workspace.getLeaf("tab");
    if (panel) this.stellaPanelLeaf = panel;
    await leaf.setViewState({
      type: viewType,
      active: true,
      state: {
        sessionFile,
        stellaPanel: panel != null,
        focusIllustrationNode: opts?.focusIllustrationNode,
      },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * 세션의 mode 로 열릴 뷰를 결정하는 단일 라우팅 지점 (M6/C0).
   * `"chat"` 이 명시된 세션만 챗 뷰 — mode 누락/불명/읽기 실패는 전부 소설 뷰.
   * (기존 세션이 챗 뷰로 잘못 열리는 일을 원천 차단.)
   */
  private async resolveSessionViewType(sessionFile: string): Promise<string> {
    try {
      const session = await this.store.getSession(sessionFile);
      if (session?.meta.mode === "chat") return VIEW_TYPE_CHAT_SESSION;
    } catch {
      // 읽기 실패 → 소설 뷰가 기존 에러 처리를 담당
    }
    return VIEW_TYPE_SESSION;
  }

  /**
   * 편집 페이지(페르소나 등)를 대시보드 내부 라우트로 연다.
   *  - 열려 있는 Stella 패널이 대시보드면 그 안에서 편집 라우트로 이동(뒤로가기 유지).
   *  - 패널이 세션 중이거나 없으면, 세션 보존을 위해 새 탭에 대시보드를 편집 라우트로 연다.
   */
  async openStellaEditor(kind: EditorKind, file: string): Promise<void> {
    const panel = this.getStellaPanelLeaf();
    if (
      panel &&
      panel.view instanceof DashboardView &&
      !isSessionHostView(panel.view)
    ) {
      this.stellaPanelLeaf = panel;
      panel.view.navigateToEditor(kind, file);
      this.app.workspace.revealLeaf(panel);
      return;
    }
    // 세션 중이거나 대시보드 패널이 없으면 새 탭에 대시보드를 편집 라우트로 시작.
    await this.savePluginData({ lastDashboardEditor: { kind, file } });
    const leaf = this.app.workspace.getLeaf("tab");
    this.stellaPanelLeaf = leaf;
    await leaf.setViewState({
      type: VIEW_TYPE_DASHBOARD,
      active: true,
      state: { stellaPanel: true },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * 대시보드를 특정 탭으로 연다 (우측 프롬프트 섹션 "새 탭에서 편집" 등).
   *  - 열려 있는 Stella 대시보드 패널이 있으면 그 안에서 탭 전환(세션 중이면 새 탭).
   *  - 없으면 새 탭에 대시보드를 그 탭으로 시작.
   */
  async openStellaDashboardTab(tab: DashboardTab): Promise<void> {
    const panel = this.getStellaPanelLeaf();
    if (panel && panel.view instanceof DashboardView) {
      this.stellaPanelLeaf = panel;
      await panel.view.jumpToTab(tab);
      this.app.workspace.revealLeaf(panel);
      return;
    }
    await this.savePluginData({
      lastDashboardTab: tab,
      lastDashboardDetail: null,
      lastDashboardEditor: null,
    });
    const leaf = this.app.workspace.getLeaf("tab");
    this.stellaPanelLeaf = leaf;
    await leaf.setViewState({
      type: VIEW_TYPE_DASHBOARD,
      active: true,
      state: { stellaPanel: true },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async openStellaFile(file: TFile): Promise<void> {
    const panel = this.getStellaPanelLeaf();
    // 세션이 열린 패널은 재사용하지 않는다 — 세션 탭 덮어쓰기 방지.
    const reusable = panel && !isSessionHostView(panel.view) ? panel : null;
    const leaf = reusable ?? this.app.workspace.getLeaf(true);
    if (reusable) this.stellaPanelLeaf = reusable;
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  private getStellaPanelLeaf(): WorkspaceLeaf | null {
    if (this.stellaPanelLeaf && this.isLeafAttached(this.stellaPanelLeaf)) {
      return this.stellaPanelLeaf;
    }

    const dashboardLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD)[0];
    if (dashboardLeaf) {
      this.stellaPanelLeaf = dashboardLeaf;
      return dashboardLeaf;
    }

    const marked = this.findMarkedStellaPanelLeaf();
    this.stellaPanelLeaf = marked;
    return marked;
  }

  private findMarkedStellaPanelLeaf(): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const state = leaf.getViewState().state;
      if (state && typeof state === "object" && (state as { stellaPanel?: unknown }).stellaPanel === true) {
        found = leaf;
      }
    });
    return found;
  }

  private updateStellaPanelActiveClass(leaf: WorkspaceLeaf | null): void {
    const active = leaf != null && this.isMarkedStellaPanelLeaf(leaf);
    document.body.toggleClass("ggai-stella-panel-active", active);
  }

  private isMarkedStellaPanelLeaf(leaf: WorkspaceLeaf): boolean {
    const state = leaf.getViewState().state;
    const type = leaf.view.getViewType();
    return (
      this.isStellaViewType(type) ||
      (state != null &&
        typeof state === "object" &&
        (state as { stellaPanel?: unknown }).stellaPanel === true)
    );
  }

  private isStellaViewType(type: string): boolean {
    return type === VIEW_TYPE_DASHBOARD || SESSION_HOST_VIEW_TYPES.includes(type);
  }

  private isLeafAttached(target: WorkspaceLeaf): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf === target) found = true;
    });
    return found;
  }

  private findReusableSessionLeaf(): WorkspaceLeaf | null {
    const active = this.app.workspace.activeLeaf;
    if (this.isReusableSessionTarget(active)) return active;

    const emptySessionLeaf = getSessionHostLeaves(this.app.workspace).find(
      (leaf) => this.isReusableSessionTarget(leaf)
    );
    if (emptySessionLeaf) return emptySessionLeaf;

    return this.app.workspace.getLeavesOfType("empty")[0] ?? null;
  }

  /**
   * 스텔라가 좌측 리본에 단 아이콘을 전부 제거한다. 옵시디언이 업데이트/핫리로드
   * 시 이전 인스턴스의 리본 아이콘을 정리하지 못해 쌓이는 문제(폐기된 기능의
   * 유령 아이콘 포함)를 막는다 — 아이콘을 새로 달기 직전에 1회 호출한다.
   * 스텔라 아이콘은 모두 aria-label 이 "GGAI Stella" 로 시작하므로 그것으로 판별한다.
   */
  private removeStaleRibbonIcons(): void {
    const actions = document.querySelectorAll(".side-dock-ribbon-action");
    actions.forEach((el) => {
      const label = el.getAttribute("aria-label") ?? "";
      if (label.startsWith("GGAI Stella")) el.remove();
    });
  }

  private isReusableSessionTarget(leaf: WorkspaceLeaf | null): leaf is WorkspaceLeaf {
    if (!leaf) return false;
    const viewType = leaf.view.getViewType();
    if (viewType === "empty") return true;
    // User-requested policy: selecting a different session should replace the
    // currently open Stella session tab.
    return isSessionHostView(leaf.view);
  }

  /**
   * 저장된 상태 타입(getViewState().type)이 주어진 타입인 리프를 전부 모은다.
   *
   * **핵심**: 옵시디언 최신 버전은 보이지 않는 사이드바 탭을 지연 로드(deferred
   * view)로 둔다. 이때 `getLeavesOfType()` 와 live `view.getViewType()` 는 그 탭을
   * 놓치므로, 리로드마다 "기존 탭 없음"으로 오판해 새 탭이 하나씩 쌓였다. 저장된
   * 상태 타입은 지연/유령(등록 해제된 옛 타입) 탭까지 항상 정확히 식별한다.
   */
  private findLeavesByStateType(...types: string[]): WorkspaceLeaf[] {
    const out: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const stateType = leaf.getViewState()?.type ?? leaf.view?.getViewType();
      if (stateType && types.includes(stateType)) out.push(leaf);
    });
    return out;
  }

  /** 제거된 옛 편집기 뷰 타입으로 저장된 유령 탭을 전부 닫는다. */
  private removeDeprecatedGhostLeaves(): void {
    for (const leaf of this.findLeavesByStateType(...DEPRECATED_STELLA_VIEW_TYPES))
      leaf.detach();
  }

  /**
   * 스텔라가 옵시디언 도크에 배치하는 단일(싱글턴) 탭들을 정리한다 — 탐색기/디테일은
   * 정확히 하나씩만 남기고, 삽화 출력·옛 편집기 유령 탭은 정리한다. 지연 로드된
   * 유령이 늦게 나타나는 경우를 대비해 로드 직후 + 잠깐 뒤 두 번 호출된다.
   */
  private reconcileStellaLeaves(): void {
    void this.ensureSidebarLeaf();
    void this.ensureDetailLeaf();
    // 삽화 출력 뷰는 요청 시에만 열리므로 중복/유령만 정리(재생성 안 함).
    for (const leaf of this.findLeavesByStateType(
      VIEW_TYPE_ILLUSTRATION_OUTPUT
    ).slice(1))
      leaf.detach();
    this.removeDeprecatedGhostLeaves();
  }

  private async ensureSidebarLeaf(): Promise<void> {
    // 업데이트/리로드로 남은 탐색기 탭(지연·유령 포함)은 첫 하나만 남기고 닫는다.
    const existing = this.findLeavesByStateType(VIEW_TYPE_SIDEBAR);
    if (existing.length > 0) {
      for (const leaf of existing.slice(1)) leaf.detach();
      return;
    }

    const leaf = this.app.workspace.getLeftLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({ type: VIEW_TYPE_SIDEBAR, active: false });
  }

  private async revealSidebar(): Promise<void> {
    await this.ensureSidebarLeaf();
    const leaves = this.findLeavesByStateType(VIEW_TYPE_SIDEBAR);
    if (leaves[0]) this.app.workspace.revealLeaf(leaves[0]);
  }

  /** 우측 사이드바에 detail view 를 항상 배치 — 리본이 없는 모바일에서도 세션/디테일에 바로 접근하도록. */
  private async ensureDetailLeaf(): Promise<void> {
    const existing = this.findLeavesByStateType(VIEW_TYPE_DETAIL);
    if (existing.length > 0) {
      for (const leaf of existing.slice(1)) leaf.detach();
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({ type: VIEW_TYPE_DETAIL, active: false });
  }

  /** 우측 사이드바에 detail view 가 없으면 만들고, 있으면 reveal. */
  async revealDetail(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DETAIL);
    if (existing[0]) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_DETAIL, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** 우측 사이드바에 삽화 출력 뷰가 없으면 만들고, 있으면 reveal. */
  async revealIllustrationOutput(): Promise<void> {
    const existing = this.findLeavesByStateType(VIEW_TYPE_ILLUSTRATION_OUTPUT);
    if (existing[0]) {
      for (const leaf of existing.slice(1)) leaf.detach();
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({
      type: VIEW_TYPE_ILLUSTRATION_OUTPUT,
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async toggleDetail(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DETAIL);
    if (existing.length > 0) {
      for (const leaf of existing) {
        await leaf.detach();
      }
      return;
    }
    await this.revealDetail();
  }

  onunload(): void {
    // registerView 로 등록한 뷰는 옵시디언이 자동 정리.
    // detachLeavesOfType 호출은 사용자 레이아웃을 해치는 안티패턴이라 하지 않음.
    document.body.removeClass("ggai-stella-panel-active");
    document.body.style.removeProperty("--ggai-toolbar-bottom-gap");
    this.ai?.stop();
  }
}

function applyActiveSettingsPatch(
  target: ActiveSettings,
  patch: Partial<ActiveSettings>
): void {
  if (patch.modelProfileId !== undefined) target.modelProfileId = patch.modelProfileId;
  if (patch.params !== undefined) target.params = patch.params;
  if (patch.promptSetId !== undefined) target.promptSetId = patch.promptSetId;
  if (patch.translation !== undefined) target.translation = { ...patch.translation };
  if (patch.illustration !== undefined) target.illustration = { ...patch.illustration };
  if (patch.summarize !== undefined) target.summarize = { ...patch.summarize };
  if (patch.naiFormat !== undefined) target.naiFormat = patch.naiFormat;
  if (patch.continueAnchor !== undefined) target.continueAnchor = patch.continueAnchor;
}

class StellaSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: StellaEnginePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GGAI Stella Engine" });

    new Setting(containerEl)
      .setName("새 세션 제목 자동 생성")
      .setDesc("첫 AI 전개가 끝나면 본문 초반부를 반영한 제목으로 세션 이름을 한 번 자동 변경합니다.")
      .addToggle((toggle) =>
        toggle
          .setValue(
            this.plugin.data.settings?.autoGenerateSessionTitle === true
          )
          .onChange(async (value) => {
            await this.plugin.savePluginData({
              settings: {
                ...(this.plugin.data.settings ?? {}),
                autoGenerateSessionTitle: value,
              },
            });
          })
      );

    new Setting(containerEl)
      .setName("읽기 모드 내보내기 폴더")
      .setDesc(
        "세션을 읽기 모드(.md)로 내보낼 때 저장할 폴더입니다. 비워두면 볼트 최상위에 만듭니다. 예: Exports"
      )
      .addText((text) => {
        text
          .setPlaceholder("(볼트 최상위)")
          .setValue(this.plugin.data.settings?.exportFolder ?? "")
          .onChange(async (value) => {
            await this.plugin.savePluginData({
              settings: {
                ...(this.plugin.data.settings ?? {}),
                exportFolder: value.trim(),
              },
            });
          });
        new FolderSuggest(this.app, text.inputEl);
      });

    new Setting(containerEl)
      .setName("응답 도착 알림음")
      .setDesc(
        "안 보고 있는 세션의 AI 응답이 도착하면 짧은 알림음을 냅니다. " +
          "OS 알림 권한과 무관하며, PC는 창이 백그라운드여도 소리가 나고 모바일은 앱 실행 중에 동작합니다. 켜는 순간 미리 들려줍니다."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings?.notifySound !== false)
          .onChange(async (value) => {
            await this.plugin.savePluginData({
              settings: {
                ...(this.plugin.data.settings ?? {}),
                notifySound: value,
              },
            });
            if (value) playNotifySound();
          })
      );

    // 진동 — 지원 환경(모바일 안드로이드 등)에서만 항목 노출.
    if (canVibrate()) {
      new Setting(containerEl)
        .setName("응답 도착 진동")
        .setDesc(
          "안 보고 있는 세션의 AI 응답이 도착하면 짧게 진동합니다. 무음 모드에서도 도착을 알 수 있습니다. 켜는 순간 미리 진동합니다."
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.data.settings?.notifyVibrate !== false)
            .onChange(async (value) => {
              await this.plugin.savePluginData({
                settings: {
                  ...(this.plugin.data.settings ?? {}),
                  notifyVibrate: value,
                },
              });
              if (value) playNotifyVibration();
            })
        );
    }

    // 데스크톱 OS 알림 — 권한을 미리 확보하고 테스트 토스트로 표시 여부까지 확인.
    if (Platform.isDesktopApp) {
      const osLabel = (status: OsNotificationStatus): string => {
        switch (status) {
          case "granted":
            return "권한 상태: 허용됨 — [테스트 알림]으로 실제 표시되는지 확인하세요.";
          case "denied":
            return "권한 상태: 거부됨 — OS 설정(Windows: 설정 > 시스템 > 알림)에서 Obsidian을 허용해야 합니다.";
          case "default":
            return "권한 상태: 미정 — [권한 요청 + 테스트]를 누르면 권한을 받고 테스트 알림을 띄웁니다.";
          default:
            return "이 환경에서는 OS 알림을 지원하지 않습니다.";
        }
      };
      const osSetting = new Setting(containerEl)
        .setName("데스크톱 알림 (자리 비움 시)")
        .setDesc(osLabel(getOsNotificationStatus()));
      osSetting.addButton((btn) =>
        btn
          .setButtonText(
            getOsNotificationStatus() === "granted"
              ? "테스트 알림"
              : "권한 요청 + 테스트"
          )
          .onClick(async () => {
            const status = await requestAndTestOsNotification();
            osSetting.setDesc(osLabel(status));
            btn.setButtonText(
              status === "granted" ? "테스트 알림" : "권한 요청 + 테스트"
            );
            if (status === "granted") {
              new Notice(
                "테스트 알림을 보냈습니다. 화면 구석(알림 센터)에 뜨는지 확인하세요. 안 보이면 OS의 집중 지원/알림 설정을 확인해 주세요."
              );
            } else if (status === "denied") {
              new Notice(
                "알림 권한이 거부되어 있습니다. OS 설정에서 Obsidian 알림을 허용해 주세요."
              );
            }
          })
      );
    }

    new Setting(containerEl)
      .setName("응답 도착 푸시 알림 웹훅 URL")
      .setDesc(
        "안 보고 있는 세션의 AI 응답이 도착하면 이 주소로 알림을 보냅니다. " +
          "휴대폰으로 받으려면: ntfy 앱 설치 → 앱에서 아무 주제(예: my-stella-abc123)를 구독 → " +
          "여기에 https://ntfy.sh/그주제 를 입력하고 [테스트 전송]으로 확인. 비워두면 사용 안 함."
      )
      .addText((text) =>
        text
          .setPlaceholder("https://ntfy.sh/…")
          .setValue(this.plugin.data.settings?.notifyWebhookUrl ?? "")
          .onChange(async (value) => {
            await this.plugin.savePluginData({
              settings: {
                ...(this.plugin.data.settings ?? {}),
                notifyWebhookUrl: value.trim(),
              },
            });
          })
      )
      .addButton((btn) =>
        btn.setButtonText("테스트 전송").onClick(async () => {
          btn.setDisabled(true);
          try {
            const fail = await sendTestWebhookPush(this.plugin);
            new Notice(
              fail
                ? `웹훅 테스트 실패: ${fail}`
                : "웹훅 테스트를 보냈습니다. 휴대폰(ntfy 앱)에 도착했는지 확인하세요."
            );
          } finally {
            btn.setDisabled(false);
          }
        })
      );

    new Setting(containerEl)
      .setName("조작 패널 하단 여백 (모바일)")
      .setDesc(
        "세션 하단 조작 패널이 안드로이드 홈버튼/제스처 바와 겹칠 때 이 값만큼 위로 띄웁니다. PC에는 적용되지 않습니다."
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 2)
          .setValue(this.plugin.data.settings?.toolbarBottomGap ?? 0)
          .setDynamicTooltip()
          .onChange(async (value) => {
            await this.plugin.savePluginData({
              settings: {
                ...(this.plugin.data.settings ?? {}),
                toolbarBottomGap: value,
              },
            });
            this.plugin.applyToolbarBottomGap();
          })
      );
  }
}

/** 볼트 안 기존 폴더를 타이핑 없이 고를 수 있는 자동완성 (읽기 모드 내보내기 폴더용). */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, private inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase();
    const folders: TFolder[] = [];
    const collect = (folder: TFolder) => {
      folders.push(folder);
      for (const child of folder.children) {
        if (child instanceof TFolder) collect(child);
      }
    };
    collect(this.app.vault.getRoot());
    return folders.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 200);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path || "/");
  }

  selectSuggestion(folder: TFolder): void {
    const value = folder.path === "/" ? "" : folder.path;
    this.setValue(value);
    this.inputEl.value = value;
    this.inputEl.trigger("input");
    this.close();
  }
}
