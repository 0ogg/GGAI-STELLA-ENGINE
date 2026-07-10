/**
 * 챗 모드 메시지 재구성 — 순수 로직 (M6/C1).
 *
 * 챗 세션의 대전제: **노드 1개 = 메시지 1개** (append 패치).
 *  - 역할은 span author 가 아니라 노드 kind 로 결정한다
 *    (root/ai-continue/ai-regen = assistant, user-write = user).
 *  - 메시지 편집은 user-edit 노드의 replace/delete 패치 — 원래 메시지의
 *    노드/역할을 유지한 채 텍스트만 바뀐다 (제자리 수정 금지).
 *  - 본문 평탄화(buildSpans)와 같은 문자 오프셋 체계를 쓰므로, 번역/요약/로어북 등
 *    본문 텍스트를 읽는 공용 기능과 오프셋이 어긋나지 않는다.
 *
 * 메시지 구분자: 챗 뷰는 두 번째 메시지부터 append 텍스트 앞에 "\n\n" 를 붙인다
 * (CHAT_MESSAGE_SEPARATOR). 평탄화된 본문이 문단 단위 기능(번역 등)에 자연스럽게
 * 보이게 하기 위한 것으로, 전송 로그에서는 trim 되어 사라진다.
 */

import type { StellaSession, TurnKind } from "../types/session";
import { pathToLeaf } from "./session-text";

/** 챗 메시지 사이 구분자 — 챗 뷰가 append 패치 텍스트 앞에 붙인다. */
export const CHAT_MESSAGE_SEPARATOR = "\n\n";

export interface ChatSessionMessage {
  /** 이 메시지를 만든 노드 — 편집돼도 유지 (삽화/스와이프 귀속 기준). */
  nodeId: string;
  role: "user" | "assistant";
  /** 평탄화 본문에서 이 메시지가 차지하는 원시 텍스트 (구분자 포함 가능). */
  text: string;
}

/** 노드 kind → 메시지 역할. user-edit 는 자기 메시지가 없는 편집 노드라 null. */
export function chatRoleOfKind(kind: TurnKind): "user" | "assistant" | null {
  switch (kind) {
    case "user-write":
      return "user";
    case "user-edit":
      return null;
    default:
      return "assistant";
  }
}

/**
 * 루트→리프 경로를 걸어 메시지 목록을 재구성한다.
 *  - append (역할 있는 노드) = 새 메시지.
 *  - append (user-edit — 챗 뷰는 안 만들지만 방어) = 마지막 메시지에 이어붙임.
 *  - replace/delete = 겹치는 메시지의 텍스트만 고침. 삽입 텍스트는 시작 지점이
 *    속한 메시지 소속. 편집으로 텍스트가 완전히 빈 메시지는 목록에서 빠진다
 *    (= 메시지 삭제).
 */
export function buildChatMessages(
  session: StellaSession,
  leafId?: string
): ChatSessionMessage[] {
  const path = pathToLeaf(session, leafId ?? session.meta.activeLeafId);
  const messages: ChatSessionMessage[] = [];

  for (const node of path) {
    for (const patch of node.patches) {
      if (patch.op === "append") {
        const text = patch.spans.map((s) => s.text).join("");
        if (!text) continue;
        const role = chatRoleOfKind(node.kind);
        if (role) {
          messages.push({ nodeId: node.id, role, text });
        } else if (messages.length > 0) {
          messages[messages.length - 1].text += text;
        } else {
          messages.push({ nodeId: node.id, role: "assistant", text });
        }
      } else {
        const insert =
          patch.op === "replace" ? patch.spans.map((s) => s.text).join("") : "";
        applyRangeEdit(messages, patch.from, patch.to, insert);
      }
    }
  }

  return messages.filter((m) => m.text.length > 0);
}

/**
 * [from, to) 구간을 지우고 from 위치에 insert 를 넣는다 — 메시지 경계 유지.
 * 오프셋은 메시지 텍스트를 이어붙인 평탄화 본문 기준 (buildSpans 와 동일 체계).
 * 삽입 텍스트는 from 이 내부에 떨어지는 첫 메시지 소속 (본문 끝이면 마지막 메시지).
 */
function applyRangeEdit(
  messages: ChatSessionMessage[],
  from: number,
  to: number,
  insert: string
): void {
  if (messages.length === 0) return;

  // 삽입 소유자 결정 — from 이 자기 범위 안([start, end))에 있는 첫 메시지.
  let ownerIdx = messages.length - 1;
  let scan = 0;
  for (let i = 0; i < messages.length; i++) {
    const end = scan + messages[i].text.length;
    if (from < end) {
      ownerIdx = i;
      break;
    }
    scan = end;
  }

  let offset = 0;
  messages.forEach((msg, i) => {
    const start = offset;
    const end = start + msg.text.length;
    offset = end;

    let text = msg.text;
    const delFrom = Math.max(from, start);
    const delTo = Math.min(to, end);
    if (delTo > delFrom) {
      text = text.slice(0, delFrom - start) + text.slice(delTo - start);
    }
    if (i === ownerIdx && insert) {
      const at = Math.min(Math.max(from - start, 0), text.length);
      text = text.slice(0, at) + insert + text.slice(at);
    }
    msg.text = text;
  });
}

/**
 * 전송용 대화 로그 — 구분자/공백을 정리한 {role, content} 목록.
 * planSessionRequest 가 챗 세션의 sessionLog 로 사용한다 (span author 추측 금지 —
 * 연속 같은 역할 메시지도 별개 항목으로 유지된다).
 */
export function buildChatLog(
  session: StellaSession,
  leafId?: string
): { role: "user" | "assistant"; content: string }[] {
  return buildChatMessages(session, leafId)
    .map((m) => ({ role: m.role, content: m.text.trim() }))
    .filter((m) => m.content.length > 0);
}
