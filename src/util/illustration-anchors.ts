/**
 * 인라인 삽화 앵커 — 순수 함수.
 *
 * 삽화는 노드 귀속(illustrations.json)이고, 인라인 표시 위치는 **저장하지 않는다**.
 * 그릴 때마다 "현재 본문 + 노드 귀속 세그먼트"에서 새로 계산하므로, 편집/분기 이동으로
 * 본문이 바뀌어도 계산이 어긋날 저장 상태 자체가 없다 (미디어 확장 스펙.md 삽화 절).
 *
 * 앵커 규칙: 노드가 마지막으로 기여한 글자를 기준으로,
 *  - 그 지점에서 문단이 끝났으면(직후가 줄바꿈이거나 줄바꿈 안에서 끝) → 그 문단 뒤.
 *  - 문단 중간(또는 본문 끝 미완 꼬리)에서 끝났으면 → 그 문단 앞
 *    (= "마지막으로 끝난 문단 뒤, 미완 문단 앞").
 * 결과 offset 은 항상 문단 시작(또는 0/본문 끝)이라 문단 토큰/스팬 경계와 일치한다.
 * 노드의 기여 텍스트가 편집으로 전부 사라졌으면 앵커가 없다(인라인 미표시, 갤러리엔 유지).
 */

import type { SessionIllustrations } from "../types/media";
import type { StellaSession } from "../types/session";
import { getActiveIllustration } from "./illustrations";
import { buildNodeSegments } from "./node-segments";

export interface IllustrationAnchor {
  nodeId: string;
  /** 최종 본문(raw) 기준 삽입 지점 — 이 offset 바로 앞에 위젯을 꽂는다. */
  offset: number;
}

/**
 * 자동 삽화 생성 주기의 기본값(문단) — 활성 경로의 마지막 삽화 앵커 이후 완성
 * 문단이 이 개수 이상 쌓였을 때만 새 자동 삽화를 생성한다. 사용자가 삽화 설정에서
 * 값을 지정하면 그 값을 쓰고(0 = 매번), 생략 시 이 기본값을 쓴다.
 */
export const DEFAULT_ILLUSTRATION_AUTO_MIN_PARAGRAPHS = 5;

/** 활성 경로에서 active 삽화가 있는 노드들의 인라인 앵커 (offset 오름차순). */
export function computeIllustrationAnchors(
  session: StellaSession,
  illustrations: SessionIllustrations,
  leafId: string = session.meta.activeLeafId
): IllustrationAnchor[] {
  const segments = buildNodeSegments(session, leafId);
  let text = "";
  // 노드별 마지막 기여 구간의 끝 offset (뒤 구간이 앞 구간을 덮어씀).
  const lastEnd = new Map<string, number>();
  for (const seg of segments) {
    text += seg.text;
    lastEnd.set(seg.nodeId, text.length);
  }
  const anchors: IllustrationAnchor[] = [];
  for (const [nodeId, end] of lastEnd) {
    if (!getActiveIllustration(illustrations, nodeId)) continue;
    anchors.push({ nodeId, offset: inlineAnchorOffset(text, end) });
  }
  // 같은 offset 은 문서 순서(안정 정렬 + Map 삽입 순서 = 마지막 기여 순) 유지.
  anchors.sort((a, b) => a.offset - b.offset);
  return anchors;
}

/** 노드 기여 끝(end, exclusive) → 앵커 규칙 적용한 문단 경계 offset. */
export function inlineAnchorOffset(text: string, end: number): number {
  const e = Math.max(0, Math.min(end, text.length));
  if (e === 0) return 0;
  if (text[e - 1] === "\n" || (e < text.length && text[e] === "\n")) {
    // 기여가 문단을 끝냄 — 이어지는 구분자(줄바꿈 묶음)를 건너뛰어 다음 문단 시작에.
    let j = e;
    while (j < text.length && text[j] === "\n") j++;
    return j;
  }
  // 문단 중간/미완 꼬리에서 끝남 — 그 문단 시작에 (직전 구분자 다음).
  return text.lastIndexOf("\n", e - 1) + 1;
}

/**
 * offset(문단 시작) 이후의 완성 문단 수 — 완성 = 뒤에 줄바꿈이 따라오는 문단.
 * 본문 끝 미완 꼬리는 세지 않는다. 자동 인라인 삽화의 밀도 판단에 쓴다.
 */
export function completedParagraphsAfter(text: string, offset: number): number {
  let count = 0;
  let i = Math.max(0, offset);
  while (i < text.length) {
    const nl = text.indexOf("\n", i);
    if (nl === -1) break;
    if (nl > i) count++;
    i = nl + 1;
  }
  return count;
}
