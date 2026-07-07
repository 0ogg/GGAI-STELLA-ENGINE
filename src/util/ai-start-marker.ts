/**
 * 가장 최근 AI 생성 텍스트 시작 위치 — 순수 함수.
 *
 * 삽화 인라인 앵커(illustration-anchors.ts)와 같은 방식으로 저장하지 않고 렌더 시점에
 * "현재 활성 경로에서 가장 최근에 추가된 AI 생성(ai-continue/ai-regen) 노드"가 시작하는
 * offset 을 계산한다. 이어쓰기/재생성/분기 이동이 생기면 다음 렌더에서 자연히 갱신된다.
 */

import type { StellaSession } from "../types/session";
import { buildNodeSegments } from "./node-segments";
import { isAINode } from "./session-tree";

/** 활성 경로에서 가장 최근 AI 노드 세그먼트가 시작하는 raw offset. 없으면 null. */
export function computeLatestAiMarkerOffset(
  session: StellaSession,
  leafId: string = session.meta.activeLeafId
): number | null {
  // 최신(리프) 노드가 사용자 입력이면 마커를 숨긴다 — 이 마커는 "생성 직후
  // 어디서부터 읽으면 되는지" 안내용이라 AI 생성이 가장 최신일 때만 의미가 있다.
  if (!isAINode(session.nodes[leafId])) return null;
  const segments = buildNodeSegments(session, leafId);
  let offset = 0;
  let markerOffset: number | null = null;
  for (const seg of segments) {
    if (isAINode(session.nodes[seg.nodeId])) markerOffset = offset;
    offset += seg.text.length;
  }
  return markerOffset;
}
