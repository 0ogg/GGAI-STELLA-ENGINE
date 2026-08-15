/**
 * 노드 귀속 세그먼트 — 순수 함수.
 *
 * 활성 경로의 패치를 전부 적용해 만든 **최종 본문**을 "이 구간을 마지막으로 쓴 노드"
 * 단위로 분해한다. 세그먼트 텍스트를 순서대로 이으면 buildSpans 결과와 정확히 같다.
 *
 * 용도: 노드 귀속 미디어(삽화)의 인라인 표시 위치 계산 — 노드가 현재 본문에서
 * 차지하는 구간을 렌더 시점에 찾는다 (미디어 확장 스펙.md 삽화 절).
 */

import type { Patch, Span, StellaSession } from "../types/session";
import { normalize, pathToLeaf } from "./session-text";

export interface NodeSegment {
  /** 이 구간을 마지막으로 쓴(소유한) 노드 id. */
  nodeId: string;
  text: string;
}

/** 소유 노드 + 저자를 함께 들고 있는 미병합 조각 (내부 표현). */
interface AuthoredSegment extends NodeSegment {
  author: Span["author"];
}

export function buildNodeSegments(
  session: StellaSession,
  leafId: string = session.meta.activeLeafId
): NodeSegment[] {
  const out: NodeSegment[] = [];
  for (const s of buildAuthoredSegments(session, leafId)) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && last.nodeId === s.nodeId) last.text += s.text;
    else out.push({ nodeId: s.nodeId, text: s.text });
  }
  return out;
}

/**
 * 특정 노드들의 구간을 뺀 본문 스팬 — "AI에게 숨김"(`node-meta.json`) 노드를
 * 전송본에서 걷어내는 데 쓴다. 화면·저장 원문은 건드리지 않는다(표시는 그대로).
 * 제외 집합이 비면 `buildSpans` 와 완전히 같은 결과다.
 */
export function spansExcludingNodes(
  session: StellaSession,
  leafId: string,
  exclude: ReadonlySet<string>
): Span[] {
  const segs = buildAuthoredSegments(session, leafId);
  return normalize(
    segs
      .filter((s) => !exclude.has(s.nodeId))
      .map((s) => ({ author: s.author, text: s.text }))
  );
}

function buildAuthoredSegments(
  session: StellaSession,
  leafId: string
): AuthoredSegment[] {
  const path = pathToLeaf(session, leafId);
  let segs: AuthoredSegment[] = [];
  for (const node of path) {
    for (const patch of node.patches) {
      segs = applySegmentPatch(segs, patch, node.id);
    }
  }
  return segs;
}

/** session-text.ts applyPatch 와 같은 의미론 — 소유 노드 추적만 추가. */
function applySegmentPatch(
  segs: AuthoredSegment[],
  patch: Patch,
  nodeId: string
): AuthoredSegment[] {
  switch (patch.op) {
    case "append":
      return [
        ...segs,
        ...patch.spans.map((s) => ({ nodeId, author: s.author, text: s.text })),
      ];
    case "delete": {
      const [left, rest] = splitSegments(segs, patch.from);
      const [, right] = splitSegments(rest, patch.to - patch.from);
      return [...left, ...right];
    }
    case "replace": {
      const [left, rest] = splitSegments(segs, patch.from);
      const [, right] = splitSegments(rest, patch.to - patch.from);
      return [
        ...left,
        ...patch.spans.map((s) => ({ nodeId, author: s.author, text: s.text })),
        ...right,
      ];
    }
  }
}

function splitSegments(
  segs: AuthoredSegment[],
  at: number
): [AuthoredSegment[], AuthoredSegment[]] {
  if (at <= 0) return [[], segs.slice()];
  const left: AuthoredSegment[] = [];
  const right: AuthoredSegment[] = [];
  let consumed = 0;
  let i = 0;
  for (; i < segs.length; i++) {
    const s = segs[i];
    const len = s.text.length;
    if (consumed + len <= at) {
      left.push(s);
      consumed += len;
      if (consumed === at) {
        i++;
        break;
      }
    } else {
      const cut = at - consumed;
      if (cut > 0) left.push({ ...s, text: s.text.slice(0, cut) });
      if (cut < len) right.push({ ...s, text: s.text.slice(cut) });
      i++;
      break;
    }
  }
  for (; i < segs.length; i++) right.push(segs[i]);
  return [left, right];
}

/** 노드별 구간 범위(최종 본문 기준) — 표시(흐리게)나 이름표 앵커 계산용. */
export interface NodeSpanRange {
  nodeId: string;
  from: number;
  to: number;
}

/** 노드가 최종 본문에서 차지하는 구간들 (등장 순서, 인접한 같은 노드는 합침). */
export function nodeSpanRanges(
  session: StellaSession,
  leafId: string = session.meta.activeLeafId
): NodeSpanRange[] {
  const out: NodeSpanRange[] = [];
  let offset = 0;
  for (const seg of buildNodeSegments(session, leafId)) {
    out.push({ nodeId: seg.nodeId, from: offset, to: offset + seg.text.length });
    offset += seg.text.length;
  }
  return out;
}
