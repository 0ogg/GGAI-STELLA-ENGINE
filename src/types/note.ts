/**
 * 세션 노트 스키마 — 세션 폴더 `notes.json`.
 *
 * QR `/comment` 가 남기는 "그 스토리 지점의 부산물"(외전·설정 메모 등)이다.
 * 인라인 삽화와 **같은 메커니즘**을 쓴다 (QR 스펙.md `/comment` 절):
 *  - 노드 귀속 저장, **표시 위치는 저장하지 않는다** — 렌더 시 앵커를 계산한다.
 *    그래서 본문을 편집하거나 분기를 갈아타도 어긋날 저장 상태가 없다.
 *  - 그 노드가 현재 분기에 없으면 안 보이고, 돌아오면 제자리에 다시 뜬다.
 *  - 위젯은 글자 0개 원자 블록이라 **전송본에 애초에 안 들어간다**(AI 에 안 감).
 *
 * 삽화와 다른 점: 삽화는 노드당 variant 중 active 1개만 보이지만, 노트는 같은 지점에서
 * 두 번 돌리면 **둘 다 남아야** 한다(외전 두 편은 대체재가 아니다) → 노드당 목록.
 */

export interface SessionNote {
  id: string;
  /** 귀속 노드 — 이 노드가 활성 경로에 있을 때만 표시된다. */
  nodeId: string;
  /** 접이식 위젯의 제목 (`<summary>` 에서 뽑은 것). 없으면 빈 문자열. */
  title: string;
  body: string;
  createdAt: number;
}

/** 세션 폴더 `notes.json`. */
export interface SessionNotes {
  schemaVersion: 1;
  /** 생성 순서 그대로 (같은 노드에 여러 개 = 등장 순서). */
  notes: SessionNote[];
}

export function createEmptySessionNotes(): SessionNotes {
  return { schemaVersion: 1, notes: [] };
}

export function normalizeSessionNotes(raw: unknown): SessionNotes {
  const empty = createEmptySessionNotes();
  if (!raw || typeof raw !== "object") return empty;
  const list = (raw as Partial<SessionNotes>).notes;
  if (!Array.isArray(list)) return empty;
  const notes: SessionNote[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const n = item as Partial<SessionNote>;
    if (typeof n.id !== "string" || typeof n.nodeId !== "string") continue;
    notes.push({
      id: n.id,
      nodeId: n.nodeId,
      title: typeof n.title === "string" ? n.title : "",
      body: typeof n.body === "string" ? n.body : "",
      createdAt: typeof n.createdAt === "number" ? n.createdAt : Date.now(),
    });
  }
  return { schemaVersion: 1, notes };
}

/** 노드에 달린 노트들 (등장 순서). */
export function notesOfNode(notes: SessionNotes, nodeId: string): SessionNote[] {
  return notes.notes.filter((n) => n.nodeId === nodeId);
}
