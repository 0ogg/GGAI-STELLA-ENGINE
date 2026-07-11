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
 * 트리거는 임시 명령("선채팅 받아보기") — 스케줄러/누적 상한은 다음 슬라이스.
 */
import type StellaEnginePlugin from "../main";
import type { SessionNode } from "../types/session";
import { planSessionRequest } from "../util/build-session-context";
import { buildSpans, spansToText } from "../util/session-text";
import { CHAT_MESSAGE_SEPARATOR } from "../util/chat-messages";
import { uuidv4 } from "../util/uuid";

export type ProactiveResult = { ok: true } | { ok: false; error: string };

/** 경과 시간을 영어 지시문용으로 거칠게 (1분 미만이면 빈 문자열 = 언급 안 함). */
function formatIdleEn(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export class ProactiveService {
  /** 세션별 실행 중 가드 — 같은 세션에 선채팅이 겹쳐 발사되지 않게. */
  private inFlight = new Set<string>();

  constructor(private plugin: StellaEnginePlugin) {}

  /**
   * 세션 하나에 선채팅 메시지 1개를 생성해 붙인다.
   * 실패는 throw 대신 결과 객체 — 호출자(명령/스케줄러)가 알림 여부를 정한다.
   */
  async send(sessionFile: string): Promise<ProactiveResult> {
    if (this.inFlight.has(sessionFile)) {
      return { ok: false, error: "이미 선채팅을 생성하는 중입니다." };
    }
    this.inFlight.add(sessionFile);
    try {
      return await this.sendInner(sessionFile);
    } finally {
      this.inFlight.delete(sessionFile);
    }
  }

  private async sendInner(sessionFile: string): Promise<ProactiveResult> {
    const plugin = this.plugin;
    const session = await plugin.store.getSession(sessionFile);
    if (!session) return { ok: false, error: "세션을 불러올 수 없습니다." };
    if (session.meta.mode !== "chat") {
      return { ok: false, error: "선채팅은 채팅 세션에서만 지원합니다." };
    }

    // 열린 세션창의 미저장 편집 커밋 — 방금 친 메시지가 컨텍스트에 빠지지 않게.
    await plugin.flushSessionEdits(sessionFile);

    const plan = await planSessionRequest(plugin, sessionFile, {});
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
    const charName = plan.meta.scenarioName?.trim() || "Character";
    let instruction =
      `[Some time has passed and ${userName} hasn't sent anything. ` +
      `${charName} decides to reach out first. Write ${charName}'s next chat ` +
      `message initiating contact — natural, in character, fitting the current ` +
      `situation. Do not write ${userName}'s lines.]`;
    // 실시간 채팅 — 현재 시간과 마지막 대화 후 경과를 알려줘 "새벽인데 안 자?"
    // 같은 시간 인지 발화를 가능하게 한다.
    if (session.meta.proactive?.realtime === true) {
      const now = new Date();
      const lastAt =
        session.nodes[session.meta.activeLeafId]?.createdAt ?? now.getTime();
      const idle = formatIdleEn(now.getTime() - lastAt);
      instruction +=
        ` [Right now it is ${now.toLocaleString()} (${now.toLocaleDateString(
          undefined,
          { weekday: "long" }
        )}). ${idle ? `About ${idle} have passed since the last message.` : ""}]`;
    }

    const res = await plugin.ai.chat({
      profileId: plan.profile.id,
      messages: [...plan.payload.messages, { role: "user", content: instruction }],
      paramsOverride: plan.paramsOverride,
      label: "선채팅",
    });
    const text = (res.text ?? "").trim();
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
