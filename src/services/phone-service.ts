/**
 * PhoneService — 스텔라 폰 실행기 (PH1 문자 + PH2 갱신 트리거/엑스트라).
 *
 * 세션과 별개의 "폰 속 문자 대화"를 담당한다. 답장 생성은 세션 전송본 경로
 * (planSessionRequest)를 타지 않는다 — 문자는 세션이 아니라 폰에서 일어나는
 * 일이고, 재료(카드 + 문자 이력 + 현재 세션 첨부)가 다르다. 대신 지시문으로
 * "문자에 적힌 것 + 실제 경험만 안다"를 강제한다 (스텔라폰 스펙.md 원칙 1~3).
 *
 * 갱신(PH2) = 캐릭터/엑스트라가 먼저 문자를 보내는 기회. 트리거 4종(폰 열기/
 * 세션 중 랜덤/정기/키워드)이 refresh() 를 부르고, refresh 는 전역 스로틀과
 * 미응답 상한 안에서 1회 1통만 만든다 (버스트 방지 — 선채팅과 같은 태도).
 *
 * 규약: 저장은 전부 store 경유, AI 호출은 전부 plugin.ai 경유. 문자는 세션
 * 노드/본문을 절대 만들거나 수정하지 않는다.
 */
import { Notice } from "obsidian";
import { BASE_FOLDER } from "../constants";
import type StellaEnginePlugin from "../main";
import type {
  GenerationProfileLite,
  ImageProfileLite,
  ChatMessage,
} from "./ai-service";
import {
  clampIssueScale,
  snsAuthorKey,
  type PhoneAccountsFile,
  type PhoneMessage,
  type PhoneMessagesFile,
  type PhoneThread,
  type SessionStreamFile,
  type SnsAccount,
  type SnsAuthor,
  type SnsFeedFile,
  type SnsPost,
  type StreamChatItem,
  type StreamNodeReaction,
} from "../types/phone";
import type { StellaUserProfile } from "../types/user";
import { applyMacros } from "../util/macros";
import { resolveMediaPrompt } from "../util/default-media-prompts";
import {
  PHONE_SNS_HEADER,
  PHONE_TUBE_HEADER,
  buildSnsIoInstructions,
  buildPhoneTextIoInstructions,
  buildTubeIoInstructions,
} from "../util/phone-prompts";
import { listPhoneContacts, type PhoneContact } from "../util/phone-contacts";
import { buildSpans, pathToLeaf, spansToText } from "../util/session-text";
import { composeInheritedSummary } from "../util/summarize-session";
import { resolveActiveLorebooks } from "../util/resolve-active-lorebooks";
import { matchLorebookEntries, type MatchedLorebookEntry } from "../util/lorebook-match";
import type { StellaLorebook } from "../types/lorebook";
import type { StellaScenario } from "../types/scenario";
import { uuidv4 } from "../util/uuid";
import { getSessionHostLeaves, isSessionHostView } from "../views/session-host";

export type PhoneSendResult =
  | {
      ok: true;
      /** 시간차 배달 시 첫 답장의 도착 예정 시각 (즉시/읽씹이면 없음). */
      firstDeliverAt?: number;
    }
  | { ok: false; error: string };

/** 문자 대상 — 시나리오 캐릭터 스레드 또는 엑스트라(모르는 번호) 스레드. */
export type PhoneSendTarget =
  | { kind: "scenario"; scenarioId: string }
  | { kind: "extra"; threadId: string };

/** 답장 컨텍스트에 넣는 문자 이력 상한 기본값 (설정 `replyHistoryLimit`). */
const REPLY_HISTORY_LIMIT = 60;
/** 현재 세션 첨부 시 본문 꼬리 토큰 기본값 (설정 `sessionTailTokens`, v2). */
const SESSION_TAIL_TOKENS = 2000;

/**
 * SNS 재료 v2 (§6.5) — 확정 참가자(시나리오=인물) 몇 명을 뽑아 각자의 최근
 * 세션 요약+본문+활성 로어북을 첨부한다. 전부 설정으로 조절.
 */
const SNS_CONFIRMED_COUNT = 3;
const SNS_SUMMARY_TOKENS = 2000;
const SNS_BODY_TOKENS = 2000;
/** 랜덤 세션 (설정 켬 시) — 개수 고정, 항목 토큰은 확정값의 50%. */
const SNS_RANDOM_SESSION_COUNT = 2;
/** 프롬프트에 보여주는 최근 피드 발췌 수 (등급 내림차순 → 최신순). */
const SNS_FEED_EXCERPT = 20;
/** 같은 최상단 이슈가 유지될 수 있는 최대 배치 수 (§6.4 — 이후 강제 교체). */
const SNS_BOOM_MAX_TURNS = 10;
/** 반응 없는 배치가 이만큼 이어지면 최상단 이슈가 식어 은퇴한다 (§6.4). */
const SNS_BOOM_QUIET_RETIRE = 2;
/** 네트워크에 올리는 총 인원(확정 + 로스터 참고) — 로스터 = 총원 − 확정. */
const SNS_WORLD_ROSTER = 10;
/** 로스터 세계 1개 레퍼런스(설명 + 로어북 전체) 토큰 상한. */
const SNS_WORLD_REF_TOKENS = 1400;
/** 뷰어(페르소나) 목록에 넣는 1인 설명 토큰 상한. */
const SNS_VIEWER_DESC_TOKENS = 120;
/** 밀린 답장 판정 — 내 문자가 마지막인 채 이만큼 방치되면 갱신 틱이 답장을 재시도. */
const BACKLOG_REPLY_MS = 30 * 60_000;
/** 한 번의 답장을 빈 줄 기준으로 쪼갤 때의 말풍선 상한. */
const REPLY_BUBBLE_LIMIT = 4;

/** 스케줄러 틱 주기. */
const TICK_MS = 60_000;
/** 갱신 전역 스로틀 — 트리거가 겹쳐도 이 간격 안엔 1회만. */
const REFRESH_MIN_GAP_MS = 5 * 60_000;
/** 캐릭터가 먼저 문자할 수 있는 최소 침묵 시간 (스레드 마지막 문자 이후). */
const INITIATE_SILENCE_MS = 3 * 3_600_000;
/** 세션 중 랜덤 트리거 간격 (5~30분). */
const RANDOM_RANGE_MS: [number, number] = [5 * 60_000, 30 * 60_000];
/** 갱신 시 엑스트라(모르는 번호) 문자가 뽑힐 확률 (세션이 열려 있을 때만). */
const EXTRA_CHANCE = 0.2;
/** 같은 엑스트라 스레드로 이어 보내는 시간 창 — 지나면 새 "모르는 번호". */
const EXTRA_THREAD_REUSE_MS = 24 * 3_600_000;

export class PhoneService {
  /** 스레드별 실행 중 가드 — 같은 스레드에 생성이 겹치지 않게. */
  private inFlight = new Set<string>();
  /** 갱신 실행 중 가드 + 마지막 갱신 시각 (전역 스로틀). */
  private refreshBusy = false;
  private lastRefreshAt = 0;
  /** 스케줄러 다음 기회 (in-memory — 옵시디언이 켜져 있을 때만 도는 트리거들). */
  private periodicNextAt: number | null = null;
  private randomNextAt: number | null = null;

  constructor(private plugin: StellaEnginePlugin) {}

  // ─────────────────────────── 로그인/모델/연락처 ───────────────────────────

  /**
   * 폰 로그인 페르소나 — 전역 활성 페르소나와 독립 (폰 안에서만 유효).
   * 지정이 없거나 파일이 사라졌으면 전역 활성 페르소나로 폴백.
   */
  async getLoginPersona(): Promise<{
    userFile: string;
    profile: StellaUserProfile;
  }> {
    const configured = this.plugin.data.phone?.loginPersonaFile;
    if (configured) {
      const profile = await this.plugin.store.getUserProfile(configured);
      if (profile) return { userFile: configured, profile };
    }
    return this.plugin.resolveActiveUserProfile();
  }

  /** 폰 로그인 전환 — 전역 활성 페르소나·세션 기억은 절대 건드리지 않는다. */
  async setLoginPersona(userFile: string): Promise<void> {
    await this.plugin.savePluginData({
      phone: { ...(this.plugin.data.phone ?? {}), loginPersonaFile: userFile },
    });
    this.plugin.store.trigger("phone-login-changed");
  }

  /** 폰 생성 모델 — 폰 전용 프로필(챗만 유효), 없으면 기본 챗 프로필. */
  resolvePhoneProfile(): GenerationProfileLite | null {
    const id = this.plugin.data.phone?.modelProfileId;
    const configured = id ? this.plugin.ai.getProfileById(id) : null;
    if (configured && configured.kind === "chat") return configured;
    return this.plugin.ai.getDefaultChatProfile();
  }

  /**
   * 로그인 페르소나의 연락처 — 세션을 함께 한 시나리오 중 **등록된** 것만
   * (1회 필터). 등록되지 않은 캐릭터는 문자 목록에도, 선발신 대상에도 안 뜬다.
   */
  async listContacts(
    personaFile: string,
    personaId: string
  ): Promise<PhoneContact[]> {
    const all = await listPhoneContacts(this.plugin.store, personaFile);
    const data = await this.plugin.store.getPhoneMessages(personaId);
    const registered = effectiveRegisteredIds(data);
    return all.filter((c) => registered.has(c.scenarioId));
  }

  /** 연락처 등록 후보 — 세션을 함께 했지만 아직 등록하지 않은 시나리오. */
  async listContactCandidates(
    personaFile: string,
    personaId: string
  ): Promise<PhoneContact[]> {
    const all = await listPhoneContacts(this.plugin.store, personaFile);
    const data = await this.plugin.store.getPhoneMessages(personaId);
    const registered = effectiveRegisteredIds(data);
    return all.filter((c) => !registered.has(c.scenarioId));
  }

  /** 연락처 등록 — 이후 문자 목록/선발신 대상이 된다. */
  async registerContact(personaId: string, scenarioId: string): Promise<void> {
    const store = this.plugin.store;
    const data = await store.getPhoneMessages(personaId);
    const registered = effectiveRegisteredIds(data);
    if (registered.has(scenarioId)) return;
    registered.add(scenarioId);
    data.contacts = [...registered];
    await store.savePhoneMessages(personaId, data);
  }

  /** 연락처 해제 — 등록을 지우고 그 스레드(대화 이력)도 함께 삭제한다. */
  async unregisterContact(personaId: string, scenarioId: string): Promise<void> {
    const store = this.plugin.store;
    const data = await store.getPhoneMessages(personaId);
    const registered = effectiveRegisteredIds(data);
    registered.delete(scenarioId);
    data.contacts = [...registered];
    data.threads = data.threads.filter(
      (t) => !(t.kind === "scenario" && t.scenarioId === scenarioId)
    );
    await store.savePhoneMessages(personaId, data);
  }

  /** 폰 이미지 모델 (PH5) — 지정 프로필, 없으면 기본 이미지 프로필. 없으면 null. */
  resolveImageProfile(): ImageProfileLite | null {
    const list = this.plugin.ai.listImageProfiles();
    const id = this.plugin.data.phone?.imageProfileId;
    const configured = id ? list.find((p) => p.id === id) : null;
    return configured ?? list.find((p) => p.isDefault) ?? list[0] ?? null;
  }

  // ─────────────────────────── 카메라/갤러리 (PH5) ───────────────────────────

  /**
   * 카메라 촬영 — 입력 텍스트로 이미지 생성 → PHONE/assets 저장 + 폰 갤러리 등록.
   * 기본 모드 = 입력을 장면 묘사(본문)로 보고 삽화 프롬프트 생성 LLM 을 거친다
   * (전역 삽화 설정의 모델/프롬프트/로어북 재사용). direct = 입력을 이미지
   * 프롬프트로 그대로 전달. 캡션 = 장면 묘사 + 생성된 이미지 프롬프트 병기
   * (실제 찍힌 인물·상황 정보 보강 — v2 §5 출처 A).
   */
  async captureImage(
    prompt: string,
    opts?: { direct?: boolean }
  ): Promise<PhoneSendResult> {
    const p = prompt.trim();
    if (!p) return { ok: false, error: "내용을 입력하세요." };
    if (!this.plugin.ai.isAvailable()) {
      return { ok: false, error: "GGAI Core 가 활성화되어 있지 않습니다." };
    }
    const profile = this.resolveImageProfile();
    if (!profile) {
      return { ok: false, error: "Core 이미지 프로필이 없습니다." };
    }
    let imagePrompt = p;
    if (opts?.direct !== true) {
      const gen = await this.plugin.illustration.generatePromptFromText(p);
      if (!gen.ok) return { ok: false, error: gen.error };
      imagePrompt = gen.prompt;
    }
    // 캡션 = 장면 묘사 + 실제 생성 프롬프트 (v2 §5 출처 A) — 묘사만으로는
    // 사진에 실제로 뭐가 찍혔는지(인물·구도) 정보가 부족하다.
    const caption =
      imagePrompt !== p ? `${p}\n[image prompt] ${imagePrompt}` : p;
    let data: string | undefined;
    try {
      const res = await this.plugin.ai.image({
        profileId: profile.id,
        prompt: imagePrompt,
        label: "스텔라 폰 카메라",
      });
      data = res.images[0]?.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `촬영 실패: ${msg}` };
    }
    if (!data) return { ok: false, error: "이미지 응답이 비어 있습니다." };
    const file = await this.plugin.store.savePhoneAsset(
      `camera-${Date.now()}.png`,
      base64ToArrayBuffer(data)
    );
    await this.addGalleryItem({ file, caption, source: "camera" });
    return { ok: true };
  }

  private async addGalleryItem(item: {
    file: string;
    caption: string;
    source: "camera" | "upload" | "sns";
  }): Promise<void> {
    const store = this.plugin.store;
    const gallery = await store.getPhoneGallery();
    gallery.items.push({
      id: uuidv4(),
      file: item.file,
      caption: item.caption,
      source: item.source,
      createdAt: Date.now(),
    });
    await store.savePhoneGallery(gallery);
  }

  /** 이 스레드에 지금 생성 중인지 (뷰의 "입력 중…" 표시용). */
  isReplying(personaId: string, targetKey: string): boolean {
    return this.inFlight.has(`${personaId}:${targetKey}`);
  }

  /** 대상 → 스레드 키 (inFlight/뷰 공용). */
  static targetKey(target: PhoneSendTarget): string {
    return target.kind === "scenario" ? target.scenarioId : target.threadId;
  }

  // ─────────────────────────── 보내기 (사용자 → 답장) ───────────────────────────

  /**
   * 문자 전송 → 상대 답장 생성까지 한 흐름.
   * 사용자 문자는 즉시 저장(이벤트로 화면 반영)되고, 답장은 생성이 끝나는 대로
   * 같은 스레드에 저장된다. 실패해도 사용자 문자는 남는다 (재시도 = 그냥 다시 전송).
   */
  async sendMessage(opts: {
    personaId: string;
    personaFile: string;
    target: PhoneSendTarget;
    text: string;
    /** 첨부 사진 — registerGallery 면 (새 업로드) 폰 갤러리에도 등록. */
    image?: { asset: string; caption: string; registerGallery?: boolean };
  }): Promise<PhoneSendResult> {
    const key = `${opts.personaId}:${PhoneService.targetKey(opts.target)}`;
    if (this.inFlight.has(key)) {
      return { ok: false, error: "이미 답장을 기다리는 중입니다." };
    }
    const text = opts.text.trim();
    if (!text && !opts.image) {
      return { ok: false, error: "보낼 내용이 없습니다." };
    }
    if (!this.plugin.ai.isAvailable()) {
      return { ok: false, error: "GGAI Core 가 활성화되어 있지 않습니다." };
    }
    const profile = this.resolvePhoneProfile();
    if (!profile) {
      return { ok: false, error: "사용 가능한 챗 모델 프로필이 없습니다." };
    }

    // 현재 세션 첨부 — 열려 있는 세션 중 "이 캐릭터 + 이 페르소나" 세션이 있으면
    // 그 장면이 함께 간다 (같이 있는데 문자하면 캐릭터가 그 상황을 안다).
    const attached =
      opts.target.kind === "scenario"
        ? await this.findAttachedSession(opts.target.scenarioId, opts.personaFile)
        : null;

    // 1) 사용자 문자 저장 (이벤트 → 폰 화면 즉시 반영).
    const store = this.plugin.store;
    const data = await store.getPhoneMessages(opts.personaId);
    const thread = resolveTargetThread(data, opts.target);
    if (!thread) return { ok: false, error: "스레드를 찾을 수 없습니다." };
    if (opts.image?.registerGallery) {
      await this.addGalleryItem({
        file: opts.image.asset,
        caption: opts.image.caption || firstLine(text) || "사진",
        source: "upload",
      });
    }
    thread.messages.push({
      id: uuidv4(),
      from: "persona",
      text,
      createdAt: Date.now(),
      ...(attached ? { sessionFile: attached.sessionFile } : {}),
      ...(opts.image
        ? {
            image: {
              asset: opts.image.asset,
              caption: opts.image.caption || firstLine(text) || "사진",
            },
          }
        : {}),
    });
    await store.savePhoneMessages(opts.personaId, data);

    // 2) 답장 생성.
    this.inFlight.add(key);
    this.plugin.store.trigger("phone-replying-changed", opts.personaId);
    try {
      const system =
        opts.target.kind === "scenario"
          ? await this.buildScenarioSystemPrompt({
              personaId: opts.personaId,
              personaFile: opts.personaFile,
              scenarioId: opts.target.scenarioId,
              attachedBodyTail: attached?.bodyTail,
              mode: "reply",
            })
          : await this.buildExtraSystemPrompt(opts.personaFile, null);
      if ("error" in system) return { ok: false, error: system.error };
      const result = await this.generateIntoThread({
        personaId: opts.personaId,
        target: opts.target,
        profile,
        system: system.text,
        stripPrefix: system.charName,
      });
      // 답장이 한참 뒤 도착하면 (시간차 배달) 사용자가 폰을 떠났을 수 있으니
      // 도착 시각에 알림을 예약한다.
      if (
        result.ok &&
        result.firstDeliverAt &&
        result.firstDeliverAt - Date.now() > 60_000
      ) {
        this.scheduleIncomingNotice(
          system.charName ?? "문자",
          result.firstDeliverAt
        );
      }
      return result;
    } finally {
      this.inFlight.delete(key);
      this.plugin.store.trigger("phone-replying-changed", opts.personaId);
    }
  }

  // ─────────────────────────── 갱신 (PH2 — 수신 문자) ───────────────────────────

  /**
   * 스케줄러 시작 — 플러그인 onload 에서 1회. 정기/세션 중 랜덤 트리거는
   * 옵시디언이 켜져 있을 때만 의미가 있으므로 in-memory 예약으로 충분하다
   * (재시작 캐치업 없음 — 선채팅과 달리 밀린 문자를 몰아 받지 않는다).
   * 방송(PH4) 라이브 상태 스냅샷도 여기서 구독한다 (세션 메뉴의 동기 판정용).
   */
  startScheduler(): void {
    this.plugin.registerInterval(
      window.setInterval(() => {
        void this.tick().catch((err) =>
          console.warn("[GGAI Stella] 폰 갱신 틱 실패:", err)
        );
      }, TICK_MS)
    );
    this.plugin.registerEvent(
      this.plugin.store.on("sns-feed-changed", () => {
        void this.recomputeLiveSessions().catch(() => {});
      })
    );
    // 스텔라튜브 방송 상태 스냅샷 (v2) — stream.json 변화에 동기 유지.
    this.plugin.registerEvent(
      this.plugin.store.on("session-stream-changed", () => {
        void this.recomputeTubeLiveSessions().catch(() => {});
      })
    );
    // 방송 중인 세션이 삭제되면 방송도 끝낸다.
    this.plugin.registerEvent(
      this.plugin.store.on("session-deleted", (file: string) => {
        if (this.isSessionLive(file)) {
          void this.endStream(file).catch(() => {});
        }
      })
    );
    void this.recomputeLiveSessions().catch(() => {});
    void this.recomputeTubeLiveSessions().catch(() => {});
  }

  private async tick(): Promise<void> {
    // 폰 확장이 꺼져 있으면 배경 갱신도 멈춘다(완전 비활성화).
    if (!this.plugin.isExtensionEnabled("stella:phone")) return;
    const t = this.plugin.data.phone?.triggers;
    const now = Date.now();

    // 정기 갱신.
    if (t?.periodic === true) {
      const gapMs = Math.max(5, t.periodicMinutes ?? 60) * 60_000;
      if (this.periodicNextAt === null) {
        this.periodicNextAt = now + gapMs;
      } else if (now >= this.periodicNextAt) {
        this.periodicNextAt = now + gapMs;
        await this.refresh("periodic");
      }
    } else {
      this.periodicNextAt = null;
    }

    // 세션 중 랜덤 — 세션 창이 열려 있는 동안만 시계가 돈다.
    if (t?.randomInSession === true) {
      const sessionOpen = getSessionHostLeaves(this.plugin.app.workspace).some(
        (leaf) => isSessionHostView(leaf.view) && leaf.view.getSessionFile()
      );
      if (!sessionOpen) {
        this.randomNextAt = null;
      } else if (this.randomNextAt === null) {
        this.randomNextAt = now + pickRange(RANDOM_RANGE_MS);
      } else if (now >= this.randomNextAt) {
        this.randomNextAt = now + pickRange(RANDOM_RANGE_MS);
        await this.refresh("random");
      }
    } else {
      this.randomNextAt = null;
    }
  }

  /**
   * 갱신 1회 — 캐릭터 또는 엑스트라가 먼저 보내는 문자 1통을 시도한다.
   * 트리거 게이트/전역 스로틀/미응답 상한을 전부 통과해야 실제로 생성한다.
   * 실패는 조용히 (자동 경로 — 사용자를 방해하지 않는다).
   */
  async refresh(reason: "open" | "periodic" | "random" | "keyword"): Promise<void> {
    const t = this.plugin.data.phone?.triggers;
    const enabled =
      reason === "open"
        ? t?.onOpen !== false
        : reason === "periodic"
          ? t?.periodic === true
          : reason === "random"
            ? t?.randomInSession === true
            : t?.keyword === true;
    if (!enabled) return;
    if (this.refreshBusy) return;
    const now = Date.now();
    if (now - this.lastRefreshAt < REFRESH_MIN_GAP_MS) return;
    if (!this.plugin.ai.isAvailable()) return;
    const profile = this.resolvePhoneProfile();
    if (!profile) return;

    this.refreshBusy = true;
    this.lastRefreshAt = now;
    try {
      const { userFile, profile: persona } = await this.getLoginPersona();
      await this.tryIncomingText(persona, userFile, profile);
      // 방송 화면 동기화 (PH4) — 라이브 방송의 본문을 그 세션 최근 장면으로 갱신.
      await this.syncLiveStreams();
      // SNS 활동 (PH3) — 상한 0 이면 자동 갱신 끔.
      if ((this.plugin.data.phone?.snsPerRefresh ?? 10) > 0) {
        await this.generateSnsActivity(persona, userFile, profile, {
          notify: true,
        });
      }
    } finally {
      this.refreshBusy = false;
    }
  }

  /**
   * 수동 새로고침 (§5) — 폰 새로고침 버튼. 스로틀·트리거 게이트를 건너뛰고
   * 지금 바로 SNS 새 글·댓글과 (방송 중이면) 시청자 채팅을 갱신한다. caps 와
   * busy 가드는 유지. 결과는 버튼 상태/알림용.
   */
  async manualRefresh(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.plugin.ai.isAvailable()) {
      return { ok: false, error: "GGAI Core 가 활성화되어 있지 않습니다." };
    }
    const profile = this.resolvePhoneProfile();
    if (!profile) return { ok: false, error: "챗 모델 프로필이 없습니다." };
    const { userFile, profile: persona } = await this.getLoginPersona();
    // SNS 새 글·댓글.
    if ((this.plugin.data.phone?.snsPerRefresh ?? 10) > 0) {
      await this.generateSnsActivity(persona, userFile, profile, {
        notify: false,
      }).catch((err) =>
        console.warn("[GGAI Stella] 수동 새로고침 SNS 실패:", err)
      );
    }
    // 진행 중 방송 — 지금 장면에 채팅을 더 받는다 (같은 노드 이어 붙이기).
    for (const f of [...this.tubeLiveSessions]) {
      await this.onSessionNodeGenerated(f, { force: true }).catch((err) =>
        console.warn("[GGAI Stella] 수동 새로고침 방송 실패:", err)
      );
    }
    return { ok: true };
  }

  /** 갱신의 문자 파트 — 캐릭터/엑스트라가 먼저 보내는 문자 1통 시도. */
  private async tryIncomingText(
    persona: StellaUserProfile,
    userFile: string,
    profile: GenerationProfileLite
  ): Promise<void> {
    const now = Date.now();
    const data = await this.plugin.store.getPhoneMessages(persona.id);

    // 미응답 상한 — 답장 안 한 수신 문자 스레드가 쌓여 있으면 쉰다.
    const cap = this.plugin.data.phone?.maxUnanswered ?? 2;
    if (cap > 0 && countUnansweredThreads(data) >= cap) return;

    const contacts = await this.listContacts(userFile, persona.id);

    // 밀린 답장 (v2 §3.2) — 읽씹(read:false)됐거나 답장이 오지 않은 채 남은
    // 스레드(내 문자가 마지막)를 우선 처리한다. 즉답과 구분되게 30분 이상
    // 방치된 것만.
    const backlog = contacts.filter((c) => {
      const thread = data.threads.find(
        (th) => th.kind === "scenario" && th.scenarioId === c.scenarioId
      );
      const last = thread?.messages[thread.messages.length - 1];
      return (
        !!last &&
        last.from === "persona" &&
        now - last.createdAt >= BACKLOG_REPLY_MS
      );
    });
    if (backlog.length > 0) {
      const picked = pickWeightedByRank(backlog);
      await this.sendBacklogReply(persona, userFile, profile, picked);
      return;
    }

    // 엑스트라(모르는 번호) — 세션이 열려 있을 때만, 낮은 확률로.
    const openSession = await this.findAnyOpenSessionOfPersona(userFile);
    if (openSession && Math.random() < EXTRA_CHANCE) {
      await this.sendExtraText(persona, userFile, profile, openSession.bodyTail);
      return;
    }

    // 캐릭터 발신 — **등록된 연락처만** 대상 (침묵이 충분히 긴/첫 스레드),
    // 최근 활동 가중 랜덤으로 1명.
    const eligible = contacts.filter((c) => {
      const thread = data.threads.find(
        (th) => th.kind === "scenario" && th.scenarioId === c.scenarioId
      );
      const last = thread?.messages[thread.messages.length - 1];
      if (!last) return true; // 첫 문자
      if (last.from === "other") {
        // 이어 보내기 (v2 §3.2) — 답 없는 스레드에도 낮은 확률로 한 번 더.
        // 연속 2통 상한, 침묵 조건 동일, 가중치는 코인 플립으로 절반.
        const msgs = thread!.messages;
        let trailing = 0;
        for (let i = msgs.length - 1; i >= 0 && msgs[i].from === "other"; i--) {
          trailing++;
        }
        if (trailing >= 2) return false;
        if (now - last.createdAt < INITIATE_SILENCE_MS) return false;
        return Math.random() < 0.5;
      }
      return now - last.createdAt >= INITIATE_SILENCE_MS;
    });
    if (eligible.length === 0) return;
    const picked = pickWeightedByRank(eligible);
    await this.sendCharacterInitiation(persona, userFile, profile, picked);
  }

  /**
   * 밀린 답장 (v2 §3.2) — 읽씹/미응답으로 남은 스레드에 답장을 다시 시도한다.
   * 재료·경로는 일반 답장(reply 모드)과 동일.
   */
  private async sendBacklogReply(
    persona: StellaUserProfile,
    personaFile: string,
    profile: GenerationProfileLite,
    contact: PhoneContact
  ): Promise<void> {
    const key = `${persona.id}:${contact.scenarioId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    this.plugin.store.trigger("phone-replying-changed", persona.id);
    try {
      const attached = await this.findAttachedSession(
        contact.scenarioId,
        personaFile
      );
      const system = await this.buildScenarioSystemPrompt({
        personaId: persona.id,
        personaFile,
        scenarioId: contact.scenarioId,
        attachedBodyTail: attached?.bodyTail,
        mode: "reply",
      });
      if ("error" in system) return;
      const result = await this.generateIntoThread({
        personaId: persona.id,
        target: { kind: "scenario", scenarioId: contact.scenarioId },
        profile,
        system: system.text,
        stripPrefix: system.charName,
      });
      if (result.ok) {
        this.scheduleIncomingNotice(contact.name, result.firstDeliverAt);
      }
    } finally {
      this.inFlight.delete(key);
      this.plugin.store.trigger("phone-replying-changed", persona.id);
    }
  }

  /** 캐릭터가 먼저 보내는 문자 1통. */
  private async sendCharacterInitiation(
    persona: StellaUserProfile,
    personaFile: string,
    profile: GenerationProfileLite,
    contact: PhoneContact
  ): Promise<void> {
    const key = `${persona.id}:${contact.scenarioId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    this.plugin.store.trigger("phone-replying-changed", persona.id);
    try {
      const attached = await this.findAttachedSession(
        contact.scenarioId,
        personaFile
      );
      const system = await this.buildScenarioSystemPrompt({
        personaId: persona.id,
        personaFile,
        scenarioId: contact.scenarioId,
        attachedBodyTail: attached?.bodyTail,
        mode: "initiate",
      });
      if ("error" in system) return;
      const result = await this.generateIntoThread({
        personaId: persona.id,
        target: { kind: "scenario", scenarioId: contact.scenarioId },
        profile,
        system: system.text,
        stripPrefix: system.charName,
      });
      if (result.ok) this.scheduleIncomingNotice(contact.name, result.firstDeliverAt);
    } finally {
      this.inFlight.delete(key);
      this.plugin.store.trigger("phone-replying-changed", persona.id);
    }
  }

  /** 엑스트라(모르는 번호) 문자 1통 — 현재 세션 분위기를 재료로. */
  private async sendExtraText(
    persona: StellaUserProfile,
    personaFile: string,
    profile: GenerationProfileLite,
    sceneTail: string
  ): Promise<void> {
    const store = this.plugin.store;
    const data = await store.getPhoneMessages(persona.id);
    // 최근 엑스트라 스레드가 살아 있으면 이어 보내고, 아니면 새 "모르는 번호".
    const now = Date.now();
    let thread = [...data.threads]
      .reverse()
      .find(
        (t) =>
          t.kind === "extra" &&
          now - (t.messages[t.messages.length - 1]?.createdAt ?? t.createdAt) <
            EXTRA_THREAD_REUSE_MS
      );
    if (!thread) {
      thread = {
        id: uuidv4(),
        kind: "extra",
        extraName: "알 수 없는 번호",
        messages: [],
        createdAt: now,
      };
      data.threads.push(thread);
      await store.savePhoneMessages(persona.id, data);
    }

    const key = `${persona.id}:${thread.id}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    this.plugin.store.trigger("phone-replying-changed", persona.id);
    try {
      const system = await this.buildExtraSystemPrompt(personaFile, sceneTail);
      if ("error" in system) return;
      const result = await this.generateIntoThread({
        personaId: persona.id,
        target: { kind: "extra", threadId: thread.id },
        profile,
        system: system.text,
        stripPrefix: null,
      });
      if (result.ok) this.scheduleIncomingNotice("알 수 없는 번호", result.firstDeliverAt);
    } finally {
      this.inFlight.delete(key);
      this.plugin.store.trigger("phone-replying-changed", persona.id);
    }
  }

  // ─────────────────────────── 스텔라튜브 방송 (v2 §7) ───────────────────────────

  /**
   * 라이브 방송 스냅샷 — 세션 메뉴가 동기적으로 읽는다.
   * `liveSessions` 는 구 SNS 게시글 내장 방송(v1, 레거시 표시 유지),
   * `tubeLiveSessions` 는 stream.json 방송(v2). 새 방송은 전부 v2 경로.
   */
  private liveSessions = new Set<string>();
  private tubeLiveSessions = new Set<string>();
  /** 튜브 반응 생성 중 가드 — 노드 생성이 몰려도 1개씩. */
  private tubeBusy = false;

  isSessionLive(sessionFile: string): boolean {
    return (
      this.tubeLiveSessions.has(sessionFile) || this.liveSessions.has(sessionFile)
    );
  }

  private async recomputeLiveSessions(): Promise<void> {
    const feed = await this.plugin.store.getSnsFeed();
    this.liveSessions = new Set(
      feed.posts
        .filter((p) => p.stream?.live)
        .map((p) => p.stream!.sessionFile)
    );
  }

  private async recomputeTubeLiveSessions(): Promise<void> {
    const streams = await this.plugin.store.listSessionStreams();
    this.tubeLiveSessions = new Set(
      streams.filter((s) => s.stream.live).map((s) => s.sessionFile)
    );
  }

  /** 세션 메뉴/커맨드 진입점 — 방송 중이면 끄고, 아니면 켠다. */
  async toggleStream(
    sessionFile: string
  ): Promise<{ ok: true; live: boolean } | { ok: false; error: string }> {
    if (this.isSessionLive(sessionFile)) {
      await this.endStream(sessionFile);
      return { ok: true, live: false };
    }
    const result = await this.startStream(sessionFile);
    return result.ok ? { ok: true, live: true } : result;
  }

  /**
   * 스텔라튜브 방송 시작 (v2 §7.2) — 세션 옆 stream.json 생성. 볼트에 동시
   * 1개만. streamer 미지정 = 로그인 페르소나 계정(수동 시작). 시작 직후
   * 오프닝 반응 1회 시도. 같은 세션에서 다시 방송하면 이전 다시보기를 덮는다.
   */
  async startStream(
    sessionFile: string,
    streamer?: SessionStreamFile["streamer"]
  ): Promise<PhoneSendResult> {
    if (this.plugin.data.phone?.tubeEnabled === false) {
      return { ok: false, error: "스텔라튜브가 꺼져 있습니다." };
    }
    const store = this.plugin.store;
    const streams = await store.listSessionStreams();
    if (streams.some((s) => s.stream.live)) {
      return { ok: false, error: "이미 진행 중인 방송이 있습니다." };
    }
    const session = await store.getSession(sessionFile);
    if (!session) return { ok: false, error: "세션을 불러올 수 없습니다." };

    let st = streamer;
    if (!st) {
      // 수동 시작 — 스트리머 = 로그인 페르소나 계정 (없으면 만들어 귀속).
      const { profile: persona } = await this.getLoginPersona();
      const accounts = await store.getPhoneAccounts();
      let acc = accounts.accounts.find(
        (a) => a.kind === "persona" && a.scenarioId === persona.id
      );
      if (!acc) {
        acc = {
          id: `acc_${uuidv4()}`,
          kind: "persona",
          scenarioId: persona.id,
          name: persona.name?.trim() || "User",
          followers: 50 + Math.floor(Math.random() * 150),
          firstSeen: Date.now(),
          lastActive: Date.now(),
          postCount: 0,
        };
        accounts.accounts.push(acc);
        await store.savePhoneAccounts(accounts);
      }
      st = {
        kind: "persona",
        accountId: acc.id,
        name: persona.name?.trim() || "User",
      };
    }
    // 시작 시청자 = 스트리머 팔로워 × 1~3% (§7.3) — 이후 노드마다 모델 제시를
    // 직전값 대비 ±60% 로 클램프.
    const accounts = await store.getPhoneAccounts();
    const followers =
      (st.accountId
        ? accounts.accounts.find((a) => a.id === st!.accountId)?.followers
        : undefined) ?? 100;
    const startViewers = Math.max(
      5,
      Math.round(followers * (0.01 + Math.random() * 0.02))
    );
    const stream: SessionStreamFile = {
      version: 1,
      streamId: uuidv4(),
      streamer: st,
      live: true,
      startedNodeId: session.meta.activeLeafId,
      startViewers,
      nodes: {},
      startedAt: Date.now(),
    };
    await store.saveSessionStream(sessionFile, stream);
    this.tubeLiveSessions.add(sessionFile);
    // 오프닝 반응 — 방송이 켜진 순간의 첫 채팅 1회 (실패는 조용히).
    void this.onSessionNodeGenerated(sessionFile).catch((err) =>
      console.warn("[GGAI Stella] 스텔라튜브 오프닝 반응 실패:", err)
    );
    return { ok: true };
  }

  /**
   * 방송 종료 — stream.json 은 다시보기로 남는다. 수동 종료는 즉시
   * (closing 2연속 판정은 자동 경로 전용). 레거시 v1 게시글 방송도 함께 끈다.
   */
  async endStream(sessionFile: string): Promise<void> {
    const store = this.plugin.store;
    const stream = await store.getSessionStream(sessionFile);
    if (stream?.live) {
      stream.live = false;
      stream.endedAt = Date.now();
      await store.saveSessionStream(sessionFile, stream);
    }
    this.tubeLiveSessions.delete(sessionFile);
    const feed = await store.getSnsFeed();
    let changed = false;
    for (const p of feed.posts) {
      if (p.stream?.live && p.stream.sessionFile === sessionFile) {
        p.stream.live = false;
        changed = true;
      }
    }
    this.liveSessions.delete(sessionFile);
    if (changed) await store.saveSnsFeed(feed);
  }

  /**
   * 세션에 새 AI 노드가 생성 완료됐을 때 (phone-extension 이 부른다) —
   * 이 세션이 방송 중이면 그 노드의 시청자 반응 배치를 생성한다 (§7.3).
   */
  async onSessionNodeGenerated(
    sessionFile: string,
    opts?: { force?: boolean }
  ): Promise<void> {
    if (this.plugin.data.phone?.tubeEnabled === false) return;
    if (!this.tubeLiveSessions.has(sessionFile)) return;
    if (this.tubeBusy) return;
    this.tubeBusy = true;
    try {
      await this.generateTubeReaction(sessionFile, opts);
    } finally {
      this.tubeBusy = false;
    }
  }

  /**
   * 노드 반응 생성 (§7.3) — 입력: 방송분 장면 tail + 직전 노드 채팅 흐름 +
   * 스트리머/계정 DB. 출력(JSON): viewers / streamState / chat. 노드 키 저장이라
   * 재생성 연동이 공짜 — pendingOff 도 활성 경로의 직전 반응에서 파생한다
   * (closing 노드를 재생성으로 없애면 자동 복구).
   */
  private async generateTubeReaction(
    sessionFile: string,
    opts?: { force?: boolean }
  ): Promise<void> {
    const plugin = this.plugin;
    const store = plugin.store;
    const stream = await store.getSessionStream(sessionFile);
    if (!stream?.live) return;
    const profile = this.resolvePhoneProfile();
    if (!profile || !plugin.ai.isAvailable()) return;
    try {
      await plugin.flushSessionEdits(sessionFile);
    } catch {
      /* flush 실패 — 캐시 본문으로 진행 */
    }
    const session = await store.getSession(sessionFile);
    if (!session) return;
    const nodeId = session.meta.activeLeafId;
    // 새 노드마다 1회 — 이미 반응이 있으면 스킵. 단 수동 새로고침(force)은
    // 같은 노드에 채팅을 이어 붙인다("지금 이 장면" 반응을 더 받는다).
    if (!nodeId || (stream.nodes[nodeId] && !opts?.force)) return;

    const pathIds = pathToLeaf(session, nodeId).map((n) => n.id);
    const count = (s: string) => plugin.ai.countTokens(s, profile.id);
    const body = spansToText(buildSpans(session, nodeId)).trim();
    const scene = trimToTokens(body, 1600, count, "tail");
    if (!scene) return;

    // 직전 반응 (활성 경로 기준) — viewers 클램프 기준 + closing 2연속 판정.
    // force(수동 새로고침)로 같은 노드에 이어 붙일 땐 그 노드 자체가 직전이다.
    const appendNode = opts?.force ? stream.nodes[nodeId] : undefined;
    let prev: StreamNodeReaction | null = appendNode ?? null;
    if (!prev) {
      for (let i = pathIds.length - 2; i >= 0; i--) {
        const r = stream.nodes[pathIds[i]];
        if (r) {
          prev = r;
          break;
        }
      }
    }
    const prevViewers = prev?.viewers ?? stream.startViewers;
    // 이어 붙이는 경우 closing 판정은 하지 않는다 (사용자가 방송을 이어 보는 중).
    const pendingOff = !appendNode && prev?.streamState === "closing";
    const chatSoFar = pathIds
      .filter((id) => stream.nodes[id])
      .slice(-2)
      .flatMap((id) =>
        stream.nodes[id].chat.map(
          (c) =>
            `${c.name}${c.handle ? ` ${c.handle}` : ""}: ${c.text}` +
            (c.donation ? ` [donated ${c.donation}]` : "")
        )
      );

    const { profile: persona } = await this.getLoginPersona();
    const personaName = persona.name?.trim() || "User";
    const newAccountCap = Math.max(
      0,
      Math.floor(plugin.data.phone?.snsNewAccountCap ?? 3)
    );

    // 세계 로스터 — 방송 세션의 세계(장면 속 인물)는 시청자 귀속에서 제외.
    const excluded = new Set(plugin.data.phone?.snsExcludedScenarioIds ?? []);
    const scenarios = await store.getScenarios().catch(
      (): Awaited<ReturnType<typeof store.getScenarios>> => []
    );
    const charByName = new Map<string, SnsAuthor>();
    for (const sc of scenarios) {
      const world = sc.scenario.data?.name?.trim();
      const id = sc.scenario.data?.extensions?.stella?.id;
      if (!world || !id || excluded.has(id)) continue;
      if (id === session.meta.scenarioId) continue;
      if (!charByName.has(world.toLowerCase())) {
        charByName.set(world.toLowerCase(), {
          kind: "character",
          id,
          name: world,
          world,
        });
      }
    }

    const accountsFile = await store.getPhoneAccounts();
    const streamerAcc = stream.streamer.accountId
      ? accountsFile.accounts.find((a) => a.id === stream.streamer.accountId)
      : undefined;
    const topAccounts = [...accountsFile.accounts]
      .filter((a) => a.kind !== "persona")
      .sort((x, y) => y.postCount - x.postCount || y.lastActive - x.lastActive)
      .slice(0, 30);
    const accountsBlock = topAccounts
      .map((a) =>
        [
          a.handle ?? "",
          a.name,
          a.world ? `(${a.world})` : "",
          `${a.followers} followers`,
          a.persona ? `— ${a.persona}` : "",
        ]
          .filter(Boolean)
          .join(" ")
      )
      .map((s) => `- ${s}`)
      .join("\n");

    const promptItem = resolveMediaPrompt(
      "phoneTube",
      plugin.data.phone?.tubePromptId,
      plugin.data.mediaPrompts
    );
    if (!promptItem) return;
    const behavior = applyMacros(promptItem.prompt, {
      char: stream.streamer.name,
      user: personaName,
      variables: {},
    }).trim();
    const language = plugin.data.phone?.language?.trim();
    const system =
      `${PHONE_TUBE_HEADER}\n\n` +
      `${behavior}\n` +
      `\n[Streamer]\n${stream.streamer.name}` +
      (streamerAcc
        ? ` — ${streamerAcc.followers} followers` +
          (streamerAcc.world ? ` (${streamerAcc.world})` : "")
        : "") +
      `\n` +
      (accountsBlock
        ? `\n[Known accounts — REUSE these viewers (refer by "account":"@handle")]\n` +
          `${accountsBlock}\n`
        : "") +
      `\n[Broadcast — the scene on screen right now; react to the NEWEST part]\n` +
      `${scene}\n` +
      (chatSoFar.length > 0
        ? `\n[Chat so far — continue this flow, don't repeat it]\n` +
          `${chatSoFar.join("\n")}\n`
        : "") +
      `\n${buildTubeIoInstructions({ prevViewers, newAccountCap })}` +
      (language ? `\n- Write ALL chat text in ${language}.` : "") +
      `\n[BEGIN JSON]`;

    let raw = "";
    try {
      const res = await plugin.ai.chat({
        profileId: profile.id,
        messages: [
          { role: "system", content: system },
          { role: "user", content: "[Generate the live chat reaction now.]" },
        ],
        label: "스텔라튜브 채팅",
      });
      raw = (res.text ?? "").trim();
    } catch (err) {
      console.warn("[GGAI Stella] 스텔라튜브 반응 생성 실패:", err);
      return;
    }
    const parsed = parseTubeReaction(raw);
    if (!parsed) return;

    const engine = this.makeAccountEngine({
      accounts: accountsFile,
      charByName,
      personaName,
      newAccountCap,
    });
    const now = Date.now();
    const chat: StreamChatItem[] = [];
    for (const c of parsed.chat.slice(0, 12)) {
      const author = engine.resolveAuthor(
        {
          account: c.account,
          author: c.name ?? c.account ?? "",
          handle: c.handle,
          world: c.world,
        },
        false
      );
      if (!author) continue;
      chat.push({
        id: uuidv4(),
        name: author.name,
        ...(author.handle ? { handle: author.handle } : {}),
        text: c.text,
        ...(typeof c.donation === "number" && c.donation > 0
          ? { donation: Math.round(c.donation) }
          : {}),
      });
      engine.recordActivity(author, { isPost: false });
    }
    // 시청자 수 — 모델 제시를 직전값 대비 ±60% 로 클램프 (순간이동 방지).
    const proposed =
      typeof parsed.viewers === "number" && parsed.viewers > 0
        ? parsed.viewers
        : prevViewers;
    const viewers = Math.max(
      1,
      Math.round(
        Math.min(prevViewers * 1.6, Math.max(prevViewers * 0.4, proposed))
      )
    );

    // 저장 — 생성 중 변경 대비 fresh 재읽기.
    const fresh = await store.getSessionStream(sessionFile);
    if (!fresh?.live) return;
    // force(수동 새로고침)면 같은 노드에 채팅을 이어 붙인다. 아니면 새 노드 반응.
    const existing = opts?.force ? fresh.nodes[nodeId] : undefined;
    fresh.nodes[nodeId] = {
      viewers,
      streamState: parsed.streamState,
      chat: existing ? [...existing.chat, ...chat] : chat,
      at: existing ? existing.at : now,
    };
    // closing 2연속 = 방송 종료 (§7.3) — 한 번의 클로징 멘트로는 안 꺼진다.
    // 이어 붙이는 경우(force)엔 종료 판정을 하지 않는다.
    if (!existing && parsed.streamState === "closing" && pendingOff) {
      fresh.live = false;
      fresh.endedAt = now;
    }
    await store.saveSessionStream(sessionFile, fresh);
    if (engine.wasChanged()) await store.savePhoneAccounts(accountsFile);
    if (!fresh.live) {
      this.tubeLiveSessions.delete(sessionFile);
      new Notice("📺 스텔라튜브 방송이 끝났습니다 — 다시보기가 남았습니다.");
    }
  }

  /** 라이브 방송 본문을 그 세션의 최근 장면으로 갱신 (LLM 없음 — 텍스트 중계). */
  private async syncLiveStreams(): Promise<void> {
    if (this.liveSessions.size === 0) return;
    const store = this.plugin.store;
    const feed = await store.getSnsFeed();
    let changed = false;
    for (const p of feed.posts) {
      if (!p.stream?.live) continue;
      const scene = await this.sessionSceneText(p.stream.sessionFile);
      if (scene && scene !== p.text) {
        p.text = scene;
        changed = true;
      }
    }
    if (changed) await store.saveSnsFeed(feed);
  }

  /** 세션의 최근 장면 (방송 화면용 본문 꼬리). 실패는 빈 문자열. */
  private async sessionSceneText(sessionFile: string): Promise<string> {
    try {
      await this.plugin.flushSessionEdits(sessionFile);
      const session = await this.plugin.store.getSession(sessionFile);
      if (!session) return "";
      const body = spansToText(
        buildSpans(session, session.meta.activeLeafId)
      ).trim();
      return body.slice(-600);
    } catch {
      return "";
    }
  }

  // ─────────────────────────── SNS (PH3) ───────────────────────────

  /**
   * 스텔라 폰 사용 여부 — PHONE 폴더가 만들어졌으면(문자/SNS/갤러리 무엇이든)
   * 사용중으로 본다. 갤러리 "네트워크에 게시" 메뉴 노출 게이트.
   */
  isPhoneInUse(): boolean {
    return !!this.plugin.app.vault.getAbstractFileByPath(`${BASE_FOLDER}/PHONE`);
  }

  /** 갤러리 "네트워크에 공유" 대기 이미지 — 폰이 열리면 SNS 작성창에 첨부된다. */
  private pendingShare: { path: string; caption: string } | null = null;

  /**
   * 갤러리 → "스텔라 네트워크에 공유" — 진짜 폰 공유처럼 스텔라 폰을 열고
   * SNS 작성창에 이미지를 첨부한다. 게시는 사용자가 코멘트를 쓰고 [게시]로.
   */
  async shareImageToNetwork(image: {
    path: string;
    caption: string;
  }): Promise<void> {
    if (!this.plugin.app.vault.getAbstractFileByPath(image.path)) {
      new Notice("이미지 파일을 찾을 수 없습니다.");
      return;
    }
    this.pendingShare = image;
    // 이미 열린 폰이 있으면 즉시 SNS 작성창으로 전환.
    this.plugin.store.trigger("phone-share-requested");
    await this.plugin.openStellaPhone();
  }

  /** 대기 중인 공유 이미지 소비 (폰 뷰 전용 — 1회성). */
  takePendingShare(): { path: string; caption: string } | null {
    const share = this.pendingShare;
    this.pendingShare = null;
    return share;
  }

  /**
   * 페르소나(사용자)가 SNS 게시글 작성 — 사진 첨부 가능 (인스타처럼).
   * image.registerGallery 면 (새 업로드) 폰 갤러리에도 등록한다. 잠시 후 반응 1회 시도.
   */
  async postToSns(
    persona: StellaUserProfile,
    text: string,
    image?: { asset: string; registerGallery?: boolean; caption?: string }
  ): Promise<void> {
    const body = text.trim();
    if (!body && !image) return;
    const caption = image?.caption?.trim() || firstLine(body) || "사진";
    if (image?.registerGallery) {
      await this.addGalleryItem({ file: image.asset, caption, source: "upload" });
    }
    const store = this.plugin.store;
    const feed = await store.getSnsFeed();
    const newPostId = uuidv4();
    feed.posts.push({
      id: newPostId,
      author: { kind: "persona", id: persona.id, name: persona.name || "User" },
      text: body,
      createdAt: Date.now(),
      replies: [],
      // 유저 게시글 = max(판정, 2) — 초기 2, 이후 배치가 상향 가능 (v2 §6.2).
      issueScale: 2,
      ...(image ? { image: { caption, asset: image.asset } } : {}),
    });
    await store.saveSnsFeed(feed);
    await this.ensurePersonaAccount(persona);
    // 게시 직후 반응 — 갱신을 기다리지 않고 SNS 활동 1회를 바로 시도한다
    // (스로틀과 무관, 캐릭터들이 답글 달 기회).
    const profile = this.resolvePhoneProfile();
    if (profile && this.plugin.ai.isAvailable()) {
      const userFile =
        this.plugin.data.phone?.loginPersonaFile ??
        this.plugin.data.activeUserProfileFile ??
        "";
      void this.generateSnsActivity(persona, userFile, profile, {
        notify: true,
        reactToPostId: newPostId,
      }).catch((err) => console.warn("[GGAI Stella] SNS 반응 생성 실패:", err));
    }
  }

  /** 페르소나 계정 등록/갱신 (v2 §6.1) — 게시 시 accounts.json 에 합류. */
  private async ensurePersonaAccount(persona: StellaUserProfile): Promise<void> {
    try {
      const store = this.plugin.store;
      const accounts = await store.getPhoneAccounts();
      const now = Date.now();
      const acc = accounts.accounts.find(
        (a) => a.kind === "persona" && a.scenarioId === persona.id
      );
      if (acc) {
        acc.lastActive = now;
        acc.postCount += 1;
      } else {
        accounts.accounts.push({
          id: `acc_${uuidv4()}`,
          kind: "persona",
          scenarioId: persona.id,
          name: persona.name?.trim() || "User",
          followers: 50 + Math.floor(Math.random() * 150),
          firstSeen: now,
          lastActive: now,
          postCount: 1,
        });
      }
      await store.savePhoneAccounts(accounts);
    } catch (err) {
      console.warn("[GGAI Stella] 페르소나 계정 등록 실패:", err);
    }
  }

  /** [더 보기] 스로틀 — 게시글별 마지막 실행 시각. */
  private moreRepliesAt = new Map<string, number>();

  /**
   * [더 보기] (v2 §6.7) — 등급 3+ 게시글 단독 대상 미니 배치. 재료 = 그 글 +
   * 전체 댓글 + 작성자 세계 자료 + 계정 목록 + 분배 규칙 → 댓글 5~10개 append.
   * 반복 클릭 가능 (게시글당 스로틀 30초).
   */
  async loadMoreReplies(
    persona: StellaUserProfile,
    postId: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.snsBusy) return { ok: false, error: "이미 생성 중입니다." };
    const last = this.moreRepliesAt.get(postId) ?? 0;
    if (Date.now() - last < 30_000) {
      return { ok: false, error: "잠시 후 다시 시도하세요." };
    }
    const profile = this.resolvePhoneProfile();
    if (!profile || !this.plugin.ai.isAvailable()) {
      return { ok: false, error: "폰 모델(챗 프로필)이 없습니다." };
    }
    this.snsBusy = true;
    this.moreRepliesAt.set(postId, Date.now());
    try {
      const plugin = this.plugin;
      const store = plugin.store;
      const feed = await store.getSnsFeed();
      const post = feed.posts.find((p) => p.id === postId);
      if (!post) return { ok: false, error: "게시글을 찾을 수 없습니다." };
      const personaName = persona.name?.trim() || "User";
      const count = (s: string) => plugin.ai.countTokens(s, profile.id);
      const scale = post.issueScale ?? 2;
      const newAccountCap = Math.max(
        0,
        Math.floor(plugin.data.phone?.snsNewAccountCap ?? 3)
      );

      // 메인 캐릭터 귀속 맵 + 작성자 세계 자료 (그 글 작성자의 세계만 확정급).
      const excluded = new Set(plugin.data.phone?.snsExcludedScenarioIds ?? []);
      const scenarios = await store.getScenarios().catch(
        (): Awaited<ReturnType<typeof store.getScenarios>> => []
      );
      const charByName = new Map<string, SnsAuthor>();
      for (const sc of scenarios) {
        const world = sc.scenario.data?.name?.trim();
        const id = sc.scenario.data?.extensions?.stella?.id;
        if (!world || !id || excluded.has(id)) continue;
        if (!charByName.has(world.toLowerCase())) {
          charByName.set(world.toLowerCase(), {
            kind: "character",
            id,
            name: world,
            world,
          });
        }
      }
      let worldBlock = "";
      const authorScenarioId =
        post.author.kind === "character" || post.author.kind === "scenario"
          ? post.author.id
          : undefined;
      if (authorScenarioId) {
        const sc = scenarios.find(
          (i) => i.scenario.data?.extensions?.stella?.id === authorScenarioId
        );
        if (sc) {
          worldBlock = await this.buildWorldReference(
            sc.scenario,
            personaName,
            count
          ).catch(() => "");
        }
      }

      const accountsFile = await store.getPhoneAccounts();
      const topAccounts = [...accountsFile.accounts]
        .filter((a) => a.kind !== "persona")
        .sort((x, y) => y.postCount - x.postCount || y.lastActive - x.lastActive)
        .slice(0, 30);
      const accountsBlock = topAccounts
        .map((a) =>
          [
            a.handle ?? "",
            a.name,
            a.world ? `(${a.world})` : "",
            `${a.followers} followers`,
            a.kind === "press" || a.verified ? "[press/verified]" : "",
          ]
            .filter(Boolean)
            .join(" ")
        )
        .map((s) => `- ${s}`)
        .join("\n");

      const snsPromptItem = resolveMediaPrompt(
        "phoneSns",
        plugin.data.phone?.snsPromptId,
        plugin.data.mediaPrompts
      );
      if (!snsPromptItem) return { ok: false, error: "SNS 프롬프트가 없습니다." };
      const behavior = applyMacros(snsPromptItem.prompt, {
        char: "",
        user: personaName,
        variables: {},
      }).trim();
      const postLines =
        `by ${post.author.name}${post.author.world ? ` (${post.author.world})` : ""} ` +
        `[scale ${scale}]${post.image ? ` [photo: ${post.image.caption}]` : ""}: ` +
        `${post.text}\n` +
        post.replies
          .map(
            (r) =>
              `  ${r.parentId ? "  ↳↳" : "↳"} ${r.author.name}: ${r.text}`
          )
          .join("\n");
      const language = plugin.data.phone?.language?.trim();
      const system =
        `${PHONE_SNS_HEADER}\n\n` +
        `${behavior}\n` +
        (accountsBlock
          ? `\n[Known accounts — REUSE these (refer by "account":"@handle"); ` +
            `press/verified only for scale 4-5.]\n${accountsBlock}\n`
          : "") +
        (worldBlock ? `\n[The poster's world]\n${worldBlock}\n` : "") +
        `\n[The post under discussion — a scale-${scale} issue. Every comment ` +
        `you generate goes on THIS post.]\n${postLines}\n\n` +
        `## OUTPUT — raw JSON array of 5-10 NEW comment objects only:\n` +
        `{"account":"@h","author":"name","world":"world name",` +
        `"to":"<commenter name or null>","text":"...","likes":3}\n` +
        `Rules:\n` +
        `- ~80% from algorithm-matched, interested people; dissent up to ` +
        `${Math.min(40, Math.max(0, (scale - 2) * 15))}%.\n` +
        `- Invent at most ${Math.max(0, newAccountCap)} brand-new accounts.\n` +
        `- Do NOT repeat existing comments; continue the thread naturally.\n` +
        `- Each text short (1-3 sentences), in that person's own voice.` +
        (language ? `\n- Write ALL text in ${language}.` : "") +
        `\n[BEGIN JSON]`;

      let raw = "";
      try {
        const res = await plugin.ai.chat({
          profileId: profile.id,
          messages: [
            { role: "system", content: system },
            { role: "user", content: "[Generate the additional comments now.]" },
          ],
          label: "스텔라 폰 SNS 더 보기",
        });
        raw = (res.text ?? "").trim();
      } catch (err) {
        console.warn("[GGAI Stella] SNS 더 보기 생성 실패:", err);
        return { ok: false, error: "생성에 실패했습니다." };
      }
      const drafts = parseSnsActivities(raw);
      if (drafts.length === 0) return { ok: false, error: "응답 파싱 실패" };

      // 저장 — 생성 중 변경 대비 fresh 재읽기. 모든 활동을 이 글 댓글로 취급.
      const freshFeed = await store.getSnsFeed();
      const target = freshFeed.posts.find((p) => p.id === postId);
      if (!target) return { ok: false, error: "게시글이 삭제되었습니다." };
      const engine = this.makeAccountEngine({
        accounts: accountsFile,
        charByName,
        personaName,
        newAccountCap,
      });
      const now = Date.now();
      let seq = 0;
      let added = 0;
      for (const d of drafts.slice(0, 10)) {
        const author = engine.resolveAuthor(d, scale >= 4);
        if (!author) continue;
        const parentId = findParentReplyId(target, d.to);
        target.replies.push({
          id: uuidv4(),
          author,
          text: d.text,
          createdAt: now + seq++,
          ...(parentId ? { parentId } : {}),
          ...(typeof d.likes === "number" && d.likes > 0
            ? { likes: Math.floor(d.likes) }
            : {}),
        });
        engine.recordActivity(author, { isPost: false });
        added++;
      }
      if (added === 0) return { ok: false, error: "반영할 댓글이 없습니다." };
      await store.saveSnsFeed(freshFeed);
      if (engine.wasChanged()) await store.savePhoneAccounts(accountsFile);
      // 자동 번역 (§4) — 켜져 있으면 방금 더 불러온 댓글도 바로 번역해 둔다.
      if (this.isAutoTranslateOn()) {
        await this.translateSnsPost(postId).catch(() => {});
      }
      return { ok: true };
    } finally {
      this.snsBusy = false;
    }
  }

  /** 페르소나(사용자)가 게시글/답글에 답글 작성. parentId 가 있으면 대댓글. */
  async replyToSnsPost(
    persona: StellaUserProfile,
    postId: string,
    text: string,
    parentId?: string
  ): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const store = this.plugin.store;
    const feed = await store.getSnsFeed();
    const post = feed.posts.find((p) => p.id === postId);
    if (!post) return;
    // 2단 제한 — 대대댓글은 그 부모(1단)에 붙인다.
    const parent = parentId ? post.replies.find((r) => r.id === parentId) : null;
    const resolvedParentId = parent ? parent.parentId ?? parent.id : undefined;
    post.replies.push({
      id: uuidv4(),
      author: { kind: "persona", id: persona.id, name: persona.name || "User" },
      text: body,
      createdAt: Date.now(),
      ...(resolvedParentId ? { parentId: resolvedParentId } : {}),
    });
    await store.saveSnsFeed(feed);
    // 내 답글에 대한 답글이 와야 한다 — 게시 직후 반응(reactToPostId)과 같은 경로로
    // 그 글에 반응 배치 1회를 바로 시도한다(스로틀 무관). 캐릭터들이 방금 단 내
    // 댓글에 되받아 답글을 달 기회.
    const profile = this.resolvePhoneProfile();
    if (profile && this.plugin.ai.isAvailable()) {
      const userFile =
        this.plugin.data.phone?.loginPersonaFile ??
        this.plugin.data.activeUserProfileFile ??
        "";
      void this.generateSnsActivity(persona, userFile, profile, {
        notify: true,
        reactToPostId: postId,
        reactedToReply: true,
      }).catch((err) =>
        console.warn("[GGAI Stella] SNS 답글 반응 생성 실패:", err)
      );
    }
  }

  /** 게시글 좋아요 토글 — 페르소나별 1회 (likedBy 목록). */
  async togglePostLike(personaId: string, postId: string): Promise<void> {
    const store = this.plugin.store;
    const feed = await store.getSnsFeed();
    const post = feed.posts.find((p) => p.id === postId);
    if (!post) return;
    const set = new Set(post.likedBy ?? []);
    if (set.has(personaId)) set.delete(personaId);
    else set.add(personaId);
    post.likedBy = [...set];
    await store.saveSnsFeed(feed);
  }

  /** 첨부용 이미지 저장 (갤러리 등록 없이 에셋만) — 게시 시점에 갤러리에 등록된다. */
  async saveIncomingImage(bytes: ArrayBuffer, filename: string): Promise<string> {
    const ext = (filename.split(".").pop() || "png").toLowerCase();
    return this.plugin.store.savePhoneAsset(`upload-${Date.now()}.${ext}`, bytes);
  }

  // ─────────────────────────── 초기화 / 개별 삭제 ───────────────────────────

  /** 문자 전체 초기화 — 모든 스레드 삭제. 연락처 등록은 유지된다. */
  async clearAllMessages(personaId: string): Promise<void> {
    const store = this.plugin.store;
    const data = await store.getPhoneMessages(personaId);
    // 초기화 전에 등록 상태를 물질화 — 구버전 파일(이력 = 등록)이 함께 지워지지 않게.
    data.contacts = [...effectiveRegisteredIds(data)];
    data.threads = [];
    await store.savePhoneMessages(personaId, data);
  }

  /** 스레드(대화 이력) 삭제 — 시나리오 스레드는 연락처 등록을 유지한다. */
  async deleteThread(personaId: string, target: PhoneSendTarget): Promise<void> {
    const store = this.plugin.store;
    const data = await store.getPhoneMessages(personaId);
    data.contacts = [...effectiveRegisteredIds(data)];
    data.threads = data.threads.filter((t) =>
      target.kind === "scenario"
        ? !(t.kind === "scenario" && t.scenarioId === target.scenarioId)
        : t.id !== target.threadId
    );
    await store.savePhoneMessages(personaId, data);
  }

  /** 문자 1통 삭제. */
  async deleteMessage(
    personaId: string,
    target: PhoneSendTarget,
    messageId: string
  ): Promise<void> {
    const store = this.plugin.store;
    const data = await store.getPhoneMessages(personaId);
    const thread = findTargetThread(data, target);
    if (!thread) return;
    const before = thread.messages.length;
    thread.messages = thread.messages.filter((m) => m.id !== messageId);
    if (thread.messages.length !== before) {
      await store.savePhoneMessages(personaId, data);
    }
  }

  /**
   * SNS 피드 초기화. keepLiked = 좋아요(♥)가 있는 게시글은 댓글째 남긴다
   * (기본 likes 말고 사용자가 직접 누른 likedBy 기준).
   *
   * 남는 게시글이 하나도 없는 엑스트라(모르는 사람) 계정은 accounts.json 에서도
   * 함께 지운다 — 캐릭터/페르소나/공식(verified) 계정은 게시글이 없어도 유지.
   * 전체 초기화면 모든 엑스트라가, 좋아요만 남기면 그 글의 작성자만 살아남는다.
   */
  async clearSnsFeed(opts: { keepLiked: boolean }): Promise<void> {
    const store = this.plugin.store;
    const feed = await store.getSnsFeed();
    feed.posts = opts.keepLiked
      ? feed.posts.filter((p) => (p.likedBy?.length ?? 0) > 0)
      : [];
    await store.saveSnsFeed(feed);
    await this.pruneOrphanExtraAccounts(feed);
  }

  /**
   * 살아남은 게시글/댓글의 작성자에 해당하지 않는 엑스트라 계정을 accounts.json
   * 에서 제거한다. 캐릭터·페르소나·공식(verified) 계정은 항상 남긴다.
   */
  private async pruneOrphanExtraAccounts(feed: SnsFeedFile): Promise<void> {
    const store = this.plugin.store;
    const accountsFile = await store.getPhoneAccounts();
    const alive = new Set<string>();
    for (const p of feed.posts) {
      alive.add(snsAuthorKey(p.author));
      for (const r of p.replies) alive.add(snsAuthorKey(r.author));
    }
    const kept = accountsFile.accounts.filter((acc) => {
      if (acc.kind !== "extra" || acc.verified) return true;
      return alive.has(snsAccountKey(acc));
    });
    if (kept.length !== accountsFile.accounts.length) {
      accountsFile.accounts = kept;
      await store.savePhoneAccounts(accountsFile);
    }
  }

  /** 게시글 삭제 (댓글 포함). */
  async deleteSnsPost(postId: string): Promise<void> {
    const store = this.plugin.store;
    const feed = await store.getSnsFeed();
    const before = feed.posts.length;
    feed.posts = feed.posts.filter((p) => p.id !== postId);
    if (feed.posts.length !== before) await store.saveSnsFeed(feed);
  }

  /** 답글 삭제 — 대댓글(자식)도 함께 지운다. */
  async deleteSnsReply(postId: string, replyId: string): Promise<void> {
    const store = this.plugin.store;
    const feed = await store.getSnsFeed();
    const post = feed.posts.find((p) => p.id === postId);
    if (!post) return;
    const before = post.replies.length;
    post.replies = post.replies.filter(
      (r) => r.id !== replyId && r.parentId !== replyId
    );
    if (post.replies.length !== before) await store.saveSnsFeed(feed);
  }

  /** 이 계정의 게시글과 (다른 글에 단) 댓글을 전부 삭제한다. */
  async deleteSnsAccountPosts(author: SnsAuthor): Promise<void> {
    const key = snsAuthorKey(author);
    const store = this.plugin.store;
    const feed = await store.getSnsFeed();
    feed.posts = feed.posts.filter((p) => snsAuthorKey(p.author) !== key);
    for (const p of feed.posts) {
      // 지워진 댓글의 대댓글은 부모 연결이 끊긴 채 남지 않게 함께 정리.
      const removed = new Set(
        p.replies.filter((r) => snsAuthorKey(r.author) === key).map((r) => r.id)
      );
      if (removed.size === 0) continue;
      p.replies = p.replies.filter(
        (r) => !removed.has(r.id) && !(r.parentId && removed.has(r.parentId))
      );
    }
    await store.saveSnsFeed(feed);
  }

  // ─────────────────────────── 번역 (PH5) ───────────────────────────

  /** 번역 실행 중 가드 키 — 같은 스레드/게시글에 번역이 겹치지 않게. */
  private translatingKeys = new Set<string>();

  /**
   * 스레드의 번역 안 된 문자를 일괄 번역해 각 문자의 translation 으로 저장한다.
   * 원문은 불변 — 이미 번역된 문자는 건너뛴다 (재번역 방지). 프롬프트/모델은
   * 전역 번역 설정, 로어북은 폰 설정의 폰 전용 로어북 (스펙: 세션 번역과 독립).
   */
  async translateThread(
    personaId: string,
    target: PhoneSendTarget,
    opts?: { force?: boolean; messageId?: string }
  ): Promise<PhoneSendResult> {
    const key = `tr:${personaId}:${PhoneService.targetKey(target)}`;
    if (this.translatingKeys.has(key)) {
      return { ok: false, error: "이미 번역 중입니다." };
    }
    this.translatingKeys.add(key);
    try {
      const store = this.plugin.store;
      const data = await store.getPhoneMessages(personaId);
      const thread = findTargetThread(data, target);
      // force = 이미 번역된 것도 다시 번역(덮어쓰기), messageId = 그 한 통만.
      const targets = (thread?.messages ?? []).filter(
        (m) =>
          m.text.trim() !== "" &&
          (opts?.force || !m.translation) &&
          (!opts?.messageId || m.id === opts.messageId)
      );
      if (targets.length === 0) return { ok: true };
      const r = await this.plugin.translation.translateItems(
        targets.map((m, i) => ({ id: `m${i}`, source: m.text })),
        this.plugin.data.phone?.translation?.lorebookIds
      );
      if (r.results.size > 0) {
        // 번역 중 새 문자가 왔을 수 있으니 다시 읽어 message id 로 매칭해 저장.
        const byMessageId = new Map<string, string>();
        targets.forEach((m, i) => {
          const t = r.results.get(`m${i}`);
          if (t) byMessageId.set(m.id, t);
        });
        const fresh = await store.getPhoneMessages(personaId);
        let changed = false;
        for (const th of fresh.threads) {
          for (const m of th.messages) {
            const t = byMessageId.get(m.id);
            if (t && (opts?.force || !m.translation)) {
              m.translation = { text: t };
              changed = true;
            }
          }
        }
        if (changed) await store.savePhoneMessages(personaId, fresh);
      }
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "번역 실패" };
    } finally {
      this.translatingKeys.delete(key);
    }
  }

  /**
   * 게시글 본문 + 답글의 번역 안 된 항목을 일괄 번역해 저장한다.
   * force = 이미 번역된 것도 다시 번역(재생성 — 덮어쓰기).
   */
  async translateSnsPost(
    postId: string,
    opts?: { force?: boolean }
  ): Promise<PhoneSendResult> {
    const key = `tr:sns:${postId}`;
    if (this.translatingKeys.has(key)) {
      return { ok: false, error: "이미 번역 중입니다." };
    }
    this.translatingKeys.add(key);
    try {
      const store = this.plugin.store;
      const feed = await store.getSnsFeed();
      const post = feed.posts.find((p) => p.id === postId);
      if (!post) return { ok: false, error: "게시글을 찾을 수 없습니다." };
      const items: { id: string; source: string }[] = [];
      /** 짧은 요청 id → 반영 대상 ("post" 또는 답글 id). */
      const applyTo = new Map<string, string>();
      if ((opts?.force || !post.translation) && post.text.trim()) {
        items.push({ id: "p0", source: post.text });
        applyTo.set("p0", "post");
      }
      post.replies.forEach((rp, i) => {
        if ((opts?.force || !rp.translation) && rp.text.trim()) {
          items.push({ id: `r${i}`, source: rp.text });
          applyTo.set(`r${i}`, rp.id);
        }
      });
      if (items.length === 0) return { ok: true };
      const r = await this.plugin.translation.translateItems(
        items,
        this.plugin.data.phone?.translation?.lorebookIds
      );
      if (r.results.size > 0) {
        const fresh = await store.getSnsFeed();
        const fp = fresh.posts.find((p) => p.id === postId);
        if (fp) {
          let changed = false;
          for (const [reqId, translated] of r.results) {
            const dest = applyTo.get(reqId);
            if (dest === "post") {
              if (opts?.force || !fp.translation) {
                fp.translation = { text: translated };
                changed = true;
              }
            } else if (dest) {
              const reply = fp.replies.find((rp) => rp.id === dest);
              if (reply && (opts?.force || !reply.translation)) {
                reply.translation = { text: translated };
                changed = true;
              }
            }
          }
          if (changed) await store.saveSnsFeed(fresh);
        }
      }
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "번역 실패" };
    } finally {
      this.translatingKeys.delete(key);
    }
  }

  /** SNS 활동 실행 중 가드 — 갱신과 게시 직후 반응이 겹치지 않게. */
  private snsBusy = false;

  /**
   * SNS 계정 엔진 (v2 §6.1) — 배치 활동의 작성자를 accounts.json 에 귀속한다.
   *  - resolveAuthor: 핸들 참조 매칭(기존 계정의 이름/성향 유지) → 메인 캐릭터
   *    귀속(계정 find-or-create) → 신규 계정(배치당 상한, 넘치면 등록 없는 익명).
   *    press/verified 는 allowVerified(등급 4~5 문맥)에서만 통과.
   *  - recordActivity: lastActive/postCount 갱신 + followers 완만 증가.
   *  - decayInactive: 장기 미활동 계정 followers 완만 감소.
   */
  private makeAccountEngine(opts: {
    accounts: PhoneAccountsFile;
    charByName: Map<string, SnsAuthor>;
    personaName: string;
    newAccountCap: number;
  }) {
    const { accounts, charByName, personaName } = opts;
    const byId = new Map(accounts.accounts.map((a) => [a.id, a]));
    const byKey = new Map<string, SnsAccount>();
    const keyOf = (acc: SnsAccount): string => {
      if (acc.handle) return `h:${acc.handle.toLowerCase()}`;
      if (acc.kind === "character" && acc.scenarioId)
        return `character:${acc.scenarioId}`;
      return `extra:${acc.name.trim().toLowerCase()}`;
    };
    for (const acc of accounts.accounts) {
      const k = keyOf(acc);
      if (!byKey.has(k)) byKey.set(k, acc);
      // 핸들 계정도 종류 키로 한 번 더 — 캐릭터가 핸들을 가져도 id 로 찾게.
      if (acc.handle && acc.kind === "character" && acc.scenarioId) {
        const ck = `character:${acc.scenarioId}`;
        if (!byKey.has(ck)) byKey.set(ck, acc);
      }
    }
    let newCount = 0;
    let changed = false;
    const now = Date.now();
    const register = (acc: SnsAccount) => {
      accounts.accounts.push(acc);
      byId.set(acc.id, acc);
      byKey.set(keyOf(acc), acc);
      changed = true;
    };
    const initFollowers = (kind: SnsAccount["kind"]): number => {
      if (kind === "press") return 3000 + Math.floor(Math.random() * 20000);
      if (kind === "character") return 150 + Math.floor(Math.random() * 400);
      return 30 + Math.floor(Math.random() * 120);
    };
    const authorOf = (acc: SnsAccount): SnsAuthor => ({
      kind: acc.kind === "press" ? "extra" : acc.kind,
      ...(acc.scenarioId ? { id: acc.scenarioId } : {}),
      name: acc.name,
      ...(acc.handle ? { handle: acc.handle } : {}),
      ...(acc.verified || acc.kind === "press" ? { verified: true } : {}),
      ...(acc.world ? { world: acc.world } : {}),
      accountId: acc.id,
    });

    const resolveAuthor = (
      d: {
        account?: string;
        author: string;
        handle?: string;
        verified?: boolean;
        world?: string;
      },
      allowVerified: boolean
    ): SnsAuthor | null => {
      const name = d.author.trim();
      if (!name) return null;
      if (name.toLowerCase() === personaName.toLowerCase()) return null;
      const isPress = (acc: SnsAccount) => acc.kind === "press" || !!acc.verified;

      // 1) 핸들 참조 — 기존 계정 귀속 (이름/성향은 계정 것을 유지).
      const handleRef = normalizeHandle(d.account ?? d.handle ?? "");
      if (handleRef) {
        const acc = byKey.get(`h:${handleRef.toLowerCase()}`);
        if (acc) {
          if (acc.kind === "persona") return null; // 사칭 방지
          if (isPress(acc) && !allowVerified) return null; // §6.1 등급 게이트
          return authorOf(acc);
        }
      }
      // 2) 메인 캐릭터 이름 — 시나리오 귀속 + 계정 find-or-create.
      const known = charByName.get(name.toLowerCase());
      if (known?.id) {
        let acc = byKey.get(`character:${known.id}`);
        if (!acc) {
          acc = {
            id: `acc_${uuidv4()}`,
            kind: "character",
            scenarioId: known.id,
            name: known.name,
            ...(handleRef ? { handle: handleRef } : {}),
            ...(known.world ? { world: known.world } : {}),
            followers: initFollowers("character"),
            firstSeen: now,
            lastActive: now,
            postCount: 0,
          };
          register(acc);
        } else if (!acc.handle && handleRef) {
          acc.handle = handleRef;
          byKey.set(`h:${handleRef.toLowerCase()}`, acc);
          changed = true;
        }
        return authorOf(acc);
      }
      // 3) 이름 키 매칭 (핸들 없는 기존 엑스트라).
      const nameAcc = byKey.get(`extra:${name.toLowerCase()}`);
      if (nameAcc && nameAcc.kind !== "persona") {
        if (isPress(nameAcc) && !allowVerified) return null;
        return authorOf(nameAcc);
      }
      // 4) 신규 계정 — 배치당 상한, 넘치면 등록 없는 익명 작성자.
      const verified = d.verified === true;
      if (verified && !allowVerified) return null;
      if (newCount >= opts.newAccountCap) {
        return {
          kind: "extra",
          name,
          ...(handleRef ? { handle: handleRef } : {}),
          ...(d.world ? { world: d.world } : {}),
        };
      }
      newCount++;
      const acc: SnsAccount = {
        id: `acc_${uuidv4()}`,
        kind: verified ? "press" : "extra",
        name,
        ...(handleRef ? { handle: handleRef } : {}),
        ...(verified ? { verified: true } : {}),
        ...(d.world ? { world: d.world } : {}),
        followers: initFollowers(verified ? "press" : "extra"),
        firstSeen: now,
        lastActive: now,
        postCount: 0,
      };
      register(acc);
      return authorOf(acc);
    };

    const recordActivity = (
      author: SnsAuthor,
      o: { isPost: boolean; scale?: number }
    ) => {
      if (!author.accountId) return;
      const acc = byId.get(author.accountId);
      if (!acc) return;
      acc.lastActive = now;
      if (o.isPost) {
        acc.postCount += 1;
        const s = Math.min(5, Math.max(1, o.scale ?? 2));
        acc.followers += s >= 3 ? s * s * 10 : s;
      } else {
        acc.followers += 1;
      }
      changed = true;
    };

    const decayInactive = () => {
      for (const acc of accounts.accounts) {
        if (acc.followers > 20 && now - acc.lastActive > 30 * 86_400_000) {
          acc.followers = Math.floor(acc.followers * 0.98);
          changed = true;
        }
      }
    };

    return {
      resolveAuthor,
      recordActivity,
      decayInactive,
      wasChanged: () => changed,
    };
  }

  /**
   * SNS 활동 1회 — 최근 플레이한 캐릭터 몇 명을 뽑아 각자의 최근 세션을 재료로
   * 게시글/답글을 **배치 1회 호출**(JSON)로 생성한다. 상한 = `snsPerRefresh`(기본 10).
   * 캐릭터 기억 우선순위 = 로그인 페르소나와의 세션 > 다른 세션 (스펙 원칙 1).
   */
  private async generateSnsActivity(
    persona: StellaUserProfile,
    userFile: string,
    profile: GenerationProfileLite,
    opts: { notify: boolean; reactToPostId?: string; reactedToReply?: boolean }
  ): Promise<void> {
    if (this.snsBusy) return;
    this.snsBusy = true;
    try {
      const plugin = this.plugin;
      const store = plugin.store;
      // 상한 = 활동 총합 (게시글 + 댓글). 배치 1회 호출은 동일.
      const cap = Math.min(20, Math.max(1, plugin.data.phone?.snsPerRefresh ?? 10));
      const minNewPosts = Math.max(
        0,
        Math.floor(plugin.data.phone?.snsMinNewPosts ?? 2)
      );
      const newAccountCap = Math.max(
        0,
        Math.floor(plugin.data.phone?.snsNewAccountCap ?? 3)
      );
      // AI 사진 게시 허용 (v2 §5.2) — 끄면 프로토콜에서 photo 를 빼고 엔진도 무시.
      const allowPhoto = plugin.data.phone?.snsPhotoEnabled !== false;
      // 스텔라튜브 자동 시작 판정 (v2 §7.2) — 자동 감지 켬 + 튜브 켬 + 열린
      // 세션 + 진행 중 방송 없음일 때만 모델에게 판정을 맡긴다.
      const tubeStartFile =
        plugin.data.phone?.streamAutoDetect === true &&
        plugin.data.phone?.tubeEnabled !== false &&
        !opts.reactToPostId &&
        this.tubeLiveSessions.size === 0 &&
        this.liveSessions.size === 0
          ? this.firstOpenSessionFile()
          : null;
      // 방송 스트리머는 그 세션의 "장면 속 인물"만 될 수 있다 — 화면에 없는
      // 딴 세계 인물이 스트리머로 뽑히면 안 된다(사용자 지적). 세션의 시나리오
      // 이름을 구해 그 이름을 지목할 때만 캐릭터 스트리머로 인정, 아니면 페르소나.
      let tubeSessionCharName: string | null = null;
      if (tubeStartFile) {
        try {
          const s = await store.getSession(tubeStartFile);
          const scId = s?.meta.scenarioId;
          if (scId) {
            const list = await store.getScenarios().catch(
              (): Awaited<ReturnType<typeof store.getScenarios>> => []
            );
            tubeSessionCharName =
              list
                .find(
                  (i) => i.scenario.data?.extensions?.stella?.id === scId
                )
                ?.scenario.data?.name?.trim() || null;
          }
        } catch {
          /* 세션/시나리오 로드 실패 — 페르소나 스트리머로 폴백 */
        }
      }

      // 재료 = 최근 세션 본문(설정 개수/양) + 본문에 걸린 활성 로어북 +
      // 최근 플레이 가중 캐릭터 로스터 10명(프로필) + 뷰어(페르소나) 목록.
      // 시나리오 = 세계이지 계정이 아니다: 작성자는 그 세계의 "인물"이다.
      const personaName = persona.name?.trim() || "User";
      const { eventBlocks, rosterBlock, viewerBlock, charByName } =
        await this.collectSnsMaterial(persona, personaName, profile);
      if (eventBlocks.length === 0) return;

      // 최근 피드 발췌 (v2 §6.4) — 게시글 누적 기준 최신 창: 표시 순서
      // (붐업 반영) 상위 N개. 단, 댓글이 열린 글은 딱 둘 — 현 최상단 이슈
      // (feed.boom)와 뷰어의 가장 최근 글. 나머지는 이미 완성된 상태로 동결
      // (컨텍스트 전용, 모델이 댓글을 달 수 없고 파서도 폐기 — 이중 방어).
      const feed = await store.getSnsFeed();
      const boomPost = feed.boom
        ? feed.posts.find((p) => p.id === feed.boom!.postId)
        : undefined;
      const boomTurns = boomPost ? feed.boom!.turns : 0;
      // 뷰어의 가장 최근 글 — 최상단 이슈와 겹치면 열린 글은 사실상 1개.
      const viewerLatest = [...feed.posts]
        .reverse()
        .find((p) => p.author.kind === "persona" && p.author.id === persona.id);
      const viewerPost =
        viewerLatest && viewerLatest.id !== boomPost?.id
          ? viewerLatest
          : undefined;
      // 사용자가 방금 반응(게시/답글)한 글 — 이 글은 최상단/뷰어 글이 아니어도
      // 댓글을 받을 수 있게 연다(그래야 내 답글에 되받아 답글이 달린다).
      const reactedPost = opts.reactToPostId
        ? feed.posts.find((p) => p.id === opts.reactToPostId)
        : undefined;
      const commentableIds = new Set(
        [boomPost?.id, viewerPost?.id, reactedPost?.id].filter(
          (v): v is string => !!v
        )
      );
      const recent = [...feed.posts]
        .sort((a, b) => snsEffectiveAt(b) - snsEffectiveAt(a))
        .slice(0, SNS_FEED_EXCERPT);
      // 사용자가 방금 반응한 글은 오래됐어도 발췌에 반드시 넣는다 — 그래야
      // 모델이 내 댓글을 보고 되받아 답글을 달 수 있다.
      if (reactedPost && !recent.some((p) => p.id === reactedPost.id)) {
        recent.push(reactedPost);
      }
      recent.sort((a, b) => a.createdAt - b.createdAt);
      const feedLines =
        recent.length === 0
          ? "The feed is currently empty."
          : recent
              .map((p) => {
                const viewer =
                  p.author.kind === "persona" && p.author.id === persona.id
                    ? " [viewer]"
                    : "";
                const live = p.stream?.live
                  ? " [🔴 LIVE — someone is streaming an ongoing scene]"
                  : p.stream
                    ? " [ended broadcast]"
                    : "";
                const replies = p.replies
                  .slice(-5)
                  .map(
                    (r) =>
                      `    ${r.parentId ? "    ↳↳" : "↳"} ${r.author.name}: ` +
                      firstLine(r.text)
                  )
                  .join("\n");
                // 라이브 방송은 화면(장면)이 핵심 정보 — 한 줄이 아니라 넉넉히.
                const bodyText = p.stream?.live
                  ? p.text.replace(/\s+/g, " ").slice(-400)
                  : firstLine(p.text);
                const photo = p.image ? ` [photo: ${p.image.caption}]` : "";
                const world = p.author.world ? ` (${p.author.world})` : "";
                const scale = ` [scale ${p.issueScale ?? 2}]`;
                const open =
                  p.id === boomPost?.id
                    ? ` [TOP ISSUE — open for comments, top for ${boomTurns} batch(es)]`
                    : opts.reactedToReply && p.id === reactedPost?.id
                      ? ` [${personaName} just commented here — open, reply back to them]`
                      : p.id === viewerPost?.id
                        ? ` [viewer's latest — open for comments]`
                        : "";
                return (
                  `- id=${p.id.slice(0, 8)}${scale}${open} by ${p.author.name}${world}${viewer}${live}: ` +
                  bodyText +
                  photo +
                  (replies ? `\n${replies}` : "")
                );
              })
              .join("\n");

      // 영속 계정 목록 (v2 §6.1) — 활동 많은 순 상위 30, 재등장 우선을 위해
      // 모델에 준다. 페르소나 계정은 사칭 방지를 위해 제외.
      const accountsFile = await store.getPhoneAccounts();
      const topAccounts = [...accountsFile.accounts]
        .filter((a) => a.kind !== "persona")
        .sort(
          (x, y) => y.postCount - x.postCount || y.lastActive - x.lastActive
        )
        .slice(0, 30);
      const accountsBlock = topAccounts
        .map((a) => {
          const bits = [
            a.handle ?? "",
            a.name,
            a.world ? `(${a.world})` : "",
            `${a.followers} followers`,
            a.kind === "press" || a.verified ? "[press/verified]" : "",
            a.persona ? `— ${a.persona}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `- ${bits}`;
        })
        .join("\n");

      const language = plugin.data.phone?.language?.trim();
      // 행동 지시문 = 편집 가능한 phoneSns 프롬프트 ({{user}} = 뷰어 이름).
      // 엔진은 헤더/데이터 블록/JSON 프로토콜(파서와 짝)만 고정으로 붙인다.
      const snsPromptItem = resolveMediaPrompt(
        "phoneSns",
        plugin.data.phone?.snsPromptId,
        plugin.data.mediaPrompts
      );
      if (!snsPromptItem) return;
      const behavior = applyMacros(snsPromptItem.prompt, {
        char: "",
        user: personaName,
        variables: {},
      }).trim();
      const system =
        `${PHONE_SNS_HEADER}\n\n` +
        `${behavior}\n` +
        (accountsBlock
          ? `\n[Known accounts on Stella Network — the SAME netizens keep ` +
            `living here. REUSE them (refer by "account":"@handle") whenever ` +
            `someone fitting exists; press/verified accounts only surface for ` +
            `scale 4-5 issues.]\n${accountsBlock}\n`
          : "") +
        (viewerBlock
          ? `\n[Viewers on Stella Network — persona accounts watching the feed. ` +
            `You NEVER post AS them, but characters can address or react to them.]\n` +
            `${viewerBlock}\n`
          : "") +
        (rosterBlock
          ? `\n[Worlds recently in play — each world/scenario with its description ` +
            `and lore, so you know its setting and the PEOPLE in it. A world may ` +
            `hold one character or many; treat each named person as their own ` +
            `individual. About half of all activity should come from these named ` +
            `people, each strictly in their own voice.]\n${rosterBlock}\n`
          : "") +
        `\n[Recent events across the worlds — the feed reacts to THESE]\n` +
        eventBlocks.join("\n\n") +
        `\n\n[Recent feed — reply to items by their id]\n${feedLines}\n\n` +
        `${personaName} is the current viewer (their posts are marked [viewer]).\n\n` +
        buildSnsIoInstructions(cap, {
          minNewPosts,
          newAccountCap,
          ...(boomPost
            ? {
                boom: {
                  idShort: boomPost.id.slice(0, 8),
                  scale: boomPost.issueScale ?? 2,
                  turns: boomTurns,
                  mustReplace: boomTurns >= SNS_BOOM_MAX_TURNS,
                },
              }
            : {}),
          ...(viewerPost
            ? { viewerPostIdShort: viewerPost.id.slice(0, 8) }
            : {}),
          allowPhoto,
          ...(tubeStartFile ? { tubeStart: true } : {}),
        }) +
        (language
          ? `\n- Write ALL text (posts, comments, display names) in ${language}, ` +
            `using that language's natural netizen style — do not mirror the ` +
            `story's language if it differs.`
          : "") +
        `\n[BEGIN JSON]`;

      const userMsg = opts.reactedToReply
        ? `[${personaName} (the viewer) just left a comment on post ` +
          `id=${opts.reactToPostId?.slice(0, 8)}. Generate the feed activity now, ` +
          `including a few natural replies that respond to ${personaName}'s ` +
          `comment (set "kind":"comment","on":"${opts.reactToPostId?.slice(0, 8)}",` +
          `"to":"${personaName}") — the people already in that thread talk back ` +
          `to them. Keep it proportional to the issue (not a crowd). The rest of ` +
          `the batch is normal new posts about the worlds' events.]`
        : opts.reactToPostId
          ? `[${personaName} just posted id=${opts.reactToPostId.slice(0, 8)} ` +
            `moments ago. Generate the feed activity now, including first ` +
            `reactions to that post AT THE LEVEL ITS ISSUE SCALE DESERVES — an ` +
            `everyday post gets 1-3 replies, not a crowd. The rest of the batch ` +
            `is normal new posts about the worlds' events.]`
          : "[Generate the feed activity now.]";
      const callOnce = async (extra?: string): Promise<SnsActivityDraft[]> => {
        try {
          const res = await plugin.ai.chat({
            profileId: profile.id,
            messages: [
              { role: "system", content: system },
              { role: "user", content: extra ? `${userMsg}\n${extra}` : userMsg },
            ],
            label: "스텔라 폰 SNS",
          });
          return parseSnsActivities((res.text ?? "").trim());
        } catch (err) {
          console.warn("[GGAI Stella] SNS 생성 실패:", err);
          return [];
        }
      };
      let activities = await callOnce();
      // 최소 새 글 검증 (v2 §6.6) — 미달이면 1회 재시도(지시 강화), 그래도
      // 미달이면 그대로 수용. 게시 직후 반응 모드는 댓글 위주라 검사하지 않음.
      if (
        !opts.reactToPostId &&
        minNewPosts > 0 &&
        activities.length > 0 &&
        activities.filter((a) => a.kind === "post").length < minNewPosts
      ) {
        const retried = await callOnce(
          `[IMPORTANT: your output MUST contain at least ${minNewPosts} items ` +
            `with "kind":"post" — brand-new posts, not comments.]`
        );
        if (
          retried.filter((a) => a.kind === "post").length >
          activities.filter((a) => a.kind === "post").length
        ) {
          activities = retried;
        }
      }
      if (activities.length === 0) return;

      // 저장 — 생성 중 다른 저장 가능성이 있으니 다시 읽는다.
      // 상한(cap)은 활동 총합(게시글+댓글) 기준. 작성자 해석은 계정 엔진(v2 §6.1)
      // — 핸들 매칭 재등장 우선, 신규 발명은 배치당 상한, 페르소나 사칭 폐기.
      const fresh = await store.getSnsFeed();
      const now = Date.now();
      let budget = cap;
      let seq = 0;
      let photoGenerated = false;
      const engine = this.makeAccountEngine({
        accounts: accountsFile,
        charByName,
        personaName,
        newAccountCap,
      });
      engine.decayInactive();
      const addReply = (
        post: SnsPost,
        c: {
          account?: string;
          author: string;
          handle?: string;
          verified?: boolean;
          world?: string;
          to?: string;
          likes?: number;
        },
        text: string
      ) => {
        if (budget <= 0) return;
        const author = engine.resolveAuthor(c, (post.issueScale ?? 2) >= 4);
        if (!author) return;
        const parentId = findParentReplyId(post, c.to);
        post.replies.push({
          id: uuidv4(),
          author,
          text,
          createdAt: now + seq++,
          ...(parentId ? { parentId } : {}),
          ...(typeof c.likes === "number" && c.likes > 0
            ? { likes: Math.floor(c.likes) }
            : {}),
        });
        // 반응이 달리면 글의 하트도 함께 자란다 (§6.2 — 등급 범위 안에서).
        // 등급 상향 없이는 하트가 죽어 있던 문제의 수정.
        post.likes = clampLikesToScale(
          (post.likes ?? 0) + 1 + Math.floor(Math.random() * 4),
          post.issueScale ?? 2
        );
        engine.recordActivity(author, { isPost: false });
        touchedPostIds.add(post.id);
        budget--;
      };

      // 이번 배치의 새 글 + 모델이 boom 플래그로 지목한 새 최상단 이슈 후보
      // + 현 최상단 이슈가 이번 배치에 받은 반응 수 (성장 게이트).
      const newPosts: SnsPost[] = [];
      // 자동 번역(§4)이 켜져 있으면 이번 배치가 건드린 글만 번역한다.
      const touchedPostIds = new Set<string>();
      let challenger: SnsPost | null = null;
      let boomEngagement = 0;
      let tubeStarted = false;
      for (const act of activities) {
        // 방송 시작 판정 (v2 §7.2) — 활동 상한과 무관, 배치당 1회.
        if (act.kind === "stream_start") {
          if (tubeStartFile && !tubeStarted) {
            tubeStarted = true;
            const name = act.author.trim();
            let streamer: SessionStreamFile["streamer"] | undefined;
            // 스트리머 = 그 세션의 장면 속 인물(= 세션 시나리오)만 인정한다.
            // 모델이 그 이름을 지목했을 때만 캐릭터 스트리머, 아니면 페르소나
            // (화면에 없는 딴 세계 인물이 스트리머가 되는 것 방지 — 사용자 지적).
            if (
              tubeSessionCharName &&
              name.toLowerCase() === tubeSessionCharName.toLowerCase()
            ) {
              const author = engine.resolveAuthor(
                {
                  account: act.account,
                  author: name,
                  handle: act.handle,
                  world: act.world,
                },
                false
              );
              if (author) {
                streamer = {
                  kind: "character",
                  ...(author.accountId ? { accountId: author.accountId } : {}),
                  name: author.name,
                };
              }
            }
            // streamer 미지정 = 로그인 페르소나 (수동 시작과 동일).
            void this.startStream(tubeStartFile, streamer).catch((err) =>
              console.warn("[GGAI Stella] 스텔라튜브 자동 시작 실패:", err)
            );
          }
          continue;
        }
        if (budget <= 0) break;
        if (act.kind === "comment" && act.on) {
          const target = fresh.posts.find((p) => p.id.startsWith(act.on!));
          if (target) {
            // 댓글은 열린 두 글(최상단 이슈 + 뷰어 최근 글)에만 — 나머지는
            // 이미 완성된 상태로 동결 (이중 방어).
            if (!commentableIds.has(target.id)) continue;
            // 등급 상향 (§6.2) — 이슈가 커지는 서사. 내리기는 불가, likes 는
            // 새 범위로 성장.
            if (typeof act.issueScale === "number") {
              const newScale = clampIssueScale(act.issueScale);
              if (newScale > (target.issueScale ?? 2)) {
                target.issueScale = newScale;
                target.likes = clampLikesToScale(target.likes, newScale);
              }
            }
            const before = target.replies.length;
            addReply(target, act, act.text);
            if (target.id === boomPost?.id && target.replies.length > before) {
              boomEngagement += 1;
            }
            // 댓글 boom 플래그 = 대상 글(뷰어 글이 터진 경우)의 최상단 도전.
            if (act.boom && target.id !== boomPost?.id && !challenger) {
              challenger = target;
            }
            continue;
          }
          // 대상 게시글이 사라졌으면 새 글로 강등.
        }
        // 게시글 — 등급 판정 클램프 + 등급 범위 likes (§6.2).
        const scale = clampIssueScale(act.issueScale ?? 2);
        const author = engine.resolveAuthor(act, scale >= 4);
        if (!author) continue;
        const post: SnsPost = {
          id: uuidv4(),
          author,
          text: act.text,
          createdAt: now + seq++,
          replies: [],
          issueScale: scale,
          likes: clampLikesToScale(act.likes, scale),
        };
        // 캐릭터 사진 (PH5) — 캡션은 항상 저장(캡션 = 정보), 이미지 모델이 있으면
        // 실제 생성 (배치당 1장 — 비용 상한). 사진 게시 허용이 꺼져 있으면 무시.
        if (act.photo && allowPhoto) {
          post.image = { caption: act.photo };
          const imgProfile = this.resolveImageProfile();
          if (imgProfile && !photoGenerated) {
            photoGenerated = true;
            try {
              const res = await plugin.ai.image({
                profileId: imgProfile.id,
                prompt: act.photo,
                label: "스텔라 폰 SNS 사진",
              });
              const data = res.images[0]?.data;
              if (data) {
                const file = await store.savePhoneAsset(
                  `sns-${Date.now()}.png`,
                  base64ToArrayBuffer(data)
                );
                post.image.asset = file;
                await this.addGalleryItem({
                  file,
                  caption: act.photo,
                  source: "sns",
                });
              }
            } catch (err) {
              console.warn("[GGAI Stella] SNS 사진 생성 실패(캡션만 표시):", err);
            }
          }
        }
        fresh.posts.push(post);
        newPosts.push(post);
        touchedPostIds.add(post.id);
        if (act.boom && !challenger) challenger = post;
        engine.recordActivity(author, { isPost: true, scale });
        budget--;
        // 게시글에 이미 달려 나오는 댓글들 — 피드가 살아 있는 느낌의 핵심.
        for (const c of act.comments ?? []) {
          addReply(post, c, c.text);
        }
      }
      if (budget === cap) {
        // 피드에 반영할 활동 없음 — 방송 시작 판정만 있었어도 계정 귀속은 저장.
        if (engine.wasChanged()) await store.savePhoneAccounts(accountsFile);
        return;
      }
      // 최상단 이슈 결정 (§6.4 v2, 사용자 확정) — 피드에서 살아 있는 붐업 글은
      // 항상 1개. 교체 판정은 모델(boom 플래그 = 서사적으로 더 큰 사건)이,
      // 엔진은 성장·수명만 책임진다. 성장은 **반응을 받은 배치에만** +1등급
      // (한도 5) — 아무도 반응 안 한 글이 상단에서 저절로 커지지 않는다.
      // 반응 없는 배치가 2번 이어지거나 10턴이 차면 은퇴/교체.
      const cur = fresh.boom
        ? fresh.posts.find((p) => p.id === fresh.boom!.postId)
        : undefined;
      const curTurns = cur ? fresh.boom!.turns : 0;
      const engaged = boomEngagement > 0;
      const quietStreak = !cur || engaged ? 0 : (fresh.boom!.quiet ?? 0) + 1;
      const expired =
        !!cur &&
        (curTurns >= SNS_BOOM_MAX_TURNS || quietStreak >= SNS_BOOM_QUIET_RETIRE);
      let next = challenger && challenger.id !== cur?.id ? challenger : null;
      if (!next && (!cur || expired)) {
        // 최상단이 비었거나 (수명/무관심으로) 저물었는데 모델 지목이 없으면
        // 이번 배치 최고 등급 새 글로 선정한다.
        next =
          [...newPosts].sort(
            (a, b) => (b.issueScale ?? 2) - (a.issueScale ?? 2)
          )[0] ?? null;
      }
      if (next) {
        fresh.boom = { postId: next.id, turns: 1 };
        next.bumpedAt = now + seq;
      } else if (cur) {
        if (expired) {
          // 이슈가 저물었는데 교체 후보도 없음 — 최상단이 빈다.
          delete fresh.boom;
        } else if (engaged) {
          // 반응을 받으며 상단 유지 — 이슈가 커진다 (한도 5).
          fresh.boom = { postId: cur.id, turns: curTurns + 1 };
          const grown = Math.min(5, (cur.issueScale ?? 2) + 1);
          if (grown > (cur.issueScale ?? 2)) {
            cur.issueScale = grown;
            cur.likes = clampLikesToScale(cur.likes, grown);
          }
          cur.bumpedAt = now + seq;
        } else {
          // 조용한 배치 — 성장/재부상 없이 자리만 지킨다 (새 글에 밀려
          // 내려가기 시작하고, 한 번 더 조용하면 은퇴).
          fresh.boom = { postId: cur.id, turns: curTurns + 1, quiet: quietStreak };
        }
      }
      await store.saveSnsFeed(fresh);
      if (engine.wasChanged()) await store.savePhoneAccounts(accountsFile);
      if (opts.notify) this.notifyIncoming("SNS 새 소식");
      // 자동 번역 (§4) — 켜져 있으면 이번 배치가 건드린 글만 바로 번역한다.
      if (this.isAutoTranslateOn()) {
        for (const id of touchedPostIds) {
          await this.translateSnsPost(id).catch(() => {});
        }
      }
    } finally {
      this.snsBusy = false;
    }
  }

  /** 자동 번역 켜짐 여부 (§4) — 번역 사용 + 자동 옵션 둘 다 켜야. */
  isAutoTranslateOn(): boolean {
    const tr = this.plugin.data.phone?.translation;
    return tr?.enabled !== false && tr?.auto === true;
  }

  /**
   * SNS 재료 수집 v2 (§6.5) — 네트워크가 볼 "세상"을 통째로 준다.
   *  - eventBlocks: 확정 참가자(가장 최근 세션 참가자 무조건 + 참가율 score 가중
   *    랜덤)별 카드 설명 + 최근 세션 요약/본문 tail + 활성 로어북. 랜덤 세션
   *    (설정 켬 시)도 같은 구성으로 토큰 50%.
   *  - rosterBlock: 확정 제외 나머지에서 score 가중 랜덤으로 뽑은 세계의
   *    설명 + 로어북 head 압축 (총원 = SNS_WORLD_ROSTER − 확정 수).
   *  - viewerBlock: 뷰어(페르소나) 목록 — 절대 그 명의로 글을 쓰지 않게.
   *  - charByName: 세계 메인 캐릭터 작성자 귀속 (확정 + 랜덤 + 로스터 전부).
   */
  private async collectSnsMaterial(
    persona: StellaUserProfile,
    userName: string,
    profile: GenerationProfileLite
  ): Promise<{
    eventBlocks: string[];
    rosterBlock: string;
    viewerBlock: string;
    charByName: Map<string, SnsAuthor>;
  }> {
    const store = this.plugin.store;
    const phone = this.plugin.data.phone;
    const count = (s: string) => this.plugin.ai.countTokens(s, profile.id);
    const confirmedCount = Math.max(
      1,
      Math.floor(phone?.snsConfirmedCount ?? SNS_CONFIRMED_COUNT)
    );
    const summaryBudget = Math.max(
      0,
      Math.floor(phone?.snsSummaryTokens ?? SNS_SUMMARY_TOKENS)
    );
    const bodyBudget = Math.max(
      100,
      Math.floor(phone?.snsBodyTokens ?? SNS_BODY_TOKENS)
    );
    const includeLore = phone?.snsIncludeLore !== false;
    const excluded = new Set(phone?.snsExcludedScenarioIds ?? []);

    const scenarios = await store
      .getScenarios()
      .catch((): Awaited<ReturnType<typeof store.getScenarios>> => []);
    // 제외(snsExcludedScenarioIds)는 "인물(계정) 축"에만 작용한다 — 확정 참가·
    // 로스터·작성자 귀속에서 빠질 뿐, 그 시나리오의 세션은 장면 재료로 유지된다
    // (세계관 시나리오에서 플레이 중이어도 지금 사건이 피드에 들어가야 한다).
    const named = scenarios.filter((i) => i.scenario.data?.name?.trim());
    type ScItem = (typeof named)[number];
    const stellaIdOf = (sc: ScItem) => sc.scenario.data.extensions?.stella?.id;
    const isExcludedPerson = (sc: ScItem) => {
      const id = stellaIdOf(sc);
      return !!id && excluded.has(id);
    };

    const charByName = new Map<string, SnsAuthor>();
    const registerWorld = (sc: ScItem) => {
      if (isExcludedPerson(sc)) return; // 제외 = 인물로 등장하지 않음
      const world = sc.scenario.data.name!.trim();
      const stellaId = stellaIdOf(sc);
      if (stellaId && !charByName.has(world.toLowerCase())) {
        charByName.set(world.toLowerCase(), {
          kind: "character",
          id: stellaId,
          name: world,
          world,
        });
      }
    };
    const scById = new Map<string, ScItem>();
    for (const sc of named) {
      const id = stellaIdOf(sc);
      if (id && !scById.has(id)) scById.set(id, sc);
    }

    // ── 전체 세션 로드 (재료 첨부 + 참가율 계산 공용) ──
    type SessionItem = Awaited<ReturnType<typeof store.getSessions>>[number];
    const allPairs: { sc: ScItem; item: SessionItem }[] = [];
    for (const sc of named) {
      if (sc.sessionCount === 0) continue;
      const sessions = await store.getSessions(sc.folder).catch(() => []);
      for (const item of sessions) allPairs.push({ sc, item });
    }

    const groupMembers = new Map<string, string[]>();
    for (const gid of new Set(
      allPairs.map((p) => p.item.session.meta.groupId).filter((g): g is string => !!g)
    )) {
      try {
        const g = (await store.getGroupById(gid))?.group;
        if (g) groupMembers.set(gid, g.members.map((m) => m.scenarioId));
      } catch {
        /* 그룹 로드 실패 — 그 세션은 호스트만 크레딧 */
      }
    }

    // ── 참가율 점수 (§6.5) — score = Σ 0.5^(경과일/14). 많이·최근에 참가할수록
    //    높다. 그룹 세션은 멤버 전원 가산 (사용자 확정).
    const nowT = Date.now();
    const scoreById = new Map<string, number>();
    const credit = (id: string | undefined, t: number) => {
      if (!id || excluded.has(id)) return;
      const days = Math.max(0, (nowT - t) / 86_400_000);
      scoreById.set(id, (scoreById.get(id) ?? 0) + Math.pow(0.5, days / 14));
    };
    for (const { sc, item } of allPairs) {
      const t = item.session.meta.modifiedAt ?? 0;
      const hostId = stellaIdOf(sc);
      credit(hostId, t);
      const gid = item.session.meta.groupId;
      if (gid) {
        for (const mid of groupMembers.get(gid) ?? []) {
          if (mid !== hostId) credit(mid, t);
        }
      }
    }

    // ── 세션 최신순 정렬 + 열린 세션 무조건 앞으로 (미저장 편집도 반영되게) ──
    allPairs.sort(
      (a, b) =>
        (b.item.session.meta.modifiedAt ?? 0) - (a.item.session.meta.modifiedAt ?? 0)
    );
    const openFile = this.firstOpenSessionFile();
    if (openFile) {
      const idx = allPairs.findIndex((p) => p.item.sessionFile === openFile);
      if (idx > 0) allPairs.unshift(allPairs.splice(idx, 1)[0]);
    }

    // 한 세션의 참가자 = 호스트 + (그룹이면) 멤버 전원 — 인물 축에서 제외된
    // 시나리오는 참가자로 세지 않는다 (세션 자체는 재료로 유효).
    const participantsOfPair = (p: (typeof allPairs)[number]): string[] => {
      const ids = [stellaIdOf(p.sc)];
      const gid = p.item.session.meta.groupId;
      if (gid) ids.push(...(groupMembers.get(gid) ?? []));
      return [
        ...new Set(
          ids.filter(
            (id): id is string => !!id && scById.has(id) && !excluded.has(id)
          )
        ),
      ];
    };

    // ── 확정 참가 — 가장 최근 세션의 참가자 무조건 + 남은 슬롯 score 가중 랜덤 ──
    const confirmedIds: string[] = [];
    if (allPairs.length > 0) {
      for (const id of participantsOfPair(allPairs[0])) {
        if (confirmedIds.length >= confirmedCount) break;
        confirmedIds.push(id);
      }
    }
    const fillCandidates = [...scById.keys()].filter(
      (id) => (scoreById.get(id) ?? 0) > 0 && !confirmedIds.includes(id)
    );
    confirmedIds.push(
      ...pickWeightedSample(
        fillCandidates,
        fillCandidates.map((id) => scoreById.get(id) ?? 0),
        confirmedCount - confirmedIds.length
      )
    );

    // ── 확정 참가자 블록 — 카드 설명 + 최근 세션 요약/본문 tail + 활성 로어북 ──
    const latestPairOf = (id: string) =>
      allPairs.find((p) => participantsOfPair(p).includes(id));
    const eventBlocks: string[] = [];
    const usedSessions = new Map<string, string>(); // sessionFile → 먼저 첨부한 인물
    for (const id of confirmedIds) {
      const sc = scById.get(id);
      if (!sc) continue;
      registerWorld(sc);
      const pair = latestPairOf(id);
      if (!pair) continue;
      const block = await this.buildParticipantBlock({
        scenario: sc.scenario,
        sessionFile: pair.item.sessionFile,
        session: pair.item.session,
        summaryBudget,
        bodyBudget,
        includeLore,
        userName,
        count,
        usedSessions,
        openFile,
      }).catch(() => "");
      if (block) eventBlocks.push(block);
    }

    // ── 현재(가장 최근) 세션 보장 — 인물 확정과 무관하게 지금 장면은 무조건
    //    재료에 들어간다. 호스트가 인물 제외(세계관 시나리오)라도 장면·로어북은
    //    첨부하되 인물 귀속(작성자 노트)만 뺀다 (프로필 축 ≠ 세션 컨텍스트 축).
    if (allPairs.length > 0 && !usedSessions.has(allPairs[0].item.sessionFile)) {
      const anchor = allPairs[0];
      registerWorld(anchor.sc);
      const block = await this.buildParticipantBlock({
        scenario: anchor.sc.scenario,
        sessionFile: anchor.item.sessionFile,
        session: anchor.item.session,
        summaryBudget,
        bodyBudget,
        includeLore,
        userName,
        count,
        usedSessions,
        openFile,
        personKnown: !isExcludedPerson(anchor.sc),
      }).catch(() => "");
      if (block) eventBlocks.unshift(block);
    }

    // ── 랜덤 세션 (설정 켬) — 확정에 안 붙은 세션 중 무작위, 토큰은 확정의 50% ──
    if (phone?.snsRandomSessions === true) {
      const pool = allPairs.filter((p) => !usedSessions.has(p.item.sessionFile));
      for (let i = 0; i < SNS_RANDOM_SESSION_COUNT && pool.length > 0; i++) {
        const pair = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
        registerWorld(pair.sc);
        const block = await this.buildParticipantBlock({
          scenario: pair.sc.scenario,
          sessionFile: pair.item.sessionFile,
          session: pair.item.session,
          summaryBudget: Math.floor(summaryBudget / 2),
          bodyBudget: Math.max(100, Math.floor(bodyBudget / 2)),
          includeLore,
          userName,
          count,
          usedSessions,
          openFile,
          personKnown: !isExcludedPerson(pair.sc),
        }).catch(() => "");
        if (block) eventBlocks.push(block);
      }
    }

    // ── 로스터 참고 — 확정 제외 나머지(참가 이력 있는 인물)에서 score 가중 랜덤.
    //    시나리오 = 세계이지 캐릭터가 아니다: 등장인물은 설명·로어북으로 파악한다.
    const rosterCandidates = named.filter((sc) => {
      const id = stellaIdOf(sc);
      return (
        !!id &&
        !excluded.has(id) &&
        !confirmedIds.includes(id) &&
        (scoreById.get(id) ?? 0) > 0
      );
    });
    const roster = pickWeightedSample(
      rosterCandidates,
      rosterCandidates.map((sc) => scoreById.get(stellaIdOf(sc) ?? "") ?? 0),
      Math.max(0, SNS_WORLD_ROSTER - confirmedIds.length)
    );
    const rosterParts: string[] = [];
    for (const sc of roster) {
      registerWorld(sc);
      rosterParts.push(await this.buildWorldReference(sc.scenario, userName, count));
    }
    const rosterBlock = rosterParts.join("\n\n");

    // ── 뷰어(페르소나) 목록 — 계정으로 사칭하지 않게, 로그인 뷰어 표시.
    const users = await store.getUsers().catch(() => []);
    const viewerBlock = users
      .slice(0, 20)
      .map((u) => {
        const name = u.profile.name?.trim() || "User";
        const mine = u.profile.id === persona.id ? " [current viewer]" : "";
        const d = u.profile.description?.trim();
        const desc = d ? ` — ${trimToTokens(d, SNS_VIEWER_DESC_TOKENS, count, "head")}` : "";
        return `- ${name}${mine}${desc}`;
      })
      .join("\n");

    return { eventBlocks, rosterBlock, viewerBlock, charByName };
  }

  /** 열려 있는 세션 호스트 뷰의 첫 세션 파일 (없으면 null). */
  private firstOpenSessionFile(): string | null {
    for (const leaf of getSessionHostLeaves(this.plugin.app.workspace)) {
      if (!isSessionHostView(leaf.view)) continue;
      const f = leaf.view.getSessionFile();
      if (f) return f;
    }
    return null;
  }

  /**
   * 한 세계(시나리오)의 레퍼런스 블록 — 설명 + 로어북 전체. 시나리오는 캐릭터가
   * 아니라 세계이므로, 그 안의 등장인물은 설명·로어북에서 파악하게 통째로 준다
   * (본문 매칭 없는 "누가 있는가" 레퍼런스라 이벤트 로어북과 성격이 다르다).
   */
  private async buildWorldReference(
    scenario: StellaScenario,
    userName: string,
    count: (s: string) => number
  ): Promise<string> {
    const world = (scenario.data.name ?? "").trim();
    const macroCtx = { char: world, user: userName, variables: {} };
    const card = scenario.data as { description?: string; personality?: string };
    const parts: string[] = [];
    const desc = card.description ? applyMacros(card.description, macroCtx).trim() : "";
    if (desc) parts.push(desc);
    const perso = card.personality ? applyMacros(card.personality, macroCtx).trim() : "";
    if (perso) parts.push(`Personality: ${perso}`);
    const books = await resolveActiveLorebooks(this.plugin.store, scenario, null).catch(
      (): StellaLorebook[] => []
    );
    const lore = renderAllLore(books, { char: world, user: userName });
    if (lore) parts.push(`Lore:\n${lore}`);

    const ref = trimToTokens(parts.join("\n"), SNS_WORLD_REF_TOKENS, count, "head");
    const header = `### ${world} — a world/scenario (may contain one or many people)`;
    return ref ? `${header}\n${ref}` : header;
  }

  /**
   * 확정 참가자(인물) 블록 v2 (§6.5) — 카드 설명 + 최근 세션 요약 tail +
   * 본문 tail + 그 본문 기준 활성 로어북 전부(상시 + 키워드 매칭, 절단 없음).
   * 같은 세션이 이미 다른 참가자로 첨부됐으면 본문/요약은 중복 첨부하지 않는다.
   */
  private async buildParticipantBlock(opts: {
    scenario: StellaScenario;
    sessionFile: string;
    session: Parameters<typeof buildSpans>[0];
    summaryBudget: number;
    bodyBudget: number;
    includeLore: boolean;
    userName: string;
    count: (s: string) => number;
    usedSessions: Map<string, string>;
    openFile: string | null;
    /**
     * false = 이 세계는 인물(계정)로 등장하지 않는다 (SNS 참가 제외 시나리오) —
     * 장면·로어북은 첨부하되 작성자 귀속 노트를 뺀다.
     */
    personKnown?: boolean;
  }): Promise<string> {
    const { scenario, sessionFile, count, userName } = opts;
    const world = (scenario.data.name ?? "").trim();
    const parts: string[] = [`### World: ${world}`];
    if (scenario.data.extensions?.stella?.id && opts.personKnown !== false) {
      parts.push(
        `(If "${world}" is a person's name, that is this world's main ` +
          `character — they post under this exact name.)`
      );
    }

    // 카드 설명 — 확정 참가자는 "누구인가"를 로스터보다 진하게 안다.
    const macroCtx = { char: world, user: userName, variables: {} };
    const card = scenario.data as { description?: string; personality?: string };
    const desc = card.description
      ? trimToTokens(
          applyMacros(card.description, macroCtx).trim(),
          SNS_WORLD_REF_TOKENS,
          count,
          "head"
        )
      : "";
    if (desc) parts.push(`[Profile]\n${desc}`);

    // 열린 세션은 flush 후 fresh 읽기 (미저장 편집 반영, v1 유지).
    let session = opts.session;
    if (sessionFile === opts.openFile) {
      try {
        await this.plugin.flushSessionEdits(sessionFile);
        const fresh = await this.plugin.store.getSession(sessionFile);
        if (fresh) session = fresh;
      } catch {
        /* flush 실패 — 캐시 본문으로 진행 */
      }
    }

    const body = spansToText(buildSpans(session, session.meta.activeLeafId)).trim();
    const tail = trimToTokens(body, opts.bodyBudget, count, "tail");
    const dupOwner = opts.usedSessions.get(sessionFile);
    if (dupOwner) {
      parts.push(
        `Recent events: shares the same scene already attached under ` +
          `"${dupOwner}" above — they are in it together.`
      );
    } else {
      // 최근 세션 요약 — 누적 요약(압축 + 앵커)의 최근분 우선.
      if (opts.summaryBudget > 0) {
        try {
          const summaries = await this.plugin.store.getSessionSummaries(sessionFile);
          const { events, state } = composeInheritedSummary(
            session as Parameters<typeof composeInheritedSummary>[0],
            summaries
          );
          const sum = [events, state ? `Current state: ${state}` : ""]
            .filter(Boolean)
            .join("\n");
          const trimmed = trimToTokens(sum, opts.summaryBudget, count, "tail");
          if (trimmed) parts.push(`[Story so far — summary]\n${trimmed}`);
        } catch {
          /* 요약 없음/로드 실패 — 본문만으로 진행 */
        }
      }
      if (tail) {
        parts.push(`Recent events (what just happened — react to THIS):\n${tail}`);
      }
      opts.usedSessions.set(sessionFile, world);
    }

    // 로어북 — 첨부한 본문 기준 활성화(상시 + 키워드 매칭)된 엔트리 전부.
    if (opts.includeLore) {
      const books = await resolveActiveLorebooks(
        this.plugin.store,
        scenario,
        session
      ).catch((): StellaLorebook[] => []);
      if (books.length > 0) {
        const scene = tail || body;
        const matched = matchLorebookEntries(books, {
          recentMessages: [scene],
          activeText: scene,
          keywordMatching: true,
        });
        const lore = renderMatchedLore(matched, { char: world, user: userName });
        if (lore) parts.push(`[Active lore triggered by this scene]\n${lore}`);
      }
    }

    return parts.join("\n");
  }

  /**
   * 수신 알림을 배달 시각에 맞춰 예약 (v2 §3.2) — 시간차 배달이면 문자가
   * "도착"하는 순간 울린다. 즉시 배달/과거면 바로.
   */
  private scheduleIncomingNotice(
    senderName: string,
    deliverAt: number | undefined
  ): void {
    const delay = (deliverAt ?? 0) - Date.now();
    if (delay <= 0) {
      this.notifyIncoming(senderName);
      return;
    }
    window.setTimeout(() => this.notifyIncoming(senderName), delay);
  }

  /** 수신 알림 — 인앱 Notice, 클릭하면 폰이 열린다. */
  private notifyIncoming(senderName: string): void {
    const notice = new Notice(`📱 새 문자 — ${senderName}`, 8_000);
    notice.noticeEl.addEventListener("click", () => {
      void this.plugin.openStellaPhone();
      notice.hide();
    });
  }

  // ─────────────────────────── 재료 조립 ───────────────────────────

  /**
   * 열려 있는 세션 뷰 중 이 캐릭터(시나리오)와 이 페르소나의 세션을 찾는다.
   * 로그인 페르소나 ≠ 그 세션의 페르소나면 첨부하지 않는다 (남의 폰으로
   * 로그인했을 때 내 세션 장면이 새어 나가지 않게 — 스펙 원칙 1-1).
   */
  private async findAttachedSession(
    scenarioId: string,
    personaFile: string
  ): Promise<{ sessionFile: string; bodyTail: string } | null> {
    return this.findOpenSession(
      (meta) => meta.scenarioId === scenarioId && meta.personaFile === personaFile
    );
  }

  /** 열려 있는 세션 중 이 페르소나의 세션 (시나리오 무관 — 엑스트라 재료용). */
  private async findAnyOpenSessionOfPersona(
    personaFile: string
  ): Promise<{ sessionFile: string; bodyTail: string } | null> {
    return this.findOpenSession((meta) => meta.personaFile === personaFile);
  }

  private async findOpenSession(
    match: (meta: { scenarioId: string; personaFile?: string }) => boolean
  ): Promise<{ sessionFile: string; bodyTail: string } | null> {
    for (const leaf of getSessionHostLeaves(this.plugin.app.workspace)) {
      if (!isSessionHostView(leaf.view)) continue;
      const sessionFile = leaf.view.getSessionFile();
      if (!sessionFile) continue;
      try {
        const session = await this.plugin.store.getSession(sessionFile);
        if (!session || !match(session.meta)) continue;
        await this.plugin.flushSessionEdits(sessionFile);
        const fresh = (await this.plugin.store.getSession(sessionFile)) ?? session;
        const body = spansToText(
          buildSpans(fresh, fresh.meta.activeLeafId)
        ).trim();
        const tailTokens = Math.max(
          100,
          this.plugin.data.phone?.sessionTailTokens ?? SESSION_TAIL_TOKENS
        );
        const profile = this.resolvePhoneProfile();
        const count = (s: string) => this.plugin.ai.countTokens(s, profile?.id);
        return { sessionFile, bodyTail: trimToTokens(body, tailTokens, count, "tail") };
      } catch {
        continue;
      }
    }
    return null;
  }

  /** 시나리오 캐릭터 스레드용 시스템 지시문 (답장/선발신 공용). */
  private async buildScenarioSystemPrompt(opts: {
    personaId: string;
    personaFile: string;
    scenarioId: string;
    attachedBodyTail?: string;
    mode: "reply" | "initiate";
  }): Promise<{ text: string; charName: string } | { error: string }> {
    const plugin = this.plugin;
    const persona = await plugin.store.getUserProfile(opts.personaFile);
    const personaName = persona?.name?.trim() || "User";

    const scenarios = await plugin.store
      .getScenarios()
      .catch((): Awaited<ReturnType<typeof plugin.store.getScenarios>> => []);
    const scItem = scenarios.find(
      (i) => i.scenario.data?.extensions?.stella?.id === opts.scenarioId
    );
    if (!scItem) return { error: "캐릭터(시나리오)를 찾을 수 없습니다." };
    const card = scItem.scenario.data;
    const charName = card.name?.trim() || "Character";
    const macroCtx = { char: charName, user: personaName, variables: {} };
    const sub = (s: string | undefined) =>
      s ? applyMacros(s, macroCtx).trim() : "";

    const phoneId = opts.personaId.slice(0, 8);
    // 행동 지시문 = 편집 가능한 phoneText 프롬프트 ({{char}}/{{user}}/{{phoneId}}).
    // 엔진은 캐릭터 카드/장면 등 데이터 블록과 언어 지시만 뒤에 붙인다.
    const promptItem = resolveMediaPrompt(
      "phoneText",
      plugin.data.phone?.textPromptId,
      plugin.data.mediaPrompts
    );
    if (!promptItem) return { error: "문자 프롬프트가 없습니다." };
    const parts: string[] = [];
    parts.push(sub(promptItem.prompt.split("{{phoneId}}").join(phoneId)));
    const desc = sub((card as any).description);
    if (desc) parts.push(`[${charName}'s profile]\n${desc}`);
    const personality = sub((card as any).personality);
    if (personality) parts.push(`[${charName}'s personality]\n${personality}`);
    const scenarioText = sub((card as any).scenario);
    if (scenarioText) parts.push(`[Background]\n${scenarioText}`);
    if (persona?.description?.trim()) {
      parts.push(
        `[About ${personaName}, as ${charName} knows them]\n${sub(persona.description)}`
      );
    }
    if (opts.attachedBodyTail) {
      parts.push(
        `[Current scene — ${charName} and ${personaName} are in this ongoing ` +
          `situation right now:]\n` +
          opts.attachedBodyTail
      );
    }
    if (opts.mode === "initiate") {
      parts.push(
        `[Situation: ${charName} is texting ${personaName} first — there is no ` +
          `unanswered message from ${personaName}.]`
      );
    }
    const language = plugin.data.phone?.language?.trim();
    if (language) parts.push(`Write the text messages in ${language}.`);
    return { text: parts.join("\n\n"), charName };
  }

  /**
   * 엑스트라(모르는 번호) 스레드용 시스템 지시문.
   * sceneTail 이 있으면 "지금 장면에 리얼리즘을 더하는 발신" (첫 발신),
   * 없으면 스레드 이력이 암시하는 그 인물로 일관되게 답장.
   */
  private async buildExtraSystemPrompt(
    personaFile: string,
    sceneTail: string | null
  ): Promise<{ text: string; charName: null } | { error: string }> {
    const persona = await this.plugin.store.getUserProfile(personaFile);
    const personaName = persona?.name?.trim() || "User";
    // 행동 지시문 = 편집 가능한 phoneExtra 프롬프트. 장면은 데이터 블록으로.
    const promptItem = resolveMediaPrompt(
      "phoneExtra",
      this.plugin.data.phone?.extraPromptId,
      this.plugin.data.mediaPrompts
    );
    if (!promptItem) return { error: "모르는 번호 프롬프트가 없습니다." };
    const macroCtx = { char: "Unknown", user: personaName, variables: {} };
    const parts: string[] = [applyMacros(promptItem.prompt, macroCtx).trim()];
    if (sceneTail) {
      parts.push(`[${personaName}'s current situation]\n${sceneTail}`);
    }
    const language = this.plugin.data.phone?.language?.trim();
    if (language) parts.push(`Write the text messages in ${language}.`);
    return { text: parts.join("\n\n"), charName: null };
  }

  // ─────────────────────────── 생성 공통 ───────────────────────────

  /**
   * 시스템 지시문 + 스레드 이력으로 상대 문자를 생성해 스레드에 저장한다.
   * 빈 줄 = 연속 문자 여러 통 — 말풍선을 나눠 저장.
   */
  private async generateIntoThread(opts: {
    personaId: string;
    target: PhoneSendTarget;
    profile: GenerationProfileLite;
    system: string;
    /** 응답 앞머리에서 벗겨낼 "이름:" 프리픽스 (엑스트라는 null). */
    stripPrefix: string | null;
  }): Promise<PhoneSendResult> {
    const plugin = this.plugin;
    const store = plugin.store;
    const current = await store.getPhoneMessages(opts.personaId);
    const currentThread = resolveTargetThread(current, opts.target);
    if (!currentThread) return { ok: false, error: "스레드를 찾을 수 없습니다." };

    // 말풍선 수 고착 방지 — 모델이 이력의 자기 패턴(항상 2통이면 영원히 2통)을
    // 모방하므로, 매 생성 랜덤 목표 통 수를 힌트로 준다 (2026-07-14 관찰).
    const bubbleTarget = [1, 1, 1, 2, 2, 3][Math.floor(Math.random() * 6)];
    // 시간차 배달 (v2 §3.2) — 답장 최대 지연 0 이면 v1 즉시 모드 (평문 출력).
    const delayCapMin = Math.max(
      0,
      plugin.data.phone?.maxReplyDelayMinutes ?? 10
    );
    const delayed = delayCapMin > 0;
    const system =
      opts.system +
      (delayed
        ? `\n\n${buildPhoneTextIoInstructions(delayCapMin * 60, bubbleTarget)}`
        : `\n\nFor this turn, aim for roughly ${bubbleTarget} text bubble(s). Vary ` +
          `the number of texts naturally from turn to turn — do not simply match ` +
          `how many you sent before.`);

    const messages: ChatMessage[] = [{ role: "system", content: system }];
    const historyLimit = Math.max(
      1,
      plugin.data.phone?.replyHistoryLimit ?? REPLY_HISTORY_LIMIT
    );
    const history = currentThread.messages.slice(-historyLimit);
    for (const m of history) {
      // 첨부 사진은 캡션으로 전달 — 이미지 못 보는 모델에게는 캡션이 정보.
      const photo = m.image ? `[photo: ${m.image.caption || "attached photo"}]` : "";
      messages.push({
        role: m.from === "persona" ? "user" : "assistant",
        content: m.text ? (photo ? `${m.text}\n${photo}` : m.text) : photo || m.text,
      });
    }
    // 이력이 assistant 로 끝나거나 비어 있으면(선발신) 진행 지시 user 턴을 붙인다 —
    // 일부 챗 API 는 user 턴 없이 호출할 수 없다.
    if (history.length === 0 || history[history.length - 1].from === "other") {
      messages.push({
        role: "user",
        content: "[Write the sender's next incoming text now.]",
      });
    }

    let replyText = "";
    try {
      const res = await plugin.ai.chat({
        profileId: opts.profile.id,
        messages,
        label: "스텔라 폰 문자",
      });
      replyText = (res.text ?? "").trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `문자 생성 실패: ${msg}` };
    }
    if (!replyText) return { ok: false, error: "모델이 빈 응답을 보냈습니다." };

    // JSON 답장 계획 (시간차 모드) — 파싱 실패는 평문 폴백 (즉시 배달).
    const plan = delayed
      ? parsePhoneReplyPlan(replyText, delayCapMin * 60)
      : null;
    const stripPrefix = (s: string) =>
      opts.stripPrefix
        ? s.replace(new RegExp(`^${escapeRegExp(opts.stripPrefix)}\\s*:\\s*`), "")
        : s;
    const bubbles: Array<{ text: string; delaySec: number }> = plan
      ? plan.bubbles
          .map((b) => ({ ...b, text: stripPrefix(b.text) }))
          .filter((b) => b.text)
          .slice(0, REPLY_BUBBLE_LIMIT)
      : stripPrefix(replyText)
          .split(/\n{2,}/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, REPLY_BUBBLE_LIMIT)
          .map((text) => ({ text, delaySec: 0 }));

    // 생성하는 동안 다른 저장이 있었을 수 있으니 다시 읽는다.
    const data = await store.getPhoneMessages(opts.personaId);
    const thread = resolveTargetThread(data, opts.target);
    if (!thread) return { ok: false, error: "스레드를 찾을 수 없습니다." };
    const now = Date.now();

    // 읽음 (v2 §3.2) — 답장(생성)을 시작했다 = 읽었다. 읽씹(read:false)이면
    // 읽지 않은 채 "1" 유지, 저장할 답장도 없다.
    const read = !plan || plan.read;
    if (read && delayed) {
      for (const m of thread.messages) {
        if (m.from === "persona" && !m.readAt) m.readAt = now;
      }
    }
    if (!read || bubbles.length === 0) {
      // 읽씹 — 읽음 표시 변화 없이 종료. 다음 갱신 틱의 밀린 답장 후보가 된다.
      if (!read) {
        await store.savePhoneMessages(opts.personaId, data);
        return { ok: true };
      }
      return { ok: false, error: "모델이 빈 응답을 보냈습니다." };
    }

    let at = now + (plan ? Math.max(0, plan.replyDelaySec) * 1000 : 0);
    let firstDeliverAt: number | undefined;
    for (let i = 0; i < bubbles.length; i++) {
      at += Math.max(0, bubbles[i].delaySec) * 1000;
      const arrive = at + i; // 동시각 정렬 안정성
      if (firstDeliverAt === undefined) firstDeliverAt = arrive;
      const msg: PhoneMessage = {
        id: uuidv4(),
        from: "other",
        text: bubbles[i].text,
        createdAt: arrive,
        ...(arrive > now ? { deliverAt: arrive } : {}),
      };
      thread.messages.push(msg);
    }
    await store.savePhoneMessages(opts.personaId, data);
    // 자동 번역 (§4) — 켜져 있으면 도착한 답장을 바로 번역해 둔다.
    if (this.isAutoTranslateOn()) {
      void this.translateThread(opts.personaId, opts.target).catch(() => {});
    }
    return { ok: true, firstDeliverAt };
  }
}

/**
 * 문자 답장 계획 파서 (v2 §3.2) — JSON {read, replyDelaySec, messages[]} 를
 * 관대하게 읽는다. JSON 이 아니면 null (평문 폴백 = 즉시 배달).
 */
function parsePhoneReplyPlan(
  raw: string,
  capSec: number
): {
  read: boolean;
  replyDelaySec: number;
  bubbles: Array<{ text: string; delaySec: number }>;
} | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (!("messages" in p) && !("read" in p)) return null;
  const bubbles: Array<{ text: string; delaySec: number }> = [];
  for (const m of Array.isArray(p.messages) ? p.messages : []) {
    if (!m || typeof m !== "object") continue;
    const mm = m as { text?: unknown; delaySec?: unknown };
    if (typeof mm.text !== "string" || !mm.text.trim()) continue;
    bubbles.push({
      text: mm.text.trim(),
      delaySec:
        typeof mm.delaySec === "number" && Number.isFinite(mm.delaySec)
          ? Math.min(120, Math.max(0, mm.delaySec))
          : 0,
    });
  }
  return {
    read: p.read !== false,
    replyDelaySec:
      typeof p.replyDelaySec === "number" && Number.isFinite(p.replyDelaySec)
        ? Math.min(capSec, Math.max(0, p.replyDelaySec))
        : 0,
    bubbles,
  };
}

/**
 * 등록된 연락처 id 집합. contacts 배열이 없는 구버전 파일은 "문자 이력이 있는
 * 시나리오 스레드 = 등록됨"으로 간주한다 (기존 대화 유지 마이그레이션).
 */
function effectiveRegisteredIds(data: PhoneMessagesFile): Set<string> {
  if (data.contacts) return new Set(data.contacts);
  return new Set(
    data.threads
      .filter(
        (t) => t.kind === "scenario" && t.messages.length > 0 && t.scenarioId
      )
      .map((t) => t.scenarioId!)
  );
}

// snsAuthorKey 는 v2 에서 types/phone.ts 로 이동 (accounts.json 백필과 공용) —
// 기존 사용처 호환을 위해 재수출.
export { snsAuthorKey };

/** 계정 → 게시글 작성자와 같은 동일성 키 (accounts.json ↔ 피드 매칭). */
function snsAccountKey(acc: SnsAccount): string {
  return snsAuthorKey({
    kind: acc.kind === "press" ? "extra" : acc.kind,
    ...(acc.scenarioId ? { id: acc.scenarioId } : {}),
    name: acc.name,
    ...(acc.handle ? { handle: acc.handle } : {}),
  });
}

/** 대상 스레드를 찾기만 한다 (없으면 null — resolveTargetThread 와 달리 생성하지 않음). */
function findTargetThread(
  data: PhoneMessagesFile,
  target: PhoneSendTarget
): PhoneThread | null {
  if (target.kind === "scenario") {
    return (
      data.threads.find(
        (t) => t.kind === "scenario" && t.scenarioId === target.scenarioId
      ) ?? null
    );
  }
  return data.threads.find((t) => t.id === target.threadId) ?? null;
}

function resolveTargetThread(
  data: PhoneMessagesFile,
  target: PhoneSendTarget
): PhoneThread | null {
  if (target.kind === "scenario") {
    const found = data.threads.find(
      (t) => t.kind === "scenario" && t.scenarioId === target.scenarioId
    );
    if (found) return found;
    const thread: PhoneThread = {
      id: uuidv4(),
      kind: "scenario",
      scenarioId: target.scenarioId,
      messages: [],
      createdAt: Date.now(),
    };
    data.threads.push(thread);
    return thread;
  }
  return data.threads.find((t) => t.id === target.threadId) ?? null;
}

/** 마지막 문자가 수신(from=other)인 채 방치된 스레드 수 — 미응답 상한 판정. */
function countUnansweredThreads(data: PhoneMessagesFile): number {
  let n = 0;
  for (const t of data.threads) {
    const last = t.messages[t.messages.length - 1];
    if (last && last.from === "other") n++;
  }
  return n;
}

/** [min,max] 범위 랜덤. */
function pickRange([min, max]: [number, number]): number {
  return min + Math.random() * (max - min);
}

/** 최근 활동순 목록에서 순위 가중 랜덤 — 앞(최근)일수록 잘 뽑힌다. */
function pickWeightedByRank<T>(items: T[]): T {
  const weights = items.map((_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @핸들 정규화 — 앞 @ 하나 보장, 공백 제거. 빈 값이면 undefined. */
function normalizeHandle(raw: string): string | undefined {
  const h = raw.trim().replace(/^@+/, "").replace(/\s+/g, "");
  return h ? `@${h}` : undefined;
}

/** 이슈 등급별 게시글 likes 범위 (v2 §6.2). */
const ISSUE_LIKES_RANGE: readonly [number, number][] = [
  [1, 2],
  [3, 99],
  [100, 999],
  [1000, 9999],
  [10000, 99999],
];

/** 게시글 likes 를 등급 범위로 클램프 — 값이 없으면 범위 하한. */
function clampLikesToScale(likes: number | undefined, scale: number): number {
  const [min, max] = ISSUE_LIKES_RANGE[Math.min(5, Math.max(1, scale)) - 1];
  const v =
    typeof likes === "number" && Number.isFinite(likes) ? Math.floor(likes) : min;
  return Math.min(max, Math.max(min, v));
}

/**
 * 피드 표시/발췌 순서 기준 (v2 §6.4) — 붐업된 글은 붐업 시각으로 재부상.
 * 벽시계 창 없음: 세션은 한 번에 며칠씩 지나가고, 사용자 몰입은 몇 시간
 * 단위라 시간이 아니라 "게시글 누적" 기준으로 최신을 정한다 (사용자 확정).
 */
function snsEffectiveAt(post: SnsPost): number {
  return Math.max(post.createdAt, post.bumpedAt ?? 0);
}

/**
 * "to" 이름 → 그 게시글에서 그 사람이 단 마지막 답글의 1단 부모 id.
 * 2단 제한 — 부모가 이미 대댓글이면 그 부모(1단)에 붙인다.
 */
function findParentReplyId(
  post: SnsPost,
  to: string | undefined
): string | undefined {
  if (!to) return undefined;
  const norm = to.trim().toLowerCase();
  if (!norm) return undefined;
  for (let i = post.replies.length - 1; i >= 0; i--) {
    const r = post.replies[i];
    if (r.author.name.trim().toLowerCase() === norm) {
      return r.parentId ?? r.id;
    }
  }
  return undefined;
}

function base64ToArrayBuffer(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** 여러 줄 텍스트의 첫 줄 (피드 발췌용, 120자 캡). */
function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/**
 * 텍스트를 토큰 예산에 맞게 자른다. keep="tail" 이면 뒤(최신)를, "head" 면 앞을
 * 남긴다. 근사 토크나이저를 비례 축소 + 몇 번 보정으로 예산 이하로 맞춘다
 * (정확할 필요 없음 — 재료 첨부용).
 */
function trimToTokens(
  text: string,
  budget: number,
  count: (s: string) => number,
  keep: "head" | "tail"
): string {
  let t = text.trim();
  if (!t) return "";
  let tok = count(t);
  for (let i = 0; i < 5 && tok > budget && t.length > 0; i++) {
    const ratio = budget / tok;
    const targetLen = Math.max(1, Math.floor(t.length * ratio * 0.95));
    t =
      keep === "tail"
        ? t.slice(t.length - targetLen).trimStart()
        : t.slice(0, targetLen).trimEnd();
    tok = count(t);
  }
  return t;
}

/** 로어북 엔트리들을 "- 이름: 내용" 줄로 렌더. 매크로 치환 적용, 빈 내용 스킵. */
function renderLoreLines(
  entries: StellaLorebook["entries"],
  macro: { char: string; user: string }
): string {
  const lines: string[] = [];
  for (const e of entries) {
    const content = applyMacros(e.content ?? "", {
      char: macro.char,
      user: macro.user,
      variables: {},
    }).trim();
    if (!content) continue;
    const title = (e.name || e.keys?.[0] || "").trim();
    lines.push(title ? `- ${title}: ${content}` : `- ${content}`);
  }
  return lines.join("\n");
}

/**
 * 매칭된 로어북 엔트리들을 렌더 (이벤트 블록용 — 활성화 판정은 matchLorebookEntries).
 */
function renderMatchedLore(
  matched: MatchedLorebookEntry[],
  macro: { char: string; user: string }
): string {
  return renderLoreLines(
    matched.map((m) => m.entry),
    macro
  );
}

/** 책들의 활성(enabled) 엔트리 전체를 렌더 (세계 레퍼런스용 — 본문 매칭 없음). */
function renderAllLore(
  books: StellaLorebook[],
  macro: { char: string; user: string }
): string {
  const entries = books.flatMap((b) => b.entries.filter((e) => e.enabled !== false));
  return renderLoreLines(entries, macro);
}

/**
 * 가중 비복원 샘플 k개 — weight 비례 확률로 뽑는다 (§6.5 참가율 score 추출).
 * 전부 0 가중이면 앞에서부터 채운다.
 */
function pickWeightedSample<T>(items: T[], weights: number[], k: number): T[] {
  const pool = items.map((v, i) => ({ v, w: Math.max(0, weights[i] ?? 0) }));
  const out: T[] = [];
  while (out.length < k && pool.length > 0) {
    const total = pool.reduce((a, b) => a + b.w, 0);
    if (total <= 0) {
      out.push(pool.shift()!.v);
      continue;
    }
    let roll = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      roll -= pool[i].w;
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    out.push(pool.splice(idx, 1)[0].v);
  }
  return out;
}

interface SnsCommentDraft {
  /** v2 — 기존 계정 핸들 참조 (accounts.json 매칭 우선). */
  account?: string;
  author: string;
  handle?: string;
  verified?: boolean;
  /** 작성자의 출신 세계 (시나리오 이름). */
  world?: string;
  /** 이 댓글이 답하는 상대(댓글 작성자) 이름 — 대댓글용. */
  to?: string;
  text: string;
  likes?: number;
}

interface SnsActivityDraft {
  /** v2 — 기존 계정 핸들 참조 (accounts.json 매칭 우선). */
  account?: string;
  author: string;
  handle?: string;
  verified?: boolean;
  world?: string;
  /** stream_start (v2 §7.2) — 모델이 "지금 방송 중" 판정, author = 스트리머. */
  kind: "post" | "comment" | "stream_start";
  /** kind=comment — 대상 게시글 피드 id (앞 8자 프리픽스). */
  on?: string;
  to?: string;
  text: string;
  likes?: number;
  /**
   * v2 이슈 등급 — post: 이 글의 등급 판정. comment: 대상 글 등급 상향 요청
   * (내리기 불가). 엔진이 1~5 클램프.
   */
  issueScale?: number;
  /** kind=post — 첨부 사진 캡션 (PH5). */
  photo?: string;
  /** kind=post — 게시글에 이미 달려 나오는 댓글들. */
  comments?: SnsCommentDraft[];
  /**
   * v2 §6.4 — 이 활동이 새 최상단 이슈 선언. post = 이 글 자체가,
   * comment = 대상 글(유저 글이 터진 경우)이 현 최상단 이슈를 서사적으로
   * 이겼다는 모델 판정. 배치당 1개만 반영.
   */
  boom?: boolean;
}

/**
 * 스텔라튜브 반응 파서 (v2 §7.3) — JSON {viewers, streamState, chat[]} 를
 * 관대하게 읽는다. 실패는 null (그 노드 반응 없음).
 */
function parseTubeReaction(raw: string): {
  viewers?: number;
  streamState: "on" | "closing";
  chat: Array<{
    account?: string;
    name?: string;
    handle?: string;
    world?: string;
    text: string;
    donation?: number;
  }>;
} | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const chat: Array<{
    account?: string;
    name?: string;
    handle?: string;
    world?: string;
    text: string;
    donation?: number;
  }> = [];
  for (const c of Array.isArray(p.chat) ? p.chat : []) {
    if (!c || typeof c !== "object") continue;
    const cc = c as Record<string, unknown>;
    const text = str(cc.text);
    if (!text) continue;
    chat.push({
      account: str(cc.account),
      name: str(cc.name) ?? str(cc.author),
      handle: str(cc.handle),
      world: str(cc.world),
      text,
      donation:
        typeof cc.donation === "number" && Number.isFinite(cc.donation)
          ? cc.donation
          : undefined,
    });
  }
  return {
    viewers:
      typeof p.viewers === "number" && Number.isFinite(p.viewers)
        ? p.viewers
        : undefined,
    streamState: p.streamState === "closing" ? "closing" : "on",
    chat,
  };
}

/** 모델 응답에서 SNS 활동 JSON 배열을 관대하게 파싱한다 (실패는 빈 배열). */
function parseSnsActivities(raw: string): SnsActivityDraft[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const out: SnsActivityDraft[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    // 방송 시작 판정 (v2 §7.2) — text 없이 스트리머 이름만 온다.
    if (a.kind === "stream_start") {
      const streamer = str(a.streamer) ?? str(a.account) ?? str(a.author);
      if (streamer) out.push({ author: streamer, kind: "stream_start", text: "" });
      continue;
    }
    // v2: account(핸들 참조)만 있고 author 가 없어도 수용 — 엔진이 계정에서 복원.
    const author = str(a.author) ?? str(a.account);
    const text = str(a.text);
    if (!author || !text) continue;
    // 구버전 호환: kind "reply"+replyTo 도 comment 로 받는다.
    const kind = a.kind === "comment" || a.kind === "reply" ? "comment" : "post";
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    const comments: SnsCommentDraft[] = [];
    for (const c of Array.isArray(a.comments) ? a.comments : []) {
      if (!c || typeof c !== "object") continue;
      const cc = c as Record<string, unknown>;
      const cAuthor = str(cc.author) ?? str(cc.account);
      const cText = str(cc.text);
      if (!cAuthor || !cText) continue;
      comments.push({
        account: str(cc.account),
        author: cAuthor,
        handle: str(cc.handle),
        verified: cc.verified === true,
        world: str(cc.world),
        to: str(cc.to),
        text: cText,
        likes: num(cc.likes),
      });
    }
    out.push({
      account: str(a.account),
      author,
      handle: str(a.handle),
      verified: a.verified === true,
      world: str(a.world),
      kind,
      on: str(a.on) ?? str(a.replyTo),
      to: str(a.to),
      text,
      likes: num(a.likes),
      issueScale: num(a.issueScale),
      photo: str(a.photo),
      ...(a.boom === true ? { boom: true } : {}),
      ...(comments.length > 0 ? { comments } : {}),
    });
  }
  return out;
}
