import type { StellaSession, Span } from "../types/session";
import type { ContextBuilderInputV2 } from "./context-builder";

/**
 * 활성 경로의 본문(spans) → 컨텍스트 빌더용 대화 로그.
 *
 * 이어쓰기 보정용 trailing user 턴(예전 "[Continue the story from here.]")은 더 이상
 * 붙이지 않는다. 소설 본문은 assistant 로 끝나며, 챗 모델은 그 뒤를 이어서(prefill /
 * continuation) 생성한다. text 완성형(NovelAI)도 본문에 지시문이 섞이지 않는다.
 */
export function buildSessionLog(
  spans: Span[],
  mode: StellaSession["meta"]["mode"]
): ContextBuilderInputV2["sessionLog"] {
  if (mode !== "chat") {
    const body = spans.map((span) => span.text).join("");
    const messages: ContextBuilderInputV2["sessionLog"] = [];
    if (body.trim()) messages.push({ role: "assistant", content: body });
    return messages;
  }

  return buildSplitRoleMessages(spans);
}

function buildSplitRoleMessages(spans: Span[]): ContextBuilderInputV2["sessionLog"] {
  const messages: ContextBuilderInputV2["sessionLog"] = [];
  for (const span of spans) {
    if (!span.text.trim()) continue;
    const role = span.author === "user" ? "user" : "assistant";
    const last = messages[messages.length - 1];
    if (last?.role === role) {
      last.content += span.text;
    } else {
      messages.push({ role, content: span.text });
    }
  }

  return messages;
}

export function hasSameTextState(
  a: StellaSession,
  b: StellaSession
): boolean {
  return (
    a.meta.rootId === b.meta.rootId &&
    a.meta.activeLeafId === b.meta.activeLeafId &&
    JSON.stringify(a.nodes) === JSON.stringify(b.nodes)
  );
}

/**
 * 세션의 본문(rootId / activeLeafId / nodes) 상태를 비교 가능한 문자열로 요약.
 * refreshSession 이 같은 객체를 제자리 갱신하므로, 갱신 전후를 비교하려면
 * 갱신 전에 이 키를 따로 보관해둬야 한다.
 */
export function sessionTextKey(s: StellaSession): string {
  return `${s.meta.rootId}|${s.meta.activeLeafId ?? ""}|${JSON.stringify(s.nodes)}`;
}
