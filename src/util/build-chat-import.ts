/**
 * 실리태번 채팅 → 세션 노드 트리 빌더 — 순수 로직.
 *
 * 대전제:
 *  - 메시지 1개 = 노드 1개 (append 패치). 역할은 노드 kind.
 *  - 스와이프(재생성 대안) = 같은 부모 밑 형제 노드. 활성 스와이프가 본문 경로.
 *  - 다음 메시지는 직전 메시지의 **활성 스와이프** 밑에 붙는다 (비활성 스와이프는 leaf 로 끝).
 *  - 노드 append 텍스트는 두 번째 메시지부터 앞에 "\n\n"(CHAT_MESSAGE_SEPARATOR)을 포함한다
 *    — 챗 세션이 native 로 만드는 노드와 동일한 평탄화 체계.
 *
 * 본문은 항상 **원문(모델 생성 언어)** 이다. 번역 익스텐션을 쓴 채팅이라도 번역본은
 * 가져오지 않는다 — 원문/번역 문단 나눔이 달라 문단 단위 번역 메모리로 신뢰성 있게
 * 저장할 수 없기 때문(사용자 결정). 필요하면 세션에서 번역 기능으로 새로 번역한다.
 */

import type { ParsedStChat } from "../import/parse-sillytavern-chat";
import type { SessionMode, SessionNode, Span, TurnKind } from "../types/session";
import { CHAT_MESSAGE_SEPARATOR } from "./chat-messages";
import { uuidv4 } from "./uuid";

export interface ChatImportBuild {
  nodes: Record<string, SessionNode>;
  rootId: string;
  activeLeafId: string;
}

export function buildChatImportSession(
  parsed: ParsedStChat,
  _mode: SessionMode,
  now: number
): ChatImportBuild {
  const nodes: Record<string, SessionNode> = {};
  let order = 0;
  let rootId = "";
  let prevActive = ""; // 직전 메시지의 활성 스와이프 노드 id

  parsed.messages.forEach((msg, mIdx) => {
    const isFirst = mIdx === 0;
    const parent: string | null = isFirst ? null : prevActive;
    const author: Span["author"] = msg.role === "user" ? "user" : "ai";

    let activeId = "";
    let firstId = "";

    msg.swipes.forEach((sw, sIdx) => {
      const id = uuidv4();
      // 첫 메시지도 역할을 따른다 — 유저가 먼저 시작한 채팅(인사말 없음)의 첫
      // 메시지를 "root"(=assistant)로 뭉개면 AI 말풍선/AI 발화로 잘못 잡힌다.
      // 역할은 노드 kind 가 결정하므로(chatRoleOfKind) parent=null 이어도 문제없다.
      const kind: TurnKind = isFirst
        ? msg.role === "user"
          ? "user-write"
          : "root"
        : msg.role === "user"
        ? "user-write"
        : sIdx === msg.activeIndex
        ? "ai-continue"
        : "ai-regen";
      const body = (isFirst ? "" : CHAT_MESSAGE_SEPARATOR) + sw.source;
      nodes[id] = {
        id,
        parent,
        kind,
        patches: body ? [{ op: "append", spans: [{ author, text: body }] }] : [],
        createdAt: now + order++,
      };
      if (sIdx === 0) firstId = id;
      if (sIdx === msg.activeIndex) activeId = id;
    });

    if (!activeId) activeId = firstId;
    if (isFirst) rootId = activeId || firstId;
    prevActive = activeId;
  });

  if (!rootId) {
    const id = uuidv4();
    nodes[id] = { id, parent: null, kind: "root", patches: [], createdAt: now };
    rootId = id;
    prevActive = id;
  }

  return { nodes, rootId, activeLeafId: prevActive || rootId };
}
