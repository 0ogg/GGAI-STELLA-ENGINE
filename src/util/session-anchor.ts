/**
 * 세션 스크롤 앵커 — 순수 함수.
 *
 * 픽셀 스크롤 위치 대신 "보고 있던 노드 + 노드 내 글자 위치"로 읽던 자리를 기록한다.
 * 출력 방식(원문 치환 / 번역 / 2분할)이나 폰트·너비가 바뀌어 픽셀 높이가 달라져도
 * 같은 내용으로 복원되며, 노드 단위라 분기 이동·외부 편집에도 비교적 강건하다.
 *
 * 노드 ↔ 본문 char offset 변환은 `buildNodeSegments` (활성 경로 최종 본문의 노드 귀속)
 * 를 그대로 쓴다. 세그먼트 텍스트를 이으면 buildSpans 결과(=baseline 본문)와 같다.
 */

import type { StellaSession } from "../types/session";
import { buildNodeSegments } from "./node-segments";

export interface SessionScrollAnchor {
  /** 이 지점을 소유한 노드 id. */
  nodeId: string;
  /** 노드 세그먼트 안에서의 글자 offset. */
  charInNode: number;
}

/** baseline 본문 char offset → 그 지점을 소유한 노드 기준 앵커. */
export function offsetToNodeAnchor(
  session: StellaSession,
  offset: number
): SessionScrollAnchor | null {
  const segs = buildNodeSegments(session);
  if (segs.length === 0) return null;
  let acc = 0;
  for (const s of segs) {
    const len = s.text.length;
    if (offset < acc + len) {
      return { nodeId: s.nodeId, charInNode: Math.max(0, offset - acc) };
    }
    acc += len;
  }
  const last = segs[segs.length - 1];
  return { nodeId: last.nodeId, charInNode: last.text.length };
}

/** 노드 앵커 → 현재 baseline 본문의 char offset. 노드가 사라졌으면 null. */
export function nodeAnchorToOffset(
  session: StellaSession,
  anchor: SessionScrollAnchor
): number | null {
  const segs = buildNodeSegments(session);
  let acc = 0;
  for (const s of segs) {
    if (s.nodeId === anchor.nodeId) {
      return acc + Math.max(0, Math.min(anchor.charInNode, s.text.length));
    }
    acc += s.text.length;
  }
  return null;
}
