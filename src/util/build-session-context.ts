import type StellaEnginePlugin from "../main";
import type { GenerationProfileLite } from "../services/ai-service";
import type { StellaLorebook } from "../types/lorebook";
import type { ActiveSettings } from "../types/preset";
import type { StellaSession } from "../types/session";
import {
  buildContext,
  buildFallbackPreset,
  type ChatMessage,
  type ContextBuilderInputV2,
  type ContextBuilderOutputV2,
} from "./context-builder";
import { buildChatLog } from "./chat-messages";

/** 챗 세션 로그 — excludeTail 이면 끝의 assistant 메시지 1개 제외 (챗 재생성 전용). */
function buildChatSessionLog(
  session: StellaSession,
  leafId: string,
  excludeTail: boolean
): { role: "user" | "assistant"; content: string }[] {
  const log = buildChatLog(session, leafId);
  if (excludeTail && log.length > 0 && log[log.length - 1].role === "assistant") {
    log.pop();
  }
  return log;
}
import {
  buildAnchorInstruction,
  currentParagraphLength,
  extractAnchorSentence,
} from "./continuation-anchor";
import { paramsToOverride } from "./generation-params";
import { buildGroupMemberLorebook } from "./group-lorebook";
import { formatIdleEn } from "./idle-duration";
import { resolveNaiFormat, resolveRoleMode } from "./model-kind-policy";
import { normalizeMessagesForChat } from "./normalize-messages";
import { resolveActiveLorebooks } from "./resolve-active-lorebooks";
import { scanPrompts } from "./scan-prompts";
import { buildSessionLog } from "./session-view-logic";
import { buildSpans, spansToText } from "./session-text";
import {
  applyChatTurnNames,
  buildNaiFormatSegments,
  buildTextCompletionSegments,
  segmentsToString,
  type ChatCompletionNames,
  type PromptSegment,
} from "./text-completion-prompt";

/**
 * 세션 → "API 에 보낼 단 하나의 전송본" 단일 진실 소스.
 *
 * 대전제: 미리보기(현재 컨텍스트 확인)와 실제 생성은 **반드시 같은 코드 경로**로
 * 전송본을 만든다. 그래야 사용자가 미리보기에서 본 그대로가 모델에 전송되고,
 * 출력 문제의 원인을 미리보기만 보고 짚을 수 있다.
 *
 * - text 프로필: 실제로 generate() 에 넣는 단일 문자열(`prompt`) + 색칠용 세그먼트.
 * - chat 프로필: 실제로 chatStream() 에 넣는 메시지 배열(`messages`) — normalize 적용 후.
 *
 * 이 함수는 세션 객체를 **변형하지 않는다**. macro setvar/로어북 timing 의 갱신값은
 * 결과(`updatedVariables` / `output.updatedTimingStates`)로 돌려주고, 영속 여부는
 * 호출자가 정한다(생성은 저장, 미리보기는 폐기).
 */

export interface SessionRequestPayloadText {
  kind: "text";
  /** 정확히 generate() 에 보내는 문자열. */
  prompt: string;
  /** 위 문자열의 파트별 세그먼트 — 이어붙이면 prompt 와 byte 단위로 같다. */
  segments: PromptSegment[];
  naiFormat: boolean;
  /**
   * 챗 세션 전용 — 히스토리가 `이름: ` 턴으로 평탄화됐고 끝에 `{{char}}:` 오프너가
   * 붙어 있다는 표시. 생성 결과는 trimChatCompletionOutput 으로 유저 턴을 잘라야
   * 한다 (ST 스탑 스트링 대응 — NAI 는 문자열 스탑을 못 받아 후처리로 절단).
   */
  chatNames?: ChatCompletionNames;
}

export interface SessionRequestPayloadChat {
  kind: "chat";
  /** 정확히 chatStream() 에 보내는 메시지 (normalizeMessagesForChat 적용 후). */
  messages: ChatMessage[];
  /**
   * 이어쓰기 이음새 보정 앵커 — 본문 마지막 문장. 값이 있으면 전송본 끝에
   * "이 문장을 그대로 받아쓰며 시작하라"는 지시문이 붙어 있고, 생성 결과의
   * 앞머리에서 이 문장 반복을 후처리로 제거해야 한다 (continuation-anchor.ts).
   */
  anchor?: string;
}

export type SessionRequestPayload =
  | SessionRequestPayloadText
  | SessionRequestPayloadChat;

export interface SessionRequestMeta {
  sessionName: string;
  scenarioName: string;
  leafId: string;
  promptSetName: string | null;
  lorebookCount: number;
  tokenBudget: number;
}

export interface SessionRequestPlan {
  session: StellaSession;
  profile: GenerationProfileLite;
  output: ContextBuilderOutputV2;
  /** API 전송본. 미리보기와 생성이 둘 다 이 값만 쓴다. */
  payload: SessionRequestPayload;
  /** Core 에 넘기는 paramsOverride. 미리보기는 사용 안 함. */
  paramsOverride: Record<string, unknown> | undefined;
  /** macro setvar 등으로 갱신된 변수 — 생성 시 세션에 다시 저장한다. */
  updatedVariables: Record<string, string>;
  meta: SessionRequestMeta;
}

export interface PlanSessionRequestOptions {
  /** 컨텍스트를 만들 leaf. 기본은 활성 leaf(=이어쓰기가 보낼 지점). */
  leafId?: string;
  /**
   * 챗 재생성 전용 — 대화 로그 끝의 assistant 메시지 1개를 컨텍스트에서 제외한다.
   * (마지막 AI 메시지 뒤에 편집 노드가 붙어 있어 leaf 를 부모로 옮길 수 없을 때,
   * "갈아끼울 메시지"가 모델에게 자기 이전 답으로 보이지 않게 한다.)
   */
  excludeTailAssistant?: boolean;
  /**
   * 이 생성 1회에만 쓰는 활성 설정 오버라이드 (프리셋 랜덤 순환 등).
   * 세션 meta/PluginData 에는 아무것도 쓰지 않는다 — 전송본 조립에서만 덮는다.
   * 키가 존재하는 필드만 덮으므로(spread), 없는 필드는 활성 설정 그대로다.
   */
  settingsOverride?: ActiveSettings;
}

/**
 * 세션 전송본(payload)을 만든다. 실패하면 `{ error }`.
 *
 * 주의: 호출자는 세션의 in-progress(미저장) 본문 편집을 먼저 커밋해야 한다.
 * 이 함수는 store 의 세션을 읽으므로, 커밋 안 된 편집은 보이지 않는다.
 */
export async function planSessionRequest(
  plugin: StellaEnginePlugin,
  sessionFile: string,
  opts: PlanSessionRequestOptions = {}
): Promise<SessionRequestPlan | { error: string }> {
  if (!plugin.ai.isAvailable()) {
    return { error: "GGAI Core 가 활성화되어 있지 않습니다." };
  }

  const session = await plugin.store.getSession(sessionFile);
  if (!session) return { error: "세션을 불러올 수 없습니다." };

  const settings = {
    ...(await plugin.resolveActiveSettings(sessionFile)),
    ...(opts.settingsOverride ?? {}),
  };
  const allProfiles = plugin.ai.listGenerationProfiles();
  const profile = settings.modelProfileId
    ? allProfiles.find((p) => p.id === settings.modelProfileId) ?? null
    : plugin.ai.getDefaultGenerationProfile();
  if (!profile) {
    return { error: "활성 프로필이 없습니다. 우측 사이드바에서 모델을 선택하세요." };
  }

  const leafId = opts.leafId ?? session.meta.activeLeafId;
  const parentSpans = buildSpans(session, leafId);

  // 확장 컨텍스트 기여 — 요약 등은 확장이 슬롯을 채운다(요약 사용 off 면 빈 값).
  // 미리보기(dry-run)도 이 경로를 그대로 쓰므로 확장 기여가 함께 보인다.
  const contributions = await plugin.extensions.collectContext({
    sessionFile,
    session,
    leafId,
    settings,
  });
  const summaryContext = plugin.extensions.pickSlot(contributions, "summary");

  const scenarioFile = scenarioFileOfSessionFile(sessionFile);
  const scenarios = await plugin.store.getScenarios();
  const scenarioItem = scenarios.find((i) => i.scenarioFile === scenarioFile);
  const scenarioData = scenarioItem?.scenario.data ?? { name: "(unknown)" };
  const { profile: user } = await plugin.resolveActiveUserProfile();

  // 활성 프롬프트 세트 (없으면 폴백)
  const promptSetId = settings.promptSetId ?? session.meta.promptPresetId;
  let preset = buildFallbackPreset();
  let promptSetName: string | null = null;
  if (promptSetId) {
    try {
      const allPresets = await scanPrompts(plugin.app.vault);
      const found = allPresets.find((p) => p.preset.meta.id === promptSetId);
      if (found) {
        preset = found.preset;
        promptSetName = found.preset.meta.name ?? null;
      }
    } catch {
      // 폴백 유지
    }
  }

  // 활성 로어북 — 확장이 선택 대체를 등록했으면 그 함수가 고르고, 없으면 기본 키워드 매칭.
  const lorebookSelector = plugin.extensions.getLorebookSelector();
  const lorebooks = await (lorebookSelector
    ? lorebookSelector({
        plugin,
        sessionFile,
        session,
        scenario: scenarioItem?.scenario ?? null,
        leafId,
      })
    : resolveActiveLorebooks(plugin.store, scenarioItem?.scenario ?? null, session)
  ).catch((): StellaLorebook[] => []);

  // 그룹 세션 (G1): 멤버 프로필(호스트 제외)을 가상 로어북으로 합류시킨다.
  // 전송본 단일 경로라 미리보기·생성에 자동으로 동일 반영. 그룹 로드 실패는
  // 조용히 단일 캐릭터 컨텍스트로 진행 (그룹이 삭제된 세션도 열려야 함).
  if (session.meta.groupId) {
    try {
      const groupItem = await plugin.store.getGroupById(session.meta.groupId);
      if (groupItem) {
        const all = await plugin.store.getScenarios();
        const memberBook = buildGroupMemberLorebook(
          groupItem.group,
          all.map((i) => i.scenario),
          session.meta.scenarioId
        );
        if (memberBook) lorebooks.push(memberBook);
      }
    } catch (err) {
      console.warn("[GGAI Stella] 그룹 멤버 컨텍스트 로드 실패:", err);
    }
  }

  const tokenBudget = settings.params?.maxContext ?? 16000;
  const novelChatRoleMode = resolveRoleMode(
    profile.kind,
    session.meta.novelChatRoleMode
  );

  // 세션을 변형하지 않도록 복사본으로 빌드. setvar 등은 buildContext 가
  // 이 복사본을 in-place 로 갱신하므로, 빌드 후 그 값을 돌려준다.
  const variables = { ...(session.meta.variables ?? {}) };

  const v2input: ContextBuilderInputV2 = {
    preset,
    scenario: {
      name: scenarioData.name ?? "(unknown)",
      description: (scenarioData as any).description,
      personality: (scenarioData as any).personality,
      scenario: (scenarioData as any).scenario,
      mes_example: (scenarioData as any).mes_example,
      first_message: (scenarioData as any).first_mes,
      system_prompt: (scenarioData as any).system_prompt,
      post_history_instructions: (scenarioData as any).post_history_instructions,
      depth_prompt: (scenarioData as any).extensions?.depth_prompt,
      creator_notes: (scenarioData as any).creator_notes,
      character_version: (scenarioData as any).character_version,
    },
    persona: { name: user.name, description: user.description },
    lorebooks,
    mode: session.meta.mode,
    novelChatRoleMode,
    // 챗 세션 로그는 span author 추측이 아니라 노드에서 직접 만든다 —
    // 연속 같은 역할 메시지가 구분 없이 붙는 문제 방지 (챗 모드 스펙.md).
    sessionLog:
      session.meta.mode === "chat"
        ? buildChatSessionLog(session, leafId, opts.excludeTailAssistant === true)
        : buildSessionLog(parentSpans, session.meta.mode, {
            novelChatRoleMode,
          }),
    memory: session.meta.memory,
    authorNote: session.meta.authorNote,
    summary: summaryContext || undefined,
    // {{idle_duration}} — 마지막 노드 이후 경과 (ST 호환, 실시간 채팅용).
    idleDuration:
      formatIdleEn(
        Date.now() - (session.nodes[leafId]?.createdAt ?? Date.now())
      ) || "less than a minute",
    variables,
    choiceValues: { ...(session.meta.choiceValues ?? {}) },
    timingStates: { ...(session.meta.timingStates ?? {}) },
    turnNumber: Object.keys(session.nodes).length,
    maxOutputTokens: settings.params?.maxOutputTokens,
    tokenBudget,
    countTokens: (s) => plugin.ai.countTokens(s, profile.id),
  };

  const output = buildContext(v2input);

  const paramsOverride = paramsToOverride(
    settings.params,
    profile.kind,
    output.adjustedMaxOutputTokens
  );

  // ── 전송본 — 미리보기와 생성이 공유하는 단 하나의 출력 ──
  let payload: SessionRequestPayload;
  if (profile.kind === "text") {
    // 텍스트 모델은 NAI 형식 기본 ON(명시적으로 끈 경우만 평문).
    const naiFormat = resolveNaiFormat(profile.kind, settings.naiFormat);
    // 챗 세션 → 텍스트 모델: ST 호환 이름 턴 — 히스토리를 `이름: ` 프리픽스로
    // 평탄화하고 끝에 `{{char}}:` 오프너를 연다. 미리보기도 이 payload 그대로.
    const chatNames: ChatCompletionNames | undefined =
      session.meta.mode === "chat"
        ? {
            user: user.name?.trim() || "User",
            char: (scenarioData.name ?? "").trim() || "Character",
          }
        : undefined;
    const flatMessages = chatNames
      ? applyChatTurnNames(output.messages, chatNames)
      : output.messages;
    const segments = naiFormat
      ? buildNaiFormatSegments(flatMessages)
      : buildTextCompletionSegments(flatMessages);
    payload = {
      kind: "text",
      prompt: segmentsToString(segments),
      segments,
      naiFormat,
      chatNames,
    };
  } else {
    const messages = normalizeMessagesForChat(output.messages);
    // 이어쓰기 이음새 보정 — 마지막 문장 반복 지시문을 전송본 끝에 붙인다.
    // 미리보기도 이 payload 를 그대로 그리므로 지시문이 그대로 보인다.
    let anchor: string | undefined;
    // 이어쓰기 이음새 보정은 소설 전용 — 챗 세션에는 절대 붙이지 않는다.
    if (settings.continueAnchor && session.meta.mode !== "chat") {
      const bodyText = spansToText(parentSpans);
      anchor = extractAnchorSentence(bodyText) ?? undefined;
      if (anchor) {
        messages.push({
          role: "user",
          content: buildAnchorInstruction(
            anchor,
            currentParagraphLength(bodyText)
          ),
          source: { type: "prompt", label: "이어쓰기 보정" },
        });
      }
    }
    payload = { kind: "chat", messages, anchor };
  }

  return {
    session,
    profile,
    output,
    payload,
    paramsOverride,
    updatedVariables: variables,
    meta: {
      sessionName: session.meta.name,
      scenarioName: scenarioData.name ?? "(unknown)",
      leafId,
      promptSetName,
      lorebookCount: lorebooks.length,
      tokenBudget,
    },
  };
}

// ─────────────────────────── 미리보기 래퍼 ───────────────────────────

export interface SessionContextDryRun {
  output: ContextBuilderOutputV2;
  profile: { id: string; name: string; kind: string; provider?: string };
  /** 텍스트 프로필일 때, 실제로 보낼 평탄화된 단일 프롬프트 문자열. */
  textPrompt?: string;
  /** 위 문자열을 파트별로 나눈 세그먼트 — 이어붙이면 textPrompt 와 동일. */
  textSegments?: PromptSegment[];
  /** 챗 프로필일 때, 실제로 보낼 메시지 배열 (normalize 적용 후 = 전송본 그대로). */
  chatMessages?: ChatMessage[];
  /** chatMessages 각 항목의 근사 토큰 수 (프로필 토크나이저 기준). */
  chatMessageTokens?: number[];
  /** textSegments 각 세그먼트의 근사 토큰 수. */
  textSegmentTokens?: number[];
  meta: SessionRequestMeta;
}

/**
 * 활성 세션의 dry-run 컨텍스트 — `planSessionRequest` 의 결과를 미리보기 모달용
 * 형태로 옮긴 얇은 래퍼. 전송본 자체는 planSessionRequest 가 만든 그대로다.
 */
export async function buildSessionContextDryRun(
  plugin: StellaEnginePlugin,
  sessionFile: string
): Promise<SessionContextDryRun | { error: string }> {
  const plan = await planSessionRequest(plugin, sessionFile);
  if ("error" in plan) return plan;

  const { profile, output, payload, meta } = plan;
  const countTok = (s: string) => plugin.ai.countTokens(s, profile.id);
  return {
    output,
    profile: {
      id: profile.id,
      name: profile.name ?? profile.id,
      kind: profile.kind,
      provider: profile.provider,
    },
    textPrompt: payload.kind === "text" ? payload.prompt : undefined,
    textSegments: payload.kind === "text" ? payload.segments : undefined,
    textSegmentTokens:
      payload.kind === "text" ? payload.segments.map((s) => countTok(s.text)) : undefined,
    chatMessages: payload.kind === "chat" ? payload.messages : undefined,
    chatMessageTokens:
      payload.kind === "chat" ? payload.messages.map((m) => countTok(m.content)) : undefined,
    meta,
  };
}

export function scenarioFileOfSessionFile(sessionFile: string): string | null {
  const parts = sessionFile.split("/");
  if (parts.length < 6 || parts[parts.length - 3] !== "SESSIONS") return null;
  return parts.slice(0, -3).join("/") + "/scenario.json";
}
