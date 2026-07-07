import { ItemView, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { VIEW_TYPE_DASHBOARD, VIEW_TYPE_SESSION } from "../constants";
import type StellaEnginePlugin from "../main";
import { AIService, type GenerationProfileLite } from "../services/ai-service";
import { StellaStore } from "../state/store";
import type {
  Patch,
  SessionNode,
  Span,
  StellaSession,
  TurnKind,
} from "../types/session";
import { paramsToOverride as buildParamsOverride } from "../util/generation-params";
import {
  applyMacros,
  renderMacrosWithMap,
  type MacroContext,
  type MacroRender,
} from "../util/macros";
import { planSessionRequest } from "../util/build-session-context";
import {
  isDefaultDatedSessionName,
  requestSessionTitle,
} from "../util/session-title";
import {
  anchorSkipFinal,
  anchorSkipStreaming,
} from "../util/continuation-anchor";
import type { PromptPresetParams } from "../types/prompt";
import type {
  SessionTranslations,
  SessionIllustrations,
  IllustrationVariant,
} from "../types/media";
import type { TranslationOutputMode } from "../types/preset";
import {
  getActiveIllustration,
  listIllustrationVariants,
  removeIllustrationVariant,
  resolveIllustrationOutput,
  setActiveIllustrationVariant,
  toggleIllustrationFavorite,
} from "../util/illustrations";
import {
  completedParagraphsAfter,
  computeIllustrationAnchors,
  DEFAULT_ILLUSTRATION_AUTO_MIN_PARAGRAPHS,
} from "../util/illustration-anchors";
import type { IllustrationAnchor } from "../util/illustration-anchors";
import { computeLatestAiMarkerOffset } from "../util/ai-start-marker";
import { isImeComposing, runWhenImeIdle } from "./edit-guard";
import { IllustrationCarousel } from "./illustration-carousel";
import {
  IllustrationGalleryModal,
  type GalleryItem,
} from "./gallery-modal";
import { IllustrationRegenModal } from "./illustration-regen-modal";
import { ParagraphRegenModal } from "./paragraph-regen-modal";
import { ViewStylePopover } from "./view-style-popover";
import { clampSessionViewStyle, type SessionViewStyle } from "../util/view-style";
import {
  listParagraphRanges,
  paragraphIndexAtOffset,
} from "../util/paragraph-regen";
import {
  nodeAnchorToOffset,
  offsetToNodeAnchor,
  type SessionScrollAnchor,
} from "../util/session-anchor";
import { attachLongPress } from "../util/long-press";
import {
  collectAnchorChain,
  composeSummaryContext,
} from "../util/summarize-session";
import {
  collectUntranslatedParagraphs,
  collectUntranslatedParagraphsFrom,
  getActiveTranslation,
  hasTranslation,
  recordTranslationVariant,
  redoLastTranslation,
  tokenizeParagraphs,
  undoLastTranslation,
} from "../util/translate-paragraphs";
import type {
  TranslatePreviewResult,
  TranslateResult,
} from "../services/translation-service";
import { ChoiceModal, ConfirmModal } from "./modals";
import type { ScenarioListItem } from "../util/scan-scenarios";
import { diffText, TextDiff } from "../util/session-diff";
import {
  applyPatch,
  buildSpans,
  pathToLeaf,
  spansLength,
  spansToText,
} from "../util/session-text";
import {
  getChildren,
  getDeepestLatestDescendant,
  getSiblings,
  isAINode,
  mergeTrailingUserWrites,
} from "../util/session-tree";
import { uuidv4 } from "../util/uuid";

/**
 * SessionView ??B2 ?紐꾨??癒?탵??+ B3 ?브쑨由?AI ?????됱뵠??
 *
 * ?紐꾩춿 UX (B2):
 *  - `<div contenteditable="plaintext-only">` ????μ뵬 癰귣챶揆??곗쨮. AI/?醫? ?닌됲뀋?? `<span class>` 嚥?
 *  - ??筌왖?癒?퓠???④쑴???紐꾩춿??롫뮉 ??덈툧?? `pendingDiff` 嚥≪뮆彛??곕뗄??(?紐껊굡 沃섎챷源??.
 *  - ?紐꾩춿 ?袁⑺뒄揶쎛 獄쏅뗀???늺(caret ??pending ?닌덉퍢 獄쏅쉼?앮에? 筌앸맩???뚣끇而??뤿연 ???紐껊굡 ??밴쉐.
 *  - 1.5s idle ?癒?뮉 blur ???뚣끇而??紐꺿봺椰?
 *  - Ctrl+Z = activeLeaf ??parent 嚥? Ctrl+Y / Ctrl+Shift+Z = redoStack ?癒?퐣 癰귣벊??
 *  - ???뚣끇而????깅선??롢늺 redoStack ?? ??쑴?숋쭪袁⑤뼄 (?됰슢?뽫㎉??브쑨由?筌욊낯??.
 *
 * ?브쑨由?UX (B3):
 *  - [??곷선?怨뚮┛] = activeLeaf ??child + AI append (kind=ai-continue).
 *  - [??源??   = activeLeaf ??parent 獄?sibling + AI append (kind=ai-regen). AI ?紐껊굡?????춸.
 *  - [?? n/m ?? = 揶쏆늿? parent ????삘뀲 child(?類ㅼ젫)嚥???猷?
 *  - [????    = activeLeaf 筌앸Þ爰쇽㎕?섎┛ ?醫? (?紐꾩뵠?????????뽯뻻).
 *  - AI ??용뮞?紐껊뮉 ?袁⑸뻻 placeholder. ??쇱젫 GGAI Core ?紐꾪뀱?? B4 ?癒?퐣.
 *
 * B2 ????????紐꾩춿 ?紐껊굡??spec ??"??륁젟=sibling" ????B2 ??child 獄쎻뫗????醫???뺣뼄.
 * ?臾? typo ???됰슢?뽫㎉?? 筌띾슢諭???紐꺿봺揶쎛 ??뺢콢???숋쭪???UX ?얜챷?????????곕????????
 */
export interface SessionViewState {
  sessionFile?: string;
  stellaPanel?: boolean;
  /** 세션을 열 때 이 노드의 삽화로 스크롤 포커스 (갤러리 "이 분기로 이동"). */
  focusIllustrationNode?: string;
}

const IDLE_COMMIT_MS = 1500;
/** 일괄 번역이 이 분량을 넘으면 실행 전 확인 다이얼로그 (실수로 전체 텍스트 전송 방지). */
const TRANSLATE_CONFIRM_PARAGRAPHS = 6;
const TRANSLATE_CONFIRM_CHARS = 2000;
/** "전체 번역" 선택이 이 문단 수 이상이면 한 번 더 경고. */
const TRANSLATE_FULL_WARN_PARAGRAPHS = 20;
type BodyHighlightRange = {
  from: number;
  to: number;
  className: string;
};

export class SessionView extends ItemView {
  private sessionFile: string | null = null;
  private stellaPanel = false;
  private session: StellaSession | null = null;

  /** 筌띾뜆?筌??뚣끇而???뽰젎??癰귣챶揆 (pending diff ??疫꿸퀣?). */
  private baselineSpans: Span[] = [];
  private baselineText = "";
  private displaySpans: Span[] = [];
  private displayText = "";
  private displayRender: MacroRender = {
    text: "",
    displayToRaw: [0],
    macroRanges: [],
  };
  private displayMacroCtx: MacroContext = { user: "User" };

  private pendingDiff: TextDiff | null = null;
  private idleTimer: number | null = null;
  /** ??롫즼???紐껊굡 id ??쎄문 (??쇰뻻 ??쎈뻬??. ???뚣끇而????λ뜃由?? ?遺용뮞??肉????????? */
  private redoStack: string[] = [];

  private bodyWrapEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private toolbarEl: HTMLElement | null = null;
  /** DOM ???꾤빊?餓λ쵐肉?input/selectionchange ?얜똻?? */
  private suppressEvents = false;
  /**
   * IME(한글 등) 조합 진행 중 플래그. 조합 중에는 commitPending()이 body.empty() 로
   * 본문을 재구성하면 안 된다 — 조합이 깨지고 contenteditable 포커스가 풀려 다음
   * 입력이 씹힌다("입력 포커스 소실"). 편집기(user/scenario/lorebook)의 composing
   * 가드와 같은 목적. compositionend 시점에 밀린 편집을 반영한다.
   */
  private composing = false;
  private leafNavigationBusy = false;
  private undoPreviewVisible = false;
  /** 스크롤 위치 영속화 debounce 타이머. */
  private scrollSaveTimer: number | null = null;
  /** 리사이즈 재중앙 debounce 타이머 (슬라이드 애니메이션 중 매 프레임 재계산 방지). */
  private recenterTimer: number | null = null;
  /** 리사이즈 storm 동안 폭을 픽셀로 고정해 둔 요소들 (settle 시 해제). */
  private widthLockedEls: HTMLElement[] = [];
  /** 이번 render 에서 복원할 읽던 노드 앵커. 없으면 null(=끝으로). */
  private pendingAnchorRestore: SessionScrollAnchor | null = null;
  /** 세션을 열 때 이 노드의 삽화로 스크롤 (갤러리 이동). render 후 1회 적용. */
  private pendingIllustrationFocus: string | null = null;
  /** 마지막으로 파악한 읽던 위치(메모리) — 창 크기 변화/보기 전환 시 재중앙 기준. */
  private lastAnchor: SessionScrollAnchor | null = null;
  /**
   * render 후 아직 적용 못 한 복원 목표. 재시작/백그라운드 탭처럼 레이아웃 높이가
   * 0 일 때는 스크롤이 무효(=맨 위 방치)가 되므로, 크기가 실제로 잡히는 순간
   * ResizeObserver 가 재시도한다. "end" = 저장된 위치 없음 → 맨 아래로.
   */
  private restoreTarget: SessionScrollAnchor | "end" | null = null;
  /** 스크롤 → 메모리 앵커 갱신 rAF (디스크 저장과 별개로 즉시 추적). */
  private anchorCaptureRaf: number | null = null;
  /** 편집 중 커서를 키보드 위로 유지하는 rAF 스로틀. */
  private keepCaretRaf: number | null = null;
  /** 생성 중 꼬리 따라가기 — 사용자가 위로 스크롤하면 해제, 바닥으로 돌아오면 재개. */
  private followTail = false;
  /** 본문 영역 크기 변화 감지 — 보류된 복원 재시도 + 보던 노드 재중앙. */
  private resizeObserver: ResizeObserver | null = null;
  /** split 스크롤 체인 on/off (전역 영속, 분할바 사슬 버튼). */
  private chainScroll = true;
  /** 체인 되먹임 방지 — 최근 사용자 스크롤 패널만 sync 소스로 인정. */
  private syncLock: { source: "body" | "translation"; until: number } | null =
    null;
  private syncRafId: number | null = null;

  /** ??삳쐭????뽯뻻????뺢돌?귐딆궎 筌롫?? (?紐껉퐬????已?. loadSession + scenarios-changed ?癒?퐣 揶쏄퉮?? */
  private cachedScenario: ScenarioListItem | null = null;

  // ??而??遺용꺖 ??updateToolbar() ?癒?퐣 ?怨밴묶 揶쏄퉮???
  private undoBtn: HTMLButtonElement | null = null;
  private redoBtn: HTMLButtonElement | null = null;
  private jumpEndBtn: HTMLButtonElement | null = null;
  private continueBtn: HTMLButtonElement | null = null;
  private regenBtn: HTMLButtonElement | null = null;
  private prevSibBtn: HTMLButtonElement | null = null;
  private nextSibBtn: HTMLButtonElement | null = null;
  private siblingIndicator: HTMLElement | null = null;
  private nodeFavBtn: HTMLButtonElement | null = null;
  private viewStyleBtn: HTMLButtonElement | null = null;
  private sidePanelBtn: HTMLButtonElement | null = null;
  /** 본문 보기 스타일(문단 간격/들여쓰기/최대폭/폰트 배율) — 전역 PluginData, onOpen/렌더 시 로드. */
  private viewStyle: SessionViewStyle = clampSessionViewStyle(undefined);
  private viewStylePopover: ViewStylePopover | null = null;
  private translateBtn: HTMLButtonElement | null = null;
  private illustrationBtn: HTMLButtonElement | null = null;
  private paraRegenBtn: HTMLButtonElement | null = null;
  private viewToggleBtn: HTMLElement | null = null;

  // ── 번역 보기 (translations.json — 문단+내용 기준) ──
  /** 세션 번역 — store 캐시와 같은 참조. 저장은 store.saveSessionTranslations 경유. */
  private translations: SessionTranslations | null = null;
  /** 번역 보기 활성 여부 (replace 모드의 원문↔번역 토글). translations.displayMode 와 동기. */
  private translationViewActive = false;
  /** 번역 출력 방식 — session.meta.translation.output. replace=토글, split-h=좌우 2분할. */
  private outputMode: TranslationOutputMode = "replace";
  /** 번역 보기 오버레이 컨테이너 (bodyEl 형제). */
  private translationEl: HTMLElement | null = null;
  /** 2분할 모드의 드래그 분할바 (bodyEl 과 translationEl 사이). */
  private splitHandleEl: HTMLElement | null = null;
  /** 2분할 좌측(원문) 비율 0~1. 드래그로 조절, 뷰 인스턴스 동안 유지. */
  private splitRatio = 0.5;
  /**
   * 문단 편집 블록 — 세션창은 편집기가 기본 모드: 스팬을 그냥 고치면 그 문단의
   * 새 번역 variant 로 저장된다. 같은 내용 문단이 여러 번 나오면 블록도 여러 개
   * (번역은 해시로 공유). 배열 순서 = 문서 순서.
   */
  private translationBlocks: Array<{
    hash: string;
    source: string;
    baseline: string;
    /** 이 문단의 baseline 본문 시작 char offset (노드 앵커 계산용). */
    offset: number;
    el: HTMLElement;
    timer: number | null;
  }> = [];
  /** 번역 뷰 단일 편집 영역 (문단을 넘는 드래그 선택 + 직접 편집). */
  private translationEditEl: HTMLElement | null = null;
  /** 번역 편집 커밋 디바운스 타이머 (편집 영역 전체 공용). */
  private translationCommitTimer: number | null = null;
  /** 번역 실행 중 — 중복 실행 방지 + 버튼 busy 표시. */
  private translating = false;

  // ── 삽화 (illustrations.json — 노드 기준, 인라인 표시) ──
  /** 세션 삽화 — store 에서 로드한 참조. */
  private illustrations: SessionIllustrations | null = null;
  /** 삽화 생성 중 — 중복 방지 + 버튼 busy. */
  private illustrating = false;
  /** 자기 illustrations 저장 이벤트 무시 (variant 선택 슬라이드 애니메이션 보존). */
  private suppressOwnIllustrationsEvent = false;
  /** 인라인 삽화 위젯들 (원문 본문/번역 편집 영역 안의 원자 블록) — 재배치 시 제거용. */
  private inlineIllusEls: HTMLElement[] = [];
  /** 가장 최근 AI 생성 시작 마커(다섯 잎 꽃) — 재배치 시 제거용. */
  private aiStartMarkerEl: HTMLElement | null = null;
  /** 번역 뷰의 AI 생성 시작 마커 — 원문 패널과 별개로 추적/제거. */
  private aiStartMarkerTrEl: HTMLElement | null = null;
  /** 미번역 문단 일괄 번역 버튼 (뷰 헤더 액션 — PC/모바일 공통). */
  private batchTranslateBtn: HTMLElement | null = null;
  /** 번역 되돌리기 버튼 (탭=되돌리기/꾹=다시 적용, 뷰 헤더 액션 — PC/모바일 공통). */
  private undoTranslateBtn: HTMLElement | null = null;
  /** 삽화 갤러리 버튼 (뷰 헤더 액션 — PC/모바일 공통). */
  private galleryToolBtn: HTMLElement | null = null;
  /** 드래그 선택 변화 → 일괄 번역 버튼 갱신 디바운스 타이머. */
  private selectionUiTimer: number | null = null;
  /** 일괄 번역 버튼이 현재 "선택 영역" 모드인지 (아이콘 교체 최소화용). */
  private batchBtnSelectionMode = false;
  /** 자기 translations 저장 이벤트 무시 플래그 (suppressOwnSessionEvent 패턴). */
  private suppressOwnTranslationsEvent = false;
  /** 문단 선택 모드 (문단 재생성) — 툴바 버튼 토글, 문단 클릭/탭 시 재생성 패널. */
  private paraSelectMode = false;

  /**
   * ?癒?┛ view 揶쎛 store.saveSession ???紐꾪뀱??롢늺 store 揶쎛 "session-changed" ??獄쏆뮉???롫뮉??
   * 域???源?硫? ?癒?┛?癒?쓺???袁⑤뼎??뺣뼄. ??? baseline 揶쏄퉮???귐됱젉????멸땋 筌욊낱????얜똻???곷튊 ??뺣뼄.
   * saveSession ?紐꾪뀱 筌욊낯???true, ?紐꾪뀱 ??false. ?紐껊굶????true 筌?reload ??쎄땁.
   */
  private suppressOwnSessionEvent = false;

  // ?????? B4: AI ??쎈뱜?귐됱빪 ?怨밴묶 ??????
  /** ?袁⑹삺 筌욊쑵六?餓λ쵐??AI ??밴쉐 ??null ??????疫? */
  private generation: {
    nodeId: string;
    abort: AbortController;
    accumulatedText: string;
    /** 이어쓰기 이음새 보정용 — 앵커 제거 전 원본 응답 누적 (앵커 있을 때만). */
    rawText?: string;
    lastRaw?: unknown;
  } | null = null;
  /**
   * 생성(스트리밍) 중 새로 도착한 생성 텍스트만 담는 전용 컨테이너.
   * 고정된 앞부분은 그대로 두고 이 컨테이너만 다시 그려, 세션이 길어도 매 delta 마다
   * 전체 문서를 재구성/재도색하지 않는다. 전체 렌더(renderBodySpans) 시 함께 지워지므로
   * 그 시점에 null 로 되돌린다. */
  private streamTailEl: HTMLElement | null = null;
  /** 스트리밍 tail 첫 렌더 시 고정 앞부분이 문단을 끝냈는지(=첫 줄 들여쓰기 여부). */
  private streamTailIndentNext = true;
  private readonly selectionChangeHandler = () => this.onSelectionChange();
  private readonly visibilityHandler = () => {
    if (document.visibilityState === "visible") void this.handleExternalChange();
  };

  private plugin: StellaEnginePlugin;
  private store: StellaStore;
  private ai: AIService;

  constructor(leaf: WorkspaceLeaf, plugin: StellaEnginePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
    this.ai = plugin.ai;
  }

  getViewType(): string {
    return VIEW_TYPE_SESSION;
  }
  getDisplayText(): string {
    const sessionName = this.session?.meta.name ?? "Session";
    const scenarioName =
      this.cachedScenario?.scenario.data.name ?? this.cachedScenario?.folderName;
    return scenarioName ? `${scenarioName} / ${sessionName}` : sessionName;
  }
  getIcon(): string {
    return "book-open";
  }

  async setState(state: unknown, result: any): Promise<void> {
    const s = state as Partial<SessionViewState> | null;
    this.stellaPanel = s?.stellaPanel === true;
    const next = s && typeof s.sessionFile === "string" ? s.sessionFile : null;
    const focus =
      s && typeof s.focusIllustrationNode === "string"
        ? s.focusIllustrationNode
        : null;
    if (next && next !== this.sessionFile) {
      // ??삘뀲 ?紐꾨??곗쨮 ?대Ŋ猿??? 疫꿸퀣??pending ????됱몵筌?筌띾뜄龜??
      await this.commitPending();
      this.flushScrollSave(); // 떠나는 세션의 스크롤 위치 저장
      this.sessionFile = next;
      this.plugin.rememberActiveSessionFile(next);
      this.pendingIllustrationFocus = focus;
      await this.loadSession();
      this.render();
    } else if (focus) {
      // 이미 열려 있는 세션 — 바로 삽화로 스크롤.
      this.focusIllustrationNode(focus);
    }
    return super.setState(state, result);
  }

  getState(): Record<string, unknown> {
    return { sessionFile: this.sessionFile, stellaPanel: this.stellaPanel };
  }

  /** detail view ???紐??癒?퐣 ??뽮쉐 ?紐꾨?野껋럥以덄몴?筌╈돦荑???????? */
  getSessionFile(): string | null {
    return this.sessionFile;
  }

  /**
   * 활성 경로 위의 노드로 스크롤만 보낸다 (분기/활성 리프는 바꾸지 않는다).
   * 그 노드가 현재 활성 경로에 없으면(다른 분기) false — 호출측이 안내한다.
   */
  scrollToNode(nodeId: string): boolean {
    if (!this.session) return false;
    const onPath = pathToLeaf(this.session, this.session.meta.activeLeafId).some(
      (n) => n.id === nodeId
    );
    if (!onPath) return false;
    const raw = nodeAnchorToOffset(this.session, { nodeId, charInNode: 0 });
    if (raw == null) return false;
    this.lastAnchor = { nodeId, charInNode: 0 };
    this.scrollAfterLayout((scroller) =>
      this.scrollRawOffsetToCenter(scroller, raw)
    );
    return true;
  }

  /**
   * 미저장(in-progress) 본문 편집을 즉시 노드로 커밋해 store 에 반영한다.
   * 미리보기처럼 외부에서 "지금 전송될 그대로"를 읽기 전에 호출한다 —
   * 그래야 방금 친 문단이 컨텍스트에 포함되고, 미리보기 = 전송본 불변식이 유지된다.
   */
  async flushPendingEdits(): Promise<void> {
    await this.commitPending();
  }

  private refreshNativeTitle(): void {
    const title = this.getDisplayText();
    const leaf = this.leaf as WorkspaceLeaf & { updateHeader?: () => void };
    leaf.updateHeader?.();

    window.requestAnimationFrame(() => {
      const leafEl = this.containerEl.closest(".workspace-leaf");
      if (leafEl instanceof HTMLElement) {
        this.setTitleTextIn(leafEl, title);
      }
      if (this.app.workspace.activeLeaf === this.leaf) {
        this.setTitleTextIn(document.body, title, true);
      }
    });
  }

  private setTitleTextIn(root: HTMLElement, title: string, activeOnly = false): void {
    const selectors = activeOnly
      ? [
          ".workspace-leaf.mod-active .view-header-title",
          ".workspace-tab-header.is-active .workspace-tab-header-inner-title",
          ".workspace-tab-header.mod-active .workspace-tab-header-inner-title",
        ]
      : [".view-header-title", ".workspace-tab-header-inner-title"];
    for (const selector of selectors) {
      for (const el of Array.from(root.querySelectorAll(selector))) {
        if (el instanceof HTMLElement) {
          el.setText(title);
          el.setAttr("title", title);
        }
      }
    }
  }

  async onOpen(): Promise<void> {
    document.addEventListener("selectionchange", this.selectionChangeHandler);
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.render();
    // 모바일: 뷰어 도구를 뷰 헤더 액션에 1회 등록 — 본문 위 우측 상단에 둥근
    // 아이콘 줄로 뜬다. PC 는 render() 가 같은 위치·모양의 플로팅 줄을 직접
    // 그린다 (renderViewerBar — 탭 타이틀 바를 꺼도 보임).
    if (Platform.isMobile) this.setupViewerToolActions();

    // ?紐? 癰궰野???삘뀲 ???紐? ?紐꾩춿疫? 揶쏅Ŋ?. ?癒?┛ 癰궰野껋럩? suppressOwnSessionEvent 嚥???쎄땁.
    this.registerEvent(
      this.store.on("session-changed", (file: string) => {
        if (file !== this.sessionFile) return;
        if (this.suppressOwnSessionEvent) return;
        void this.handleExternalChange();
      })
    );
    this.registerEvent(
      this.store.on("session-deleted", (file: string) => {
        if (file !== this.sessionFile) return;
        this.handleDeletedSession();
      })
    );
    this.registerEvent(
      this.store.on("session-translations-changed", (file: string) => {
        if (file !== this.sessionFile) return;
        if (this.suppressOwnTranslationsEvent) return;
        void this.handleExternalTranslationsChange();
      })
    );
    this.registerEvent(
      this.store.on("session-illustrations-changed", (file: string) => {
        if (file !== this.sessionFile) return;
        if (this.suppressOwnIllustrationsEvent) return;
        void this.refreshIllustrations();
      })
    );

    // ??뺢돌?귐딆궎 筌롫??(??已??紐껉퐬??筌앸Þ爰쇽㎕?섎┛) 癰궰野?????삳쐭筌???쇰뻻 域밸챶??
    this.registerEvent(
      this.store.on("scenarios-changed", () => {
        void this.refreshScenario();
      })
    );
    this.registerEvent(
      this.store.on("user-profile-changed", () => {
        void this.handleMacroContextChanged();
      })
    );
    // 요약 앵커 변경 → 본문 {{summary}} 매크로 표시 갱신.
    this.registerEvent(
      this.store.on("session-summaries-changed", (file: string) => {
        if (file !== this.sessionFile) return;
        void this.handleMacroContextChanged();
      })
    );
    this.registerDomEvent(window, "focus", () => void this.handleExternalChange());

    // 모바일 소프트키보드가 뜨거나 움직이면(뷰포트 기하 변화) 편집 중인 커서가 키보드에
    // 가릴 수 있다. visualViewport 기준으로 커서를 딱 키보드 위로만 올려준다.
    const vv = window.visualViewport;
    if (vv) {
      const onVv = () => this.scheduleKeepCaretVisible();
      vv.addEventListener("resize", onVv);
      vv.addEventListener("scroll", onVv);
      this.register(() => {
        vv.removeEventListener("resize", onVv);
        vv.removeEventListener("scroll", onVv);
      });
    }
  }

  private async refreshScenario(): Promise<void> {
    if (this.deferWhileComposing("scenario", () => void this.refreshScenario())) {
      return;
    }
    await this.commitPending();
    await this.resolveScenario();
    await this.refreshMacroContext();
    this.redrawBodyPreservingCaret();
    this.refreshNativeTitle();
  }

  async onClose(): Promise<void> {
    document.removeEventListener(
      "selectionchange",
      this.selectionChangeHandler
    );
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    if (this.selectionUiTimer != null) {
      window.clearTimeout(this.selectionUiTimer);
      this.selectionUiTimer = null;
    }
    if (this.recenterTimer != null) {
      window.clearTimeout(this.recenterTimer);
      this.recenterTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.viewStylePopover?.close();
    this.viewStylePopover = null;
    if (this.anchorCaptureRaf != null) {
      window.cancelAnimationFrame(this.anchorCaptureRaf);
      this.anchorCaptureRaf = null;
    }
    if (this.keepCaretRaf != null) {
      window.cancelAnimationFrame(this.keepCaretRaf);
      this.keepCaretRaf = null;
    }
    if (this.syncRafId != null) {
      window.cancelAnimationFrame(this.syncRafId);
      this.syncRafId = null;
    }
    this.flushScrollSave();
    this.flushTranslationEdits();
    await this.commitPending();
  }

  // --- load / render ---

  private async loadSession(): Promise<void> {
    this.pendingDiff = null;
    this.redoStack = [];
    this.clearIdleTimer();
    this.pendingAnchorRestore = null;
    this.restoreTarget = null;
    this.lastAnchor = null;

    if (!this.sessionFile) {
      this.session = null;
      this.cachedScenario = null;
      this.translations = null;
      this.translationViewActive = false;
      return;
    }
    // 재실행/세션 전환 시 마지막 읽던 노드 위치 복원 준비 (render 끝에서 적용).
    this.pendingAnchorRestore = this.plugin.getSessionAnchor(this.sessionFile);
    this.lastAnchor = this.pendingAnchorRestore;
    this.followTail = false;
    this.chainScroll = this.plugin.data.translationScrollChain !== false;
    this.session = await this.store.getSession(this.sessionFile);
    this.translations = await this.store.getSessionTranslations(this.sessionFile);
    this.illustrations = await this.store.getSessionIllustrations(this.sessionFile);
    this.translationViewActive = this.translations.displayMode === "translation";
    this.outputMode = this.session?.meta.translation?.output ?? "replace";
    this.splitRatio = this.plugin.data.translationSplitRatio ?? 0.5;
    await this.resolveScenario();
    await this.refreshMacroContext();
    if (this.session) {
      this.baselineSpans = buildSpans(this.session);
      this.baselineText = spansToText(this.baselineSpans);
      this.refreshDisplayBaseline();
    }
  }

  /** ?紐꾨????곷립 ??뺢돌?귐딆궎 ?怨쀬뵠???紐껉퐬????已? ??store ?癒?퐣 筌≪뼚釉?筌?Ŋ?? */
  private async resolveScenario(): Promise<void> {
    this.cachedScenario = null;
    if (!this.sessionFile) return;
    const scenarioFile = scenarioFileOfSessionFile(this.sessionFile);
    if (!scenarioFile) return;
    const list = await this.store.getScenarios();
    this.cachedScenario =
      list.find((i) => i.scenarioFile === scenarioFile) ?? null;
    this.refreshNativeTitle();
  }

  private async refreshMacroContext(): Promise<void> {
    const { profile: user } = await this.plugin.resolveActiveUserProfile();
    const scenario = this.cachedScenario?.scenario.data;
    // {{summary}} 표시용 — 활성 경로 위 요약 앵커 합성 (전송본과 같은 합성 로직).
    let summaryContext = "";
    if (this.session && this.sessionFile) {
      try {
        const summaries = await this.store.getSessionSummaries(this.sessionFile);
        summaryContext = composeSummaryContext(
          collectAnchorChain(this.session, summaries)
        );
      } catch {
        // 요약 없이 진행
      }
    }
    this.displayMacroCtx = {
      char: scenario?.name ?? "(unknown)",
      user: user.name || "User",
      scenario: (scenario as any)?.scenario,
      description: (scenario as any)?.description,
      personality: (scenario as any)?.personality,
      first_message: (scenario as any)?.first_mes,
      charFirstMessage: (scenario as any)?.first_mes,
      example_dialogue: (scenario as any)?.mes_example,
      mesExamples: (scenario as any)?.mes_example,
      mesExamplesRaw: (scenario as any)?.mes_example,
      persona: user.description,
      system: (scenario as any)?.system_prompt,
      summary: summaryContext || undefined,
      charPrompt: (scenario as any)?.system_prompt,
      charInstruction: (scenario as any)?.post_history_instructions,
      charDepthPrompt: (scenario as any)?.extensions?.depth_prompt,
      charCreatorNotes: (scenario as any)?.creator_notes,
      charVersion: (scenario as any)?.character_version,
    };
  }

  private refreshDisplayBaseline(): void {
    this.displayRender = renderMacrosWithMap(
      this.baselineText,
      this.displayMacroCtx
    );
    this.displayText = this.displayRender.text;
    this.displaySpans = [];
    let rawOffset = 0;
    for (const span of this.baselineSpans) {
      const rawEnd = rawOffset + span.text.length;
      const displayFrom = this.rawOffsetToDisplayOffset(rawOffset);
      const displayTo = this.rawOffsetToDisplayOffset(rawEnd);
      const text = this.displayText.slice(displayFrom, displayTo);
      if (text.length > 0) this.displaySpans.push({ author: span.author, text });
      rawOffset = rawEnd;
    }
  }

  /**
   * 전역 IME 조합 중이면 배경 갱신을 조합 종료 뒤로 미룬다 (키별 코얼레싱).
   * 조합 중 본문 DOM/문서 선택영역을 건드리면 그 조합이 통째로 얼어붙는
   * "입력 마비"가 난다 (2026-07-06 사고, 회귀 금지 — edit-guard.ts 참조).
   * true = 미뤄짐(호출부는 즉시 return).
   */
  private imeDeferredKeys = new Set<string>();
  private deferWhileComposing(key: string, run: () => void): boolean {
    if (!isImeComposing()) return false;
    if (!this.imeDeferredKeys.has(key)) {
      this.imeDeferredKeys.add(key);
      runWhenImeIdle(() => {
        this.imeDeferredKeys.delete(key);
        run();
      });
    }
    return true;
  }

  private async handleMacroContextChanged(): Promise<void> {
    if (!this.session) return;
    if (
      this.deferWhileComposing("macro", () => void this.handleMacroContextChanged())
    ) {
      return;
    }
    await this.commitPending();
    await this.refreshMacroContext();
    this.redrawBodyPreservingCaret();
  }

  /** ?紐??癒?퐣 session.json ??獄쏅뗀??野껋럩????pending ?癒?┛ ??store ?????+ ?袁⑷퍥 ????? */
  private async handleExternalChange(): Promise<void> {
    if (!this.sessionFile) return;
    // 생성(스트리밍) 중에는 본문 소유권이 생성 플로우에 있다 — 외부발 전체 재구성은
    // 건너뛰고 생성 종료 시 rebuildBaselineAndRender 가 한 번에 반영한다.
    // (재구성이 스트리밍 tail 을 지워 중복 렌더되는 것을 막는다.)
    if (this.generation) return;
    // 어딘가에서(우측 메모리/작가노트, 편집기, 이 뷰 자신 포함) 한글 조합 중이면
    // 조합 종료 뒤로 미룬다 — 배경 본문 손질이 그 조합을 얼려버린다 (입력 마비).
    if (
      this.deferWhileComposing("external", () => void this.handleExternalChange())
    ) {
      return;
    }
    // refreshSession 은 같은 객체를 제자리 갱신한다. 분기 패널 등 다른 뷰가
    // session.meta.activeLeafId 를 직접 바꾼 뒤 saveSession 하면, 이 핸들러가
    // 실행될 때쯤 session 객체는 이미 새 값으로 덮여 있다. 따라서 갱신 전후의
    // sessionTextKey 를 비교하면 항상 같다고 나와 본문이 갱신되지 않는다.
    // 대신 "현재 화면에 실제로 그려진 텍스트"와 "갱신 후 그려져야 할 텍스트"를
    // 직접 비교한다.
    const prevBaselineText = this.baselineText;
    const prevActiveLeafId = this.session?.meta.activeLeafId ?? null;
    const nextSession = await this.store.refreshSession(this.sessionFile);
    if (!nextSession) return;
    this.session = nextSession;

    const textUnchanged =
      prevActiveLeafId !== null &&
      nextSession.meta.activeLeafId === prevActiveLeafId &&
      spansToText(buildSpans(nextSession)) === prevBaselineText;
    if (textUnchanged) {
      const nextMode = this.session.meta.translation?.output ?? "replace";
      if (nextMode !== this.outputMode) {
        // 출력 방식 전환 시 보던 노드를 새 레이아웃에 이어준다.
        const anchor = this.currentAnchor();
        this.outputMode = nextMode;
        this.applyDisplayMode();
        if (anchor) this.restoreToAnchor(anchor);
      }
      this.updateToolbar();
      // 삽화 사용/출력 위치 등 설정 변경 반영.
      this.renderInlineIllustrations();
      return;
    }

    if (this.pendingDiff) {
      new Notice("?紐? 癰궰野?揶쏅Ŋ? ??筌욊쑵六?餓λ쵐????紐꾩춿???癒?┛??몃빍??");
    }
    this.pendingDiff = null;
    this.clearIdleTimer();
    const shouldRestoreCaret = this.isBodyActive();
    const caret = shouldRestoreCaret ? this.getCaretOffset() : 0;
    await this.refreshMacroContext();
    this.baselineSpans = buildSpans(this.session);
    this.baselineText = spansToText(this.baselineSpans);
    this.refreshDisplayBaseline();
    this.suppressEvents = true;
    this.renderBodySpans();
    if (shouldRestoreCaret) {
      this.setCaretOffset(Math.min(caret, this.displayText.length));
      // renderBodySpans 의 body.empty() 로 contenteditable DOM 포커스가 풀린다 —
      // caret(Selection) 만 복원하면 다음 입력이 씹히므로 포커스도 되돌린다
      // (redrawBodyPreservingCaret 과 동일).
      this.bodyEl?.focus({ preventScroll: true });
    }
    this.suppressEvents = false;
    this.updateToolbar();
    this.outputMode = this.session.meta.translation?.output ?? "replace";
    this.applyDisplayMode();
    // 편집 중(caret 복원)이 아니면 보던 노드 위치를 이어준다 — 외부 변경으로
    // 본문이 재구성돼도 읽던 자리가 유지되게.
    if (!shouldRestoreCaret && this.lastAnchor) {
      this.restoreToAnchor(this.lastAnchor);
    }
  }

  /** 외부(다른 view/편집기)에서 media.json 이 바뀌면 번역 보기 상태/블록을 갱신. */
  private async handleExternalTranslationsChange(): Promise<void> {
    if (!this.sessionFile) return;
    if (
      this.deferWhileComposing("translations", () =>
        void this.handleExternalTranslationsChange()
      )
    ) {
      return;
    }
    this.translations = await this.store.getSessionTranslations(this.sessionFile);
    const nextActive = this.translations.displayMode === "translation";
    // 보기 상태가 실제로 바뀔 때만 보던 노드를 이어준다 (같은 모드 재렌더는 픽셀 보존).
    const modeChanged = nextActive !== this.translationViewActive;
    const anchor = modeChanged ? this.currentAnchor() : null;
    if (modeChanged) {
      if (!nextActive || !this.generation) {
        await this.commitPending();
        this.translationViewActive = nextActive;
      }
    }
    this.applyDisplayMode();
    if (anchor) this.restoreToAnchor(anchor);
  }

  private handleDeletedSession(): void {
    this.pendingDiff = null;
    this.redoStack = [];
    this.clearIdleTimer();
    this.lastAnchor = null;
    this.restoreTarget = null;
    this.followTail = false;
    this.sessionFile = null;
    this.plugin.rememberActiveSessionFile(null);
    this.session = null;
    this.cachedScenario = null;
    this.translations = null;
    this.translationViewActive = false;
    this.translating = false;
    this.illustrations = null;
    this.illustrating = false;
    this.paraSelectMode = false;
    this.clearTranslationBlocks();
    this.baselineSpans = [];
    this.baselineText = "";
    this.displaySpans = [];
    this.displayText = "";
    this.displayRender = { text: "", displayToRaw: [0], macroRanges: [] };
    this.generation?.abort.abort();
    this.generation = null;
    // 세션(또는 시나리오)이 삭제되면 빈 안내 대신 대시보드로 전환한다.
    void this.leaf.setViewState({
      type: VIEW_TYPE_DASHBOARD,
      active: true,
      state: { stellaPanel: this.stellaPanel },
    });
  }

  /** 로비(대시보드)로 — 미저장 본문 편집을 커밋한 뒤 같은 탭에서 전환. */
  private async goToLobby(): Promise<void> {
    await this.flushPendingEdits();
    await this.leaf.setViewState({
      type: VIEW_TYPE_DASHBOARD,
      active: true,
      state: { stellaPanel: this.stellaPanel },
    });
  }

  /**
   * 3???닌듼?
   *   [header]   ?⑥쥙?? ??뺢돌?귐딆궎 ?紐껉퐬????已?+ ?紐꾨???已?+ ?類ｋ궖 + 筌앸Þ爰쇽㎕?섎┛.
   *   [body-wrap] flex:1, ??쎄쾿嚥??怨몃열. ?????contenteditable body.
   *   [toolbar]  ?⑥쥙?? ??undo/redo/end) / 餓???곷선?怨뚮┛ ??甕곌쑵?? / ??regen/?類ㅼ젫/?????뺤뺍/??쇱젟).
   */
  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ggai-stella-session");
    // 일반 Obsidian 테마가 편집창 본문(배경 등)으로 스타일링하도록 기본 편집창 클래스 부여.
    root.addClass("markdown-source-view");
    this.bodyWrapEl = null;
    this.bodyEl = null;
    this.toolbarEl = null;
    this.translationEl = null;
    this.splitHandleEl = null;
    this.inlineIllusEls = [];
    this.paraSelectMode = false;
    this.clearTranslationBlocks();

    if (!this.sessionFile) {
      root.createEl("div", {
        cls: "ggai-session-placeholder",
        text: "Open a Stella session to start.",
      });
      return;
    }
    if (!this.session) {
      root.createEl("div", {
        cls: "ggai-session-placeholder",
        text: "Session file not found: " + this.sessionFile,
      });
      return;
    }

    // 뷰어 도구(원문·번역 전환/일괄 번역/번역 되돌리기/갤러리/로비) —
    // 모바일 = 뷰 헤더 액션(본문 위 우측 상단, setupViewerToolActions) /
    // PC = 같은 위치·모양의 플로팅 줄(renderViewerBar, 0높이 레이어).
    if (!Platform.isMobile) this.renderViewerBar(root);
    this.bodyWrapEl = root.createEl("div", { cls: "ggai-session-body-wrap" });
    this.viewStyle = this.plugin.getViewStyle();
    this.applyViewStyle();
    this.bodyWrapEl.addEventListener("scroll", () => this.onBodyScroll());
    // 문단 선택 모드(문단 재생성): 캡처 단계에서 클릭을 가로채 문단 매핑.
    // mousedown 도 막아 caret 이동/편집 진입을 방지한다.
    this.bodyWrapEl.addEventListener(
      "mousedown",
      (e) => {
        if (this.paraSelectMode) e.preventDefault();
      },
      { capture: true }
    );
    this.bodyWrapEl.addEventListener(
      "click",
      (e) => this.onParaSelectClick(e),
      { capture: true }
    );
    const body = this.bodyWrapEl.createEl("div", { cls: "ggai-session-body" });
    body.setAttr("contenteditable", "plaintext-only");
    body.setAttr("spellcheck", "false");
    this.bodyEl = body;
    this.renderBodySpans();
    body.addEventListener("input", () => this.onBodyInput());
    body.addEventListener("blur", () => void this.commitPending());
    body.addEventListener("keydown", (e) => this.onKeydown(e));
    // IME(한글) 조합 중에는 커밋/재구성을 미룬다 — 조합 끝나면 밀린 편집을 반영.
    body.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    body.addEventListener("compositionend", () => {
      this.composing = false;
      if (this.suppressEvents) return;
      this.syncPendingDiff();
      this.scheduleIdleCommit();
    });
    // split 모드에선 본문 패널(bodyEl) 자체가 스크롤한다.
    body.addEventListener("scroll", () => {
      this.onBodyScroll();
      this.onSplitPanelScroll("body");
    });

    this.translationEl = this.bodyWrapEl.createEl("div", {
      cls: "ggai-session-translation",
    });
    // split 모드에선 번역 패널도 독립 스크롤 — 스크롤 체인 소스.
    this.translationEl.addEventListener("scroll", () =>
      this.onSplitPanelScroll("translation")
    );

    // 창/패널 크기 변화 감지: 숨김(높이 0) 상태에서 무효가 된 복원을 크기가 잡히는
    // 순간 재시도하고, 이미 읽는 중이면 보던 노드를 다시 화면 중앙에 맞춘다.
    // wrap(뷰포트)만 관찰 — 본문(bodyEl)은 타이핑/스트리밍으로 내용 높이가 계속
    // 변해 편집 흐름과 스크롤이 싸우게 되므로 관찰하지 않는다.
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.onViewportResized());
    this.resizeObserver.observe(this.bodyWrapEl);
    this.resizeObserver.observe(this.contentEl);

    this.toolbarEl = root.createEl("div", { cls: "ggai-session-toolbar" });
    this.renderToolbarContent();

    this.applyDisplayMode();
    this.updateToolbar();
    // 저장된 노드 위치가 있으면 거기로, 없으면 마지막(끝)으로.
    // 레이아웃이 아직 없으면(재시작 직후/백그라운드 탭) restoreTarget 으로 보류되고
    // ResizeObserver 가 크기가 잡히는 순간 재시도한다 — 맨 위 방치 금지.
    this.restoreTarget = this.pendingAnchorRestore ?? "end";
    this.pendingAnchorRestore = null;
    this.attemptRestore();
  }

  private renderToolbarContent(): void {
    const toolbar = this.toolbarEl;
    if (!toolbar) return;
    toolbar.empty();

    // ?ル슣瑜? ??쀪쉘 ???? / ??쀪쉘 ???? / 筌띾뜆?筌??紐껊굡 ?癒곕늄(??
    const left = toolbar.createEl("div", { cls: "ggai-toolbar-group-left" });
    const leftTop = left.createEl("div", {
      cls: "ggai-toolbar-row ggai-toolbar-row-top",
    });
    this.undoBtn = this.makeIconBtn(leftTop, "rewind", "Undo (Ctrl+Z)", () =>
      this.handleUndo()
    );
    this.undoBtn.addEventListener("mouseenter", () =>
      this.showUndoRemovalPreview()
    );
    this.undoBtn.addEventListener("mouseleave", () =>
      this.clearUndoRemovalPreview()
    );
    this.redoBtn = this.makeIconBtn(
      leftTop,
      "fast-forward",
      "Redo (Ctrl+Y)",
      () => this.handleRedo()
    );
    this.jumpEndBtn = this.makeIconBtn(
      leftTop,
      "skip-forward",
      "Jump to end",
      () => this.handleJumpEnd()
    );
    const leftBottom = left.createEl("div", {
      cls: "ggai-toolbar-row ggai-toolbar-row-bottom",
    });
    // 미디어 트리거 패널: 번역 / 삽화 / 문단 재생성.
    // 탭 = 최신 노드 생성, 꾹 = 자동 on/off (미디어 확장 스펙.md 세션 툴바 트리거 버튼 패널).
    const tBtn = leftBottom.createEl("button", {
      cls: "ggai-btn ggai-icon-btn ggai-media-trigger-btn",
    });
    setIcon(tBtn, "languages");
    tBtn.setAttr("aria-label", "번역 (꾹: 자동 번역 on/off)");
    tBtn.setAttr("data-tooltip-position", "top");
    attachLongPress(tBtn, {
      onTap: () => void this.handleTranslateTap(),
      onLongPress: () => void this.handleAutoTranslateToggle(),
    });
    this.translateBtn = tBtn;

    const iBtn = leftBottom.createEl("button", {
      cls: "ggai-btn ggai-icon-btn ggai-media-trigger-btn",
    });
    setIcon(iBtn, "image");
    iBtn.setAttr("aria-label", "삽화 (꾹: 자동 삽화 on/off)");
    iBtn.setAttr("data-tooltip-position", "top");
    attachLongPress(iBtn, {
      onTap: () => void this.handleIllustrateTap(),
      onLongPress: () => void this.handleAutoIllustrateToggle(),
    });
    this.illustrationBtn = iBtn;

    const pBtn = leftBottom.createEl("button", {
      cls: "ggai-btn ggai-icon-btn ggai-media-trigger-btn",
    });
    setIcon(pBtn, "wand-2");
    pBtn.setAttr("aria-label", "문단 재생성 — 문단 선택 모드");
    pBtn.setAttr("data-tooltip-position", "top");
    pBtn.addEventListener("click", () => void this.toggleParaSelectMode());
    this.paraRegenBtn = pBtn;

    // 餓λ쵐釉? ??곷선?怨뚮┛ (??CTA)
    const center = toolbar.createEl("div", {
      cls: "ggai-toolbar-group-center",
    });
    const cont = center.createEl("button", {
      cls: "ggai-btn ggai-cta-btn",
    });
    setIcon(cont, "play");
    cont.setAttr("aria-label", "Continue generation");
    cont.setAttr("data-tooltip-position", "top");
    cont.addEventListener("click", () => void this.handleContinueOrStop());
    this.continueBtn = cont;

    // ?怨쀫?: ??源??/ ?類ㅼ젫 nav / ??쇱젟 / ?????뺤뺍
    const right = toolbar.createEl("div", { cls: "ggai-toolbar-group-right" });
    const rightTop = right.createEl("div", {
      cls: "ggai-toolbar-row ggai-toolbar-row-top",
    });
    this.regenBtn = this.makeIconBtn(
      rightTop,
      "refresh-cw",
      "Regenerate branch",
      () => this.handleRegen()
    );
    // 재생성도 현재 노드의 생성분을 새로 교체하므로, 호버 시 사라질(교체될) 구간을
    // undo 와 동일하게 미리 강조해 준다.
    this.regenBtn.addEventListener("mouseenter", () =>
      this.showUndoRemovalPreview()
    );
    this.regenBtn.addEventListener("mouseleave", () =>
      this.clearUndoRemovalPreview()
    );
    this.prevSibBtn = this.makeIconBtn(
      rightTop,
      "chevron-left",
      "Previous branch",
      () => this.handleSiblingNav(-1)
    );
    this.siblingIndicator = rightTop.createEl("span", {
      cls: "ggai-sibling-indicator",
      text: "1/1",
    });
    this.nextSibBtn = this.makeIconBtn(
      rightTop,
      "chevron-right",
      "Next branch",
      () => this.handleSiblingNav(1)
    );
    const rightBottom = right.createEl("div", {
      cls: "ggai-toolbar-row ggai-toolbar-row-bottom",
    });
    this.nodeFavBtn = this.makeIconBtn(
      rightBottom,
      "save",
      "Quick save this point",
      () => this.handleNodeFavorite()
    );
    this.viewStyleBtn = this.makeIconBtn(
      rightBottom,
      "sliders-horizontal",
      "보기 스타일",
      () => this.handleViewStyle()
    );
    this.sidePanelBtn = this.makeIconBtn(
      rightBottom,
      "panel-right",
      "Details panel",
      () => this.handleSidePanel()
    );
  }

  /** ?袁⑹뵠??甕곌쑵?????? setIcon ?紐꾪뀱 + aria-label + click ?紐껊굶?? */
  private makeIconBtn(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLButtonElement {
    const btn = parent.createEl("button", { cls: "ggai-btn ggai-icon-btn" });
    setIcon(btn, icon);
    btn.setAttr("aria-label", label);
    // 하단 툴바 버튼 — 설명이 아래로 뜨면 버튼을 가리므로 위로.
    btn.setAttr("data-tooltip-position", "top");
    btn.addEventListener("click", () => onClick());
    return btn;
  }

  /** baselineSpans ??DOM ??곗쨮 ??쇰뻻 域밸챶???(???癒????. */
  /**
   * 인라인 마크다운(**굵게**, __굵게__, *기울임*, _기울임_, `코드`) 표기를 조각(run)으로
   * 쪼갠다. 마커 문자(*, _, `)는 지우지 않고 별도 span(ggai-md-marker)으로 남겨
   * textContent 총 길이·오프셋 매핑을 그대로 보존한다 — CSS 로만 시각적으로 접는다.
   * (undo/재생성/diff 로직이 전부 문자 오프셋 기반이라 텍스트를 실제로 지우면 깨진다.)
   */
  private tokenizeMarkdownRun(
    text: string,
    baseCls: string
  ): { text: string; cls: string }[] {
    const tokens: { text: string; cls: string }[] = [];
    const re =
      /\*\*((?:[^*]|\*(?!\*))+?)\*\*|__((?:[^_]|_(?!_))+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|`([^`\n]+?)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) {
        tokens.push({ text: text.slice(last, m.index), cls: baseCls });
      }
      const full = m[0];
      const isBold = full.startsWith("**") || full.startsWith("__");
      const isCode = full.startsWith("`");
      const markerLen = isBold ? 2 : 1;
      const kindCls = isBold
        ? "ggai-md-bold"
        : isCode
          ? "ggai-md-code"
          : "ggai-md-italic";
      tokens.push({
        text: full.slice(0, markerLen),
        cls: `${baseCls} ggai-md-marker`,
      });
      tokens.push({
        text: full.slice(markerLen, full.length - markerLen),
        cls: `${baseCls} ${kindCls}`,
      });
      tokens.push({
        text: full.slice(full.length - markerLen),
        cls: `${baseCls} ggai-md-marker`,
      });
      last = re.lastIndex;
    }
    if (last < text.length) tokens.push({ text: text.slice(last), cls: baseCls });
    return tokens;
  }

  /** 마크다운 조각들을 실제 span 으로 그려 넣는다. 문단 들여쓰기 클래스는 조각 중
   * 첫 비어있지 않은 조각에만 붙인다(전체 buf 를 한 span 으로 그리던 것과 동일 위치). */
  private appendMarkdownRun(
    container: HTMLElement,
    text: string,
    baseCls: string,
    indentFirst: boolean
  ): void {
    if (text.length === 0) return;
    const tokens = this.tokenizeMarkdownRun(text, baseCls).filter(
      (t) => t.text.length > 0
    );
    tokens.forEach((t, i) => {
      const cls = indentFirst && i === 0 ? `${t.cls} ggai-para-indent` : t.cls;
      container.createEl("span", { cls, text: t.text });
    });
  }

  private renderBodySpans(highlights: BodyHighlightRange[] = []): void {
    const body = this.bodyEl;
    if (!body) return;
    const ranges = highlights
      .filter((r) => r.to > r.from)
      .sort((a, b) => a.from - b.from);

    body.empty();
    // 전체 재렌더가 스트리밍 tail 컨테이너까지 지웠으니 참조를 놓는다.
    this.streamTailEl = null;
    let offset = 0;
    // 보기 스타일(문단 간격/들여쓰기)용 렌더 상태 — 청크(span/highlight) 경계를 넘어
    // 문서 전체에서 이어진다. 각 줄바꿈("\n")을 문단 경계로 본다:
    //  - "\n" 문자는 ggai-para-gap span 으로 감싸 그 줄의 line-height 만 키운다 → 문단 사이
    //    간격. 문단 안 줄바꿈이 없는 산문에서 매 Enter 가 문단 구분이 되도록 매 "\n" 적용.
    //  - 줄 시작 첫 텍스트 span 에 ggai-para-indent 클래스 → 첫 줄 들여쓰기(빈 span 은
    //    contenteditable 에서 사라지므로 실제 텍스트 span 에 padding-left 를 준다).
    // 어느 것도 textContent 를 바꾸지 않아 offset 매핑은 그대로 유지된다.
    let indentNext = true;
    for (const s of this.displaySpans) {
      if (s.text.length === 0) continue;
      const spanStart = offset;
      const spanEnd = spanStart + s.text.length;
      let local = 0;

      while (local < s.text.length) {
        const absolute = spanStart + local;
        const activeRange = ranges.find(
          (r) => r.from <= absolute && absolute < r.to
        );
        const nextRange = activeRange
          ? null
          : ranges.find((r) => r.from > absolute && r.from < spanEnd);
        const nextAbsolute = activeRange
          ? Math.min(spanEnd, activeRange.to)
          : nextRange
            ? nextRange.from
            : spanEnd;
        const text = s.text.slice(local, nextAbsolute - spanStart);
        const authorClass = s.author === "ai" ? "ggai-span-ai" : "ggai-span-user";
        const cls = activeRange
          ? `${authorClass} ${activeRange.className}`
          : authorClass;

        let buf = "";
        const flush = () => {
          if (buf.length === 0) return;
          this.appendMarkdownRun(body, buf, cls, indentNext);
          indentNext = false;
          buf = "";
        };
        for (const ch of text) {
          if (ch === "\n") {
            flush();
            body.createEl("span", { cls: `ggai-para-gap ${cls}`, text: "\n" });
            indentNext = true;
          } else {
            buf += ch;
          }
        }
        flush();
        local = nextAbsolute - spanStart;
      }

      offset = spanEnd;
    }
    // 본문을 새로 그렸으니 인라인 삽화도 다시 꽂는다.
    this.renderInlineIllustrations();
    this.renderAiStartMarker();
  }

  /**
   * 생성(스트리밍) 전용 경량 렌더. 고정된 앞부분(renderBodySpans 로 이미 그려짐)은
   * 건드리지 않고, 본문 끝에 append 되는 생성 텍스트만 전용 컨테이너에 다시 그린다.
   * 세션 전체 길이와 무관하게 생성 텍스트 길이에만 비례하므로 긴 세션에서도 멈추지 않는다.
   * 앵커 스킵으로 표시량이 되돌아가는 경우도 매번 tail 전체를 다시 그려 정확히 반영한다.
   * baselineText/offset 매핑 등 전체 상태는 생성 종료 시 rebuildBaselineAndRender 가 한 번 맞춘다.
   */
  private renderStreamingTail(tailText: string): void {
    const body = this.bodyEl;
    if (!body) return;
    if (!this.streamTailEl || this.streamTailEl.parentElement !== body) {
      // 경계 들여쓰기 상태 = 고정 앞부분이 문단을 끝냈는지(빈 본문/줄바꿈 끝이면 들여쓰기).
      this.streamTailIndentNext =
        this.displayText.length === 0 || this.displayText.endsWith("\n");
      this.streamTailEl = body.createEl("span", { cls: "ggai-stream-tail" });
    }
    const container = this.streamTailEl;
    container.empty();
    const cls = "ggai-span-ai";
    let indentNext = this.streamTailIndentNext;
    let buf = "";
    const flush = () => {
      if (buf.length === 0) return;
      this.appendMarkdownRun(container, buf, cls, indentNext);
      indentNext = false;
      buf = "";
    };
    for (const ch of tailText) {
      if (ch === "\n") {
        flush();
        container.createEl("span", { cls: `ggai-para-gap ${cls}`, text: "\n" });
        indentNext = true;
      } else {
        buf += ch;
      }
    }
    flush();
  }

  private scrollBodyToEnd(): void {
    this.scrollAfterLayout((scroller) => {
      scroller.scrollTop = scroller.scrollHeight;
    });
  }

  /** 저장된 노드 앵커로 복원(보던 노드를 화면 중앙에). 노드가 사라졌으면 끝으로. */
  private restoreToAnchor(anchor: SessionScrollAnchor): void {
    if (!this.session) return;
    this.lastAnchor = anchor;
    const raw = nodeAnchorToOffset(this.session, anchor);
    if (raw == null) {
      this.scrollBodyToEnd();
      return;
    }
    this.scrollAfterLayout((scroller) =>
      this.scrollRawOffsetToCenter(scroller, raw)
    );
  }

  /** render 복원 목표 적용 — 레이아웃이 아직 없으면 보류(ResizeObserver 가 재시도). */
  private attemptRestore(): void {
    const scroller = this.activeScroller();
    if (!scroller || scroller.clientHeight === 0) return;
    // 삽화 포커스 요청이 있으면 기본 앵커 복원보다 우선한다.
    if (this.pendingIllustrationFocus) {
      const nodeId = this.pendingIllustrationFocus;
      this.pendingIllustrationFocus = null;
      this.restoreTarget = null;
      this.applyIllustrationFocus(nodeId, scroller);
      return;
    }
    const target = this.restoreTarget;
    if (!target) return;
    this.restoreTarget = null;
    if (target === "end") this.scrollBodyToEnd();
    else this.restoreToAnchor(target);
  }

  /** 갤러리 이동 — 이 노드의 인라인 삽화 위젯을 화면 중앙으로. render 후/이미 열린 세션 공용. */
  private focusIllustrationNode(nodeId: string): void {
    this.pendingIllustrationFocus = nodeId;
    this.attemptRestore();
  }

  /** 삽화 위젯이 DOM 에 있으면 중앙으로, 없으면(출력 뷰 모드 등) 그 노드 위치로. */
  private applyIllustrationFocus(nodeId: string, scroller: HTMLElement): void {
    if (!this.session || !this.session.nodes[nodeId]) return;
    this.lastAnchor = { nodeId, charInNode: 0 };

    const centerWidget = (widget: HTMLElement): void => {
      const center = () =>
        widget.scrollIntoView({ block: "center", behavior: "auto" });
      center();
      // 이미지가 아직 로드 전이면 위젯 높이가 0이라 스크롤이 어긋난다(=노드에 멈춘 것처럼
      // 보임). 이미지가 실제 크기를 얻는 순간·안정 후 다시 중앙으로 맞춘다.
      const img = widget.querySelector("img");
      if (img && !img.complete) {
        img.addEventListener("load", center, { once: true });
        img.addEventListener("error", center, { once: true });
      }
      window.setTimeout(center, 150);
    };

    const findWidget = (): HTMLElement | undefined =>
      this.inlineIllusEls.find((el) => el.dataset.illustNode === nodeId);

    const immediate = findWidget();
    if (immediate) {
      centerWidget(immediate);
      return;
    }
    // 위젯이 아직 안 그려졌을 수 있다(렌더 순서). 몇 프레임 재시도 후, 끝내 없으면
    // (출력 뷰 모드 등 인라인 위젯이 아예 없으면) 노드 위치로 폴백.
    let tries = 0;
    const retry = () => {
      const widget = findWidget();
      if (widget) {
        centerWidget(widget);
        return;
      }
      if (++tries < 6) {
        window.setTimeout(retry, 60);
        return;
      }
      if (!this.session) return;
      const raw = nodeAnchorToOffset(this.session, { nodeId, charInNode: 0 });
      if (raw != null) this.scrollRawOffsetToCenter(scroller, raw);
    };
    window.setTimeout(retry, 60);
  }

  /** 본문 영역 크기 변화 — 픽셀 스크롤은 어긋나므로 보던 노드 기준으로 다시 맞춘다. */
  private onViewportResized(): void {
    // 초기 복원 대기(레이아웃 높이 0 → 크기 잡히는 순간)는 storm 이 아니다 — 즉시 재시도.
    if (this.restoreTarget) {
      this.attemptRestore();
      return;
    }
    // 편집 중(본문/번역 편집칸 포커스)에는 스크롤에 일절 개입하지 않는다. 모바일
    // 소프트키보드로 뷰포트가 줄면 여기가 도는데, 보던 노드로 재중앙하면 브라우저가
    // caret 을 맞춰 둔 스크롤을 빼앗아 "타이핑 지점보다 위"로 끌어올려 버린다. 편집
    // 중엔 브라우저의 caret 추적에 그대로 맡긴다.
    if (this.isEditingFocused()) return;
    // 모바일 사이드바 슬라이드/데스크톱 분할 드래그 중에는 매 프레임 발동한다. 여기서
    // DOM 을 읽으면(clientHeight 등) 강제 리플로우가 일어나 긴 세션에서 프레임마다 전체
    // 레이아웃이 돌아 버벅인다. storm 동안에는 (1) 본문 폭을 현재 픽셀로 고정해 긴 글의
    // 줄바꿈 재계산 자체를 막고 (2) 아무것도 읽지 않는다. 멎은 뒤 한 번만 폭을 풀고
    // 삽화 높이/보던 노드 재중앙을 처리한다.
    if (this.recenterTimer == null) this.lockBodyWidthForResize();
    else window.clearTimeout(this.recenterTimer);
    this.recenterTimer = window.setTimeout(() => {
      this.recenterTimer = null;
      this.onResizeSettled();
    }, 150);
  }

  /** storm 시작 — 본문/번역 패널 폭을 현재 픽셀로 고정(매 프레임 줄바꿈 재계산 방지). */
  private lockBodyWidthForResize(): void {
    for (const el of [this.bodyEl, this.translationEl]) {
      if (!el) continue;
      const w = el.getBoundingClientRect().width;
      if (w <= 0) continue; // 숨김(display:none) 패널은 고정 불필요.
      el.style.width = `${w}px`;
      el.style.maxWidth = "none";
      // split 모드는 flex-basis(%) 가 폭을 정하므로 픽셀로 함께 고정.
      if (this.outputMode === "split-h") el.style.flexBasis = `${w}px`;
      this.widthLockedEls.push(el);
    }
  }

  /** 크기 변화가 멎음 — 폭 고정을 풀고(리플로우 1회) 삽화 높이/보던 노드 재중앙. */
  private onResizeSettled(): void {
    for (const el of this.widthLockedEls) {
      el.style.width = "";
      el.style.maxWidth = "";
      el.style.flexBasis = "";
    }
    this.widthLockedEls = [];
    if (this.outputMode === "split-h") this.applySplitRatio();
    const scroller = this.activeScroller();
    if (!scroller || scroller.clientHeight === 0) return;
    if (this.generation) {
      this.scrollTailIfFollowing();
      return;
    }
    // 모바일 소프트키보드가 뜨면 뷰포트가 줄며 이 핸들러가 돈다. 이때 보던 노드를
    // 재중앙하면 브라우저가 이미 caret 을 맞춰 놓은 스크롤을 빼앗아 "타이핑 지점보다
    // 위"로 끌어올려 버린다. 편집 중(본문/번역 편집칸에 포커스)이면 재중앙하지 않고
    // 브라우저의 caret 추적에 맡긴다.
    if (this.isEditingFocused()) return;
    if (this.lastAnchor) this.restoreToAnchor(this.lastAnchor);
  }

  /** 이 뷰의 편집칸(본문/번역)에 포커스가 있는가 — 소프트키보드가 떠 있는 상태 판정. */
  private isEditingFocused(): boolean {
    const active = document.activeElement;
    if (!active) return false;
    return active === this.bodyEl || active === this.translationEditEl;
  }

  private scheduleKeepCaretVisible(): void {
    if (this.keepCaretRaf != null) return;
    this.keepCaretRaf = window.requestAnimationFrame(() => {
      this.keepCaretRaf = null;
      this.keepCaretVisible();
    });
  }

  /**
   * 편집 중 커서가 소프트키보드에 가리면 딱 키보드 위로만 스크롤한다. visualViewport 의
   * 실제 보이는 영역(offsetTop~height)으로 판정하므로 옵시디언이 레이아웃을 줄이든(resize)
   * 키보드를 덮어 그리든(overlay) 똑같이 동작하고, 키보드가 없으면 가릴 일이 없어 no-op.
   * 앵커 재중앙과 달리 "보던 위치"가 아니라 "커서"를 기준으로 최소한만 움직인다.
   */
  private keepCaretVisible(): void {
    if (!this.isEditingFocused()) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const scroller = this.caretScroller();
    if (!scroller) return;
    const rect = this.caretClientRect();
    if (!rect) return;
    const margin = 24;
    const visibleTop = vv.offsetTop;
    const visibleBottom = vv.offsetTop + vv.height;
    if (rect.bottom > visibleBottom - margin) {
      scroller.scrollTop += rect.bottom - (visibleBottom - margin);
    } else if (rect.top < visibleTop + margin) {
      scroller.scrollTop -= visibleTop + margin - rect.top;
    }
  }

  /** 포커스된 편집칸을 담은 스크롤 컨테이너. split-h 의 번역칸은 translationEl 자체가 스크롤. */
  private caretScroller(): HTMLElement | null {
    if (document.activeElement === this.translationEditEl) {
      return this.outputMode === "split-h" ? this.translationEl : this.bodyWrapEl;
    }
    return this.activeScroller();
  }

  /** 현재 커서(접힌 선택)의 화면 사각형. 편집칸 밖이면 null. */
  private caretClientRect(): DOMRect | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const inBody = !!this.bodyEl && this.bodyEl.contains(range.startContainer);
    const inTr =
      !!this.translationEditEl &&
      this.translationEditEl.contains(range.startContainer);
    if (!inBody && !inTr) return null;
    const rects = range.getClientRects();
    if (rects.length > 0) return rects[rects.length - 1];
    const b = range.getBoundingClientRect();
    if (b.width === 0 && b.height === 0 && b.top === 0) return null;
    return b;
  }

  /** 현재 출력 방식의 스크롤 컨테이너. split-h 는 원문 패널(bodyEl)이 스크롤한다. */
  private activeScroller(): HTMLElement | null {
    if (this.outputMode === "split-h") return this.bodyEl;
    return this.bodyWrapEl;
  }

  // --- 노드 앵커 ↔ 스크롤 위치 (픽셀이 아닌 "보던 노드" 기준) ---

  /** 현재 보고 있는 위치의 노드 앵커 (없으면 null). */
  private currentAnchor(): SessionScrollAnchor | null {
    if (!this.session) return null;
    const raw = this.currentViewRawOffset();
    if (raw == null) return null;
    return offsetToNodeAnchor(this.session, raw);
  }

  /** 활성 뷰 세로 중앙(시선 초점)에 보이는 baseline(raw) char offset. */
  private currentViewRawOffset(): number | null {
    const scroller = this.activeScroller();
    if (!scroller) return null;
    // split 은 항상 원문(좌) 패널 기준. replace 는 현재 보이는 쪽(원문/번역).
    const showingTranslation =
      this.outputMode !== "split-h" && this.translationViewActive;
    return showingTranslation
      ? this.translationRawOffsetAtCenter(scroller)
      : this.bodyRawOffsetAtCenter(scroller);
  }

  /** 번역 패널: 화면 세로 중앙에 걸친 문단 블록의 baseline 시작 offset. */
  private translationRawOffsetAtCenter(scroller: HTMLElement): number | null {
    const blocks = this.translationBlocks;
    if (blocks.length === 0) return null;
    const sRect = scroller.getBoundingClientRect();
    const cy = sRect.top + sRect.height / 2;
    for (const b of blocks) {
      if (b.el.getBoundingClientRect().bottom > cy) return b.offset;
    }
    return blocks[blocks.length - 1].offset;
  }

  /** 본문(원문) 패널: 화면 세로 중앙 글자의 display offset → raw offset. */
  private bodyRawOffsetAtCenter(scroller: HTMLElement): number | null {
    const body = this.bodyEl;
    if (!body) return null;
    const sRect = scroller.getBoundingClientRect();
    // 본문은 가운데 정렬(max-width)이라 좌측은 빈 여백 → 가운데 x 로 찍는다.
    // 시선이 머무는 세로 중앙 기준. 줄 여백에 걸릴 수 있으니 위아래로 흔들며 찾는다.
    const cx = sRect.left + sRect.width / 2;
    const cy = sRect.top + sRect.height / 2;
    for (const dy of [0, 14, -14, 30, -30, 55, -55, 90]) {
      const pos = this.caretFromPoint(cx, cy + dy);
      if (pos && body.contains(pos.node) && pos.node.nodeType === Node.TEXT_NODE) {
        return this.displayToRawOffset(this.displayOffsetOf(pos.node, pos.offset));
      }
    }
    // 폴백: 화면 중앙을 지나는 첫 자식 span 의 시작 offset.
    let acc = 0;
    for (const child of Array.from(body.childNodes)) {
      const rect =
        child instanceof HTMLElement ? child.getBoundingClientRect() : null;
      if (rect && rect.bottom > cy) {
        return this.displayToRawOffset(acc);
      }
      acc += (child.textContent ?? "").length;
    }
    // 계산 실패 — 맨 위(0)로 오판해 저장을 덮어쓰지 않도록 null.
    return null;
  }

  /**
   * raw offset 이 화면 세로 중앙에 오도록 해당 스크롤러를 이동.
   * 위치를 못 찾았을 때는 맨 위가 아니라 맨 아래로 (fallbackToEnd=false 면 유지).
   */
  private scrollRawOffsetToCenter(
    scroller: HTMLElement,
    raw: number,
    fallbackToEnd = true
  ): void {
    const showingTranslation =
      scroller === this.translationEl ||
      (scroller === this.bodyWrapEl && this.translationViewActive);
    const rect = showingTranslation
      ? this.translationRectForRawOffset(raw)
      : this.bodyRectForRawOffset(raw);
    const sRect = scroller.getBoundingClientRect();
    if (!rect || rect.height === 0) {
      if (fallbackToEnd) scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    const next =
      scroller.scrollTop + (rect.top - sRect.top) - (sRect.height - rect.height) / 2;
    scroller.scrollTop = Math.max(
      0,
      Math.min(next, scroller.scrollHeight - scroller.clientHeight)
    );
  }

  /**
   * 읽던 위치(뷰 중앙 노드)를 고정한 채 fn 을 실행한다. fn 이 본문 위쪽에 콘텐츠
   * (삽화 위젯 등)를 삽입해 높이가 늘어도 보던 지점이 화면에서 움직이지 않는다.
   * 삽화 이미지는 로드 전 높이가 0이라, 각 이미지가 로드되며 커지는 순간에도 다시
   * 맞춘다. 로드 대기 중 사용자가 직접 스크롤하면(예상값과 어긋나면) 개입을 멈춘다.
   * 생성(스트리밍) 중엔 꼬리 따라가기가 우선이므로 관여하지 않는다.
   */
  private preserveReadingPosition(fn: () => void): void {
    const scroller = this.activeScroller();
    const raw = this.generation ? null : this.currentViewRawOffset();
    fn();
    if (raw == null || !scroller) return;
    let expectedTop = -1;
    const recenter = () => {
      if (scroller.clientHeight === 0) return;
      if (expectedTop >= 0 && Math.abs(scroller.scrollTop - expectedTop) > 4) return;
      this.scrollRawOffsetToCenter(scroller, raw, false);
      expectedTop = scroller.scrollTop;
    };
    recenter();
    for (const el of this.inlineIllusEls) {
      const img = el.querySelector("img");
      if (img && !img.complete) {
        img.addEventListener("load", recenter, { once: true });
        img.addEventListener("error", recenter, { once: true });
      }
    }
  }

  private translationRectForRawOffset(raw: number): DOMRect | null {
    const blocks = this.translationBlocks;
    if (blocks.length === 0) return null;
    let target = blocks[0];
    for (const b of blocks) {
      if (b.offset <= raw) target = b;
      else break;
    }
    return target.el.getBoundingClientRect();
  }

  private bodyRectForRawOffset(raw: number): DOMRect | null {
    const display = this.rawOffsetToDisplayOffset(raw);
    return this.charRectAtDisplayOffset(display);
  }

  private caretFromPoint(
    x: number,
    y: number
  ): { node: Node; offset: number } | null {
    const doc = (this.bodyEl?.ownerDocument ?? document) as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (
        x: number,
        y: number
      ) => { offsetNode: Node; offset: number } | null;
    };
    if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(x, y);
      if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      if (p) return { node: p.offsetNode, offset: p.offset };
    }
    return null;
  }

  /** bodyEl 안에서 (node, offset) 까지의 누적 텍스트 길이 = display offset. */
  private displayOffsetOf(node: Node, offset: number): number {
    const body = this.bodyEl;
    if (!body) return 0;
    if (node.nodeType === Node.ELEMENT_NODE) {
      let acc = 0;
      const kids = Array.from(node.childNodes).slice(0, offset);
      for (const c of kids) acc += (c.textContent ?? "").length;
      return this.textBefore(body, node) + acc;
    }
    return this.textBefore(body, node) + offset;
  }

  private textBefore(root: HTMLElement, target: Node): number {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (n === target) return acc;
      acc += (n.textContent ?? "").length;
    }
    return acc;
  }

  /**
   * display offset 위치의 한 글자 rect. collapsed Range 는 크로미움에서 빈 rect 를
   * 돌려줘 스크롤이 맨 위로 떨어지므로, 1글자 범위(getClientRects)로 실제 위치를 잰다.
   */
  private charRectAtDisplayOffset(display: number): DOMRect | null {
    const body = this.bodyEl;
    if (!body) return null;
    // 줄바꿈/빈 글자에 걸리면 rect 가 비므로 몇 글자 앞으로 스캔.
    for (let d = display; d <= display + 6; d++) {
      const found = this.textNodeAtDisplayOffset(d);
      if (!found) break;
      const { node, local } = found;
      if (local >= node.length) continue;
      const r = document.createRange();
      r.setStart(node, local);
      r.setEnd(node, local + 1);
      const rects = r.getClientRects();
      if (rects.length > 0 && rects[0].height > 0) return rects[0] as DOMRect;
    }
    // 못 찾음 — 본문 전체 rect 를 돌려주면 맨 위로 오판하므로 null (호출부가 끝으로 폴백).
    return null;
  }

  private textNodeAtDisplayOffset(
    display: number
  ): { node: Text; local: number } | null {
    const body = this.bodyEl;
    if (!body) return null;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let last: Text | null = null;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = n as Text;
      last = t;
      if (acc + t.length > display) return { node: t, local: display - acc };
      acc += t.length;
    }
    return last ? { node: last, local: last.length } : null;
  }

  private displayToRawOffset(display: number): number {
    const map = this.displayRender.displayToRaw;
    if (display <= 0) return 0;
    if (display >= map.length) return this.baselineText.length;
    return map[display] ?? this.baselineText.length;
  }

  /**
   * 레이아웃 안정 후 스크롤 콜백 적용. 번역 보기는 본문보다 DOM 이 무거워 한 프레임
   * 늦게 높이가 잡히므로 두 프레임에 걸쳐 적용한다(단일 rAF 면 높이 0 → 맨 위로 가버림).
   * split-h 는 원문·번역 두 패널을 같은 위치로 맞춘다.
   */
  private scrollAfterLayout(apply: (scroller: HTMLElement) => void): void {
    const run = () => {
      if (this.outputMode === "split-h") {
        if (this.bodyEl) apply(this.bodyEl);
        if (this.translationEl) apply(this.translationEl);
      } else if (this.bodyWrapEl) {
        apply(this.bodyWrapEl);
      }
    };
    window.requestAnimationFrame(() => {
      run();
      window.requestAnimationFrame(run);
    });
  }

  /** 본문 스크롤 시 — 디바운스로 읽던 노드 앵커를 PluginData 에 영속화 (재실행 복원용). */
  private onBodyScroll(): void {
    if (!this.sessionFile) return;
    if (this.generation) {
      // 생성 중: 위로 올리면 꼬리 따라가기 해제, 바닥으로 돌아오면 재개.
      const scroller = this.activeScroller();
      if (scroller) this.followTail = this.isNearBottom(scroller);
      return;
    }
    this.captureAnchorSoon();
    if (this.scrollSaveTimer != null) window.clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = window.setTimeout(() => {
      this.scrollSaveTimer = null;
      this.saveAnchor();
    }, 600);
  }

  /** 디스크 저장(600ms)과 별개로 메모리 앵커를 즉시 갱신 — 리사이즈 재중앙 기준. */
  private captureAnchorSoon(): void {
    if (this.anchorCaptureRaf != null) return;
    this.anchorCaptureRaf = window.requestAnimationFrame(() => {
      this.anchorCaptureRaf = null;
      const anchor = this.currentAnchor();
      if (anchor) this.lastAnchor = anchor;
    });
  }

  private isNearBottom(scroller: HTMLElement): boolean {
    return (
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
    );
  }

  /** 생성 중 꼬리 따라가기 — 스트리밍 렌더/크기 변화 직후 붙는 지점을 계속 보여준다. */
  private scrollTailIfFollowing(): void {
    if (!this.followTail) return;
    if (this.outputMode === "split-h") {
      if (this.bodyEl) this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
      if (this.translationEl)
        this.translationEl.scrollTop = this.translationEl.scrollHeight;
    } else if (this.bodyWrapEl) {
      this.bodyWrapEl.scrollTop = this.bodyWrapEl.scrollHeight;
    }
  }

  /** 미저장 읽던 위치를 즉시 영속화 (세션 전환/닫기 직전). */
  private flushScrollSave(): void {
    if (this.scrollSaveTimer != null) {
      window.clearTimeout(this.scrollSaveTimer);
      this.scrollSaveTimer = null;
    }
    this.saveAnchor();
  }

  private saveAnchor(): void {
    const file = this.sessionFile;
    if (!file) return;
    const anchor = this.currentAnchor();
    // 계산 실패(숨김/레이아웃 없음)로 저장된 위치를 지우지 않는다 — 마지막 값 유지.
    if (!anchor) return;
    this.lastAnchor = anchor;
    void this.plugin.setSessionAnchor(file, anchor);
  }

  // --- split 스크롤 체인 (원문·번역 같이 스크롤) ---

  /** split 패널 스크롤 → 반대편을 같은 내용 위치로 (rAF 스로틀 + 되먹임 잠금). */
  private onSplitPanelScroll(source: "body" | "translation"): void {
    if (this.outputMode !== "split-h" || !this.chainScroll) return;
    if (this.generation) return; // 생성 중엔 꼬리 따라가기가 두 패널을 직접 맞춘다.
    const now = performance.now();
    if (this.syncLock && this.syncLock.source !== source && now < this.syncLock.until) {
      return; // 체인이 유발한 반대편 스크롤 이벤트 — 되받아치지 않는다.
    }
    this.syncLock = { source, until: now + 150 };
    if (this.syncRafId != null) return;
    this.syncRafId = window.requestAnimationFrame(() => {
      this.syncRafId = null;
      const lock = this.syncLock;
      if (lock) this.performSplitSync(lock.source);
    });
  }

  /** 원문·번역 패널을 화면 세로 중앙 기준 같은 내용 위치로 정렬. */
  private performSplitSync(source: "body" | "translation"): void {
    const body = this.bodyEl;
    const translation = this.translationEl;
    if (!body || !translation) return;
    if (source === "body") {
      const raw = this.bodyRawOffsetAtCenter(body);
      if (raw != null) this.scrollRawOffsetToCenter(translation, raw, false);
    } else {
      const raw = this.translationRawOffsetAtCenter(translation);
      if (raw != null) this.scrollRawOffsetToCenter(body, raw, false);
    }
  }

  // --- editing flow ---

  private onBodyInput(): void {
    if (this.suppressEvents) return;
    if (!this.bodyEl || !this.session) return;
    // 조합 중에는 textContent 가 미완성 상태라 여기서 diff/커밋 예약을 하지 않는다.
    // compositionend 에서 한 번에 반영한다.
    if (this.composing) return;
    this.syncPendingDiff();
    this.scheduleIdleCommit();
  }

  private onSelectionChange(): void {
    if (this.suppressEvents) return;
    // 드래그 선택 변화 → 일괄 번역 버튼 표시/모드 갱신 (원문 보기에서도 뜨게).
    this.scheduleSelectionUiUpdate();
    // 타이핑으로 커서가 아래로 내려가면 키보드에 가릴 수 있다 — 편집 중이면 위로 유지.
    this.scheduleKeepCaretVisible();
    if (!this.bodyEl || !this.session) return;
    // 조합 중 selectionchange 로 커밋(=body.empty() 재구성)이 일어나면 조합·포커스가
    // 깨진다. 조합이 끝난 뒤 판정한다.
    if (this.composing) return;

    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!this.bodyEl.contains(range.startContainer)) return;

    // pendingDiff ????DOM textContent ??筌욊낯????뚮선 ?醫롪퐨??띿쓺 ????怨좊립??
    // ??곸?: Chromium ?癒?퐣 selectionchange 揶쎛 input 癰귣????믪눘? 獄쏆뮉???롫뮉 野껋럩??
    //       pendingDiff ????疫꼲????쇱퓗筌???甕곌쑴?????caret > end ??쎈솇????룸┸??
    //       textContent ????? 筌ㅼ뮇??DOM 揶쏅??좄첋?嚥?????筌???뽮퐣???類μ넇??롫뼄.
    this.syncPendingDiff();
    const fresh = this.pendingDiff;
    if (!fresh) return; // 癰궰野???곸벉 ???뚣끇而??븍뜆??

    const caret = this.getCaretOffset();
    const end = fresh.from + fresh.inserted.length;
    // ?닌덉퍢 獄쏅쉼?좑쭖??袁⑺뒄揶쎛 獄쏅뗀??野껉퍔?앮에??癒?뼊 ??筌앸맩???뚣끇而?
    if (caret < fresh.from || caret > end) {
      void this.commitPending();
    }
  }

  /** DOM ?袁⑹삺 ??용뮞?紐? baseline ??diff ??pendingDiff ??揶쏄퉮???뺣뼄. */
  private syncPendingDiff(): void {
    const body = this.bodyEl;
    if (!body) return;
    this.pendingDiff = diffText(this.displayText, body.textContent ?? "");
  }

  /** selectionchange 마다 버튼 전체를 갱신하지 않게 디바운스 (원문 드래그 반영). */
  private scheduleSelectionUiUpdate(): void {
    if (this.selectionUiTimer != null) return;
    this.selectionUiTimer = window.setTimeout(() => {
      this.selectionUiTimer = null;
      this.updateViewToggleBtn();
    }, 120);
  }

  private onKeydown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) {
      e.preventDefault();
      void this.handleUndo();
    } else if (k === "y" || (k === "z" && e.shiftKey)) {
      e.preventDefault();
      void this.handleRedo();
    }
  }

  private scheduleIdleCommit(): void {
    this.clearIdleTimer();
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      void this.commitPending();
    }, IDLE_COMMIT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** pendingDiff ?????紐껊굡 1揶쏆뮆以??뚣끇而? diff 揶쎛 ??곸몵筌?no-op. */
  private displayDiffToStoredPatch(diff: TextDiff): Patch {
    let rawFrom = this.displayOffsetToRawOffset(diff.from);
    let rawTo = this.displayOffsetToRawOffset(diff.to);

    for (const range of this.displayRender.macroRanges) {
      const overlaps =
        diff.from < range.displayTo && diff.to > range.displayFrom;
      const insertionInside =
        diff.from === diff.to &&
        diff.from > range.displayFrom &&
        diff.from < range.displayTo;
      if (overlaps || insertionInside) {
        rawFrom = Math.min(rawFrom, range.rawFrom);
        rawTo = Math.max(rawTo, range.rawTo);
      }
    }

    const isAppendAtEnd =
      rawFrom === this.baselineText.length &&
      rawTo === this.baselineText.length &&
      diff.inserted.length > 0;
    if (isAppendAtEnd) {
      return { op: "append", spans: [{ author: "user", text: diff.inserted }] };
    }
    if (diff.inserted.length === 0) {
      return { op: "delete", from: rawFrom, to: rawTo };
    }
    return {
      op: "replace",
      from: rawFrom,
      to: rawTo,
      spans: [{ author: "user", text: diff.inserted }],
    };
  }

  private displayOffsetToRawOffset(offset: number): number {
    const map = this.displayRender.displayToRaw;
    const i = Math.max(0, Math.min(offset, map.length - 1));
    return map[i] ?? this.baselineText.length;
  }

  private rawOffsetToDisplayOffset(offset: number): number {
    if (offset <= 0) return 0;
    if (offset >= this.baselineText.length) return this.displayText.length;
    const map = this.displayRender.displayToRaw;
    for (let i = 0; i < map.length; i++) {
      if ((map[i] ?? 0) >= offset) return i;
    }
    return this.displayText.length;
  }

  private async commitPending(): Promise<void> {
    this.clearIdleTimer();
    if (!this.session || !this.sessionFile) return;
    // 조합 중이면 body.empty() 재구성을 미룬다 — compositionend 에서 다시 예약된다.
    if (this.composing) {
      this.scheduleIdleCommit();
      return;
    }
    const diff = this.pendingDiff;
    if (!diff) return;
    this.pendingDiff = null;

    const patch = this.displayDiffToStoredPatch(diff);
    const kind: TurnKind =
      patch.op === "append" ? "user-write" : "user-edit";

    const node: SessionNode = {
      id: uuidv4(),
      parent: this.session.meta.activeLeafId,
      kind,
      patches: [patch],
      createdAt: Date.now(),
    };
    this.session.nodes[node.id] = node;
    this.session.meta.activeLeafId = node.id;
    this.redoStack = [];

    // baseline 揶쏄퉮????DOM ?? ??? 揶쏆늿? ?怨밴묶, ??곗춸 ????
    this.baselineSpans = applyPatch(this.baselineSpans, patch);
    this.baselineText = spansToText(this.baselineSpans);

    await this.persistSession("?紐꾨???????쎈솭");

    this.redrawBodyPreservingCaret();
    this.updateToolbar();
  }

  // --- undo / redo via activeLeaf ---

  private async handleUndo(): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    if (this.leafNavigationBusy) return;
    await this.commitPending();
    const curId = this.session.meta.activeLeafId;
    const cur = this.session.nodes[curId];
    if (!cur || cur.parent == null) {
      new Notice("????롫즼??????곷뮸??덈뼄.");
      return;
    }
    this.clearUndoRemovalPreview();
    this.leafNavigationBusy = true;
    try {
      this.redoStack.push(curId);
      this.session.meta.activeLeafId = cur.parent;
      await this.afterLeafChange();
    } finally {
      this.leafNavigationBusy = false;
    }
  }

  private async handleRedo(): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    if (this.leafNavigationBusy) return;
    await this.commitPending();
    // commitPending ??redoStack ????쑴???삠늺 ????곴맒 ??野???용뼄.
    let next = this.redoStack.pop();
    if (!next || !this.session.nodes[next]) {
      // redoStack ??鹽뚮뮉硫??(?醫뉒뜇沃섇돥??嫄??ル옙?????紐껊굡 ????????: ?醫밴춯 child 濾롫뗄??
      const curId = this.session.meta.activeLeafId;
      const children = getChildren(this.session, curId);
      next = children.length > 0 ? children[children.length - 1].id : undefined;
    }
    if (!next || !this.session.nodes[next]) {
      new Notice("??쇰뻻 ??쎈뻬?????????곷뮸??덈뼄.");
      return;
    }
    this.leafNavigationBusy = true;
    try {
      this.session.meta.activeLeafId = next;
      await this.afterLeafChange();
    } finally {
      this.leafNavigationBusy = false;
    }
  }

  private async afterLeafChange(): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    this.baselineSpans = buildSpans(this.session);
    this.baselineText = spansToText(this.baselineSpans);
    this.refreshDisplayBaseline();
    await this.persistSession("activeLeaf ??????쎈솭", true);
    this.suppressEvents = true;
    this.renderBodySpans();
    // undo/redo/?브쑨由?筌욊낱??caret ?? 癰귣챶揆 ??밸퓠 ?癒?뮉 野?揶쎛????????얜뼄.
    this.setCaretOffset(this.displayText.length);
    this.suppressEvents = false;
    this.updateToolbar();
    // 번역 보기/split 중이면 바뀐 활성 경로로 블록 재구성 — 형제 이동으로 트리에서
    // 빠진 노드의 번역 문단이 남아있지 않게 한다.
    if (this.translationViewActive || this.outputMode === "split-h") {
      this.renderTranslationBlocks();
    }
  }

  // --- B3 / B4: ?브쑨由?/ AI ??밴쉐 / 筌앸Þ爰쇽㎕?섎┛ ---

  /**
   * ??곷선?怨뚮┛ 甕곌쑵?????? ?紐껊굶??
   * - ??疫?餓? handleContinue() ?紐꾪뀱 (???怨밴묶)
   * - ??밴쉐 餓? abort ?醫륁깈 ?袁⑸꽊 (???怨밴묶 ??餓λ쵎??
   */
  private showUndoRemovalPreview(): void {
    if (!this.session || this.pendingDiff) return;
    const cur = this.session.nodes[this.session.meta.activeLeafId];
    if (!cur || cur.parent == null) return;

    const rawRanges = this.getNodeInsertedRawRanges(cur);
    if (rawRanges.length === 0) return;

    // 번역 보기: 사라질 구간과 겹치는 문단을 문단 단위로 강조 (대략적).
    if (this.translationViewActive) this.highlightTranslationRemoval(rawRanges);

    // 원문 본문 강조 (replace+번역보기면 숨겨져 안 보이지만 split-h/원문보기에선 보임).
    const ranges: BodyHighlightRange[] = rawRanges.map((r) => ({
      from: this.rawOffsetToDisplayOffset(r.from),
      to: this.rawOffsetToDisplayOffset(r.to),
      className: "ggai-span-undo-preview",
    }));
    this.suppressEvents = true;
    this.renderBodySpans(ranges);
    this.suppressEvents = false;
    this.undoPreviewVisible = true;
  }

  private clearUndoRemovalPreview(): void {
    if (!this.undoPreviewVisible) return;
    this.undoPreviewVisible = false;
    this.clearTranslationRemovalPreview();
    if (!this.bodyEl || this.pendingDiff) return;

    this.suppressEvents = true;
    this.renderBodySpans();
    this.suppressEvents = false;
  }

  /** 노드가 본문에 끼워넣은 구간 — raw(본문) 오프셋 기준. */
  private getNodeInsertedRawRanges(
    node: SessionNode
  ): Array<{ from: number; to: number }> {
    if (!this.session || node.parent == null) return [];

    const ranges: Array<{ from: number; to: number }> = [];
    let spans = buildSpans(this.session, node.parent);

    for (const patch of node.patches) {
      if (patch.op === "append") {
        const from = spansLength(spans);
        const length = spansLength(patch.spans);
        if (length > 0) ranges.push({ from, to: from + length });
      } else if (patch.op === "replace") {
        const length = spansLength(patch.spans);
        if (length > 0) ranges.push({ from: patch.from, to: patch.from + length });
      }
      spans = applyPatch(spans, patch);
    }

    return ranges;
  }

  private getNodeInsertedRanges(node: SessionNode): BodyHighlightRange[] {
    return this.getNodeInsertedRawRanges(node).map((r) => ({
      from: this.rawOffsetToDisplayOffset(r.from),
      to: this.rawOffsetToDisplayOffset(r.to),
      className: "ggai-span-undo-preview",
    }));
  }

  /** 번역 보기에서 사라질(교체될) 구간과 겹치는 문단 블록을 문단 단위로 강조. */
  private highlightTranslationRemoval(
    rawRanges: Array<{ from: number; to: number }>
  ): void {
    for (const block of this.translationBlocks) {
      const start = block.offset;
      const end = block.offset + block.source.length;
      const overlaps = rawRanges.some((r) => r.from < end && r.to > start);
      block.el.toggleClass("ggai-tr-removal-preview", overlaps);
    }
  }

  private clearTranslationRemovalPreview(): void {
    for (const block of this.translationBlocks) {
      block.el.removeClass("ggai-tr-removal-preview");
    }
  }

  private async handleContinueOrStop(): Promise<void> {
    if (this.generation) {
      this.generation.abort.abort();
    } else {
      await this.handleContinue();
    }
  }

  /** ??곷선?怨뚮┛ ??activeLeaf ??parent 嚥?AI ?紐껊굡??child 嚥??곕떽???랁?chatStream ??곗쨮 筌?쑴?. */
  private async handleContinue(): Promise<void> {
    if (!this.session || this.generation) return;
    await this.commitPending();
    // 타이핑을 멈출 때마다 잘게 쌓인 유저 작성 노드를 생성 직전 하나로 합친다
    // (본문은 동일, 분기 트리만 정리). 합쳤으면 저장.
    if (mergeTrailingUserWrites(this.session)) {
      this.redoStack = [];
      await this.persistSession("유저 입력 노드 병합");
    }
    await this.applyPresetRotationIfEnabled();
    await this.runGeneration(this.session.meta.activeLeafId, "ai-continue");
  }

  /**
   * 프리셋 자동 순환(켜져 있을 때) — 생성 직전 즐겨찾기 프리셋 중 하나를 무작위
   * (주사위)로 골라 silent 적용한다. UI 의 "선택된 프리셋" 표시는 그대로 둔다.
   * 이어쓰기/재생성 둘 다에서 호출 — 문단 재생성(별도 실행기)은 대상이 아니다.
   * applyPreset 이 세션 메타를 store 에 쓰므로, in-memory 사본을 새로 읽어 stale 방지.
   * 그동안의 session-changed 는 억제하고(중복 리로드/재렌더 방지) 직접 갱신한다.
   */
  private async applyPresetRotationIfEnabled(): Promise<void> {
    if (!this.plugin.data.presetRotationEnabled || !this.sessionFile) return;
    const file = this.sessionFile;
    this.suppressOwnSessionEvent = true;
    try {
      const applied = await this.plugin.maybeRotatePreset(file);
      if (applied) {
        const fresh = await this.store.getSession(file);
        if (fresh) this.session = fresh;
      }
    } finally {
      this.suppressOwnSessionEvent = false;
    }
  }

  /**
   * ??源????activeLeaf ??parent ?????봔筌뤴뫀以?sibling AI ?紐껊굡???곕떽???랁?chatStream ??곗쨮 筌?쑴?.
   * activeLeaf 揶쎛 AI ?紐껊굡揶쎛 ?袁⑤빍椰꾧퀡援?root 筌?椰꾧퀡?.
   */
  private async handleRegen(): Promise<void> {
    if (!this.session || this.generation) return;
    await this.commitPending();

    const cur = this.session.nodes[this.session.meta.activeLeafId];
    if (!cur || !isAINode(cur) || cur.parent == null) {
      new Notice("Regenerate is available only on AI generation nodes.");
      return;
    }
    await this.applyPresetRotationIfEnabled();
    await this.runGeneration(cur.parent, "ai-regen");
  }

  /**
   * ?⑤벏??AI ??밴쉐 ?룐뫂遊?(??곷선?怨뚮┛ / ??源??筌뤴뫀紐?????.
   *
   * ?癒?カ:
   *   1) ??뺢돌?귐딆궎 / 癰귣챶揆(parent 繹먮슣?) 嚥??뚢뫂???쎈뱜 ??슢諭?
   *   2) ??AI ?紐껊굡 ??밴쉐 + activeLeaf 揶쏄퉮????癰귣챶揆 筌앸맩???????(??쎈뱜????筌?쑴?숋쭪?.
   *   3) chatStream ?룐뫂遊? text-delta 筌띾뜄???紐껊굡 patch in-place 揶쏄퉮????癰귣챶揆 ?????(?遺용뮞??沃섎챷???.
   *   4) done / error / abort ??????甕?store.saveSession ??곗쨮 ?怨몃꺗??
   */
  private async runGeneration(
    parentId: string,
    kind: "ai-continue" | "ai-regen"
  ): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    this.exitParaSelectMode();

    if (!this.ai.isAvailable()) {
      new Notice(
        "GGAI Core is not installed or enabled. Enable it in Settings first."
      );
      return;
    }

    // ??뽮쉐 ??쇱젟 ????뽮쉐 ?紐꾨???PluginData.current ??뽰몵嚥?
    // 제목 자동 생성 등에 쓸 활성 파라미터. 전송 프로필/전송본은 planSessionRequest 가 정한다.
    const settings = await this.plugin.resolveActiveSettings(this.sessionFile);

    // 1) ?뚢뫂???쎈뱜 ??슢諭?v2 ??preset + lorebook + scenario + session 癰귣챶揆
    const parentSpans = buildSpans(this.session, parentId);
    const scenarioFile = scenarioFileOfSessionFile(this.sessionFile);
    const scenarios = await this.store.getScenarios();
    const scenarioName =
      scenarios.find((i) => i.scenarioFile === scenarioFile)?.scenario.data?.name ??
      "(unknown)";

    // 전송본은 미리보기(현재 컨텍스트 확인)와 동일한 단일 빌더로만 만든다.
    // parentId(=이어쓰기가 보낼 지점) 기준으로 컨텍스트를 진다.
    const plan = await planSessionRequest(this.plugin, this.sessionFile, {
      leafId: parentId,
    });
    if ("error" in plan) {
      new Notice(plan.error);
      return;
    }
    const profile = plan.profile;
    const ctx = plan.output;
    const payload = plan.payload;
    const paramsOverride = plan.paramsOverride;
    // macro setvar / 로어북 timing 갱신값을 세션에 반영(영속).
    this.session.meta.variables = plan.updatedVariables;
    this.session.meta.timingStates = ctx.updatedTimingStates;

    // 2) ??AI ?紐껊굡 ?곕떽?
    const nodeId = uuidv4();
    const node: SessionNode = {
      id: nodeId,
      parent: parentId,
      kind,
      patches: [{ op: "append", spans: [{ author: "ai", text: "" }] }],
      createdAt: Date.now(),
      gen: {
        model: profile.model,
        tokensIn: 0,
        tokensOut: 0,
        profile: profile.name,
      },
    };
    this.session.nodes[nodeId] = node;
    this.session.meta.activeLeafId = nodeId;
    this.redoStack = [];
    this.rebuildBaselineAndRender();
    // 재생성은 이전 활성 경로의 노드가 트리에서 빠진다 — 번역 보기에서도 그 문단이
    // 즉시 사라지도록 블록을 한 번만 재구성한다. 번역 보기 모드는 그대로 유지한다
    // (원문 보기로 뒤집지 않는다 — 그 플립이 "모드가 풀리는" 삐걱거림의 원인이었다).
    // 스트리밍 중엔 재구성하지 않으므로 전체 재렌더 부담도 없다.
    if (kind === "ai-regen" && (this.translationViewActive || this.outputMode === "split-h")) {
      this.renderTranslationBlocks();
    }

    // 3) 筌욊쑵六??怨밴묶
    const abort = new AbortController();
    this.generation = { nodeId, abort, accumulatedText: "" };
    this.setBodyEditable(false);
    this.updateToolbar();
    // 이어쓰기/재생성 — 생성이 붙는 지점(본문 끝)으로 이동해 스트리밍을 따라간다.
    // 사용자가 위로 스크롤하면 해제되고, 바닥으로 돌아오면 다시 따라간다.
    this.followTail = true;
    this.scrollTailIfFollowing();

    let usage = { inputTokens: 0, outputTokens: 0 };
    let aborted = false;
    let emptyResponse = false;

    try {
      if (payload.kind === "text") {
        // ??용뮞???뚮똾逾녺뵳????袁⑥쨮????Core ??generate() ??ㅼ뻣 ?紐꾪뀱.
        // chat 筌롫뗄?놅쭪? 獄쏄퀣肉??NAI text-completion ????μ뵬 prompt 嚥???뱁뒊??
        // 텍스트 모델은 NAI 형식 기본 ON(명시적으로 끈 경우만 평문) — 역할 토큰으로 감싼다.
        const promptStr = payload.prompt;
        const r = await this.ai.generate({
          profileId: profile.id,
          prompt: promptStr,
          paramsOverride,
          signal: abort.signal,
        });
        const gen = this.generation;
        if (gen) {
          gen.accumulatedText = r.text ?? "";
          const append = node.patches[0];
          if (append.op === "append" && append.spans[0]) {
            append.spans[0].text = gen.accumulatedText;
          }
          this.rebuildBaselineAndRender();
          this.scrollTailIfFollowing();
        }
        usage = r.usage;
        if (!r.text || r.text.length === 0) {
          emptyResponse = true;
          console.warn("[GGAI Stella] empty text completion response", {
            promptLen: promptStr.length,
            promptTail: promptStr.slice(-500),
            tokensUsed: ctx.tokensUsed,
            droppedLogTurns: ctx.droppedLogTurns,
            trace: ctx.trace,
            raw: r.raw,
          });
          new Notice(
            "AI response is empty. Check profile / prompt / token settings."
          );
        }
      } else {
        // chat ?袁⑥쨮????OpenAI ?紐낆넎 ?遺얜굡?????GLM/Z.AI, DeepSeek ?? 揶쎛 椰꾧퀡???롫뮉 ???쉘
        // (?怨쀫꺗 system / 筌띾뜆?筌?assistant) ???類?뇣?酉釉?????쎈뱜?귐됱빪.
        const safeMessages = payload.messages;
        // 이어쓰기 이음새 보정 — 응답 앞의 앵커(마지막 문장) 반복을 제거하고 표시.
        const anchorSentence = payload.anchor;
        const chatReq = {
          profileId: profile.id,
          messages: safeMessages,
          paramsOverride,
          signal: abort.signal,
        };
        for await (const event of this.ai.chatStream(chatReq)) {
          if (event.type === "text-delta") {
            const gen = this.generation;
            if (!gen) break;
            if (anchorSentence) {
              gen.rawText = (gen.rawText ?? "") + event.delta;
              const skip = anchorSkipStreaming(gen.rawText, anchorSentence);
              // 판정 전(null)에는 표시를 보류 — 앵커 반복이 화면에 비치지 않는다.
              gen.accumulatedText =
                skip === null ? "" : gen.rawText.slice(skip);
            } else {
              gen.accumulatedText += event.delta;
            }
            const append = node.patches[0];
            if (append.op === "append" && append.spans[0]) {
              append.spans[0].text = gen.accumulatedText;
            }
            // 전체 재구성 대신 새로 도착한 생성 텍스트만 다시 그린다(긴 세션 프리즈 방지).
            this.renderStreamingTail(gen.accumulatedText);
            this.scrollTailIfFollowing();
          } else if (event.type === "done") {
            usage = event.response.usage;
            if (this.generation) this.generation.lastRaw = event.response.raw;
            const doneText = event.response.text ?? "";
            if (
              doneText.length > 0 &&
              (this.generation?.rawText ?? this.generation?.accumulatedText ?? "") === ""
            ) {
              const gen = this.generation;
              if (gen) {
                if (anchorSentence) {
                  gen.rawText = doneText;
                } else {
                  gen.accumulatedText = doneText;
                }
                const append = node.patches[0];
                if (append.op === "append" && append.spans[0]) {
                  append.spans[0].text = gen.accumulatedText;
                }
                this.rebuildBaselineAndRender();
                this.scrollTailIfFollowing();
              }
            }
          } else if (event.type === "error") {
            const streamErr: any = new Error(event.error.message);
            streamErr.code = event.error.code;
            throw streamErr;
          }
        }
        // 스트림 종료 — 보류/미판정 상태를 확정하고 앵커 반복을 최종 제거.
        this.finalizeAnchorStrip(anchorSentence, node);
        if ((this.generation?.accumulatedText ?? "").length === 0 && !abort.signal.aborted) {
          emptyResponse = true;
          console.warn("[GGAI Stella] empty chat completion response", {
            roles: safeMessages.map((m) => m.role).join(","),
            lastRole: safeMessages[safeMessages.length - 1]?.role,
            lastContentTail: safeMessages[safeMessages.length - 1]?.content?.slice(-500),
            tokensUsed: ctx.tokensUsed,
            droppedLogTurns: ctx.droppedLogTurns,
            trace: ctx.trace,
            raw: this.generation?.lastRaw,
          });
          new Notice("Core returned empty text. See console for the raw response.");
        }
      }
    } catch (err: any) {
      if (err?.code === "cancelled" || abort.signal.aborted) {
        aborted = true;
        new Notice(
          hasVisibleText(this.generation?.accumulatedText ?? "")
            ? "Generation stopped. Partial text was kept."
            : "Generation stopped before any text was produced."
        );
      } else {
        const msg = err?.message ?? String(err);
        new Notice("Generation failed: " + msg);
        // ???紐껊굡??겹늺 ?類ｂ봺
        if (!hasVisibleText(this.generation?.accumulatedText ?? "")) {
          delete this.session.nodes[nodeId];
          this.session.meta.activeLeafId = parentId;
        }
      }
    } finally {
      // 중단/오류로 스트림이 끊긴 경우에도 앵커 반복 제거를 확정 (재호출 안전).
      this.finalizeAnchorStrip(
        payload.kind === "chat" ? payload.anchor : undefined,
        node
      );
      if (node.gen) {
        node.gen.tokensIn = usage.inputTokens;
        node.gen.tokensOut = usage.outputTokens;
      }
      if (emptyResponse && !aborted && (this.generation?.accumulatedText ?? "") === "") {
        delete this.session.nodes[nodeId];
        if (this.session.meta.activeLeafId === nodeId) {
          this.session.meta.activeLeafId = parentId;
        }
      }
      const generatedText = this.generation?.accumulatedText ?? "";
      const blankGeneration = !hasVisibleText(generatedText);
      if (blankGeneration) {
        delete this.session.nodes[nodeId];
        if (this.session.meta.activeLeafId === nodeId) {
          this.session.meta.activeLeafId = parentId;
        }
        if (!emptyResponse && !aborted) {
          new Notice("AI response contained no visible text, so no branch was saved.");
        }
      }
      this.generation = null;
      this.setBodyEditable(true);
      this.rebuildBaselineAndRender();
      // 번역 보기 중이면 생성 결과를 번역 화면에도 반영한다 — 새 문단은 (자동 번역
      // 전이면) 원문으로 보이고, 이어서 자동 번역이 돌면 번역으로 갱신된다. 모드 전환
      // 없이 블록만 한 번 재구성하므로 재생성 후 "번역할 자리가 비는" 구멍이 없다.
      if (this.translationViewActive || this.outputMode === "split-h") {
        this.renderTranslationBlocks();
      }
      this.setCaretOffset(this.displayText.length);
      // 따라가던 중이면 생성 결과 끝을 보여주고, 그 위치를 읽던 위치로 기록.
      this.scrollTailIfFollowing();
      this.followTail = false;
      window.requestAnimationFrame(() => this.saveAnchor());
      await this.persistSession(
        aborted ? "Partial generation save failed" : "AI generation save failed",
        true
      );
      if (!aborted && !emptyResponse && !blankGeneration) {
        const parentText = spansToText(parentSpans);
        await this.maybeGenerateSessionTitle({
          generatedText,
          parentText,
          profile,
          scenarioName,
          params: settings.params,
        });
        // 번역·삽화(본체)와 확장 생성-완료 훅(요약 등)은 서로 독립 — 동시에 실행.
        await Promise.all([
          // 생성 시작 지점이 속한 문단부터 자동 번역 (직전 문단 경계로 한 칸 양보).
          this.maybeAutoTranslate(Math.max(0, parentText.length - 1)),
          // 새 원문 노드의 자동 삽화.
          this.maybeAutoIllustrate(nodeId),
          // 확장 생성-완료 훅 — 요약 확장이 주기 도달 시 자동 요약한다.
          this.plugin.extensions.runGenerationComplete({
            sessionFile: this.sessionFile,
            nodeId,
            generatedText,
            parentText,
            profile,
          }),
        ]);
      }
      this.updateToolbar();
    }
  }

  /**
   * 이어쓰기 이음새 보정 확정 — 원본 응답(rawText)에서 앵커(마지막 문장) 반복을
   * 잘라낸 최종본을 accumulatedText/patch 에 반영한다. 스트리밍 정상 종료·중단·
   * 오류 어느 경로에서든 호출되며, 앵커 미사용이면 아무것도 하지 않는다.
   */
  private finalizeAnchorStrip(
    anchor: string | undefined,
    node: SessionNode
  ): void {
    const gen = this.generation;
    if (!gen || !anchor || gen.rawText === undefined) return;
    gen.accumulatedText = gen.rawText.slice(
      anchorSkipFinal(gen.rawText, anchor)
    );
    const append = node.patches[0];
    if (append.op === "append" && append.spans[0]) {
      append.spans[0].text = gen.accumulatedText;
    }
  }

  /** baselineSpans/Text ?????+ 癰귣챶揆 ?????(caret ?얜똻?????紐꾪뀱?癒? ???툡??. */
  private async maybeGenerateSessionTitle(input: {
    generatedText: string;
    parentText: string;
    profile: GenerationProfileLite;
    scenarioName: string;
    params?: PromptPresetParams;
  }): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    if (this.plugin.data.settings?.autoGenerateSessionTitle !== true) return;
    if (this.session.meta.autoTitleGenerated) return;
    if (!isDefaultDatedSessionName(this.session.meta.name)) return;

    this.session.meta.autoTitleGenerated = true;
    try {
      const title = await this.generateSessionTitle(input);
      if (!title) {
        await this.persistSession("Session title flag save failed", true);
        return;
      }
      const result = await this.store.renameSession(this.sessionFile, title);
      this.sessionFile = result.newSessionFile;
      this.plugin.rememberActiveSessionFile(result.newSessionFile);
      this.refreshNativeTitle();
    } catch (err) {
      console.warn("[GGAI Stella] session title generation failed:", err);
      await this.persistSession("Session title flag save failed", true);
    }
  }

  private async generateSessionTitle(input: {
    generatedText: string;
    parentText: string;
    profile: GenerationProfileLite;
    scenarioName: string;
    params?: PromptPresetParams;
  }): Promise<string | null> {
    const story = [input.parentText.slice(-1200), input.generatedText.slice(0, 1800)]
      .filter(Boolean)
      .join("\n\n");
    return requestSessionTitle(this.ai, {
      story,
      profile: input.profile,
      scenarioName: input.scenarioName,
      params: input.params,
    });
  }

  private rebuildBaselineAndRender(): void {
    if (!this.session) return;
    this.baselineSpans = buildSpans(this.session);
    this.baselineText = spansToText(this.baselineSpans);
    this.refreshDisplayBaseline();
    this.suppressEvents = true;
    this.renderBodySpans();
    this.suppressEvents = false;
  }

  private setBodyEditable(editable: boolean): void {
    if (!this.bodyEl) return;
    this.bodyEl.setAttr(
      "contenteditable",
      editable ? "plaintext-only" : "false"
    );
  }

  /** 筌띾뜆?筌??紐껊굡嚥??癒곕늄 ??activeLeaf ???癒?? 餓?揶쎛??筌ㅼ뮄??leaf 繹먮슣? ?怨뺤뵬揶쏄쑬?? */
  private async handleJumpEnd(): Promise<void> {
    if (!this.session || this.generation) return;
    await this.commitPending();
    const cur = this.session.nodes[this.session.meta.activeLeafId];
    if (!cur) return;
    const leaf = getDeepestLatestDescendant(this.session, cur.id);
    if (!leaf || leaf.id === cur.id) {
      new Notice("Already at the latest branch end.");
      return;
    }
    this.session.meta.activeLeafId = leaf.id;
    this.redoStack = [];
    await this.afterLeafChange();
  }

  /** ?怨쀫? ?????뺤뺍 detail view ??용┛ / reveal. */
  private handleSidePanel(): void {
    if (Platform.isMobile) {
      void this.plugin.revealDetail();
      return;
    }
    void this.plugin.toggleDetail();
  }

  private handleViewStyle(): void {
    // 열려 있으면 토글로 닫는다.
    if (this.viewStylePopover?.isOpen()) {
      this.viewStylePopover.close();
      this.viewStylePopover = null;
      return;
    }
    if (!this.viewStyleBtn) return;
    this.viewStylePopover = new ViewStylePopover(
      this.plugin,
      this.viewStyle,
      (style) => {
        this.viewStyle = style;
        this.applyViewStyle();
      }
    );
    this.viewStylePopover.open(this.viewStyleBtn);
  }

  /** 본문 보기 스타일을 CSS 변수로 반영 — bodyWrapEl 이 스코프(이 세션창에만 적용). */
  private applyViewStyle(): void {
    const el = this.bodyWrapEl;
    if (!el) return;
    el.style.setProperty("--ggai-view-max-width", `${this.viewStyle.maxWidth}px`);
    el.style.setProperty("--ggai-view-indent", `${this.viewStyle.indent}em`);
    el.style.setProperty("--ggai-view-para-gap", `${this.viewStyle.paragraphGap}px`);
    el.style.setProperty("--ggai-view-font-scale", String(this.viewStyle.fontScale));
  }

  /** ??뺢돌?귐딆궎 ???문/?紐꾩춿 ????쇱벉 ??ｍ? */
  /** 揶쏆늿? parent ???類ㅼ젫嚥?activeLeaf ??猷? direction = -1(??곸읈) | 1(??쇱벉). */
  private async handleSiblingNav(direction: -1 | 1): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    await this.commitPending();

    const cur = this.session.nodes[this.session.meta.activeLeafId];
    if (!cur) return;
    const siblings = getSiblings(this.session, cur.id);
    const idx = siblings.findIndex((n) => n.id === cur.id);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= siblings.length) return;

    this.session.meta.activeLeafId = siblings[newIdx].id;
    this.redoStack = [];
    await this.afterLeafChange();
  }

  /** activeLeaf ??favorite ???삋域??醫?. ?브쑨由??癒?퍥??獄쏅뗀??? ??놁몵沃샕嚥?癰귣챶揆 ??????븍뜆?? */
  private async handleNodeFavorite(): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    const cur = this.session.nodes[this.session.meta.activeLeafId];
    if (!cur) return;
    cur.favorite = !cur.favorite;
    await this.persistSession("Node favorite save failed");
    this.updateToolbar();
  }

  /**
   * ?袁⑹삺 筌롫뗀?덄뵳??怨밴묶??store 嚥??怨몃꺗?酉釉??
   * - suppressOwnSessionEvent 嚥?癰귣챷???獄쏆룇? session-changed ???얜똻????? 揶쏄퉮????.
   * - silent=true 筌???쎈솭 ???꾩꼷??野껋럡?э쭕?(??????紐꾪뀱 ??곸벉).
   */
  private async persistSession(
    errorPrefix: string,
    silent = false
  ): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    this.suppressOwnSessionEvent = true;
    try {
      await this.store.saveSession(this.sessionFile, this.session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (silent) console.warn("[GGAI Stella] " + errorPrefix + ":", err);
      else new Notice(errorPrefix + ": " + msg);
    } finally {
      this.suppressOwnSessionEvent = false;
    }
  }

  /** ?袁⑹삺 activeLeaf + ??밴쉐 ?怨밴묶 疫꿸퀣???곗쨮 ??而???삳쐭 甕곌쑵????뽮쉐/??뽯뻻 揶쏄퉮?? */
  private updateToolbar(): void {
    if (!this.session) return;
    const cur = this.session.nodes[this.session.meta.activeLeafId];
    if (!cur) return;

    const generating = this.generation != null;

    // ?ル슣瑜?域밸챶竊?
    if (this.undoBtn) this.undoBtn.disabled = generating || cur.parent == null;
    const hasRedoTarget =
      this.redoStack.length > 0 || getChildren(this.session, cur.id).length > 0;
    if (this.redoBtn) this.redoBtn.disabled = generating || !hasRedoTarget;
    // jump-end: ?癒??????됱뱽 ???춸 ???. 揶쏄쑬???children 鈺곕똻??筌ｋ똾寃?
    const hasDeeper = getDeepestLatestDescendant(this.session, cur.id)?.id !== cur.id;
    if (this.jumpEndBtn) this.jumpEndBtn.disabled = generating || !hasDeeper;

    // 餓λ쵐釉?????밴쉐 餓λ쵐?좑쭖???餓λ쵎??, ?袁⑤빍筌?????곷선?怨뚮┛)
    if (this.continueBtn) {
      this.continueBtn.empty();
      if (generating) {
        setIcon(this.continueBtn, "square");
        this.continueBtn.addClass("ggai-cta-generating");
        this.continueBtn.setAttr("aria-label", "Stop generation");
        this.continueBtn.disabled = false;
      } else {
        setIcon(this.continueBtn, "play");
        this.continueBtn.removeClass("ggai-cta-generating");
        this.continueBtn.setAttr("aria-label", "Continue generation");
        this.continueBtn.disabled = false;
      }
    }

    // ?怨쀫?: ??源??/ ?類ㅼ젫 nav
    if (this.regenBtn) {
      const canRegen = isAINode(cur) && cur.parent != null;
      this.regenBtn.disabled = generating || !canRegen;
    }
    const siblings = getSiblings(this.session, cur.id);
    const idx = siblings.findIndex((n) => n.id === cur.id);
    if (this.siblingIndicator) {
      this.siblingIndicator.setText(String(idx + 1) + "/" + String(siblings.length));
    }
    if (this.prevSibBtn) this.prevSibBtn.disabled = generating || idx <= 0;
    if (this.nextSibBtn)
      this.nextSibBtn.disabled = generating || idx >= siblings.length - 1;

    // side-panel / settings ??placeholder ????쑵??源딆넅 ????(Notice ?袁?)
    if (this.sidePanelBtn) this.sidePanelBtn.disabled = false;

    // ??삳쐭??筌앸Þ爰쇽㎕?섎┛
    if (this.nodeFavBtn) {
      const fav = cur.favorite === true;
      this.nodeFavBtn.toggleClass("is-favorited", fav);
      this.nodeFavBtn.disabled = generating;
      this.nodeFavBtn.setAttr(
        "aria-label",
        fav ? "Remove quick save" : "Quick save this point"
      );
    }

    // 번역 버튼: 번역 사용(enabled) off 면 비활성 (오작동 방지). 자동 on 은 활성 스타일.
    if (this.translateBtn) {
      const t = this.session.meta.translation;
      this.translateBtn.disabled =
        generating || this.translating || t?.enabled !== true;
      this.translateBtn.toggleClass("is-auto-on", t?.auto === true);
      this.translateBtn.toggleClass("is-busy", this.translating);
      this.translateBtn.setAttr(
        "aria-label",
        t?.auto === true
          ? "번역 (자동 번역 켜짐 — 꾹: 끄기)"
          : "번역 (꾹: 자동 번역 켜기)"
      );
    }

    // 삽화 버튼: 삽화 사용(enabled) off 면 비활성. 자동 on 은 활성 스타일.
    if (this.illustrationBtn) {
      const i = this.session.meta.illustration;
      this.illustrationBtn.disabled =
        generating || this.illustrating || i?.enabled !== true;
      this.illustrationBtn.toggleClass("is-auto-on", i?.auto === true);
      this.illustrationBtn.toggleClass("is-busy", this.illustrating);
      this.illustrationBtn.setAttr(
        "aria-label",
        i?.auto === true
          ? "삽화 (자동 삽화 켜짐 — 꾹: 끄기)"
          : "삽화 (꾹: 자동 삽화 켜기)"
      );
    }

    // 문단 재생성 버튼: 생성 중에는 비활성. 선택 모드 on 은 활성 스타일.
    if (this.paraRegenBtn) {
      this.paraRegenBtn.disabled = generating;
      this.paraRegenBtn.toggleClass("is-select-on", this.paraSelectMode);
      this.paraRegenBtn.setAttr(
        "aria-label",
        this.paraSelectMode
          ? "문단 선택 모드 끄기"
          : "문단 재생성 — 문단 선택 모드"
      );
    }

    this.updateViewToggleBtn();
  }

  /**
   * 모바일: 뷰어 도구를 뷰 헤더 액션에 등록 — 옵시디언 모바일은 이 액션들을
   * 화면 하단 내비바(모바일 툴바)에 그린다. PC 뷰어 바(renderViewerBar)와 같은
   * 마커 클래스를 붙여 is-active/is-selection/is-hidden 상태 CSS 와
   * updateViewToggleBtn 갱신 로직을 그대로 공유한다.
   * 아이콘 자리가 좁아(기기에 따라 4개 안팎에서 넘치면 잘리거나 숨은 아이콘이
   * 생김) 되돌리기/다시적용을 한 아이콘에 겸용한다
   * (탭 = 되돌리기, 꾹 = 다시 적용 — 번역/삽화 트리거 버튼과 같은 패턴).
   * 뷰 헤더 액션은 등록 순서의 역순으로 표시되므로, 표시 순서(좌→우: 로비/갤러리/
   * 되돌리기/일괄/전환, PC renderViewerBar 와 동일)를 내려면 등록은 역순으로 한다.
   */
  private setupViewerToolActions(): void {
    const viewToggle = this.addAction("languages", "원문/번역 전환", () =>
      void this.handleViewToggle()
    );
    viewToggle.addClass("ggai-translation-toggle");
    this.viewToggleBtn = viewToggle;

    const batch = this.addAction(
      "list-plus",
      "번역 안 된 문단 모두 번역",
      () => void this.handleBatchTranslateClick()
    );
    batch.addClass("ggai-tr-batch-btn");
    // mousedown 기본 동작(포커스 이동)이 본문 드래그 선택을 지우지 않게 막는다
    // — 드래그 선택 시 "선택 영역만 번역"으로 동작해야 하므로.
    batch.addEventListener("mousedown", (e) => e.preventDefault());
    this.batchTranslateBtn = batch;

    // addAction 의 클릭 콜백은 비워두고(no-op), attachLongPress 가 탭/꾹을 전담한다
    // (콜백을 실행 로직으로 채우면 매 클릭마다 이것도 같이 실행돼 버림).
    const undoRedo = this.addAction(
      "undo-2",
      "번역 되돌리기 (꾹: 다시 적용)",
      () => {}
    );
    undoRedo.addClass("ggai-tr-undo-btn");
    attachLongPress(undoRedo, {
      onTap: () => void this.handleUndoTranslate(),
      onLongPress: () => void this.handleRedoTranslate(),
    });
    this.undoTranslateBtn = undoRedo;

    const gallery = this.addAction("images", "삽화 갤러리", () =>
      this.openGallery()
    );
    gallery.addClass("ggai-gallery-btn");
    this.galleryToolBtn = gallery;

    this.addAction("log-out", "세션 나가기 (로비로)", () => void this.goToLobby());

    this.updateViewToggleBtn();
  }

  /**
   * PC 뷰어 줄 — 모바일에서 뷰 헤더 액션이 뜨는 자리(본문 위 우측 상단)에 같은
   * 구성의 둥근 아이콘 가로 줄을 그린다 (0높이 레이어라 본문을 밀지 않고 위에
   * 뜸). 탭 타이틀 바(뷰 헤더)를 꺼둔 환경에서도 항상 보인다. 버튼 구성·동작은
   * setupViewerToolActions(모바일)와 1:1 대응 — 한쪽을 바꾸면 같이 바꾼다.
   * DOM 순서는 표시 순서(좌→우: 로비/갤러리/되돌리기/일괄/전환)를 따른다.
   */
  private renderViewerBar(root: HTMLElement): void {
    const bar = root.createEl("div", { cls: "ggai-session-viewer-options" });
    const mkBtn = (icon: string, label: string): HTMLButtonElement => {
      const btn = bar.createEl("button", { cls: "clickable-icon" });
      setIcon(btn, icon);
      btn.setAttr("aria-label", label);
      return btn;
    };

    const home = mkBtn("log-out", "세션 나가기 (로비로)");
    home.addEventListener("click", () => void this.goToLobby());

    const gallery = mkBtn("images", "삽화 갤러리");
    gallery.addClass("ggai-gallery-btn");
    gallery.addEventListener("click", () => this.openGallery());
    this.galleryToolBtn = gallery;

    // 클릭 핸들러 없이 attachLongPress 가 탭/꾹을 전담한다 (탭=되돌리기/꾹=다시 적용).
    const undoRedo = mkBtn("undo-2", "번역 되돌리기 (꾹: 다시 적용)");
    undoRedo.addClass("ggai-tr-undo-btn");
    attachLongPress(undoRedo, {
      onTap: () => void this.handleUndoTranslate(),
      onLongPress: () => void this.handleRedoTranslate(),
    });
    this.undoTranslateBtn = undoRedo;

    const batch = mkBtn("list-plus", "번역 안 된 문단 모두 번역");
    batch.addClass("ggai-tr-batch-btn");
    // mousedown 기본 동작(포커스 이동)이 본문 드래그 선택을 지우지 않게 막는다
    // — 드래그 선택 시 "선택 영역만 번역"으로 동작해야 하므로.
    batch.addEventListener("mousedown", (e) => e.preventDefault());
    batch.addEventListener("click", () =>
      void this.handleBatchTranslateClick()
    );
    this.batchTranslateBtn = batch;

    const viewToggle = mkBtn("languages", "원문/번역 전환");
    viewToggle.addClass("ggai-translation-toggle");
    viewToggle.addEventListener("click", () => void this.handleViewToggle());
    this.viewToggleBtn = viewToggle;
  }

  /**
   * 버튼 비활성 처리 — 뷰 헤더 액션은 <button> 이 아니므로
   * 클래스로 pointer-events/opacity 를 죽인다.
   */
  private setActionDisabled(el: HTMLElement | null, disabled: boolean): void {
    if (!el) return;
    if (el instanceof HTMLButtonElement) el.disabled = disabled;
    else el.toggleClass("ggai-action-disabled", disabled);
  }

  /** 뷰 헤더 액션 뷰어 도구 상태 — 원문↔번역 토글 + 미번역 일괄 번역 등. */
  private updateViewToggleBtn(): void {
    const splitMode = this.outputMode === "split-h";
    // 번역 4버튼(전환/일괄/되돌리기/다시적용)은 번역 사용(enabled) 여부로만 노출을
    // 결정한다 — 원문/번역 보기 전환 같은 일시적 상태로는 뜨고 사라지지 않는다
    // (버튼 구성이 계속 바뀌는 걸 방지).
    const enabled = this.session?.meta.translation?.enabled === true;

    if (this.viewToggleBtn) {
      this.viewToggleBtn.toggleClass("is-hidden", !enabled);
      const hasTranslations =
        !!this.translations &&
        Object.keys(this.translations.paragraphs).length > 0;
      this.setActionDisabled(
        this.viewToggleBtn,
        !enabled ||
          // split 모드는 원문·번역을 동시에 보여주므로 토글이 무의미.
          splitMode ||
          (!hasTranslations && !this.translationViewActive)
      );
      this.viewToggleBtn.toggleClass("is-active", this.translationViewActive);
    }
    if (this.batchTranslateBtn) {
      // 드래그 선택이 있으면 버튼 기능이 "선택 영역만 번역"으로 바뀐다.
      const selHashes =
        this.generation == null && enabled
          ? this.getSelectionParagraphHashes()
          : [];
      const selectionMode = selHashes.length > 0;

      this.batchTranslateBtn.toggleClass("is-hidden", !enabled);
      // 기능이 바뀌었음을 아이콘+색으로 표시 (선택 모드 = 활성 스타일).
      this.batchTranslateBtn.toggleClass("is-selection", selectionMode);
      if (selectionMode !== this.batchBtnSelectionMode) {
        this.batchBtnSelectionMode = selectionMode;
        setIcon(this.batchTranslateBtn, selectionMode ? "list-checks" : "list-plus");
      }

      if (selectionMode) {
        const untranslated = this.translations
          ? selHashes.filter((h) => !hasTranslation(this.translations!, h)).length
          : selHashes.length;
        this.setActionDisabled(this.batchTranslateBtn, this.translating);
        this.batchTranslateBtn.setAttr(
          "aria-label",
          untranslated > 0
            ? `선택 영역의 미번역 문단 ${untranslated}개 번역`
            : `선택 영역 문단 ${selHashes.length}개 재번역`
        );
      } else {
        const untranslated = this.translations
          ? collectUntranslatedParagraphs(this.baselineText, this.translations)
              .length
          : 0;
        this.setActionDisabled(
          this.batchTranslateBtn,
          this.generation != null ||
            this.translating ||
            !enabled ||
            untranslated === 0
        );
        this.batchTranslateBtn.setAttr(
          "aria-label",
          untranslated > 0
            ? `번역 안 된 문단 ${untranslated}개 모두 번역`
            : "번역 안 된 문단 없음"
        );
      }
    }
    if (this.undoTranslateBtn) {
      this.undoTranslateBtn.toggleClass("is-hidden", !enabled);
      // 이 아이콘 하나가 탭=되돌리기/꾹=다시적용 겸용이라 둘 중 하나만
      // 가능해도 활성 상태로 둔다.
      const canAct =
        (this.translations?.undoStack?.length ?? 0) > 0 ||
        (this.translations?.redoStack?.length ?? 0) > 0;
      this.setActionDisabled(
        this.undoTranslateBtn,
        !enabled || this.generation != null || this.translating || !canAct
      );
    }
    if (this.galleryToolBtn) {
      // 삽화가 꺼져 있어도 이미 생성된 이미지가 있으면 갤러리는 계속 보여준다.
      const illustrationEnabled = this.session?.meta.illustration?.enabled === true;
      const hasImages = Object.keys(this.illustrations?.nodes ?? {}).length > 0;
      this.galleryToolBtn.toggleClass(
        "is-hidden",
        !illustrationEnabled && !hasImages
      );
    }
  }

  // --- 번역 보기 / 번역 실행 (translations.json — 문단 기준) ---

  /** 출력 방식(replace / split-h)에 따라 본문·번역 레이아웃 적용. */
  private applyDisplayMode(): void {
    this.flushTranslationEdits();
    if (this.outputMode === "split-h") {
      this.applySplitLayout();
    } else {
      this.applyReplaceLayout();
    }
    this.updateToolbar();
  }

  /** replace 모드 — 본문 영역에서 원문↔번역 토글(한 번에 하나만 표시). */
  private applyReplaceLayout(): void {
    this.teardownSplit();
    const active = this.translationViewActive;
    this.bodyEl?.toggleClass("is-hidden", active);
    this.translationEl?.toggleClass("is-active", active);
    if (active) this.renderTranslationBlocks();
  }

  /** split-h 모드 — 원문(좌) | 번역(우) 나란히 + 가운데 드래그 분할바. */
  private applySplitLayout(): void {
    if (!this.bodyWrapEl || !this.bodyEl || !this.translationEl) return;
    this.bodyWrapEl.addClass("is-split");
    this.bodyEl.removeClass("is-hidden");
    this.translationEl.addClass("is-active");
    this.ensureSplitHandle();
    this.applySplitRatio();
    this.renderTranslationBlocks();
  }

  /** split 모드 해제 — 분할바 제거 + wrap 클래스/인라인 너비 초기화. */
  private teardownSplit(): void {
    this.bodyWrapEl?.removeClass("is-split");
    this.splitHandleEl?.remove();
    this.splitHandleEl = null;
    if (this.bodyEl) this.bodyEl.style.flexBasis = "";
    if (this.translationEl) this.translationEl.style.flexBasis = "";
  }

  private ensureSplitHandle(): void {
    if (this.splitHandleEl || !this.bodyWrapEl || !this.translationEl) return;
    const handle = this.bodyWrapEl.createDiv({ cls: "ggai-session-split-handle" });
    // 분할바는 본문(좌)과 번역(우) 사이에 위치.
    this.bodyWrapEl.insertBefore(handle, this.translationEl);
    this.splitHandleEl = handle;
    handle.addEventListener("pointerdown", (e) => this.onSplitDragStart(e));

    // 스크롤 체인 토글 — 분할바 가운데 사슬 버튼. 켜져 있으면 한쪽을 스크롤할 때
    // 반대편도 같은 내용 위치로 따라온다.
    const chainBtn = handle.createEl("button", {
      cls: "ggai-btn ggai-icon-btn ggai-split-chain-btn",
    });
    const syncChainBtnUi = () => {
      setIcon(chainBtn, this.chainScroll ? "link" : "unlink");
      chainBtn.toggleClass("is-off", !this.chainScroll);
      chainBtn.setAttr(
        "aria-label",
        this.chainScroll ? "스크롤 연동 끄기" : "스크롤 연동 켜기"
      );
    };
    syncChainBtnUi();
    // 버튼 클릭이 분할바 드래그로 번지지 않게.
    chainBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    chainBtn.addEventListener("click", () => {
      this.chainScroll = !this.chainScroll;
      syncChainBtnUi();
      void this.plugin.savePluginData({
        translationScrollChain: this.chainScroll,
      });
      if (this.chainScroll) {
        // 켜는 즉시 번역 패널을 원문 위치에 맞춘다.
        this.syncLock = { source: "body", until: performance.now() + 150 };
        this.performSplitSync("body");
      }
    });
  }

  private applySplitRatio(): void {
    const left = Math.round(this.splitRatio * 1000) / 10;
    if (this.bodyEl) this.bodyEl.style.flexBasis = left + "%";
    if (this.translationEl) this.translationEl.style.flexBasis = 100 - left + "%";
  }

  private onSplitDragStart(e: PointerEvent): void {
    e.preventDefault();
    const wrap = this.bodyWrapEl;
    const handle = this.splitHandleEl;
    if (!wrap || !handle) return;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = wrap.getBoundingClientRect();
      if (rect.width <= 0) return;
      let ratio = (ev.clientX - rect.left) / rect.width;
      ratio = Math.min(0.8, Math.max(0.2, ratio));
      this.splitRatio = ratio;
      this.applySplitRatio();
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      // 분할바 위치 영속화 (전역 설정).
      void this.plugin.savePluginData({ translationSplitRatio: this.splitRatio });
      // 넓은 쪽이 바뀌었을 수 있으니 인라인 삽화를 다시 배치(넓은 쪽에만).
      this.renderInlineIllustrations();
      // 패널 너비가 바뀌어 줄바꿈이 달라졌으니 보던 노드를 다시 중앙에.
      if (this.lastAnchor) this.restoreToAnchor(this.lastAnchor);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  /** 보기 토글 버튼 — 전환 + 표시 상태를 media.json 에 세션별로 저장. */
  private async handleViewToggle(): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    await this.commitPending();
    // 원문↔번역 전환에도 보던 노드 위치를 유지.
    const anchor = this.currentAnchor();
    this.translationViewActive = !this.translationViewActive;
    this.applyDisplayMode();
    if (anchor) this.restoreToAnchor(anchor);
    await this.persistDisplayMode();
  }

  private async persistDisplayMode(): Promise<void> {
    if (!this.sessionFile) return;
    const media =
      this.translations ?? (await this.store.getSessionTranslations(this.sessionFile));
    media.displayMode = this.translationViewActive ? "translation" : "source";
    this.translations = media;
    await this.saveTranslationsSuppressed();
  }

  /** media 저장 — 자기 이벤트는 suppress (블록은 직접 갱신하므로). */
  private async saveTranslationsSuppressed(): Promise<void> {
    if (!this.sessionFile || !this.translations) return;
    this.suppressOwnTranslationsEvent = true;
    try {
      await this.store.saveSessionTranslations(this.sessionFile, this.translations);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice("번역 데이터 저장 실패: " + msg);
    } finally {
      this.suppressOwnTranslationsEvent = false;
    }
  }

  /**
   * 번역 보기 전체 구성 — 최종 본문을 문단 토큰으로 분해해 본문처럼 이어 붙인다.
   * 문단 구분자(줄바꿈)는 원문 구조 그대로 보존. active 번역이 있는 문단만 번역으로
   * 치환되고, 없는 문단은 원문이 그대로 보인다 (번역이 하나도 없으면 원문과 동일).
   *
   * 세션창은 편집기가 기본 모드: 문단 스팬을 그냥 고치면 그 문단의 새 번역 variant 로
   * 저장된다 (번역 없던 문단을 고치면 첫 variant). 개별 문단 재번역은 문단 재생성
   * 패널(문단 선택 모드 → 재번역 버튼)로 통합됐다. 스크롤 위치 보존.
   */
  private renderTranslationBlocks(): void {
    const root = this.translationEl;
    if (!root || !this.session) return;
    this.flushTranslationEdits();
    // split 모드에선 번역 패널(translationEl) 자체가 스크롤 컨테이너.
    const scroller =
      this.outputMode === "split-h"
        ? root
        : this.bodyWrapEl ?? this.contentEl;
    const scrollTop = scroller.scrollTop;

    root.empty();
    this.clearTranslationBlocks();

    // 번역 뷰 전체가 하나의 편집 영역 — 문단을 넘는 드래그 선택이 되고, 편집도
    // 본문과 똑같이 자연스럽다. 문단 텍스트는 편집 상태를 상속하고, 구분자(줄바꿈)와
    // 재번역 버튼은 contenteditable=false 원자 위젯이라 caret 이 그 안으로 들어가지
    // 않아 편집이 항상 문단 안에서만 일어난다.
    const editEl = root.createEl("div", { cls: "ggai-tr-edit" });
    editEl.setAttr("contenteditable", "plaintext-only");
    editEl.setAttr("spellcheck", "false");
    this.translationEditEl = editEl;
    editEl.addEventListener("input", () => this.scheduleTranslationCommit());
    editEl.addEventListener("blur", () => this.flushTranslationEdits());

    let docOffset = 0;
    for (const token of tokenizeParagraphs(this.baselineText)) {
      if (token.kind === "separator") {
        const sep = editEl.createEl("span", { cls: "ggai-tr-sep" });
        sep.setAttr("contenteditable", "false");
        sep.setText(token.text);
        docOffset += token.text.length;
        continue;
      }
      const active = this.translations
        ? getActiveTranslation(this.translations, token.hash)
        : null;
      // 빈(공백뿐인) 번역은 없는 것으로 취급 — 원문을 보여주고 재번역 대상에 남긴다.
      const translated = !!active && active.text.trim() !== "";
      const rawText = translated ? active!.text : token.source;
      // 원문 본문과 동일하게 매크로 치환 + 인라인 마크다운을 입혀 보여준다.
      // - 매크로: {{user}} 등을 표시값으로 치환. 미번역 문단은 치환된 원문이 보인다.
      // - 마크다운: 마커(*, _, `)는 지우지 않고 ggai-md-marker(font-size:0) span 으로만
      //   접어 textContent(=편집 비교/저장 기준) 길이를 그대로 보존한다.
      // baseline 을 "표시 텍스트"로 두어야 el.textContent 와 일치해 미편집 문단이
      // 저장으로 오인되지 않는다. 편집 후 저장되는 variant text 도 이 표시 텍스트다.
      const baseline = applyMacros(rawText, this.displayMacroCtx);

      const span = editEl.createEl("span", {
        cls: "ggai-tr-paragraph",
        attr: { "data-paragraph-hash": token.hash },
      });
      this.appendMarkdownRun(span, baseline, "", false);

      const block = {
        hash: token.hash,
        source: token.source,
        baseline,
        offset: docOffset,
        el: span,
        timer: null as number | null,
      };
      docOffset += token.source.length;
      this.translationBlocks.push(block);
      // 개별 문단 재번역은 문단 재생성 패널(문단 선택 모드 → 재번역 버튼)로 통합됐다.
    }
    // 인라인 삽화(번역 패널) — 스크롤 복원 전에 꽂아 높이를 이전과 같게.
    this.renderInlineIllustrations();
    this.renderAiStartMarkerTranslation();
    scroller.scrollTop = scrollTop;
  }

  private clearTranslationBlocks(): void {
    if (this.translationCommitTimer != null) {
      window.clearTimeout(this.translationCommitTimer);
      this.translationCommitTimer = null;
    }
    this.translationBlocks = [];
    this.translationEditEl = null;
  }

  /** 편집 영역 입력 → 디바운스 후 바뀐 문단만 커밋. */
  private scheduleTranslationCommit(): void {
    if (this.translationCommitTimer != null) {
      window.clearTimeout(this.translationCommitTimer);
    }
    this.translationCommitTimer = window.setTimeout(() => {
      this.translationCommitTimer = null;
      this.flushTranslationEdits();
    }, IDLE_COMMIT_MS);
  }

  /**
   * 문단 스팬의 현재 텍스트를 새 user-edit 번역 variant 로 기록 (translations 동기 변경).
   * 변경이 없으면 false. 저장(saveTranslationsSuppressed)은 호출자가 처리.
   */
  private commitTranslationEditSync(block: {
    hash: string;
    source: string;
    baseline: string;
    el: HTMLElement;
    timer: number | null;
  }): boolean {
    if (!this.translations) return false;
    // 편집 영역에서 떨어져 나간 스팬(브라우저 정규화)은 읽지 않는다 — 오독으로 번역이
    // 통째로 지워지던 회귀 방지.
    if (this.translationEditEl && !this.translationEditEl.contains(block.el)) {
      return false;
    }
    // 재번역 버튼(svg 아이콘뿐)은 textContent 에 안 잡히므로 문단 텍스트만 읽힌다.
    const text = block.el.textContent ?? "";
    if (text === block.baseline) return false;
    // 내용이 있던 문단이 빈 값으로 바뀌는 건 정규화 아티팩트로 보고 저장하지 않는다.
    if (text.trim() === "" && block.baseline.trim() !== "") return false;
    recordTranslationVariant(this.translations, {
      source: block.source,
      text,
      kind: "user-edit",
    });
    block.baseline = text;
    return true;
  }

  /** 모든 문단의 미저장 편집을 variant 로 커밋 + 1회 저장. 보기 전환/재구성/닫기 직전 호출. */
  private flushTranslationEdits(): void {
    if (this.translationCommitTimer != null) {
      window.clearTimeout(this.translationCommitTimer);
      this.translationCommitTimer = null;
    }
    let changed = false;
    for (const block of this.translationBlocks) {
      if (this.commitTranslationEditSync(block)) changed = true;
    }
    if (changed) {
      void this.saveTranslationsSuppressed();
      this.updateViewToggleBtn();
    }
  }

  /**
   * 현재 드래그 선택 영역과 겹치는 문단 해시 목록 (문서 순서).
   * 원문 본문 선택 = 텍스트 offset 으로 문단 매핑, 번역 패널 선택 = 문단 블록 교차.
   * 선택이 없거나 본문/번역 밖이면 빈 배열.
   */
  private getSelectionParagraphHashes(): string[] {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
    const range = sel.getRangeAt(0);

    // 번역 패널 — 렌더된 문단 블록과의 교차로 판정.
    if (this.translationEl?.contains(range.commonAncestorContainer)) {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const block of this.translationBlocks) {
        if (range.intersectsNode(block.el) && !seen.has(block.hash)) {
          seen.add(block.hash);
          out.push(block.hash);
        }
      }
      return out;
    }

    // 원문 본문 — 선택 구간의 표시 offset 을 원문 offset 으로 바꿔 문단 토큰에 매핑.
    // (본문은 매크로가 치환된 표시 텍스트라 baselineText 와 offset 이 다를 수 있다.)
    const body = this.bodyEl;
    if (!body || !body.contains(range.commonAncestorContainer)) return [];
    const pre = range.cloneRange();
    pre.selectNodeContents(body);
    pre.setEnd(range.startContainer, range.startOffset);
    const displayStart = pre.toString().length;
    const start = this.displayToRawOffset(displayStart);
    const end = this.displayToRawOffset(
      displayStart + range.toString().length
    );
    const seen = new Set<string>();
    const out: string[] = [];
    let offset = 0;
    for (const token of tokenizeParagraphs(this.baselineText)) {
      const len =
        token.kind === "separator" ? token.text.length : token.source.length;
      const tokenEnd = offset + len;
      if (
        token.kind === "paragraph" &&
        offset < end &&
        tokenEnd > start &&
        !seen.has(token.hash)
      ) {
        seen.add(token.hash);
        out.push(token.hash);
      }
      offset = tokenEnd;
      if (offset >= end) break;
    }
    return out;
  }

  /**
   * 일괄 번역 버튼 — 드래그 선택이 있으면 선택 영역만:
   *  - 선택에 미번역 문단이 있으면 그 문단들만 번역
   *  - 전부 번역돼 있으면 선택 문단 전체 재번역 (새 variant, 되돌리기 한 단계)
   * 선택이 없으면 기존 동작 (미번역 문단 전부, 분량 크면 확인).
   */
  private async handleBatchTranslateClick(): Promise<void> {
    if (!this.session || !this.sessionFile || this.translating) return;
    const selHashes = this.getSelectionParagraphHashes();
    if (selHashes.length === 0) {
      await this.commitPending();
      await this.runTranslate();
      return;
    }
    const translations =
      this.translations ??
      (await this.store.getSessionTranslations(this.sessionFile));
    const untranslated = selHashes.filter(
      (h) => !hasTranslation(translations, h)
    );
    await this.commitPending();
    await this.runTranslate({
      hashes: untranslated.length > 0 ? untranslated : selHashes,
    });
  }

  /** 번역 버튼 탭 — 번역 안 된 문단 일괄 번역. */
  private async handleTranslateTap(): Promise<void> {
    if (!this.session || this.session.meta.translation?.enabled !== true) return;
    await this.commitPending();
    await this.runTranslate();
  }

  /**
   * 방금 한 번역 되돌리기 — 스택 맨 위 실행을 한 단계 되돌린다.
   * 되돌린 문단은 이전 번역(있으면) 또는 "번역 안 됨"으로 돌아가, 기존 문단별
   * 재번역/일괄 번역으로 다시 번역할 수 있다. 원문 노드는 건드리지 않는다.
   */
  private async handleUndoTranslate(): Promise<void> {
    if (!this.sessionFile || this.translating) return;
    this.flushTranslationEdits();
    const translations =
      this.translations ??
      (await this.store.getSessionTranslations(this.sessionFile));
    const result = undoLastTranslation(translations);
    if (!result) {
      new Notice("되돌릴 번역이 없습니다.");
      return;
    }
    this.translations = translations;
    await this.saveTranslationsSuppressed();
    if (this.translationViewActive || this.outputMode === "split-h") {
      this.renderTranslationBlocks();
    }
    this.updateViewToggleBtn();
    new Notice(
      result.revertedHashes.length > 0
        ? `번역 ${result.revertedHashes.length}개 문단 되돌림`
        : "되돌림 (변경 없음)"
    );
  }

  /** 방금 되돌린 번역을 다시 적용 — undo 의 짝. */
  private async handleRedoTranslate(): Promise<void> {
    if (!this.sessionFile || this.translating) return;
    this.flushTranslationEdits();
    const translations =
      this.translations ??
      (await this.store.getSessionTranslations(this.sessionFile));
    const result = redoLastTranslation(translations);
    if (!result) {
      new Notice("다시 적용할 번역이 없습니다.");
      return;
    }
    this.translations = translations;
    await this.saveTranslationsSuppressed();
    if (this.translationViewActive || this.outputMode === "split-h") {
      this.renderTranslationBlocks();
    }
    this.updateViewToggleBtn();
    new Notice(
      result.restoredHashes.length > 0
        ? `번역 ${result.restoredHashes.length}개 문단 다시 적용`
        : "다시 적용 (변경 없음)"
    );
  }

  /** 번역 버튼 꾹 — 자동 번역 on/off. 활성 설정(세션 메타/프리셋 연동)에 저장. */
  private async handleAutoTranslateToggle(): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    const current = this.session.meta.translation ?? {};
    if (current.enabled !== true) return;
    const translation = { ...current, auto: current.auto !== true };
    // 낙관적 갱신 — 삽화 토글과 같은 이유(동기화 폴더 저장 지연으로 UI 를 막지 않는다).
    this.session.meta.translation = translation;
    this.updateToolbar();
    new Notice(translation.auto ? "자동 번역 켜짐" : "자동 번역 꺼짐");
    this.suppressOwnSessionEvent = true;
    try {
      await this.plugin.patchActiveSettings({ translation }, this.sessionFile);
    } finally {
      this.suppressOwnSessionEvent = false;
    }
  }

  /**
   * 새 본문 생성 직후 자동 번역 (번역 사용 + 자동 번역 둘 다 on 일 때).
   * **이번 생성으로 새로 생긴/바뀐 구간의 문단만** 대상 — 과거의 번역 안 된
   * 본문 전체를 자동으로 보내지 않는다. 번역할 문단이 없으면 조용히 skip.
   */
  private async maybeAutoTranslate(generationStartOffset: number): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    const t = this.session.meta.translation;
    if (t?.enabled !== true || t?.auto !== true) return;
    const translations =
      this.translations ??
      (await this.store.getSessionTranslations(this.sessionFile));
    const targets = collectUntranslatedParagraphsFrom(
      this.baselineText,
      translations,
      generationStartOffset
    );
    if (targets.length === 0) return;
    await this.runTranslate({ hashes: targets.map((p) => p.hash) });
  }

  // --- 삽화 (illustrations.json — 노드 기준, 인라인 표시) ---

  /** 삽화 버튼 탭 — 현재 활성 노드(최신)의 삽화 생성. */
  private async handleIllustrateTap(): Promise<void> {
    if (!this.session || this.session.meta.illustration?.enabled !== true) return;
    await this.commitPending();
    await this.runIllustrate();
  }

  /** 삽화 버튼 꾹 — 자동 삽화 on/off. */
  private async handleAutoIllustrateToggle(): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    const current = this.session.meta.illustration ?? {};
    if (current.enabled !== true) return;
    const illustration = { ...current, auto: current.auto !== true };
    // 낙관적 갱신 — 버튼 스타일/알림은 즉시. 저장(session.json 전체 + 플러그인 데이터)은
    // 동기화 폴더에서 불규칙하게 느릴 수 있으므로 UI 를 막지 않고 백그라운드로 넘긴다.
    // this.session 은 store 캐시와 같은 객체라 patchActiveSettings 가 같은 patch 로
    // 다시 써도 정합성이 유지된다.
    this.session.meta.illustration = illustration;
    this.updateToolbar();
    new Notice(illustration.auto ? "자동 삽화 켜짐" : "자동 삽화 꺼짐");
    this.suppressOwnSessionEvent = true;
    try {
      await this.plugin.patchActiveSettings({ illustration }, this.sessionFile);
    } finally {
      this.suppressOwnSessionEvent = false;
    }
  }

  /** 새 원문 노드 생성 직후 자동 삽화 (삽화 사용 + 자동 둘 다 on 일 때). */
  private async maybeAutoIllustrate(nodeId: string): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    const i = this.session.meta.illustration;
    if (i?.enabled !== true || i?.auto !== true) return;
    // 자동 생성 주기 — 마지막 삽화 앵커 이후 완성 문단이 설정한 개수 이상 쌓였을
    // 때만 생성(출력 위치와 무관). 카운터를 저장하지 않고 매번 현재 브랜치 기준으로
    // 계산하므로 분기 이동/편집으로 어긋나지 않는다. 수동(툴바 탭)은 이 게이트를 타지
    // 않는다. 0 = 매 이어쓰기 완료마다 생성(게이트 없음).
    const threshold = i.autoMinParagraphs ?? DEFAULT_ILLUSTRATION_AUTO_MIN_PARAGRAPHS;
    if (threshold > 0) {
      const illustrations =
        this.illustrations ??
        (await this.store.getSessionIllustrations(this.sessionFile));
      const anchors = computeIllustrationAnchors(this.session, illustrations);
      const last = anchors.length > 0 ? anchors[anchors.length - 1].offset : 0;
      const fresh = completedParagraphsAfter(this.baselineText, last);
      if (fresh < threshold) return;
    }
    await this.runIllustrate(nodeId);
  }

  /** 삽화 생성 (툴바 탭 / 자동) — 프롬프트 생성부터. 대상 노드 생략 시 활성 노드. */
  private async runIllustrate(nodeId?: string): Promise<void> {
    await this.runIllustrationJob(() =>
      this.plugin.illustration.generateForNode(this.sessionFile!, nodeId)
    );
  }

  /** 재생성 UI 에서 다듬은 프롬프트로 재생성 → 이 노드의 새 삽화 variant. */
  private openIllustrationRegen(nodeId: string): void {
    const active = this.illustrations
      ? getActiveIllustration(this.illustrations, nodeId)
      : null;
    new IllustrationRegenModal(this.app, {
      prompt: active?.prompt ?? "",
      negativePrompt: active?.negativePrompt ?? "",
      onSubmit: (prompt, negativePrompt) =>
        void this.runIllustrationJob(() =>
          this.plugin.illustration.regenWithPrompt(this.sessionFile!, nodeId, {
            prompt,
            negativePrompt,
          })
        ),
    }).open();
  }

  /** 삽화 생성 작업 공통 래퍼 — busy 표시 + 결과 처리 + 갱신. */
  private async runIllustrationJob(
    job: () => Promise<{ ok: boolean; errors: string[] }>
  ): Promise<void> {
    if (!this.session || !this.sessionFile || this.illustrating) return;
    if (!this.ai.isAvailable()) {
      new Notice("GGAI Core 가 설치/활성화되어 있지 않습니다.");
      return;
    }
    this.illustrating = true;
    this.updateToolbar();
    try {
      const result = await job();
      if (!result.ok) {
        new Notice("삽화 생성 실패: " + (result.errors[0] ?? "알 수 없는 오류"));
      } else {
        await this.refreshIllustrations();
      }
    } finally {
      this.illustrating = false;
      this.updateToolbar();
      // 생성 직후 삽화가 붙어도 읽던 위치가 밀리지 않게 고정한다.
      this.preserveReadingPosition(() => this.renderInlineIllustrations());
    }
  }

  /** store 에서 삽화 다시 읽고 인라인 표시 갱신. 출력 뷰는 자체 이벤트로 갱신됨. */
  private async refreshIllustrations(): Promise<void> {
    if (!this.sessionFile) {
      this.illustrations = null;
    } else {
      this.illustrations = await this.store.getSessionIllustrations(
        this.sessionFile
      );
    }
    // 삽화가 붙거나 바뀌어도 읽던 위치가 밀리지 않게 고정한다.
    this.preserveReadingPosition(() => this.renderInlineIllustrations());
    // 갤러리 버튼 노출 여부(삽화 비활성이어도 기존 이미지가 있으면 표시)가
    // illustrations 개수에 달려 있으므로 갱신.
    this.updateViewToggleBtn();
  }

  private resolveIllustrationSrc(v: IllustrationVariant): string | null {
    const file = this.app.vault.getAbstractFileByPath(
      `${this.sessionFolderPath()}/${v.path}`
    );
    return file instanceof TFile ? this.app.vault.getResourcePath(file) : null;
  }

  private async selectIllustrationVariant(
    nodeId: string,
    variantId: string
  ): Promise<void> {
    if (!this.sessionFile || !this.illustrations) return;
    // 캐러셀이 이미 로컬 슬라이드했으므로 in-place 갱신 + 자기 이벤트 suppress(재렌더 방지).
    if (!setActiveIllustrationVariant(this.illustrations, nodeId, variantId)) return;
    this.suppressOwnIllustrationsEvent = true;
    try {
      await this.store.saveSessionIllustrations(this.sessionFile, this.illustrations);
    } finally {
      this.suppressOwnIllustrationsEvent = false;
    }
  }

  /**
   * 인라인 삽화 배치 — 앵커(문단 경계)는 저장하지 않고 렌더 시점에 계산한다
   * (`computeIllustrationAnchors`, 누적 표시: 활성 경로의 삽화 전부).
   * 위젯은 텍스트 0글자의 contenteditable=false 원자 블록이라 본문 diff/offset/caret 에
   * 영향이 없고, 텍스트 노드를 건드리지 않으므로 재배치해도 편집·스크롤이 보존된다.
   * 생성(스트리밍) 중에는 배치하지 않는다 — 끝나면 renderBodySpans 경유로 재배치.
   */
  private renderInlineIllustrations(): void {
    if (this.generation) return;
    // 위젯 제거·재삽입은 문서 선택영역이 걸쳐 있는 본문 서브트리를 건드린다 —
    // 어딘가에서 조합 중이면 조합이 끝난 뒤로 미룬다 (입력 마비 회귀 금지).
    if (
      this.deferWhileComposing("inline-illus", () =>
        this.renderInlineIllustrations()
      )
    ) {
      return;
    }
    for (const el of this.inlineIllusEls) el.remove();
    this.inlineIllusEls = [];
    if (!this.session || !this.sessionFile || !this.illustrations) return;
    const ill = this.session.meta.illustration;
    if (ill?.enabled !== true) return;
    const output = resolveIllustrationOutput(ill.output);
    if (output !== "inline") return;
    const anchors = computeIllustrationAnchors(this.session, this.illustrations);
    if (anchors.length === 0) return;
    // 2분할(split-h)로 원문·번역 두 패널이 동시에 보일 때는 넓은 쪽에만 배치한다
    // (좁은 쪽엔 안 넣음 — 분할바를 넓혀둔 쪽이 곧 주로 읽는 쪽). 폭이 같으면 번역 쪽.
    // 그 외(원문 치환/번역 미사용)는 양쪽에 배치해 토글해도 항상 보이게 한다.
    const translationEnabled = this.session.meta.translation?.enabled === true;
    const splitMode = translationEnabled && this.outputMode === "split-h";
    if (splitMode) {
      // splitRatio = 좌측(원문) 너비 비율. 0.5 초과면 원문이 넓다.
      if (this.splitRatio > 0.5) this.placeInlineInBody(anchors);
      else this.placeInlineInTranslation(anchors);
    } else {
      this.placeInlineInBody(anchors);
      if (this.translationEditEl) this.placeInlineInTranslation(anchors);
    }
  }

  /**
   * 가장 최근 AI 생성 텍스트 시작 지점에 다섯 잎 꽃 마커를 꽂는다 — 텍스트 0글자
   * contenteditable=false 원자 위젯이라 본문 diff/offset/caret 에 영향 없다(인라인 삽화와
   * 같은 원리). 위치는 저장하지 않고 매번 `computeLatestAiMarkerOffset` 로 다시 계산한다.
   * 생성(스트리밍) 중에는 배치하지 않는다 — 끝나면 renderBodySpans 로 재배치.
   */
  private renderAiStartMarker(): void {
    if (this.generation) return;
    if (
      this.deferWhileComposing("ai-start-marker", () => this.renderAiStartMarker())
    ) {
      return;
    }
    this.aiStartMarkerEl?.remove();
    this.aiStartMarkerEl = null;
    const body = this.bodyEl;
    if (!body || !this.session) return;
    const rawOffset = computeLatestAiMarkerOffset(this.session);
    if (rawOffset === null) return;
    const target = this.rawOffsetToDisplayOffset(rawOffset);
    let ref: Node | null = null;
    let acc = 0;
    for (const child of Array.from(body.childNodes)) {
      const isWidget =
        child instanceof HTMLElement &&
        (child.hasClass("ggai-inline-illustration") ||
          child.hasClass("ggai-ai-start-marker"));
      if (acc >= target && !isWidget) {
        ref = child;
        break;
      }
      acc += child.textContent?.length ?? 0;
    }
    const el = this.createAiStartMarkerEl();
    body.insertBefore(el, ref);
    this.aiStartMarkerEl = el;
  }

  /** 다섯 잎 꽃 마커 엘리먼트 — 텍스트 0글자 contenteditable=false 원자 위젯. */
  private createAiStartMarkerEl(): HTMLElement {
    const el = document.createElement("span");
    el.classList.add("ggai-ai-start-marker");
    el.setAttribute("contenteditable", "false");
    el.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 5; i++) el.appendChild(document.createElement("i"));
    return el;
  }

  /**
   * 번역 뷰에 AI 시작 마커를 꽂는다 — 원문 패널과 같은 위치(가장 최근 AI 노드
   * 시작 문단 앞)에. 인라인 삽화와 같은 원자 위젯이라 편집/caret/스크롤에 영향 없다.
   * 생성 중에는 배치하지 않는다.
   */
  private renderAiStartMarkerTranslation(): void {
    this.aiStartMarkerTrEl?.remove();
    this.aiStartMarkerTrEl = null;
    if (this.generation) return;
    const editEl = this.translationEditEl;
    if (!editEl || !this.session) return;
    const rawOffset = computeLatestAiMarkerOffset(this.session);
    if (rawOffset === null) return;
    const block = this.translationBlocks.find((b) => b.offset >= rawOffset);
    const el = this.createAiStartMarkerEl();
    editEl.insertBefore(el, block?.el ?? null);
    this.aiStartMarkerTrEl = el;
  }

  /** 원문 본문에 인라인 위젯 삽입 — raw 앵커를 표시 offset 으로 바꿔 스팬 경계에. */
  private placeInlineInBody(anchors: IllustrationAnchor[]): void {
    const body = this.bodyEl;
    if (!body) return;
    for (const anchor of anchors) {
      const target = this.rawOffsetToDisplayOffset(anchor.offset);
      // 앵커는 항상 문단 시작이라 스팬 경계에 떨어진다. 이미 꽂힌 위젯(0글자)은
      // 누적 길이에 영향이 없고, 같은 위치에선 위젯 뒤에 이어 붙어 순서를 지킨다.
      let ref: Node | null = null;
      let acc = 0;
      for (const child of Array.from(body.childNodes)) {
        const isWidget =
          child instanceof HTMLElement &&
          child.hasClass("ggai-inline-illustration");
        if (acc >= target && !isWidget) {
          ref = child;
          break;
        }
        acc += child.textContent?.length ?? 0;
      }
      const el = this.createInlineIllustrationEl(anchor.nodeId);
      body.insertBefore(el, ref);
      this.inlineIllusEls.push(el);
    }
  }

  /** 번역 편집 영역에 인라인 위젯 삽입 — 앵커 이후 첫 문단 블록 앞에. */
  private placeInlineInTranslation(anchors: IllustrationAnchor[]): void {
    const editEl = this.translationEditEl;
    if (!editEl) return;
    for (const anchor of anchors) {
      const block = this.translationBlocks.find(
        (b) => b.offset >= anchor.offset
      );
      const el = this.createInlineIllustrationEl(anchor.nodeId);
      editEl.insertBefore(el, block?.el ?? null);
      this.inlineIllusEls.push(el);
    }
  }

  /** 인라인 삽화 위젯 — 출력 뷰와 같은 캐러셀(variant 넘김/라이트박스/재생성) 재사용. */
  private createInlineIllustrationEl(nodeId: string): HTMLElement {
    const el = document.createElement("div");
    el.classList.add("ggai-inline-illustration");
    el.setAttribute("contenteditable", "false");
    el.dataset.illustNode = nodeId;
    const carouselEl = document.createElement("div");
    el.appendChild(carouselEl);
    new IllustrationCarousel(carouselEl, {
      resolveSrc: (v) => this.resolveIllustrationSrc(v),
      getVariants: () =>
        this.illustrations
          ? listIllustrationVariants(this.illustrations, nodeId)
          : [],
      getActiveId: () =>
        this.illustrations
          ? getActiveIllustration(this.illustrations, nodeId)?.id ?? null
          : null,
      onSelect: (variantId) =>
        void this.selectIllustrationVariant(nodeId, variantId),
      onRegen: () => this.openIllustrationRegen(nodeId),
      isBusy: () => this.illustrating,
      isFavorite: (v) => !!v.favorite,
      onToggleFavorite: (variantId) =>
        this.toggleIllustrationFavoriteFor(nodeId, variantId),
    });
    return el;
  }

  /** 삽화 variant 즐겨찾기 토글 — 동기 반영 + 자기 이벤트 무시 저장. */
  private toggleIllustrationFavoriteFor(
    nodeId: string,
    variantId: string
  ): boolean {
    if (!this.sessionFile || !this.illustrations) return false;
    const next = toggleIllustrationFavorite(this.illustrations, nodeId, variantId);
    this.suppressOwnIllustrationsEvent = true;
    void this.store
      .saveSessionIllustrations(this.sessionFile, this.illustrations)
      .finally(() => {
        this.suppressOwnIllustrationsEvent = false;
      });
    return next;
  }

  /** 이 세션의 모든 삽화 variant 를 갤러리 팝업으로 (이동/삭제 가능). */
  private openGallery(): void {
    const items: GalleryItem[] = [];
    const nodes = this.illustrations?.nodes ?? {};
    for (const [nodeId, entry] of Object.entries(nodes)) {
      for (const v of Object.values(entry.variants)) {
        const src = this.resolveIllustrationSrc(v);
        if (src)
          items.push({
            src,
            nodeId,
            variantId: v.id,
            createdAt: v.createdAt,
            favorite: v.favorite,
          });
      }
    }
    new IllustrationGalleryModal(this.app, {
      items,
      onJump: (nodeId) => void this.jumpToIllustrationNode(nodeId),
      onDelete: (nodeId, variantId) => this.deleteIllustration(nodeId, variantId),
      onToggleFavorite: (nodeId, variantId) =>
        this.toggleIllustrationFavoriteFor(nodeId, variantId),
    }).open();
  }

  /** 갤러리에서 선택한 삽화의 원문 노드로 이동 + 그 위치로 스크롤. */
  private async jumpToIllustrationNode(nodeId: string): Promise<void> {
    if (!this.session || !this.sessionFile || this.generation) return;
    if (!this.session.nodes[nodeId]) return;
    await this.commitPending();
    const leaf =
      getDeepestLatestDescendant(this.session, nodeId) ??
      this.session.nodes[nodeId];
    this.session.meta.activeLeafId = leaf.id;
    this.redoStack = [];
    await this.afterLeafChange();
    this.focusIllustrationNode(nodeId);
  }

  /** 갤러리에서 삽화 variant 하나 삭제 (asset PNG 도 휴지통으로). */
  private async deleteIllustration(
    nodeId: string,
    variantId: string
  ): Promise<void> {
    if (!this.sessionFile || !this.illustrations) return;
    const removed = removeIllustrationVariant(
      this.illustrations,
      nodeId,
      variantId
    );
    if (!removed) return;
    // 자기 변경 이벤트는 무시 — 디스크 재로딩/전체 재렌더 폭주를 막고(모바일 멈춤 원인)
    // in-memory 상태를 그대로 유지해 연속 삭제도 일관되게 동작한다.
    this.suppressOwnIllustrationsEvent = true;
    try {
      await this.store.saveSessionIllustrations(this.sessionFile, this.illustrations);
      await this.store.deleteSessionAsset(this.sessionFile, removed.path);
    } finally {
      this.suppressOwnIllustrationsEvent = false;
    }
    // 인라인 표시만 국소 갱신 (삭제된 variant 반영). 출력 뷰는 자체 이벤트로 갱신됨.
    this.renderInlineIllustrations();
  }

  private sessionFolderPath(): string {
    return this.sessionFile
      ? this.sessionFile.slice(0, -"/session.json".length)
      : "";
  }

  /**
   * 번역 실행 공통 경로 (툴바 탭 / 자동 / 일괄 버튼 / 재생성 패널 재번역).
   * hashes 없으면 번역 안 된 문단 전부 — 분량이 크면 실행 전 확인을 받는다
   * (번역을 처음 켠 긴 세션에서 실수로 전체 텍스트를 보내는 사고 방지).
   * 성공 시 번역 보기로 자동 전환.
   */
  /**
   * 번역 진행 중 — 지금까지 저장된 번역을 다시 읽어 완료분을 즉시 표시한다.
   * 원문 치환 모드에서 번역 보기로의 전환은 여기서 하지 않는다 — 전환은 작업(한
   * 청크든 전체든) 이 모두 끝난 뒤 runTranslate 쪽에서만 일어난다. 이미 번역 보기
   * 중이거나 2분할이면 완료된 문단을 실시간으로 반영한다.
   */
  private async renderTranslatedSoFar(): Promise<void> {
    if (!this.sessionFile) return;
    this.translations = await this.store.getSessionTranslations(this.sessionFile);
    if (this.translationViewActive) {
      const anchor = this.currentAnchor();
      this.applyDisplayMode();
      if (anchor) this.restoreToAnchor(anchor);
    } else if (this.outputMode === "split-h") {
      this.renderTranslationBlocks();
    }
  }

  private async runTranslate(
    opts?: { hashes?: string[] }
  ): Promise<TranslateResult | undefined> {
    if (!this.session || !this.sessionFile || this.translating) return undefined;
    if (!this.ai.isAvailable()) {
      new Notice("GGAI Core 가 설치/활성화되어 있지 않습니다.");
      return undefined;
    }
    let effectiveOpts = opts;
    if (!opts?.hashes) {
      const translations =
        this.translations ??
        (await this.store.getSessionTranslations(this.sessionFile));
      const targets = collectUntranslatedParagraphs(
        this.baselineText,
        translations
      );
      const chars = targets.reduce((n, p) => n + p.source.length, 0);
      if (
        targets.length > TRANSLATE_CONFIRM_PARAGRAPHS ||
        chars > TRANSLATE_CONFIRM_CHARS
      ) {
        const choice = await new Promise<string | null>((resolve) => {
          new ChoiceModal(
            this.app,
            "일괄 번역 확인",
            `번역 안 된 문단이 ${targets.length}개 (약 ${chars.toLocaleString()}자) 있습니다. 얼마나 번역할까요?`,
            [
              {
                text: `최근 문단 ${TRANSLATE_CONFIRM_PARAGRAPHS}개만`,
                value: "recent",
                cta: true,
              },
              { text: "전체 번역", value: "all", warning: true },
            ],
            resolve
          ).open();
        });
        if (!choice) return undefined;
        if (choice === "recent") {
          effectiveOpts = {
            hashes: targets
              .slice(-TRANSLATE_CONFIRM_PARAGRAPHS)
              .map((p) => p.hash),
          };
        } else if (targets.length >= TRANSLATE_FULL_WARN_PARAGRAPHS) {
          // 전체 번역이 정말 큰 경우 한 번 더 경고.
          const reallyAll = await new Promise<boolean>((resolve) => {
            new ConfirmModal(
              this.app,
              "전체 번역 확인",
              `문단 ${targets.length}개 (약 ${chars.toLocaleString()}자)를 전부 번역합니다. 요청은 나눠서 순차 전송되고 진행분은 즉시 저장됩니다. 정말 진행할까요?`,
              "전체 번역",
              resolve
            ).open();
          });
          if (!reallyAll) return undefined;
        }
      }
    }
    this.flushTranslationEdits();
    this.translating = true;
    this.updateToolbar();
    this.suppressOwnTranslationsEvent = true;
    const progress: { notice: Notice | null } = { notice: null };
    try {
      const result = await this.plugin.translation.translateParagraphs(
        this.sessionFile,
        {
          ...effectiveOpts,
          onProgress: (done, total) => {
            // 청크가 끝날 때마다 완료분을 바로 화면에 반영 (전체 끝날 때까지 대기 X).
            void this.renderTranslatedSoFar();
            if (total <= 8) return; // 청크 1개 분량이면 진행 표시 생략
            if (!progress.notice) progress.notice = new Notice("", 0);
            progress.notice.setMessage(`번역 중... ${done}/${total} 문단`);
          },
        }
      );
      // 부분 성공도 표시에 반영 (청크 단위로 이미 저장돼 있음).
      if (result.updatedHashes.length > 0) {
        const anchor = this.currentAnchor();
        this.translations = await this.store.getSessionTranslations(this.sessionFile);
        this.translationViewActive = true;
        this.translations.displayMode = "translation";
        await this.store.saveSessionTranslations(this.sessionFile, this.translations);
        this.applyDisplayMode();
        if (anchor) this.restoreToAnchor(anchor);
      }
      if (result.cancelled) {
        new Notice("번역을 취소했습니다.");
      } else if (!result.ok) {
        new Notice("번역 실패: " + (result.errors[0] ?? "알 수 없는 오류"));
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice("번역 실패: " + msg);
      return undefined;
    } finally {
      progress.notice?.hide();
      this.suppressOwnTranslationsEvent = false;
      this.translating = false;
      this.updateToolbar();
    }
  }

  // --- 문단 재생성 (문단 선택 모드 → 재생성 패널 → 승인 시 user-edit 노드 파생) ---

  /** 툴바 문단 재생성 버튼 — 문단 선택 모드 on/off. */
  private async toggleParaSelectMode(): Promise<void> {
    if (!this.session || this.generation) return;
    if (this.paraSelectMode) {
      this.exitParaSelectMode();
      return;
    }
    await this.commitPending();
    this.paraSelectMode = true;
    this.bodyWrapEl?.addClass("ggai-para-select-mode");
    this.updateToolbar();
    new Notice("재생성할 문단을 클릭/탭하세요.");
  }

  private exitParaSelectMode(): void {
    if (!this.paraSelectMode) return;
    this.paraSelectMode = false;
    this.bodyWrapEl?.removeClass("ggai-para-select-mode");
    this.updateToolbar();
  }

  /** 선택 모드 중 본문/번역 클릭 → 문단 매핑 → 재생성 패널. 문단 밖 클릭은 모드 유지. */
  private onParaSelectClick(e: MouseEvent): void {
    if (!this.paraSelectMode) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = this.paragraphIndexAtPoint(e);
    if (idx == null) return;
    // 패널이 닫히면(취소/승인 모두) 선택 모드도 함께 꺼진 상태여야 한다 — 여기서 끈다.
    this.exitParaSelectMode();
    this.openParagraphRegen(idx);
  }

  /**
   * 클릭 지점 → baseline 문단 인덱스. 원문 = caret offset, 번역 패널 = 문단 블록.
   * 텍스트뿐 아니라 좌우 여백·문단 사이 공백·본문 배경을 눌러도 가장 가까운 문단을 잡는다.
   */
  private paragraphIndexAtPoint(e: MouseEvent): number | null {
    const target = e.target as Node;
    const ranges = listParagraphRanges(this.baselineText);
    if (ranges.length === 0) return null;
    // 번역 패널(번역 보기/split) — 클릭된 문단 블록의 baseline offset 으로 매핑.
    if (this.translationEl?.contains(target)) {
      for (const block of this.translationBlocks) {
        if (block.el === target || block.el.contains(target)) {
          return paragraphIndexAtOffset(ranges, block.offset);
        }
      }
      // 편집 영역 배경/구분자·여백 클릭 — y 좌표로 가장 가까운 문단 블록.
      const block = this.nearestTranslationBlock(e.clientY);
      return block ? paragraphIndexAtOffset(ranges, block.offset) : null;
    }
    // 원문 본문 — 본문 래퍼 안 클릭이면 처리 (배경/여백 포함).
    if (this.bodyEl && this.bodyWrapEl?.contains(target)) {
      const bodyRect = this.bodyEl.getBoundingClientRect();
      // 클릭 지점 caret → 실패(좌우 여백 등)면 본문 가로 중앙의 같은 y 로 재시도.
      const cx = bodyRect.left + bodyRect.width / 2;
      const pos =
        this.caretFromPoint(e.clientX, e.clientY) ??
        this.caretFromPoint(cx, e.clientY);
      if (pos && this.bodyEl.contains(pos.node)) {
        const raw = this.displayToRawOffset(
          this.displayOffsetOf(pos.node, pos.offset)
        );
        return paragraphIndexAtOffset(ranges, raw);
      }
      // 본문 위/아래 빈 영역 클릭 — 첫/끝 문단으로.
      return e.clientY <= bodyRect.top ? 0 : ranges.length - 1;
    }
    return null;
  }

  /** 번역 패널에서 클릭 y 에 가장 가까운(또는 안쪽) 문단 블록. */
  private nearestTranslationBlock(
    clientY: number
  ): { offset: number } | null {
    let best: { offset: number } | null = null;
    let bestDist = Infinity;
    for (const block of this.translationBlocks) {
      const r = block.el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return block;
      const dist = clientY < r.top ? r.top - clientY : clientY - r.bottom;
      if (dist < bestDist) {
        bestDist = dist;
        best = block;
      }
    }
    return best;
  }

  private openParagraphRegen(anchorIndex: number): void {
    if (!this.sessionFile) return;
    new ParagraphRegenModal(this.plugin, {
      sessionFile: this.sessionFile,
      baselineText: this.baselineText,
      anchorIndex,
      onApply: (from, to, expected, text) =>
        this.applyParagraphRegen(from, to, expected, text),
      translationEnabled: this.session?.meta.translation?.enabled === true,
      onRetranslate: (from, to, hashes) =>
        this.retranslateFromPanel(from, to, hashes),
    }).open();
  }

  /**
   * 재생성 패널의 재번역 버튼 — 선택 범위 문단들을 미리 번역해본다. **아직 반영하지
   * 않는다.** 미리보기 텍스트와, 패널에서 [적용]을 눌렀을 때 실제로 translations.json
   * 에 반영(되돌리기 스택에 쌓임)하는 commit 콜백을 돌려준다. 실패/무반영이면 null.
   */
  private async retranslateFromPanel(
    from: number,
    to: number,
    hashes: string[]
  ): Promise<{ previewText: string; commit: () => Promise<boolean> } | null> {
    if (!this.sessionFile || hashes.length === 0 || this.translating) return null;
    if (!this.ai.isAvailable()) {
      new Notice("GGAI Core 가 설치/활성화되어 있지 않습니다.");
      return null;
    }
    this.translating = true;
    this.updateToolbar();
    let preview: TranslatePreviewResult;
    try {
      preview = await this.plugin.translation.previewTranslateRange(
        this.sessionFile,
        hashes
      );
    } finally {
      this.translating = false;
      this.updateToolbar();
    }
    if (!preview.ok || preview.items.length === 0) {
      new Notice("번역 실패: " + (preview.errors[0] ?? "알 수 없는 오류"));
      return null;
    }

    const bySource = new Map(preview.items.map((it) => [it.hash, it.translation]));
    const slice = this.baselineText.slice(from, to);
    const previewText = tokenizeParagraphs(slice)
      .map((t) => (t.kind === "separator" ? t.text : bySource.get(t.hash) ?? t.source))
      .join("");

    const commit = async (): Promise<boolean> => {
      if (!this.sessionFile || this.translating) return false;
      this.translating = true;
      this.updateToolbar();
      this.suppressOwnTranslationsEvent = true;
      try {
        await this.plugin.translation.commitPreview(
          this.sessionFile,
          preview.items,
          { modelProfileId: preview.modelProfileId, promptId: preview.promptId }
        );
        const anchor = this.currentAnchor();
        this.translations = await this.store.getSessionTranslations(this.sessionFile);
        this.translationViewActive = true;
        this.translations.displayMode = "translation";
        await this.store.saveSessionTranslations(this.sessionFile, this.translations);
        this.applyDisplayMode();
        if (anchor) this.restoreToAnchor(anchor);
        return true;
      } finally {
        this.suppressOwnTranslationsEvent = false;
        this.translating = false;
        this.updateToolbar();
      }
    };
    return { previewText, commit };
  }

  /**
   * 재생성 결과 승인 — 해당 구간을 교체하는 user-edit 노드를 파생시킨다.
   * 원문 노드는 불변, 승인 시에만 노드가 추가된다 (미디어 확장 스펙).
   */
  private async applyParagraphRegen(
    from: number,
    to: number,
    expected: string,
    text: string
  ): Promise<boolean> {
    if (!this.session || !this.sessionFile) return false;
    if (this.generation) {
      new Notice("생성 중에는 적용할 수 없습니다.");
      return false;
    }
    await this.commitPending();
    // 패널이 열린 사이 본문이 바뀌었으면(외부 편집 등) 잘못된 구간을 지우지 않게 중단.
    if (this.baselineText.slice(from, to) !== expected) {
      new Notice("본문이 바뀌어 적용할 수 없습니다. 문단을 다시 선택해주세요.");
      return false;
    }
    const patch: Patch = {
      op: "replace",
      from,
      to,
      spans: [{ author: "user", text }],
    };
    const node: SessionNode = {
      id: uuidv4(),
      parent: this.session.meta.activeLeafId,
      kind: "user-edit",
      patches: [patch],
      createdAt: Date.now(),
    };
    this.session.nodes[node.id] = node;
    this.session.meta.activeLeafId = node.id;
    this.redoStack = [];
    this.baselineSpans = applyPatch(this.baselineSpans, patch);
    this.baselineText = spansToText(this.baselineSpans);
    await this.persistSession("문단 재생성 적용 실패");
    this.refreshDisplayBaseline();
    this.suppressEvents = true;
    this.renderBodySpans();
    this.suppressEvents = false;
    // 번역 보기/split 중이면 바뀐 문단(새 해시)이 원문으로 보이게 블록 재구성.
    if (this.translationViewActive || this.outputMode === "split-h") {
      this.renderTranslationBlocks();
    }
    this.updateToolbar();
    return true;
  }

  // --- caret helpers ---

  private redrawBodyPreservingCaret(): void {
    const hadFocus = document.activeElement === this.bodyEl;
    const caret = this.getCaretOffset();
    this.refreshDisplayBaseline();
    this.suppressEvents = true;
    this.renderBodySpans();
    this.setCaretOffset(caret);
    // body.empty() 로 자식 노드를 전부 갈아치우면 Selection Range 는 새로 잡혀도
    // contenteditable(plaintext-only) 요소 자체의 DOM 포커스는 브라우저에 따라
    // 풀릴 수 있다 — 타이핑 중(IDLE_COMMIT_MS 마다) 이 경로를 타면 다음 입력이
    // 씹히는 "포커스 사라짐" 증상으로 나타난다. 원래 포커스 상태였다면 명시적으로
    // 되돌려준다.
    if (hadFocus) this.bodyEl?.focus({ preventScroll: true });
    this.suppressEvents = false;
  }

  private getCaretOffset(): number {
    const root = this.bodyEl;
    if (!root) return 0;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) return 0;
    const pre = range.cloneRange();
    pre.selectNodeContents(root);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }

  private setCaretOffset(offset: number): void {
    const root = this.bodyEl;
    if (!root) return;
    // 다른 편집칸(우측 메모리/작가노트 textarea, 편집기 입력 등)이 포커스를 갖고
    // 있으면 문서 선택영역을 건드리지 않는다 — removeAllRanges/addRange 가 그쪽
    // caret 과 진행 중인 한글 조합을 죽인다 (입력 마비 회귀 금지). 이 본문이 다시
    // 포커스를 얻을 때(클릭/포커스 복원) caret 은 자연히 다시 잡힌다.
    if (otherEditableActive(root)) return;
    const sel = document.getSelection();
    if (!sel) return;

    let remaining = Math.max(0, offset);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= len;
    }
    // ??媛? 癰귣챶揆 ??
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  private isBodyActive(): boolean {
    const root = this.bodyEl;
    const active = document.activeElement;
    return !!root && !!active && (active === root || root.contains(active));
  }
}

// ?????????????????????????????? module-level helpers ??????????????????????????????

function scenarioFileOfSessionFile(sessionFile: string): string | null {
  const parts = sessionFile.split("/");
  if (parts.length < 6 || parts[parts.length - 3] !== "SESSIONS") return null;
  return parts.slice(0, -3).join("/") + "/scenario.json";
}

function hasVisibleText(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * 세션 본문(root) 밖의 다른 편집칸이 포커스를 갖고 있는가.
 * body.empty() 직후처럼 포커스가 document.body 로 떨어진 상태는 편집칸이 아니므로
 * false — caret 복원(redrawBodyPreservingCaret)의 정상 경로는 막지 않는다.
 */
function otherEditableActive(root: HTMLElement): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active === root || root.contains(active)) return false;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active.isContentEditable
  );
}
