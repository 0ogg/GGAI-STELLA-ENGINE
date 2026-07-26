/**
 * 세션 노트(QR `/comment`) 인라인 앵커 — 순수 함수.
 *
 * 인라인 삽화와 같은 규칙을 쓴다(`illustration-anchors.ts`): 표시 위치는 저장하지 않고
 * "현재 본문 + 노드 귀속 세그먼트"에서 매번 다시 계산한다. 그래서 본문 편집/분기 이동으로
 * 어긋날 저장 상태가 없고, 그 노드가 활성 경로에 없으면 자연히 표시되지 않는다.
 *
 * 삽화와 다른 점 하나: 노드당 **여러 개**가 나올 수 있다(외전 두 편은 대체재가 아니다).
 */

import type { SessionNote, SessionNotes } from "../types/note";
import type { StellaSession } from "../types/session";
import { inlineAnchorOffset } from "./illustration-anchors";
import { buildNodeSegments } from "./node-segments";

export interface NoteAnchor {
  note: SessionNote;
  /** 최종 본문(raw) 기준 삽입 지점 — 이 offset 바로 앞에 위젯을 꽂는다. */
  offset: number;
}

/** 활성 경로에 있는 노드의 노트들 — 인라인 앵커 (offset 오름차순, 같은 곳은 생성 순). */
export function computeNoteAnchors(
  session: StellaSession,
  notes: SessionNotes,
  leafId: string = session.meta.activeLeafId
): NoteAnchor[] {
  if (notes.notes.length === 0) return [];
  const segments = buildNodeSegments(session, leafId);
  let text = "";
  const lastEnd = new Map<string, number>();
  for (const seg of segments) {
    text += seg.text;
    lastEnd.set(seg.nodeId, text.length);
  }
  const anchors: NoteAnchor[] = [];
  for (const note of notes.notes) {
    const end = lastEnd.get(note.nodeId);
    if (end === undefined) continue;
    anchors.push({ note, offset: inlineAnchorOffset(text, end) });
  }
  // 같은 offset 은 생성 순서 유지 (안정 정렬).
  anchors.sort((a, b) => a.offset - b.offset);
  return anchors;
}
