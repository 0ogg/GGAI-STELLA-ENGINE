/**
 * 삽화 표시면 일치 — 인라인과 출력 뷰가 같은 삽화 집합을 보여야 한다.
 *
 * 사고(2026-08-19): 본문 끝을 지운 직후 삽화를 만들면, 삽화가 그 **지우기 편집 노드**
 * 에 붙었다. 출력 뷰는 노드 경로만 보고 그리므로 멀쩡히 떴지만, 인라인은 "그 노드가
 * 본문에서 차지한 글자 구간" 뒤에 그리는데 지우기 노드는 차지한 글자가 없어 **영영
 * 안 보였다**. 사용자에겐 "첫 삽화는 인라인, 재생성한 건 출력창"으로 갈라져 보였다.
 *
 * 두 겹으로 막는다.
 *  1) 붙일 때  — resolveIllustrationTargetNode 가 글자를 남기는 노드로 옮긴다.
 *  2) 그릴 때  — computeIllustrationAnchors 가 구간 없는 노드에도 자리를 준다
 *                (이미 그렇게 저장된 과거 삽화 구제).
 */

import assert from "node:assert/strict";
import type { StellaSession } from "../src/types/session";
import type { SessionIllustrations } from "../src/types/media";
import {
  computeIllustrationAnchors,
  resolveIllustrationTargetNode,
} from "../src/util/illustration-anchors";
import { buildSpans, spansToText } from "../src/util/session-text";

/**
 * root("첫 문단\n두 번째 문단\n") ── ai("AI 가 쓴 꼬리\n") ── del(꼬리 삭제)
 * del 은 `delete` 패치뿐이라 본문에 자기 글자가 없다.
 */
function makeSession(): StellaSession {
  const head = "첫 문단\n두 번째 문단\n";
  const tail = "AI 가 쓴 꼬리\n";
  return {
    schemaVersion: 1,
    meta: {
      id: "s1",
      name: "t",
      scenarioId: "sc",
      mode: "novel",
      rootId: "root",
      activeLeafId: "del",
      createdAt: 0,
      updatedAt: 0,
    },
    nodes: {
      root: {
        id: "root",
        parent: null,
        kind: "root",
        createdAt: 1,
        patches: [{ op: "append", spans: [{ author: "ai", text: head }] }],
      },
      ai: {
        id: "ai",
        parent: "root",
        kind: "ai-continue",
        createdAt: 2,
        patches: [{ op: "append", spans: [{ author: "ai", text: tail }] }],
      },
      del: {
        id: "del",
        parent: "ai",
        kind: "user-edit",
        createdAt: 3,
        patches: [
          { op: "delete", from: head.length, to: head.length + tail.length },
        ],
      },
    },
  } as unknown as StellaSession;
}

function illustrationsOn(nodeId: string): SessionIllustrations {
  return {
    schemaVersion: 1,
    nodes: {
      [nodeId]: {
        activeVariantId: "v1",
        variants: {
          v1: {
            id: "v1",
            kind: "ai-illustration",
            sourceNodeId: nodeId,
            path: "assets/a.png",
            createdAt: 10,
            updatedAt: 10,
          },
        },
      },
    },
  } as unknown as SessionIllustrations;
}

const session = makeSession();
const bodyLen = spansToText(buildSpans(session)).length;

// 1) 붙일 때 — 지우기만 한 리프에는 안 붙고, 본문 끝을 소유한 노드로 옮긴다.
assert.equal(
  resolveIllustrationTargetNode(session),
  "root",
  "지우기 편집 리프에 삽화를 매달면 인라인이 자리를 못 찾는다"
);

// 2) 그릴 때 — 이미 지우기 노드에 붙어 버린 삽화도 인라인 자리를 갖는다.
const orphan = computeIllustrationAnchors(session, illustrationsOn("del"));
assert.equal(orphan.length, 1, "출력 뷰에만 보이고 인라인에서 사라지면 안 된다");
assert.equal(orphan[0].nodeId, "del");
assert.equal(orphan[0].offset, bodyLen, "지운 자리 = 지금 본문 끝");

// 3) 평소 경로는 그대로 — 글자를 소유한 노드는 자기 구간 뒤에 붙는다.
assert.equal(resolveIllustrationTargetNode(session, "ai"), "ai");
const normal = computeIllustrationAnchors(session, illustrationsOn("root"), "ai");
assert.equal(normal.length, 1);
assert.equal(
  normal[0].offset,
  "첫 문단\n두 번째 문단\n".length,
  "root 기여가 문단으로 끝났으니 그 문단 뒤"
);

// 4) 삽화가 없는 노드는 여전히 앵커를 만들지 않는다(빈 위젯 방지).
assert.equal(
  computeIllustrationAnchors(session, { schemaVersion: 1, nodes: {} }).length,
  0
);

console.log("illustration-anchors: ok");
