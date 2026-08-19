/**
 * **AI 에게 보내는 본문의 단일 창구.** 세션 본문을 AI 요청 재료로 쓰는 코드는
 * (전송본이든 확장이든) 전부 이 파일을 거친다.
 *
 * 왜 창구가 필요한가: 본문 재구성 함수(`buildSpans`)는 **화면에 보이는 원문**을 만든다.
 * 거기엔 "AI에게 숨김"(`node-meta.json`, QR `/hide`·`/comment`) 구간이 그대로 들어 있고,
 * 지난 시점의 본문을 되감으면 나중에 지운 대목도 되살아난다. 확장·서비스가 저마다
 * `buildSpans` 를 직접 부르면 그 두 가지가 매번 새 확장에서 되살아난다 — 실제로
 * 요약·로어북 자동 생성·스텔라 폰이 같은 방식으로 새고 있었다.
 *
 * 그래서 규칙은 하나다: **본문이 AI 로 가는 자리에서는 `buildSpans` 를 직접 부르지 않는다.**
 * (하네스 `tests/architecture-rules.mjs` 가 services/extensions 를 검사한다. 표시·오프셋
 * 계산처럼 원문이 필요한 곳은 `// body-raw:` 주석으로 이유를 남기고 예외로 둔다.)
 *
 * 숨김은 "안 보내기"이지 "안 보이기"가 아니다 — 화면 표시, 번역 문단 키, 삽화 앵커,
 * 편집 diff, 내보내기는 원문 그대로 둔다.
 */

import type { StellaStore } from "../state/store";
import type { StellaSession } from "../types/session";
import { hiddenNodeIds } from "../types/node-meta";
import { spansExcludingNodes, textBetweenNodes } from "./node-segments";
import { buildSpans, spansToText } from "./session-text";

/** 세션의 숨김 노드 집합. 파일이 없거나 못 읽으면 빈 집합(= 도입 전과 같은 동작). */
export async function hiddenNodesOf(
  store: StellaStore,
  sessionFile: string
): Promise<Set<string>> {
  try {
    return hiddenNodeIds(await store.getSessionNodeMeta(sessionFile));
  } catch (err) {
    console.warn("[GGAI Stella] node-meta.json 읽기 실패 — 숨김 없이 진행:", err);
    return new Set<string>();
  }
}

/** 숨김 구간을 뺀 본문. 숨긴 게 없으면 `buildSpans` 와 완전히 같은 경로. */
export function sendableText(
  session: StellaSession,
  leafId: string,
  hidden: ReadonlySet<string>
): string {
  return spansToText(
    // body-raw: 숨긴 게 없을 때의 동일 경로 — 이 함수가 그 판단을 소유한다.
    hidden.size > 0
      ? spansExcludingNodes(session, leafId, hidden)
      : buildSpans(session, leafId)
  );
}

/** 숨김 집합을 직접 들고 있지 않은 호출부용 — 한 번에 읽어 본문까지 만든다. */
export async function sendableTextOf(
  store: StellaStore,
  sessionFile: string,
  session: StellaSession,
  leafId: string = session.meta.activeLeafId
): Promise<string> {
  return sendableText(session, leafId, await hiddenNodesOf(store, sessionFile));
}

/**
 * 구간 재료 — `afterNodeId` 다음부터 `throughNodeId` 까지 **새로 진행된 내용**을
 * 지금 본문 기준으로 잘라 준다(요약 조각, 로어북 자동 스캔). 나중에 지우거나 고친
 * 대목은 지워지고 고쳐진 채로 나온다.
 */
export function sendablePassage(
  session: StellaSession,
  leafId: string,
  afterNodeId: string | undefined,
  throughNodeId: string,
  hidden: ReadonlySet<string>
): string {
  return textBetweenNodes(session, leafId, afterNodeId, throughNodeId, hidden);
}
