import type { ChatMessage } from "./context-builder";

/**
 * 빈 메시지 제거 + 연속된 같은 role 병합. 이것이 chat 프로필에 실제로 전송되는
 * 최종 메시지 배열이다 (미리보기도 이 결과를 그대로 보여준다).
 * 이어쓰기 보정용 trailing user 턴은 더 이상 주입하지 않는다 — 소설 본문은
 * assistant 로 끝나고 모델이 그 뒤를 이어서 생성한다 (prefill / continuation).
 *
 * source 등 부가 메타는 보존한다(전송 내용에는 영향 없음, 미리보기 출처 표시용).
 */
export function normalizeMessagesForChat(
  messages: ChatMessage[]
): ChatMessage[] {
  const nonEmpty = messages.filter(
    (m) => m.content && m.content.trim().length > 0
  );

  const merged: ChatMessage[] = [];
  for (const m of nonEmpty) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      merged.push({ ...m });
    }
  }

  return merged;
}
