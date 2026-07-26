/**
 * 스텔라 폰 뷰 (PH1 문자 + PH3 SNS + PH5 카메라/갤러리 — 홈 화면 모델).
 *
 * 폰 = 홈 화면 + 앱: 켜면 배경화면(월페이퍼) + 시계 + 앱 아이콘 그리드가 보이고,
 * 앱을 탭해 들어간다. 하단 홈 바(알약)로 홈 복귀. 새 기능은 홈에 앱 아이콘을
 * 추가하는 방식으로 확장한다. PC 는 폰 프레임 안에, 모바일은 프레임 없이 풀 화면.
 *
 * 메시지 앱 말풍선은 챗 세션 공용 스킨(`.ggai-chat-msg`/`avatar`/`name`/`bubble`)을
 * 그대로 재사용한다 — 아바타/이름이 챗 세션과 동일하게 보인다.
 *
 * 렌더 규약: store 이벤트는 국소 갱신(본문 영역만 다시 그림), 입력창 DOM 은
 * 재렌더에서 제외해 타이핑을 보존한다. IME 조합 중 도착한 외부 변경은
 * runWhenImeIdle 로 미룬다 (회귀금지.md 입력 마비 사고).
 */
import {
  type App,
  Component,
  Menu,
  Modal,
  Notice,
  Platform,
  Setting,
  setIcon,
} from "obsidian";
import type StellaEnginePlugin from "../main";
import {
  PhoneService,
  snsAuthorKey,
  PHONE_APP_MESSAGES,
  PHONE_APP_SNS,
  PHONE_APP_TUBE,
  PHONE_APP_CAMERA,
  PHONE_APP_SETTINGS,
  type PhoneApp,
  type PhoneSendTarget,
} from "../services/phone-service";
import { ChoiceModal, ConfirmModal, PromptModal } from "./modals";
import { PhoneContactModal } from "./phone-contact-modal";
import { ScenarioSelectModal } from "./scenario-select-modal";
import {
  renderPhoneCommonSettings,
  renderPhoneMessagesSettings,
  renderPhoneSnsSettings,
  renderPhoneTubeSettings,
  type PhoneSettingsCtx,
} from "./phone-settings-sections";
import { accountTier } from "../types/phone";
import type {
  PhoneGalleryFile,
  PhoneMessagesFile,
  PhoneThread,
  SessionStreamFile,
  SnsAuthor,
  SnsAccount,
  SnsFeedFile,
  SnsList,
  SnsPost,
  SnsReply,
  StreamChatItem,
} from "../types/phone";
import type { StellaUserProfile } from "../types/user";
import { formatChatText } from "../util/chat-format";
import { pathToLeaf } from "../util/session-text";
import { attachLongPress } from "../util/long-press";
import type { PhoneContact } from "../util/phone-contacts";
import { renderThumb } from "../util/render-thumb";
import { runWhenImeIdle } from "./edit-guard";
import {
  PhoneImagePickerModal,
  type PickedPhoneImage,
} from "./phone-image-picker";

/**
 * 폰 화면 — 홈 / 내장 앱 / 외부 등록 앱(ext). 홈 그리드는 `plugin.phone.listApps()`
 * (내장 + 등록)를 그린다 (v2 §9). 내장 앱은 아래 map 으로 내부 화면에 라우팅되고,
 * 외부 앱은 "ext" 화면에서 자체 render 로 그려진다.
 */
type PhoneScreen =
  | "home"
  | "messages"
  | "sns"
  | "camera"
  | "tube"
  | "settings"
  | "ext";

/** 번역을 지원하는 앱 축 (v2) — 토글·재번역·표시가 이 축으로 공통 처리된다. */
type PhoneTranslateKind = "messages" | "sns" | "tube";

/** 내장 앱 id → 내부 화면 (홈 그리드 클릭 라우팅). */
const BUILTIN_SCREEN_BY_ID: Record<
  string,
  Exclude<PhoneScreen, "home" | "ext">
> = {
  [PHONE_APP_MESSAGES]: "messages",
  [PHONE_APP_SNS]: "sns",
  [PHONE_APP_TUBE]: "tube",
  [PHONE_APP_CAMERA]: "camera",
  [PHONE_APP_SETTINGS]: "settings",
};

const APP_TITLES: Record<
  Exclude<PhoneScreen, "home" | "ext">,
  string
> = {
  messages: "메시지",
  sns: "스텔라 네트워크",
  camera: "카메라",
  tube: "스텔라튜브",
  settings: "설정",
};

/**
 * 설정 앱 탭 — 공통 + 앱별. 렌더러는 확장 탭 패널과 공유하는 공용 모듈이라
 * 두 곳이 어긋나지 않는다.
 */
const PHONE_SETTINGS_TABS: Array<{
  id: string;
  label: string;
  render: (ctx: PhoneSettingsCtx) => void;
}> = [
  { id: "common", label: "공통", render: renderPhoneCommonSettings },
  { id: "messages", label: "메시지", render: renderPhoneMessagesSettings },
  { id: "sns", label: "네트워크", render: renderPhoneSnsSettings },
  { id: "tube", label: "스텔라튜브", render: renderPhoneTubeSettings },
];

/** 답글 알림 한 건 — 내 게시글/댓글에 달린 (내가 아닌) 답글. */
interface SnsNotification {
  post: SnsPost;
  reply: SnsReply;
  /** post = 내 게시글에 달린 답글, comment = 내 댓글에 달린 답글. */
  reason: "post" | "comment";
}

/** 연락처 목록 한 줄 — 시나리오 연락처 또는 엑스트라(모르는 번호) 스레드. */
interface PhoneListRow {
  target: PhoneSendTarget;
  name: string;
  thumbnailPath: string | null;
  lastAt: number;
  preview: string | null;
}

/** 폰 UI 본체 — 탭 뷰(모바일)와 오버레이(PC)가 공유하는 컴포넌트. */
class PhoneController extends Component {
  private loginUserFile: string | null = null;
  private loginProfile: StellaUserProfile | null = null;
  private personaThumbPath: string | null = null;
  private contacts: PhoneContact[] = [];
  private messages: PhoneMessagesFile | null = null;
  /** 현재 화면 — 홈 / 앱. */
  private screen: PhoneScreen = "home";
  /** 외부 등록 앱 화면(screen==="ext")에서 활성인 앱 (v2 §9). */
  private activeExtApp: PhoneApp | null = null;
  /** 외부 앱 render 가 반환한 정리 함수 — 화면을 떠날 때 호출. */
  private extCleanup: (() => void) | null = null;
  /** 메시지 앱에서 열려 있는 스레드 대상 — null 이면 연락처 목록. */
  private openTarget: PhoneSendTarget | null = null;
  private feed: SnsFeedFile | null = null;
  private gallery: PhoneGalleryFile | null = null;
  /** 시나리오 stella id → 썸네일 경로 (SNS 아바타용). */
  private scenarioThumbById = new Map<string, string | null>();
  /** 게시 대기 중인 첨부 사진. */
  private pendingAttach: PickedPhoneImage | null = null;
  /** 공유로 진입 — 다음 SNS 렌더에서 작성창에 포커스를 준다. */
  private focusSnsComposer = false;
  /** 문자 전송 대기 중인 첨부 사진. */
  private pendingMsgAttach: PickedPhoneImage | null = null;
  /** 카메라 촬영 진행 중 (버튼 잠금). */
  private cameraBusy = false;
  /** 카메라 — 프롬프트 직접 입력 모드 (기본 = 삽화 프롬프트 생성 경유). */
  private cameraDirect = false;
  /** 카메라 프롬프트 — 촬영 후에도 유지(같은 프롬프트로 재시도), 재렌더 넘어 보존. */
  private cameraPrompt = "";
  /** SNS 계정 모아보기 필터 — null 이면 전체 피드. */
  private snsAccountFilter: { key: string; label: string } | null = null;
  /** 피드 갱신이 입력 중에 도착함 — 입력이 끝나면 다시 그린다. */
  private snsDirty = false;
  /** 답글 입력이 열려 있는 대상 — 게시글 id + (대댓글이면) 부모 답글 id. */
  private replyOpen: { postId: string; parentId?: string } | null = null;
  /**
   * 작성 중인 글·답글 — **DOM 이 아니라 여기 산다**. 입력칸 값만 믿으면 사진을
   * 첨부하거나(첨부 미리보기 = 재렌더) 번역·생성이 끝나 피드가 갱신될 때 써 둔
   * 글이 조용히 사라진다(첨부는 필드라 살아남아 "사진만 올라감").
   */
  private snsDraft = "";
  private replyDraft = "";
  /**
   * 원문↔번역 표시 오버라이드 — null = 설정(자동 번역)을 따름, true = 번역 보기,
   * false = 원문 보기. 햄버거 토글이 설정한다. 문자/SNS/방송 공통(앱별 축).
   */
  private msgTrOverride: boolean | null = null;
  private snsTrOverride: boolean | null = null;
  private tubeTrOverride: boolean | null = null;
  /** SNS 답글 알림 모아보기 화면 열림 여부. */
  private snsNotifOpen = false;
  /** SNS 좋아요(맘찍) 한 글 모아보기 화면 열림 여부. */
  private snsLikedOpen = false;
  /** SNS 관리 화면 (v3) — 리스트 관리 / 계정 관리 (null = 피드). */
  private snsManageOpen: "lists" | "accounts" | null = null;
  /** 설정 앱에서 보고 있는 탭 (앱을 나갔다 와도 유지). */
  private settingsTab = "common";
  /** 계정 전환 팝업 요소 (백드롭 + 시트) — 열려 있을 때만. */
  private personaSwitcherEls: HTMLElement[] | null = null;
  private personaSwitcherKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** 등급 3+ 게시글의 댓글 접기 해제 상태 (v2 §6.7). */
  private snsExpanded = new Set<string>();
  /** [더 보기] 생성 중인 게시글. */
  private snsMoreBusy = new Set<string>();
  /** 번역 실행 중 키 (스레드 키 / 게시글 id) — 버튼 잠금. */
  private translateBusy = new Set<string>();
  /** 스텔라튜브 — 볼트 전체 방송 목록 (라이브 + 다시보기). */
  private streams: { sessionFile: string; stream: SessionStreamFile }[] = [];
  /** 튜브 화면에서 열어 본 다시보기 — null 이면 라이브(있으면)/목록. */
  private openStreamFile: string | null = null;
  /** 라이브 뷰 국소 갱신용 — 채팅 컨테이너 + 이미 그린 채팅 id. */
  private tubeChatEl: HTMLElement | null = null;
  private tubeViewersEl: HTMLElement | null = null;
  private tubeShownFile: string | null = null;
  private tubeRenderedChatIds = new Set<string>();
  /**
   * "여기까지 봤음" 기준 채팅 id — 방송 화면을 여는 렌더에서 한 번 잡고, 보는
   * 동안은 고정한다(번역 토글 등 재렌더로 구분선이 눈앞에서 사라지면 안 된다).
   * 저장은 화면을 떠날 때 `markTubeSeen` 이 한다.
   */
  private tubeSeenMark: string | null = null;
  private tubeSeenFile: string | null = null;
  /** 화면에 그린 마지막 채팅 id — 떠날 때 이 지점을 "봤음"으로 저장. */
  private tubeLastChatId: string | null = null;
  /**
   * 표시 시점 자동 번역 보충의 "직전 시도 지문" (키 → 미번역 항목 지문).
   * 자동 번역은 생성 시점 1회뿐이라 그때 빠진 항목(설정을 켜기 전에 쌓인 글,
   * 청크 실패분, 라이브 중 추가분)이 영영 원문으로 남았다. 화면에 그릴 때 미번역이
   * 남아 있으면 다시 채우되, **지문이 같으면**(= 지난 시도로 아무것도 못 채웠으면)
   * 재시도하지 않는다 — 실패 루프 방지.
   */
  private autoTrTried = new Map<string, string>();

  private screenEl!: HTMLElement;
  private statusClockEl!: HTMLElement;
  private statusPersonaEl!: HTMLButtonElement;
  private headerEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private composerEl!: HTMLElement;
  private msgAttachPreviewEl!: HTMLElement;
  private homeBarEl!: HTMLElement;
  private backNavBtn!: HTMLButtonElement;
  private refreshNavBtn!: HTMLButtonElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private loadSeq = 0;
  /** 수동 새로고침 진행 중 (버튼 스피너). */
  private refreshBusy = false;

  constructor(
    private plugin: StellaEnginePlugin,
    private hostEl: HTMLElement,
    /** 폰 닫기 — 홈에서 홈/뒤로를 누르면 호출 (오버레이 닫기). */
    private closeHost: () => void
  ) {
    super();
  }

  private get app() {
    return this.plugin.app;
  }

  onload(): void {
    const root = this.hostEl;
    root.empty();
    root.addClass("ggai-phone-root");

    // PC = 폰 프레임, 모바일 = 그냥 화면 전체.
    const screen = Platform.isMobile
      ? root.createDiv({ cls: "ggai-phone-screen is-bare" })
      : root
          .createDiv({ cls: "ggai-phone-frame-wrap" })
          .createDiv({ cls: "ggai-phone-frame" })
          .createDiv({ cls: "ggai-phone-screen" });
    this.screenEl = screen;

    // 상태 바 — 시계 + 로그인 페르소나 (어느 화면에서든 접근).
    const status = screen.createDiv({ cls: "ggai-phone-status" });
    this.statusClockEl = status.createSpan({ cls: "ggai-phone-status-clock" });
    // 신호·와이파이·배터리 — 순수 장식(v2 §2.1). 진짜 폰처럼 보이게 하는 것이
    // 목적이라 상태를 읽지 않는다(읽을 상태도 없다).
    const indicators = status.createDiv({ cls: "ggai-phone-status-icons" });
    const signal = indicators.createDiv({ cls: "ggai-phone-status-signal" });
    for (let i = 0; i < 4; i++) signal.createSpan();
    setIcon(indicators.createSpan({ cls: "ggai-phone-status-wifi" }), "wifi");
    indicators.createDiv({ cls: "ggai-phone-status-battery" });
    this.statusPersonaEl = status.createEl("button", {
      cls: "ggai-phone-persona",
      attr: { "aria-label": "폰 로그인 페르소나 전환" },
    });
    this.statusPersonaEl.addEventListener("click", (e) =>
      void this.openPersonaMenu(e)
    );
    this.updateClock();
    this.registerInterval(window.setInterval(() => this.updateClock(), 30_000));
    // 시간차 배달 (v2) — 도착 예정 문자가 있으면 5초마다 배달 반영.
    this.registerInterval(
      window.setInterval(() => {
        if (this.screen !== "messages") return;
        if (!this.hasUndelivered()) return;
        runWhenImeIdle(() => this.renderBody());
      }, 5_000)
    );

    this.headerEl = screen.createDiv({ cls: "ggai-phone-header" });
    this.bodyEl = screen.createDiv({ cls: "ggai-phone-body" });
    this.composerEl = screen.createDiv({ cls: "ggai-phone-composer" });
    this.buildComposer();

    // 하단 내비게이션 바 — 3분할: 새로고침(좌) · 홈(중) · 뒤로(우). 항상 보임.
    // 홈에서 홈/뒤로를 누르면 폰이 닫힌다 (진짜 폰의 홈 제스처처럼).
    this.homeBarEl = screen.createDiv({ cls: "ggai-phone-homebar" });
    this.refreshNavBtn = this.homeBarEl.createEl("button", {
      cls: "ggai-phone-nav-btn is-refresh",
      attr: { "aria-label": "새로고침 (SNS·방송 갱신)" },
    });
    setIcon(this.refreshNavBtn, "refresh-cw");
    this.refreshNavBtn.addEventListener("click", () =>
      void this.handleManualRefresh()
    );
    const homeNav = this.homeBarEl.createEl("button", {
      cls: "ggai-phone-nav-btn is-home",
      attr: { "aria-label": "홈" },
    });
    // 홈 = 제스처 바 알약 (아이콘 대신 — v2 §2.1).
    homeNav.createSpan({ cls: "ggai-phone-home-pill" });
    homeNav.addEventListener("click", () => {
      if (this.screen === "home") this.closeHost();
      else this.goHome();
    });
    this.backNavBtn = this.homeBarEl.createEl("button", {
      cls: "ggai-phone-nav-btn is-back",
      attr: { "aria-label": "뒤로" },
    });
    setIcon(this.backNavBtn, "chevron-left");
    this.backNavBtn.addEventListener("click", () => {
      if (this.screen === "home") this.closeHost();
      else this.navBack();
    });

    // ── 모바일 소프트키보드 회피 — 폰 모달은 100dvh 고정이라 키보드가 덮으면
    //    컴포저·카메라 입력이 가려진다. visualViewport 로 실제 가려진 높이만큼
    //    화면을 줄인다 (styles.css 의 --ggai-phone-kb). 기준선(base)은 관측된
    //    최소 가림값 — 키보드 없이도 남는 시스템 바 몫이 섞이지 않게 한다. ──
    if (Platform.isMobile && window.visualViewport) {
      const vv = window.visualViewport;
      let base = Number.POSITIVE_INFINITY;
      const onVv = () => {
        const occluded = Math.max(
          0,
          window.innerHeight - vv.height - vv.offsetTop
        );
        base = Math.min(base, occluded);
        const kb = occluded - base;
        const active = kb > 60;
        root.style.setProperty(
          "--ggai-phone-kb",
          active ? `${Math.round(kb)}px` : "0px"
        );
        root.toggleClass("is-kb", active);
        // 키보드가 올라와 스레드 아래가 잘리면 마지막 말풍선이 보이게 따라간다.
        if (active && this.composerEl.contains(document.activeElement)) {
          this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
        }
      };
      vv.addEventListener("resize", onVv);
      vv.addEventListener("scroll", onVv);
      this.register(() => {
        vv.removeEventListener("resize", onVv);
        vv.removeEventListener("scroll", onVv);
      });
      onVv();
    }

    // ── store 구독 — 전부 국소 갱신. ──
    this.registerEvent(
      this.plugin.store.on("phone-messages-changed", (personaId: string) => {
        if (personaId !== this.loginProfile?.id) return;
        runWhenImeIdle(() => void this.reloadMessages());
      })
    );
    this.registerEvent(
      this.plugin.store.on("phone-replying-changed", (personaId: string) => {
        if (personaId !== this.loginProfile?.id) return;
        runWhenImeIdle(() => {
          this.updateComposerState();
          if (this.screen === "messages") this.renderBody();
        });
      })
    );
    this.registerEvent(
      this.plugin.store.on("phone-login-changed", () => {
        runWhenImeIdle(() => void this.reloadAll());
      })
    );
    this.registerEvent(
      this.plugin.store.on("users-changed", () => {
        runWhenImeIdle(() => void this.reloadAll());
      })
    );
    this.registerEvent(
      this.plugin.store.on("sns-feed-changed", () => {
        runWhenImeIdle(() => void this.reloadFeed());
      })
    );
    this.registerEvent(
      this.plugin.store.on("phone-gallery-changed", () => {
        runWhenImeIdle(() => void this.reloadGallery());
      })
    );
    // 스텔라튜브 (v2) — 방송/반응 변경. 라이브 뷰는 채팅 append 국소 갱신.
    this.registerEvent(
      this.plugin.store.on("session-stream-changed", () => {
        runWhenImeIdle(() => void this.reloadStreams());
      })
    );
    // 갤러리 "네트워크에 공유" — 이미 열려 있는 폰이면 즉시 SNS 작성창으로.
    this.registerEvent(
      this.plugin.store.on("phone-share-requested", () => {
        runWhenImeIdle(() => this.consumePendingShare());
      })
    );
    // 폰 앱 등록/해제 (v2 §9) — 홈 그리드 갱신, 열린 외부 앱이 사라지면 홈으로.
    this.registerEvent(
      this.plugin.store.on("phone-apps-changed", () => {
        runWhenImeIdle(() => {
          if (
            this.screen === "ext" &&
            this.activeExtApp &&
            !this.plugin.phone.listApps().includes(this.activeExtApp)
          ) {
            this.goHome();
          } else if (this.screen === "home") {
            this.renderBody();
          }
        });
      })
    );
    // 리스트(v3) 변경 — SNS 화면일 때만 다시 그린다 (칩 바 + 빈 화면 전환).
    this.registerEvent(
      this.plugin.store.on("phone-lists-changed", () => {
        runWhenImeIdle(() => {
          if (this.screen === "sns") this.renderBody();
        });
      })
    );
    // 계정 DB 변경 (v3) — 계정 관리 화면이 열려 있을 때만 다시 그린다.
    this.registerEvent(
      this.plugin.store.on("phone-accounts-changed", () => {
        runWhenImeIdle(() => {
          if (this.screen === "sns" && this.snsManageOpen === "accounts") {
            this.renderBody();
          }
        });
      })
    );
    // 연락처는 세션 기록에서 파생 — 메시지 목록 화면일 때만 다시 계산.
    const refreshContactsIfListing = () => {
      if (this.screen !== "messages" || this.openTarget !== null) return;
      runWhenImeIdle(() => void this.reloadContacts());
    };
    this.registerEvent(
      this.plugin.store.on("scenarios-changed", refreshContactsIfListing)
    );
    this.registerEvent(
      this.plugin.store.on("sessions-changed", refreshContactsIfListing)
    );

    // 언로드 시 열려 있던 계정 전환 팝업 정리 (document keydown 리스너 포함).
    this.register(() => this.closePersonaSwitcher());
    // 언로드 시 열려 있던 외부 앱 render 정리 (v2 §9).
    this.register(() => this.clearExtApp());
    // 폰을 닫을 때 보던 방송의 "여기까지 봤음"을 저장 (다음에 열면 그 아래부터).
    this.register(() => this.markTubeSeen());

    void this.reloadAll().then(() => {
      // 갱신 트리거: 폰을 켰을 때 (PH2) — 게이트/스로틀은 refresh 가 판정.
      void this.plugin.phone.refresh("open");
    });
  }

  // ─────────────────────────── 데이터 로드 ───────────────────────────

  private async reloadAll(): Promise<void> {
    const seq = ++this.loadSeq;
    const { userFile, profile } = await this.plugin.phone.getLoginPersona();
    if (seq !== this.loadSeq) return;
    this.loginUserFile = userFile;
    this.loginProfile = profile;
    const [contacts, messages, feed, gallery, users, streams] = await Promise.all([
      this.plugin.phone.listContacts(userFile, profile.id),
      this.plugin.store.getPhoneMessages(profile.id),
      this.plugin.store.getSnsFeed().catch(() => null),
      this.plugin.store.getPhoneGallery().catch(() => null),
      this.plugin.store
        .getUsers()
        .catch(
          (): Awaited<ReturnType<StellaEnginePlugin["store"]["getUsers"]>> => []
        ),
      this.plugin.store
        .listSessionStreams()
        .catch(
          (): Awaited<
            ReturnType<StellaEnginePlugin["store"]["listSessionStreams"]>
          > => []
        ),
    ]);
    if (seq !== this.loadSeq) return;
    this.contacts = contacts;
    this.messages = messages;
    this.feed = feed;
    this.gallery = gallery;
    this.streams = streams;
    this.personaThumbPath =
      users.find((u) => u.userFile === userFile)?.thumbnailPath ?? null;
    // SNS 아바타용 — 시나리오 표지 맵.
    const scenarios = await this.plugin.store
      .getScenarios()
      .catch(
        (): Awaited<ReturnType<StellaEnginePlugin["store"]["getScenarios"]>> => []
      );
    if (seq !== this.loadSeq) return;
    this.scenarioThumbById = new Map(
      scenarios.flatMap((i) => {
        const id = i.scenario.data?.extensions?.stella?.id;
        return id ? [[id, i.thumbnailPath] as const] : [];
      })
    );
    // 로그인이 바뀌었는데 열린 스레드 상대가 이 폰에 없으면 목록으로.
    if (this.openTarget !== null && this.currentThreadOrContactMissing()) {
      this.openTarget = null;
    }
    this.renderStatus();
    this.renderHeader();
    this.renderBody();
    this.updateComposerState();
    // 공유로 폰이 새로 열린 경우 — 로드가 끝난 뒤 SNS 작성창으로.
    this.consumePendingShare();
  }

  /**
   * 갤러리에서 "스텔라 네트워크에 공유"로 넘어온 이미지 — 진짜 폰 공유처럼
   * SNS 작성창을 열고 사진을 첨부한 채 코멘트 입력을 기다린다.
   */
  private consumePendingShare(): void {
    const share = this.plugin.phone.takePendingShare();
    if (!share) return;
    this.screen = "sns";
    this.snsAccountFilter = null;
    this.pendingAttach = {
      path: share.path,
      isNewUpload: false,
      caption: share.caption,
    };
    this.focusSnsComposer = true;
    this.renderHeader();
    this.renderBody();
    this.updateComposerState();
  }

  private currentThreadOrContactMissing(): boolean {
    const t = this.openTarget;
    if (!t) return false;
    if (t.kind === "scenario") {
      return !this.contacts.some((c) => c.scenarioId === t.scenarioId);
    }
    return !this.messages?.threads.some((th) => th.id === t.threadId);
  }

  private async reloadContacts(): Promise<void> {
    if (!this.loginUserFile || !this.loginProfile) return;
    const seq = ++this.loadSeq;
    const contacts = await this.plugin.phone.listContacts(
      this.loginUserFile,
      this.loginProfile.id
    );
    if (seq !== this.loadSeq) return;
    this.contacts = contacts;
    if (this.screen === "messages" && this.openTarget === null) this.renderBody();
  }

  private async reloadMessages(): Promise<void> {
    if (!this.loginProfile) return;
    const seq = ++this.loadSeq;
    const messages = await this.plugin.store.getPhoneMessages(
      this.loginProfile.id
    );
    if (seq !== this.loadSeq) return;
    this.messages = messages;
    if (this.screen === "messages") this.renderBody();
  }

  private async reloadFeed(): Promise<void> {
    const feed = await this.plugin.store.getSnsFeed().catch(() => null);
    this.feed = feed;
    if (this.screen !== "sns") return;
    // 게시/답글 입력 중이면 다 쓰고 나서 다시 그린다 (입력 보존).
    if (this.isSnsComposing()) {
      this.snsDirty = true;
      return;
    }
    this.renderBody();
  }

  private async reloadGallery(): Promise<void> {
    const gallery = await this.plugin.store.getPhoneGallery().catch(() => null);
    this.gallery = gallery;
    // 카메라 화면의 "최근 촬영" 미리보기가 갤러리 데이터를 쓴다.
    if (this.screen === "camera") this.renderBody();
  }

  /** SNS 화면의 입력칸에 포커스 + 내용이 있는지 (재렌더 보류 판정). */
  private isSnsComposing(): boolean {
    const el = document.activeElement;
    if (!(el instanceof HTMLTextAreaElement)) return false;
    if (!this.bodyEl.contains(el)) return false;
    return el.value.trim().length > 0;
  }

  // ─────────────────────────── 내비게이션 ───────────────────────────

  /** 하단 뒤로 버튼 — 스레드 안에선 목록으로, 앱 첫 화면에선 홈으로. */
  private navBack(): void {
    if (this.screen === "messages" && this.openTarget !== null) {
      this.openTarget = null;
      this.renderHeader();
      this.renderBody();
      this.updateComposerState();
      return;
    }
    if (this.screen === "tube" && this.openStreamFile !== null) {
      this.markTubeSeen();
      this.openStreamFile = null;
      this.renderHeader();
      this.renderBody();
      return;
    }
    this.goHome();
  }

  private goHome(): void {
    if (this.screen === "home") return;
    this.markTubeSeen();
    this.clearExtApp();
    this.screen = "home";
    this.snsDirty = false;
    this.snsAccountFilter = null;
    this.snsNotifOpen = false;
    this.snsLikedOpen = false;
    this.snsManageOpen = null;
    this.renderHeader();
    this.renderBody();
    this.updateComposerState();
  }

  private openApp(screen: PhoneScreen): void {
    this.markTubeSeen();
    this.clearExtApp();
    this.screen = screen;
    this.snsAccountFilter = null;
    this.snsNotifOpen = false;
    this.snsLikedOpen = false;
    this.snsManageOpen = null;
    this.openStreamFile = null;
    this.renderHeader();
    this.renderBody();
    this.updateComposerState();
  }

  // ─────────────────────────── 상태 바 / 헤더 ───────────────────────────

  private updateClock(): void {
    const d = new Date();
    this.statusClockEl.setText(
      `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    );
  }

  private renderStatus(): void {
    this.statusPersonaEl.empty();
    setIcon(
      this.statusPersonaEl.createSpan({ cls: "ggai-phone-persona-icon" }),
      "user"
    );
    this.statusPersonaEl.createSpan({
      cls: "ggai-phone-persona-name",
      text: this.loginProfile?.name ?? "…",
    });
  }

  /**
   * 계정 전환 — 프사(표지)가 보이는 팝업 시트. 옵시디언 Menu 는 이미지를 못
   * 그리므로 폰 화면 안에 백드롭 + 시트를 직접 띄운다 (바깥 클릭/Esc 로 닫힘).
   */
  private async openPersonaMenu(_e: MouseEvent): Promise<void> {
    const users = await this.plugin.store
      .getUsers()
      .catch(
        (): Awaited<ReturnType<StellaEnginePlugin["store"]["getUsers"]>> => []
      );
    if (users.length === 0) return;
    this.closePersonaSwitcher();
    const backdrop = this.screenEl.createDiv({
      cls: "ggai-phone-sheet-backdrop",
    });
    const sheet = this.screenEl.createDiv({
      cls: "ggai-phone-persona-switcher",
    });
    sheet.createDiv({
      cls: "ggai-phone-persona-switcher-title",
      text: "계정 전환",
    });
    for (const u of users) {
      const active = u.userFile === this.loginUserFile;
      const row = sheet.createDiv({
        cls: `ggai-phone-persona-switcher-row${active ? " is-active" : ""}`,
      });
      const av = row.createDiv({ cls: "ggai-phone-persona-switcher-avatar" });
      renderThumb(this.app, av, u.thumbnailPath, u.profile.name || "?", "user");
      row.createDiv({
        cls: "ggai-phone-persona-switcher-name",
        text: u.profile.name || u.userFile,
      });
      if (active) {
        const check = row.createSpan({
          cls: "ggai-phone-persona-switcher-check",
        });
        setIcon(check, "check");
      }
      row.addEventListener("click", () => {
        this.closePersonaSwitcher();
        if (u.userFile !== this.loginUserFile) {
          void this.plugin.phone.setLoginPersona(u.userFile);
        }
      });
    }
    backdrop.addEventListener("click", () => this.closePersonaSwitcher());
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") this.closePersonaSwitcher();
    };
    document.addEventListener("keydown", onKey);
    this.personaSwitcherEls = [backdrop, sheet];
    this.personaSwitcherKeyHandler = onKey;
  }

  private closePersonaSwitcher(): void {
    for (const el of this.personaSwitcherEls ?? []) el.remove();
    this.personaSwitcherEls = null;
    if (this.personaSwitcherKeyHandler) {
      document.removeEventListener("keydown", this.personaSwitcherKeyHandler);
      this.personaSwitcherKeyHandler = null;
    }
  }

  private renderHeader(): void {
    this.headerEl.empty();
    this.headerEl.toggleClass("is-hidden", this.screen === "home");
    if (this.screen === "home") return;

    // 뒤로 — 스레드 안에선 목록으로, 앱 첫 화면에선 홈으로. 항상 보인다.
    const inThread = this.screen === "messages" && this.openTarget !== null;
    const back = this.headerEl.createEl("button", {
      cls: "ggai-phone-icon-btn",
      attr: { "aria-label": "뒤로" },
    });
    setIcon(back, "arrow-left");
    back.addEventListener("click", () => {
      if (inThread) {
        this.openTarget = null;
        this.renderHeader();
        this.renderBody();
        this.updateComposerState();
      } else if (this.screen === "sns" && this.snsSubScreenOpen()) {
        // 모아보기/관리 화면에선 뒤로 = 피드 (홈까지 나갔다 오지 않게).
        this.backToSnsFeed();
      } else {
        this.goHome();
      }
    });
    const title = inThread
      ? this.currentThreadName()
      : this.screen === "ext"
        ? (this.activeExtApp?.name ?? "")
        : APP_TITLES[this.screen];
    const titleEl = this.headerEl.createDiv({
      cls: "ggai-phone-title",
      text: title,
    });
    // 제목 탭 = 그 앱의 첫 화면 (SNS: 어느 모아보기·관리 화면에서든 피드로).
    if (this.screen === "sns") {
      titleEl.addClass("is-clickable");
      titleEl.addEventListener("click", () => this.backToSnsFeed());
    }

    // 답글 알림 벨 (SNS) — 내 게시글/댓글에 달린 답글 모아보기. 안 읽음 배지.
    if (this.screen === "sns") {
      const bell = this.headerEl.createEl("button", {
        cls: "ggai-phone-icon-btn ggai-phone-notif-btn",
        attr: { "aria-label": "답글 알림" },
      });
      setIcon(bell, "bell");
      bell.toggleClass("is-active", this.snsNotifOpen);
      const unread = this.countUnreadNotifications();
      if (unread > 0 && !this.snsNotifOpen) {
        bell.createSpan({
          cls: "ggai-phone-notif-badge",
          text: unread > 99 ? "99+" : String(unread),
        });
      }
      bell.addEventListener("click", () => this.toggleNotifications());
    }

    // 햄버거 메뉴 — 초기화/삭제 + 번역 토글/재번역. 문자·SNS 는 항상, 방송은
    // 방송이 열려 있고 번역이 켜진 경우(번역 항목만 있으므로 빈 메뉴 방지).
    const showMenu =
      this.screen === "messages" ||
      this.screen === "sns" ||
      (this.screen === "tube" && this.currentTranslateKind() === "tube");
    if (showMenu) {
      const menuBtn = this.headerEl.createEl("button", {
        cls: "ggai-phone-icon-btn",
        attr: { "aria-label": "메뉴" },
      });
      setIcon(menuBtn, "menu");
      menuBtn.addEventListener("click", (e) => this.openHeaderMenu(e));
    }
  }

  /** SNS 서브 화면(알림/좋아요/모아보기/관리)이 열려 있는가. */
  private snsSubScreenOpen(): boolean {
    return (
      this.snsNotifOpen ||
      this.snsLikedOpen ||
      this.snsManageOpen !== null ||
      this.snsAccountFilter !== null
    );
  }

  /** SNS 피드로 복귀 — 서브 화면 상태를 전부 닫는다. */
  private backToSnsFeed(): void {
    if (!this.snsSubScreenOpen()) return;
    this.snsNotifOpen = false;
    this.snsLikedOpen = false;
    this.snsManageOpen = null;
    this.snsAccountFilter = null;
    this.renderHeader();
    this.renderBody();
    this.updateComposerState();
  }

  /**
   * 피드 초기화 — 누르면 범위를 고른다 (취소 / 맘찍 빼고 / 전체).
   * 되돌릴 수 없으므로 기본 동작 없이 항상 사용자가 고르게 한다.
   */
  private async clearSnsFeedInteractive(): Promise<void> {
    const choice = await new Promise<string | null>((resolve) => {
      new ChoiceModal(
        this.app,
        "피드 초기화",
        "지울 범위를 고르세요. 되돌릴 수 없습니다.",
        [
          { text: "맘찍 빼고 지우기", value: "keep" },
          { text: "전체 삭제", value: "all", warning: true },
        ],
        resolve
      ).open();
    });
    if (!choice) return;
    await this.plugin.phone
      .clearSnsFeed({ keepLiked: choice === "keep" })
      .catch((err) =>
        new Notice(
          `스텔라 폰: ${err instanceof Error ? err.message : String(err)}`
        )
      );
  }

  /** 초기화 확인 → 실행 (되돌릴 수 없는 동작은 전부 확인 모달을 거친다). */
  private confirmThen(
    title: string,
    message: string,
    confirmText: string,
    action: () => Promise<void>
  ): void {
    new ConfirmModal(this.app, title, message, confirmText, (confirmed) => {
      if (!confirmed) return;
      void action().catch((err) =>
        new Notice(
          `스텔라 폰: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }).open();
  }

  /**
   * 번역 공통 메뉴 (v2 §C) — 원문↔번역 보기 토글. 문자/SNS/방송 어느 앱이든 같은
   * 코드로 붙는다. "번역 보기"로 전환하면 아직 번역 안 된 항목을 그때 채우므로(각
   * setter), 별도 "전체 다시 번역"은 두지 않는다 — 특정 글만 고치는 건 개별 재번역.
   */
  private addTranslationMenuItems(menu: Menu, kind: PhoneTranslateKind): void {
    // 자동 번역이 꺼져 있어도 보기 전환은 언제나 가능하다 (수동 축).
    const showing = this.showTranslated(kind);
    menu.addItem((mi) =>
      mi
        .setTitle(showing ? "원문 보기" : "번역 보기")
        .setIcon("languages")
        .onClick(() => void this.setTranslated(kind, !showing))
    );
  }

  /** 그 앱의 번역본을 보여줄지 — 오버라이드(햄버거 토글) 우선, 없으면 자동 번역 설정. */
  private showTranslated(kind: PhoneTranslateKind): boolean {
    const ov =
      kind === "messages"
        ? this.msgTrOverride
        : kind === "sns"
          ? this.snsTrOverride
          : this.tubeTrOverride;
    return ov ?? this.plugin.phone.isAutoTranslateOn();
  }

  /** 원문↔번역 보기 전환 — 앱별 동작으로 디스패치. */
  private async setTranslated(
    kind: PhoneTranslateKind,
    show: boolean
  ): Promise<void> {
    if (kind === "messages") await this.setMsgTranslated(show);
    else if (kind === "sns") await this.setSnsTranslated(show);
    else await this.setTubeTranslated(show);
  }

  /** 지금 화면에서 번역 메뉴를 붙일 앱 축 (없으면 null). */
  private currentTranslateKind(): PhoneTranslateKind | null {
    if (this.screen === "messages" && this.openTarget !== null) return "messages";
    if (this.screen === "sns") return "sns";
    if (this.screen === "tube" && this.currentTubeItem() !== null) return "tube";
    return null;
  }

  /**
   * SNS 원문↔번역 표시 전환 (햄버거) — 번역 보기로 갈 때 아직 번역 안 된 글/댓글이
   * 있으면 **피드 전체를 한 번에** 먼저 번역한다(문자 스레드와 같은 동작). 이게
   * 없으면 "번역 보기"를 눌러도 미번역 글이 원문으로 남아 토글이 먹통처럼 보인다.
   */
  private async setSnsTranslated(show: boolean): Promise<void> {
    if (!show) {
      this.snsTrOverride = false;
      if (this.screen === "sns") this.renderBody();
      return;
    }
    const key = "sns:feed";
    // 수동 토글은 지문 게이트를 무시하고 한 번 더 시도한다(사용자가 눌렀다 =
    // 재시도 의사). 다만 이번 대상 지문은 기록해 둔다 — 이 시도가 아무것도 못
    // 채우면 뒤따르는 렌더가 같은 요청을 또 쏘지 않게.
    const pending = this.pendingFeedTranslationIds();
    if (pending.length > 0 && !this.translateBusy.has(key)) {
      this.autoTrTried.set(key, `${pending.length}:${pending.join(",")}`);
      this.translateBusy.add(key);
      // 진행 안내는 Core 가 label + 모델명으로 띄운다 (CLAUDE.md 7).
      const result = await this.plugin.phone.translateFeed();
      this.translateBusy.delete(key);
      if (!result.ok) new Notice(`스텔라 폰: ${result.error}`);
      this.snsTrOverride = true;
      await this.reloadFeed();
      return;
    }
    this.snsTrOverride = true;
    if (this.screen === "sns") this.renderBody();
  }

  /**
   * 방송 원문↔번역 표시 전환 (햄버거) — 번역 보기로 갈 때 아직 번역 안 된 채팅이
   * 있으면 그 방송 채팅 전체를 먼저 번역한다(문자·SNS 와 동일).
   */
  private async setTubeTranslated(show: boolean): Promise<void> {
    if (!show) {
      this.tubeTrOverride = false;
      if (this.screen === "tube") this.renderBody();
      return;
    }
    const item = this.currentTubeItem();
    if (item) {
      const key = `tube:${item.sessionFile}`;
      const pending = this.pendingStreamTranslationIds(item.stream);
      if (pending.length > 0 && !this.translateBusy.has(key)) {
        this.autoTrTried.set(key, `${pending.length}:${pending.join(",")}`);
        this.translateBusy.add(key);
        // 진행 안내는 Core 가 label + 모델명으로 띄운다 (CLAUDE.md 7).
        const result = await this.plugin.phone.translateStream(item.sessionFile);
        this.translateBusy.delete(key);
        if (!result.ok) new Notice(`스텔라 폰: ${result.error}`);
      }
    }
    this.tubeTrOverride = true;
    await this.refreshStreamsAndRenderTube();
  }

  /**
   * 방송 번역 후 화면 갱신 — `this.streams`(뷰 캐시)를 새로 읽어야 방금 저장한
   * 번역이 반영된다(append 경로는 새 채팅 id 가 없어 번역 표시로 안 바뀌므로 전체 렌더).
   */
  private async refreshStreamsAndRenderTube(): Promise<void> {
    this.streams = await this.plugin.store
      .listSessionStreams()
      .catch(() => this.streams);
    if (this.screen === "tube") this.renderBody();
  }

  private openHeaderMenu(e: MouseEvent): void {
    const menu = new Menu();
    if (this.screen === "messages") {
      const inThread = this.openTarget !== null;
      if (inThread) {
        const target = this.openTarget!;
        this.addTranslationMenuItems(menu, "messages");
        menu.addItem((mi) =>
          mi
            .setTitle("대화 내용 삭제")
            .setIcon("eraser")
            .onClick(() =>
              this.confirmThen(
                "대화 삭제",
                `${this.currentThreadName()}와의 대화 내용을 모두 삭제합니다.`,
                "삭제",
                async () => {
                  if (!this.loginProfile) return;
                  await this.plugin.phone.deleteThread(this.loginProfile.id, target);
                }
              )
            )
        );
        if (target.kind === "scenario") {
          menu.addItem((mi) =>
            mi
              .setTitle("연락처 해제 (대화 포함 삭제)")
              .setIcon("user-x")
              .onClick(() =>
                this.confirmThen(
                  "연락처 해제",
                  `${this.currentThreadName()}을(를) 연락처에서 지우고 대화도 삭제합니다. 더 이상 먼저 문자가 오지 않습니다.`,
                  "해제",
                  async () => {
                    if (!this.loginProfile) return;
                    await this.plugin.phone.unregisterContact(
                      this.loginProfile.id,
                      target.scenarioId
                    );
                    this.openTarget = null;
                    await this.reloadContacts();
                    this.renderHeader();
                    this.renderBody();
                    this.updateComposerState();
                  }
                )
              )
          );
        }
      } else {
        menu.addItem((mi) =>
          mi
            .setTitle("문자 전체 초기화")
            .setIcon("trash-2")
            .onClick(() =>
              this.confirmThen(
                "문자 전체 초기화",
                "이 폰의 모든 대화 내용을 삭제합니다. 연락처 등록은 유지됩니다.",
                "초기화",
                async () => {
                  if (!this.loginProfile) return;
                  await this.plugin.phone.clearAllMessages(this.loginProfile.id);
                }
              )
            )
        );
      }
    } else if (this.screen === "sns") {
      // 햄버거는 네 갈래로 단순화 (사용자 결정): 번역 / 좋아요 / 리스트 / 초기화.
      // 계정 관리는 리스트 화면 안 탭으로, 설정은 홈의 "설정" 앱으로 옮겼다.
      this.addTranslationMenuItems(menu, "sns");
      menu.addItem((mi) =>
        mi
          .setTitle(this.snsLikedOpen ? "피드로 돌아가기" : "좋아요")
          .setIcon("heart")
          .onClick(() => {
            this.snsLikedOpen = !this.snsLikedOpen;
            if (this.snsLikedOpen) {
              this.snsNotifOpen = false;
              this.snsAccountFilter = null;
              this.snsManageOpen = null;
            }
            this.renderHeader();
            this.renderBody();
            this.updateComposerState();
          })
      );
      menu.addItem((mi) =>
        mi
          .setTitle(this.snsManageOpen ? "피드로 돌아가기" : "리스트")
          .setIcon("users")
          .onClick(() => {
            this.snsManageOpen = this.snsManageOpen ? null : "lists";
            if (this.snsManageOpen) {
              this.snsNotifOpen = false;
              this.snsLikedOpen = false;
              this.snsAccountFilter = null;
            }
            this.renderHeader();
            this.renderBody();
            this.updateComposerState();
          })
      );
      menu.addItem((mi) =>
        mi
          .setTitle("초기화")
          .setIcon("trash-2")
          .onClick(() => void this.clearSnsFeedInteractive())
      );
    } else if (this.screen === "tube") {
      // 방송 화면 — 번역 토글 + 전체 다시 번역 (공통 메뉴).
      this.addTranslationMenuItems(menu, "tube");
    }
    menu.showAtMouseEvent(e);
  }

  /**
   * 문자 원문↔번역 표시 전환 (햄버거) — 번역 보기로 갈 때 번역 안 된 문자가
   * 있으면 먼저 일괄 번역한다.
   */
  private async setMsgTranslated(show: boolean): Promise<void> {
    if (!this.loginProfile || !this.openTarget) return;
    if (!show) {
      this.msgTrOverride = false;
      this.renderHeader();
      if (this.screen === "messages") this.renderBody();
      return;
    }
    const key = PhoneService.targetKey(this.openTarget);
    // 수동 토글은 지문 게이트를 무시하고 시도하되, 대상 지문은 기록한다
    // (이 시도가 아무것도 못 채우면 뒤따르는 렌더가 같은 요청을 또 쏘지 않게).
    const pending = this.pendingThreadTranslationIds();
    if (pending.length > 0 && !this.translateBusy.has(key)) {
      this.autoTrTried.set(key, `${pending.length}:${pending.join(",")}`);
      this.translateBusy.add(key);
      this.renderHeader();
      const result = await this.plugin.phone.translateThread(
        this.loginProfile.id,
        this.openTarget
      );
      this.translateBusy.delete(key);
      if (!result.ok) {
        new Notice(`스텔라 폰: ${result.error}`);
        this.renderHeader();
        return;
      }
      await this.reloadMessages();
    }
    this.msgTrOverride = true;
    this.renderHeader();
    if (this.screen === "messages") this.renderBody();
  }

  /** 문자 1통 번역 재생성 (덮어쓰기) — 개별 문자 메뉴. */
  private async regenerateMessageTranslation(messageId: string): Promise<void> {
    if (!this.loginProfile || !this.openTarget) return;
    const key = PhoneService.targetKey(this.openTarget);
    if (this.translateBusy.has(key)) return;
    this.translateBusy.add(key);
    this.renderHeader();
    const result = await this.plugin.phone.translateThread(
      this.loginProfile.id,
      this.openTarget,
      { force: true, messageId }
    );
    this.translateBusy.delete(key);
    if (!result.ok) {
      new Notice(`스텔라 폰: ${result.error}`);
      this.renderHeader();
      return;
    }
    this.msgTrOverride = true; // 재생성 결과가 보이도록 번역 보기로.
    await this.reloadMessages();
    this.renderHeader();
  }

  /** SNS 게시글 번역 재생성 (본문+댓글 덮어쓰기) — 개별 게시물 ⋯ 메뉴. */
  private async regenerateSnsPostTranslation(postId: string): Promise<void> {
    if (this.translateBusy.has(postId)) return;
    this.translateBusy.add(postId);
    // 진행 안내는 Core 가 label + 모델명으로 띄운다 (CLAUDE.md 7).
    const result = await this.plugin.phone.translateSnsPost(postId, {
      force: true,
    });
    this.translateBusy.delete(postId);
    if (!result.ok) {
      new Notice(`스텔라 폰: ${result.error}`);
      return;
    }
    this.snsTrOverride = true; // 재생성 결과가 보이도록 번역 보기로.
    await this.reloadFeed();
  }

  // ─────────────────────────── 본문 렌더 ───────────────────────────

  private renderBody(): void {
    this.bodyEl.empty();
    this.bodyEl.className = "ggai-phone-body";
    // 홈에선 월페이퍼가 상태바까지 덮는다 (화면 전체 배경).
    this.screenEl.toggleClass("is-home", this.screen === "home");
    switch (this.screen) {
      case "home":
        this.renderHome();
        return;
      case "sns":
        this.renderSnsFeed();
        return;
      case "camera":
        this.renderCamera();
        return;
      case "tube":
        this.renderTube();
        return;
      case "settings":
        this.renderSettings();
        return;
      case "ext":
        this.renderExtApp();
        return;
      default:
        if (this.openTarget === null) this.renderContactList();
        else this.renderThread();
    }
  }

  /**
   * 설정 화면 (폰 앱) — 별도 모달이 아니라 다른 앱과 같은 폰 화면이다.
   * 탭 = 공통 / 메시지 / 네트워크 / 스텔라튜브. 렌더러는 확장 탭 패널과
   * 같은 공용 모듈(`phone-settings-sections`)을 쓴다.
   */
  private renderSettings(): void {
    // 탭은 고정, 본문만 스크롤 — 스크롤 축을 하나로 둔다(이중 스크롤 방지).
    this.bodyEl.addClass("is-settings");
    const tabsEl = this.bodyEl.createDiv({
      cls: "ggai-detail-tabs ggai-phone-settings-tabs",
    });
    const pane = this.bodyEl.createDiv({ cls: "ggai-phone-settings-pane" });
    for (const tab of PHONE_SETTINGS_TABS) {
      const el = tabsEl.createDiv({ cls: "ggai-detail-tab", text: tab.label });
      el.toggleClass("is-active", tab.id === this.settingsTab);
      el.addEventListener("click", () => {
        if (this.settingsTab === tab.id) return;
        this.settingsTab = tab.id;
        this.renderBody();
      });
    }
    // 디테일 뷰 설정과 같은 골격 — 그룹 소제목 + `ggai-media-body` 간격.
    const group = pane.createDiv({ cls: "ggai-media-body" });
    let firstSection = true;
    const section = (title: string) => {
      const el = group.createDiv({ cls: "ggai-phone-subhead", text: title });
      if (firstSection) el.addClass("is-first");
      firstSection = false;
    };
    const tab =
      PHONE_SETTINGS_TABS.find((t) => t.id === this.settingsTab) ??
      PHONE_SETTINGS_TABS[0];
    tab.render({
      plugin: this.plugin,
      parent: group,
      section,
      patch: async (p) => {
        await this.plugin.savePluginData({
          phone: { ...(this.plugin.data.phone ?? {}), ...p },
        });
        // 토글로 하위 항목이 생기고 사라지므로 저장 후 다시 그린다.
        runWhenImeIdle(() => {
          if (this.screen === "settings") this.renderBody();
        });
      },
      rerender: () => {
        if (this.screen === "settings") this.renderBody();
      },
    });
  }

  /** 홈 화면 — 배경화면 + 시계 + 앱 그리드. */
  private renderHome(): void {
    this.bodyEl.addClass("is-home");
    const d = new Date();
    const clockWrap = this.bodyEl.createDiv({ cls: "ggai-phone-home-clock" });
    clockWrap.createDiv({
      cls: "ggai-phone-home-time",
      text: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
    });
    clockWrap.createDiv({
      cls: "ggai-phone-home-date",
      text: d.toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        weekday: "long",
      }),
    });

    const grid = this.bodyEl.createDiv({ cls: "ggai-phone-home-grid" });
    // 내장 + 등록 앱 (v2 §9) — 레지스트리 순서대로.
    for (const app of this.plugin.phone.listApps()) {
      const builtinScreen = BUILTIN_SCREEN_BY_ID[app.id];
      const btn = grid.createEl("button", { cls: "ggai-phone-app" });
      const icon = btn.createDiv({ cls: "ggai-phone-app-icon" });
      setIcon(icon, app.icon);
      icon.addClass(`is-${builtinScreen ?? "ext"}`);
      // LIVE 점 배지 (스텔라튜브 등 — 앱이 liveBadge 로 판정).
      if (app.liveBadge?.()) {
        icon.createDiv({ cls: "ggai-phone-app-badge-live" });
      }
      btn.createDiv({ cls: "ggai-phone-app-label", text: app.name });
      btn.addEventListener("click", () => {
        if (builtinScreen) this.openApp(builtinScreen);
        else this.openExtApp(app);
      });
    }
  }

  /** 외부 등록 앱 화면 렌더 (v2 §9) — 앱이 bodyEl 에 자체 UI 를 그린다. */
  private renderExtApp(): void {
    const app = this.activeExtApp;
    if (!app?.render) {
      this.goHome();
      return;
    }
    // 재렌더 전 이전 render 정리 (bodyEl 은 renderBody 가 이미 비웠으므로
    // 앱이 붙인 전역 listener 만 정리하면 된다).
    if (this.extCleanup) {
      try {
        this.extCleanup();
      } catch {
        /* 정리 실패 무시 */
      }
      this.extCleanup = null;
    }
    const personaId = this.loginProfile?.id ?? "";
    const personaFile = this.loginUserFile ?? "";
    const cleanup = app.render(this.bodyEl, {
      personaId,
      personaFile,
      plugin: this.plugin,
      goHome: () => this.goHome(),
    });
    this.extCleanup = typeof cleanup === "function" ? cleanup : null;
  }

  /** 외부 앱 화면 진입 — 이전 앱 정리 후 전환. */
  private openExtApp(app: PhoneApp): void {
    this.markTubeSeen();
    this.clearExtApp();
    this.activeExtApp = app;
    this.screen = "ext";
    this.snsAccountFilter = null;
    this.snsNotifOpen = false;
    this.snsLikedOpen = false;
    this.snsManageOpen = null;
    this.openStreamFile = null;
    this.renderHeader();
    this.renderBody();
    this.updateComposerState();
  }

  /** 외부 앱 화면을 떠날 때 render 정리 함수 실행. */
  private clearExtApp(): void {
    if (this.extCleanup) {
      try {
        this.extCleanup();
      } catch {
        /* 정리 실패 무시 */
      }
      this.extCleanup = null;
    }
    this.activeExtApp = null;
  }

  // ─────────────────────────── 메시지 앱 ───────────────────────────

  /** 배달된(표시 가능한) 문자만 — deliverAt 미래는 아직 도착 전 (v2 시간차 배달). */
  private visibleMessages(thread: PhoneThread): PhoneThread["messages"] {
    const now = Date.now();
    return thread.messages.filter((m) => !m.deliverAt || m.deliverAt <= now);
  }

  /** 도착 예정(미배달) 문자가 있는지 — 5초 배달 틱 게이트. */
  private hasUndelivered(): boolean {
    const now = Date.now();
    return (this.messages?.threads ?? []).some((t) =>
      t.messages.some((m) => m.deliverAt !== undefined && m.deliverAt > now)
    );
  }

  /** 열린 스레드에 곧(20초 내) 도착할 문자가 있는지 — 타이핑 인디케이터. */
  private deliveryImminent(thread: PhoneThread | null): boolean {
    if (!thread) return false;
    const now = Date.now();
    return thread.messages.some(
      (m) =>
        m.deliverAt !== undefined &&
        m.deliverAt > now &&
        m.deliverAt - now <= 20_000
    );
  }

  private currentThread(): PhoneThread | null {
    const t = this.openTarget;
    if (!t || !this.messages) return null;
    if (t.kind === "scenario") {
      return (
        this.messages.threads.find(
          (th) => th.kind === "scenario" && th.scenarioId === t.scenarioId
        ) ?? null
      );
    }
    return this.messages.threads.find((th) => th.id === t.threadId) ?? null;
  }

  /** 열린 스레드의 표시 이름. */
  private currentThreadName(): string {
    const t = this.openTarget;
    if (!t) return "";
    if (t.kind === "scenario") {
      return (
        this.contacts.find((c) => c.scenarioId === t.scenarioId)?.name ?? "문자"
      );
    }
    return this.currentThread()?.extraName ?? "알 수 없는 번호";
  }

  /** 열린 스레드 상대의 썸네일 (엑스트라는 null). */
  private currentThreadThumb(): string | null {
    const t = this.openTarget;
    if (!t || t.kind !== "scenario") return null;
    return (
      this.contacts.find((c) => c.scenarioId === t.scenarioId)?.thumbnailPath ??
      null
    );
  }

  /** 목록 행 구성 — 시나리오 연락처 + 엑스트라(모르는 번호) 스레드, 최근 활동순. */
  private buildListRows(): PhoneListRow[] {
    const rows: PhoneListRow[] = [];
    for (const contact of this.contacts) {
      const thread = this.messages?.threads.find(
        (t) => t.kind === "scenario" && t.scenarioId === contact.scenarioId
      );
      const visible = thread ? this.visibleMessages(thread) : [];
      const last = visible[visible.length - 1];
      rows.push({
        target: { kind: "scenario", scenarioId: contact.scenarioId },
        name: contact.name,
        thumbnailPath: contact.thumbnailPath,
        lastAt: last?.createdAt ?? contact.lastSessionAt,
        preview: last ? last.text.split("\n")[0] : null,
      });
    }
    for (const thread of this.messages?.threads ?? []) {
      if (thread.kind !== "extra") continue;
      const visible = this.visibleMessages(thread);
      if (visible.length === 0) continue;
      const last = visible[visible.length - 1];
      rows.push({
        target: { kind: "extra", threadId: thread.id },
        name: thread.extraName ?? "알 수 없는 번호",
        thumbnailPath: null,
        lastAt: last.createdAt,
        preview: last.text.split("\n")[0],
      });
    }
    rows.sort((a, b) => b.lastAt - a.lastAt);
    return rows;
  }

  /** 연락처 관리 — 후보 전체를 체크 목록 모달로 (체크=등록, 해제=삭제, v2 §3.1). */
  private openRegisterContactMenu(): void {
    if (!this.loginUserFile || !this.loginProfile) return;
    new PhoneContactModal(
      this.plugin,
      this.loginProfile.id,
      this.loginUserFile,
      () => void this.reloadContacts()
    ).open();
  }

  private renderContactList(): void {
    // 등록 진입점 — 세션을 함께 한 캐릭터라도 등록해야 문자를 주고받는다 (1회 필터).
    const registerRow = this.bodyEl.createEl("button", {
      cls: "ggai-phone-register-btn",
    });
    setIcon(registerRow.createSpan({ cls: "ggai-phone-persona-icon" }), "user-plus");
    registerRow.createSpan({ text: " 연락처 등록" });
    registerRow.addEventListener("click", () => this.openRegisterContactMenu());

    const rows = this.buildListRows();
    if (rows.length === 0) {
      const empty = this.bodyEl.createDiv({ cls: "ggai-phone-empty" });
      empty.createDiv({ text: "연락처가 비어 있습니다." });
      empty.createDiv({
        cls: "ggai-phone-empty-sub",
        text: `세션을 함께 한 캐릭터를 [연락처 등록]으로 초대하면 여기에 나타나고, 등록한 캐릭터하고만 문자를 주고받습니다.`,
      });
      return;
    }
    for (const item of rows) {
      const row = this.bodyEl.createDiv({ cls: "ggai-phone-contact" });
      const thumb = row.createDiv({ cls: "ggai-phone-contact-thumb" });
      renderThumb(
        this.app,
        thumb,
        item.thumbnailPath,
        item.name,
        item.target.kind === "extra" ? "help-circle" : "user"
      );
      const main = row.createDiv({ cls: "ggai-phone-contact-main" });
      main.createDiv({ cls: "ggai-phone-contact-name", text: item.name });
      main.createDiv({
        cls: "ggai-phone-contact-preview",
        text: item.preview ?? "대화를 시작해 보세요",
      });
      if (item.preview) {
        row.createDiv({
          cls: "ggai-phone-contact-time",
          text: formatTimeShort(item.lastAt),
        });
      }
      row.addEventListener("click", () => {
        this.openTarget = item.target;
        this.renderHeader();
        this.renderBody();
        this.updateComposerState();
      });
      // 우클릭(PC)/길게 누르기(모바일) — 개별 삭제·연락처 해제.
      const openRowMenu = (x: number, y: number) => {
        const menu = new Menu();
        menu.addItem((mi) =>
          mi
            .setTitle("대화 삭제")
            .setIcon("eraser")
            .onClick(() =>
              this.confirmThen(
                "대화 삭제",
                `${item.name}와의 대화 내용을 삭제합니다.`,
                "삭제",
                async () => {
                  if (!this.loginProfile) return;
                  await this.plugin.phone.deleteThread(
                    this.loginProfile.id,
                    item.target
                  );
                }
              )
            )
        );
        if (item.target.kind === "scenario") {
          const scenarioId = item.target.scenarioId;
          menu.addItem((mi) =>
            mi
              .setTitle("연락처 해제 (대화 포함 삭제)")
              .setIcon("user-x")
              .onClick(() =>
                this.confirmThen(
                  "연락처 해제",
                  `${item.name}을(를) 연락처에서 지우고 대화도 삭제합니다.`,
                  "해제",
                  async () => {
                    if (!this.loginProfile) return;
                    await this.plugin.phone.unregisterContact(
                      this.loginProfile.id,
                      scenarioId
                    );
                    await this.reloadContacts();
                  }
                )
              )
          );
        }
        menu.showAtPosition({ x, y });
      };
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openRowMenu(e.clientX, e.clientY);
      });
      attachLongPress(row, { onLongPress: openRowMenu });
      // 눈에 보이는 ⋯ 버튼 — 우클릭/길게 누르기를 모르는 사용자도 삭제·해제 접근.
      const moreBtn = row.createEl("button", {
        cls: "ggai-phone-icon-btn ggai-phone-contact-more",
        attr: { "aria-label": "연락처 메뉴 (대화 삭제·연락처 해제)" },
      });
      setIcon(moreBtn, "more-vertical");
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openRowMenu(e.clientX, e.clientY);
      });
    }
  }

  /** 스레드 — 챗 세션과 같은 말풍선 스킨 (아바타/이름/버블 공용 클래스). */
  private renderThread(): void {
    this.bodyEl.addClass("is-thread");
    // 번역 보기 상태인데 원문으로 남은 문자가 있으면 백그라운드로 채운다.
    this.maybeAutoTranslateThread();
    const thread = this.currentThread();
    const charName = this.currentThreadName();
    const charThumb = this.currentThreadThumb();
    const userName = this.loginProfile?.name ?? "User";

    const visible = thread ? this.visibleMessages(thread) : [];
    // 읽음 표시 — 마지막으로 읽힌 내 문자 1통에만 붙인다.
    const lastReadId = [...visible]
      .reverse()
      .find((m) => m.from === "persona" && m.readAt !== undefined)?.id;
    if (!thread || visible.length === 0) {
      this.bodyEl.createDiv({
        cls: "ggai-phone-empty",
        text: `${charName}에게 첫 문자를 보내 보세요.`,
      });
    } else {
      let lastDay = "";
      for (const m of visible) {
        // 날짜가 바뀌면 가운데 날짜 칩.
        const day = new Date(m.createdAt).toDateString();
        if (day !== lastDay) {
          lastDay = day;
          this.bodyEl.createDiv({
            cls: "ggai-phone-day-sep",
            text: new Date(m.createdAt).toLocaleDateString(undefined, {
              month: "long",
              day: "numeric",
              weekday: "short",
            }),
          });
        }
        const isMe = m.from === "persona";
        const row = this.bodyEl.createDiv({
          cls: `ggai-chat-msg ${isMe ? "is-user" : "is-assistant"}`,
        });
        const avatar = row.createDiv({ cls: "ggai-chat-avatar" });
        renderThumb(
          this.app,
          avatar,
          isMe ? this.personaThumbPath : charThumb,
          isMe ? userName : charName,
          isMe
            ? "user"
            : this.openTarget?.kind === "extra"
              ? "help-circle"
              : "book-open"
        );
        const stack = row.createDiv({ cls: "ggai-chat-stack" });
        stack.createDiv({
          cls: "ggai-chat-name",
          text: isMe ? userName : charName,
        });
        const bubble = stack.createDiv({ cls: "ggai-chat-bubble" });
        // 첨부 사진 — 탭하면 확대.
        if (m.image) {
          const img = bubble.createEl("img", { cls: "ggai-phone-msg-photo" });
          img.src = this.app.vault.adapter.getResourcePath(m.image.asset);
          img.alt = m.image.caption;
          img.loading = "lazy";
          const asset = m.image.asset;
          const caption = m.image.caption;
          img.addEventListener("click", () =>
            new ImageLightboxModal(this.app, asset, caption).open()
          );
        }
        // 번역 보기 — 번역이 있는 문자만 바꿔 보여준다 (원문은 불변).
        // 오버라이드(햄버거 원문/번역 토글) 우선, 없으면 자동 번역 설정.
        const showTr = this.showMsgTranslated();
        const shown = showTr && m.translation ? m.translation.text : m.text;
        if (shown.trim()) {
          const textDiv = bubble.createDiv();
          textDiv.innerHTML = formatChatText(shown);
        }
        stack.createDiv({
          cls: "ggai-phone-msg-time",
          text:
            isMe && m.id === lastReadId
              ? `읽음 · ${formatTimeShort(m.createdAt)}`
              : formatTimeShort(m.createdAt),
        });
        // 우클릭(PC)/길게 누르기(모바일) — 문자 1통 삭제.
        const messageId = m.id;
        const openMsgMenu = (x: number, y: number) => {
          const target = this.openTarget;
          if (!target) return;
          const menu = new Menu();
          if (m.text.trim() !== "") {
            menu.addItem((mi) =>
              mi
                .setTitle("번역 재생성")
                .setIcon("languages")
                .onClick(() =>
                  void this.regenerateMessageTranslation(messageId)
                )
            );
          }
          menu.addItem((mi) =>
            mi
              .setTitle("이 문자 삭제")
              .setIcon("trash-2")
              .onClick(() =>
                this.confirmThen("문자 삭제", "이 문자를 삭제합니다.", "삭제", async () => {
                  if (!this.loginProfile) return;
                  await this.plugin.phone.deleteMessage(
                    this.loginProfile.id,
                    target,
                    messageId
                  );
                })
              )
          );
          menu.showAtPosition({ x, y });
        };
        bubble.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          openMsgMenu(e.clientX, e.clientY);
        });
        attachLongPress(bubble, { onLongPress: openMsgMenu });
      }
    }

    // 답장 생성 중이거나 곧 도착할 문자가 있으면 — "입력 중…" 점 세 개.
    if (this.isReplyingHere() || this.deliveryImminent(thread)) {
      const row = this.bodyEl.createDiv({ cls: "ggai-chat-msg is-assistant" });
      const avatar = row.createDiv({ cls: "ggai-chat-avatar" });
      renderThumb(this.app, avatar, charThumb, charName, "book-open");
      const stack = row.createDiv({ cls: "ggai-chat-stack" });
      const bubble = stack.createDiv({
        cls: "ggai-chat-bubble ggai-phone-typing",
      });
      for (let i = 0; i < 3; i++) bubble.createSpan({ cls: "ggai-phone-dot" });
    }

    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  // ─────────────────────────── 스텔라 네트워크 (SNS) ───────────────────────────

  /** 작성자 아바타 — character/scenario = 시나리오 표지, persona = 페르소나 썸네일,
   *  extra = 이니셜 원. */
  private renderAuthorAvatar(parent: HTMLElement, author: SnsAuthor): HTMLElement {
    const avatar = parent.createDiv({ cls: "ggai-phone-sns-avatar" });
    avatar.addClass(`is-${author.kind}`);
    const thumb =
      author.kind === "character" || author.kind === "scenario"
        ? this.scenarioThumbById.get(author.id ?? "") ?? null
        : author.kind === "persona" && author.id === this.loginProfile?.id
          ? this.personaThumbPath
          : null;
    if (thumb) {
      const img = avatar.createEl("img");
      img.src = this.app.vault.adapter.getResourcePath(thumb);
      img.alt = author.name;
    } else {
      avatar.setText((author.name || "?").slice(0, 1));
    }
    return avatar;
  }

  /** 계정 모아보기 켜기/끄기 — 닉네임/프사 탭 진입점. */
  private setSnsAccountFilter(author: SnsAuthor | null): void {
    this.snsAccountFilter = author
      ? {
          key: snsAuthorKey(author),
          label: author.handle ? `${author.name} ${author.handle}` : author.name,
        }
      : null;
    if (this.screen === "sns") this.renderBody();
  }

  /**
   * 팔로우 전 첫 화면 (v3) — 리스트가 하나도 없을 때. 여기서는 피드도 생성도
   * 돌지 않는다는 걸 분명히 보여주고, 만드는 두 경로만 제시한다.
   */
  private renderSnsFollowEmpty(): void {
    const box = this.bodyEl.createDiv({ cls: "ggai-phone-sns-follow-empty" });
    setIcon(box.createDiv({ cls: "ggai-phone-sns-follow-icon" }), "user-plus");
    box.createDiv({
      cls: "ggai-phone-empty",
      text: "아직 팔로우한 계정이 없습니다.",
    });
    box.createDiv({
      cls: "ggai-phone-sns-follow-hint",
      text: "리스트에 담은 세계의 이야기만 이 피드에 올라옵니다.",
    });
    const actions = box.createDiv({ cls: "ggai-phone-sns-follow-actions" });
    const quick = actions.createEl("button", {
      cls: "ggai-phone-sns-post-btn",
      text: "최근 세션 봇으로 시작",
    });
    quick.addEventListener("click", () => {
      void (async () => {
        const ids = await this.plugin.phone.recentSessionParticipants();
        if (ids.length === 0) {
          new Notice("플레이한 세션이 아직 없습니다.");
          return;
        }
        await this.plugin.phone.createSnsList("내 피드", ids);
        new Notice(`${ids.length}명을 팔로우했습니다.`);
      })();
    });
    const manual = actions.createEl("button", {
      cls: "ggai-phone-sns-reply-btn",
      text: "직접 고르기",
    });
    manual.addEventListener("click", () => void this.createSnsListInteractive());
  }

  /** 리스트 칩 바 — 전환 + 관리 진입점. */
  private renderSnsListBar(lists: SnsList[]): void {
    const active = this.plugin.phone.activeSnsList();
    const bar = this.bodyEl.createDiv({ cls: "ggai-phone-sns-listbar" });
    for (const list of lists) {
      const chip = bar.createEl("button", {
        cls: "ggai-phone-sns-listchip",
        text: list.name,
      });
      chip.toggleClass("is-active", list.id === active?.id);
      chip.addEventListener("click", () => {
        // 활성 칩을 다시 누르면 관리 메뉴 (전환은 다른 칩을 누를 때).
        if (list.id === active?.id) {
          this.openSnsListMenu(list, chip);
          return;
        }
        void this.plugin.phone.setActiveSnsList(list.id);
      });
      attachLongPress(chip, {
        onLongPress: () => this.openSnsListMenu(list, chip),
      });
      chip.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openSnsListMenu(list, chip);
      });
    }
    // 팔로우 편집은 피드에서 바로 — 관리 화면까지 들어가지 않게 (사용자 요청).
    // 리스트가 아직 없으면 이 버튼이 곧 "첫 리스트 만들기"다.
    const followBtn = bar.createEl("button", {
      cls: "ggai-phone-sns-listchip is-follow",
      text: active ? "+ 팔로우" : "+ 팔로우 시작",
    });
    followBtn.addEventListener("click", () => {
      if (active) {
        void this.editSnsListMembers(active);
        return;
      }
      void (async () => {
        const ids = await ScenarioSelectModal.open(this.plugin, [], {
          title: "팔로우할 인물 (체크 = 이 피드에 이야기 반영)",
        });
        if (!ids || ids.length === 0) return;
        await this.plugin.phone.createSnsList("내 피드", ids);
        new Notice(`${ids.length}명을 팔로우했습니다.`);
      })();
    });
    const addBtn = bar.createEl("button", {
      cls: "ggai-phone-sns-listchip is-add",
      attr: { "aria-label": "리스트 추가" },
    });
    setIcon(addBtn, "plus");
    addBtn.addEventListener("click", () => void this.createSnsListInteractive());
  }

  /** 리스트 관리 메뉴 — 팔로우 편집 / 밴 / 이름 / 삭제. */
  private openSnsListMenu(list: SnsList, anchor: HTMLElement): void {
    const menu = new Menu();
    menu.addItem((mi) =>
      mi
        .setTitle("팔로우 고르기 (추가·제외)")
        .setIcon("user-plus")
        .onClick(() => void this.editSnsListMembers(list))
    );
    menu.addItem((mi) =>
      mi
        .setTitle("세션 골라서 그 인물 전부 추가")
        .setIcon("list-plus")
        .onClick(() => void this.addSnsListFromSession(list))
    );
    menu.addItem((mi) =>
      mi
        .setTitle("최근 플레이한 인물 전부 추가")
        .setIcon("users")
        .onClick(() => {
          void (async () => {
            const ids = await this.plugin.phone.recentSessionParticipants();
            if (ids.length === 0) {
              new Notice("플레이한 세션이 아직 없습니다.");
              return;
            }
            await this.plugin.phone.updateSnsList(list.id, {
              scenarioIds: [...list.scenarioIds, ...ids],
            });
            new Notice("최근 세션 인물을 추가했습니다.");
          })();
        })
    );
    menu.addItem((mi) =>
      mi
        .setTitle("이 리스트에서 밴")
        .setIcon("user-x")
        .onClick(() => void this.editSnsListBans(list))
    );
    menu.addItem((mi) =>
      mi
        .setTitle("이름 변경")
        .setIcon("pencil")
        .onClick(() => void this.renameSnsList(list))
    );
    menu.addItem((mi) =>
      mi
        .setTitle("리스트 삭제")
        .setIcon("trash-2")
        .onClick(() =>
          this.confirmThen(
            "리스트 삭제",
            `"${list.name}" 리스트를 삭제합니다. 이미 올라온 게시글은 그대로 남습니다.`,
            "삭제",
            () => this.plugin.phone.deleteSnsList(list.id)
          )
        )
    );
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  /** 관리 화면 공통 헤더 — 제목 + 닫기(피드로). */
  private renderSnsManageBar(icon: string, title: string): void {
    const bar = this.bodyEl.createDiv({ cls: "ggai-phone-sns-filterbar" });
    setIcon(bar.createSpan({ cls: "ggai-phone-sns-photo-icon" }), icon);
    bar.createSpan({ cls: "ggai-phone-sns-filterbar-label", text: title });
    const closeBtn = bar.createEl("button", {
      cls: "ggai-phone-sns-attach-remove",
      attr: { "aria-label": "닫기" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => {
      this.snsManageOpen = null;
      this.renderBody();
    });
  }

  /**
   * 리스트 관리 화면 (v3) — 리스트를 여러 개 두고 계속 편집하는 상설 화면.
   * 행 클릭 = 그 리스트를 활성으로(생성 대상 전환), 행 안 버튼 = 편집.
   */
  private renderSnsListManager(): void {
    const lists = this.plugin.phone.listSnsLists();
    const active = this.plugin.phone.activeSnsList();

    const addBtn = this.bodyEl.createEl("button", {
      cls: "ggai-phone-sns-post-btn ggai-phone-sns-manage-add",
      text: "+ 새 리스트",
    });
    addBtn.addEventListener("click", () => void this.createSnsListInteractive());

    if (lists.length === 0) {
      const empty = this.bodyEl.createDiv({ cls: "ggai-phone-empty" });
      empty.createDiv({ text: "아직 리스트가 없습니다." });
      empty.createDiv({
        cls: "ggai-phone-empty-sub",
        text: "리스트에 담은 세계의 이야기만 피드에 반영됩니다.",
      });
      return;
    }

    for (const list of lists) {
      const row = this.bodyEl.createDiv({ cls: "ggai-phone-sns-manage-row" });
      const isActive = list.id === active?.id;
      row.toggleClass("is-active", isActive);
      const main = row.createDiv({ cls: "ggai-phone-sns-manage-main" });
      const head = main.createDiv({ cls: "ggai-phone-sns-manage-head" });
      head.createSpan({ cls: "ggai-phone-sns-name", text: list.name });
      if (isActive) {
        head.createSpan({
          cls: "ggai-phone-sns-manage-badge",
          text: "생성 중인 피드",
        });
      }
      main.createDiv({
        cls: "ggai-phone-sns-manage-sub",
        text:
          `팔로우 ${list.scenarioIds.length}` +
          ((list.bannedScenarioIds?.length ?? 0) > 0
            ? ` · 밴 ${list.bannedScenarioIds!.length}`
            : ""),
      });
      // 행 클릭 = 활성 전환 (이미 활성이면 관리 메뉴).
      main.addEventListener("click", () => {
        if (isActive) this.openSnsListMenu(list, row);
        else void this.plugin.phone.setActiveSnsList(list.id);
      });
      const menuBtn = row.createEl("button", {
        cls: "ggai-phone-sns-manage-btn",
        attr: { "aria-label": "리스트 메뉴" },
      });
      setIcon(menuBtn, "more-vertical");
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openSnsListMenu(list, menuBtn);
      });
    }
  }

  /**
   * 계정 관리 화면 (v3) — 생성된 SNS 계정 전부를 활동순으로. 편집(이름/핸들/
   * 세계/성향/팔로워)과 삭제(글 포함 여부 선택)를 여기서 한다.
   */
  private async renderSnsAccountManager(): Promise<void> {
    // 로어북 인물 등록 (§V3-4) — 세계관 시나리오의 로어북에 사는 사람들을
    // 계정으로 올려야 피드가 엑스트라로 채워지지 않는다.
    const scanBtn = this.bodyEl.createEl("button", {
      cls: "ggai-phone-sns-post-btn ggai-phone-sns-manage-add",
      text: "+ 로어북에서 인물 찾기",
    });
    scanBtn.addEventListener("click", () => void this.scanCastInteractive());
    const listEl = this.bodyEl.createDiv();
    listEl.createDiv({ cls: "ggai-phone-empty", text: "불러오는 중…" });
    const accounts = await this.plugin.store
      .getPhoneAccounts()
      .catch(() => null);
    // 비동기 로드 중 화면이 바뀌었으면 그리지 않는다.
    if (this.snsManageOpen !== "accounts" || !listEl.isConnected) return;
    listEl.empty();
    const rows = (accounts?.accounts ?? [])
      .filter((a) => a.kind !== "persona")
      .sort((x, y) => y.lastActive - x.lastActive);
    if (rows.length === 0) {
      const empty = listEl.createDiv({ cls: "ggai-phone-empty" });
      empty.createDiv({ text: "아직 만들어진 계정이 없습니다." });
      empty.createDiv({
        cls: "ggai-phone-empty-sub",
        text: "피드가 갱신되면 글을 쓴 인물들이 여기 계정으로 쌓입니다.",
      });
      return;
    }
    // 등급(§V3-4)이 곧 등장 빈도 — 목록에서 바로 보이게 한다.
    const kindLabel = (a: SnsAccount): string =>
      a.kind === "press"
        ? "언론/공식"
        : accountTier(a) === 1
          ? "고정 캐릭터"
          : accountTier(a) === 2
            ? "로어북 인물"
            : "엑스트라";
    for (const acc of rows) {
      const row = listEl.createDiv({ cls: "ggai-phone-sns-manage-row" });
      this.renderAuthorAvatar(row, {
        kind: acc.kind === "press" ? "extra" : acc.kind,
        ...(acc.scenarioId ? { id: acc.scenarioId } : {}),
        name: acc.name,
      });
      const main = row.createDiv({ cls: "ggai-phone-sns-manage-main" });
      const head = main.createDiv({ cls: "ggai-phone-sns-manage-head" });
      head.createSpan({ cls: "ggai-phone-sns-name", text: acc.name });
      if (acc.handle) {
        head.createSpan({ cls: "ggai-phone-sns-handle", text: acc.handle });
      }
      main.createDiv({
        cls: "ggai-phone-sns-manage-sub",
        text:
          `${kindLabel(acc)} · 팔로워 ${acc.followers}` +
          ` · 글 ${acc.postCount}` +
          (acc.world ? ` · ${acc.world}` : "") +
          (this.plugin.phone.isSnsAccountBanned(acc) ? " · 등장 금지" : ""),
      });
      if (acc.persona) {
        main.createDiv({
          cls: "ggai-phone-sns-manage-memo",
          text: acc.persona,
        });
      }
      main.addEventListener("click", () => this.openSnsAccountEditor(acc));
      const menuBtn = row.createEl("button", {
        cls: "ggai-phone-sns-manage-btn",
        attr: { "aria-label": "계정 메뉴" },
      });
      setIcon(menuBtn, "more-vertical");
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem((mi) =>
          mi
            .setTitle("계정 편집")
            .setIcon("pencil")
            .onClick(() => this.openSnsAccountEditor(acc))
        );
        menu.addItem((mi) =>
          mi
            .setTitle("이 계정의 글 모아보기")
            .setIcon("newspaper")
            .onClick(() => {
              this.snsManageOpen = null;
              this.setSnsAccountFilter({
                kind: acc.kind === "press" ? "extra" : acc.kind,
                ...(acc.scenarioId ? { id: acc.scenarioId } : {}),
                name: acc.name,
                ...(acc.handle ? { handle: acc.handle } : {}),
                accountId: acc.id,
              });
            })
        );
        if (accountTier(acc) !== 1) {
          menu.addItem((mi) =>
            mi
              .setTitle("고정 캐릭터로 승격")
              .setIcon("star")
              .onClick(() => void this.promoteSnsAccountInteractive(acc))
          );
        }
        if (this.plugin.phone.isSnsAccountBanned(acc)) {
          menu.addItem((mi) =>
            mi
              .setTitle("등장 금지 해제")
              .setIcon("user-check")
              .onClick(() => {
                void this.plugin.phone.unbanSnsAccount(acc).then(() => {
                  new Notice("등장 금지를 풀었습니다.");
                  this.renderBody();
                });
              })
          );
        } else {
          menu.addItem((mi) =>
            mi
              .setTitle("이 피드에 등장 금지 (밴)")
              .setIcon("user-x")
              .onClick(() => this.banSnsAccountInteractive(acc))
          );
        }
        menu.addItem((mi) =>
          mi
            .setTitle("계정 삭제")
            .setIcon("trash-2")
            .onClick(() => void this.deleteSnsAccountInteractive(acc))
        );
        const rect = menuBtn.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom });
      });
    }
  }

  /** 계정 삭제 — 글까지 지울지 선택 (ChoiceModal). */
  private async deleteSnsAccountInteractive(acc: SnsAccount): Promise<void> {
    const choice = await new Promise<string | null>((resolve) => {
      new ChoiceModal(
        this.app,
        "계정 삭제",
        `"${acc.name}" 계정을 삭제합니다. 이 계정이 쓴 글과 댓글도 지울까요?`,
        [
          { text: "계정만 삭제", value: "account" },
          { text: "글까지 삭제", value: "all", warning: true },
        ],
        resolve
      ).open();
    });
    if (!choice) return;
    await this.plugin.phone.deleteSnsAccount(acc.id, {
      deletePosts: choice === "all",
    });
    new Notice("계정을 삭제했습니다.");
  }

  /**
   * 로어북 인물 찾기 (§V3-4) — 세계를 고르면 그 로어북에서 사람만 골라 계정으로
   * 등록한다. 이미 훑은 세계도 다시 고르면 새로 추가된 인물만 더한다.
   */
  private async scanCastInteractive(): Promise<void> {
    const list = this.plugin.phone.activeSnsList();
    const picked = await ScenarioSelectModal.open(
      this.plugin,
      list?.scenarioIds ?? [],
      { title: "인물을 찾을 세계 (하나만 고르세요)" }
    );
    const scenarioId = picked?.[0];
    if (!scenarioId) return;
    new Notice("로어북에서 인물을 찾는 중…");
    const res = await this.plugin.phone.scanLorebookCast(scenarioId, {
      force: true,
    });
    if (!res.ok) {
      new Notice(res.reason ?? "인물을 찾지 못했습니다.");
      return;
    }
    new Notice(
      res.added > 0
        ? `인물 ${res.added}명을 계정으로 등록했습니다.`
        : "새로 등록할 인물이 없습니다."
    );
  }

  /** 승격 — 이 인물을 어떤 세계(시나리오)의 고정 캐릭터로 삼을지 고른다. */
  private async promoteSnsAccountInteractive(acc: SnsAccount): Promise<void> {
    const picked = await ScenarioSelectModal.open(this.plugin, [], {
      title: `"${acc.name}" 을(를) 연결할 시나리오 (하나만 고르세요)`,
    });
    const scenarioId = picked?.[0];
    if (!scenarioId) return;
    await this.plugin.phone.promoteSnsAccount(acc.id, scenarioId);
    new Notice(`"${acc.name}" 을(를) 고정 캐릭터로 올렸습니다.`);
  }

  /** 밴 — 활성 리스트 피드에 더는 등장하지 않게 한다 (기존 글은 남는다). */
  private banSnsAccountInteractive(acc: SnsAccount): void {
    this.confirmThen(
      "등장 금지",
      `"${acc.name}" 이(가) 이 피드에 더는 나오지 않게 합니다. ` +
        `이미 올라간 글은 그대로 남습니다.`,
      "등장 금지",
      async () => {
        const done = await this.plugin.phone.banSnsAccount(acc.id);
        new Notice(
          done ? "등장을 금지했습니다." : "먼저 리스트를 만들어 주세요."
        );
      }
    );
  }

  /** 계정 편집 모달 열기. */
  private openSnsAccountEditor(acc: SnsAccount): void {
    new SnsAccountEditModal(this.app, acc, async (patch) => {
      await this.plugin.phone.updateSnsAccount(acc.id, patch);
      new Notice("계정을 수정했습니다.");
    }).open();
  }

  /** 새 리스트 — 이름을 받고 바로 팔로우 목록을 고르게 한다. */
  private async createSnsListInteractive(): Promise<void> {
    const name = await this.askText("새 리스트", "리스트 이름", "내 피드");
    if (name === null) return;
    const ids = await ScenarioSelectModal.open(this.plugin, [], {
      title: "팔로우할 인물 (체크 = 이 피드에 이야기 반영)",
    });
    if (!ids) return;
    await this.plugin.phone.createSnsList(name, ids);
  }

  private async editSnsListMembers(list: SnsList): Promise<void> {
    const ids = await ScenarioSelectModal.open(this.plugin, list.scenarioIds, {
      title: `${list.name} — 팔로우 (체크 해제 = 제외)`,
    });
    if (!ids) return;
    await this.plugin.phone.updateSnsList(list.id, { scenarioIds: ids });
  }

  private async editSnsListBans(list: SnsList): Promise<void> {
    const ids = await ScenarioSelectModal.open(
      this.plugin,
      list.bannedScenarioIds ?? [],
      { title: `${list.name} — 밴 (체크한 인물은 이 피드에 안 나옴)` }
    );
    if (!ids) return;
    await this.plugin.phone.updateSnsList(list.id, { bannedScenarioIds: ids });
  }

  private async renameSnsList(list: SnsList): Promise<void> {
    const name = await this.askText("리스트 이름", "리스트 이름", list.name);
    if (name === null) return;
    await this.plugin.phone.updateSnsList(list.id, { name });
  }

  /** 한 줄 입력 (공용 PromptModal 재사용). */
  private askText(
    title: string,
    placeholder: string,
    initial: string
  ): Promise<string | null> {
    return new Promise((resolve) => {
      new PromptModal(this.app, title, placeholder, initial, resolve).open();
    });
  }

  /**
   * 세션 단위 팔로우 — 세션을 고르면 그 이야기에 나오는 사람들(호스트 + 그룹
   * 멤버 전원)이 통째로 들어온다. 최근 세션 목록을 메뉴로 띄운다.
   */
  private async addSnsListFromSession(list: SnsList): Promise<void> {
    const rows = await this.plugin.phone.listRecentSessions();
    if (rows.length === 0) {
      new Notice("플레이한 세션이 아직 없습니다.");
      return;
    }
    const menu = new Menu();
    for (const row of rows) {
      menu.addItem((mi) =>
        mi.setTitle(row.label).onClick(() => {
          void (async () => {
            const ids = await this.plugin.phone.participantsOfSession(
              row.sessionFile
            );
            if (ids.length === 0) {
              new Notice("이 세션에서 인물을 찾지 못했습니다.");
              return;
            }
            await this.plugin.phone.updateSnsList(list.id, {
              scenarioIds: [...list.scenarioIds, ...ids],
            });
            new Notice(`${ids.length}명을 팔로우했습니다.`);
          })();
        })
      );
    }
    menu.showAtPosition({
      x: this.bodyEl.getBoundingClientRect().left + 20,
      y: this.bodyEl.getBoundingClientRect().top + 40,
    });
  }

  private renderSnsFeed(): void {
    this.bodyEl.addClass("is-sns");
    // 번역 보기 상태인데 원문으로 남은 글이 있으면 백그라운드로 채운다
    // (관리 화면은 글을 안 보여주므로 제외).
    if (!this.snsManageOpen) this.maybeAutoTranslateFeed();

    // ── 답글 알림 모아보기 — 내 게시글/댓글에 달린 답글만 (컴포저 숨김). ──
    if (this.snsNotifOpen) {
      this.renderSnsNotifications();
      return;
    }

    // ── 좋아요(맘찍) 한 글 모아보기 — 내가 ♥ 누른 게시글만 (컴포저 숨김). ──
    if (this.snsLikedOpen) {
      this.renderSnsLiked();
      return;
    }

    // ── 관리 화면 (v3) — 리스트/계정 한 화면, 탭으로 전환 (컴포저 숨김). ──
    if (this.snsManageOpen) {
      this.renderSnsManageBar("users", "관리");
      const tabsEl = this.bodyEl.createDiv({
        cls: "ggai-detail-tabs ggai-phone-settings-tabs",
      });
      for (const tab of [
        { id: "lists" as const, label: "리스트" },
        { id: "accounts" as const, label: "계정" },
      ]) {
        const el = tabsEl.createDiv({ cls: "ggai-detail-tab", text: tab.label });
        el.toggleClass("is-active", this.snsManageOpen === tab.id);
        el.addEventListener("click", () => {
          if (this.snsManageOpen === tab.id) return;
          this.snsManageOpen = tab.id;
          this.renderBody();
        });
      }
      if (this.snsManageOpen === "lists") this.renderSnsListManager();
      else void this.renderSnsAccountManager();
      return;
    }

    // ── 계정 모아보기 모드 — 필터 바 + 그 계정 게시글만 (컴포저 숨김). ──
    if (this.snsAccountFilter) {
      const bar = this.bodyEl.createDiv({ cls: "ggai-phone-sns-filterbar" });
      setIcon(bar.createSpan({ cls: "ggai-phone-sns-photo-icon" }), "user");
      bar.createSpan({
        cls: "ggai-phone-sns-filterbar-label",
        text: this.snsAccountFilter.label,
      });
      const closeBtn = bar.createEl("button", {
        cls: "ggai-phone-sns-attach-remove",
        attr: { "aria-label": "모아보기 닫기" },
      });
      setIcon(closeBtn, "x");
      closeBtn.addEventListener("click", () => this.setSnsAccountFilter(null));

      const key = this.snsAccountFilter.key;
      const posts = [...(this.feed?.posts ?? [])]
        .filter((p) => snsAuthorKey(p.author) === key)
        .sort((a, b) => b.createdAt - a.createdAt);
      if (posts.length === 0) {
        this.bodyEl.createDiv({
          cls: "ggai-phone-empty",
          text: "이 계정의 게시글이 없습니다.",
        });
        return;
      }
      for (const post of posts) this.renderSnsPost(post);
      return;
    }

    // ── 리스트(v3) — 팔로우한 세계가 없으면 피드는 조용하다. 첫 화면은
    //    "아직 팔로우한 계정이 없습니다" + 팔로우 관리뿐. ──
    const lists = this.plugin.phone.listSnsLists();
    if (lists.length === 0 && (this.feed?.posts.length ?? 0) === 0) {
      // 아직 아무것도 없는 첫 화면 — 만드는 두 경로만 크게 보여준다.
      this.renderSnsFollowEmpty();
      return;
    }
    // 리스트가 없어도 칩 바(= 팔로우 진입점)는 항상 피드 위에 둔다. 이미 쌓인
    // 글이 있는 볼트에서 팔로우 버튼이 안내 박스 안에만 있으면 사실상 숨는다.
    this.renderSnsListBar(lists);

    // ── 게시 컴포저 — 아바타 + 글 + 사진 첨부 (인스타처럼). ──
    const composer = this.bodyEl.createDiv({ cls: "ggai-phone-sns-compose" });
    const row = composer.createDiv({ cls: "ggai-phone-sns-compose-row" });
    if (this.loginProfile) {
      this.renderAuthorAvatar(row, {
        kind: "persona",
        id: this.loginProfile.id,
        name: this.loginProfile.name || "User",
      });
    }
    const ta = row.createEl("textarea", {
      cls: "ggai-phone-input",
      attr: {
        rows: "2",
        placeholder: `${this.loginProfile?.name ?? "나"}(으)로 게시하기…`,
      },
    });
    // 재렌더를 넘어 살아남는 초안 (필드가 진실 소스).
    ta.value = this.snsDraft;
    ta.addEventListener("input", () => {
      this.snsDraft = ta.value;
    });
    ta.addEventListener("blur", () => this.flushSnsDirty());
    // 첨부 미리보기.
    if (this.pendingAttach) {
      const preview = composer.createDiv({ cls: "ggai-phone-sns-attach" });
      const img = preview.createEl("img");
      img.src = this.app.vault.adapter.getResourcePath(this.pendingAttach.path);
      const removeBtn = preview.createEl("button", {
        cls: "ggai-phone-sns-attach-remove",
        attr: { "aria-label": "첨부 제거" },
      });
      setIcon(removeBtn, "x");
      removeBtn.addEventListener("click", () => {
        this.pendingAttach = null;
        this.renderBody();
      });
    }
    const btnRow = composer.createDiv({ cls: "ggai-phone-sns-compose-actions" });
    const attachBtn = btnRow.createEl("button", {
      cls: "ggai-phone-sns-reply-btn is-attach",
    });
    setIcon(attachBtn.createSpan({ cls: "ggai-phone-sns-photo-icon" }), "image");
    attachBtn.createSpan({ text: " 사진" });
    attachBtn.addEventListener("click", () => {
      new PhoneImagePickerModal(this.plugin, (picked) => {
        this.pendingAttach = picked;
        // 쓰던 글로 커서를 돌려준다 (첨부 미리보기 때문에 다시 그려야 한다).
        this.focusSnsComposer = true;
        this.renderBody();
      }).open();
    });
    const postBtn = btnRow.createEl("button", {
      cls: "ggai-phone-sns-post-btn",
      text: "게시",
    });
    postBtn.addEventListener("click", () => {
      const text = ta.value.trim();
      if ((!text && !this.pendingAttach) || !this.loginProfile) return;
      const attach = this.pendingAttach;
      ta.value = "";
      this.snsDraft = "";
      this.pendingAttach = null;
      this.snsDirty = false;
      void this.plugin.phone.postToSns(
        this.loginProfile,
        text,
        attach
          ? {
              asset: attach.path,
              registerGallery: attach.isNewUpload,
              caption: attach.caption,
            }
          : undefined
      );
    });

    // 공유로 진입했거나 사진을 첨부한 직후 — 쓰던 자리(글 끝)로 커서 복귀.
    if (this.focusSnsComposer) {
      this.focusSnsComposer = false;
      window.requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    }

    // 표시 순서 = max(작성, 붐업) — 다시 화제가 된 글이 상위로 재부상 (v2).
    const effectiveAt = (p: SnsPost) => Math.max(p.createdAt, p.bumpedAt ?? 0);
    const posts = [...(this.feed?.posts ?? [])].sort(
      (a, b) => effectiveAt(b) - effectiveAt(a)
    );
    if (posts.length === 0) {
      this.bodyEl.createDiv({
        cls: "ggai-phone-empty",
        text: "아직 피드가 조용합니다. 첫 글을 올리거나 갱신을 기다려 보세요.",
      });
      return;
    }
    for (const post of posts) this.renderSnsPost(post);
  }

  /** 게시글 카드 — 미디어 있으면 헤더 → 사진 → 액션(♥/댓글) → 본문 → 댓글,
   *  텍스트만이면 헤더 → 본문 → 액션 → 댓글. */
  private renderSnsPost(post: SnsPost): void {
    const card = this.bodyEl.createDiv({
      cls: "ggai-phone-sns-post",
      attr: { "data-post-id": post.id },
    });
    const showTranslated = this.snsShowTranslated();
    const postText =
      showTranslated && post.translation ? post.translation.text : post.text;

    // 헤더 — 아바타 + 이름 + 세계 서브라벨 + LIVE + 시각. 아바타/이름 탭 = 모아보기.
    const head = card.createDiv({ cls: "ggai-phone-sns-head" });
    const avatarEl = this.renderAuthorAvatar(head, post.author);
    avatarEl.addEventListener("click", () =>
      this.setSnsAccountFilter(post.author)
    );
    const nameWrap = head.createDiv({ cls: "ggai-phone-sns-namewrap" });
    const nameLine = nameWrap.createDiv({ cls: "ggai-phone-sns-nameline" });
    const nameEl = nameLine.createSpan({
      cls: "ggai-phone-sns-name is-clickable",
      text: post.author.name,
    });
    nameEl.addEventListener("click", () => this.setSnsAccountFilter(post.author));
    if (post.author.verified) {
      const badge = nameLine.createSpan({ cls: "ggai-phone-sns-verified" });
      setIcon(badge, "badge-check");
    }
    // 핸들과 소속 세계를 함께 — 어느 세계 사람인지 보이게 (이름=세계면 생략).
    const authorWorld =
      post.author.world && post.author.world !== post.author.name
        ? post.author.world
        : undefined;
    const sub = [post.author.handle, authorWorld].filter(Boolean).join(" · ");
    if (sub) nameWrap.createDiv({ cls: "ggai-phone-sns-world", text: sub });
    if (post.stream) {
      head.createSpan({
        cls: `ggai-phone-sns-live${post.stream.live ? " is-live" : ""}`,
        text: post.stream.live ? "LIVE" : "방송 종료",
      });
    }
    // 이슈 등급 배지 (v2 §6.2) — 3+ 만 표시.
    const issueScale = post.issueScale ?? 2;
    if (issueScale >= 3) {
      head.createSpan({
        cls: "ggai-phone-sns-issue",
        text: `🔥${issueScale}`,
        attr: { "aria-label": `이슈 등급 ${issueScale}` },
      });
    }
    // 붐업 배지 (v2) — 다시 화제가 되어 재부상한 글.
    if (post.bumpedAt && post.bumpedAt > post.createdAt) {
      head.createSpan({ cls: "ggai-phone-sns-bumped", text: "↻ 다시 화제" });
    }
    head.createSpan({
      cls: "ggai-phone-sns-time",
      text: formatTimeShort(post.createdAt),
    });
    // ⋯ 메뉴 — 모아보기/삭제.
    const moreBtn = head.createEl("button", {
      cls: "ggai-phone-icon-btn ggai-phone-sns-more",
      attr: { "aria-label": "게시글 메뉴" },
    });
    setIcon(moreBtn, "more-vertical");
    moreBtn.addEventListener("click", (e) => {
      const menu = new Menu();
      menu.addItem((mi) =>
        mi
          .setTitle("이 계정 모아보기")
          .setIcon("user")
          .onClick(() => this.setSnsAccountFilter(post.author))
      );
      {
        menu.addItem((mi) =>
          mi
            .setTitle("이 게시물 번역 재생성")
            .setIcon("languages")
            .onClick(() => void this.regenerateSnsPostTranslation(post.id))
        );
      }
      menu.addItem((mi) =>
        mi
          .setTitle("게시글 삭제")
          .setIcon("trash-2")
          .onClick(() =>
            this.confirmThen(
              "게시글 삭제",
              "이 게시글과 댓글을 삭제합니다.",
              "삭제",
              () => this.plugin.phone.deleteSnsPost(post.id)
            )
          )
      );
      menu.addItem((mi) =>
        mi
          .setTitle("이 계정 글 모두 삭제")
          .setIcon("user-x")
          .onClick(() =>
            this.confirmThen(
              "계정 글 삭제",
              `${post.author.name}의 게시글과 댓글을 피드에서 모두 삭제합니다.`,
              "삭제",
              () => this.plugin.phone.deleteSnsAccountPosts(post.author)
            )
          )
      );
      menu.showAtMouseEvent(e);
    });

    // 사진 / 방송 화면 — 사진은 탭하면 확대. 파일이 지워졌으면 캡션으로 대체.
    if (
      post.image?.asset &&
      !this.app.vault.getAbstractFileByPath(post.image.asset)
    ) {
      post = { ...post, image: { caption: post.image.caption } };
    }
    if (post.image?.asset) {
      const img = card.createEl("img", { cls: "ggai-phone-sns-photo" });
      img.src = this.app.vault.adapter.getResourcePath(post.image.asset);
      img.alt = post.image.caption;
      img.loading = "lazy";
      const asset = post.image.asset;
      const caption = post.image.caption;
      img.addEventListener("click", () =>
        new ImageLightboxModal(this.app, asset, caption).open()
      );
    } else if (post.image) {
      const ph = card.createDiv({ cls: "ggai-phone-sns-photo-caption" });
      setIcon(ph.createSpan({ cls: "ggai-phone-sns-photo-icon" }), "image");
      ph.createSpan({ text: post.image.caption });
    }
    if (post.stream) {
      const screenDiv = card.createDiv({
        cls: "ggai-phone-sns-text is-stream-screen",
      });
      screenDiv.innerHTML = formatChatText(postText);
    }

    // 액션 줄 — 좋아요 ♥ + 댓글 수 + 답글.
    const renderActions = () => {
      const actions = card.createDiv({ cls: "ggai-phone-sns-actions" });
      const likedByMe =
        !!this.loginProfile &&
        (post.likedBy ?? []).includes(this.loginProfile.id);
      const likeCount = (post.likes ?? 0) + (post.likedBy?.length ?? 0);
      const likeBtn = actions.createEl("button", {
        cls: `ggai-phone-sns-like${likedByMe ? " is-liked" : ""}`,
        attr: { "aria-label": "좋아요" },
      });
      setIcon(likeBtn.createSpan({ cls: "ggai-phone-sns-like-icon" }), "heart");
      if (likeCount > 0) likeBtn.createSpan({ text: formatCount(likeCount) });
      likeBtn.addEventListener("click", () => {
        if (!this.loginProfile) return;
        void this.plugin.phone.togglePostLike(this.loginProfile.id, post.id);
      });
      if (post.replies.length > 0) {
        const c = actions.createSpan({ cls: "ggai-phone-sns-count" });
        setIcon(
          c.createSpan({ cls: "ggai-phone-sns-like-icon" }),
          "message-circle"
        );
        c.createSpan({ text: String(post.replies.length) });
      }
      const replyBtn = actions.createEl("button", {
        cls: "ggai-phone-sns-reply-btn",
        text: "답글",
      });
      replyBtn.addEventListener("click", () => {
        this.replyOpen =
          this.replyOpen?.postId === post.id && !this.replyOpen.parentId
            ? null
            : { postId: post.id };
        this.replyDraft = ""; // 다른 글의 답글칸으로 옮겨가면 초안도 새로.
        this.renderBody();
      });
      // 번역 표시는 폰 설정의 "자동 번역"으로 일괄 제어한다 (항목별 버튼 없음).
    };

    // 본문 (캡션) — 방송이 아닐 때만 (방송은 위의 화면이 본문).
    const renderCaption = () => {
      if (post.stream || !post.text.trim()) return;
      const bodyDiv = card.createDiv({ cls: "ggai-phone-sns-text" });
      bodyDiv.createSpan({
        cls: "ggai-phone-sns-name is-inline",
        text: post.author.name + " ",
      });
      const span = bodyDiv.createSpan();
      span.innerHTML = formatChatText(postText);
    };

    // 사진/방송이 있으면 인스타 순서(미디어 → 액션 → 캡션),
    // 텍스트만 있으면 글 → 액션 순서 (좋아요 줄이 본문 위에 뜨지 않게).
    if (post.image || post.stream) {
      renderActions();
      renderCaption();
    } else {
      renderCaption();
      renderActions();
    }

    // 댓글 2단 트리 — 등급 3+ 는 5개까지만 공개 + [더 보기] (v2 §6.7).
    const topReplies = post.replies.filter((r) => !r.parentId);
    const collapsed =
      issueScale >= 3 &&
      !this.snsExpanded.has(post.id) &&
      post.replies.length > 5;
    let rendered = 0;
    if (topReplies.length > 0) {
      const replies = card.createDiv({ cls: "ggai-phone-sns-replies" });
      outer: for (const r of topReplies) {
        if (collapsed && rendered >= 5) break;
        this.renderSnsReply(replies, post.id, r, false);
        rendered++;
        for (const child of post.replies.filter((c) => c.parentId === r.id)) {
          if (collapsed && rendered >= 5) break outer;
          this.renderSnsReply(replies, post.id, child, true);
          rendered++;
        }
      }
    }
    if (issueScale >= 3) {
      const hidden = post.replies.length - rendered;
      const busy = this.snsMoreBusy.has(post.id);
      const moreReplies = card.createEl("button", {
        cls: "ggai-phone-sns-reply-btn ggai-phone-sns-more-replies",
        text: busy
          ? "반응 불러오는 중…"
          : collapsed
            ? `더 보기 (${hidden}개)`
            : "반응 더 불러오기",
      });
      moreReplies.disabled = busy;
      moreReplies.addEventListener("click", () => {
        if (this.snsMoreBusy.has(post.id)) return;
        this.snsExpanded.add(post.id);
        if (collapsed) this.renderBody();
        void this.loadMoreSnsReplies(post.id);
      });
    }
    if (this.replyOpen?.postId === post.id) {
      this.renderSnsReplyCompose(card, post.id, this.replyOpen.parentId);
    }
  }

  /** [더 보기] 실행 — 미니 배치 생성 (스로틀/실패는 Notice 로 안내). */
  private async loadMoreSnsReplies(postId: string): Promise<void> {
    if (!this.loginProfile) return;
    this.snsMoreBusy.add(postId);
    this.renderBody();
    try {
      const result = await this.plugin.phone.loadMoreReplies(
        this.loginProfile,
        postId
      );
      if (!result.ok) new Notice(result.error);
    } finally {
      this.snsMoreBusy.delete(postId);
      this.renderBody();
    }
  }

  /** 답글 한 줄 (nested = 대댓글 들여쓰기) + 좋아요 수 + 그 답글에 답하기 버튼. */
  private renderSnsReply(
    parent: HTMLElement,
    postId: string,
    reply: SnsReply,
    nested: boolean
  ): void {
    const row = parent.createDiv({
      cls: `ggai-phone-sns-reply${nested ? " is-nested" : ""}`,
    });
    // 1줄: 아바타 + 이름 (+ 인증) + 좋아요 수 — 2줄: 본문 전체 폭.
    const head = row.createDiv({ cls: "ggai-phone-sns-reply-head" });
    const avatarEl = this.renderAuthorAvatar(head, reply.author);
    avatarEl.addEventListener("click", () =>
      this.setSnsAccountFilter(reply.author)
    );
    const nameEl = head.createSpan({
      cls: "ggai-phone-sns-name is-clickable",
      text: reply.author.name,
    });
    nameEl.addEventListener("click", () =>
      this.setSnsAccountFilter(reply.author)
    );
    if (reply.author.world && reply.author.world !== reply.author.name) {
      head.createSpan({
        cls: "ggai-phone-sns-reply-world",
        text: reply.author.world,
      });
    }
    if (reply.author.verified) {
      setIcon(
        head.createSpan({ cls: "ggai-phone-sns-verified is-small" }),
        "badge-check"
      );
    }
    if ((reply.likes ?? 0) > 0) {
      head.createSpan({
        cls: "ggai-phone-sns-reply-likes",
        text: `♥ ${formatCount(reply.likes ?? 0)}`,
      });
    }
    const rt = row.createDiv({ cls: "ggai-phone-sns-reply-text" });
    const shownReply =
      this.snsShowTranslated() && reply.translation
        ? reply.translation.text
        : reply.text;
    rt.innerHTML = formatChatText(shownReply);
    const btn = row.createEl("button", {
      cls: "ggai-phone-sns-reply-btn",
      text: "답글",
    });
    btn.addEventListener("click", () => {
      const same =
        this.replyOpen?.postId === postId &&
        this.replyOpen?.parentId === reply.id;
      this.replyOpen = same ? null : { postId, parentId: reply.id };
      this.replyDraft = "";
      this.renderBody();
    });
    // 우클릭(PC)/길게 누르기(모바일) — 댓글 삭제 (대댓글 포함).
    const openReplyMenu = (x: number, y: number) => {
      const menu = new Menu();
      menu.addItem((mi) =>
        mi
          .setTitle("댓글 삭제")
          .setIcon("trash-2")
          .onClick(() =>
            this.confirmThen(
              "댓글 삭제",
              "이 댓글(대댓글 포함)을 삭제합니다.",
              "삭제",
              () => this.plugin.phone.deleteSnsReply(postId, reply.id)
            )
          )
      );
      menu.showAtPosition({ x, y });
    };
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openReplyMenu(e.clientX, e.clientY);
    });
    attachLongPress(row, { onLongPress: openReplyMenu });
  }

  /** 답글 입력칸 — 게시글 답글 또는 대댓글 (parentId). */
  private renderSnsReplyCompose(
    card: HTMLElement,
    postId: string,
    parentId?: string
  ): void {
    const replyBox = card.createDiv({ cls: "ggai-phone-sns-reply-compose" });
    const rta = replyBox.createEl("textarea", {
      cls: "ggai-phone-input",
      attr: { rows: "1", placeholder: "답글 남기기…" },
    });
    const sendBtn = replyBox.createEl("button", {
      cls: "ggai-phone-sns-post-btn",
      text: "전송",
    });
    // 글 작성칸과 같은 이유로 초안은 필드에 산다 (재렌더 생존).
    rta.value = this.replyDraft;
    rta.addEventListener("input", () => {
      this.replyDraft = rta.value;
    });
    sendBtn.addEventListener("click", () => {
      const text = rta.value.trim();
      if (!text || !this.loginProfile) return;
      this.replyOpen = null;
      this.replyDraft = "";
      this.snsDirty = false;
      void this.plugin.phone.replyToSnsPost(
        this.loginProfile,
        postId,
        text,
        parentId
      );
    });
    rta.addEventListener("blur", () => this.flushSnsDirty());
    window.setTimeout(() => {
      rta.focus();
      rta.setSelectionRange(rta.value.length, rta.value.length);
    }, 0);
  }

  /** SNS 번역본을 보여줄지 (공통 getter 위임). */
  private snsShowTranslated(): boolean {
    return this.showTranslated("sns");
  }

  /** 문자 번역본을 보여줄지 (공통 getter 위임). */
  private showMsgTranslated(): boolean {
    return this.showTranslated("messages");
  }

  // ─────────────────────────── 답글 알림 (모아보기) ───────────────────────────

  /**
   * 내 게시글/댓글에 달린 (내가 아닌) 답글을 최신순으로 모은다.
   *  - 내 게시글에 달린 답글 = reason "post"
   *  - 내 댓글에 달린 답글(parentId 가 내 댓글) = reason "comment"
   * 같은 답글이 둘 다 해당하면 "comment" 를 우선한다(중복 방지).
   */
  private computeSnsNotifications(): SnsNotification[] {
    const viewerId = this.loginProfile?.id;
    if (!viewerId || !this.feed) return [];
    const isViewer = (a: SnsAuthor) =>
      a.kind === "persona" && a.id === viewerId;
    const out = new Map<string, SnsNotification>();
    for (const post of this.feed.posts) {
      const myReplyIds = new Set(
        post.replies.filter((r) => isViewer(r.author)).map((r) => r.id)
      );
      const postMine = isViewer(post.author);
      if (!postMine && myReplyIds.size === 0) continue;
      for (const r of post.replies) {
        if (isViewer(r.author)) continue;
        if (r.parentId && myReplyIds.has(r.parentId)) {
          out.set(r.id, { post, reply: r, reason: "comment" });
        } else if (postMine) {
          out.set(r.id, { post, reply: r, reason: "post" });
        }
      }
    }
    return [...out.values()].sort(
      (a, b) => b.reply.createdAt - a.reply.createdAt
    );
  }

  /** 마지막 확인 이후 새로 달린 답글 수 (벨 배지). */
  private countUnreadNotifications(): number {
    const seen = this.plugin.data.phone?.snsNotifSeenAt ?? 0;
    return this.computeSnsNotifications().filter(
      (n) => n.reply.createdAt > seen
    ).length;
  }

  /** 벨 토글 — 열면 안 읽음을 확인 처리(seenAt 저장). */
  private toggleNotifications(): void {
    this.snsNotifOpen = !this.snsNotifOpen;
    if (this.snsNotifOpen) {
      this.snsAccountFilter = null;
      void this.markSnsNotificationsSeen();
    }
    this.renderHeader();
    this.renderBody();
    this.updateComposerState();
  }

  private async markSnsNotificationsSeen(): Promise<void> {
    await this.plugin.savePluginData({
      phone: { ...(this.plugin.data.phone ?? {}), snsNotifSeenAt: Date.now() },
    });
  }

  private renderSnsNotifications(): void {
    // 상단 바 — 닫기.
    const bar = this.bodyEl.createDiv({ cls: "ggai-phone-sns-filterbar" });
    setIcon(bar.createSpan({ cls: "ggai-phone-sns-photo-icon" }), "bell");
    bar.createSpan({
      cls: "ggai-phone-sns-filterbar-label",
      text: "답글 알림",
    });
    const closeBtn = bar.createEl("button", {
      cls: "ggai-phone-sns-attach-remove",
      attr: { "aria-label": "알림 닫기" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.toggleNotifications());

    const notifs = this.computeSnsNotifications();
    if (notifs.length === 0) {
      const empty = this.bodyEl.createDiv({ cls: "ggai-phone-empty" });
      empty.createDiv({ text: "아직 답글 알림이 없습니다." });
      empty.createDiv({
        cls: "ggai-phone-empty-sub",
        text: "내 게시글이나 댓글에 누군가 답글을 달면 여기 모입니다.",
      });
      return;
    }
    const showTr = this.snsShowTranslated();
    for (const n of notifs) {
      const row = this.bodyEl.createDiv({ cls: "ggai-phone-notif-row" });
      this.renderAuthorAvatar(row, n.reply.author);
      const main = row.createDiv({ cls: "ggai-phone-notif-main" });
      const head = main.createDiv({ cls: "ggai-phone-notif-head" });
      head.createSpan({
        cls: "ggai-phone-sns-name",
        text: n.reply.author.name,
      });
      head.createSpan({
        cls: "ggai-phone-notif-reason",
        text:
          n.reason === "comment"
            ? " 님이 내 댓글에 답글"
            : " 님이 내 게시글에 답글",
      });
      head.createSpan({
        cls: "ggai-phone-sns-time",
        text: formatTimeShort(n.reply.createdAt),
      });
      const body = main.createDiv({ cls: "ggai-phone-notif-text" });
      const shown =
        showTr && n.reply.translation ? n.reply.translation.text : n.reply.text;
      body.innerHTML = formatChatText(shown);
      const ctx = n.post.text.replace(/\s+/g, " ").trim().slice(0, 50);
      if (ctx) {
        main.createDiv({
          cls: "ggai-phone-notif-context",
          text: `↳ ${ctx}`,
        });
      }
      row.addEventListener("click", () => this.jumpToPost(n.post.id));
    }
  }

  /** 좋아요(맘찍) 한 글 모아보기 — 내가 ♥ 누른 게시글을 최신순으로. */
  private renderSnsLiked(): void {
    const bar = this.bodyEl.createDiv({ cls: "ggai-phone-sns-filterbar" });
    setIcon(bar.createSpan({ cls: "ggai-phone-sns-photo-icon" }), "heart");
    bar.createSpan({
      cls: "ggai-phone-sns-filterbar-label",
      text: "좋아요 한 글",
    });
    const closeBtn = bar.createEl("button", {
      cls: "ggai-phone-sns-attach-remove",
      attr: { "aria-label": "닫기" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => {
      this.snsLikedOpen = false;
      this.renderHeader();
      this.renderBody();
      this.updateComposerState();
    });

    const viewerId = this.loginProfile?.id;
    const posts = viewerId
      ? [...(this.feed?.posts ?? [])]
          .filter((p) => (p.likedBy ?? []).includes(viewerId))
          .sort((a, b) => b.createdAt - a.createdAt)
      : [];
    if (posts.length === 0) {
      const empty = this.bodyEl.createDiv({ cls: "ggai-phone-empty" });
      empty.createDiv({ text: "아직 좋아요 한 글이 없습니다." });
      empty.createDiv({
        cls: "ggai-phone-empty-sub",
        text: "게시글의 ♥ 를 누르면 여기 모입니다.",
      });
      return;
    }
    for (const post of posts) this.renderSnsPost(post);
  }

  /** 알림에서 게시글로 이동 — 피드로 돌아가 그 글로 스크롤/강조. */
  private jumpToPost(postId: string): void {
    this.snsNotifOpen = false;
    this.snsAccountFilter = null;
    this.renderHeader();
    this.renderBody();
    this.updateComposerState();
    window.requestAnimationFrame(() => {
      const el = this.bodyEl.querySelector(
        `.ggai-phone-sns-post[data-post-id="${window.CSS.escape(postId)}"]`
      );
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: "center" });
        el.addClass("is-flash");
        window.setTimeout(() => el.removeClass("is-flash"), 1400);
      }
    });
  }

  /** 입력 중이라 미뤄둔 피드 재렌더를 입력이 끝난 뒤 반영. */
  private flushSnsDirty(): void {
    if (!this.snsDirty || this.screen !== "sns") return;
    this.snsDirty = false;
    // blur 직후 클릭 대상(게시 버튼 등)이 먼저 처리되도록 한 틱 미룬다.
    window.setTimeout(() => {
      if (this.screen === "sns" && !this.isSnsComposing()) this.renderBody();
    }, 120);
  }

  // ─────────────────────────── 스텔라튜브 (v2 §7) ───────────────────────────

  /** 방송 목록 재로드 — 라이브 뷰는 채팅 append 국소 갱신, 실패 시 전체 렌더. */
  private async reloadStreams(): Promise<void> {
    const streams = await this.plugin.store
      .listSessionStreams()
      .catch(
        (): Awaited<
          ReturnType<StellaEnginePlugin["store"]["listSessionStreams"]>
        > => []
      );
    this.streams = streams;
    if (this.screen === "tube") {
      if (!(await this.tryAppendTubeChat())) this.renderBody();
    } else if (this.screen === "home") {
      // 홈의 LIVE 배지 갱신.
      this.renderBody();
    }
  }

  /**
   * 튜브 화면이 보여줄 방송 — 열어 본 것 > 라이브.
   * 방송이 여러 개 켜질 수 있으므로(세션당 1개, 볼트 전역 제한 없음) 라이브가
   * 둘 이상이면 **지금 열어 둔 세션의 방송**을 우선하고, 그것도 없으면 목록을
   * 보여준다(엉뚱한 방송이 멋대로 열리지 않게).
   */
  private currentTubeItem(): {
    sessionFile: string;
    stream: SessionStreamFile;
  } | null {
    if (this.openStreamFile) {
      return (
        this.streams.find((s) => s.sessionFile === this.openStreamFile) ?? null
      );
    }
    const live = this.streams.filter((s) => s.stream.live);
    if (live.length === 0) return null;
    if (live.length === 1) return live[0];
    const openFile = this.plugin.phone.openSessionFile();
    return live.find((s) => s.sessionFile === openFile) ?? null;
  }

  private renderTube(): void {
    this.bodyEl.addClass("is-tube");
    this.tubeChatEl = null;
    this.tubeViewersEl = null;
    this.tubeShownFile = null;
    this.tubeRenderedChatIds = new Set();
    const item = this.currentTubeItem();
    if (item) {
      void this.renderTubeStream(item);
      return;
    }
    this.renderTubeReplayList();
  }

  /** 다시보기 목록 — 종료된 방송 (라이브가 없을 때의 첫 화면). */
  private renderTubeReplayList(): void {
    const list = [...this.streams].sort(
      (a, b) =>
        (b.stream.endedAt ?? b.stream.startedAt) -
        (a.stream.endedAt ?? a.stream.startedAt)
    );
    if (list.length === 0) {
      const empty = this.bodyEl.createDiv({ cls: "ggai-phone-empty" });
      empty.createDiv({ text: "아직 방송이 없습니다." });
      empty.createDiv({
        cls: "ggai-phone-empty-sub",
        text: "세션 메뉴의 [이 장면 방송하기]로 지금 장면을 생중계하면 시청자 채팅이 달립니다.",
      });
      return;
    }
    for (const item of list) {
      const { stream } = item;
      const row = this.bodyEl.createDiv({
        cls: "ggai-phone-contact ggai-phone-tube-row",
      });
      const thumb = row.createDiv({
        cls: "ggai-phone-contact-thumb is-tube-replay",
      });
      setIcon(thumb, stream.live ? "radio-tower" : "tv");
      const main = row.createDiv({ cls: "ggai-phone-contact-main" });
      const nameEl = main.createDiv({ cls: "ggai-phone-contact-name" });
      nameEl.createSpan({ text: `${stream.streamer.name}의 방송` });
      if (stream.live) {
        nameEl.createSpan({ cls: "ggai-phone-sns-live is-live", text: "LIVE" });
      }
      const reactions = Object.values(stream.nodes);
      const peak = reactions.reduce(
        (m, r) => Math.max(m, r.viewers),
        stream.startViewers
      );
      main.createDiv({
        cls: "ggai-phone-contact-preview",
        text:
          `${formatTimeShort(stream.startedAt)} · 반응 ${reactions.length}` +
          ` · 최고 시청 ${formatCount(peak)}`,
      });
      row.addEventListener("click", () => {
        this.markTubeSeen();
        this.openStreamFile = item.sessionFile;
        this.renderBody();
      });
      // 다시보기 삭제 — 우클릭/길게 누르기 (사용자 결정: 보관 + 개별 삭제).
      const openRowMenu = (x: number, y: number) => {
        const menu = new Menu();
        menu.addItem((mi) =>
          mi
            .setTitle("방송 기록 삭제")
            .setIcon("trash-2")
            .onClick(() =>
              this.confirmThen(
                "방송 기록 삭제",
                `${stream.streamer.name}의 방송 기록(채팅 포함)을 삭제합니다.`,
                "삭제",
                async () => {
                  await this.plugin.store.deleteSessionStream(item.sessionFile);
                }
              )
            )
        );
        menu.showAtPosition({ x, y });
      };
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openRowMenu(e.clientX, e.clientY);
      });
      attachLongPress(row, { onLongPress: openRowMenu });
    }
  }

  /**
   * 이 방송이 지금 활성 경로 위에 있는가 — 되감기·분기 전환으로 방송 시작
   * 지점(startedNodeId)이 경로에서 빠지면 서사상 아직 방송을 켜지 않은 지점이다.
   * live 는 유지하되(앞으로 다시 가면 그대로 이어진다) 화면은 대기 상태로.
   */
  private tubeOnActivePath(
    stream: SessionStreamFile,
    session: Parameters<typeof pathToLeaf>[0] | null
  ): boolean {
    if (!stream.live || !session || !stream.startedNodeId) return true;
    return pathToLeaf(session, session.meta.activeLeafId).some(
      (n) => n.id === stream.startedNodeId
    );
  }

  /** 표시할 반응 노드 순서 — 라이브는 활성 경로 기준, 다시보기는 시간순. */
  private tubeOrderedNodeIds(
    stream: SessionStreamFile,
    session: Parameters<typeof pathToLeaf>[0] | null
  ): string[] {
    if (stream.live && session) {
      const path = pathToLeaf(session, session.meta.activeLeafId).map(
        (n) => n.id
      );
      return path.filter((id) => stream.nodes[id]);
    }
    return Object.keys(stream.nodes).sort(
      (a, b) => stream.nodes[a].at - stream.nodes[b].at
    );
  }

  /** 표시 순서대로 평탄화한 채팅 목록 (id 로 국소 append 를 추적한다). */
  private tubeOrderedChat(
    stream: SessionStreamFile,
    session: Parameters<typeof pathToLeaf>[0] | null
  ): StreamChatItem[] {
    return this.tubeOrderedNodeIds(stream, session).flatMap(
      (id) => stream.nodes[id].chat
    );
  }

  /** 라이브 뷰/다시보기 — 방송 화면 + 실시간 채팅 + 시청자 오버레이. */
  private async renderTubeStream(item: {
    sessionFile: string;
    stream: SessionStreamFile;
  }): Promise<void> {
    const { stream } = item;
    const wrap = this.bodyEl.createDiv({ cls: "ggai-phone-tube" });
    const screenBox = wrap.createDiv({ cls: "ggai-phone-tube-screen" });
    // 방송 화면 = 삽화(활성 노드)가 있으면 그 이미지, 없으면 스트리머 이니셜
    // 플레이스홀더. 장면 텍스트는 넣지 않는다 (사용자 요청 — 영상 화면답게).
    const stage = screenBox.createDiv({ cls: "ggai-phone-tube-stage" });
    const overlay = screenBox.createDiv({ cls: "ggai-phone-tube-overlay" });
    overlay.createSpan({
      cls: stream.live ? "ggai-phone-sns-live is-live" : "ggai-phone-sns-live",
      text: stream.live ? "LIVE" : "다시보기",
    });
    overlay.createSpan({
      cls: "ggai-phone-tube-streamer",
      text: stream.streamer.name,
    });
    this.tubeViewersEl = overlay.createSpan({ cls: "ggai-phone-tube-viewers" });

    const chatWrap = wrap.createDiv({ cls: "ggai-phone-tube-chat" });
    this.tubeChatEl = chatWrap;
    this.tubeShownFile = item.sessionFile;

    const session = await this.plugin.store
      .getSession(item.sessionFile)
      .catch(() => null);
    await this.paintTubeStage(stage, item.sessionFile, session, stream);

    // 되감기·분기 전환으로 방송 시작 지점이 활성 경로에서 빠졌으면 "아직 켜지지
    // 않은 지점"이다 — LIVE 표시를 대기로 바꾸고 채팅도 비운다(방송 자체는 유지,
    // 앞으로 다시 가면 그대로 이어진다).
    const onPath = this.tubeOnActivePath(stream, session);
    if (!onPath) {
      overlay.empty();
      overlay.createSpan({ cls: "ggai-phone-sns-live", text: "대기" });
      overlay.createSpan({
        cls: "ggai-phone-tube-streamer",
        text: stream.streamer.name,
      });
      this.tubeViewersEl = overlay.createSpan({
        cls: "ggai-phone-tube-viewers",
      });
    }

    const ordered = onPath ? this.tubeOrderedChat(stream, session) : [];
    // 지난번에 보다 만 지점 — 이 방송을 여는 첫 렌더에서만 새로 잡는다.
    if (this.tubeSeenFile !== item.sessionFile) {
      this.tubeSeenFile = item.sessionFile;
      this.tubeSeenMark =
        this.plugin.data.phone?.tubeSeen?.[item.sessionFile] ?? null;
    }
    // 기준을 못 찾으면(처음 여는 방송, 재생성으로 경로가 바뀜) 전부 "이미 있던
    // 것"으로 조용히 그린다 — 예전 채팅이 새것처럼 쏟아지는 게 원래 문제였다.
    const seenIdx = this.tubeSeenMark
      ? ordered.findIndex((c) => c.id === this.tubeSeenMark)
      : -1;
    const splitAt = seenIdx >= 0 ? seenIdx + 1 : ordered.length;
    this.tubeRenderedChatIds = new Set();
    this.appendTubeChat(chatWrap, ordered.slice(0, splitAt), {
      animate: false,
    });
    const fresh = ordered.slice(splitAt);
    if (fresh.length > 0) {
      chatWrap.createDiv({
        cls: "ggai-phone-tube-seen-mark",
        text: `여기까지 봤어요 · 새 채팅 ${fresh.length}`,
      });
      this.appendTubeChat(chatWrap, fresh);
    }
    this.updateTubeViewers(stream, session);
    if (ordered.length === 0) {
      chatWrap.createDiv({
        cls: "ggai-phone-tube-chat-empty",
        text: !onPath
          ? "이 지점은 방송 시작 전입니다. 이야기를 다시 진행하면 방송이 이어집니다."
          : stream.live
            ? "시청자 입장 중… 장면이 이어지면 채팅이 달립니다."
            : "채팅 기록이 없습니다.",
      });
    }
    chatWrap.scrollTop = chatWrap.scrollHeight;
    // 자동 번역(또는 번역 보기)이면 여는 순간 아직 번역 안 된 채팅을 채운다 —
    // 지난 방송(다시보기)은 생성 시점에 번역이 없어(또는 예전 버그로) 원문으로
    // 남아 있었다. 방송은 한 번에 하나만 열려 비용이 바운드된다.
    this.maybeAutoTranslateStream(item);
  }

  /**
   * 표시 시점 자동 번역 보충 게이트 (문자·SNS·방송 공용) — 아직 번역 안 된 항목이
   * 있으면 true. 단 **지난 시도와 미번역 집합이 똑같으면**(= 그 시도로 아무것도
   * 못 채웠으면) false 를 돌려 실패 루프를 막는다. 일부라도 채워졌으면 집합이
   * 달라지므로 남은 항목을 이어서 다시 시도한다.
   */
  private shouldFillTranslations(key: string, pendingIds: string[]): boolean {
    if (pendingIds.length === 0 || this.translateBusy.has(key)) return false;
    const sig = `${pendingIds.length}:${pendingIds.join(",")}`;
    if (this.autoTrTried.get(key) === sig) return false;
    this.autoTrTried.set(key, sig);
    return true;
  }

  /** 피드에서 아직 번역이 없는 글·댓글 id (빈 글 제외). */
  private pendingFeedTranslationIds(): string[] {
    const out: string[] = [];
    for (const p of this.feed?.posts ?? []) {
      if (!p.translation && p.text.trim() !== "") out.push(p.id);
      for (const r of p.replies) {
        if (!r.translation && r.text.trim() !== "") out.push(r.id);
      }
    }
    return out;
  }

  /** 지금 열린 문자 스레드에서 아직 번역이 없는 문자 id. */
  private pendingThreadTranslationIds(): string[] {
    return (this.currentThread()?.messages ?? [])
      .filter((m) => !m.translation && m.text.trim() !== "")
      .map((m) => m.id);
  }

  /**
   * 문자 스레드를 그릴 때 자동 번역 채우기 — SNS·방송과 같은 규칙(생성 시점에
   * 빠진 문자를 표시 시점에 이어 채운다).
   */
  private maybeAutoTranslateThread(): void {
    if (!this.loginProfile || !this.openTarget) return;
    if (!this.showTranslated("messages")) return;
    const key = PhoneService.targetKey(this.openTarget);
    const target = this.openTarget;
    const personaId = this.loginProfile.id;
    if (!this.shouldFillTranslations(key, this.pendingThreadTranslationIds())) {
      return;
    }
    this.translateBusy.add(key);
    void this.plugin.phone
      .translateThread(personaId, target)
      .then(() => {
        this.translateBusy.delete(key);
        if (this.screen === "messages") void this.reloadMessages();
      })
      .catch(() => {
        this.translateBusy.delete(key);
      });
  }

  /** 그 방송에서 아직 번역이 없는 채팅 id. */
  private pendingStreamTranslationIds(stream: SessionStreamFile): string[] {
    const out: string[] = [];
    for (const n of Object.values(stream.nodes)) {
      for (const c of n.chat) {
        if (!c.translation && c.text.trim() !== "") out.push(c.id);
      }
    }
    return out;
  }

  /**
   * SNS 피드를 그릴 때 자동 번역 채우기 — 번역 보기 상태(자동 번역 or 수동 토글)인데
   * 원문으로 남은 글·댓글이 있으면 백그라운드로 채운다. 자동 번역은 생성 시점 1회
   * 시도뿐이라, 설정을 켜기 전에 쌓인 글·청크 실패분은 이 경로가 없으면 영원히
   * 원문이었다("일부만 번역됨"의 원인).
   */
  private maybeAutoTranslateFeed(): void {
    if (!this.showTranslated("sns")) return;
    const pending = this.pendingFeedTranslationIds();
    const key = "sns:feed";
    if (!this.shouldFillTranslations(key, pending)) return;
    this.translateBusy.add(key);
    void this.plugin.phone
      .translateFeed()
      .then(() => {
        this.translateBusy.delete(key);
        if (this.screen === "sns") void this.reloadFeed();
      })
      .catch(() => {
        this.translateBusy.delete(key);
      });
  }

  /**
   * 방송이 열릴 때 자동 번역 채우기 — 번역 보기 상태(자동 번역 or 수동 토글)이고
   * 아직 번역 안 된 채팅이 있으면 백그라운드로 번역한 뒤 갱신한다.
   */
  private maybeAutoTranslateStream(item: {
    sessionFile: string;
    stream: SessionStreamFile;
  }): void {
    if (!this.showTranslated("tube")) return;
    const key = `tube:${item.sessionFile}`;
    const pending = this.pendingStreamTranslationIds(item.stream);
    // 라이브 중 새로 온 채팅이 인라인 번역에서 빠졌으면 여기서 이어 채운다
    // (예전의 "방송당 1회" 가드는 그 몫을 영영 못 채웠다).
    if (!this.shouldFillTranslations(key, pending)) return;
    this.translateBusy.add(key);
    void this.plugin.phone
      .translateStream(item.sessionFile)
      .then(() => {
        this.translateBusy.delete(key);
        // 아직 이 방송을 보고 있으면 번역본으로 갱신.
        if (
          this.screen === "tube" &&
          this.currentTubeItem()?.sessionFile === item.sessionFile
        ) {
          void this.refreshStreamsAndRenderTube();
        }
      })
      .catch(() => {
        this.translateBusy.delete(key);
      });
  }

  /** 방송 화면 그리기 — 활성 노드 삽화가 있으면 이미지, 없으면 이니셜 배경. */
  private async paintTubeStage(
    stage: HTMLElement,
    sessionFile: string,
    session: Parameters<typeof pathToLeaf>[0] | null,
    stream: SessionStreamFile
  ): Promise<void> {
    let assetPath: string | null = null;
    if (session) {
      try {
        const illus = await this.plugin.store.getSessionIllustrations(
          sessionFile
        );
        const entry = illus.nodes[session.meta.activeLeafId];
        const variant = entry?.variants[entry.activeVariantId];
        if (variant?.path) {
          const folder = sessionFile.replace(/\/session\.json$/, "");
          const full = `${folder}/${variant.path}`;
          if (this.app.vault.getAbstractFileByPath(full)) assetPath = full;
        }
      } catch {
        /* 삽화 없음 — 플레이스홀더로 */
      }
    }
    if (assetPath) {
      const img = stage.createEl("img", { cls: "ggai-phone-tube-stage-img" });
      img.src = this.app.vault.adapter.getResourcePath(assetPath);
      return;
    }
    stage.addClass("is-placeholder");
    stage.createDiv({
      cls: "ggai-phone-tube-stage-initial",
      text: (stream.streamer.name.trim()[0] ?? "•").toUpperCase(),
    });
  }

  /**
   * 방송 화면을 떠날 때 "여기까지 봤음"을 저장한다 — 다음에 열면 그 사이 들어온
   * 채팅만 구분선 아래에 새로 흐른다. 보는 동안에는 저장하지 않는다(구분선이
   * 눈앞에서 사라지면 안 된다).
   */
  private markTubeSeen(): void {
    const file = this.tubeSeenFile;
    const last = this.tubeLastChatId;
    this.tubeSeenFile = null;
    this.tubeSeenMark = null;
    this.tubeLastChatId = null;
    if (!file || !last) return;
    const phone = this.plugin.data.phone;
    if (!phone || phone.tubeSeen?.[file] === last) return;
    void this.plugin.savePluginData({
      phone: { ...phone, tubeSeen: { ...(phone.tubeSeen ?? {}), [file]: last } },
    });
  }

  /**
   * 라이브 뷰 국소 갱신 — 아직 안 그린 채팅만 하단에 append 한다 (통짜 재렌더
   * 금지, §7.5). 이미 그린 채팅이 새 목록에서 사라졌으면(재생성/종료) false 를
   * 돌려 전체 렌더로 넘긴다.
   */
  private async tryAppendTubeChat(): Promise<boolean> {
    if (this.screen !== "tube" || !this.tubeChatEl || !this.tubeShownFile) {
      return false;
    }
    if (!this.tubeChatEl.isConnected) return false;
    const item = this.currentTubeItem();
    if (!item || item.sessionFile !== this.tubeShownFile) return false;
    if (!item.stream.live) return false; // 종료 전환 — 배지 갱신 겸 전체 렌더
    const session = await this.plugin.store
      .getSession(item.sessionFile)
      .catch(() => null);
    const ordered = this.tubeOrderedChat(item.stream, session);
    const orderedIds = new Set(ordered.map((c) => c.id));
    for (const id of this.tubeRenderedChatIds) {
      if (!orderedIds.has(id)) return false; // 재생성 등으로 경로가 바뀜
    }
    const fresh = ordered.filter((c) => !this.tubeRenderedChatIds.has(c.id));
    if (fresh.length > 0) {
      this.tubeChatEl.querySelector(".ggai-phone-tube-chat-empty")?.remove();
      this.appendTubeChat(this.tubeChatEl, fresh);
      this.tubeChatEl.scrollTop = this.tubeChatEl.scrollHeight;
    }
    this.updateTubeViewers(item.stream, session);
    return true;
  }

  /**
   * 채팅 줄 append — 실시간 채팅처럼 한 줄씩 계단식 등장 애니메이션.
   * `animate:false` = 이미 본 채팅(화면을 열 때의 과거분)이라 조용히 얹는다.
   */
  private appendTubeChat(
    host: HTMLElement,
    chat: StreamChatItem[],
    opts?: { animate?: boolean }
  ): void {
    // 번역 보기면 번역본, 원문 보기면 원문 (번역 없으면 원문 폴백).
    const showTr = this.showTranslated("tube");
    const animate = opts?.animate !== false;
    let i = 0;
    for (const c of chat) {
      if (this.tubeRenderedChatIds.has(c.id)) continue;
      this.tubeRenderedChatIds.add(c.id);
      this.tubeLastChatId = c.id;
      const row = host.createDiv({
        cls:
          "ggai-phone-tube-line" +
          (animate ? " is-enter" : "") +
          (c.donation ? " is-donation" : ""),
      });
      // 여러 줄이 한꺼번에 들어와도 실시간 채팅처럼 순차로 흘러들어오게.
      if (animate) row.style.animationDelay = `${Math.min(i, 8) * 60}ms`;
      i++;
      if (c.donation) {
        row.createDiv({
          cls: "ggai-phone-tube-donation",
          text: `💰 ${formatCount(c.donation)}`,
        });
      }
      const text = showTr && c.translation ? c.translation.text : c.text;
      row.createSpan({ cls: "ggai-phone-tube-line-name", text: c.name });
      row.createSpan({ cls: "ggai-phone-tube-line-text", text: ` ${text}` });
    }
  }

  private updateTubeViewers(
    stream: SessionStreamFile,
    session: Parameters<typeof pathToLeaf>[0] | null
  ): void {
    if (!this.tubeViewersEl) return;
    const ids = this.tubeOrderedNodeIds(stream, session);
    const last = ids.length > 0 ? stream.nodes[ids[ids.length - 1]] : null;
    this.tubeViewersEl.setText(
      `👁 ${formatCount(last?.viewers ?? stream.startViewers)}`
    );
  }

  // ─────────────────────────── 카메라 (PH5) ───────────────────────────

  private renderCamera(): void {
    this.bodyEl.addClass("is-camera");
    const profile = this.plugin.phone.resolveImageProfile();
    if (!profile) {
      this.bodyEl.createDiv({
        cls: "ggai-phone-empty",
        text: "Core 에 이미지 프로필이 없습니다. 이미지 모델을 추가하면 촬영할 수 있어요.",
      });
      return;
    }

    // ── v2 §2.2 카메라 스킨: 뷰파인더 + 하단 [썸네일 | 셔터 | 모드] 바. ──
    const shots = (this.gallery?.items ?? [])
      .filter((i) => i.source === "camera")
      .sort((a, b) => b.createdAt - a.createdAt);
    const latest = shots[0] ?? null;
    const latestSrc = latest
      ? this.app.vault.adapter.getResourcePath(latest.file)
      : null;

    // 뷰파인더 — 최근 촬영 결과가 채운다 (탭 = 크게, 우클릭/롱프레스 = 공유, v2 §4).
    const finder = this.bodyEl.createDiv({ cls: "ggai-phone-camera-finder" });
    if (latest && latestSrc) {
      const img = finder.createEl("img");
      img.src = latestSrc;
      img.alt = latest.caption;
      img.addEventListener("click", () =>
        new ImageLightboxModal(this.app, latest.file, latest.caption).open()
      );
      img.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openShotMenu(latest, e);
      });
      finder.createDiv({
        cls: "ggai-phone-camera-caption",
        text: latest.caption,
      });
    } else if (!this.cameraBusy) {
      const empty = finder.createDiv({ cls: "ggai-phone-camera-empty" });
      setIcon(empty.createDiv(), "camera");
      empty.createSpan({ text: "아직 찍은 사진이 없어요" });
    }
    if (this.cameraBusy) {
      finder.createDiv({
        cls: "ggai-phone-camera-developing",
        text: "찰칵… 현상 중",
      });
    }

    // 하단 컨트롤 — 장면 묘사 입력 + 셔터 바.
    const controls = this.bodyEl.createDiv({ cls: "ggai-phone-camera-controls" });
    const placeholder = () =>
      this.cameraDirect
        ? "이미지 프롬프트를 직접 입력…"
        : "찍고 싶은 장면을 묘사하세요 (삽화 프롬프트로 자동 변환)…";
    const ta = controls.createEl("textarea", {
      cls: "ggai-phone-camera-prompt",
      attr: { rows: "2", placeholder: placeholder() },
    });
    // 촬영 후에도 프롬프트 유지 — 마음에 안 들면 같은 문구로 바로 재촬영.
    ta.value = this.cameraPrompt;
    ta.addEventListener("input", () => {
      this.cameraPrompt = ta.value;
    });
    const bar = controls.createDiv({ cls: "ggai-phone-camera-bar" });

    // 좌 — 최근 촬영 썸네일 (탭 = 크게, 우클릭/롱프레스 = 공유).
    const thumbBtn = bar.createEl("button", {
      cls: "ggai-phone-camera-side is-thumb",
      attr: { "aria-label": "최근 촬영" },
    });
    if (latest && latestSrc) {
      const t = thumbBtn.createEl("img");
      t.src = latestSrc;
      t.alt = latest.caption;
      thumbBtn.addEventListener("click", () =>
        new ImageLightboxModal(this.app, latest.file, latest.caption).open()
      );
      thumbBtn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openShotMenu(latest, e);
      });
    } else {
      setIcon(thumbBtn, "image");
      thumbBtn.disabled = true;
    }

    // 중앙 — 셔터 원버튼.
    const shutter = bar.createEl("button", {
      cls: "ggai-phone-camera-shutter",
      attr: { "aria-label": "촬영" },
    });
    shutter.disabled = this.cameraBusy;
    if (this.cameraBusy) shutter.addClass("is-busy");
    shutter.addEventListener("click", async () => {
      const prompt = ta.value.trim();
      if (!prompt || this.cameraBusy) return;
      this.cameraPrompt = ta.value;
      this.cameraBusy = true;
      this.renderBody();
      const result = await this.plugin.phone.captureImage(prompt, {
        direct: this.cameraDirect,
      });
      this.cameraBusy = false;
      if (!result.ok) new Notice(`스텔라 폰: ${result.error}`);
      // 성공 시 갤러리 이벤트가 오지만, 카메라 화면은 직접 갱신해 결과를 보여준다.
      this.renderBody();
    });

    // 우 — 프롬프트 직접 입력 모드 토글 (기본 = 삽화 프롬프트 생성 경유).
    //    재렌더 없이 국소 갱신 — 입력 중 텍스트 보존.
    const modeBtn = bar.createEl("button", {
      cls: "ggai-phone-camera-side is-mode",
      attr: { "aria-label": "프롬프트 직접 입력 모드" },
    });
    setIcon(modeBtn, "terminal");
    modeBtn.toggleClass("is-active", this.cameraDirect);
    modeBtn.addEventListener("click", () => {
      this.cameraDirect = !this.cameraDirect;
      modeBtn.toggleClass("is-active", this.cameraDirect);
      ta.placeholder = placeholder();
    });
  }

  /** 카메라 결과 공유 메뉴 — 스텔라 네트워크 게시 / 문자로 보내기 (v2 §4). */
  private openShotMenu(
    shot: { file: string; caption: string },
    e: MouseEvent
  ): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("스텔라 네트워크에 게시")
        .setIcon("share-2")
        .onClick(() => {
          this.pendingAttach = {
            path: shot.file,
            isNewUpload: false,
            caption: shot.caption,
          };
          this.screen = "sns";
          this.snsAccountFilter = null;
          this.focusSnsComposer = true;
          this.renderHeader();
          this.renderBody();
          this.updateComposerState();
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("문자로 보내기…")
        .setIcon("send")
        .onClick(() => {
          if (this.contacts.length === 0) {
            new Notice("등록된 연락처가 없습니다.");
            return;
          }
          const pick = new Menu();
          for (const c of this.contacts) {
            pick.addItem((item2) =>
              item2.setTitle(c.name).onClick(() => {
                this.screen = "messages";
                this.openTarget = {
                  kind: "scenario",
                  scenarioId: c.scenarioId,
                };
                this.pendingMsgAttach = {
                  path: shot.file,
                  isNewUpload: false,
                  caption: shot.caption,
                };
                this.renderHeader();
                this.renderBody();
                this.updateComposerState();
                this.renderMsgAttachPreview();
              })
            );
          }
          pick.showAtMouseEvent(e);
        })
    );
    menu.showAtMouseEvent(e);
  }

  // ─────────────────────────── 입력(컴포저) ───────────────────────────

  private buildComposer(): void {
    // 첨부 미리보기 줄 — 입력창 위 (입력 DOM 은 재렌더에서 제외되므로 국소 갱신).
    this.msgAttachPreviewEl = this.composerEl.createDiv({
      cls: "ggai-phone-msg-attach is-hidden",
    });
    const inputRow = this.composerEl.createDiv({ cls: "ggai-phone-composer-row" });
    const attachBtn = inputRow.createEl("button", {
      cls: "ggai-phone-icon-btn",
      attr: { "aria-label": "사진 첨부" },
    });
    setIcon(attachBtn, "image");
    attachBtn.addEventListener("click", () => {
      new PhoneImagePickerModal(this.plugin, (picked) => {
        this.pendingMsgAttach = picked;
        this.renderMsgAttachPreview();
      }).open();
    });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "ggai-phone-input",
      attr: { rows: "1", placeholder: "메시지 보내기" },
    });
    this.sendBtn = inputRow.createEl("button", {
      cls: "ggai-phone-send",
      attr: { "aria-label": "전송" },
    });
    setIcon(this.sendBtn, "send");
    this.sendBtn.addEventListener("click", () => void this.handleSend());
    this.inputEl.addEventListener("keydown", (e) => {
      // PC: Enter 전송 / Shift+Enter 줄바꿈. 모바일은 버튼으로만 (IME 안전).
      if (Platform.isMobile) return;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.handleSend();
      }
    });
    // 입력 높이 자동 (최대 4줄) — 값은 건드리지 않는다.
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 96)}px`;
    });
  }

  private isReplyingHere(): boolean {
    return (
      !!this.loginProfile &&
      !!this.openTarget &&
      this.plugin.phone.isReplying(
        this.loginProfile.id,
        PhoneService.targetKey(this.openTarget)
      )
    );
  }

  private updateComposerState(): void {
    const inThread = this.screen === "messages" && this.openTarget !== null;
    this.composerEl.toggleClass("is-hidden", !inThread);
    // 내비 바 3버튼은 항상 보인다 (홈에서 홈/뒤로 = 폰 닫기).
    this.refreshNavBtn.toggleClass("is-busy", this.refreshBusy);
    const busy = this.isReplyingHere();
    this.sendBtn.disabled = busy;
    this.sendBtn.toggleClass("is-busy", busy);
  }

  /** 수동 새로고침 (§5) — SNS 새 글·댓글 + 진행 중 방송 채팅을 지금 갱신. */
  private async handleManualRefresh(): Promise<void> {
    if (this.refreshBusy) return;
    this.refreshBusy = true;
    this.refreshNavBtn.addClass("is-busy");
    try {
      const result = await this.plugin.phone.manualRefresh();
      if (!result.ok) new Notice(`스텔라 폰: ${result.error}`);
    } finally {
      this.refreshBusy = false;
      this.refreshNavBtn.removeClass("is-busy");
    }
  }

  /** 문자 첨부 미리보기 국소 갱신 (입력창은 건드리지 않음). */
  private renderMsgAttachPreview(): void {
    const host = this.msgAttachPreviewEl;
    host.empty();
    host.toggleClass("is-hidden", !this.pendingMsgAttach);
    if (!this.pendingMsgAttach) return;
    const img = host.createEl("img");
    img.src = this.app.vault.adapter.getResourcePath(this.pendingMsgAttach.path);
    const removeBtn = host.createEl("button", {
      cls: "ggai-phone-sns-attach-remove",
      attr: { "aria-label": "첨부 제거" },
    });
    setIcon(removeBtn, "x");
    removeBtn.addEventListener("click", () => {
      this.pendingMsgAttach = null;
      this.renderMsgAttachPreview();
    });
  }

  private async handleSend(): Promise<void> {
    if (!this.loginProfile || !this.loginUserFile || !this.openTarget) return;
    if (this.isReplyingHere()) return;
    const text = this.inputEl.value.trim();
    const attach = this.pendingMsgAttach;
    if (!text && !attach) return;
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.pendingMsgAttach = null;
    this.renderMsgAttachPreview();
    const result = await this.plugin.phone.sendMessage({
      personaId: this.loginProfile.id,
      personaFile: this.loginUserFile,
      target: this.openTarget,
      text,
      ...(attach
        ? {
            image: {
              asset: attach.path,
              caption: attach.caption,
              registerGallery: attach.isNewUpload,
            },
          }
        : {}),
    });
    if (!result.ok) new Notice(`스텔라 폰: ${result.error}`);
  }
}

/** 스텔라 폰 탭 뷰 — 모바일(풀 화면) 호스트. */
/**
 * 폰 오버레이 — 화면 위에 창처럼 뜨고 바깥 클릭/Esc 로 닫힌다. PC 는 폰 프레임,
 * 모바일은 프레임 없이 버튼만 보이는 풀 화면(창은 띄우되 프레임은 감춤).
 */
export class PhoneOverlayModal extends Modal {
  private controller: PhoneController | null = null;

  constructor(private plugin: StellaEnginePlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("ggai-phone-modal");
    if (Platform.isMobile) this.modalEl.addClass("is-mobile");
    this.controller = new PhoneController(this.plugin, this.contentEl, () =>
      this.close()
    );
    this.controller.load();
  }

  onClose(): void {
    this.controller?.unload();
    this.controller = null;
    this.contentEl.empty();
    if (this.plugin.phoneOverlay === this) this.plugin.phoneOverlay = null;
  }
}

/** 이미지 확대 뷰어 — 갤러리/SNS/문자 사진 공용. 바깥 클릭/Esc 로 닫힌다. */
class ImageLightboxModal extends Modal {
  constructor(
    app: App,
    private path: string,
    private caption: string
  ) {
    super(app);
    (this as unknown as { shouldRestoreSelection?: boolean }).shouldRestoreSelection =
      false;
  }

  onOpen(): void {
    this.modalEl.addClass("ggai-phone-lightbox-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ggai-phone-lightbox");
    // 옵시디언 기본 이미지 확대처럼 — 배경(프레임) 어디를 눌러도 닫힌다.
    contentEl.addEventListener("click", () => this.close());
    const img = contentEl.createEl("img");
    img.src = this.app.vault.adapter.getResourcePath(this.path);
    img.alt = this.caption;
    if (this.caption) {
      contentEl.createDiv({
        cls: "ggai-phone-lightbox-caption",
        text: this.caption,
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 오늘이면 HH:MM, 아니면 M/D. */
function formatTimeShort(at: number): string {
  if (!at) return "";
  const d = new Date(at);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes()
    ).padStart(2, "0")}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 좋아요 수 축약 표기 (v2 §6.2) — 1234 → 1.2k, 34000 → 34k. */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) {
    const v = Math.round(n / 100) / 10;
    return `${Number.isInteger(v) ? v.toFixed(0) : v}k`;
  }
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = Math.round(n / 100_000) / 10;
  return `${Number.isInteger(m) ? m.toFixed(0) : m}M`;
}

/**
 * SNS 계정 편집 모달 (v3 계정 관리) — 이름/핸들/세계/성향 메모/팔로워.
 * 저장 시 피드의 기존 글 작성자 표기도 함께 갱신된다 (PhoneService 담당).
 */
class SnsAccountEditModal extends Modal {
  constructor(
    app: App,
    private readonly acc: SnsAccount,
    private readonly onSave: (
      patch: Partial<
        Pick<SnsAccount, "name" | "handle" | "world" | "persona" | "followers">
      >
    ) => Promise<void>
  ) {
    super(app);
    this.shouldRestoreSelection = false;
  }

  onOpen(): void {
    this.titleEl.setText("계정 편집");
    const { contentEl } = this;
    const field = (label: string, value: string, placeholder = "") => {
      const wrap = contentEl.createDiv({ cls: "ggai-phone-acc-field" });
      wrap.createDiv({ cls: "ggai-media-label", text: label });
      const input = wrap.createEl("input", {
        cls: "ggai-form-input",
        attr: { type: "text", placeholder },
      });
      input.value = value;
      return input;
    };
    const nameIn = field("이름", this.acc.name);
    const handleIn = field("핸들", this.acc.handle ?? "", "@handle (비우면 없음)");
    const worldIn = field("세계", this.acc.world ?? "", "출신 세계 (비우면 없음)");
    const memoWrap = contentEl.createDiv({ cls: "ggai-phone-acc-field" });
    memoWrap.createDiv({
      cls: "ggai-media-label",
      text: "성향 메모 (생성 시 말투·태도 재료)",
    });
    const memoIn = memoWrap.createEl("textarea", {
      cls: "ggai-form-input",
      attr: { rows: "2", placeholder: "예: 냉소적인 헤비 트위터리안, 존댓말" },
    });
    memoIn.value = this.acc.persona ?? "";
    const followersIn = field("팔로워 수", String(this.acc.followers));
    followersIn.type = "number";
    followersIn.min = "0";

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("취소").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("저장")
          .setCta()
          .onClick(() => {
            const followers = Number(followersIn.value);
            void this.onSave({
              name: nameIn.value,
              handle: handleIn.value,
              world: worldIn.value,
              persona: memoIn.value,
              ...(Number.isFinite(followers) ? { followers } : {}),
            }).then(() => this.close());
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
