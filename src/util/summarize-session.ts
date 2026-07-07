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
import type { SessionSummaries, SummaryAnchor } from "../types/summary";
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
 * 구버전 릴레이 체크포인트(pending)를 지운다(in-place). 릴레이 방식은 폐기됐다 —
 * 이제 요청 1번 = 앵커 1개라 앵커 저장 자체가 진행 기록이고, 중단 시에는 다음
 * 실행이 마지막 저장 앵커 다음 경계부터 자연히 이어간다. 옛 파일 정리용으로만 남긴다.
 */
export function clearSummaryCheckpoint(summaries: SessionSummaries): void {
  delete summaries.pending;
}
