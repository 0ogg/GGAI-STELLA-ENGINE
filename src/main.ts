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
import { SessionView } from "./views/session-view";
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

export interface StellaPluginSettings {
  autoGenerateSessionTitle?: boolean;
  /** 모바일에서 세션 조작 패널을 시스템 내비게이션 바 위로 띄우는 추가 여백(px). PC 미적용. */
  toolbarBottomGap?: number;
  /** 읽기 모드 내보내기(.md) 저장 폴더. 비면 vault 루트에 만든다. */
  exportFolder?: string;
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
    // 내장 확장 등록 — 요약(확장 + 설정 패널). 외부 플러그인도 같은 API 로 꽂는다.
    registerSummaryExtension(this);
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

    // 5. 명령 — 우측 detail 패널 열기
    this.addCommand({
      id: "open-stella-detail-pane",
      name: "GGAI Stella 우측 패널 열기",
      callback: () => void this.revealDetail(),
    });

    // 6. 리본 아이콘
    this.addCommand({
      id: "open-stella-dashboard",
      name: "GGAI Stella dashboard",
      callback: () => void this.openStellaPanel(),
    });

    this.addRibbonIcon("sparkles", "GGAI Stella", () => {
      void this.revealSidebar();
    });

    // 삽화 출력 전용 뷰 열기 (우측 사이드바 자체 아이콘)
    this.addCommand({
      id: "open-stella-illustration-output",
      name: "GGAI Stella 삽화 출력 열기",
      callback: () => void this.revealIllustrationOutput(),
    });
    this.addRibbonIcon("image", "GGAI Stella 삽화 출력", () => {
      void this.revealIllustrationOutput();
    });

    // 7. 최초 레이아웃 준비 시 좌우 뷰 + Default 프롬프트 세트 보장
    this.app.workspace.onLayoutReady(() => {
      void this.ensureSidebarLeaf();
      void this.ensureDetailLeaf();
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
        if (leaf?.view instanceof SessionView) {
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
        if (Object.keys(patch).length > 0) void this.savePluginData(patch);
      })
    );
    this.registerEvent(
      this.store.on("session-renamed", (oldFile: string, newFile: string) => {
        const prev = this.data.sessionAnchor?.[oldFile];
        if (prev === undefined) return;
        const map = { ...this.data.sessionAnchor };
        delete map[oldFile];
        map[newFile] = prev;
        void this.savePluginData({ sessionAnchor: map });
      })
    );
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
    if (!opts?.silent) {
      await this.savePluginData({ lastActivePresetId: preset.id });
    }
  }

  /**
   * 프리셋 자동 순환 — 켜져 있으면 즐겨찾기한 프리셋 중 하나를 무작위로 골라(주사위
   * 굴리기) 활성 설정에 적용한다(이어쓰기 직전 호출). 즐겨찾기가 없으면 아무 것도
   * 안 한다. `silent` 적용이라 프리셋 그리드의 "선택됨" 표시는 바뀌지 않는다 —
   * 사용자가 마지막으로 직접 고른 프리셋 그대로 보인다.
   * 적용된 프리셋 id 를 돌려준다(없으면 null).
   */
  async maybeRotatePreset(sessionFile: string | null): Promise<string | null> {
    if (!this.data.presetRotationEnabled) return null;
    const items = await this.store.getPresets();
    const favs = items.filter((i) => i.preset.favorite);
    if (favs.length === 0) return null;
    const pick = favs[Math.floor(Math.random() * favs.length)];
    await this.applyPreset(pick.preset, sessionFile, { silent: true });
    return pick.preset.id;
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
    if (active?.view instanceof SessionView) {
      const f = active.view.getSessionFile();
      if (f) return f;
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION)) {
      if (leaf.view instanceof SessionView) {
        const f = leaf.view.getSessionFile();
        if (f) return f;
      }
    }
    return null;
  }

  rememberActiveSessionFile(sessionFile: string | null): void {
    if (!sessionFile || this.data.lastActiveSessionFile === sessionFile) return;
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
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION)) {
      const view = leaf.view;
      if (view instanceof SessionView && view.getSessionFile() === sessionFile) {
        await view.flushPendingEdits();
      }
    }
  }

  /**
   * 열려 있는 세션 뷰를 해당 노드 위치로 스크롤한다 (분기는 바꾸지 않는다).
   * 세션이 열려 있지 않거나 그 노드가 활성 경로에 없으면 false.
   */
  scrollOpenSessionToNode(sessionFile: string, nodeId: string): boolean {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION)) {
      const view = leaf.view;
      if (view instanceof SessionView && view.getSessionFile() === sessionFile) {
        return view.scrollToNode(nodeId);
      }
    }
    return false;
  }

  getActiveOrLastSessionFile(): string | null {
    const active = this.app.workspace.activeLeaf;
    if (active?.view instanceof SessionView) {
      const activeSession = active.view.getSessionFile();
      if (activeSession) return activeSession;
    }

    if (this.data.lastActiveSessionFile) return this.data.lastActiveSessionFile;

    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION)) {
      if (leaf.view instanceof SessionView) {
        const sessionFile = leaf.view.getSessionFile();
        if (sessionFile) return sessionFile;
      }
    }
    return null;
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
    const panel = this.getStellaPanelLeaf();
    const leaf = panel ?? this.findReusableSessionLeaf() ?? this.app.workspace.getLeaf("tab");
    if (panel) this.stellaPanelLeaf = panel;
    await leaf.setViewState({
      type: VIEW_TYPE_SESSION,
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
   * 편집 페이지(페르소나 등)를 대시보드 내부 라우트로 연다.
   *  - 열려 있는 Stella 패널이 대시보드면 그 안에서 편집 라우트로 이동(뒤로가기 유지).
   *  - 패널이 세션 중이거나 없으면, 세션 보존을 위해 새 탭에 대시보드를 편집 라우트로 연다.
   */
  async openStellaEditor(kind: EditorKind, file: string): Promise<void> {
    const panel = this.getStellaPanelLeaf();
    if (
      panel &&
      panel.view instanceof DashboardView &&
      panel.view.getViewType() !== VIEW_TYPE_SESSION
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
    const reusable =
      panel && panel.view.getViewType() !== VIEW_TYPE_SESSION ? panel : null;
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
    return type === VIEW_TYPE_DASHBOARD || type === VIEW_TYPE_SESSION;
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

    const emptySessionLeaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_SESSION)
      .find((leaf) => this.isReusableSessionTarget(leaf));
    if (emptySessionLeaf) return emptySessionLeaf;

    return this.app.workspace.getLeavesOfType("empty")[0] ?? null;
  }

  private isReusableSessionTarget(leaf: WorkspaceLeaf | null): leaf is WorkspaceLeaf {
    if (!leaf) return false;
    const viewType = leaf.view.getViewType();
    if (viewType === "empty") return true;
    // User-requested policy: selecting a different session should replace the
    // currently open Stella session tab.
    return leaf.view instanceof SessionView;
  }

  private async ensureSidebarLeaf(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);
    // User-requested policy: hot reload must not accumulate Stella explorer
    // tabs. Keep exactly one left sidebar explorer leaf and close duplicates.
    if (existing.length > 0) {
      for (const leaf of existing.slice(1)) {
        leaf.detach();
      }
      return;
    }

    const leaf = this.app.workspace.getLeftLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({ type: VIEW_TYPE_SIDEBAR, active: false });
  }

  private async revealSidebar(): Promise<void> {
    await this.ensureSidebarLeaf();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);
    if (leaves[0]) this.app.workspace.revealLeaf(leaves[0]);
  }

  /** 우측 사이드바에 detail view 를 항상 배치 — 리본이 없는 모바일에서도 세션/디테일에 바로 접근하도록. */
  private async ensureDetailLeaf(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DETAIL);
    if (existing.length > 0) {
      for (const leaf of existing.slice(1)) {
        leaf.detach();
      }
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
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_ILLUSTRATION_OUTPUT
    );
    if (existing[0]) {
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
