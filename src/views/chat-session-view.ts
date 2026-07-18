/**
 * 챗 세션 뷰 (M6/C2) — 소설 세션뷰와 **완전 별도**의 뷰.
 *
 * 대전제 (챗 모드 스펙.md):
 *  - 노드 1개 = 메시지 1개. 역할은 노드 kind (root/ai-* = assistant, user-write = user).
 *  - 말풍선 직접 편집 = user-edit replace 노드 파생 (제자리 수정 금지).
 *  - 전송본은 planSessionRequest 단일 경로 (소설과 공유 — 미리보기 = 전송본).
 *  - 데이터 변경은 전부 store 경유, IME 조합 중 DOM 갱신은 runWhenImeIdle 게이트.
 *  - meta.mode !== "chat" 세션이 들어오면 소설 뷰로 즉시 넘긴다 (뷰 혼입 방지).
 */

import {
  ItemView,
  Menu,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import {
  VIEW_TYPE_CHAT_SESSION,
  VIEW_TYPE_DASHBOARD,
  VIEW_TYPE_SESSION,
} from "../constants";
import type StellaEnginePlugin from "../main";
import type { SessionChangeDetail, StellaStore } from "../state/store";
import type { AIService } from "../services/ai-service";
import type {
  IllustrationVariant,
  SessionIllustrations,
  SessionTranslations,
} from "../types/media";
import type { Patch, SessionNode, StellaSession } from "../types/session";
import type { StellaGroup } from "../types/group";
import {
  parseTalkativeness,
  pickNextSpeaker,
  type GroupSpeakerCandidate,
} from "../util/group-speaker";
import { planSessionRequest } from "../util/build-session-context";
import { applyRawRegexToGeneration } from "../util/session-regex";
import {
  buildChatMessages,
  CHAT_MESSAGE_SEPARATOR,
  type ChatSessionMessage,
} from "../util/chat-messages";
import {
  getActiveIllustration,
  listIllustrationVariants,
  setActiveIllustrationVariant,
  toggleIllustrationFavorite,
} from "../util/illustrations";
import { formatChatText } from "../util/chat-format";
import { applyMacros, type MacroContext } from "../util/macros";
import { REGEX_PLACEMENT, type RegexScript } from "../types/regex";
import { getRegexedString } from "../util/regex-engine";
import { readScenarioRegexScripts } from "../util/regex-scripts";
import { listParagraphRanges } from "../util/paragraph-regen";
import { attachLongPress } from "../util/long-press";
import {
  openExtensionActionsMenu,
  renderHeaderCommandBar,
} from "./session-command-bar";
import { buildSpans, spansToText } from "../util/session-text";
import { trimChatCompletionOutput } from "../util/text-completion-prompt";
import {
  getChildren,
  getDeepestLatestDescendant,
  getSiblings,
} from "../util/session-tree";
import {
  collectUntranslatedParagraphs,
  getActiveTranslation,
  recordTranslationVariant,
  tokenizeParagraphs,
} from "../util/translate-paragraphs";
import { uuidv4 } from "../util/uuid";
import { clampSessionViewStyle, type SessionViewStyle } from "../util/view-style";
import { removeIllustrationVariant } from "../util/illustrations";
import { renderThumb } from "../util/render-thumb";
import { EditGuard, isImeComposing, runWhenImeIdle } from "./edit-guard";
import {
  IllustrationGalleryModal,
  illustrationCaption,
  shareGalleryImageToNetwork,
  type GalleryItem,
} from "./gallery-modal";
import { IllustrationCarousel } from "./illustration-carousel";
import { IllustrationRegenModal } from "./illustration-regen-modal";
import { ParagraphRegenModal } from "./paragraph-regen-modal";
import { ViewStylePopover } from "./view-style-popover";

interface ChatSessionViewState {
  sessionFile: string;
  stellaPanel?: boolean;
}

interface ChatGenerationState {
  nodeId: string;
  abort: AbortController;
  accumulatedText: string;
}

const EDIT_COMMIT_DEBOUNCE_MS = 800;

export class ChatSessionView extends ItemView {
  private readonly plugin: StellaEnginePlugin;
  private readonly store: StellaStore;
  private readonly ai: AIService;

  private sessionFile: string | null = null;
  private session: StellaSession | null = null;
  private stellaPanel = false;

  /** 현재 렌더된 메시지 목록 (활성 경로 기준 캐시 — 편집 오프셋 계산용). */
  private messages: ChatSessionMessage[] = [];
  private generation: ChatGenerationState | null = null;
  /** 발신자 토큰 — 이 뷰의 저장이 쏜 session-changed 를 detail.origin 으로 구분. */
  private readonly storeOrigin = `chat-view:${uuidv4()}`;
  private readonly guard = new EditGuard();
  /** 말풍선 편집 중 미뤄진 재렌더 — 편집이 끝나면(blur) 반영. */
  private renderPending = false;
  /** 표시용 매크로 컨텍스트 ({{char}}/{{user}} 등 — 전송본과 별개, 표시 전용). */
  private displayMacroCtx: MacroContext = { user: "User" };

  // ── 미디어/보기 (C3) ──
  private translations: SessionTranslations | null = null;
  private illustrations: SessionIllustrations | null = null;
  private translationViewActive = false;
  private translating = false;
  private illustrating = false;
  private viewStyle: SessionViewStyle = clampSessionViewStyle(undefined);
  private viewStylePopover: ViewStylePopover | null = null;
  /** 콕핏 날개 — 입력창 좌/우에 리모컨 버튼을 접어 넣는다. */
  private leftWingEl: HTMLElement | null = null;
  private rightWingEl: HTMLElement | null = null;
  /** 문단 재생성 선택 모드 — 말풍선(또는 입력창)을 탭해 대상을 고른다. */
  private paraSelectMode = false;
  private viewToggleBtn: HTMLElement | null = null;
  /** undo 로 되돌린 리프 스택 — 새 커밋(전송/편집/생성)이 생기면 비운다. */
  private redoStack: string[] = [];
  // 리모컨 버튼 refs (소설 툴바와 같은 구성, 가운데 이어쓰기만 없음)
  private undoBtn: HTMLButtonElement | null = null;
  private redoBtn: HTMLButtonElement | null = null;
  private jumpEndBtn: HTMLButtonElement | null = null;
  private translateBtn: HTMLButtonElement | null = null;
  private illustrationBtn: HTMLButtonElement | null = null;
  private wandBtn: HTMLButtonElement | null = null;
  private nodeFavBtn: HTMLButtonElement | null = null;
  private proactiveBtn: HTMLButtonElement | null = null;
  /** 아바타 재료 — refreshMacroContext 에서 함께 갱신. */
  private scenarioThumbPath: string | null = null;
  private personaThumbPath: string | null = null;
  /** 표시 시점 정규식 재료 — refreshMacroContext 에서 함께 갱신. */
  private scopedRegexScripts: RegexScript[] = [];
  private scenarioStellaId: string | null = null;

  // ── 그룹 챗 (G2) — 발화자 시스템 ──
  /** 세션의 그룹 (meta.groupId) — refreshMacroContext 에서 갱신. */
  private group: StellaGroup | null = null;
  /** 멤버 표시 재료 — 발화자 결정/라벨/아바타 공용. */
  private groupMembers: {
    scenarioId: string;
    name: string;
    thumbPath: string | null;
    talkativeness: number;
  }[] = [];
  /** 발화자 지목 (입력창 옆 버튼). null = 자동 결정. 세션에 저장하지 않는다. */
  private pinnedSpeakerId: string | null = null;
  private speakerBtn: HTMLButtonElement | null = null;
  /** 자동 연쇄 — 이번 라운드 남은 AI 발화 수. 타이핑 시작 시 즉시 0. */
  private autoChainRemaining = 0;
  private autoChainTimer: number | null = null;

  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private streamBubbleEl: HTMLElement | null = null;
  private streamPaintQueued = false;

  private editCommitTimer: number | null = null;
  private pendingEditBubble: HTMLElement | null = null;
  private followTail = true;
  /** 번역 보기 직접 편집 상태 — 포커스된 말풍선 하나만 (blur 시 커밋 후 해제). */
  private trEdit: {
    bubble: HTMLElement;
    blocks: { hash: string; source: string; baseline: string; el: HTMLElement }[];
    timer: number | null;
  } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: StellaEnginePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
    this.ai = plugin.ai;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT_SESSION;
  }
  getDisplayText(): string {
    return this.session?.meta.name ?? "Chat";
  }
  getIcon(): string {
    return "message-circle";
  }

  async setState(state: unknown, result: any): Promise<void> {
    const s = state as Partial<ChatSessionViewState> | null;
    this.stellaPanel = s?.stellaPanel === true;
    const next = s && typeof s.sessionFile === "string" ? s.sessionFile : null;
    if (next && next !== this.sessionFile) {
      // 생성 중 재타게팅 방지는 openStellaSession 이 담당하지만, 예상 밖 경로
      // (레이아웃 복원 등)로 여기 오면 생성을 중단해 잠금·스트리밍이 새 세션에
      // 새어들지 않게 한다.
      this.generation?.abort.abort();
      this.cancelAutoChain();
      this.pinnedSpeakerId = null;
      await this.flushPendingEdits();
      this.sessionFile = next;
      this.plugin.rememberActiveSessionFile(next);
      await this.loadSession();
      this.render();
    }
    return super.setState(state, result);
  }

  getState(): Record<string, unknown> {
    return { sessionFile: this.sessionFile, stellaPanel: this.stellaPanel };
  }

  // ── 세션 호스트 공통 창구 (session-host.ts) ──────────────────────

  getSessionFile(): string | null {
    return this.sessionFile;
  }

  /** AI 생성(스트리밍) 진행 중 — 이 탭은 다른 세션으로 갈아끼우면 안 된다 (session-host 규약). */
  isGenerating(): boolean {
    return this.generation != null;
  }

  async flushPendingEdits(): Promise<void> {
    if (this.editCommitTimer != null) {
      window.clearTimeout(this.editCommitTimer);
      this.editCommitTimer = null;
    }
    const bubble = this.pendingEditBubble;
    this.pendingEditBubble = null;
    if (bubble) await this.commitBubbleEdit(bubble);
    // 번역 보기에서 편집 중인 말풍선도 커밋 (translations.json 에만 저장).
    if (this.trEdit) await this.endTranslationBubbleEdit(this.trEdit.bubble);
  }

  scrollToNode(nodeId: string): boolean {
    const el = this.messagesEl?.querySelector(
      `.ggai-chat-msg[data-node-id="${nodeId}"]`
    );
    if (!(el instanceof HTMLElement)) return false;
    el.scrollIntoView({ block: "center" });
    return true;
  }

  // ── 라이프사이클 ─────────────────────────────────────────────────

  async onOpen(): Promise<void> {
    this.registerEvent(
      this.store.on(
        "session-changed",
        (file: string, detail?: SessionChangeDetail) => {
          if (file !== this.sessionFile) return;
          if (detail?.origin === this.storeOrigin) return; // 자기 저장 에코
          if (this.guard.isSavingSelf) return;
          if (this.generation) return; // 생성 중 외부 변경은 생성 종료 후 재로드
          if (detail?.kinds?.every((k) => k === "settings")) {
            // 활성 설정만 바뀜 (프리셋/모델/미디어 토글 등) — 말풍선 불변.
            // 세션 객체는 store 캐시 공유라 이미 최신, 리모컨 상태만 동기화.
            this.updateToolbar();
            return;
          }
          runWhenImeIdle(() => void this.reloadFromStore());
        }
      )
    );
    // 표시 매크로 재료 변경 — 페르소나/시나리오 이름 등.
    this.registerEvent(
      this.store.on("user-profile-changed", () => {
        void this.refreshMacroContext().then(() => this.renderMessages());
      })
    );
    this.registerEvent(
      this.store.on("scenarios-changed", () => {
        void this.refreshMacroContext().then(() => this.renderMessages());
      })
    );
    // 그룹 멤버 변경 (초대/내보내기) — 발화자 후보/라벨 재료 갱신.
    this.registerEvent(
      this.store.on("groups-changed", () => {
        void this.refreshMacroContext().then(() => {
          this.updateSpeakerBtn();
          this.renderMessages();
        });
      })
    );
    this.registerEvent(
      this.store.on("session-deleted", (file: string) => {
        if (file !== this.sessionFile) return;
        this.sessionFile = null;
        this.session = null;
        this.plugin.rememberActiveSessionFile(null);
        this.render();
      })
    );
    this.registerEvent(
      this.store.on(
        "session-translations-changed",
        (file: string, detail?: SessionChangeDetail) => {
          if (file !== this.sessionFile) return;
          if (detail?.origin === this.storeOrigin) return; // 자기 저장 에코
          void this.store.getSessionTranslations(file).then((t) => {
            this.translations = t;
            this.translationViewActive = t.displayMode === "translation";
            runWhenImeIdle(() => {
              this.renderMessages();
              this.updateViewToggleBtn();
            });
          });
        }
      )
    );
    this.registerEvent(
      this.store.on(
        "session-illustrations-changed",
        (file: string, detail?: SessionChangeDetail) => {
          if (file !== this.sessionFile) return;
          if (detail?.origin === this.storeOrigin) return; // 자기 저장 에코
          void this.store.getSessionIllustrations(file).then((i) => {
            this.illustrations = i;
            runWhenImeIdle(() => this.renderMessages());
          });
        }
      )
    );
    this.render();
    // 모바일 — 뷰어 도구(갤러리/번역 전환)를 뷰 헤더 액션에 1회 등록.
    if (Platform.isMobile) this.setupViewerToolActions();
  }

  async onClose(): Promise<void> {
    this.cancelAutoChain();
    this.viewStylePopover?.close();
    this.viewStylePopover = null;
    await this.flushPendingEdits();
    this.generation?.abort.abort();
  }

  private async loadSession(): Promise<void> {
    this.messages = [];
    if (!this.sessionFile) {
      this.session = null;
      return;
    }
    this.session = await this.store.getSession(this.sessionFile);

    // 뷰 혼입 방지 — 챗이 아닌 세션은 소설 뷰로 넘긴다 (mode 누락 = 소설).
    if (this.session && this.session.meta.mode !== "chat") {
      const file = this.sessionFile;
      const panel = this.stellaPanel;
      this.session = null;
      window.setTimeout(() => {
        void this.leaf.setViewState({
          type: VIEW_TYPE_SESSION,
          active: true,
          state: { sessionFile: file, stellaPanel: panel },
        });
      }, 0);
      return;
    }
    this.translations = await this.store.getSessionTranslations(this.sessionFile);
    this.illustrations = await this.store.getSessionIllustrations(this.sessionFile);
    this.translationViewActive = this.translations?.displayMode === "translation";
    this.viewStyle = this.plugin.getViewStyle();
    await this.refreshMacroContext();
  }

  /** 표시용 매크로 컨텍스트 재구성 — 시나리오/페르소나 이름 + 아바타 재료. */
  private async refreshMacroContext(): Promise<void> {
    const { profile: user, userFile } = await this.plugin.resolveActiveUserProfile();
    let scenarioData: any = null;
    this.scenarioThumbPath = null;
    this.personaThumbPath = null;
    this.group = null;
    this.groupMembers = [];
    this.scopedRegexScripts = [];
    this.scenarioStellaId = null;
    if (this.sessionFile) {
      const scenarios = await this.store.getScenarios().catch(() => []);
      const scenarioFile = scenarioFileOfSessionFile(this.sessionFile);
      if (scenarioFile) {
        const item = scenarios.find((i) => i.scenarioFile === scenarioFile);
        scenarioData = item?.scenario.data ?? null;
        this.scenarioThumbPath = item?.thumbnailPath ?? null;
        // 표시 시점 정규식 재료 — 시나리오 전용 스크립트 + 허용 판정용 id.
        this.scopedRegexScripts = readScenarioRegexScripts(item?.scenario);
        this.scenarioStellaId = item?.scenario.data?.extensions?.stella?.id ?? null;
      }
      // 그룹 챗 (G2) — 멤버 이름/표지/수다스러움(ST talkativeness) 재료.
      const groupId = this.session?.meta.groupId;
      if (groupId) {
        const gi = await this.store.getGroupById(groupId).catch(() => null);
        if (gi) {
          this.group = gi.group;
          const byId = new Map(
            scenarios.map(
              (i) => [i.scenario.data?.extensions?.stella?.id, i] as const
            )
          );
          this.groupMembers = gi.group.members.flatMap((m) => {
            const sc = byId.get(m.scenarioId);
            const name = sc?.scenario.data?.name?.trim();
            if (!name) return [];
            return [
              {
                scenarioId: m.scenarioId,
                name,
                thumbPath: sc?.thumbnailPath ?? null,
                talkativeness: parseTalkativeness(
                  (sc?.scenario.data as any)?.extensions?.talkativeness
                ),
              },
            ];
          });
          // 지목했던 발화자가 내보내졌으면 자동으로 복귀.
          if (
            this.pinnedSpeakerId &&
            !this.groupMembers.some((m) => m.scenarioId === this.pinnedSpeakerId)
          ) {
            this.pinnedSpeakerId = null;
          }
        }
      }
    }
    if (userFile) {
      const users = await this.store.getUsers().catch(() => []);
      this.personaThumbPath =
        users.find((u) => u.userFile === userFile)?.thumbnailPath ?? null;
    }
    this.displayMacroCtx = {
      char: scenarioData?.name ?? "(unknown)",
      user: user.name || "User",
      persona: user.description,
      scenario: scenarioData?.scenario,
      description: scenarioData?.description,
      personality: scenarioData?.personality,
      first_message: scenarioData?.first_mes,
      charFirstMessage: scenarioData?.first_mes,
    };
  }

  /** 표시 전용 매크로 적용 — 변수는 복사본 (표시 중 setvar 가 세션에 영속되지 않게). */
  private macroText(text: string): string {
    return applyMacros(text, {
      ...this.displayMacroCtx,
      variables: { ...(this.session?.meta.variables ?? {}) },
    });
  }

  /** 표시 시점 정규식 재료 — 전역(라이브) + 허용된 시나리오 전용(캐시). */
  private displayRegexScripts(): RegexScript[] {
    const global = this.plugin.data.regexScripts ?? [];
    const allowed =
      this.scenarioStellaId != null &&
      (this.plugin.data.regexScriptsAllowedScenarios ?? []).includes(
        this.scenarioStellaId
      );
    return allowed ? [...global, ...this.scopedRegexScripts] : global;
  }

  /**
   * 표시 시점(markdownOnly) 정규식 — 말풍선에 보일 때만 치환한다. 저장 원문과
   * 전송본은 불변(편집 진입 시 raw 로 스왑되는 구조라 편집에도 안전).
   */
  private displayRegexText(text: string, index: number): string {
    const scripts = this.displayRegexScripts();
    const msg = this.messages[index];
    if (scripts.length === 0 || !msg || !text) return text;
    return getRegexedString(
      text,
      msg.role === "user" ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
      scripts,
      {
        isMarkdown: true,
        depth: this.messages.length - 1 - index,
        substitute: (s) => this.macroText(s),
      }
    );
  }

  private async reloadFromStore(): Promise<void> {
    if (!this.sessionFile) return;
    if (this.isBubbleEditing()) {
      this.renderPending = true; // 편집 중 외부 재렌더 금지 — blur 시 반영
      return;
    }
    this.session = await this.store.getSession(this.sessionFile);
    // 그룹 링크가 생기거나 사라졌으면 (플레이 중 초대 등) 멤버 재료도 갱신.
    if ((this.session?.meta.groupId ?? null) !== (this.group?.id ?? null)) {
      await this.refreshMacroContext();
      this.updateSpeakerBtn();
    }
    this.renderMessages();
  }

  /** 말풍선 안에서 실제로 편집(포커스/조합) 중인가 — 버튼 포커스는 편집이 아니다. */
  private isBubbleEditing(): boolean {
    if (this.guard.isComposing) return true;
    const active = document.activeElement;
    return (
      active instanceof HTMLElement &&
      this.messagesEl?.contains(active) === true &&
      active.closest(".ggai-chat-bubble[contenteditable]") != null
    );
  }

  // ── 렌더 ────────────────────────────────────────────────────────

  // ── 그룹 챗 (G2) — 발화자 결정/지목/자동 연쇄 ────────────────────

  private isGroupChat(): boolean {
    return (
      this.group != null &&
      this.groupMembers.length > 1 &&
      this.session?.meta.mode === "chat"
    );
  }

  private memberOf(scenarioId: string | undefined | null) {
    if (!scenarioId) return null;
    return this.groupMembers.find((m) => m.scenarioId === scenarioId) ?? null;
  }

  /** 노드의 발화자 표시 재료 — speaker 없는 노드(그룹 이전/일반)는 호스트. */
  private speakerDisplayOf(nodeId: string): {
    name: string;
    thumbPath: string | null;
    colorIndex: number;
  } {
    const hostId = this.session?.meta.scenarioId ?? "";
    const speakerId = this.session?.nodes[nodeId]?.speaker ?? hostId;
    const member = this.memberOf(speakerId) ?? this.memberOf(hostId);
    const idx = this.groupMembers.findIndex(
      (m) => m.scenarioId === (member?.scenarioId ?? hostId)
    );
    return {
      name: member?.name ?? this.displayMacroCtx.char ?? "AI",
      thumbPath: member ? member.thumbPath : this.scenarioThumbPath,
      colorIndex: idx >= 0 ? idx : 0,
    };
  }

  /**
   * 다음 발화자 결정 — 지목(핀) > 이름 불림 > 가중 랜덤(수다스러움+미발화 보정).
   * 그룹 챗이 아니면 undefined (일반 단일 캐릭터 생성).
   */
  private chooseSpeakerForNext(): string | undefined {
    if (!this.session) return undefined;
    return this.chooseSpeaker(buildChatMessages(this.session));
  }

  /**
   * 주어진 대화 이력을 기준으로 다음 발화자를 판결한다 (지목 > 이름 불림 > 가중 랜덤).
   * 재생성은 갈아끼울 메시지를 뺀 이력을 넘겨 "누가 답할지"부터 다시 정한다.
   */
  private chooseSpeaker(msgs: ChatSessionMessage[]): string | undefined {
    if (!this.session || !this.isGroupChat()) return undefined;
    if (this.pinnedSpeakerId && this.memberOf(this.pinnedSpeakerId)) {
      return this.pinnedSpeakerId;
    }
    const hostId = this.session.meta.scenarioId;
    const last = msgs[msgs.length - 1];
    const speakerOf = (nodeId: string) =>
      this.session!.nodes[nodeId]?.speaker ?? hostId;
    const lastSpeakerId =
      last?.role === "assistant" ? speakerOf(last.nodeId) : null;
    // 직전 발화자가 끝에서 연속으로 몇 번 말했는지 (중복 발화 상한 판정).
    let lastSpeakerStreak = 0;
    if (lastSpeakerId) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== "assistant") break;
        if (speakerOf(msgs[i].nodeId) !== lastSpeakerId) break;
        lastSpeakerStreak++;
      }
    }
    const recentSpeakerIds = msgs
      .filter((m) => m.role === "assistant")
      .slice(-4)
      .map((m) => speakerOf(m.nodeId));
    const candidates: GroupSpeakerCandidate[] = this.groupMembers;
    return (
      pickNextSpeaker({
        candidates,
        lastMessageText: last ? this.displayTextOf(last) : "",
        lastSpeakerId,
        lastSpeakerStreak,
        maxConsecutiveSame: this.group?.maxConsecutiveSpeaker,
        recentSpeakerIds,
      }) ?? hostId
    );
  }

  /** 한 라운드(유저 발화 뒤)의 최대 연속 AI 발화 수 — 그룹 설정, 없으면 멤버 수(상한 3). */
  private maxAutoReplies(): number {
    const configured = this.group?.autoChainMax;
    if (configured && configured > 0) return Math.max(1, Math.floor(configured));
    return Math.min(3, this.groupMembers.length);
  }

  /** 발화자 선택 버튼 표시 — 자동(users 아이콘) 또는 지목 멤버 아바타. */
  private updateSpeakerBtn(): void {
    const btn = this.speakerBtn;
    if (!btn) return;
    btn.toggleClass("is-hidden", !this.isGroupChat());
    btn.empty();
    const pinned = this.memberOf(this.pinnedSpeakerId);
    btn.toggleClass("is-pinned", pinned != null);
    if (pinned) {
      const avatar = btn.createDiv({ cls: "ggai-chat-speaker-avatar" });
      renderThumb(this.app, avatar, pinned.thumbPath, pinned.name, "user");
      btn.setAttr("aria-label", `발화자: ${pinned.name} (탭해서 변경)`);
    } else {
      setIcon(btn, "users");
      btn.setAttr("aria-label", "발화자: 자동 (탭해서 지목)");
    }
    btn.setAttr("data-tooltip-position", "top");
  }

  /** 입력창 옆 발화자 메뉴 — 자동 + 멤버 목록. */
  private openSpeakerMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("자동 (다음 발화자 추천)")
        .setIcon("users")
        .setChecked(this.pinnedSpeakerId == null)
        .onClick(() => {
          this.pinnedSpeakerId = null;
          this.updateSpeakerBtn();
        })
    );
    for (const m of this.groupMembers) {
      menu.addItem((item) =>
        item
          .setTitle(m.name)
          .setIcon("user")
          .setChecked(this.pinnedSpeakerId === m.scenarioId)
          .onClick(() => {
            this.pinnedSpeakerId = m.scenarioId;
            this.updateSpeakerBtn();
          })
      );
    }
    menu.showAtMouseEvent(e);
  }

  /** 자동 연쇄 중단 — 타이핑/이동/재생성 등 사용자 개입 시 즉시. */
  private cancelAutoChain(): void {
    this.autoChainRemaining = 0;
    if (this.autoChainTimer != null) {
      window.clearTimeout(this.autoChainTimer);
      this.autoChainTimer = null;
    }
  }

  /** 생성 완료 후 다음 발화자 자동 이어가기 예약 (남은 횟수 있을 때만). */
  private scheduleAutoChain(): void {
    if (!this.isGroupChat() || this.autoChainRemaining <= 0) return;
    if (this.autoChainTimer != null) window.clearTimeout(this.autoChainTimer);
    this.autoChainTimer = window.setTimeout(() => {
      this.autoChainTimer = null;
      void this.runAutoChainStep();
    }, 700);
  }

  private async runAutoChainStep(): Promise<void> {
    if (!this.session || !this.sessionFile || this.generation) return;
    if (!this.isGroupChat() || this.autoChainRemaining <= 0) return;
    // 사용자가 입력 중이면 연쇄를 조용히 멈춘다 (타이핑 인터럽트).
    if ((this.inputEl?.value ?? "").trim() !== "") {
      this.cancelAutoChain();
      return;
    }
    this.autoChainRemaining--;
    await this.runGeneration(this.session.meta.activeLeafId, "ai-continue", {
      speakerId: this.chooseSpeakerForNext(),
      chain: true,
    });
  }

  /** [계속 진행] — 자동 연쇄 한 라운드를 다시 연다 (상한 도달/중단 후 이어가기). */
  private async continueGroupRound(): Promise<void> {
    if (!this.session || this.generation) return;
    await this.flushPendingEdits();
    this.autoChainRemaining = this.maxAutoReplies();
    await this.runAutoChainStep();
  }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("ggai-chat-view");

    if (!this.session || !this.sessionFile) {
      root.createDiv({
        cls: "ggai-chat-empty",
        text: "세션이 없습니다. 로비나 사이드바에서 채팅 세션을 여세요.",
      });
      return;
    }

    // 상단 뷰어 옵션 줄 — 소설과 같은 자리·모양 (모바일은 뷰 헤더 액션이 대신).
    if (!Platform.isMobile) this.renderViewerBar(root);
    // PC(제목줄 꺼짐): Commander 페이지 헤더 버튼을 상단 좌측에 대신 그린다
    // — 모바일 제목줄에서 보이는 버튼과 동기.
    renderHeaderCommandBar(this.app, root);

    this.messagesEl = root.createDiv({ cls: "ggai-chat-messages" });
    this.guard.attach(this.messagesEl);
    this.messagesEl.addEventListener("scroll", () => {
      const el = this.messagesEl;
      if (!el) return;
      this.followTail = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    });
    // 문단 재생성 선택 모드 — 말풍선 탭으로 대상 문단을 고른다 (캡처 단계).
    this.messagesEl.addEventListener(
      "click",
      (e) => {
        if (!this.paraSelectMode) return;
        const target = e.target as HTMLElement;
        const bubble = target.closest?.(".ggai-chat-bubble");
        if (!(bubble instanceof HTMLElement)) return;
        e.preventDefault();
        e.stopPropagation();
        const anchor = this.paragraphIndexFromBubbleClick(bubble, e);
        this.exitParaSelectMode();
        if (anchor != null) this.openParagraphRegen(anchor);
      },
      true
    );
    this.applyViewStyle();

    // 콕핏 입력바 — 입력창을 가운데 두고 리모컨을 좌/우 날개로 접어 넣는다.
    // 좌측 날개(되감기·미디어 2줄) + 가운데(입력+전송) + 우측 날개(세이브·보기·패널).
    // 재생성·형제이동은 마지막 말풍선 아래(renderTailControls)가 담당한다.
    const bar = root.createDiv({ cls: "ggai-chat-inputbar ggai-chat-cockpit" });
    this.leftWingEl = bar.createDiv({
      cls: "ggai-cockpit-wing ggai-cockpit-left",
    });
    const center = bar.createDiv({ cls: "ggai-cockpit-center" });
    this.inputEl = center.createEl("textarea", {
      cls: "ggai-chat-input",
      attr: { rows: "1", placeholder: "메시지를 입력하세요…" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      // 모바일은 Enter = 줄바꿈 (Shift 키가 사실상 없다) — 전송은 버튼으로.
      // PC 는 Enter = 전송, Shift+Enter = 줄바꿈 (채팅 앱 관례).
      if (Platform.isMobile) return;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.handleSend();
      }
    });
    this.inputEl.addEventListener("input", () => {
      // 타이핑 인터럽트 — 사용자가 쓰기 시작하면 자동 연쇄를 즉시 멈춘다 (G2).
      if ((this.inputEl?.value ?? "") !== "") this.cancelAutoChain();
      this.autosizeInput();
    });
    // 선택 모드에서 입력창을 탭하면 입력창 텍스트가 재생성 대상이 된다.
    this.inputEl.addEventListener(
      "mousedown",
      (e) => {
        if (!this.paraSelectMode) return;
        const text = this.inputEl?.value ?? "";
        if (!text.trim()) return;
        e.preventDefault();
        this.exitParaSelectMode();
        this.openInputRegen();
      },
      true
    );

    this.sendBtn = center.createEl("button", { cls: "ggai-chat-send" });
    this.sendBtn.addEventListener("click", () => void this.handleSend());

    this.rightWingEl = bar.createDiv({
      cls: "ggai-cockpit-wing ggai-cockpit-right",
    });
    this.renderToolbar();

    this.renderMessages();
    this.updateSendButton();
    this.scrollToBottom();
  }

  /**
   * PC 뷰어 줄 — 본문 위 우측 상단 0높이 레이어 (소설 renderViewerBar 대응).
   * 모바일은 setupViewerToolActions 가 같은 구성(갤러리/원문↔번역)을 뷰 헤더 액션으로.
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
    gallery.addEventListener("click", () => this.openGallery());
    const viewToggle = mkBtn("languages", "원문/번역 전환");
    viewToggle.addEventListener("click", () =>
      void this.setTranslationView(!this.translationViewActive)
    );
    this.viewToggleBtn = viewToggle;
    this.updateViewToggleBtn();
  }

  /** 모바일 — 뷰 헤더 액션 (등록 역순 표시: 좌→우 = 갤러리/전환). */
  private setupViewerToolActions(): void {
    const viewToggle = this.addAction("languages", "원문/번역 전환", () =>
      void this.setTranslationView(!this.translationViewActive)
    );
    this.viewToggleBtn = viewToggle;
    this.addAction("images", "삽화 갤러리", () => this.openGallery());
    // 등록 역순 표시라 로비(나가기)를 가장 왼쪽에 두려면 마지막에 등록한다.
    this.addAction("log-out", "세션 나가기 (로비로)", () => void this.goToLobby());
    this.updateViewToggleBtn();
  }

  /** 로비(대시보드)로 — 미저장 편집을 커밋한 뒤 같은 탭에서 전환 (소설과 동일). */
  private async goToLobby(): Promise<void> {
    this.cancelAutoChain();
    await this.flushPendingEdits();
    await this.leaf.setViewState({
      type: VIEW_TYPE_DASHBOARD,
      active: true,
      state: { stellaPanel: this.stellaPanel },
    });
  }

  private updateViewToggleBtn(): void {
    this.viewToggleBtn?.toggleClass("is-active", this.translationViewActive);
  }

  /** 세션 전체 삽화 갤러리 (소설과 같은 모달 재사용). */
  private openGallery(): void {
    const items: GalleryItem[] = [];
    const nodes = this.illustrations?.nodes ?? {};
    const folder = this.sessionFile
      ? this.sessionFile.slice(0, -"/session.json".length)
      : "";
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
            path: `${folder}/${v.path}`,
            caption: illustrationCaption(v.prompt),
          });
      }
    }
    if (items.length === 0) {
      new Notice("이 세션에 생성된 삽화가 없습니다.");
      return;
    }
    new IllustrationGalleryModal(this.app, {
      items,
      onJump: (nodeId) => void this.jumpToIllustrationNode(nodeId),
      onDelete: (nodeId, variantId) => this.deleteIllustration(nodeId, variantId),
      onToggleFavorite: (nodeId, variantId) =>
        this.toggleIllustrationFavorite(nodeId, variantId),
      ...(this.plugin.phone.isPhoneInUse()
        ? {
            onShareToNetwork: (item: GalleryItem) =>
              shareGalleryImageToNetwork(this.plugin, item.path!, item.caption),
          }
        : {}),
    }).open();
  }

  /** 갤러리에서 고른 삽화의 메시지로 이동 — 그 노드의 최신 분기로 전환 후 스크롤. */
  private async jumpToIllustrationNode(nodeId: string): Promise<void> {
    if (!this.session || !this.sessionFile || this.generation) return;
    if (!this.session.nodes[nodeId]) return;
    await this.flushPendingEdits();
    const leaf =
      getDeepestLatestDescendant(this.session, nodeId) ?? this.session.nodes[nodeId];
    this.session.meta.activeLeafId = leaf.id;
    await this.persistSession("분기 이동 저장 실패");
    this.renderMessages();
    window.requestAnimationFrame(() => this.scrollToNode(nodeId));
  }

  /** 갤러리에서 삽화 variant 삭제 (asset PNG 도 휴지통으로). */
  private async deleteIllustration(nodeId: string, variantId: string): Promise<void> {
    if (!this.sessionFile || !this.illustrations) return;
    const removed = removeIllustrationVariant(this.illustrations, nodeId, variantId);
    if (!removed) return;
    await this.store.saveSessionIllustrations(this.sessionFile, this.illustrations, {
      origin: this.storeOrigin,
    });
    await this.store.deleteSessionAsset(this.sessionFile, removed.path);
    this.renderMessages();
  }

  private renderMessages(): void {
    const host = this.messagesEl;
    if (!host || !this.session) return;
    if (this.isBubbleEditing()) {
      // 말풍선 편집 중에만 재렌더를 미룬다 (버튼 포커스는 막지 않는다) —
      // blur 시점에 renderPending 을 반영. 광역 가드는 "갱신이 한참 미뤄지다
      // 한꺼번에 나타나는" 문제의 원인이었다.
      this.renderPending = true;
      return;
    }
    this.renderPending = false;

    // 읽던 위치 보존 — 바닥 따라가기 중이 아니면(위로 스크롤해 옛 대화를 읽는
    // 중이면) 재렌더 후 스크롤 위치를 복원한다. 자동 번역/삽화 완료 같은 외부
    // 갱신이 읽던 화면을 맨 아래로 끌어내리는 회귀 방지 (소설 뷰의 보던 위치
    // 보존 원칙과 동일).
    const savedScrollTop = this.followTail ? null : host.scrollTop;

    host.empty();
    this.streamBubbleEl = null;
    this.messages = buildChatMessages(this.session);

    if (this.messages.length === 0 && !this.generation) {
      host.createDiv({
        cls: "ggai-chat-empty",
        text: "메시지를 입력해 대화를 시작하세요.",
      });
      return;
    }

    host.toggleClass("is-para-select", this.paraSelectMode);

    // 날짜가 바뀌는 지점에만 구분선 — 현실 시각(노드 createdAt) 기준.
    let prevDayKey: string | null = null;
    this.messages.forEach((msg, index) => {
      const ts = this.session?.nodes[msg.nodeId]?.createdAt;
      if (ts) {
        const key = dayKeyOf(ts);
        if (key !== prevDayKey) {
          const divider = host.createDiv({ cls: "ggai-chat-date-divider" });
          divider.createSpan({
            cls: "ggai-chat-date-label",
            text: formatDateDivider(ts),
          });
          prevDayKey = key;
        }
      }

      const row = host.createDiv({
        cls: `ggai-chat-msg ${msg.role === "user" ? "is-user" : "is-assistant"}`,
      });
      row.dataset.nodeId = msg.nodeId;

      // 발화자 표시 재료 — 그룹 챗이면 노드의 발화자 멤버 (G2), 아니면 시나리오.
      const groupChat = this.isGroupChat();
      const speaker =
        msg.role === "assistant" && groupChat
          ? this.speakerDisplayOf(msg.nodeId)
          : null;

      // 아바타 — AI 는 발화자(시나리오) 표지, 유저는 페르소나 썸네일 (말풍선 옆).
      const avatar = row.createDiv({ cls: "ggai-chat-avatar" });
      renderThumb(
        this.app,
        avatar,
        msg.role === "user"
          ? this.personaThumbPath
          : speaker?.thumbPath ?? this.scenarioThumbPath,
        msg.role === "user"
          ? this.displayMacroCtx.user ?? "User"
          : speaker?.name ?? this.displayMacroCtx.char ?? "AI",
        msg.role === "user" ? "user" : "book-open"
      );

      const stack = row.createDiv({ cls: "ggai-chat-stack" });
      // 이름 라벨 — AI = 발화자(시나리오) 이름, 유저 = 페르소나 이름.
      const nameEl = stack.createDiv({
        cls: "ggai-chat-name",
        text:
          msg.role === "user"
            ? this.displayMacroCtx.user ?? "User"
            : speaker?.name ?? this.displayMacroCtx.char ?? "AI",
      });
      if (speaker) nameEl.addClass(`is-speaker-${speaker.colorIndex % 6}`);
      const bubble = stack.createDiv({ cls: "ggai-chat-bubble" });
      bubble.dataset.index = String(index);

      const generatingThis =
        this.generation != null && this.generation.nodeId === msg.nodeId;
      if (generatingThis) {
        bubble.setText(this.generation?.accumulatedText ?? "");
        this.streamBubbleEl = bubble;
        row.addClass("is-generating");
      } else if (this.translationViewActive) {
        // 번역 보기 — 번역 슬롯 치환 표시 + 직접 편집(문단별 user-edit variant 로
        // translations.json 에만 저장 — 본문(원문)은 절대 건드리지 않는다).
        this.setBubbleDisplay(
          bubble,
          this.displayRegexText(
            this.macroText(this.translatedTextOf(this.displayTextOf(msg))),
            index
          )
        );
        row.addClass("is-translated");
        if (!this.paraSelectMode) this.makeTranslationBubbleEditable(bubble);
      } else {
        // 표시 = 매크로 적용본에 표기(기울임/대사/문단) 반영, 편집 진입(focus)
        // 시 raw 로 스왑.
        this.setBubbleDisplay(
          bubble,
          this.displayRegexText(this.macroText(this.displayTextOf(msg)), index)
        );
        // 선택 모드에서는 편집 대신 탭 = 재생성 대상 지정.
        if (!this.paraSelectMode) this.makeBubbleEditable(bubble);
      }

      // AI 말풍선 밑 삽화 캐러셀 (노드 기준 illustrations.json 그대로).
      if (msg.role === "assistant" && !generatingThis) {
        this.renderBubbleIllustrations(stack, msg.nodeId);
      }
    });

    // 생성 중인데 노드 텍스트가 아직 비어 메시지로 안 잡히면 자리 말풍선을 만든다
    // (첫 델타부터 바로 보이게).
    if (this.generation && !this.streamBubbleEl) {
      const row = host.createDiv({ cls: "ggai-chat-msg is-assistant is-generating" });
      row.dataset.nodeId = this.generation.nodeId;
      // 그룹 챗 — 누가 말하는 중인지 아바타+이름 라벨을 먼저 보여준다.
      if (this.isGroupChat()) {
        const speaker = this.speakerDisplayOf(this.generation.nodeId);
        const avatar = row.createDiv({ cls: "ggai-chat-avatar" });
        renderThumb(this.app, avatar, speaker.thumbPath, speaker.name, "book-open");
        const stack = row.createDiv({ cls: "ggai-chat-stack" });
        stack
          .createDiv({ cls: "ggai-chat-name", text: speaker.name })
          .addClass(`is-speaker-${speaker.colorIndex % 6}`);
        const bubble = stack.createDiv({ cls: "ggai-chat-bubble" });
        bubble.setText(this.generation.accumulatedText);
        this.streamBubbleEl = bubble;
      } else {
        const bubble = row.createDiv({ cls: "ggai-chat-bubble" });
        bubble.setText(this.generation.accumulatedText);
        this.streamBubbleEl = bubble;
      }
    }

    // 마지막 메시지 컨트롤 — 스와이프(형제 이동) + 재생성.
    if (!this.generation) this.renderTailControls(host);
    this.updateToolbar();
    if (savedScrollTop == null) this.scrollToBottom();
    else host.scrollTop = savedScrollTop;
  }

  /** 번역 보기 텍스트 — 문단 토큰의 번역 슬롯 치환 (미번역 문단은 원문 유지). */
  private translatedTextOf(text: string): string {
    const tr = this.translations;
    if (!tr) return text;
    return tokenizeParagraphs(text)
      .map((tok) => {
        if (tok.kind === "separator") return tok.text;
        const t = getActiveTranslation(tr, tok.hash);
        return t && t.text.trim() !== "" ? t.text : tok.source;
      })
      .join("");
  }

  /** AI 말풍선 밑 삽화 캐러셀 — variant 가 있을 때만. */
  private renderBubbleIllustrations(stack: HTMLElement, nodeId: string): void {
    const ill = this.illustrations;
    if (!ill || !this.sessionFile) return;
    if (listIllustrationVariants(ill, nodeId).length === 0) return;
    const carEl = stack.createDiv({ cls: "ggai-chat-illus" });
    new IllustrationCarousel(carEl, {
      resolveSrc: (v) => this.resolveIllustrationSrc(v),
      getVariants: () =>
        this.illustrations ? listIllustrationVariants(this.illustrations, nodeId) : [],
      getActiveId: () =>
        this.illustrations
          ? getActiveIllustration(this.illustrations, nodeId)?.id ?? null
          : null,
      onSelect: (variantId) => void this.selectIllustrationVariant(nodeId, variantId),
      onRegen: () => this.openIllustrationRegen(nodeId),
      isBusy: () => this.illustrating,
      isFavorite: (v) => !!v.favorite,
      onToggleFavorite: (variantId) =>
        this.toggleIllustrationFavorite(nodeId, variantId),
      onDelete: (variantId) => void this.deleteIllustration(nodeId, variantId),
      ...(this.plugin.phone.isPhoneInUse()
        ? {
            onShare: (v: IllustrationVariant) =>
              shareGalleryImageToNetwork(
                this.plugin,
                `${this.sessionFile?.slice(0, -"/session.json".length) ?? ""}/${v.path}`,
                illustrationCaption(v.prompt)
              ),
          }
        : {}),
    });
  }

  private resolveIllustrationSrc(v: IllustrationVariant): string | null {
    if (!this.sessionFile) return null;
    const folder = this.sessionFile.slice(0, -"/session.json".length);
    const file = this.app.vault.getAbstractFileByPath(`${folder}/${v.path}`);
    return file instanceof TFile ? this.app.vault.getResourcePath(file) : null;
  }

  private async selectIllustrationVariant(
    nodeId: string,
    variantId: string
  ): Promise<void> {
    if (!this.sessionFile || !this.illustrations) return;
    if (!setActiveIllustrationVariant(this.illustrations, nodeId, variantId)) return;
    await this.store.saveSessionIllustrations(this.sessionFile, this.illustrations, {
      origin: this.storeOrigin,
    });
  }

  private toggleIllustrationFavorite(nodeId: string, variantId: string): boolean {
    if (!this.sessionFile || !this.illustrations) return false;
    const next = toggleIllustrationFavorite(this.illustrations, nodeId, variantId);
    void this.store.saveSessionIllustrations(this.sessionFile, this.illustrations, {
      origin: this.storeOrigin,
    });
    return next;
  }

  private openIllustrationRegen(nodeId: string): void {
    const active = this.illustrations
      ? getActiveIllustration(this.illustrations, nodeId)
      : null;
    new IllustrationRegenModal(this.app, {
      prompt: active?.prompt ?? "",
      negativePrompt: active?.negativePrompt ?? "",
      onSubmit: (prompt, negativePrompt) =>
        void this.runIllustrationRegen(nodeId, prompt, negativePrompt),
    }).open();
  }

  private async runIllustrationRegen(
    nodeId: string,
    prompt: string,
    negativePrompt: string
  ): Promise<void> {
    if (!this.sessionFile || this.illustrating) return;
    this.illustrating = true;
    this.updateToolbar();
    try {
      const result = await this.plugin.illustration.regenWithPrompt(
        this.sessionFile,
        nodeId,
        { prompt, negativePrompt }
      );
      if (!result.ok) {
        new Notice("삽화 생성 실패: " + (result.errors[0] ?? "알 수 없는 오류"));
      }
    } finally {
      this.illustrating = false;
      this.updateToolbar();
    }
  }

  // ── 리모컨 (콕핏 날개) ───────────────────────────────────────────

  private renderToolbar(): void {
    const left = this.leftWingEl;
    const right = this.rightWingEl;
    if (!left || !right || !this.session) return;
    left.empty();
    right.empty();

    const mkIconBtn = (
      parent: HTMLElement,
      icon: string,
      label: string,
      onClick: () => void
    ): HTMLButtonElement => {
      const btn = parent.createEl("button", { cls: "ggai-btn ggai-icon-btn" });
      setIcon(btn, icon);
      btn.setAttr("aria-label", label);
      btn.setAttr("data-tooltip-position", "top");
      btn.addEventListener("click", () => onClick());
      return btn;
    };

    // 좌측 날개: undo/redo/끝으로 (위) + 번역/삽화/문단재생성 (아래).
    const leftTop = left.createEl("div", {
      cls: "ggai-toolbar-row ggai-toolbar-row-top",
    });
    this.undoBtn = mkIconBtn(leftTop, "rewind", "Undo (마지막 메시지 접기)", () =>
      void this.handleUndo()
    );
    this.redoBtn = mkIconBtn(leftTop, "fast-forward", "Redo", () =>
      void this.handleRedo()
    );
    this.jumpEndBtn = mkIconBtn(leftTop, "skip-forward", "끝으로", () =>
      void this.handleJumpEnd()
    );

    const leftBottom = left.createEl("div", {
      cls: "ggai-toolbar-row ggai-toolbar-row-bottom",
    });
    const tBtn = leftBottom.createEl("button", {
      cls: "ggai-btn ggai-icon-btn ggai-media-trigger-btn",
    });
    setIcon(tBtn, "languages");
    tBtn.setAttr(
      "aria-label",
      "번역 — 입력창에 글이 있으면 입력창 번역 (꾹: 자동 번역 on/off)"
    );
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
    pBtn.setAttr(
      "aria-label",
      "문단 재생성 — 켠 뒤 말풍선(또는 입력창)을 탭해 대상 선택"
    );
    pBtn.setAttr("data-tooltip-position", "top");
    pBtn.addEventListener("click", () => this.toggleParaSelectMode());
    this.wandBtn = pBtn;

    // 우측 날개: 세이브 / 보기 (위) + 우측 패널 (아래). 재생성·형제이동은
    // 마지막 말풍선 아래(renderTailControls)가 담당하므로 여기 두지 않는다.
    const rightTop = right.createEl("div", {
      cls: "ggai-toolbar-row ggai-toolbar-row-top",
    });
    // 그룹 챗 — 발화자 선택 (자동 / 멤버 지목). 일반 세션에선 숨김(플레이 중
    // 초대로 그룹이 되는 순간 바로 보이도록 항상 만들어 두고 is-hidden 으로 토글).
    this.speakerBtn = rightTop.createEl("button", {
      cls: "ggai-btn ggai-icon-btn ggai-chat-speaker-btn",
    });
    this.speakerBtn.setAttr("data-tooltip-position", "top");
    this.speakerBtn.addEventListener("click", (e) => this.openSpeakerMenu(e));
    this.updateSpeakerBtn();
    this.nodeFavBtn = mkIconBtn(rightTop, "save", "세이브 (노드 즐겨찾기)", () =>
      void this.toggleNodeFavorite()
    );
    const styleBtn: HTMLButtonElement = mkIconBtn(
      rightTop,
      "sliders-horizontal",
      "보기 스타일",
      () => this.toggleViewStylePopover(styleBtn)
    );

    const rightBottom = right.createEl("div", {
      cls: "ggai-toolbar-row ggai-toolbar-row-bottom",
    });
    // 선채팅 — 탭: 이 세션 온오프 / 꾹: 실시간 채팅(시간 인지) 온오프.
    const bBtn = rightBottom.createEl("button", {
      cls: "ggai-btn ggai-icon-btn ggai-media-trigger-btn",
    });
    setIcon(bBtn, "bell");
    bBtn.setAttr(
      "aria-label",
      "선채팅 on/off — 캐릭터가 먼저 말 걸기 (꾹: 실시간 채팅 on/off)"
    );
    bBtn.setAttr("data-tooltip-position", "top");
    attachLongPress(bBtn, {
      onTap: () => void this.toggleProactive(),
      onLongPress: () => void this.toggleProactiveRealtime(),
    });
    this.proactiveBtn = bBtn;
    mkIconBtn(rightBottom, "panel-right", "우측 패널 열기", () =>
      void this.plugin.revealDetail()
    );
    // 확장 조작 트레이 — 탭하면 이 버튼에서 확장 액션 모음이 열린다.
    const extBtn = rightBottom.createEl("button", {
      cls: "ggai-btn ggai-icon-btn",
    });
    setIcon(extBtn, "puzzle");
    extBtn.setAttr("aria-label", "확장 기능");
    extBtn.setAttr("data-tooltip-position", "top");
    extBtn.addEventListener("click", (e) => {
      if (this.sessionFile)
        openExtensionActionsMenu(this.plugin, this.sessionFile, e);
    });

    this.updateToolbar();
  }

  /** 리모컨 상태 갱신 — 비활성/토글 표시 (소설 updateToolbar 대응). */
  private updateToolbar(): void {
    if (!this.session) return;
    const cur = this.session.nodes[this.session.meta.activeLeafId];
    if (!cur) return;
    const generating = this.generation != null;

    if (this.undoBtn) this.undoBtn.disabled = generating || cur.parent == null;
    const hasRedoTarget =
      this.redoStack.length > 0 || getChildren(this.session, cur.id).length > 0;
    if (this.redoBtn) this.redoBtn.disabled = generating || !hasRedoTarget;
    const hasDeeper =
      getDeepestLatestDescendant(this.session, cur.id)?.id !== cur.id;
    if (this.jumpEndBtn) this.jumpEndBtn.disabled = generating || !hasDeeper;

    const t = this.session.meta.translation;
    if (this.translateBtn) {
      this.translateBtn.disabled =
        generating || this.translating || t?.enabled !== true;
      this.translateBtn.toggleClass("is-auto-on", t?.auto === true);
      this.translateBtn.toggleClass("is-busy", this.translating);
    }
    const i = this.session.meta.illustration;
    if (this.illustrationBtn) {
      this.illustrationBtn.disabled =
        generating || this.illustrating || i?.enabled !== true;
      this.illustrationBtn.toggleClass("is-auto-on", i?.auto === true);
      this.illustrationBtn.toggleClass("is-busy", this.illustrating);
    }
    if (this.wandBtn) {
      this.wandBtn.disabled = generating;
      this.wandBtn.toggleClass("is-select-on", this.paraSelectMode);
    }
    const pa = this.session.meta.proactive;
    if (this.proactiveBtn) {
      this.proactiveBtn.toggleClass("is-active", pa?.enabled === true);
      this.proactiveBtn.toggleClass("is-auto-on", pa?.realtime === true);
    }

    this.nodeFavBtn?.toggleClass("is-active", cur.favorite === true);
  }

  /** undo — 활성 리프를 부모로 (마지막 메시지/편집 접기). redo 스택에 쌓는다. */
  private async handleUndo(): Promise<void> {
    if (!this.session || this.generation) return;
    this.cancelAutoChain();
    await this.flushPendingEdits();
    const cur = this.session.nodes[this.session.meta.activeLeafId];
    if (!cur?.parent) return;
    this.redoStack.push(cur.id);
    this.session.meta.activeLeafId = cur.parent;
    await this.persistSession("Undo 저장 실패");
    this.followTail = true; // 결과(접힌 꼬리)가 보이게
    this.renderMessages();
  }

  /** redo — undo 스택 우선, 없으면 최근 자식으로 전진. */
  private async handleRedo(): Promise<void> {
    if (!this.session || this.generation) return;
    this.cancelAutoChain();
    await this.flushPendingEdits();
    let targetId: string | null = null;
    while (this.redoStack.length > 0) {
      const candidate = this.redoStack.pop()!;
      if (this.session.nodes[candidate]) {
        targetId = candidate;
        break;
      }
    }
    if (!targetId) {
      const children = getChildren(
        this.session,
        this.session.meta.activeLeafId
      ).sort((a, b) => b.createdAt - a.createdAt);
      targetId = children[0]?.id ?? null;
    }
    if (!targetId) return;
    this.session.meta.activeLeafId = targetId;
    await this.persistSession("Redo 저장 실패");
    this.followTail = true;
    this.renderMessages();
  }

  /** 끝으로 — 현재 리프에서 가장 깊은 최신 후손으로. */
  private async handleJumpEnd(): Promise<void> {
    if (!this.session || this.generation) return;
    this.cancelAutoChain();
    await this.flushPendingEdits();
    const deepest = getDeepestLatestDescendant(
      this.session,
      this.session.meta.activeLeafId
    );
    if (!deepest || deepest.id === this.session.meta.activeLeafId) return;
    this.session.meta.activeLeafId = deepest.id;
    this.redoStack = [];
    await this.persistSession("이동 저장 실패");
    this.followTail = true;
    this.renderMessages();
  }

  /** ◀ ▶ — 활성 리프의 형제 분기 이동 (스와이프와 동일). */
  /** 꾹 — 자동 번역 on/off (소설과 같은 낙관적 갱신). */
  private async handleAutoTranslateToggle(): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    const current = this.session.meta.translation ?? {};
    if (current.enabled !== true) return;
    const translation = { ...current, auto: current.auto !== true };
    this.session.meta.translation = translation;
    this.updateToolbar();
    new Notice(translation.auto ? "자동 번역 켜짐" : "자동 번역 꺼짐");
    await this.plugin.patchActiveSettings({ translation }, this.sessionFile, {
      origin: this.storeOrigin,
    });
  }

  /** 탭 — 이 세션의 선채팅(캐릭터 선발화) on/off. */
  private async toggleProactive(): Promise<void> {
    if (!this.session) return;
    const next = this.session.meta.proactive?.enabled !== true;
    this.session.meta.proactive = {
      ...(this.session.meta.proactive ?? {}),
      enabled: next,
    };
    this.updateToolbar();
    new Notice(
      next
        ? "선채팅 켜짐 — 이 세션의 캐릭터가 먼저 말을 걸 수 있습니다."
        : "선채팅 꺼짐"
    );
    await this.persistSession("선채팅 설정 저장 실패");
  }

  /** 꾹 — 실시간 채팅 on/off (선채팅에 현재 시간·경과 반영). */
  private async toggleProactiveRealtime(): Promise<void> {
    if (!this.session) return;
    const next = this.session.meta.proactive?.realtime !== true;
    this.session.meta.proactive = {
      ...(this.session.meta.proactive ?? {}),
      realtime: next,
    };
    this.updateToolbar();
    new Notice(
      next
        ? "실시간 채팅 켜짐 — 선채팅이 현재 시간과 지난 시간을 인지합니다."
        : "실시간 채팅 꺼짐"
    );
    await this.persistSession("선채팅 설정 저장 실패");
  }

  /** 꾹 — 자동 삽화 on/off. */
  private async handleAutoIllustrateToggle(): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    const current = this.session.meta.illustration ?? {};
    if (current.enabled !== true) return;
    const illustration = { ...current, auto: current.auto !== true };
    this.session.meta.illustration = illustration;
    this.updateToolbar();
    new Notice(illustration.auto ? "자동 삽화 켜짐" : "자동 삽화 꺼짐");
    await this.plugin.patchActiveSettings({ illustration }, this.sessionFile, {
      origin: this.storeOrigin,
    });
  }

  // ── 문단 재생성 선택 모드 ────────────────────────────────────────

  private toggleParaSelectMode(): void {
    if (this.paraSelectMode) {
      this.exitParaSelectMode();
      return;
    }
    if (!this.session || this.generation) return;
    void this.flushPendingEdits().then(() => {
      this.paraSelectMode = true;
      this.renderMessages(); // updateToolbar 가 is-select-on 표시를 겸한다
      new Notice("재생성할 말풍선(또는 입력창)을 탭하세요.");
    });
  }

  private exitParaSelectMode(): void {
    if (!this.paraSelectMode) return;
    this.paraSelectMode = false;
    this.renderMessages();
  }

  /**
   * 말풍선 클릭 → 본문 전체 기준 문단 인덱스.
   * 전역 인덱스 = 앞 메시지들의 문단 수 합 + 말풍선 안 클릭 문단 순번.
   *
   * 말풍선 표시는 <p class="ggai-chat-para">(빈 줄 경계) 안에 <br>(단일 줄바꿈)로
   * 그려지고, textContent 에는 그 경계가 남지 않는다 — 그래서 글자 오프셋 역산이
   * 아니라 **클릭한 <p> 블록 + 그 안의 줄(<br>) 순번**을 직접 센다. 재생성 문단
   * 단위(tokenizeParagraphs = 줄 단위)와 1:1 로 맞는 계산이다.
   * (표시는 매크로 적용본이라 원문 문단 수로 클램프 — 드문 불일치 방어.)
   */
  private paragraphIndexFromBubbleClick(
    bubble: HTMLElement,
    e: MouseEvent
  ): number | null {
    const idx = Number(bubble.dataset.index);
    const msg = this.messages[idx];
    if (!msg) return null;
    const paraCount = (text: string): number =>
      tokenizeParagraphs(text).filter((t) => t.kind === "paragraph").length;

    let base = 0;
    for (let i = 0; i < idx; i++) base += paraCount(this.messages[i].text);
    const total = paraCount(msg.text);
    if (total <= 0) return null;

    let within = total - 1; // 폴백: 여백/경계 클릭은 마지막 문단
    const blocks = Array.from(
      bubble.querySelectorAll<HTMLElement>(":scope > p.ggai-chat-para")
    );
    const clickedBlock =
      e.target instanceof HTMLElement
        ? e.target.closest("p.ggai-chat-para")
        : null;
    if (blocks.length > 0 && clickedBlock instanceof HTMLElement) {
      const bIdx = blocks.indexOf(clickedBlock);
      if (bIdx >= 0) {
        let lines = 0;
        for (let i = 0; i < bIdx; i++) {
          lines += blocks[i].querySelectorAll("br").length + 1;
        }
        lines += lineIndexInBlock(clickedBlock, e);
        within = Math.min(lines, total - 1);
      }
    }
    return base + within;
  }

  /** 선택 모드에서 입력창을 탭 — 입력창 텍스트를 재생성 대상으로 모달 오픈. */
  private openInputRegen(): void {
    const ta = this.inputEl;
    if (!ta || !this.sessionFile) return;
    const baselineText = ta.value;
    const ranges = listParagraphRanges(baselineText);
    if (ranges.length === 0) return;
    new ParagraphRegenModal(this.plugin, {
      sessionFile: this.sessionFile,
      baselineText,
      anchorIndex: ranges.length - 1,
      onApply: async (from, to, expected, text) => {
        const input = this.inputEl;
        if (!input) return false;
        if (input.value.slice(from, to) !== expected) {
          new Notice("입력창 내용이 바뀌어 적용할 수 없습니다.");
          return false;
        }
        input.value = input.value.slice(0, from) + text + input.value.slice(to);
        this.autosizeInput();
        input.focus();
        return true;
      },
    }).open();
  }

  private async toggleNodeFavorite(): Promise<void> {
    if (!this.session) return;
    const cur = this.session.nodes[this.session.meta.activeLeafId];
    if (!cur) return;
    cur.favorite = !cur.favorite;
    await this.persistSession("노드 즐겨찾기 저장 실패");
    this.updateToolbar();
  }

  /** 번역 버튼 — 입력창에 글이 있으면 입력창 번역(전송 전 확인), 없으면 일괄 번역. */
  private async handleTranslateTap(): Promise<void> {
    if (!this.session || !this.sessionFile || this.translating) return;
    const inputText = this.inputEl?.value.trim() ?? "";
    this.translating = true;
    this.updateToolbar();
    try {
      if (inputText) {
        const r = await this.plugin.translation.translateText(
          this.sessionFile,
          inputText
        );
        if (!r.ok) {
          new Notice("입력 번역 실패: " + (r.error ?? "알 수 없는 오류"));
          return;
        }
        if (this.inputEl) {
          this.inputEl.value = r.text;
          this.autosizeInput();
          this.inputEl.focus();
        }
        return;
      }
      await this.flushPendingEdits();
      const flat = spansToText(buildSpans(this.session));
      const translations = await this.store.getSessionTranslations(this.sessionFile);
      const targets = collectUntranslatedParagraphs(flat, translations);
      if (targets.length === 0) {
        new Notice("번역할 문단이 없습니다.");
        return;
      }
      const r = await this.plugin.translation.translateParagraphs(this.sessionFile, {
        hashes: targets.map((p) => p.hash),
      });
      if (!r.ok) {
        // 실패했으면 원문 보기를 유지한다 — 번역 안 된 화면으로 전환하지 않는다.
        new Notice("번역 실패: " + (r.errors[0] ?? "알 수 없는 오류"));
        return;
      }
      if (!this.translationViewActive) await this.setTranslationView(true);
    } finally {
      this.translating = false;
      this.updateToolbar();
    }
  }

  /** 원문↔번역 보기 토글 — displayMode 는 translations.json 에 세션별 영속. */
  private async setTranslationView(active: boolean): Promise<void> {
    if (!this.sessionFile) return;
    await this.flushPendingEdits();
    const translations =
      this.translations ??
      (await this.store.getSessionTranslations(this.sessionFile));
    translations.displayMode = active ? "translation" : "source";
    this.translations = translations;
    this.translationViewActive = active;
    await this.store.saveSessionTranslations(this.sessionFile, translations, {
      origin: this.storeOrigin,
    });
    this.updateViewToggleBtn();
    this.renderMessages();
  }

  /** 삽화 버튼 — 마지막 AI 메시지에 삽화 생성. */
  private async handleIllustrateTap(): Promise<void> {
    if (!this.session || !this.sessionFile || this.illustrating) return;
    const nodeId = this.lastAssistantNodeId();
    if (!nodeId) {
      new Notice("삽화를 붙일 AI 메시지가 없습니다.");
      return;
    }
    this.illustrating = true;
    this.updateToolbar();
    try {
      const r = await this.plugin.illustration.generateForNode(
        this.sessionFile,
        nodeId
      );
      if (!r.ok) new Notice("삽화 생성 실패: " + (r.errors[0] ?? "알 수 없는 오류"));
    } finally {
      this.illustrating = false;
      this.updateToolbar();
    }
  }

  private lastAssistantNodeId(): string | null {
    if (!this.session) return null;
    const msgs = buildChatMessages(this.session);
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") return msgs[i].nodeId;
    }
    return null;
  }

  /** 문단 재생성 — 선택 모드에서 탭한 문단을 앵커로 모달 오픈 (범위는 ▲ 로 위로 확장). */
  private openParagraphRegen(anchorIndex: number): void {
    if (!this.session || !this.sessionFile || this.generation) return;
    void this.flushPendingEdits().then(() => {
      if (!this.session || !this.sessionFile) return;
      const baselineText = spansToText(buildSpans(this.session));
      const ranges = listParagraphRanges(baselineText);
      if (ranges.length === 0) return;
      new ParagraphRegenModal(this.plugin, {
        sessionFile: this.sessionFile,
        baselineText,
        anchorIndex: Math.max(0, Math.min(anchorIndex, ranges.length - 1)),
        onApply: (from, to, expected, text) =>
          this.applyRangeReplace(from, to, expected, text),
      }).open();
    });
  }

  /** 검증된 구간 replace 를 user-edit 노드로 파생 (원문 불변 원칙). */
  private async applyRangeReplace(
    from: number,
    to: number,
    expected: string,
    text: string
  ): Promise<boolean> {
    if (!this.session || !this.sessionFile) return false;
    const flat = spansToText(buildSpans(this.session));
    if (flat.slice(from, to) !== expected) {
      new Notice("본문이 바뀌어 적용할 수 없습니다. 다시 열어주세요.");
      return false;
    }
    const node: SessionNode = {
      id: uuidv4(),
      parent: this.session.meta.activeLeafId,
      kind: "user-edit",
      patches: [{ op: "replace", from, to, spans: [{ author: "user", text }] }],
      createdAt: Date.now(),
    };
    this.session.nodes[node.id] = node;
    this.session.meta.activeLeafId = node.id;
    this.redoStack = [];
    await this.persistSession("문단 재생성 적용 실패");
    this.renderMessages();
    return true;
  }

  // ── 보기 설정 (소설과 같은 전역 viewStyle 공유) ──────────────────

  private toggleViewStylePopover(anchor: HTMLElement): void {
    if (this.viewStylePopover?.isOpen()) {
      this.viewStylePopover.close();
      this.viewStylePopover = null;
      return;
    }
    this.viewStylePopover = new ViewStylePopover(
      this.plugin,
      this.viewStyle,
      (style) => {
        this.viewStyle = style;
        this.applyViewStyle();
      },
      "chat"
    );
    this.viewStylePopover.open(anchor);
  }

  private applyViewStyle(): void {
    const el = this.messagesEl;
    if (!el) return;
    el.style.setProperty("--ggai-view-font-scale", String(this.viewStyle.fontScale));
    el.style.setProperty("--ggai-view-indent", `${this.viewStyle.indent}em`);
    el.style.setProperty("--ggai-view-para-gap", `${this.viewStyle.paragraphGap}px`);
    // 아바타(아이콘) 크기 — 보기 설정에서 조절, 0 이면 숨김.
    el.style.setProperty(
      "--ggai-chat-avatar-size",
      `${this.viewStyle.chatAvatarSize}px`
    );
    el.toggleClass("ggai-chat-no-avatar", this.viewStyle.chatAvatarSize <= 0);
  }

  // 자동 번역/삽화(생성 직후)는 번역·삽화 확장(`extensions/translation-extension.ts`,
  // `extensions/illustration-extension.ts`)이 onGenerationComplete 훅으로 실행한다 —
  // 이 뷰는 store 이벤트로 결과만 반영.

  /**
   * 말풍선 표시본 채우기 — 표기(기울임/대사/문단)를 반영한 HTML.
   * 편집(focus) 시에는 raw 로 스왑되므로 diff/커밋에는 영향이 없다.
   */
  private setBubbleDisplay(bubble: HTMLElement, text: string): void {
    bubble.innerHTML = formatChatText(text);
  }

  /** 표시 텍스트 — 메시지 앞 구분자만 벗긴다 (원문 그대로, trim 은 안 함). */
  private displayTextOf(msg: ChatSessionMessage): string {
    return msg.text.startsWith(CHAT_MESSAGE_SEPARATOR)
      ? msg.text.slice(CHAT_MESSAGE_SEPARATOR.length)
      : msg.text;
  }

  private renderTailControls(host: HTMLElement): void {
    if (!this.session) return;
    const leafId = this.session.meta.activeLeafId;
    const leafNode = this.session.nodes[leafId];
    if (!leafNode) return;

    // 스와이프는 리프가 메시지 노드일 때만 (편집 노드의 형제는 변형이 아니다).
    const siblings =
      leafNode.kind === "user-edit"
        ? []
        : getSiblings(this.session, leafId).sort(
            (a, b) => a.createdAt - b.createdAt
          );
    // 재생성 = "마지막 AI 메시지 갈아끼우기" — 뒤에 편집 노드가 붙어 있어도 가능.
    const lastMsg = this.messages[this.messages.length - 1];
    const canRegen = lastMsg?.role === "assistant";
    if (siblings.length <= 1 && !canRegen) return;

    const controls = host.createDiv({ cls: "ggai-chat-tail-controls" });

    if (siblings.length > 1) {
      const idx = siblings.findIndex((n) => n.id === leafId);
      const prevBtn = controls.createEl("button", { cls: "clickable-icon" });
      setIcon(prevBtn, "chevron-left");
      prevBtn.disabled = idx <= 0;
      prevBtn.addEventListener("click", () => void this.swipeTo(siblings[idx - 1]));
      controls.createSpan({
        cls: "ggai-chat-swipe-count",
        text: `${idx + 1}/${siblings.length}`,
      });
      const nextBtn = controls.createEl("button", { cls: "clickable-icon" });
      setIcon(nextBtn, "chevron-right");
      nextBtn.disabled = idx >= siblings.length - 1;
      nextBtn.addEventListener("click", () => void this.swipeTo(siblings[idx + 1]));
    }

    if (canRegen) {
      const regenBtn = controls.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": "재생성" },
      });
      setIcon(regenBtn, "rotate-ccw");
      regenBtn.addEventListener("click", () => void this.regenerateLastAssistant());
    }

    // 그룹 챗 — [계속 진행]: 다음 캐릭터가 이어서 말한다 (자동 연쇄 재개, G2).
    if (this.isGroupChat()) {
      const contBtn = controls.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": "계속 진행 — 다음 캐릭터가 이어서 말함" },
      });
      setIcon(contBtn, "play");
      contBtn.addEventListener("click", () => void this.continueGroupRound());
    }
  }

  /**
   * 마지막 AI 메시지 재생성.
   *  - 리프가 그 메시지 노드면: 형제 분기 (기존 변형 보존, 스와이프로 오감).
   *  - 리프 뒤에 편집 노드가 붙어 있으면: **편집을 보존한 채** 마지막 AI 메시지
   *    구간만 delete+append 로 갈아끼운다 (수정 후 재생성 시 수정이 증발하는
   *    문제의 해법 — 컨텍스트에서는 그 메시지를 제외해 자기 답을 다시 보지 않게).
   */
  private async regenerateLastAssistant(): Promise<void> {
    if (!this.session || this.generation) return;
    await this.flushPendingEdits();
    const msgs = buildChatMessages(this.session);
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "assistant") return;

    // 그룹 챗 재생성 = 발화자부터 다시 판결 — 갈아끼울 메시지를 뺀 이력 기준으로
    // "누가 답할지"를 새로 정한다(지목 중이면 그 캐릭터). 그룹이 아니면 undefined.
    this.cancelAutoChain();
    const speakerId = this.chooseSpeaker(msgs.slice(0, -1));
    const leafId = this.session.meta.activeLeafId;
    if (last.nodeId === leafId) {
      const parent = this.session.nodes[leafId]?.parent;
      if (parent) await this.runGeneration(parent, "ai-regen", { speakerId });
      return;
    }
    // 마지막 AI 메시지 구간 시작 오프셋 (선행 구분자 포함해서 걷어낸다).
    const flatLen = spansToText(buildSpans(this.session)).length;
    await this.runGeneration(leafId, "ai-regen", {
      replaceFrom: flatLen - last.text.length,
      speakerId,
    });
  }

  private async swipeTo(sibling: SessionNode): Promise<void> {
    if (!this.session || !this.sessionFile || this.generation) return;
    this.cancelAutoChain();
    await this.flushPendingEdits();
    const target = getDeepestLatestDescendant(this.session, sibling.id);
    this.session.meta.activeLeafId = target?.id ?? sibling.id;
    await this.persistSession("스와이프 저장 실패");
    this.followTail = true; // 스와이프 결과(바뀐 마지막 메시지)가 보이게
    this.renderMessages();
  }

  // ── 말풍선 직접 편집 (EditGuard + user-edit 파생 노드) ────────────

  private makeBubbleEditable(bubble: HTMLElement): void {
    bubble.setAttr("contenteditable", "plaintext-only");
    // 클릭 좌표 기억 — raw 스왑 후 커서를 클릭 지점 근처로 복원한다.
    let lastPointer: { x: number; y: number } | null = null;
    bubble.addEventListener("pointerdown", (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    });
    // 편집 진입 — 매크로 표시본 대신 raw 텍스트로 스왑 (매크로 원문을 고치게).
    bubble.addEventListener("focus", () => {
      const idx = Number(bubble.dataset.index);
      const msg = this.messages[idx];
      if (!msg) return;
      const raw = this.displayTextOf(msg);
      if (bubble.textContent !== raw) {
        bubble.setText(raw);
        // 커서 복원 — 표시본→raw 스왑으로 클릭 지점을 잃지 않게, 같은 좌표의
        // 글자 위치에 caret 을 놓는다 (문구가 거의 같아 자연스럽게 맞는다).
        // 포커스된 말풍선 자신에 대한 조작이라 배경 Selection 개입 금지와 무관.
        const pt = lastPointer;
        if (pt && !isImeComposing()) {
          window.requestAnimationFrame(() => {
            if (document.activeElement !== bubble || isImeComposing()) return;
            placeCaretAtPoint(bubble, pt.x, pt.y);
          });
        }
      }
      lastPointer = null;
    });
    // Esc = 편집 취소 — 저장 예약을 버리고 원래 내용으로 되돌린 뒤 편집 종료.
    bubble.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.isComposing || this.guard.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.editCommitTimer != null) {
        window.clearTimeout(this.editCommitTimer);
        this.editCommitTimer = null;
      }
      if (this.pendingEditBubble === bubble) this.pendingEditBubble = null;
      const idx = Number(bubble.dataset.index);
      const msg = this.messages[idx];
      if (msg) bubble.setText(this.displayTextOf(msg));
      bubble.blur(); // blur 핸들러가 매크로 표시본으로 복귀시킨다
    });
    bubble.addEventListener("input", () => {
      if (this.guard.isComposing) return; // IME 조합 중 커밋 금지
      this.scheduleBubbleCommit(bubble);
    });
    bubble.addEventListener("compositionend", () => {
      // 조합 확정값 유실 방지 — 조합 끝에서 반드시 커밋 스케줄.
      this.scheduleBubbleCommit(bubble);
    });
    bubble.addEventListener("blur", () => {
      void (async () => {
        if (this.pendingEditBubble === bubble) await this.flushPendingEdits();
        if (this.renderPending) {
          // 편집 중 미뤄둔 재렌더/외부 변경 반영.
          await this.reloadFromStore();
          return;
        }
        // 편집 종료 — 매크로+표시 정규식 적용본(표기 반영)으로 복귀.
        const idx = Number(bubble.dataset.index);
        const msg = this.messages[idx];
        if (msg) {
          this.setBubbleDisplay(
            bubble,
            this.displayRegexText(this.macroText(this.displayTextOf(msg)), idx)
          );
        }
      })();
    });
  }

  // ── 번역 보기 직접 편집 (문단별 user-edit variant — 본문 불변) ────────
  //
  // 소설 번역 뷰와 같은 커밋 기계를 말풍선 단위로 축소한 것: 편집 진입(focus)
  // 시 말풍선을 "문단 스팬 + 원자 구분자(contenteditable=false)" 구조로 스왑해
  // caret 이 항상 문단 안에서만 움직이고, 바뀐 문단만 user-edit variant 로
  // translations.json 에 저장한다. 커밋 방어(회귀 금지): 내용 있던 문단 → 빈 값
  // 커밋 금지, 정규화로 떨어져 나간 스팬 무시.

  private makeTranslationBubbleEditable(bubble: HTMLElement): void {
    bubble.setAttr("contenteditable", "plaintext-only");
    let lastPointer: { x: number; y: number } | null = null;
    bubble.addEventListener("pointerdown", (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    });
    bubble.addEventListener("focus", () => {
      if (this.trEdit?.bubble === bubble) return;
      const idx = Number(bubble.dataset.index);
      const msg = this.messages[idx];
      if (!msg) return;
      this.beginTranslationBubbleEdit(bubble, this.displayTextOf(msg));
      const pt = lastPointer;
      lastPointer = null;
      if (pt && !isImeComposing()) {
        window.requestAnimationFrame(() => {
          if (document.activeElement !== bubble || isImeComposing()) return;
          placeCaretAtPoint(bubble, pt.x, pt.y);
        });
      }
    });
    bubble.addEventListener("input", () => {
      if (this.guard.isComposing) return; // IME 조합 중 커밋 금지
      this.scheduleTranslationBubbleCommit();
    });
    bubble.addEventListener("compositionend", () => {
      this.scheduleTranslationBubbleCommit();
    });
    // Esc = 편집 취소 — 미커밋 편집을 버리고 표시본으로 복귀.
    bubble.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.isComposing || this.guard.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      const st = this.trEdit;
      if (st?.bubble === bubble) {
        if (st.timer != null) window.clearTimeout(st.timer);
        this.trEdit = null;
      }
      this.restoreTranslationBubbleDisplay(bubble);
      bubble.blur();
    });
    bubble.addEventListener("blur", () => {
      void this.endTranslationBubbleEdit(bubble);
    });
  }

  /** 편집 진입 — 표시본을 "문단 스팬 + 원자 구분자" raw 구조로 스왑. */
  private beginTranslationBubbleEdit(bubble: HTMLElement, sourceText: string): void {
    bubble.empty();
    const blocks: {
      hash: string;
      source: string;
      baseline: string;
      el: HTMLElement;
    }[] = [];
    for (const token of tokenizeParagraphs(sourceText)) {
      if (token.kind === "separator") {
        const sep = bubble.createSpan({ cls: "ggai-chat-tr-sep" });
        sep.setAttr("contenteditable", "false");
        sep.setText(token.text);
        continue;
      }
      const active = this.translations
        ? getActiveTranslation(this.translations, token.hash)
        : null;
      // 빈(공백뿐인) 번역은 없는 것으로 취급 — 원문을 편집 대상으로 보여준다.
      const baseline =
        active && active.text.trim() !== "" ? active.text : token.source;
      const span = bubble.createSpan({
        cls: "ggai-chat-tr-para",
        attr: { "data-paragraph-hash": token.hash },
      });
      span.setText(baseline);
      blocks.push({ hash: token.hash, source: token.source, baseline, el: span });
    }
    this.trEdit = { bubble, blocks, timer: null };
  }

  private scheduleTranslationBubbleCommit(): void {
    const st = this.trEdit;
    if (!st) return;
    if (st.timer != null) window.clearTimeout(st.timer);
    st.timer = window.setTimeout(() => {
      if (this.trEdit === st) st.timer = null;
      void this.commitTranslationBubbleEdit();
    }, EDIT_COMMIT_DEBOUNCE_MS);
  }

  /** 바뀐 문단만 user-edit variant 로 기록 + 저장 (변경 없으면 no-op). */
  private async commitTranslationBubbleEdit(): Promise<void> {
    const st = this.trEdit;
    if (!st || !this.sessionFile || !this.translations) return;
    let changed = false;
    for (const b of st.blocks) {
      // 편집 영역에서 떨어져 나간 스팬(브라우저 정규화)은 읽지 않는다.
      if (!st.bubble.contains(b.el)) continue;
      const text = b.el.textContent ?? "";
      if (text === b.baseline) continue;
      // 내용 있던 문단 → 빈 값은 정규화 아티팩트로 보고 저장하지 않는다.
      if (text.trim() === "" && b.baseline.trim() !== "") continue;
      recordTranslationVariant(this.translations, {
        source: b.source,
        text,
        kind: "user-edit",
      });
      b.baseline = text;
      changed = true;
    }
    if (!changed) return;
    await this.store.saveSessionTranslations(this.sessionFile, this.translations, {
      origin: this.storeOrigin,
    });
  }

  /** 편집 종료(blur/flush) — 커밋 후 표시본으로 복귀. */
  private async endTranslationBubbleEdit(bubble: HTMLElement): Promise<void> {
    const st = this.trEdit;
    if (!st || st.bubble !== bubble) return;
    if (st.timer != null) {
      window.clearTimeout(st.timer);
      st.timer = null;
    }
    await this.commitTranslationBubbleEdit();
    this.trEdit = null;
    if (this.renderPending) {
      // 편집 중 미뤄둔 외부 변경 반영.
      await this.reloadFromStore();
      return;
    }
    this.restoreTranslationBubbleDisplay(bubble);
  }

  /** 말풍선을 번역 표시본(표기 반영)으로 되돌린다. */
  private restoreTranslationBubbleDisplay(bubble: HTMLElement): void {
    const idx = Number(bubble.dataset.index);
    const msg = this.messages[idx];
    if (!msg) return;
    this.setBubbleDisplay(
      bubble,
      this.displayRegexText(
        this.macroText(this.translatedTextOf(this.displayTextOf(msg))),
        idx
      )
    );
  }

  private scheduleBubbleCommit(bubble: HTMLElement): void {
    this.pendingEditBubble = bubble;
    if (this.editCommitTimer != null) window.clearTimeout(this.editCommitTimer);
    this.editCommitTimer = window.setTimeout(() => {
      this.editCommitTimer = null;
      const target = this.pendingEditBubble;
      this.pendingEditBubble = null;
      if (target) void this.commitBubbleEdit(target);
    }, EDIT_COMMIT_DEBOUNCE_MS);
  }

  private async commitBubbleEdit(bubble: HTMLElement): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    const index = Number(bubble.dataset.index);
    if (!Number.isFinite(index)) return;

    // 커밋 직전 세션 기준으로 오프셋 재계산 (스테일 캐시 방지).
    const fresh = buildChatMessages(this.session);
    const msg = fresh[index];
    if (!msg) return;

    const newText = bubble.textContent ?? "";
    const oldDisplay = this.displayTextOf(msg);
    if (newText === oldDisplay) return;
    // 커밋 방어 — 내용 있던 말풍선이 통째로 빈 값이 되는 커밋은 하지 않는다
    // (브라우저 정규화/전체선택 삭제로 메시지가 증발하는 회귀 방지).
    if (newText.trim() === "" && oldDisplay.trim() !== "") {
      bubble.setText(oldDisplay);
      return;
    }

    // 평탄화 본문에서 이 메시지의 표시 구간 [from, to) 계산.
    let start = 0;
    for (let i = 0; i < index; i++) start += fresh[i].text.length;
    const sepLen = msg.text.startsWith(CHAT_MESSAGE_SEPARATOR)
      ? CHAT_MESSAGE_SEPARATOR.length
      : 0;
    const from = start + sepLen;
    const to = start + msg.text.length;

    // 원문 불변 검증 — 구간 원문이 기대와 다르면 커밋하지 않는다.
    const flat = spansToText(buildSpans(this.session));
    if (flat.slice(from, to) !== oldDisplay) {
      this.renderMessages();
      return;
    }

    const node: SessionNode = {
      id: uuidv4(),
      parent: this.session.meta.activeLeafId,
      kind: "user-edit",
      patches: [
        { op: "replace", from, to, spans: [{ author: "user", text: newText }] },
      ],
      createdAt: Date.now(),
    };
    this.session.nodes[node.id] = node;
    this.session.meta.activeLeafId = node.id;
    this.redoStack = [];
    this.messages = buildChatMessages(this.session);
    await this.guard.runSave(() => this.persistSession("메시지 편집 저장 실패"));
    // 말풍선 내용은 이미 사용자가 친 그대로 — 재렌더 없이 캐시만 갱신됐다.
  }

  // ── 전송 / 생성 ──────────────────────────────────────────────────

  private async handleSend(): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    if (this.generation) {
      this.generation.abort.abort();
      return;
    }
    this.cancelAutoChain();
    await this.flushPendingEdits();

    const text = this.inputEl?.value.trim() ?? "";
    if (text) {
      const flatLen = spansToText(buildSpans(this.session)).length;
      const node: SessionNode = {
        id: uuidv4(),
        parent: this.session.meta.activeLeafId,
        kind: "user-write",
        patches: [
          {
            op: "append",
            spans: [
              {
                author: "user",
                text: (flatLen > 0 ? CHAT_MESSAGE_SEPARATOR : "") + text,
              },
            ],
          },
        ],
        createdAt: Date.now(),
      };
      this.session.nodes[node.id] = node;
      this.session.meta.activeLeafId = node.id;
      this.redoStack = [];
      if (this.inputEl) {
        this.inputEl.value = "";
        this.autosizeInput();
      }
      await this.persistSession("메시지 저장 실패");
      this.followTail = true;
      this.renderMessages();
    }

    // 그룹 챗 — 발화자 결정(지목 > 이름 불림 > 가중 랜덤) + 자동 연쇄 라운드 시작.
    // 지목(핀) 중이면 그 캐릭터 1명만 답한다 (연쇄 없음).
    if (this.isGroupChat() && !this.pinnedSpeakerId) {
      this.autoChainRemaining = this.maxAutoReplies() - 1;
    }
    await this.runGeneration(this.session.meta.activeLeafId, "ai-continue", {
      speakerId: this.chooseSpeakerForNext(),
      chain: true,
    });
  }

  private async runGeneration(
    parentId: string,
    kind: "ai-continue" | "ai-regen",
    opts?: {
      /**
       * 수정 보존 갈아끼우기 — 부모 본문의 이 오프셋부터 끝(=마지막 AI 메시지
       * 구간)을 지우고 새 메시지를 붙인다. 컨텍스트에서도 그 메시지를 제외.
       */
      replaceFrom?: number;
      /** 그룹 챗 발화자 (멤버 시나리오 stella.id) — 노드 귀속 + 전송본 반영. */
      speakerId?: string;
      /** 그룹 챗 자동 연쇄의 한 스텝 — 성공 시 다음 발화자를 예약한다. */
      chain?: boolean;
    }
  ): Promise<void> {
    if (!this.session || !this.sessionFile || this.generation) return;
    this.exitParaSelectMode();
    if (!this.ai.isAvailable()) {
      new Notice("GGAI Core 가 활성화되어 있지 않습니다.");
      return;
    }

    const sessionFile = this.sessionFile;
    const plan = await planSessionRequest(this.plugin, sessionFile, {
      leafId: parentId,
      excludeTailAssistant: opts?.replaceFrom != null,
      speakerId: opts?.speakerId,
    });
    if ("error" in plan) {
      new Notice(plan.error);
      return;
    }
    const profile = plan.profile;
    const payload = plan.payload;
    this.session.meta.variables = plan.updatedVariables;
    this.session.meta.timingStates = plan.output.updatedTimingStates;

    const parentSpans = buildSpans(this.session, parentId);
    const parentFullText = spansToText(parentSpans);
    // 갈아끼우기면 "지운 뒤" 길이 기준으로 구분자/후처리 기준 텍스트를 잡는다.
    const baseLen = Math.min(
      opts?.replaceFrom ?? parentFullText.length,
      parentFullText.length
    );
    const parentText = parentFullText.slice(0, baseLen);
    const sep = baseLen > 0 ? CHAT_MESSAGE_SEPARATOR : "";

    // 빈 응답으로 무산되면 원래 보던 리프로 복귀 (재생성 변형 선택 보존).
    const prevLeafId = this.session.meta.activeLeafId;
    const nodeId = uuidv4();
    const appendPatch = {
      op: "append" as const,
      spans: [{ author: "ai" as const, text: sep }],
    };
    const patches: Patch[] =
      baseLen < parentFullText.length
        ? [{ op: "delete", from: baseLen, to: parentFullText.length }, appendPatch]
        : [appendPatch];
    const node: SessionNode = {
      id: nodeId,
      parent: parentId,
      kind,
      patches,
      createdAt: Date.now(),
      gen: { model: profile.model, tokensIn: 0, tokensOut: 0, profile: profile.name },
    };
    // 그룹 챗 — 이 메시지의 발화자 귀속 (라벨/재생성/다음 발화자 결정 재료).
    if (this.isGroupChat() && opts?.speakerId && this.memberOf(opts.speakerId)) {
      node.speaker = opts.speakerId;
    }
    this.session.nodes[nodeId] = node;
    this.session.meta.activeLeafId = nodeId;
    this.redoStack = [];

    const abort = new AbortController();
    this.generation = { nodeId, abort, accumulatedText: "" };
    this.followTail = true;
    this.renderMessages();
    this.updateSendButton();

    let usage = { inputTokens: 0, outputTokens: 0 };
    let aborted = false;

    const applyText = (text: string): void => {
      const gen = this.generation;
      if (!gen) return;
      gen.accumulatedText = text;
      if (appendPatch.spans[0]) {
        appendPatch.spans[0].text = sep + text;
      }
      this.paintStreamBubble(text);
    };

    try {
      if (payload.kind === "text") {
        const r = await this.ai.generate({
          profileId: profile.id,
          prompt: payload.prompt,
          paramsOverride: plan.paramsOverride,
          signal: abort.signal,
          label: "대화",
        });
        // 이름 턴 전송본이면 유저 턴 절단 + 캐릭터 라벨 제거 (ST 스탑 스트링 대응).
        const text = payload.chatNames
          ? trimChatCompletionOutput(r.text ?? "", payload.chatNames)
          : r.text ?? "";
        applyText(text);
        usage = r.usage;
      } else {
        for await (const event of this.ai.chatStream({
          profileId: profile.id,
          messages: payload.messages,
          paramsOverride: plan.paramsOverride,
          signal: abort.signal,
          label: "대화",
        })) {
          if (event.type === "text-delta") {
            const gen = this.generation;
            if (!gen) break;
            applyText(gen.accumulatedText + event.delta);
          } else if (event.type === "done") {
            usage = event.response.usage;
            const doneText = event.response.text ?? "";
            if (doneText && (this.generation?.accumulatedText ?? "") === "") {
              applyText(doneText);
            }
          } else if (event.type === "error") {
            const streamErr: any = new Error(event.error.message);
            streamErr.code = event.error.code;
            throw streamErr;
          }
        }
      }
    } catch (err: any) {
      if (err?.code === "cancelled" || abort.signal.aborted) {
        aborted = true;
      } else {
        new Notice("생성 실패: " + (err?.message ?? String(err)));
      }
    } finally {
      // 그룹 챗 (챗 컴플리션): 다른 멤버/유저 턴 절단 + 발화자 라벨 제거 —
      // 스트리밍이 끝난 뒤 한 번 적용한다 (텍스트 컴플리션은 위에서 이미 처리).
      if (payload.kind === "chat" && payload.names) {
        const raw = this.generation?.accumulatedText ?? "";
        if (raw) {
          applyText(
            trimChatCompletionOutput(raw, payload.names, {
              dropIncompleteTail: false,
            })
          );
        }
      }
      let generatedText = this.generation?.accumulatedText ?? "";
      // 저장 원문(raw) 시점 정규식 — 저장 전에 치환 (전송본/표시 시점은 안 돎).
      if (generatedText.trim()) {
        const regexed = await applyRawRegexToGeneration(
          this.plugin,
          sessionFile,
          generatedText
        );
        if (regexed !== generatedText) {
          generatedText = regexed;
          if (appendPatch.spans[0]) {
            appendPatch.spans[0].text = sep + regexed;
          }
        }
      }
      if (node.gen) {
        node.gen.tokensIn = usage.inputTokens;
        node.gen.tokensOut = usage.outputTokens;
      }
      const blank = generatedText.trim().length === 0;
      if (blank) {
        // 빈 응답/무산 — 노드를 남기지 않고 원래 보던 리프로 복귀.
        delete this.session.nodes[nodeId];
        if (this.session.meta.activeLeafId === nodeId) {
          this.session.meta.activeLeafId = this.session.nodes[prevLeafId]
            ? prevLeafId
            : parentId;
        }
        if (!aborted) new Notice("AI 응답이 비어 있어 저장하지 않았습니다.");
      }
      this.generation = null;
      await this.persistSession(
        aborted ? "부분 생성 저장 실패" : "생성 결과 저장 실패",
        true
      );
      this.renderMessages();
      this.updateSendButton();

      if (!blank && !aborted) {
        // 확장 생성-완료 훅 — 번역/삽화/요약 확장이 각자 자동 실행을 판정한다
        // (서로 독립, 레지스트리가 병렬 실행). 결과는 store 이벤트로 이 뷰에 반영.
        await this.plugin.extensions.runGenerationComplete({
          sessionFile,
          nodeId,
          generatedText,
          parentText,
          profile,
        });
        // 그룹 챗 자동 연쇄 — 이 스텝이 성공했으면 다음 발화자를 예약한다.
        if (opts?.chain) this.scheduleAutoChain();
      }
    }
  }

  /** 스트리밍 텍스트 반영 — IME 조합 중에는 화면 갱신을 조합 종료 뒤로 미룬다. */
  private paintStreamBubble(text: string): void {
    const bubble = this.streamBubbleEl;
    if (!bubble) return;
    if (isImeComposing()) {
      if (this.streamPaintQueued) return;
      this.streamPaintQueued = true;
      runWhenImeIdle(() => {
        this.streamPaintQueued = false;
        const gen = this.generation;
        if (gen && this.streamBubbleEl) {
          this.streamBubbleEl.setText(gen.accumulatedText);
          this.scrollTailIfFollowing();
        }
      });
      return;
    }
    bubble.setText(text);
    this.scrollTailIfFollowing();
  }

  // ── 저장/보조 ────────────────────────────────────────────────────

  private async persistSession(errorPrefix: string, silent = false): Promise<void> {
    if (!this.session || !this.sessionFile) return;
    try {
      await this.store.saveSession(this.sessionFile, this.session, {
        origin: this.storeOrigin,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (silent) console.warn("[GGAI Stella] " + errorPrefix + ":", err);
      else new Notice(errorPrefix + ": " + msg);
    }
  }

  private updateSendButton(): void {
    const btn = this.sendBtn;
    if (!btn) return;
    btn.empty();
    setIcon(btn, this.generation ? "square" : "send");
    btn.toggleClass("is-generating", this.generation != null);
    btn.setAttr("aria-label", this.generation ? "생성 중단" : "전송");
  }

  private autosizeInput(): void {
    const ta = this.inputEl;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }

  private scrollToBottom(): void {
    const el = this.messagesEl;
    if (el) el.scrollTop = el.scrollHeight;
  }

  private scrollTailIfFollowing(): void {
    if (this.followTail) this.scrollToBottom();
  }
}

/** 현실 시각을 "년-월-일" 로컬 날짜 키로 — 날짜 구분선 경계 판정용. */
function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** 날짜 구분선 라벨 — 오늘/어제는 말로, 그 외는 "M월 D일 (요일)" (다른 해면 연도). */
function formatDateDivider(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const key = dayKeyOf(ts);
  if (key === dayKeyOf(now.getTime())) return "오늘";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKeyOf(yesterday.getTime())) return "어제";
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  const md = `${d.getMonth() + 1}월 ${d.getDate()}일 (${weekday})`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}년 ${md}`;
}

/** 좌표의 글자 위치에 caret 배치 — 편집 진입 시 클릭 지점 복원용 (포커스된 요소 전용). */
function placeCaretAtPoint(el: HTMLElement, x: number, y: number): void {
  const doc = el.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const range = doc.caretRangeFromPoint?.(x, y) ?? null;
  if (!range || !el.contains(range.startContainer)) return;
  const sel = doc.defaultView?.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * <p> 블록 안에서 클릭한 줄 순번 — 클릭 지점 앞에 있는 <br> 개수.
 * 단일 줄바꿈은 <br> 로 그려지므로, 줄 = tokenizeParagraphs 의 문단 단위와 같다.
 */
function lineIndexInBlock(block: HTMLElement, e: MouseEvent): number {
  const doc = block.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const range = doc.caretRangeFromPoint?.(e.clientX, e.clientY) ?? null;
  const node =
    range && block.contains(range.startContainer) ? range.startContainer : null;
  if (!node) return 0;
  let line = 0;
  const walker = doc.createTreeWalker(block, NodeFilter.SHOW_ALL);
  let cur: Node | null;
  while ((cur = walker.nextNode())) {
    if (cur === node || (cur instanceof Element && cur.contains(node))) {
      return line;
    }
    if (cur.nodeName === "BR") line++;
  }
  return line;
}

/** `.../SESSIONS/<세션>/session.json` → 시나리오 폴더의 scenario.json 경로. */
function scenarioFileOfSessionFile(sessionFile: string): string | null {
  const parts = sessionFile.split("/");
  if (parts.length < 6 || parts[parts.length - 3] !== "SESSIONS") return null;
  return parts.slice(0, -3).join("/") + "/scenario.json";
}
