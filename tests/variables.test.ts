/**
 * 게임형 카드 변수 — 가지 되짚기 + 스코프 격리 검사.
 *
 * 두 가지를 못 박는다.
 *
 * 1) **가지 되짚기** — 재생성/과거 점프로 돌아가면 값도 그 지점 것이어야 한다.
 *    이게 깨지면 애정도가 분기 사이로 새어 게임이 조용히 망가진다(화면상 정상).
 *
 * 2) **스코프 격리** — 전역 값은 `global::` 접두를 달고 매크로용 맵에만 얹히고,
 *    세션에 저장되는 맵에는 절대 남으면 안 된다. 새면 session.json 이 오염되어
 *    기능을 걷어내도 흔적이 남는다(게임형 카드 지원 스펙.md C급 금지).
 */

import assert from "node:assert/strict";
import type { StellaSession } from "../src/types/session";
import {
  createEmptyVariableLog,
  isEmptyVariableLog,
  normalizeVariableLog,
} from "../src/types/variables";
import {
  diffVariables,
  GLOBAL_VAR_PREFIX,
  mergeDelta,
  nodePathTo,
  resolveVariablesAt,
  stripGlobalScope,
  withGlobalScope,
} from "../src/util/variables";

/**
 * 테스트용 세션 — 노드 트리만 쓴다.
 *
 *   root ── a ── b        (b 에서 애정도 30)
 *        └─ a ── c        (c = a 에서 재생성한 다른 가지, 애정도 5)
 */
function makeSession(): StellaSession {
  const node = (id: string, parent: string | null) => ({
    id,
    parent,
    kind: "ai-continue" as const,
    patches: [],
    createdAt: 0,
  });
  return {
    meta: {
      id: "s",
      name: "t",
      scenarioId: "sc",
      mode: "novel",
      rootId: "root",
      activeLeafId: "b",
    },
    nodes: {
      root: node("root", null),
      a: node("a", "root"),
      b: node("b", "a"),
      c: node("c", "a"),
    },
  } as unknown as StellaSession;
}

// ── 1. 경로 ──
{
  const session = makeSession();
  assert.deepEqual(nodePathTo(session, "b"), ["root", "a", "b"]);
  assert.deepEqual(nodePathTo(session, "c"), ["root", "a", "c"]);
  assert.deepEqual(nodePathTo(session, "root"), ["root"]);
  // 없는 노드 → 빈 경로 (예외 대신 빈 값 — 값 조회는 실패해도 생성을 막지 않는다)
  assert.deepEqual(nodePathTo(session, "없음"), []);
}

// ── 2. 가지 되짚기 ──
{
  const session = makeSession();
  const log = createEmptyVariableLog();
  log.base = { "children.ra.affection": "0", gold: "100" };
  log.nodes["a"] = { "children.ra.affection": "5" };
  log.nodes["b"] = { "children.ra.affection": "30", quest: "시작" };

  const atB = resolveVariablesAt(session, log, "b");
  assert.equal(atB["children.ra.affection"], "30", "b 지점 = 마지막 변화");
  assert.equal(atB.quest, "시작");
  assert.equal(atB.gold, "100", "base 값은 살아 있어야 한다");

  // 다른 가지(c)로 가면 b 의 변화는 없던 일이 된다 — 이게 핵심.
  const atC = resolveVariablesAt(session, log, "c");
  assert.equal(atC["children.ra.affection"], "5", "c 지점은 a 까지만 반영");
  assert.equal(atC.quest, undefined, "다른 가지의 변화가 새면 안 된다");

  // 과거 지점으로 되돌아가면 값도 되돌아간다.
  assert.equal(resolveVariablesAt(session, log, "root")["children.ra.affection"], "0");
}

// ── 3. 삭제 표시(null)는 빈 문자열과 다르다 ──
{
  const session = makeSession();
  const log = createEmptyVariableLog();
  log.base = { flag: "Y" };
  log.nodes["a"] = { flag: null };
  log.nodes["b"] = { empty: "" };

  const atA = resolveVariablesAt(session, log, "a");
  assert.equal("flag" in atA, false, "null 은 삭제 — 키 자체가 없어야 한다");

  const atB = resolveVariablesAt(session, log, "b");
  assert.equal(atB.empty, "", "빈 문자열은 값이 있는 것");
  assert.equal("empty" in atB, true);
}

// ── 4. 차이 계산 / 같은 노드 변화 누적 ──
{
  assert.deepEqual(diffVariables({ a: "1" }, { a: "1" }), {}, "안 바뀌면 빈 변화");
  assert.deepEqual(diffVariables({ a: "1" }, { a: "2" }), { a: "2" });
  assert.deepEqual(diffVariables({ a: "1" }, {}), { a: null }, "사라진 키 = 삭제");
  assert.deepEqual(diffVariables({}, { b: "" }), { b: "" });

  assert.deepEqual(
    mergeDelta({ a: "1", b: "1" }, { b: "2", c: null }),
    { a: "1", b: "2", c: null },
    "같은 지점에서 여러 번 바뀌면 나중 값이 이긴다"
  );
}

// ── 5. 스코프 격리 (전역 값이 세션으로 새지 않는다) ──
{
  const merged = withGlobalScope({ gold: "100" }, { DHLanguage: "korean" });
  assert.equal(merged.gold, "100");
  assert.equal(merged[GLOBAL_VAR_PREFIX + "DHLanguage"], "korean");
  assert.equal(merged.DHLanguage, undefined, "전역은 접두 없이 보이면 안 된다");

  // 이름이 겹쳐도 서로 다른 칸이다.
  const clash = withGlobalScope({ mode: "세션" }, { mode: "전역" });
  assert.equal(clash.mode, "세션");
  assert.equal(clash[GLOBAL_VAR_PREFIX + "mode"], "전역");

  // 저장 직전 걷어내기 — 이게 빠지면 session.json 이 오염된다.
  const stripped = stripGlobalScope(merged);
  assert.deepEqual(stripped, { gold: "100" });
  assert.equal(
    Object.keys(stripped).some((k) => k.startsWith(GLOBAL_VAR_PREFIX)),
    false,
    "세션 저장용 맵에 전역 접두가 남으면 안 된다"
  );

  // 생성 중 setvar 로 새 값이 생겨도 전역만 골라 빠진다.
  const afterGeneration = { ...merged, quest: "진행" };
  assert.deepEqual(stripGlobalScope(afterGeneration), {
    gold: "100",
    quest: "진행",
  });
}

// ── 6. 기록 비어 있음 판정 / 관용적 정규화 ──
{
  assert.equal(isEmptyVariableLog(createEmptyVariableLog()), true);
  const withBase = createEmptyVariableLog();
  withBase.base = { a: "1" };
  assert.equal(isEmptyVariableLog(withBase), false, "base 만 있어도 기록이 있는 것");

  const dirty = normalizeVariableLog({
    version: 1,
    base: { ok: "1", bad: 3 },
    nodes: { n1: { ok: "x", del: null, bad: {} }, n2: "쓰레기", n3: {} },
  });
  assert.deepEqual(dirty.base, { ok: "1" }, "문자열 아닌 base 값은 버린다");
  assert.deepEqual(dirty.nodes.n1, { ok: "x", del: null });
  assert.equal("n2" in dirty.nodes, false, "객체가 아닌 변화는 버린다");
  assert.equal("n3" in dirty.nodes, false, "빈 변화는 담지 않는다");

  assert.deepEqual(normalizeVariableLog(null), createEmptyVariableLog());
  assert.deepEqual(normalizeVariableLog("깨짐"), createEmptyVariableLog());
}

console.log("variables harness passed");
