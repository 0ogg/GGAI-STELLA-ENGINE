/**
 * 세션 요약 순수 로직 — summaries.json (노드 앵커 누적) 의 계산 계층.
 *
 * 이 파일은 **순수 함수**만 담는다 (vault/AI 의존성 없음).
 * 실제 AI 호출과 summaries.json 저장은 services/summary-service.ts 가 담당한다.
 *
 * 모델:
 *  - 요약 앵커는 노드에 붙고, "직전 앵커 이후 ~ 이 노드까지"의 패시지만 다룬다.
 *  - {{summary}} 는 루트→리프 경로 위 앵커들의 events 나열 + 마지막 앵커의 state 합성.
 *  - 재생성으로 앵커 노드가 경로에서 빠지면 그 요약도 자동 제외 — 무효화 로직 없음.
 */

import type { Span, StellaSession } from "../types/session";
import type {
  SessionSummaries,
  SummaryAnchor,
  SummaryCompaction,
} from "../types/summary";
import { isAINode } from "./session-tree";
import { applyPatch, pathToLeaf, spansLength } from "./session-text";

/** 요약 주기 기본값 — 마지막 앵커 이후 AI 생성 횟수. */
export const DEFAULT_SUMMARY_THRESHOLD = 5;

/** 연속성 참고용으로 요청에 함께 보내는 최근 사건 요약 수. */
export const RECENT_EVENTS_FOR_CONTEXT = 3;

// ─────────────────────────── 경로 위 앵커 ───────────────────────────

/** 루트→리프 경로 위에 있는 요약 앵커를 경로 순서대로 반환. */
export function collectAnchorChain(
  session: StellaSession,
  summaries: SessionSummaries,
  leafId: string = session.meta.activeLeafId
): SummaryAnchor[] {
  const out: SummaryAnchor[] = [];
  for (const node of pathToLeaf(session, leafId)) {
    const anchor = summaries.anchors[node.id];
    if (anchor) out.push(anchor);
  }
  return out;
}

/**
 * {{summary}} 로 주입할 합성 텍스트 — 경로 위 앵커들의 사건 요약을 시간순으로
 * 나열하고, 마지막 앵커의 현재 상황 스냅샷을 붙인다. 앵커가 없으면 빈 문자열.
 *
 * JSON 형식으로 감싸는 이유: 본문(자연어 서술)과 구분되는 메타 정보라는 것을
 * 모델이 명확히 인식하도록 하기 위함.
 */
export function composeSummaryContext(anchors: SummaryAnchor[]): string {
  const events = anchors.map((a) => a.events.trim()).filter((e) => e !== "");
  const state = anchors.length > 0 ? anchors[anchors.length - 1].state.trim() : "";
  if (events.length === 0 && !state) return "";
  return JSON.stringify({ pastEvents: events, currentState: state }, null, 2);
}

// ─────────────────────────── 압축(컴팩트) 반영 합성 ───────────────────────────

/**
 * 경로에 적용되는 "유효 요약" — 오래된 앵커들을 접은 압축본(있으면)과 그 이후 개별
 * 앵커를 분리해 돌려준다.
 *
 *  - compaction: 경로 위 throughNodeId 를 가진 압축 중 **경로상 가장 뒤**의 것.
 *    없으면 null.
 *  - anchors: 압축이 커버하는 노드(throughNodeId 포함) **이후**의 개별 앵커만.
 *    압축이 없으면 경로 위 모든 앵커.
 *
 * 분기 안전: 압축의 throughNodeId 가 현재 경로에 없으면 그 압축은 무시된다(다른 분기의
 * 압축이 이 경로에 새지 않는다).
 */
export function collectEffectiveSummary(
  session: StellaSession,
  summaries: SessionSummaries,
  leafId: string = session.meta.activeLeafId
): { compaction: SummaryCompaction | null; anchors: SummaryAnchor[] } {
  const path = pathToLeaf(session, leafId);
  const indexOf = new Map<string, number>();
  path.forEach((n, i) => indexOf.set(n.id, i));

  // 경로 위 앵커 (경로 순서대로).
  const anchors: SummaryAnchor[] = [];
  for (const node of path) {
    const anchor = summaries.anchors[node.id];
    if (anchor) anchors.push(anchor);
  }

  // 경로 위에서 가장 뒤에 있는 압축을 고른다.
  let best: SummaryCompaction | null = null;
  let bestIdx = -1;
  const compactions = summaries.compactions ?? {};
  for (const key of Object.keys(compactions)) {
    const c = compactions[key];
    const idx = indexOf.get(c.throughNodeId);
    if (idx === undefined) continue;
    if (idx > bestIdx) {
      bestIdx = idx;
      best = c;
    }
  }

  if (!best) return { compaction: null, anchors };
  // 압축이 커버하는 노드(throughNodeId 포함) 이후의 앵커만 개별로 남긴다.
  const kept = anchors.filter((a) => (indexOf.get(a.nodeId) ?? -1) > bestIdx);
  return { compaction: best, anchors: kept };
}

/**
 * 상속 요약 — 다음화로 물려줄 "지금까지의 누적 요약"을 events 한 덩어리 + state 로 합성한다.
 * 압축본이 있으면 앞세우고 이후 앵커 events 를 이어붙인다. leafId 시점까지만 반영한다
 * (다음화가 물려주는 경계 노드까지의 요약). 새 화 root 에 앵커 하나로 심는 데 쓴다.
 */
export function composeInheritedSummary(
  session: StellaSession,
  summaries: SessionSummaries,
  leafId: string = session.meta.activeLeafId
): { events: string; state: string } {
  const { compaction, anchors } = collectEffectiveSummary(session, summaries, leafId);
  const parts: string[] = [];
  if (compaction && compaction.events.trim() !== "") parts.push(compaction.events.trim());
  for (const a of anchors) {
    const e = a.events.trim();
    if (e !== "") parts.push(e);
  }
  const state =
    anchors.length > 0
      ? anchors[anchors.length - 1].state.trim()
      : compaction
      ? compaction.state.trim()
      : "";
  return { events: parts.join("\n\n"), state };
}

/**
 * {{summary}} 주입 텍스트 — 압축 반영 버전. 경로 위 압축본을 앞세우고, 그 이후 앵커의
 * 사건 요약을 이어붙인 뒤, 마지막 상황 스냅샷을 붙인다. composeSummaryContext 와 같은
 * JSON shape 를 낸다 (미리보기=전송본 대전제).
 */
export function composeSummaryContextForPath(
  session: StellaSession,
  summaries: SessionSummaries,
  leafId: string = session.meta.activeLeafId
): string {
  const { compaction, anchors } = collectEffectiveSummary(session, summaries, leafId);
  const events: string[] = [];
  if (compaction && compaction.events.trim() !== "") events.push(compaction.events.trim());
  for (const a of anchors) {
    const e = a.events.trim();
    if (e !== "") events.push(e);
  }
  const state =
    anchors.length > 0
      ? anchors[anchors.length - 1].state.trim()
      : compaction
      ? compaction.state.trim()
      : "";
  if (events.length === 0 && !state) return "";
  return JSON.stringify({ pastEvents: events, currentState: state }, null, 2);
}

/**
 * 경로상 afterNodeId(마지막 앵커) **이후**의 AI 생성 노드 수 — 자동 요약 트리거 판정.
 * afterNodeId 가 없거나 경로에 없으면 경로 전체의 AI 생성 노드를 센다.
 */
export function countGenerationsSince(
  session: StellaSession,
  leafId: string,
  afterNodeId?: string
): number {
  const path = pathToLeaf(session, leafId);
  let start = 0;
  if (afterNodeId) {
    const idx = path.findIndex((n) => n.id === afterNodeId);
    if (idx >= 0) start = idx + 1;
  }
  let count = 0;
  for (let i = start; i < path.length; i++) {
    if (isAINode(path[i])) count++;
  }
  return count;
}

/**
 * 자동 요약의 "확정된" 끝 노드 — 방금 생성된 마지막 턴은 재생성으로 버려질 수 있으니
 * 요약 대상에서 뺀다. 경로 위 AI 생성 노드 중 **끝에서 두 번째**(직전 턴)를 돌려준다.
 * 확정된 직전 턴이 없으면(경로에 AI 노드가 2개 미만) undefined.
 *
 * 한 턴 미루면 두 가지가 해결된다: (1) 방금 턴을 재생성해도 요약 끝 지점이 그대로라
 * 매턴 재요약이 사라지고, (2) N턴까지의 요약은 N+1턴이 그 위에 쌓여 확정된 뒤에 돈다.
 * 수동 요약(지금 요약/개별 재생성)은 실제 leaf 를 쓰므로 이 지연을 적용하지 않는다.
 */
export function lastConfirmedGenerationNode(
  session: StellaSession,
  leafId: string
): string | undefined {
  const path = pathToLeaf(session, leafId);
  const aiIdx: number[] = [];
  for (let i = 0; i < path.length; i++) {
    if (isAINode(path[i])) aiIdx.push(i);
  }
  if (aiIdx.length < 2) return undefined;
  return path[aiIdx[aiIdx.length - 2]].id;
}

/**
 * 밀린 구간을 **앵커 경계 노드들**로 나눈다. 대원칙: **경계 1개 = 요약 요청 1번 =
 * 앵커 1개** — 요청 하나가 끝날 때마다 앵커 하나가 저장·표시된다.
 *
 * afterNodeId(마지막 앵커) 다음부터 leaf 까지 경로를 걸으며 AI 생성이 threshold 개
 * 쌓이면 그 노드를 경계로 닫는다. maxChars 가 주어지면 구간 본문이 그보다 커져도
 * 즉시 경계를 닫는다 — 모델 입력 한도를 넘을 것 같으면 요청을 여러 번으로 쪼개는 게
 * 아니라 **앵커를 더 잘게** 만든다. 남은 꼬리는 leaf 를 마지막 경계로 붙인다.
 * 새 생성이 하나도 없으면 빈 배열.
 */
export function planSummaryBoundaries(
  session: StellaSession,
  leafId: string,
  afterNodeId: string | undefined,
  threshold: number,
  maxChars: number = Infinity
): string[] {
  const path = pathToLeaf(session, leafId);
  let start = 0;
  if (afterNodeId) {
    const idx = path.findIndex((n) => n.id === afterNodeId);
    if (idx >= 0) start = idx + 1;
  }
  const step = Math.max(1, threshold);

  // 경로를 한 번 걸으며 각 노드 직후의 본문 길이를 기록 — 구간 본문 크기 추정용
  // (replace/delete 가 섞이면 근사치지만 예산 판정에는 충분).
  let spans: Span[] = [];
  const lenAfter: number[] = [];
  for (let i = 0; i < path.length; i++) {
    for (const patch of path[i].patches) spans = applyPatch(spans, patch);
    lenAfter.push(spansLength(spans));
  }

  const boundaries: string[] = [];
  let genCount = 0;
  let inSegment = 0;
  let segStartLen = start > 0 ? lenAfter[start - 1] : 0;
  for (let i = start; i < path.length; i++) {
    if (!isAINode(path[i])) continue;
    genCount++;
    inSegment++;
    const grown = lenAfter[i] - segStartLen;
    if (inSegment >= step || grown >= maxChars) {
      boundaries.push(path[i].id);
      inSegment = 0;
      segStartLen = lenAfter[i];
    }
  }
  if (genCount === 0) return [];
  // 마지막 경계가 leaf 가 아니면(꼬리가 남음) leaf 를 마지막 앵커 경계로 붙인다.
  if (boundaries.length === 0 || boundaries[boundaries.length - 1] !== leafId) {
    boundaries.push(leafId);
  }
  return boundaries;
}

/**
 * 새 패시지 추출 — 앵커 시점 본문과 현재 본문의 공통 접두사 이후를 새 구간으로 본다.
 * (편집으로 앞부분이 바뀌면 공통 접두사가 짧아져 바뀐 구간부터 다시 요약 대상이 된다.)
 */
export function extractNewPassage(textAtAnchor: string, textAtLeaf: string): string {
  const max = Math.min(textAtAnchor.length, textAtLeaf.length);
  let i = 0;
  while (i < max && textAtAnchor.charCodeAt(i) === textAtLeaf.charCodeAt(i)) i++;
  return textAtLeaf.slice(i);
}

// ─────────────────────────── AI 입출력 규약 ───────────────────────────

export interface SummaryRequestPayload {
  /** 직전 앵커의 현재 상황 스냅샷 — 없으면 빈 문자열 (세션 첫 요약). */
  previousState: string;
  /** 연속성 참고용 최근 사건 요약 (오래된 것 → 최근 것). */
  recentEvents: string[];
  /** 이번에 요약할 새 패시지 원문. */
  passage: string;
}

export interface SummaryResult {
  events: string;
  state: string;
}

/**
 * 사용자 요약 프롬프트 뒤에 붙는 엔진 고정 입출력 규약.
 * 프롬프트 내용(문체/언어)과 무관하게 JSON 입출력을 강제한다.
 */
export const SUMMARY_IO_INSTRUCTIONS = [
  "Input is a JSON object:",
  '{ "previousState": string, "recentEvents": string[], "passage": string }',
  '"passage" is the new story text to summarize. "previousState" is the situation snapshot',
  'from the previous summary (empty on the first run). "recentEvents" are earlier event',
  "digests provided for continuity only — do not repeat them.",
  "Respond with a JSON object only — no markdown fences, no commentary:",
  '{ "events": string | string[], "state": string }',
  '"events" covers only the new passage (a single string or a list of event strings).',
  '"state" is the full updated situation snapshot.',
].join("\n");

export function buildSummaryRequestBody(payload: SummaryRequestPayload): string {
  return JSON.stringify(payload);
}

// ─────────────────────────── 압축 입출력 규약 ───────────────────────────

/** 압축 결과. state 는 압축하지 않고 경계 앵커의 스냅샷을 그대로 쓴다. */
export interface CompactionResult {
  events: string;
}

export const COMPACTION_IO_INSTRUCTIONS = [
  "You are compressing older story-summary fragments into a single shorter digest.",
  'Input is a JSON object: { "events": string[] } — older event digests in chronological order.',
  "Merge them into ONE concise digest that preserves key plot points, character developments,",
  "and unresolved threads, dropping redundancy and minor detail. Keep chronological order.",
  "Write in the same language as the input.",
  "Respond with a JSON object only — no markdown fences, no commentary:",
  '{ "events": string }',
].join("\n");

export function buildCompactionRequestBody(events: string[]): string {
  return JSON.stringify({ events });
}

/** 압축 응답 파싱 — events 는 문자열 또는 문자열 배열 허용 (summary 와 동일 관용). */
export function parseCompactionResponse(text: string): CompactionResult | null {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const events = coerceSummaryField(obj.events);
    if (events === null || events.trim() === "") return null;
    return { events };
  } catch {
    return null;
  }
}

/**
 * 압축 계획 — 유효 요약(압축본 + 이후 앵커)을 시간순 블록으로 놓고 오래된 상위 절반을
 * 고른다. 블록이 2개 미만이면(접을 게 없으면) null. 항상 최소 1개 블록은 최근분으로 남긴다.
 */
export function planCompaction(effective: {
  compaction: SummaryCompaction | null;
  anchors: SummaryAnchor[];
}): { throughNodeId: string; state: string; oldEvents: string[] } | null {
  const blocks: { events: string; nodeId: string; state: string }[] = [];
  if (effective.compaction) {
    blocks.push({
      events: effective.compaction.events,
      nodeId: effective.compaction.throughNodeId,
      state: effective.compaction.state,
    });
  }
  for (const a of effective.anchors) {
    blocks.push({ events: a.events, nodeId: a.nodeId, state: a.state });
  }
  if (blocks.length < 2) return null;

  let olderCount = Math.ceil(blocks.length / 2);
  if (olderCount >= blocks.length) olderCount = blocks.length - 1;
  const older = blocks.slice(0, olderCount);
  const boundary = older[older.length - 1];
  const oldEvents = older.map((b) => b.events.trim()).filter((e) => e !== "");
  if (oldEvents.length === 0) return null;
  return { throughNodeId: boundary.nodeId, state: boundary.state, oldEvents };
}

/**
 * events/state 필드 정규화 — 문자열이면 그대로, 문자열 배열이면 줄바꿈으로 이어붙인다.
 * 모델이 "events"(복수)를 리스트로 내놓는 경우가 흔해 배열도 받아 문자열로 만든다.
 * 그 외 타입은 null (형식 위반).
 */
function coerceSummaryField(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === "string")) return null;
    return (value as string[]).map((v) => v.trim()).filter((v) => v !== "").join("\n");
  }
  return null;
}

/** 응답 파싱 — 코드펜스 허용, events/state 는 문자열 또는 문자열 배열 허용. */
export function parseSummaryResponse(text: string): SummaryResult | null {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const events = coerceSummaryField(obj.events);
    const state = coerceSummaryField(obj.state);
    if (events === null || state === null) return null;
    if (events.trim() === "" && state.trim() === "") return null;
    return { events, state };
  } catch {
    return null;
  }
}

// ─────────────────────────── 기록 ───────────────────────────

/**
 * 요약 앵커 기록 — 같은 노드에 이미 앵커가 있으면 내용을 갱신한다 (createdAt 유지).
 * 넘겨받은 summaries 객체를 in-place 로 수정하고 기록된 앵커를 반환한다.
 */
export function recordSummaryAnchor(
  summaries: SessionSummaries,
  input: {
    nodeId: string;
    fromNodeId?: string;
    events: string;
    state: string;
    modelProfileId?: string;
    promptId?: string;
    now?: number;
  }
): SummaryAnchor {
  const existing = summaries.anchors[input.nodeId];
  const now = input.now ?? Date.now();
  const anchor: SummaryAnchor = {
    nodeId: input.nodeId,
    fromNodeId: input.fromNodeId,
    events: input.events,
    state: input.state,
    modelProfileId: input.modelProfileId,
    promptId: input.promptId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  summaries.anchors[input.nodeId] = anchor;
  return anchor;
}

/**
 * 압축본 기록 — throughNodeId 를 키로 저장(in-place). 오래된 앵커 자체는 지우지 않고
 * 덮어쓰기(합성 시 override)만 한다. 이전 압축을 오래된 절반에 흡수했다면 그 이전
 * throughNodeId 의 압축본은 이제 무의미하므로 제거한다.
 */
export function recordCompaction(
  summaries: SessionSummaries,
  input: {
    throughNodeId: string;
    events: string;
    state: string;
    tokens?: number;
    now?: number;
    /** 이번 압축에 흡수된 이전 압축의 throughNodeId (있으면 제거). */
    absorbedThroughNodeId?: string;
  }
): SummaryCompaction {
  if (!summaries.compactions) summaries.compactions = {};
  const now = input.now ?? Date.now();
  const existing = summaries.compactions[input.throughNodeId];
  if (
    input.absorbedThroughNodeId &&
    input.absorbedThroughNodeId !== input.throughNodeId
  ) {
    delete summaries.compactions[input.absorbedThroughNodeId];
  }
  const compaction: SummaryCompaction = {
    throughNodeId: input.throughNodeId,
    events: input.events,
    state: input.state,
    tokens: input.tokens,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  summaries.compactions[input.throughNodeId] = compaction;
  return compaction;
}

/**
 * 구버전 릴레이 체크포인트(pending)를 지운다(in-place). 릴레이 방식은 폐기됐다 —
 * 이제 요청 1번 = 앵커 1개라 앵커 저장 자체가 진행 기록이고, 중단 시에는 다음
 * 실행이 마지막 저장 앵커 다음 경계부터 자연히 이어간다. 옛 파일 정리용으로만 남긴다.
 */
export function clearSummaryCheckpoint(summaries: SessionSummaries): void {
  delete summaries.pending;
}
