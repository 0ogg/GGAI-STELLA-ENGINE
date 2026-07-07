/**
 * 노드 귀속 세그먼트 — 순수 함수.
 *
 * 활성 경로의 패치를 전부 적용해 만든 **최종 본문**을 "이 구간을 마지막으로 쓴 노드"
 * 단위로 분해한다. 세그먼트 텍스트를 순서대로 이으면 buildSpans 결과와 정확히 같다.
 *
 * 용도: 노드 귀속 미디어(삽화)의 인라인 표시 위치 계산 — 노드가 현재 본문에서
 * 차지하는 구간을 렌더 시점에 찾는다 (미디어 확장 스펙.md 삽화 절).
 */

import type { Patch, StellaSession } from "../types/session";
import { pathToLeaf } from "./session-text";

export interface NodeSegment {
  /** 이 구간을 마지막으로 쓴(소유한) 노드 id. */
  nodeId: string;
  text: string;
}

export function buildNodeSegments(
  session: StellaSession,
  leafId: string = session.meta.activeLeafId
): NodeSegment[] {
  const path = pathToLeaf(session, leafId);
  let segs: NodeSegment[] = [];
  for (const node of path) {
    for (const patch of node.patches) {
      segs = applySegmentPatch(segs, patch, node.id);
    }
  }
  const out: NodeSegment[] = [];
  for (const s of segs) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && last.nodeId === s.nodeId) last.text += s.text;
    else out.push({ nodeId: s.nodeId, text: s.text });
  }
  return out;
}

/** session-text.ts applyPatch 와 같은 의미론 — 소유 노드 추적만 추가. */
function applySegmentPatch(
  segs: NodeSegment[],
  patch: Patch,
  nodeId: string
): NodeSegment[] {
  switch (patch.op) {
    case "append":
      return [...segs, ...patch.spans.map((s) => ({ nodeId, text: s.text }))];
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
        ...patch.spans.map((s) => ({ nodeId, text: s.text })),
        ...right,
      ];
    }
  }
}

function splitSegments(
  segs: NodeSegment[],
  at: number
): [NodeSegment[], NodeSegment[]] {
  if (at <= 0) return [[], segs.slice()];
  const left: NodeSegment[] = [];
  const right: NodeSegment[] = [];
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
      if (cut > 0) left.push({ nodeId: s.nodeId, text: s.text.slice(0, cut) });
      if (cut < len) right.push({ nodeId: s.nodeId, text: s.text.slice(cut) });
      i++;
      break;
    }
  }
  for (; i < segs.length; i++) right.push(segs[i]);
  return [left, right];
}
