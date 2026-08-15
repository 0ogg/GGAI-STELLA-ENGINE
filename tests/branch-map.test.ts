import assert from "node:assert/strict";
import type { SessionNode, StellaSession } from "../src/types/session";
import { buildMapGraph } from "../src/util/branch-map";

/** 노드 체인 정의로 세션 하나 만들기 — parent 는 id 문자열. */
function makeSession(
  links: Array<[id: string, parent: string | null]>,
  activeLeafId: string
): StellaSession {
  const nodes: Record<string, SessionNode> = {};
  links.forEach(([id, parent], i) => {
    nodes[id] = {
      id,
      parent,
      kind: parent == null ? "root" : "ai-continue",
      patches: [],
      createdAt: 1000 + i,
    };
  });
  return {
    schemaVersion: 1,
    meta: {
      id: "s1",
      name: "test",
      scenarioId: "sc1",
      mode: "novel",
      rootId: links[0][0],
      activeLeafId,
      createdAt: 1000,
      modifiedAt: 1000,
      lastPlayedAt: 1000,
      favorite: false,
    },
    nodes,
  };
}

// 갈래가 없는 일직선: 루트와 끝만 남고 사이는 한 구간으로 접힌다.
{
  const session = makeSession(
    [
      ["r", null],
      ["a", "r"],
      ["b", "a"],
      ["c", "b"],
      ["d", "c"],
    ],
    "d"
  );
  const keep = (n: SessionNode) =>
    n.parent == null ||
    Object.values(session.nodes).filter((x) => x.parent === n.id).length !== 1 ||
    n.id === session.meta.activeLeafId;
  const g = buildMapGraph(session, ["r"], keep, new Set());
  assert.equal(g.hiddenTotal, 3, "a/b/c 세 개가 접힌다");
  assert.deepEqual(g.edgesOf.get("r"), [
    { toId: "d", runKey: "d", count: 3 },
  ]);
  assert.deepEqual(g.edgesOf.get("d"), []);
}

// 갈라지는 자리(자식 2개)는 남고, 각 갈래의 일직선은 따로 접힌다.
{
  const session = makeSession(
    [
      ["r", null],
      ["a", "r"], // 분기점
      ["b1", "a"],
      ["b2", "b1"], // 갈래 1 끝
      ["c1", "a"], // 갈래 2 끝(자식 없음)
    ],
    "b2"
  );
  const keep = (n: SessionNode) =>
    n.parent == null ||
    Object.values(session.nodes).filter((x) => x.parent === n.id).length !== 1 ||
    n.id === session.meta.activeLeafId;
  const g = buildMapGraph(session, ["r"], keep, new Set());
  assert.deepEqual(g.edgesOf.get("r"), [{ toId: "a" }], "분기점은 그대로 이어진다");
  assert.deepEqual(g.edgesOf.get("a"), [
    { toId: "b2", runKey: "b2", count: 1 },
    { toId: "c1" },
  ]);
  assert.equal(g.hiddenTotal, 1);
}

// 펼친 구간은 원래 사슬로 되살아나고, 첫 이음선에 접기 표시가 붙는다.
{
  const session = makeSession(
    [
      ["r", null],
      ["a", "r"],
      ["b", "a"],
      ["c", "b"],
    ],
    "c"
  );
  const keep = (n: SessionNode) =>
    n.parent == null ||
    Object.values(session.nodes).filter((x) => x.parent === n.id).length !== 1 ||
    n.id === session.meta.activeLeafId;
  const g = buildMapGraph(session, ["r"], keep, new Set(["c"]));
  assert.deepEqual(g.edgesOf.get("r"), [
    { toId: "a", runKey: "c", count: 2, expanded: true },
  ]);
  assert.deepEqual(g.edgesOf.get("a"), [{ toId: "b" }]);
  assert.deepEqual(g.edgesOf.get("b"), [{ toId: "c" }]);
  assert.equal(g.hiddenTotal, 0, "펼친 구간은 숨김 수에 안 들어간다");
}

// 즐겨찾기/현재 노드는 일직선 한가운데여도 남아 구간을 둘로 가른다.
{
  const session = makeSession(
    [
      ["r", null],
      ["a", "r"],
      ["m", "a"],
      ["b", "m"],
      ["leaf", "b"],
    ],
    "leaf"
  );
  session.nodes["m"].favorite = true;
  const keep = (n: SessionNode) =>
    n.parent == null ||
    Object.values(session.nodes).filter((x) => x.parent === n.id).length !== 1 ||
    n.id === session.meta.activeLeafId ||
    n.favorite === true;
  const g = buildMapGraph(session, ["r"], keep, new Set());
  assert.deepEqual(g.edgesOf.get("r"), [{ toId: "m", runKey: "m", count: 1 }]);
  assert.deepEqual(g.edgesOf.get("m"), [
    { toId: "leaf", runKey: "leaf", count: 1 },
  ]);
}

console.log("branch-map tests passed");
