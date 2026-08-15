/**
 * 익명 발화자 이름표(QR `/sendas name=`) 인라인 앵커 — 순수 함수.
 *
 * 삽화·노트 앵커와 같은 규칙: **표시 위치를 저장하지 않고** 렌더 시점에 계산한다.
 * 다른 점은 기준점이 "노드가 마지막으로 기여한 자리"가 아니라 **처음 기여한 자리**라는
 * 것뿐이다 — 이름표는 그 발화가 시작되는 문단 앞에 붙어야 하기 때문이다.
 *
 * 이름을 본문 글자로 박지 않는 이유: 본문은 문자 오프셋 기준으로 패치·번역·삽화
 * 앵커가 전부 물려 있어서, 접두어를 넣으면 그 모든 위치가 밀린다.
 */

import type { SessionNodeMetaMap } from "../types/node-meta";
import type { StellaSession } from "../types/session";
import { nodeSpanRanges } from "./node-segments";
import { buildSpans, spansToText } from "./session-text";

export interface SpeakerLabelAnchor {
  nodeId: string;
  name: string;
  /** 최종 본문(raw) 기준 삽입 지점 — 이 offset 바로 앞에 이름표를 꽂는다. */
  offset: number;
}

export function computeSpeakerLabelAnchors(
  session: StellaSession,
  meta: SessionNodeMetaMap | null | undefined,
  leafId: string = session.meta.activeLeafId
): SpeakerLabelAnchor[] {
  const names = meta?.nodes ?? {};
  if (Object.keys(names).length === 0) return [];
  const text = spansToText(buildSpans(session, leafId));
  const firstStart = new Map<string, number>();
  for (const range of nodeSpanRanges(session, leafId)) {
    if (range.to === range.from) continue;
    if (!firstStart.has(range.nodeId)) firstStart.set(range.nodeId, range.from);
  }
  const anchors: SpeakerLabelAnchor[] = [];
  for (const [nodeId, start] of firstStart) {
    const name = names[nodeId]?.speakerName?.trim();
    if (!name) continue;
    // 이 노드가 붙인 앞머리 구분자(줄바꿈)를 먼저 건너뛴다 — 안 그러면 스냅이
    // **앞 문단**의 시작으로 되돌아가 남의 글 앞에 이름표가 붙는다.
    let s = start;
    while (s < text.length && text[s] === "\n") s++;
    // 문단 시작으로 스냅 — 이름표는 문단 앞에 놓인다(문단 중간에 끼면 글이 갈라진다).
    const offset = s <= 0 ? 0 : text.lastIndexOf("\n", s - 1) + 1;
    anchors.push({ nodeId, name, offset });
  }
  anchors.sort((a, b) => a.offset - b.offset);
  return anchors;
}
