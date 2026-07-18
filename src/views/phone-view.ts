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
  ItemView,
  Menu,
  Modal,
  Notice,
  Platform,
  setIcon,
  WorkspaceLeaf,
} from "obsidian";
import { VIEW_TYPE_PHONE } from "../constants";
import type StellaEnginePlugin from "../main";
import {
  PhoneService,
  snsAuthorKey,
  type PhoneSendTarget,
} from "../services/phone-service";
import { ConfirmModal } from "./modals";
import { PhoneContactModal } from "./phone-contact-modal";
import type {
  PhoneGalleryFile,
  PhoneMessagesFile,
  PhoneThread,
  SessionStreamFile,
  SnsAuthor,
  SnsFeedFile,
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

/** 폰 화면 — 홈 또는 앱. (사진 보기/업로드는 첨부 창과 대시보드 갤러리가 담당.) */
type PhoneScreen = "home" | "messages" | "sns" | "camera" | "tube";

/** 홈 화면 앱 정의 — 새 기능은 여기에 아이콘을 추가한다. */
const PHONE_APPS: { screen: PhoneScreen; icon: string; label: string }[] = [
  { screen: "messages", icon: "message-circle", label: "메시지" },
  { screen: "sns", icon: "sparkles", label: "스텔라 네트워크" },
  { screen: "tube", icon: "tv", label: "스텔라튜브" },
  { screen: "camera", icon: "camera", label: "카메라" },
];

const APP_TITLES: Record<Exclude<PhoneScreen, "home">, string> = {
  messages: "메시지",
  sns: "스텔라 네트워크",
  camera: "카메라",
  tube: "스텔라튜브",
};

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
  /** SNS 계정 모아보기 필터 — null 이면 전체 피드. */
  private snsAccountFilter: { key: string; label: string } | null = null;
  /** 피드 갱신이 입력 중에 도착함 — 입력이 끝나면 다시 그린다. */
  private snsDirty = false;
  /** 답글 입력이 열려 있는 대상 — 게시글 id + (대댓글이면) 부모 답글 id. */
  private replyOpen: { postId: string; parentId?: string } | null = null;
  /** 문자 스레드 번역 표시 토글 (원문↔번역) — 스레드 이동해도 유지. */
  private showMsgTranslation = false;
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
    setIcon(homeNav, "circle");
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
      this.openStreamFile = null;
      this.renderHeader();
      this.renderBody();
      return;
    }
    this.goHome();
  }

  private goHome(): void {
    if (this.screen === "home") return;
    this.screen = "home";
    this.snsDirty = false;
    this.snsAccountFilter = null;
    this.renderHeader();
    this.renderBody();
    this.updateComposerState();
  }

  private openApp(screen: PhoneScreen): void {
    this.screen = screen;
    this.snsAccountFilter = null;
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

  private async openPersonaMenu(e: MouseEvent): Promise<void> {
    const users = await this.plugin.store
      .getUsers()
      .catch(
        (): Awaited<ReturnType<StellaEnginePlugin["store"]["getUsers"]>> => []
      );
    if (users.length === 0) return;
    const menu = new Menu();
    for (const u of users) {
      menu.addItem((item) =>
        item
          .setTitle(u.profile.name || u.userFile)
          .setChecked(u.userFile === this.loginUserFile)
          .onClick(() => void this.plugin.phone.setLoginPersona(u.userFile))
      );
    }
    menu.showAtMouseEvent(e);
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
      } else {
        this.goHome();
      }
    });
    this.headerEl.createDiv({
      cls: "ggai-phone-title",
      text: inThread ? this.currentThreadName() : APP_TITLES[this.screen],
    });

    // 번역 보기 토글 (PH5) — 첫 켜기 때 번역 안 된 문자를 일괄 번역한다.
    // 자동 번역이 켜져 있으면 항상 번역본이 보이므로 토글은 감춘다 (설정으로 제어).
    if (
      inThread &&
      this.phoneTranslationEnabled() &&
      !this.plugin.phone.isAutoTranslateOn()
    ) {
      const key = this.openTarget ? PhoneService.targetKey(this.openTarget) : "";
      const trBtn = this.headerEl.createEl("button", {
        cls: "ggai-phone-icon-btn",
        attr: { "aria-label": "번역 보기 (원문↔번역)" },
      });
      setIcon(trBtn, "languages");
      trBtn.toggleClass("is-active", this.showMsgTranslation);
      trBtn.toggleClass("is-busy", this.translateBusy.has(key));
      trBtn.addEventListener("click", () => void this.toggleThreadTranslation());
    }

    // 햄버거 메뉴 — 초기화/삭제 (메시지·SNS 화면).
    if (this.screen === "messages" || this.screen === "sns") {
      const menuBtn = this.headerEl.createEl("button", {
        cls: "ggai-phone-icon-btn",
        attr: { "aria-label": "메뉴" },
      });
      setIcon(menuBtn, "menu");
      menuBtn.addEventListener("click", (e) => this.openHeaderMenu(e));
    }
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

  private openHeaderMenu(e: MouseEvent): void {
    const menu = new Menu();
    if (this.screen === "messages") {
      const inThread = this.openTarget !== null;
      if (inThread) {
        const target = this.openTarget!;
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
      menu.addItem((mi) =>
        mi
          .setTitle("좋아요 글 남기고 초기화")
          .setIcon("heart")
          .onClick(() =>
            this.confirmThen(
              "피드 초기화",
              "♥ 를 누른 게시글(댓글 포함)만 남기고 피드를 비웁니다.",
              "초기화",
              () => this.plugin.phone.clearSnsFeed({ keepLiked: true })
            )
          )
      );
      menu.addItem((mi) =>
        mi
          .setTitle("피드 전체 초기화")
          .setIcon("trash-2")
          .onClick(() =>
            this.confirmThen(
              "피드 전체 초기화",
              "모든 게시글과 댓글을 삭제합니다.",
              "초기화",
              () => this.plugin.phone.clearSnsFeed({ keepLiked: false })
            )
          )
      );
    }
    menu.showAtMouseEvent(e);
  }

  /** 폰 안 번역 사용 여부 (폰 설정 — 기본 켜짐). */
  private phoneTranslationEnabled(): boolean {
    return this.plugin.data.phone?.translation?.enabled !== false;
  }

  /** 문자 스레드 번역 토글 — 켤 때 번역 안 된 문자가 있으면 먼저 일괄 번역. */
  private async toggleThreadTranslation(): Promise<void> {
    if (!this.loginProfile || !this.openTarget) return;
    if (this.showMsgTranslation) {
      this.showMsgTranslation = false;
      this.renderHeader();
      if (this.screen === "messages") this.renderBody();
      return;
    }
    const key = PhoneService.targetKey(this.openTarget);
    if (this.translateBusy.has(key)) return;
    const thread = this.currentThread();
    const needs = (thread?.messages ?? []).some(
      (m) => !m.translation && m.text.trim() !== ""
    );
    if (needs) {
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
    this.showMsgTranslation = true;
    this.renderHeader();
    if (this.screen === "messages") this.renderBody();
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
      default:
        if (this.openTarget === null) this.renderContactList();
        else this.renderThread();
    }
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
    const anyLive = this.streams.some((s) => s.stream.live);
    for (const app of PHONE_APPS) {
      const btn = grid.createEl("button", { cls: "ggai-phone-app" });
      const icon = btn.createDiv({ cls: "ggai-phone-app-icon" });
      setIcon(icon, app.icon);
      icon.addClass(`is-${app.screen}`);
      // 스텔라튜브 — 방송 중이면 빨간 LIVE 점 배지.
      if (app.screen === "tube" && anyLive) {
        icon.createDiv({ cls: "ggai-phone-app-badge-live" });
      }
      btn.createDiv({ cls: "ggai-phone-app-label", text: app.label });
      btn.addEventListener("click", () => this.openApp(app.screen));
    }
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
        // 자동 번역이 켜져 있으면 기본으로 번역본, 헤더 토글로 원문 전환 가능.
        const showTr =
          this.plugin.phone.isAutoTranslateOn() || this.showMsgTranslation;
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

  private renderSnsFeed(): void {
    this.bodyEl.addClass("is-sns");

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

    // 공유로 진입한 직후 — 코멘트를 바로 쓸 수 있게 작성창 포커스.
    if (this.focusSnsComposer) {
      this.focusSnsComposer = false;
      window.requestAnimationFrame(() => ta.focus());
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
    const card = this.bodyEl.createDiv({ cls: "ggai-phone-sns-post" });
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
    sendBtn.addEventListener("click", () => {
      const text = rta.value.trim();
      if (!text || !this.loginProfile) return;
      this.replyOpen = null;
      this.snsDirty = false;
      void this.plugin.phone.replyToSnsPost(
        this.loginProfile,
        postId,
        text,
        parentId
      );
    });
    rta.addEventListener("blur", () => this.flushSnsDirty());
    window.setTimeout(() => rta.focus(), 0);
  }

  /** SNS/문자 번역본을 보여줄지 — 폰 설정의 "자동 번역"으로 일괄 제어. */
  private snsShowTranslated(): boolean {
    return this.plugin.phone.isAutoTranslateOn();
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

  /** 튜브 화면이 보여줄 방송 — 열어 본 다시보기 > 진행 중 라이브. */
  private currentTubeItem(): {
    sessionFile: string;
    stream: SessionStreamFile;
  } | null {
    if (this.openStreamFile) {
      return (
        this.streams.find((s) => s.sessionFile === this.openStreamFile) ?? null
      );
    }
    return this.streams.find((s) => s.stream.live) ?? null;
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

    const ordered = this.tubeOrderedChat(stream, session);
    this.tubeRenderedChatIds = new Set();
    this.appendTubeChat(chatWrap, ordered);
    this.updateTubeViewers(stream, session);
    if (ordered.length === 0) {
      chatWrap.createDiv({
        cls: "ggai-phone-tube-chat-empty",
        text: stream.live
          ? "시청자 입장 중… 장면이 이어지면 채팅이 달립니다."
          : "채팅 기록이 없습니다.",
      });
    }
    chatWrap.scrollTop = chatWrap.scrollHeight;
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

  /** 채팅 줄 append — 실시간 채팅처럼 한 줄씩 계단식 등장 애니메이션. */
  private appendTubeChat(host: HTMLElement, chat: StreamChatItem[]): void {
    let i = 0;
    for (const c of chat) {
      if (this.tubeRenderedChatIds.has(c.id)) continue;
      this.tubeRenderedChatIds.add(c.id);
      const row = host.createDiv({
        cls: "ggai-phone-tube-line is-enter" + (c.donation ? " is-donation" : ""),
      });
      // 여러 줄이 한꺼번에 들어와도 실시간 채팅처럼 순차로 흘러들어오게.
      row.style.animationDelay = `${Math.min(i, 8) * 60}ms`;
      i++;
      if (c.donation) {
        row.createDiv({
          cls: "ggai-phone-tube-donation",
          text: `💰 ${formatCount(c.donation)}`,
        });
      }
      row.createSpan({ cls: "ggai-phone-tube-line-name", text: c.name });
      row.createSpan({ cls: "ggai-phone-tube-line-text", text: ` ${c.text}` });
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

    const form = this.bodyEl.createDiv({ cls: "ggai-phone-camera-form" });
    const ta = form.createEl("textarea", {
      cls: "ggai-phone-input",
      attr: {
        rows: "3",
        placeholder: this.cameraDirect
          ? "이미지 프롬프트를 직접 입력…"
          : "찍고 싶은 장면을 묘사하세요 (삽화 프롬프트로 자동 변환)…",
      },
    });
    // 기본 = 장면 묘사를 삽화 프롬프트 생성 LLM 에 통과 (삽화 설정·로어북 적용).
    const directRow = form.createEl("label", { cls: "ggai-phone-camera-direct" });
    const directCb = directRow.createEl("input", { type: "checkbox" });
    directCb.checked = this.cameraDirect;
    directRow.createSpan({ text: " 프롬프트 직접 입력" });
    directCb.addEventListener("change", () => {
      this.cameraDirect = directCb.checked;
      ta.placeholder = this.cameraDirect
        ? "이미지 프롬프트를 직접 입력…"
        : "찍고 싶은 장면을 묘사하세요 (삽화 프롬프트로 자동 변환)…";
    });
    const shootBtn = form.createEl("button", {
      cls: "ggai-phone-sns-post-btn ggai-phone-camera-shoot",
      text: this.cameraBusy ? "촬영 중…" : "촬영",
    });
    shootBtn.disabled = this.cameraBusy;
    shootBtn.addEventListener("click", async () => {
      const prompt = ta.value.trim();
      if (!prompt || this.cameraBusy) return;
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

    // 최근 촬영 결과 미리보기 (카메라 출신 최신 1장).
    const shots = (this.gallery?.items ?? [])
      .filter((i) => i.source === "camera")
      .sort((a, b) => b.createdAt - a.createdAt);
    if (this.cameraBusy) {
      this.bodyEl.createDiv({
        cls: "ggai-phone-empty",
        text: "찰칵… 현상 중입니다.",
      });
    } else if (shots[0]) {
      const preview = this.bodyEl.createDiv({ cls: "ggai-phone-camera-preview" });
      const img = preview.createEl("img", { cls: "ggai-phone-sns-photo" });
      img.src = this.app.vault.adapter.getResourcePath(shots[0].file);
      img.alt = shots[0].caption;
      const shot = shots[0];
      img.addEventListener("click", () =>
        new ImageLightboxModal(this.app, shot.file, shot.caption).open()
      );
      // 우클릭(모바일 롱프레스) — 촬영 결과를 바로 게시/전송 (v2 §4).
      img.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openShotMenu(shot, e);
      });
      preview.createDiv({
        cls: "ggai-phone-camera-caption",
        text: shots[0].caption,
      });
    }
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
export class PhoneView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: StellaEnginePlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PHONE;
  }

  getDisplayText(): string {
    return "스텔라 폰";
  }

  getIcon(): string {
    return "smartphone";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    this.addChild(
      new PhoneController(this.plugin, root, () => this.leaf.detach())
    );
  }
}

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
    const img = contentEl.createEl("img");
    img.src = this.app.vault.adapter.getResourcePath(this.path);
    img.alt = this.caption;
    img.addEventListener("click", () => this.close());
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
