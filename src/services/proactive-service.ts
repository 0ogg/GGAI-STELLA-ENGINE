/**
 * ProactiveService — 선채팅(캐릭터가 먼저 말 걸기) 실행기 (P1).
 *
 * 세션창이 열려 있지 않아도 동작해야 하므로 뷰의 runGeneration 을 쓰지 않고,
 * 같은 전송본 단일 경로(planSessionRequest)로 그 세션의 평소 컨텍스트(모델/
 * 페르소나/로어북/요약)를 조립한 뒤, "사용자 응답이 없어 {{char}}가 먼저 말을
 * 건다"는 지시문을 끝에 얹어 비스트리밍으로 1회 생성한다. 결과는 일반 ai 노드
 * (+`proactive` 플래그)로 저장 — 브랜치/번역/요약/알림(N0) 체계에 그대로 편승.
 *
 * v1 범위: 챗 세션(meta.mode === "chat") + 챗 페이로드(챗 프로필) 전용.
 *
 * 스케줄러 (P1 슬라이스 2):
 *  - 예약은 `PluginData.proactiveSchedule` (key = sessionFile, `{ nextAt }`) 에
 *    영속 — 재시작해도 발화 예정 시각이 유지된다. 간격은 전역 빈도 성향
 *    (`settings.proactiveFrequency`) 범위 안에서 지터(랜덤)로 뽑는다.
 *  - 저빈도 틱(1분)이 기한 지난 예약을 확인하고 **한 번에 한 세션만** 발화.
 *  - 사용자 활동(그 세션의 본문 변경)마다 타이머 리셋 — 대화 중엔 안 끼어들고,
 *    마지막 활동에서 간격만큼 지난 뒤에 온다. 켜기/끄기는 session-changed 로 감지.
 *  - 발화 전 판정: 안 읽은 응답이 누적 상한(`settings.proactiveMaxUnread`)만큼
 *    쌓였으면 쉼(N0 unread 재사용), 지금 보고 있는 세션이면 다음 기회로.
 */
import type StellaEnginePlugin from "../main";
import type { SessionChangeDetail } from "../state/store";
import type { SessionNode, StellaSession } from "../types/session";
import { planSessionRequest } from "../util/build-session-context";
import { trimChatCompletionOutput } from "../util/text-completion-prompt";
import { buildSpans, spansToText } from "../util/session-text";
import { buildChatMessages, CHAT_MESSAGE_SEPARATOR } from "../util/chat-messages";
import {
  parseTalkativeness,
  pickNextSpeaker,
  type GroupSpeakerCandidate,
} from "../util/group-speaker";
import { formatIdleEn } from "../util/idle-duration";
import { uuidv4 } from "../util/uuid";
import { isViewingSession } from "../views/session-host";

export type ProactiveResult = { ok: true } | { ok: false; error: string };

/** 선채팅 발화 예약 1건 — PluginData.proactiveSchedule 값. */
export interface ProactiveScheduleEntry {
  /** 다음 발화 예정 시각 (epoch ms, 지터 반영). */
  nextAt: number;
  /**
   * 사용자가 이 세션을 마지막으로 본 시각 (epoch ms) — 복귀 독촉의 부재 기준.
   * 예약 시드 시 현재 시각으로 초기화, 세션을 다시 보면 갱신(noteSessionSeen).
   */
  seenAt?: number;
  /**
   * 이번 부재 동안 이미 발화한 복귀 독촉 단계 수 (0~RETURN_NUDGE_TIERS_MS.length).
   * 세션을 다시 보면 0으로 리셋 — 다음 부재에 처음부터 다시 독촉한다.
   */
  nudged?: number;
}

/** 스케줄러 틱 주기 — 저빈도. 예약 확인만 하므로 가볍다. */
const TICK_MS = 60_000;

/** 빈도 성향별 발화 간격 범위 (ms) — 이 안에서 매번 랜덤(지터). */
const FREQ_RANGES_MS: Record<"low" | "mid" | "high", [number, number]> = {
  low: [3 * 3_600_000, 8 * 3_600_000], // 가끔: 3~8시간
  mid: [1 * 3_600_000, 3 * 3_600_000], // 보통: 1~3시간
  high: [15 * 60_000, 45 * 60_000], // 자주: 15~45분
};

/**
 * 복귀 독촉 경계 (ms) — 마지막 접속 후 부재가 이 경계를 넘을 때마다 상한을 뚫고
 * "요즘 왜 안 와…" 특별 발화를 1회씩 허용한다. 상한 트랙과 독립. 오름차순.
 */
const DAY_MS = 24 * 3_600_000;
const RETURN_NUDGE_TIERS_MS = [7 * DAY_MS, 30 * DAY_MS];

export class ProactiveService {
  /** 세션별 실행 중 가드 — 같은 세션에 선채팅이 겹쳐 발사되지 않게. */
  private inFlight = new Set<string>();

  constructor(private plugin: StellaEnginePlugin) {}

  // ─────────────────────────── 스케줄러 ───────────────────────────

  /** 다음 발화까지의 간격 — 전역 빈도 성향 범위 안에서 지터. */
  private pickDelayMs(): number {
    const freq = this.plugin.data.settings?.proactiveFrequency ?? "mid";
    const [min, max] = FREQ_RANGES_MS[freq] ?? FREQ_RANGES_MS.mid;
    return min + Math.random() * (max - min);
  }

  /**
   * 예약 갱신/삭제 + 영속화. nextAt=null 이면 예약 삭제.
   * 기존 엔트리의 seenAt/nudged(복귀 독촉 상태)는 보존한다 — nextAt 리셋이
   * 부재 진행을 지우지 않게. 새로 시드되는 예약은 seenAt=현재 시각으로 초기화.
   */
  private async setSchedule(
    sessionFile: string,
    nextAt: number | null
  ): Promise<void> {
    const map = { ...(this.plugin.data.proactiveSchedule ?? {}) };
    if (nextAt === null) {
      if (map[sessionFile] === undefined) return;
      delete map[sessionFile];
    } else {
      const prev = map[sessionFile];
      map[sessionFile] = {
        ...prev,
        nextAt,
        seenAt: prev?.seenAt ?? Date.now(),
      };
    }
    await this.plugin.savePluginData({ proactiveSchedule: map });
  }

  /**
   * 사용자가 세션을 보기 시작함 — 복귀 독촉 부재 시계를 리셋한다.
   * `rememberActiveSessionFile`(활성 세션 변경 단일 지점)에서 호출. 예약이 없는
   * 세션(선채팅 꺼짐)이면 아무것도 하지 않는다.
   */
  async noteSessionSeen(sessionFile: string): Promise<void> {
    const prev = this.plugin.data.proactiveSchedule?.[sessionFile];
    if (!prev) return;
    // 이미 방금 본 것으로 기록돼 있고 독촉 진행도 없으면 불필요한 저장 생략.
    if ((prev.nudged ?? 0) === 0 && Date.now() - (prev.seenAt ?? 0) < TICK_MS) {
      return;
    }
    const map = { ...this.plugin.data.proactiveSchedule };
    map[sessionFile] = { ...prev, seenAt: Date.now(), nudged: 0 };
    await this.plugin.savePluginData({ proactiveSchedule: map });
  }

  /** 이 세션에 지금 발화 가능한 복귀 독촉 단계 수 (0=없음, 1~N=그 단계까지 부재). */
  private dueReturnNudge(entry: ProactiveScheduleEntry | undefined): number {
    if (!entry) return 0;
    const away = Date.now() - (entry.seenAt ?? Date.now());
    let eligible = 0;
    for (const tier of RETURN_NUDGE_TIERS_MS) if (away >= tier) eligible++;
    return eligible > (entry.nudged ?? 0) ? eligible : 0;
  }

  /**
   * 스케줄러 시작 — 플러그인 onload 에서 1회.
   *  - session-changed 구독: 켜기/끄기 반영 + 사용자 활동 시 타이머 리셋
   *  - 1분 틱: 기한 지난 예약 확인, 1회 1세션 발화
   *  - 시작 스윕 + 캐치업: 예약 시드/정리 후, 앱이 꺼져 있는 동안 밀린 것 처리
   */
  startScheduler(): void {
    const plugin = this.plugin;
    plugin.registerEvent(
      plugin.store.on(
        "session-changed",
        (file: string, detail?: SessionChangeDetail) => {
          void this.reconcileSchedule(file, detail).catch((err) =>
            console.warn("[GGAI Stella] 선채팅 예약 갱신 실패:", err)
          );
        }
      )
    );
    plugin.registerInterval(
      window.setInterval(() => {
        void this.tick().catch((err) =>
          console.warn("[GGAI Stella] 선채팅 스케줄러 틱 실패:", err)
        );
      }, TICK_MS)
    );
    plugin.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => {
        void (async () => {
          await this.sweepSchedules();
          await this.startupCatchUp();
        })().catch((err) =>
          console.warn("[GGAI Stella] 선채팅 예약 스윕/캐치업 실패:", err)
        );
      }, 5_000);
    });
  }

  /**
   * 시작 캐치업 — 앱을 켠 순간, 닫혀 있던 동안 지나버린 예약을 처리한다.
   * 선채팅은 앱이 켜져 있을 때만 오므로 "다시 열었을 때 밀린 것"을 잡아주는 지점.
   *  - 가장 오래 밀린 **1세션만 즉시** 발화(`fireScheduled` — 복귀 독촉/상한/보기중
   *    판정 그대로 태운다). 켜자마자 "왔네?" 한 통으로 복귀를 알린다.
   *  - 나머지 밀린 예약은 지금부터의 새 시각으로 흩뿌려 재예약 → 한꺼번에 쏟아지지 않고
   *    이후 평소 틱이 하나씩 처리한다(밀린 것 폭탄 방지). seenAt/nudged 는 보존되므로
   *    각자의 복귀 독촉도 재예약된 시각에 그대로 판정된다.
   */
  private async startupCatchUp(): Promise<void> {
    const map = this.plugin.data.proactiveSchedule;
    if (!map) return;
    const now = Date.now();
    const overdue = Object.entries(map)
      .filter(([, e]) => e.nextAt <= now)
      .sort((a, b) => a[1].nextAt - b[1].nextAt);
    if (overdue.length === 0) return;
    for (const [file] of overdue.slice(1)) {
      await this.setSchedule(file, now + this.pickDelayMs());
    }
    await this.fireScheduled(overdue[0][0]);
  }

  /**
   * 세션 변경 → 예약 조정. 켜져 있으면 예약 보장 + 본문 변경(=대화 활동)마다
   * 타이머 리셋(마지막 활동 기준 간격), 꺼져 있으면 예약 삭제.
   */
  private async reconcileSchedule(
    file: string,
    detail?: SessionChangeDetail
  ): Promise<void> {
    const session = await this.plugin.store.getSession(file);
    if (!session) return;
    const enabled =
      session.meta.mode === "chat" && session.meta.proactive?.enabled === true;
    const entry = this.plugin.data.proactiveSchedule?.[file];
    if (!enabled) {
      if (entry) await this.setSchedule(file, null);
      return;
    }
    // settings-only 변경(모델/파라미터 등)은 대화 활동이 아니므로 리셋하지 않는다.
    const settingsOnly =
      detail?.kinds !== undefined && detail.kinds.every((k) => k === "settings");
    if (!entry || !settingsOnly) {
      await this.setSchedule(file, Date.now() + this.pickDelayMs());
    }
  }

  /** 틱 — 기한 지난 예약 중 가장 오래된 것 하나만 발화 (1회 1세션). */
  private async tick(): Promise<void> {
    const map = this.plugin.data.proactiveSchedule;
    if (!map) return;
    const now = Date.now();
    const due = Object.entries(map)
      .filter(([, e]) => e.nextAt <= now)
      .sort((a, b) => a[1].nextAt - b[1].nextAt);
    if (due.length === 0) return;
    await this.fireScheduled(due[0][0]);
  }

  /** 예약 발화 — 판정 후 send. 성공/보류/실패 모두 다음 예약을 다시 잡는다. */
  private async fireScheduled(file: string): Promise<void> {
    const plugin = this.plugin;
    const postpone = () => this.setSchedule(file, Date.now() + this.pickDelayMs());

    const session = await plugin.store.getSession(file);
    if (
      !session ||
      session.meta.mode !== "chat" ||
      session.meta.proactive?.enabled !== true
    ) {
      // 세션이 사라졌거나 꺼짐 — 예약만 정리.
      await this.setSchedule(file, null);
      return;
    }
    // 지금 보면서 대화 중인 세션엔 끼어들지 않는다 — 다음 기회로 (독촉/일반 공통).
    if (isViewingSession(plugin.app.workspace, file)) {
      await postpone();
      return;
    }
    if (!plugin.ai.isAvailable()) {
      await postpone();
      return;
    }

    // ── 복귀 독촉: 마지막 접속 후 부재가 경계(7일/30일)를 넘고 그 단계를 아직
    // 안 보냈으면, 누적 상한을 뚫고 1회 특별 발화한다 ("요즘 왜 안 와…"). ──
    const nudgeTier = this.dueReturnNudge(plugin.data.proactiveSchedule?.[file]);
    if (nudgeTier > 0) {
      const result = await this.send(file, { returnNudge: true });
      if (result.ok) await this.markNudged(file, nudgeTier);
      else console.warn("[GGAI Stella] 복귀 독촉 발화 실패:", result.error);
      await postpone();
      return;
    }

    // 누적 상한 (N0 unread 재사용) — 안 읽은 응답이 상한만큼 쌓이면 그 세션은 쉼.
    const cap = plugin.data.settings?.proactiveMaxUnread ?? 2;
    if (cap > 0 && (plugin.getSessionUnread(file)?.count ?? 0) >= cap) {
      await postpone();
      return;
    }
    const result = await this.send(file);
    if (!result.ok) {
      console.warn("[GGAI Stella] 선채팅 자동 발화 실패:", result.error);
    }
    // 성공 시 자기 저장의 session-changed 리셋과 겹치지만 값이 같아 무해.
    await postpone();
  }

  /** 복귀 독촉 발화 후 그 단계까지 완료 기록 — 같은 부재에 재발화하지 않게. */
  private async markNudged(file: string, tier: number): Promise<void> {
    const prev = this.plugin.data.proactiveSchedule?.[file];
    if (!prev) return;
    const map = { ...this.plugin.data.proactiveSchedule };
    map[file] = { ...prev, nudged: tier };
    await this.plugin.savePluginData({ proactiveSchedule: map });
  }

  /**
   * 시작 스윕 — 재시작/과거 데이터로 예약이 어긋난 세션 보정.
   * 켜져 있는데 예약 없음 → 시드, 꺼짐/사라진 세션의 예약 → 정리.
   */
  private async sweepSchedules(): Promise<void> {
    const plugin = this.plugin;
    const known = new Set<string>();
    for (const sc of await plugin.store.getScenarios()) {
      for (const s of await plugin.store.getSessions(sc.folder)) {
        known.add(s.sessionFile);
        const enabled =
          s.session.meta.mode === "chat" &&
          s.session.meta.proactive?.enabled === true;
        const entry = plugin.data.proactiveSchedule?.[s.sessionFile];
        if (enabled && !entry) {
          await this.setSchedule(s.sessionFile, Date.now() + this.pickDelayMs());
        } else if (!enabled && entry) {
          await this.setSchedule(s.sessionFile, null);
        }
      }
    }
    for (const file of Object.keys(plugin.data.proactiveSchedule ?? {})) {
      if (!known.has(file)) await this.setSchedule(file, null);
    }
  }

  /**
   * 세션 하나에 선채팅 메시지 1개를 생성해 붙인다.
   * 실패는 throw 대신 결과 객체 — 호출자(명령/스케줄러)가 알림 여부를 정한다.
   */
  async send(
    sessionFile: string,
    opts: { returnNudge?: boolean } = {}
  ): Promise<ProactiveResult> {
    if (this.inFlight.has(sessionFile)) {
      return { ok: false, error: "이미 선채팅을 생성하는 중입니다." };
    }
    this.inFlight.add(sessionFile);
    try {
      return await this.sendInner(sessionFile, opts);
    } finally {
      this.inFlight.delete(sessionFile);
    }
  }

  /**
   * 그룹 챗 선채팅의 발화자 — 멤버 중 먼저 말 걸 1명을 뽑는다 (P1 × G2).
   * 챗 뷰의 다음 발화자 결정과 같은 규칙(이름 불림 > 수다스러움 가중 랜덤 >
   * 미발화 보정, 연속 발화 상한). 그룹이 아니거나 멤버가 1명 이하면 null.
   */
  private async resolveGroupSpeaker(
    session: StellaSession
  ): Promise<{ id: string; name: string } | null> {
    if (session.meta.mode !== "chat" || !session.meta.groupId) return null;
    const gi = await this.plugin.store
      .getGroupById(session.meta.groupId)
      .catch(() => null);
    if (!gi || gi.group.members.length < 2) return null;

    const scenarios = await this.plugin.store.getScenarios().catch(() => []);
    const byId = new Map(
      scenarios.map(
        (i) => [i.scenario.data?.extensions?.stella?.id, i] as const
      )
    );
    const candidates: GroupSpeakerCandidate[] = gi.group.members.flatMap((m) => {
      const sc = byId.get(m.scenarioId);
      const name = sc?.scenario.data?.name?.trim();
      if (!name) return [];
      return [
        {
          scenarioId: m.scenarioId,
          name,
          talkativeness: parseTalkativeness(
            (sc?.scenario.data as any)?.extensions?.talkativeness
          ),
        },
      ];
    });
    if (candidates.length < 2) return null;

    const hostId = session.meta.scenarioId;
    const msgs = buildChatMessages(session);
    const last = msgs[msgs.length - 1];
    const speakerOf = (nodeId: string) =>
      session.nodes[nodeId]?.speaker ?? hostId;
    const lastSpeakerId =
      last?.role === "assistant" ? speakerOf(last.nodeId) : null;
    let streak = 0;
    if (lastSpeakerId) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== "assistant") break;
        if (speakerOf(msgs[i].nodeId) !== lastSpeakerId) break;
        streak++;
      }
    }
    const recentSpeakerIds = msgs
      .filter((m) => m.role === "assistant")
      .slice(-4)
      .map((m) => speakerOf(m.nodeId));

    const pickedId =
      pickNextSpeaker({
        candidates,
        lastMessageText: last?.text ?? "",
        lastSpeakerId,
        lastSpeakerStreak: streak,
        maxConsecutiveSame: gi.group.maxConsecutiveSpeaker,
        recentSpeakerIds,
      }) ?? hostId;
    const name =
      candidates.find((c) => c.scenarioId === pickedId)?.name ??
      candidates.find((c) => c.scenarioId === hostId)?.name ??
      "Character";
    return { id: pickedId, name };
  }

  private async sendInner(
    sessionFile: string,
    opts: { returnNudge?: boolean }
  ): Promise<ProactiveResult> {
    const plugin = this.plugin;
    const session = await plugin.store.getSession(sessionFile);
    if (!session) return { ok: false, error: "세션을 불러올 수 없습니다." };
    if (session.meta.mode !== "chat") {
      return { ok: false, error: "선채팅은 채팅 세션에서만 지원합니다." };
    }

    // 열린 세션창의 미저장 편집 커밋 — 방금 친 메시지가 컨텍스트에 빠지지 않게.
    await plugin.flushSessionEdits(sessionFile);

    // 그룹 챗이면 먼저 말 걸 발화자를 뽑는다 (수다스러움 가중 랜덤 · 이름 불림 등).
    // 그 발화자 카드가 풀 카드로 조립되도록 speakerId 를 전송본에 넘긴다.
    const groupSpeaker = await this.resolveGroupSpeaker(session);
    const plan = await planSessionRequest(
      plugin,
      sessionFile,
      groupSpeaker ? { speakerId: groupSpeaker.id } : {}
    );
    if ("error" in plan) return { ok: false, error: plan.error };
    if (plan.payload.kind !== "chat") {
      return {
        ok: false,
        error: "선채팅은 챗 모델 프로필에서만 지원합니다 (텍스트 컴플리션 제외).",
      };
    }

    // 선발화 지시문 — 평소 컨텍스트 끝에 user 지시로 얹는다 (이어쓰기 이음새
    // 보정과 같은 방식). 이름은 매크로 대신 실제 값으로 (payload 는 이미 매크로
    // 치환이 끝난 상태라 여기서 {{char}} 를 쓰면 안 풀린다).
    const { profile: userProfile } = await plugin.resolveActiveUserProfile();
    const userName = userProfile?.name?.trim() || "User";
    // 그룹이면 뽑힌 발화자 이름, 아니면 호스트(시나리오) 이름.
    const charName =
      groupSpeaker?.name ?? (plan.meta.scenarioName?.trim() || "Character");
    const now = new Date();
    const lastAt =
      session.nodes[session.meta.activeLeafId]?.createdAt ?? now.getTime();
    const idle = formatIdleEn(now.getTime() - lastAt);
    // 복귀 독촉 = 오래 부재한 사용자에게 안부를 묻는 특별 발화, 일반 = 평범한 선발화.
    let instruction = opts.returnNudge
      ? `[${userName} has been away for a long time` +
        `${idle ? ` (about ${idle})` : ""} without replying. ${charName} reaches ` +
        `out again — a short, in-character message wondering where ${userName} ` +
        `has been or that they are missed, gently checking in. Keep it natural, ` +
        `not clingy or desperate. Do not write ${userName}'s lines.]`
      : `[Some time has passed and ${userName} hasn't sent anything. ` +
        `${charName} decides to reach out first. Write ${charName}'s next chat ` +
        `message initiating contact — natural, in character, fitting the current ` +
        `situation. Do not write ${userName}'s lines.]`;
    // 실시간 채팅 — 현재 시간과 마지막 대화 후 경과를 알려줘 "새벽인데 안 자?"
    // 같은 시간 인지 발화를 가능하게 한다. 컨텍스트 맨 끝에 붙는 문장이라 모델이
    // "가장 중요한 지시"로 읽고 매번 시간 얘기부터 꺼내는 집착이 관찰됨(2026-07-12)
    // — 배경 참고용임을 명시해 자연스러울 때만 반영하게 한다.
    if (session.meta.proactive?.realtime === true) {
      instruction +=
        ` [Background context only: it is currently ${now.toLocaleString()} (${now.toLocaleDateString(
          undefined,
          { weekday: "long" }
        )})${idle ? `, about ${idle} since the last message` : ""}. ` +
        `This is for situational awareness — do not bring up the time or elapsed ` +
        `duration unless it is natural for the conversation.]`;
    }

    const res = await plugin.ai.chat({
      profileId: plan.profile.id,
      messages: [...plan.payload.messages, { role: "user", content: instruction }],
      paramsOverride: plan.paramsOverride,
      label: opts.returnNudge ? "복귀 독촉" : "선채팅",
    });
    let text = (res.text ?? "").trim();
    // 그룹 챗 세션 — 다른 멤버/유저 턴 절단 + 발화자 라벨 제거 (챗 뷰와 동일).
    if (plan.payload.names) {
      text = trimChatCompletionOutput(text, plan.payload.names, {
        dropIncompleteTail: false,
      });
    }
    if (!text) return { ok: false, error: "모델이 빈 응답을 보냈습니다." };

    // 일반 ai 노드로 저장 — 챗 뷰의 이어쓰기와 같은 형태 (구분자 + ai span).
    const parentId = session.meta.activeLeafId;
    const parentText = spansToText(buildSpans(session, parentId));
    const sep = parentText.length > 0 ? CHAT_MESSAGE_SEPARATOR : "";
    const node: SessionNode = {
      id: uuidv4(),
      parent: parentId,
      kind: "ai-continue",
      proactive: true,
      patches: [{ op: "append", spans: [{ author: "ai", text: sep + text }] }],
      createdAt: Date.now(),
      gen: {
        model: plan.profile.model,
        profile: plan.profile.name,
        tokensIn: res.usage.inputTokens,
        tokensOut: res.usage.outputTokens,
      },
    };
    // 그룹 챗 — 이 선발화의 발화자 귀속 (말풍선 라벨/아바타/다음 발화자 결정 재료).
    if (groupSpeaker) node.speaker = groupSpeaker.id;
    session.nodes[node.id] = node;
    session.meta.activeLeafId = node.id;
    session.meta.modifiedAt = Date.now();
    session.meta.variables = plan.updatedVariables;
    session.meta.timingStates = plan.output.updatedTimingStates;
    await plugin.store.saveSession(sessionFile, session);

    // 생성-완료 훅 — 자동 번역/삽화/요약 + 알림(N0)이 일반 생성과 똑같이 돈다.
    await plugin.extensions.runGenerationComplete({
      sessionFile,
      nodeId: node.id,
      generatedText: text,
      parentText,
      profile: plan.profile,
    });
    return { ok: true };
  }
}
