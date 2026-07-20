import type StellaEnginePlugin from "../main";
import type { GenerationProfileLite } from "../services/ai-service";
import type { CustomContextContribution } from "../services/extension-registry";
import {
  defaultLorebookEntry,
  defaultLorebookMeta,
  type StellaLorebook,
} from "../types/lorebook";
import type { ActiveSettings } from "../types/preset";
import type { StellaSession } from "../types/session";
import {
  buildContext,
  buildFallbackPreset,
  type ChatMessage,
  type ContextBuilderInputV2,
  type ContextBuilderOutputV2,
} from "./context-builder";
import { buildChatLog, buildChatMessages } from "./chat-messages";
import type { StellaGroup } from "../types/group";
import { applyMacros } from "./macros";
import { getDefaultPrompts } from "./default-media-prompts";
import type { MediaPromptItem } from "../types/preset";
import { REGEX_PLACEMENT } from "../types/regex";
import { getRegexedString } from "./regex-engine";
import { collectRegexScripts } from "./regex-scripts";

/**
 * 작가노트 프레이밍 — 세션이 전용 프롬프트를 골랐으면 작가노트 원문을 그 프롬프트의
 * {{MAIN}}({{main}}) 자리에 넣어 감싼다. 고르지 않았거나(없음) 못 찾으면 원문 그대로.
 * 프롬프트가 선택돼 있으면 작가노트가 비어 있어도 프레임을 삽입한다(프레임 자체가
 * "빈 경우 알아서 전개"를 지시하므로).
 */
function frameAuthorNote(
  note: string | undefined,
  templateId: string | undefined,
  library: MediaPromptItem[] | undefined
): string | undefined {
  if (!templateId) return note;
  const template =
    library?.find((p) => p.id === templateId) ??
    getDefaultPrompts("authorNote").find((p) => p.id === templateId);
  if (!template) return note;
  return template.prompt.replace(/\{\{\s*main\s*\}\}/gi, note ?? "");
}

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

/**
 * 그룹 챗 세션 로그 — 각 메시지에 `이름: ` 프리픽스 (ST 그룹 force-names 호환).
 * AI 메시지 이름은 노드의 발화자(`node.speaker`), 없으면 호스트 캐릭터.
 * 모델이 여러 화자를 구분하고 이름 지목에 반응할 수 있게 한다.
 */
function buildGroupChatSessionLog(
  session: StellaSession,
  leafId: string,
  excludeTail: boolean,
  userName: string,
  hostName: string,
  nameById: Map<string, string>,
  // 정규식 치환 — `이름: ` 프리픽스가 붙기 전 원문에 적용한다 (ST 동일).
  transform?: (text: string, role: "user" | "assistant", depth: number) => string
): { role: "user" | "assistant"; content: string }[] {
  const msgs = buildChatMessages(session, leafId).filter(
    (m) => m.text.trim().length > 0
  );
  if (excludeTail && msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
    msgs.pop();
  }
  return msgs.map((m, i) => {
    const speaker =
      m.role === "user"
        ? userName
        : nameById.get(session.nodes[m.nodeId]?.speaker ?? "") ?? hostName;
    const text = transform
      ? transform(m.text.trim(), m.role, msgs.length - 1 - i)
      : m.text.trim();
    return { role: m.role, content: `${speaker}: ${text}` };
  });
}
import {
  buildAnchorInstruction,
  currentParagraphLength,
  extractAnchorSentence,
} from "./continuation-anchor";
import { paramsToOverride } from "./generation-params";
import { buildGroupMemberLorebook } from "./group-lorebook";
import { formatIdleEn } from "./idle-duration";
import { resolveNaiFormat } from "./model-kind-policy";
import { normalizeMessagesForChat } from "./normalize-messages";
import { DEFAULT_LOREBOOK_SELECT_CONTEXT_CHARS } from "./lorebook-ai-select";
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
  /**
   * 그룹 챗 전용 — 생성 결과에서 다른 멤버/유저 턴(`이름:`)을 절단하고 발화자
   * 라벨을 벗겨야 한다는 표시 (trimChatCompletionOutput, dropIncompleteTail 없이).
   */
  names?: ChatCompletionNames;
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
  /**
   * 그룹 챗 발화자 — 멤버 시나리오의 stella.id (G2). 그룹 챗 세션에서만 의미.
   * 지정된 멤버의 카드가 풀 카드(시나리오 슬롯)로 들어가고 나머지 멤버(호스트
   * 포함)는 프로필 로어북으로 합류한다. 없거나 멤버가 아니면 호스트가 발화자.
   */
  speakerId?: string;
  /**
   * 미리보기 전용 — 로어북 AI 매칭을 새로 돌리지 않고 마지막 선별 결과를 재사용한다.
   * (선별은 실제 생성 직전에만 실행 — 미리보기가 AI 호출/비용을 유발하지 않게.)
   */
  dryRun?: boolean;
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
  const phoneContext = plugin.extensions.pickSlot(contributions, "phone");

  const scenarioFile = scenarioFileOfSessionFile(sessionFile);
  const scenarios = await plugin.store.getScenarios();
  const scenarioItem = scenarios.find((i) => i.scenarioFile === scenarioFile);
  const scenarioData = scenarioItem?.scenario.data ?? { name: "(unknown)" };
  const { profile: user } = await plugin.resolveActiveUserProfile();
  const userName = user.name?.trim() || "User";

  // ── 그룹 세션 (G1/G2) — 멤버 목록과 (챗) 발화자를 먼저 해석한다.
  // 그룹 로드 실패는 조용히 단일 캐릭터 컨텍스트로 진행 (그룹이 삭제된 세션도
  // 열려야 함).
  let group: StellaGroup | null = null;
  if (session.meta.groupId) {
    try {
      group = (await plugin.store.getGroupById(session.meta.groupId))?.group ?? null;
    } catch (err) {
      console.warn("[GGAI Stella] 그룹 로드 실패:", err);
    }
  }
  const memberNameById = new Map<string, string>();
  if (group) {
    const byStellaId = new Map(
      scenarios.map((i) => [i.scenario.data?.extensions?.stella?.id, i] as const)
    );
    for (const m of group.members) {
      const name = byStellaId.get(m.scenarioId)?.scenario.data?.name?.trim();
      if (name) memberNameById.set(m.scenarioId, name);
    }
  }
  const isGroupChat = group != null && session.meta.mode === "chat";
  // 발화자 (G2) — 그룹 챗에서만 의미. 멤버가 아니면 호스트로 폴백.
  const speakerId =
    isGroupChat &&
    opts.speakerId &&
    group!.members.some((m) => m.scenarioId === opts.speakerId)
      ? opts.speakerId
      : session.meta.scenarioId;
  // 발화자 = 풀 카드: 호스트가 아니면 시나리오 슬롯을 발화자 카드로 교체하고,
  // 나머지 멤버(호스트 포함)는 프로필 로어북(압축)으로 합류한다.
  let speakerData = scenarioData;
  if (isGroupChat && speakerId !== session.meta.scenarioId) {
    const sc = scenarios.find(
      (i) => i.scenario.data?.extensions?.stella?.id === speakerId
    );
    if (sc) speakerData = sc.scenario.data;
  }
  const speakerName = (speakerData.name ?? "").trim() || "Character";
  const otherNames = isGroupChat
    ? [...memberNameById.entries()]
        .filter(([id]) => id !== speakerId)
        .map(([, name]) => name)
    : undefined;

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

  // 그룹 세션 (G1/G2): 발화자를 뺀 멤버 프로필을 가상 로어북으로 합류시킨다
  // (소설 그룹은 발화자 = 호스트 고정). 전송본 단일 경로라 미리보기·생성에
  // 자동으로 동일 반영.
  if (group) {
    const memberBook = buildGroupMemberLorebook(
      group,
      scenarios.map((i) => i.scenario),
      isGroupChat ? speakerId : session.meta.scenarioId
    );
    if (memberBook) lorebooks.push(memberBook);

    // 멤버가 각자 끼고 있는 시나리오 로어북도 합집합으로 참여시킨다.
    // 세션의 disabledScenarioLorebookIds 로 끌 수 있게 같은 disabled 셋을 존중하고,
    // 이미 들어온 책(호스트 로어북 등)과 id 로 중복 제거한다.
    const disabledLore = new Set(session.meta.disabledScenarioLorebookIds ?? []);
    const alreadyLore = new Set(lorebooks.map((l) => l.meta.id));
    const memberLoreIds: string[] = [];
    for (const member of group.members) {
      if (member.scenarioId === session.meta.scenarioId) continue; // 호스트는 이미 반영
      const sc = scenarios.find(
        (i) => i.scenario.data?.extensions?.stella?.id === member.scenarioId
      );
      const st = sc?.scenario.data?.extensions?.stella;
      if (!st) continue;
      if (st.defaultLorebookId) memberLoreIds.push(st.defaultLorebookId);
      for (const id of st.extraLorebookIds ?? []) memberLoreIds.push(id);
    }
    for (const id of memberLoreIds) {
      if (disabledLore.has(id) || alreadyLore.has(id)) continue;
      alreadyLore.add(id);
      const item = await plugin.store.getLorebookById(id);
      if (item) lorebooks.push(item.lorebook);
    }
  }

  // 스텔라 폰 문자 기억 (PH1) — 확장이 채운 phone 슬롯을 가상 로어북 상시
  // 엔트리로 감싸 히스토리 근처(at_depth)에 삽입한다. 그룹 멤버 프로필과 같은
  // 방식이라 미리보기·생성·토큰 예산에 자동으로 동일 반영된다.
  if (phoneContext) {
    lorebooks.push({
      meta: defaultLorebookMeta("sillytavern", "스텔라 폰", "stella-phone"),
      entries: [
        {
          ...defaultLorebookEntry("sillytavern"),
          uid: "stella-phone-context",
          name: "스텔라 폰",
          keys: [],
          content: phoneContext,
          constant: true,
          position: "at_depth",
          depth: 4,
          role: "system",
          order: 100,
        },
      ],
    });
  }

  // 확장 custom 슬롯 — 외부 확장이 배치 규칙과 함께 기여한 텍스트를 폰/그룹
  // 멤버와 같은 가상 로어북 상시 엔트리로 감싸 지정 위치에 삽입한다. 외부
  // 확장의 컨텍스트 삽입 진입점은 이 한 곳뿐(확장별 별도 배선 금지) —
  // 미리보기·생성·토큰 예산이 자동으로 동일 반영된다.
  const customContribs = contributions.filter(
    (c): c is CustomContextContribution & { sourceId: string } => c.slot === "custom"
  );
  if (customContribs.length) {
    lorebooks.push({
      meta: defaultLorebookMeta("sillytavern", "확장 컨텍스트", "stella-extension-context"),
      entries: customContribs.map((c, i) => ({
        ...defaultLorebookEntry("sillytavern"),
        uid: `ext-${c.sourceId}-${i}`,
        name: c.name ?? c.sourceId,
        keys: [],
        content: c.text,
        constant: true,
        position: c.position ?? "after_char",
        depth: c.depth ?? 4,
        role: c.role ?? "system",
        order: c.order ?? 100,
      })),
    });
  }

  // ── 로어북 확장 — AI 매칭 (생성 전 선별 모델이 필요한 엔트리를 고른다).
  // 미리보기(dryRun)는 새 AI 호출 없이 마지막 선별 결과를 재사용 — 직전 생성에
  // 실제로 쓰인 값이므로 전송본과 같은 경로/같은 결과가 유지된다.
  const lorebookPlus = settings.lorebookPlus ?? {};
  let forcedEntryKeys: string[] | undefined;
  if (lorebookPlus.aiMatching === true) {
    if (opts.dryRun) {
      forcedEntryKeys = plugin.lorebookPlus.getCachedKeys(sessionFile) ?? [];
    } else {
      // 본문 첨부량(자) — 설정으로 조절, 끝(최신)에서부터 자른다.
      const contextChars =
        lorebookPlus.contextChars ?? DEFAULT_LOREBOOK_SELECT_CONTEXT_CHARS;
      const recentText =
        session.meta.mode === "chat"
          ? buildChatLog(session, leafId)
              .map((m) => m.content)
              .join("\n")
          : spansToText(parentSpans);
      forcedEntryKeys = await plugin.lorebookPlus.selectEntries({
        sessionFile,
        leafId,
        books: lorebooks,
        recentText: recentText.slice(-contextChars),
        settings: lorebookPlus,
      });
    }
  }

  const tokenBudget = settings.params?.maxContext ?? 16000;

  // 세션을 변형하지 않도록 복사본으로 빌드. setvar 등은 buildContext 가
  // 이 복사본을 in-place 로 갱신하므로, 빌드 후 그 값을 돌려준다.
  const variables = { ...(session.meta.variables ?? {}) };

  // ── 정규식 스크립트 (전송본 시점) — 전역 + (허용된) 시나리오별을 히스토리
  // 메시지에 적용한다. ST 와 같은 의미: USER_INPUT = 유저 메시지, AI_OUTPUT = AI
  // 메시지, depth = 끝에서 몇 번째(0 = 마지막). 전송본 단일 경로라 미리보기에도
  // 자동으로 동일 반영된다. 저장 원문(raw)·표시(display) 시점 스크립트는 여기서
  // isPrompt 필터에 걸러져 원문을 건드리지 않는다.
  const scenarioStellaId = scenarioItem?.scenario.data?.extensions?.stella?.id;
  const regexScripts = collectRegexScripts({
    global: plugin.data.regexScripts,
    scenario: scenarioItem?.scenario,
    scenarioAllowed:
      !!scenarioStellaId &&
      (plugin.data.regexScriptsAllowedScenarios ?? []).includes(scenarioStellaId),
  });
  const regexSubstitute = (s: string) =>
    applyMacros(s, { char: speakerName, user: userName, variables });
  const regexMessage = (text: string, role: "user" | "assistant", depth: number) =>
    getRegexedString(
      text,
      role === "user" ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
      regexScripts,
      { isPrompt: true, depth, substitute: regexSubstitute }
    );
  const applyPromptRegex = (
    log: { role: "user" | "assistant"; content: string }[]
  ): { role: "user" | "assistant"; content: string }[] =>
    regexScripts.length === 0
      ? log
      : log.map((m, i) => ({
          ...m,
          content: regexMessage(m.content, m.role, log.length - 1 - i),
        }));

  const v2input: ContextBuilderInputV2 = {
    preset,
    // 그룹 챗이면 시나리오 슬롯 = 이번 발화자의 풀 카드 (그 외엔 호스트 카드).
    scenario: {
      name: speakerData.name ?? "(unknown)",
      description: (speakerData as any).description,
      personality: (speakerData as any).personality,
      scenario: (speakerData as any).scenario,
      mes_example: (speakerData as any).mes_example,
      first_message: (speakerData as any).first_mes,
      system_prompt: (speakerData as any).system_prompt,
      post_history_instructions: (speakerData as any).post_history_instructions,
      depth_prompt: (speakerData as any).extensions?.depth_prompt,
      creator_notes: (speakerData as any).creator_notes,
      character_version: (speakerData as any).character_version,
    },
    persona: { name: user.name, description: user.description },
    lorebooks,
    mode: session.meta.mode,
    // 챗 세션 로그는 span author 추측이 아니라 노드에서 직접 만든다 —
    // 연속 같은 역할 메시지가 구분 없이 붙는 문제 방지 (챗 모드 스펙.md).
    // 그룹 챗은 메시지마다 발화자 이름을 붙인다 (ST force-names 호환).
    sessionLog:
      session.meta.mode === "chat"
        ? isGroupChat
          ? buildGroupChatSessionLog(
              session,
              leafId,
              opts.excludeTailAssistant === true,
              userName,
              scenarioData.name?.trim() || "(unknown)",
              memberNameById,
              regexScripts.length > 0 ? regexMessage : undefined
            )
          : applyPromptRegex(
              buildChatSessionLog(session, leafId, opts.excludeTailAssistant === true)
            )
        : applyPromptRegex(buildSessionLog(parentSpans, session.meta.mode)),
    memory: session.meta.memory,
    authorNote: frameAuthorNote(
      session.meta.authorNote,
      session.meta.authorNoteTemplateId,
      plugin.data.mediaPrompts?.authorNote
    ),
    summary: summaryContext || undefined,
    // {{idle_duration}} — 마지막 노드 이후 경과 (ST 호환, 실시간 채팅용).
    idleDuration:
      formatIdleEn(
        Date.now() - (session.nodes[leafId]?.createdAt ?? Date.now())
      ) || "less than a minute",
    variables,
    choiceValues: { ...(session.meta.choiceValues ?? {}) },
    timingStates: { ...(session.meta.timingStates ?? {}) },
    lorebookControl: {
      keywordMatching: lorebookPlus.keywordMatching,
      forcedEntryKeys,
    },
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
    // 평탄화하고 끝에 `발화자이름:` 오프너를 연다. 미리보기도 이 payload 그대로.
    // 그룹 챗은 로그에 발화자별 이름이 이미 붙어 있으니 오프너만 연다.
    const chatNames: ChatCompletionNames | undefined =
      session.meta.mode === "chat"
        ? { user: userName, char: speakerName, others: otherNames }
        : undefined;
    const flatMessages = chatNames
      ? applyChatTurnNames(output.messages, chatNames, {
          historyAlreadyNamed: isGroupChat,
        })
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
    // 그룹 챗 (G2): 이번 턴은 이 발화자만 말하라는 지시문을 끝에 붙인다
    // (ST group nudge 호환). 미리보기도 이 payload 를 그대로 그린다.
    let names: ChatCompletionNames | undefined;
    if (isGroupChat) {
      names = { user: userName, char: speakerName, others: otherNames };
      messages.push({
        role: "user",
        content: `[Write the next reply only as ${speakerName}.]`,
        source: { type: "prompt", label: "그룹 발화 지시" },
      });
    }
    payload = { kind: "chat", messages, anchor, names };
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
  const plan = await planSessionRequest(plugin, sessionFile, { dryRun: true });
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
