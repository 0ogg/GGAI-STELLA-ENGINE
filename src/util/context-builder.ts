/**
 * 컨텍스트 빌더 v2 — 순수 함수. 추후 GGAI Core agent() tool 로 노출 가능.
 *
 * 입출력 모두 JSON-serializable.
 *
 * 핵심 흐름:
 *   1) prompts[] 순회 → 고정 메시지 수집 / chatHistory 플레이스홀더 기록
 *   2) chatHistory 확장: at_depth 로어북 / ABSOLUTE 텍스트 주입 / memory / summary / authorNote
 *   3) 토큰 예산: 고정 블록 선차감 → chatHistory 끝부터 역순으로 채움
 *   4) continueText 처리 → 최종 메시지 조립
 */

import type { StellaLorebook, StellaLorebookEntry } from "../types/lorebook";
import type {
  MarkerIdentifier,
  PromptChoiceBlock,
  StellaPromptPreset,
  StellaPromptTextItem,
} from "../types/prompt";
import { MARKER_MACRO_TOKENS } from "../types/prompt";
import { applyMacros, type MacroContext } from "./macros";
import { tokenizeParagraphs } from "./translate-paragraphs";
import {
  matchLorebookEntries,
  type EntryTimingState,
} from "./lorebook-match";

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  source?: ContextSource;
  /** 토큰 초과 시 자르기 우선순위를 정하는 정책 태그. */
  contextKind?: "prompt" | "history" | "injection";
};
type ConversationMessage = ChatMessage & { role: "user" | "assistant" };

export interface ContextSource {
  type:
    | "prompt"
    | "marker"
    | "scenario"
    | "lorebook"
    | "chat"
    | "memory"
    | "authorNote"
    | "summary"
    | "fallback";
  label: string;
  detail?: string;
}

export interface ContextBuilderInputV2 {
  preset: StellaPromptPreset;
  scenario: {
    name: string;
    description?: string;
    personality?: string;
    scenario?: string;
    mes_example?: string;
    first_message?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    depth_prompt?: string;
    creator_notes?: string;
    character_version?: string;
  };
  persona?: { name: string; description?: string };
  lorebooks: StellaLorebook[];
  mode?: "novel" | "textgame" | "chat";
  /** 소설 모드: [{ role:"assistant", content: 전체 본문 }]. 챗 모드: 교대 턴 배열. */
  sessionLog: { role: "user" | "assistant"; content: string }[];
  /** chatHistory 마지막 메시지 직전에 system 으로 삽입. */
  memory?: string;
  /** chatHistory 끝에서 3 메시지 앞에 system 으로 삽입. */
  authorNote?: string;
  /**
   * 이전 본문 요약. chatSummary 마커가 켜져 있거나 {{summary}} 매크로를 쓰면
   * 그 위치를 존중하고, 없으면 작가노트 바로 위(본문 끝-4문단 지점)에 자동 삽입한다.
   */
  summary?: string;
  /** 이어쓰기 모드 — 마지막 assistant 메시지에 prepend. 있으면 trigger=continue 항목만. */
  continueText?: string;
  /** 마지막 노드 이후 경과 표현 — {{idle_duration}} 매크로 값 (P1 실시간 채팅). */
  idleDuration?: string;
  /** 세션 단위 매크로 변수. setvar/getvar/addvar 계열이 이 객체를 갱신한다. */
  variables?: Record<string, string>;
  /** 세션 단위 Choice Block 선택값. */
  choiceValues?: Record<string, string[]>;
  /** 세션 단위 로어북 sticky/cooldown 상태. */
  timingStates?: Record<string, EntryTimingState>;
  /**
   * 로어북 확장 — 활성화 방식 제어. keywordMatching=false 면 키워드 매칭 끔,
   * forcedEntryKeys 는 AI 선별 등으로 키워드 없이 강제 활성화할 엔트리 키 목록.
   */
  lorebookControl?: { keywordMatching?: boolean; forcedEntryKeys?: string[] };
  /** 현재 턴 번호. 로어북 delay 계산에 사용한다. */
  turnNumber?: number;
  /** 출력 토큰 예산. 입력이 많이 차면 이 값을 줄여 전체 컨텍스트 창을 맞춘다. */
  maxOutputTokens?: number;
  tokenBudget: number;
  /** GGAI Core countTokens 주입 — 동기 근사값. */
  countTokens: (s: string) => number;
}

export interface ContextBuilderOutputV2 {
  messages: ChatMessage[];
  tokensUsed: number;
  matchedLorebookEntries: string[];
  updatedTimingStates?: Record<string, EntryTimingState>;
  adjustedMaxOutputTokens?: number;
  droppedLogTurns: number;
  trace: {
    id: string;
    identifier: string;
    included: boolean;
    reason?: string;
  }[];
}

const CHAT_HISTORY_PLACEHOLDER = "__GGAI_CHAT_HISTORY__";
const MIN_PARTIAL_TRUNCATION_TOKENS = 100;

export function buildContext(
  input: ContextBuilderInputV2
): ContextBuilderOutputV2 {
  const count = input.countTokens;
  const isContinue = input.continueText != null;

  // ── 1. 활성 marker 집합 / claimed source 집합 ─────────────────────
  const activeMarkers = new Set<string>();
  const configuredMarkers = new Set<string>();
  // Contract: enabled prompts[] are assembled in visible prompt-list order.
  // Marker identifiers are anchors; chatHistory is expanded at this exact spot.
  for (const item of input.preset.prompts) {
    if (item.kind !== "marker") continue;
    configuredMarkers.add(item.identifier);
    if (item.enabled) activeMarkers.add(item.identifier);
  }
  // 요약 명시 배치 여부 — chatSummary 마커가 켜져 있거나 프롬프트가 {{summary}}
  // 매크로를 쓰면 그 위치를 존중하고 자동 삽입하지 않는다 (페르소나와 같은 규칙).
  const summaryExplicit =
    activeMarkers.has("chatSummary") ||
    input.preset.prompts.some(
      (item) =>
        item.enabled &&
        item.kind === "text" &&
        /\{\{\s*summary\s*\}\}/i.test(item.content)
    );
  const claimedSources = new Set<string>();
  if (activeMarkers.has("charDescription")) claimedSources.add("description");
  if (activeMarkers.has("charPersonality")) claimedSources.add("personality");
  if (activeMarkers.has("scenario")) claimedSources.add("scenario");
  if (activeMarkers.has("dialogueExamples")) claimedSources.add("mes_example");

  // ── 2. 로어북 매칭 ────────────────────────────────────────────────
  const recentMessages = input.sessionLog.map((m) => m.content);
  const timingStates = recordToTimingMap(input.timingStates);
  const matched = matchLorebookEntries(input.lorebooks, {
    recentMessages,
    activeText: recentMessages[recentMessages.length - 1],
    turnNumber: input.turnNumber,
    timingStates,
    keywordMatching: input.lorebookControl?.keywordMatching,
    forcedEntryKeys: input.lorebookControl?.forcedEntryKeys
      ? new Set(input.lorebookControl.forcedEntryKeys)
      : undefined,
  });

  const lorebookByPos: Record<string, StellaLorebookEntry[]> = {
    before_char: [],
    after_char: [],
    before_examples: [],
    after_examples: [],
    at_depth: [],
  };
  for (const { entry } of matched) {
    if (lorebookByPos[entry.position] !== undefined) {
      lorebookByPos[entry.position].push(entry);
    }
  }
  for (const g of Object.values(lorebookByPos)) {
    g.sort((a, b) => b.order - a.order);
  }

  // ── 3. 매크로 컨텍스트 ───────────────────────────────────────────
  const wiBefore = renderLorebookEntries(lorebookByPos.before_char);
  const wiAfter = renderLorebookEntries(lorebookByPos.after_char);
  const wiExamples = renderLorebookEntries([
    ...lorebookByPos.before_examples,
    ...lorebookByPos.after_examples,
  ]);
  const dialogueExamples = formatDialogueExamples(input.scenario.mes_example ?? "");
  const lastMessage = lastNonEmptyMessage(input.sessionLog);
  const choices = resolveChoiceMacros(input.preset.choices ?? [], input.choiceValues);
  const shouldAutoInsertPersona = !presetUsesPersonaMacro(input.preset);
  let autoPersonaInserted = false;
  const macroCtx: MacroContext = {
    char: input.scenario.name,
    user: input.persona?.name ?? "User",
    persona: input.persona?.description ?? "",
    scenario: input.scenario.scenario,
    description: input.scenario.description,
    personality: input.scenario.personality,
    first_message: input.scenario.first_message,
    charFirstMessage: input.scenario.first_message,
    example_dialogue: input.scenario.mes_example,
    mesExamples: dialogueExamples,
    mesExamplesRaw: input.scenario.mes_example,
    wiBefore,
    wiAfter,
    loreBefore: wiBefore,
    loreAfter: wiAfter,
    anchorBefore: "",
    anchorAfter: "",
    system: input.scenario.system_prompt,
    summary: input.summary,
    charPrompt: input.scenario.system_prompt,
    charInstruction: input.scenario.post_history_instructions,
    charDepthPrompt: input.scenario.depth_prompt,
    charCreatorNotes: input.scenario.creator_notes,
    charVersion: input.scenario.character_version,
    lastMessage,
    idleDuration: input.idleDuration,
    variables: input.variables,
    choices,
  };

  // ── 4. prompts[] 순회 ────────────────────────────────────────────
  const trace: ContextBuilderOutputV2["trace"] = [];
  const fixedMessages: ChatMessage[] = [];
  const absoluteItems: StellaPromptTextItem[] = [];
  let chatHistoryIdx = -1;
  let chatHistoryWrap: string | undefined;
  // 소설모드 본문 롤 — chatHistory 마커 설정(기본 assistant). 챗 모드는 무관.
  let novelHistoryRole: "user" | "assistant" = "assistant";
  let memoryWrap: string | undefined;
  let authorNoteWrap: string | undefined;

  for (const item of input.preset.prompts) {
    if (!item.enabled) {
      trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "disabled" });
      continue;
    }

    if (item.kind === "marker") {
      if (
        shouldAutoInsertPersona &&
        !autoPersonaInserted &&
        PERSONA_ANCHOR_MARKERS.has(item.identifier)
      ) {
        // 페르소나는 캐릭터/시나리오 설정 블록의 첫 마커 앞에 삽입한다.
        // 캐릭터 설명 마커가 꺼진 세트(텍스트 컴플리션 기본 등)에서도 누락되지 않도록.
        const inserted = pushPersonaMessage(fixedMessages, input.persona?.description ?? "", macroCtx);
        autoPersonaInserted = autoPersonaInserted || inserted;
      }
      switch (item.identifier) {
        case "chatHistory": {
          chatHistoryIdx = fixedMessages.length;
          chatHistoryWrap = item.wrap;
          if (item.historyRole === "user") novelHistoryRole = "user";
          fixedMessages.push({
            role: "system",
            content: CHAT_HISTORY_PLACEHOLDER,
            source: { type: "marker", label: item.name || "Chat History" },
            contextKind: "prompt",
          });
          trace.push({ id: item.id, identifier: item.identifier, included: true });
          break;
        }
        case "worldInfoBefore": {
          const base = applyMacros(wiBefore, macroCtx);
          if (base.trim()) {
            fixedMessages.push({
              role: "system",
              content: applyMarkerWrap(item.wrap, base, item.identifier, macroCtx),
              source: lorebookSource("Lorebook Before", lorebookByPos.before_char),
              contextKind: "prompt",
            });
            trace.push({ id: item.id, identifier: item.identifier, included: true });
          } else {
            trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "empty" });
          }
          break;
        }
        case "worldInfoAfter": {
          const base = applyMacros(wiAfter, macroCtx);
          if (base.trim()) {
            fixedMessages.push({
              role: "system",
              content: applyMarkerWrap(item.wrap, base, item.identifier, macroCtx),
              source: lorebookSource("Lorebook After", lorebookByPos.after_char),
              contextKind: "prompt",
            });
            trace.push({ id: item.id, identifier: item.identifier, included: true });
          } else {
            trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "empty" });
          }
          break;
        }
        case "charDescription": {
          const base = applyMacros(input.scenario.description ?? "", macroCtx);
          if (base.trim()) {
            fixedMessages.push({
              role: "system",
              content: applyMarkerWrap(item.wrap, base, item.identifier, macroCtx),
              source: { type: "scenario", label: "Scenario: description" },
              contextKind: "prompt",
            });
            trace.push({ id: item.id, identifier: item.identifier, included: true });
          } else {
            trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "empty" });
          }
          break;
        }
        case "charPersonality": {
          const base = applyMacros(input.scenario.personality ?? "", macroCtx);
          if (base.trim()) {
            fixedMessages.push({
              role: "system",
              content: applyMarkerWrap(item.wrap, base, item.identifier, macroCtx),
              source: { type: "scenario", label: "Scenario: personality" },
              contextKind: "prompt",
            });
            trace.push({ id: item.id, identifier: item.identifier, included: true });
          } else {
            trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "empty" });
          }
          break;
        }
        case "scenario": {
          const base = applyMacros(input.scenario.scenario ?? "", macroCtx);
          if (base.trim()) {
            fixedMessages.push({
              role: "system",
              content: applyMarkerWrap(item.wrap, base, item.identifier, macroCtx),
              source: { type: "scenario", label: "Scenario: scenario" },
              contextKind: "prompt",
            });
            trace.push({ id: item.id, identifier: item.identifier, included: true });
          } else {
            trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "empty" });
          }
          break;
        }
        case "dialogueExamples": {
          const parts: string[] = [];
          for (const e of [
            ...lorebookByPos.before_examples,
            ...lorebookByPos.after_examples,
          ]) {
            const c = applyMacros(formatLorebookEntry(e), macroCtx);
            if (c.trim()) parts.push(c);
          }
          const mesEx = applyMacros(dialogueExamples, macroCtx);
          if (mesEx.trim()) parts.push(mesEx);
          if (parts.length > 0) {
            fixedMessages.push({
              role: "system",
              content: applyMarkerWrap(item.wrap, parts.join("\n\n"), item.identifier, macroCtx),
              source: { type: "scenario", label: "Scenario: dialogue examples" },
              contextKind: "prompt",
            });
            trace.push({ id: item.id, identifier: item.identifier, included: true });
          } else {
            trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "empty" });
          }
          break;
        }
        case "memory":
          // chatHistory 확장 시 처리 — 가공 템플릿만 여기서 잡아둔다.
          memoryWrap = item.wrap;
          trace.push({ id: item.id, identifier: item.identifier, included: true });
          break;
        case "authorNote":
          authorNoteWrap = item.wrap;
          trace.push({ id: item.id, identifier: item.identifier, included: true });
          break;
        case "chatSummary": {
          const base = applyMacros(input.summary ?? "", macroCtx);
          if (base.trim()) {
            fixedMessages.push({
              role: "system",
              content: applyMarkerWrap(item.wrap, base, item.identifier, macroCtx),
              source: { type: "marker", label: "Chat Summary" },
              contextKind: "prompt",
            });
            trace.push({ id: item.id, identifier: item.identifier, included: true });
          } else {
            trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "empty" });
          }
          break;
        }
        case "enhanceDefinitions": {
          trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "empty-marker" });
          break;
        }
      }
    } else {
      // text item
      if (!checkTrigger(item, isContinue)) {
        trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "trigger-mismatch" });
        continue;
      }
      if (item.injectionPosition === 1) {
        absoluteItems.push(item);
        trace.push({ id: item.id, identifier: item.identifier, included: true, reason: "absolute-deferred" });
        continue;
      }
      if (isClaimedSingleMacro(item.content, claimedSources)) {
        trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "claimed-by-marker" });
        continue;
      }
      if (
        shouldAutoInsertPersona &&
        !autoPersonaInserted &&
        isCharDescriptionSlot(item.content)
      ) {
        const inserted = pushPersonaMessage(fixedMessages, input.persona?.description ?? "", macroCtx);
        autoPersonaInserted = autoPersonaInserted || inserted;
      }
      const content = applyMacros(item.content, macroCtx);
      if (!content.trim()) {
        trace.push({ id: item.id, identifier: item.identifier, included: false, reason: "empty" });
        continue;
      }
      fixedMessages.push({
        role: item.role,
        content,
        source: { type: "prompt", label: item.name || item.identifier, detail: item.identifier },
        contextKind: "prompt",
      });
      trace.push({ id: item.id, identifier: item.identifier, included: true });
    }
  }

  // 마커가 프리셋에 아예 없을 때만 폴백으로 챗 히스토리 앞에 끼운다.
  // (마커가 있는데 비활성이면 = 의도적 숨김으로 보고 넣지 않는다.)
  const fallbackLoreParts: string[] = [];
  if (!configuredMarkers.has("worldInfoBefore") && wiBefore.trim()) {
    fallbackLoreParts.push(applyMacros(wiBefore, macroCtx));
  }
  if (!configuredMarkers.has("worldInfoAfter") && wiAfter.trim()) {
    fallbackLoreParts.push(applyMacros(wiAfter, macroCtx));
  }
  if (!configuredMarkers.has("dialogueExamples") && wiExamples.trim()) {
    fallbackLoreParts.push(applyMacros(wiExamples, macroCtx));
  }
  const fallbackLore = fallbackLoreParts.filter((s) => s.trim()).join("\n\n");
  if (fallbackLore.trim()) {
    insertBeforeChatHistory(fixedMessages, {
      role: "system",
      content: fallbackLore,
      source: { type: "fallback", label: "Lorebook fallback" },
      contextKind: "prompt",
    });
  }

  // ── 5. chatHistory 확장 ──────────────────────────────────────────
  const macroSessionLog = input.sessionLog.map((m) => ({
    role: m.role,
    content: applyMacros(m.content, macroCtx),
  }));
  const chatHistory = buildChatHistoryMessages(
    macroSessionLog,
    input.mode ?? "novel",
    novelHistoryRole,
    {
      memory:
        // Session memory is a fixed session field, not a prompt-list marker.
        // If present, it always enters immediately before the story body.
        input.memory?.trim()
          ? applyMarkerWrap(memoryWrap, applyMacros(input.memory, macroCtx), "memory", macroCtx)
          : "",
      authorNote:
        // Author's note is likewise fixed session context. The story builders
        // insert it four paragraphs before the end of the visible body.
        input.authorNote?.trim()
          ? applyMarkerWrap(authorNoteWrap, applyMacros(input.authorNote, macroCtx), "authorNote", macroCtx)
          : "",
      summary:
        // Summary defaults to sitting immediately above the author's note.
        // Explicit placement (chatSummary marker / {{summary}} macro) wins.
        !summaryExplicit && input.summary?.trim()
          ? applyMacros(input.summary, macroCtx)
          : "",
    }
  );

  // 5a. at_depth 로어북 — depth 내림차순으로 삽입해야 splice 위치 안 밀림
  const byDepth = new Map<number, StellaLorebookEntry[]>();
  for (const e of lorebookByPos.at_depth) {
    if (!byDepth.has(e.depth)) byDepth.set(e.depth, []);
    byDepth.get(e.depth)!.push(e);
  }
  const depthsDesc = Array.from(byDepth.keys()).sort((a, b) => b - a);
  // at_depth lorebook entries are intentionally injected inside chatHistory,
  // so their final position follows depth, not the visible lorebook markers.
  for (const depth of depthsDesc) {
    const entries = byDepth.get(depth)!.sort((a, b) => a.order - b.order);
    const pos = Math.max(0, chatHistory.length - depth);
    const msgs: ChatMessage[] = entries
      .map((e) => ({
        role: e.role as ChatMessage["role"],
        content: applyMacros(formatLorebookEntry(e), macroCtx),
        contextKind: "injection" as const,
        source: {
          type: "lorebook" as const,
          label: `Lorebook at depth ${e.depth}`,
          detail: e.name.trim() || e.uid,
        },
      }))
      .filter((m) => m.content.trim());
    if (msgs.length > 0) chatHistory.splice(pos, 0, ...msgs);
  }

  // 5b. ABSOLUTE text 항목 — depth 내림차순, 같은 depth 에서 injectionOrder 오름차순
  const absByDepth = new Map<number, StellaPromptTextItem[]>();
  for (const item of absoluteItems) {
    const d = item.injectionDepth ?? 0;
    if (!absByDepth.has(d)) absByDepth.set(d, []);
    absByDepth.get(d)!.push(item);
  }
  for (const [depth, items] of Array.from(absByDepth.entries()).sort(([a], [b]) => b - a)) {
    items.sort((a, b) => (a.injectionOrder ?? 0) - (b.injectionOrder ?? 0));
    const pos = Math.max(0, chatHistory.length - depth);
    const msgs: ChatMessage[] = items
      .filter((i) => checkTrigger(i, isContinue))
      .map((i) => ({
        role: i.role,
        content: applyMacros(i.content, macroCtx),
        contextKind: "injection" as const,
        source: {
          type: "prompt" as const,
          label: i.name || i.identifier,
          detail: `absolute depth ${i.injectionDepth ?? 0}`,
        },
      }))
      .filter((m) => m.content.trim());
    if (msgs.length > 0) chatHistory.splice(pos, 0, ...msgs);
  }

  // 5c. memory — chatHistory 앞 (buildChatHistoryMessages 에서 처리)


  // 5d. authorNote — 끝에서 3 메시지 앞


  // ── 6. 토큰 예산 ─────────────────────────────────────────────────
  // 원칙: 본문(대화/스토리) 외의 모든 것 — 고정 프롬프트 + 메모리 + 작가노트 +
  // at_depth 로어북 + 절대 위치 주입 — 을 먼저 확보하고, 남는 예산으로 본문을 최근부터
  // 채운다. 순서대로 한 배열을 잘라내면 앞쪽 메모리/로어북이 먼저 밀려나므로 그렇게 안 한다.
  let fixedCost = 0;
  for (const m of fixedMessages) {
    if (m.content === CHAT_HISTORY_PLACEHOLDER) continue;
    fixedCost += count(m.content);
  }
  // chatHistory 안의 비-본문 항목(주입/메모리/작가노트)도 선확보한다.
  for (const m of chatHistory) {
    if (m.contextKind !== "history") fixedCost += count(m.content);
  }
  let remaining = Math.max(0, input.tokenBudget - fixedCost);

  const requiredTail = requiredTailForBudget(
    chatHistory,
    input.mode ?? "novel"
  );
  // 본문만 최근(끝)부터 남는 예산에 채운다. 비-본문 항목은 위치 그대로 항상 유지.
  const kept = new Array<boolean>(chatHistory.length).fill(false);
  const truncatedAt = new Map<number, string>();
  let bodyExhausted = false;
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const m = chatHistory[i];
    if (m.contextKind !== "history") {
      kept[i] = true; // 비-본문: 선확보했으므로 항상 포함
      continue;
    }
    if (bodyExhausted) continue; // 예산 소진 후의 오래된 본문은 버린다
    const cost = count(m.content);
    if (cost <= remaining) {
      kept[i] = true;
      remaining -= cost;
      continue;
    }
    // 경계 본문: 남는 만큼 잘라 넣고, 그 앞(더 오래된) 본문은 버린다.
    if (
      !requiredTail.includes(m as ConversationMessage) &&
      remaining > MIN_PARTIAL_TRUNCATION_TOKENS
    ) {
      const truncated = truncateContent(m.content, remaining, count);
      if (truncated.trim()) {
        kept[i] = true;
        truncatedAt.set(i, truncated);
        remaining = Math.max(0, remaining - count(truncated));
      }
    }
    bodyExhausted = true;
  }

  let includedHistory: ChatMessage[] = [];
  for (let i = 0; i < chatHistory.length; i++) {
    if (!kept[i]) continue;
    const m = chatHistory[i];
    const tc = truncatedAt.get(i);
    if (tc === undefined) {
      includedHistory.push(m);
    } else {
      includedHistory.push({
        ...m,
        content: tc,
        source: m.source
          ? {
              ...m.source,
              detail: [m.source.detail, "truncated to fit budget"]
                .filter(Boolean)
                .join("; "),
            }
          : undefined,
      });
    }
  }
  const droppedLogTurns = chatHistory.filter(
    (m, i) => m.contextKind === "history" && !kept[i]
  ).length;
  // 필수 tail(가장 최근 대화 턴)은 예산 트리밍에도 반드시 남아야 한다. 단, 이미
  // includedHistory 에 있으면 그대로 둔다 — at_depth 로어북/주입이 본문 끝(물리적
  // 마지막)에 오는 건 정상이며, 그 때문에 "본문 뒤로 tail 을 강제 이동"하면 이미
  // 들어간 최근 본문이 오히려 제거·유실된다(예산 부족 시). 진짜로 빠진 tail 만 보충한다.
  const missingTail = requiredTail.filter(
    (tail) => !includedHistory.some((m) => sameMessage(m, tail))
  );
  for (const m of missingTail) {
    const cost = count(m.content);
    if (cost <= remaining) {
      includedHistory.push({ ...m });
      remaining = Math.max(0, remaining - cost);
    } else if (remaining > MIN_PARTIAL_TRUNCATION_TOKENS) {
      const truncated = truncateContent(m.content, remaining, count);
      if (truncated.trim()) {
        includedHistory.push({
          ...m,
          content: truncated,
          source: m.source
            ? {
                ...m.source,
                detail: [m.source.detail, "required tail truncated to fit budget"]
                  .filter(Boolean)
                  .join("; "),
              }
            : undefined,
        });
        remaining = Math.max(0, remaining - count(truncated));
      }
    }
  }

  // ── 7. continueText ──────────────────────────────────────────────
  if (input.continueText) {
    if (includedHistory.length > 0) {
      const last = includedHistory[includedHistory.length - 1];
      if (last.role === "assistant") {
        last.content = applyMacros(input.continueText, macroCtx) + last.content;
      } else {
        includedHistory.push({
          role: "assistant",
          content: applyMacros(input.continueText, macroCtx),
          source: { type: "chat", label: "Continue prefill" },
          contextKind: "history",
        });
      }
    } else {
      includedHistory.push({
        role: "assistant",
        content: applyMacros(input.continueText, macroCtx),
        source: { type: "chat", label: "Continue prefill" },
        contextKind: "history",
      });
    }
  }

  // ── 8. 최종 조립 ─────────────────────────────────────────────────
  const finalMessages: ChatMessage[] = [];
  for (const m of fixedMessages) {
    if (m.content === CHAT_HISTORY_PLACEHOLDER) {
      if (chatHistoryWrap !== undefined && includedHistory.length > 0) {
        // 본문 가공 — prefix/suffix 를 system 메시지로 끼운다.
        const split = splitMarkerWrap(chatHistoryWrap, "chatHistory", macroCtx);
        const suffix = split.suffix;
        // 작가노트가 본문 맨 위면 어시스턴트가 쓴 내용이 없으므로 챗 히스토리 슬롯의
        // 어시스턴트 오프너는 중복 → 제거. 작가노트의 오프너가 턴을 연다.
        const prefix = authorNoteIsAtBodyTop(includedHistory)
          ? stripTrailingAssistantOpener(split.prefix)
          : split.prefix;
        // 메모리는 chatHistory 앞 컨텍스트다 — prefix(`*** Write./nothink` 등)는 메모리
        // 다음, 실제 본문 바로 앞에 와야 한다. 그래서 선두의 메모리 메시지는 prefix 앞에 둔다.
        let bodyStart = 0;
        while (
          bodyStart < includedHistory.length &&
          includedHistory[bodyStart].source?.type === "memory"
        ) {
          bodyStart++;
        }
        for (let k = 0; k < bodyStart; k++) finalMessages.push(includedHistory[k]);
        if (prefix.trim()) {
          finalMessages.push({
            role: "system",
            content: prefix,
            source: { type: "marker", label: "Chat History (가공 앞)" },
            contextKind: "prompt",
          });
        }
        for (let k = bodyStart; k < includedHistory.length; k++) {
          finalMessages.push(includedHistory[k]);
        }
        if (suffix.trim()) {
          finalMessages.push({
            role: "system",
            content: suffix,
            source: { type: "marker", label: "Chat History (가공 뒤)" },
            contextKind: "prompt",
          });
        }
      } else {
        finalMessages.push(...includedHistory);
      }
    } else {
      finalMessages.push(m);
    }
  }
  // chatHistory marker 없으면 끝에 붙임
  if (chatHistoryIdx === -1) {
    finalMessages.push(...includedHistory);
  }
  const tokensUsed = totalMessageTokens(finalMessages, count);

  return {
    messages: finalMessages,
    tokensUsed,
    matchedLorebookEntries: matched.map((m) => m.entry.name),
    updatedTimingStates: timingMapToRecord(timingStates),
    adjustedMaxOutputTokens: adjustMaxOutputTokens(
      input.maxOutputTokens,
      input.tokenBudget,
      tokensUsed
    ),
    droppedLogTurns,
    trace,
  };
}

// ─── 폴백 프리셋 ────────────────────────────────────────────────────
/** 프리셋이 없을 때 사용하는 최소 구성. 시나리오 필드 + chatHistory. */
export function buildFallbackPreset(): StellaPromptPreset {
  return {
    meta: { id: "", name: "fallback", favorite: false },
    prompts: [
      { id: "fb-wi-before", kind: "marker", identifier: "worldInfoBefore", name: "Lorebook Before", enabled: true },
      { id: "fb-desc", kind: "marker", identifier: "charDescription", name: "Character Description", enabled: true },
      { id: "fb-pers", kind: "marker", identifier: "charPersonality", name: "Character Personality", enabled: true },
      { id: "fb-scen", kind: "marker", identifier: "scenario", name: "Scenario", enabled: true },
      { id: "fb-wi-after", kind: "marker", identifier: "worldInfoAfter", name: "Lorebook After", enabled: true },
      // chatSummary 마커 없음 — 요약(확장)이 켜져 있으면 작가노트 바로 위 자동 삽입.
      { id: "fb-chat", kind: "marker", identifier: "chatHistory", name: "Chat History", enabled: true },
    ],
  };
}

// ─── 헬퍼 ───────────────────────────────────────────────────────────

const WRAP_SENTINEL = "GGAI_MARKER";

/** 마커의 "해당 매크로" 토큰 정규식. 토큰이 없는 마커는 null. */
function markerMacroRegex(identifier: MarkerIdentifier): RegExp | null {
  const tokens = MARKER_MACRO_TOKENS[identifier];
  if (!tokens || tokens.length === 0) return null;
  return new RegExp(`\\{\\{\\s*(?:${tokens.join("|")})\\s*\\}\\}`, "gi");
}

/**
 * 마커 본문 가공 — 마커 내용을 그 마커의 "해당 매크로" 자리에 끼운다.
 *  - wrap === undefined → 가공 안 함, 내용 그대로.
 *  - 해당 매크로가 있으면 그 자리에 치환 (앞뒤 줄바꿈 없음).
 *  - 없으면 내용을 템플릿 맨 뒤에 붙인다.
 * 템플릿 안의 다른 매크로({{char}} 등)는 정상 치환된다. 마커 매크로는 sentinel 로
 * 보호한 뒤 치환하므로, 그 값이 실제 매크로든 아니든 일관되게 동작한다.
 */
function applyMarkerWrap(
  wrap: string | undefined,
  content: string,
  identifier: MarkerIdentifier,
  macroCtx: MacroContext
): string {
  if (wrap === undefined) return content;
  const re = markerMacroRegex(identifier);
  let t = re ? wrap.replace(re, WRAP_SENTINEL) : wrap;
  t = applyMacros(t, macroCtx);
  if (t.includes(WRAP_SENTINEL)) return t.split(WRAP_SENTINEL).join(content);
  return t + content;
}

/**
 * 작가노트가 본문 맨 위(=어시스턴트가 아직 아무것도 쓰지 않은 지점)에 삽입됐는지.
 * 짧은 본문이라 작가노트가 body-before 없이 맨 앞에 오면, 챗 히스토리 슬롯의
 * 어시스턴트 오프너가 작가노트의 오프너와 겹쳐 중복된다.
 */
function authorNoteIsAtBodyTop(history: ChatMessage[]): boolean {
  let sawAssistant = false;
  for (const m of history) {
    if (m.source?.type === "authorNote") return !sawAssistant;
    if (m.role === "assistant") sawAssistant = true;
  }
  return false;
}

/**
 * 텍스트 컴플리션 NovelAI 어시스턴트 오프너(`<|assistant|> <think></think>`) 를 문자열 끝에서 제거.
 * 작가노트가 본문 맨 위에 올 때 챗 히스토리 슬롯의 중복 오프너를 떼는 용도.
 * 사용자가 토큰을 바꿨으면 매칭이 안 되어 그대로 둔다(무해).
 */
function stripTrailingAssistantOpener(text: string): string {
  return text.replace(/\s*<\|assistant\|>\s*<think>\s*<\/think>\s*$/i, "");
}

/** chatHistory 가공 — 템플릿을 마커 매크로 기준 prefix/suffix 로 가른다 (없으면 prefix 만 = 본문 맨 뒤). */
function splitMarkerWrap(
  wrap: string,
  identifier: MarkerIdentifier,
  macroCtx: MacroContext
): { prefix: string; suffix: string } {
  const re = markerMacroRegex(identifier);
  let t = re ? wrap.replace(re, WRAP_SENTINEL) : wrap;
  t = applyMacros(t, macroCtx);
  const idx = t.indexOf(WRAP_SENTINEL);
  if (idx < 0) return { prefix: t, suffix: "" };
  return {
    prefix: t.slice(0, idx),
    suffix: t.slice(idx + WRAP_SENTINEL.length),
  };
}

function renderLorebookEntries(entries: StellaLorebookEntry[]): string {
  return entries
    .map(formatLorebookEntry)
    .filter((s) => s.trim())
    .join("\n\n");
}

function formatDialogueExamples(text: string): string {
  return text;
}

function lastNonEmptyMessage(
  log: { role: "user" | "assistant"; content: string }[]
): string {
  for (let i = log.length - 1; i >= 0; i--) {
    const content = log[i].content;
    if (content.trim()) return content;
  }
  return "";
}

/**
 * 페르소나 자동 삽입 앵커 — 캐릭터/시나리오 설정 블록의 마커들.
 * 이 중 "순서상 먼저 켜진" 마커 앞에 페르소나(사용자 설명)를 한 번 삽입한다.
 * 캐릭터 설명(charDescription) 우선, 없으면 성격/시나리오 앞.
 */
const PERSONA_ANCHOR_MARKERS = new Set<string>([
  "charDescription",
  "charPersonality",
  "scenario",
]);

function pushPersonaMessage(
  messages: ChatMessage[],
  persona: string,
  macroCtx: MacroContext
): boolean {
  const content = applyMacros(persona, macroCtx);
  if (!content.trim()) return false;
  messages.push({
    role: "system",
    content,
    source: { type: "prompt", label: "User profile: persona" },
    contextKind: "prompt",
  });
  return true;
}

function presetUsesPersonaMacro(preset: StellaPromptPreset): boolean {
  return preset.prompts.some(
    (item) => item.enabled && item.kind === "text" && /\{\{\s*persona\s*\}\}/i.test(item.content)
  );
}

function isCharDescriptionSlot(content: string): boolean {
  return /^\s*\{\{\s*description\s*\}\}\s*$/i.test(content);
}

function resolveChoiceMacros(
  blocks: PromptChoiceBlock[],
  selectedByBlock: Record<string, string[]> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of blocks) {
    if (block.options.length === 0) continue;
    const selectedIds = block.random
      ? [chooseWeightedOption(block.options).id]
      : selectedByBlock?.[block.id] ?? [block.options[0].id];
    const selected = block.options.filter((option) =>
      selectedIds.includes(option.id)
    );
    const values = (block.multiSelect ? selected : selected.slice(0, 1))
      .map((option) => option.value)
      .filter((value) => value.trim());
    const value = values.join("\n");
    out[block.id] = value;
    out[block.name] = value;
  }
  return out;
}

function chooseWeightedOption<T extends { weight?: number }>(options: T[]): T {
  const total = options.reduce(
    (sum, option) => sum + Math.max(0, option.weight ?? 1),
    0
  );
  if (total <= 0) return options[0];

  let pick = Math.random() * total;
  for (const option of options) {
    pick -= Math.max(0, option.weight ?? 1);
    if (pick <= 0) return option;
  }
  return options[options.length - 1];
}

function formatLorebookEntry(entry: StellaLorebookEntry): string {
  const content = entry.content.trim();
  const name = entry.name.trim();
  if (!content) return "";
  if (entry.addMemo && name) return `${name}\n${content}`;
  return content;
}

function insertBeforeChatHistory(
  messages: ChatMessage[],
  message: ChatMessage
): void {
  const idx = messages.findIndex((m) => m.content === CHAT_HISTORY_PLACEHOLDER);
  if (idx === -1) messages.push(message);
  else messages.splice(idx, 0, message);
}

function lorebookSource(label: string, entries: StellaLorebookEntry[]): ContextSource {
  const names = entries
    .map((e) => e.name.trim() || e.uid)
    .filter((s) => s.length > 0);
  return {
    type: "lorebook",
    label,
    detail: names.join(", "),
  };
}

/**
 * 본문 끝-4 지점에 함께 삽입되는 개입 블록 — 요약(있으면) 바로 아래 작가노트.
 */
function buildNoteBlock(inserts: {
  authorNote?: string;
  summary?: string;
}): ChatMessage[] {
  const block: ChatMessage[] = [];
  if (inserts.summary?.trim()) {
    block.push({
      role: "system",
      content: inserts.summary,
      source: {
        type: "summary",
        label: "Session: summary",
        detail: "Inserted above the author's note",
      },
      contextKind: "prompt",
    });
  }
  if (inserts.authorNote?.trim()) {
    block.push({
      role: "system",
      content: inserts.authorNote,
      source: {
        type: "authorNote",
        label: "Session: author's note",
        detail: "Inserted 4 paragraphs before the end",
      },
      contextKind: "prompt",
    });
  }
  return block;
}

function buildChatHistoryMessages(
  log: { role: "user" | "assistant"; content: string }[],
  mode: "novel" | "textgame" | "chat",
  // 소설모드 본문을 내보낼 롤 (chatHistory 마커 설정, 기본 assistant). 챗 모드 무관.
  novelHistoryRole: "user" | "assistant",
  inserts: { memory?: string; authorNote?: string; summary?: string }
): ChatMessage[] {
  const noteBlock = buildNoteBlock(inserts);
  if (mode === "chat") {
    const messages: ChatMessage[] = log.map((m, index) => ({
      role: m.role,
      content: m.content,
      source: { type: "chat", label: `Chat History #${index + 1}` },
      contextKind: "history",
    }));
    if (inserts.memory?.trim()) {
      // 메모리 — chatHistory 앞 (novel 모드와 동일하게 맨 앞에 삽입).
      messages.unshift({
        role: "system",
        content: inserts.memory,
        source: { type: "memory", label: "Session: memory" },
        contextKind: "prompt",
      });
    }
    if (noteBlock.length > 0) {
      const pos = Math.max(0, messages.length - 4);
      messages.splice(pos, 0, ...noteBlock);
    }
    return messages;
  }

  const story = log
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .join("");
  const messages: ChatMessage[] = [];
  if (inserts.memory?.trim()) {
    messages.push({
      role: "system",
      content: inserts.memory,
      source: { type: "memory", label: "Session: memory" },
      contextKind: "prompt",
    });
  }
  messages.push(...storyToMessages(story, noteBlock, novelHistoryRole));
  return messages;
}

function storyToMessages(
  story: string,
  noteBlock: ChatMessage[],
  role: "user" | "assistant"
): ChatMessage[] {
  if (!story.trim()) return [];
  if (noteBlock.length === 0) {
    return [{
      role,
      content: story,
      source: { type: "chat", label: "Session body" },
      contextKind: "history",
    }];
  }
  // 문단 정의는 앱 공통(tokenizeParagraphs)을 따른다 — 연속 줄바꿈은 하나의
  // 구분자라, 엔터를 한 번 띄우든 두 번 띄우든 "내용 블록"만 문단으로 센다.
  // 작가노트는 "내용 있는 끝에서 4번째 문단" 앞에 삽입. 공백만 있는 블록은 문단으로
  // 세지 않는다. 원문 줄바꿈은 토큰째로 보존해 before + after 가 story 와 byte 동일.
  const tokens = tokenizeParagraphs(story);
  const paraTokenIdx = tokens
    .map((t, i) => (t.kind === "paragraph" && t.source.trim() ? i : -1))
    .filter((i) => i >= 0);
  const insertOrdinal = Math.max(0, paraTokenIdx.length - 4);
  const splitAt = paraTokenIdx[insertOrdinal] ?? tokens.length;
  const tokenText = (t: (typeof tokens)[number]) =>
    t.kind === "separator" ? t.text : t.source;
  const before = tokens.slice(0, splitAt).map(tokenText).join("");
  const after = tokens.slice(splitAt).map(tokenText).join("");
  const messages: ChatMessage[] = [];
  if (before.trim()) {
    messages.push({
      role,
      content: before,
      source: { type: "chat", label: "Session body before author's note" },
      contextKind: "history",
    });
  }
  messages.push(...noteBlock);
  if (after.trim()) {
    messages.push({
      role,
      content: after,
      source: { type: "chat", label: "Session body after author's note" },
      contextKind: "history",
    });
  }
  return messages;
}

function requiredTailForBudget(
  messages: ChatMessage[],
  mode: "novel" | "textgame" | "chat"
): ConversationMessage[] {
  if (mode === "chat") {
    return messages
      .filter((m): m is ConversationMessage =>
        m.role === "user" || m.role === "assistant"
      )
      .slice(-2);
  }

  // Novel merged mode: the story body is recent context and may be
  // packed/truncated by the remaining maxContext budget — nothing in the
  // history is mandatory. (Previously the trailing continue turn was required;
  // it no longer exists, so the story end can be truncated freely to fit.)
  return [];
}

function checkTrigger(item: StellaPromptTextItem, isContinue: boolean): boolean {
  const triggers = item.injectionTrigger;
  if (!triggers || triggers.length === 0) return true;
  if (isContinue) return triggers.includes("continue") || triggers.includes("normal");
  return triggers.includes("normal");
}

function isClaimedSingleMacro(content: string, claimed: Set<string>): boolean {
  const trimmed = content.trim();
  const MAP: Record<string, string> = {
    "{{description}}": "description",
    "{{personality}}": "personality",
    "{{scenario}}": "scenario",
    "{{example_dialogue}}": "mes_example",
    "{{mesexamples}}": "mes_example",
    "{{mesexamplesraw}}": "mes_example",
    "{{persona}}": "persona",
  };
  const source = MAP[trimmed.toLowerCase()];
  return source != null && claimed.has(source);
}

function sameMessage(
  a: ChatMessage,
  b: { role: "user" | "assistant"; content: string }
): boolean {
  return a.role === b.role && a.content === b.content;
}

/**
 * 예산 경계 메시지를 자른다. 오래된 앞을 버리고 **최근(끝) 부분만** 남긴다.
 * 잘림 표시 문자열을 본문에 끼우지 않는다(모델이 읽을 실제 텍스트를 더럽히지 않음).
 * 가능하면 줄바꿈 경계에서 끊어 문장/문단 중간이 잘리지 않게 한다.
 */
function truncateContent(
  text: string,
  targetTokens: number,
  countTokens: (s: string) => number
): string {
  if (targetTokens <= 0) return "";
  if (countTokens(text) <= targetTokens) return text;

  // 예산에 맞는 가장 긴 "끝 부분(suffix)" 을 이진 탐색으로 찾는다.
  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = text.slice(text.length - keep);
    if (countTokens(candidate) <= targetTokens) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }

  // 앞이 줄 중간에서 잘렸으면, 첫 줄바꿈 이후부터 시작해 깔끔한 문단 경계로 맞춘다.
  const nl = best.indexOf("\n");
  if (nl >= 0 && nl < best.length - 1) best = best.slice(nl + 1);
  return best.replace(/^\s+/, "");
}

function totalMessageTokens(
  messages: ChatMessage[],
  countTokens: (s: string) => number
): number {
  return messages.reduce((sum, message) => sum + countTokens(message.content), 0);
}

function adjustMaxOutputTokens(
  requested: number | undefined,
  _tokenBudget: number,
  _tokensUsed: number
): number | undefined {
  return requested == null || requested <= 0
    ? DEFAULT_MAX_OUTPUT_TOKENS
    : requested;
}

function recordToTimingMap(
  record: Record<string, EntryTimingState> | undefined
): Map<string, EntryTimingState> {
  const map = new Map<string, EntryTimingState>();
  if (!record) return map;
  for (const [key, state] of Object.entries(record)) {
    map.set(key, {
      lastActivatedAt:
        typeof state.lastActivatedAt === "number" ? state.lastActivatedAt : -1,
      stickyRemaining:
        typeof state.stickyRemaining === "number" ? state.stickyRemaining : 0,
      cooldownRemaining:
        typeof state.cooldownRemaining === "number" ? state.cooldownRemaining : 0,
    });
  }
  return map;
}

function timingMapToRecord(
  map: Map<string, EntryTimingState>
): Record<string, EntryTimingState> {
  const out: Record<string, EntryTimingState> = {};
  for (const [key, state] of map) {
    if (state.stickyRemaining <= 0 && state.cooldownRemaining <= 0) continue;
    out[key] = {
      lastActivatedAt: state.lastActivatedAt,
      stickyRemaining: state.stickyRemaining,
      cooldownRemaining: state.cooldownRemaining,
    };
  }
  return out;
}
