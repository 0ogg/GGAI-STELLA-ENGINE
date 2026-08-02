/**
 * 반복 표현 감지 — 언어 중립 집계 검사. (`반복 표현 감지 스펙.md`)
 *
 * 못 박는 것 네 가지.
 *
 * 1) **사용자 문장 불참** — 집계는 AI 가 쓴 스팬만 본다. 사용자 문체 교정은 월권이라,
 *    여기가 새면 기능의 성격 자체가 바뀐다.
 * 2) **언어 중립** — 영어에서도 잡히고, 기능어(the/of)만으로 된 덩어리는 안 잡힌다.
 *    사전이 없으므로 "흔한 말"은 그 본문에서 학습된다.
 * 3) **띄어쓰기 없는 언어** — 일본어/중국어는 글자 단위로 자동 전환된다.
 * 4) **목록 위생** — 제외 단어(이름)는 빠지고, 같은 횟수의 포함 관계는 긴 쪽만 남는다.
 */

import assert from "node:assert/strict";
import type { StellaSession } from "../src/types/session";
import {
  REPETITION_DEFAULTS,
  collectRecentAiText,
  composeRepetitionNote,
  detectRepetitionUnit,
  findRepetitions,
  formatRepetitionList,
  normalizeRepetitionSettings,
  type RepetitionSettings,
} from "../src/util/repetition";

const settings = (patch: Partial<RepetitionSettings> = {}): RepetitionSettings => ({
  ...REPETITION_DEFAULTS,
  ...patch,
});

/** 노드 하나짜리 세션 — 스팬 저자만 다르게 둔다. */
function makeSession(spans: Array<{ author: "ai" | "user"; text: string }>): StellaSession {
  return {
    meta: {
      id: "s1",
      name: "t",
      scenarioId: "sc1",
      mode: "novel",
      rootId: "root",
      activeLeafId: "root",
      createdAt: 0,
      modifiedAt: 0,
    },
    nodes: {
      root: {
        id: "root",
        parent: null,
        kind: "root",
        patches: [{ op: "append", spans }],
        createdAt: 0,
      },
    },
  } as unknown as StellaSession;
}

// 1) 사용자 스팬은 집계 대상이 아니다.
{
  const session = makeSession([
    { author: "ai", text: "그는 아득한 눈빛으로 하늘을 보았다." },
    { author: "user", text: " 나는 아득한 눈빛으로 그를 보았다." },
  ]);
  const text = collectRecentAiText(session, "root", 10);
  assert.ok(text.includes("아득한 눈빛으로 하늘을"));
  assert.ok(!text.includes("나는 아득한"), "사용자가 쓴 문장이 집계에 섞였다");
}

// 2) 영어 — 반복은 잡히고, 기능어 덩어리는 안 잡힌다.
{
  const line = "she let out a breath she had been holding";
  const text = [
    `${line} and looked at the door of the room.`,
    `${line} and looked at the door of the room.`,
    `${line} while the rain kept falling outside.`,
  ].join("\n");
  const items = findRepetitions(text, settings({ minCount: 3 }));
  const texts = items.map((i) => i.text);
  assert.ok(
    texts.some((t) => t.includes("let out a breath") || t.includes("out a breath")),
    `영어 반복이 안 잡혔다: ${JSON.stringify(texts)}`
  );
  assert.ok(
    !texts.includes("of the") && !texts.includes("at the"),
    `기능어 덩어리가 목록에 올랐다: ${JSON.stringify(texts)}`
  );
}

// 3) 띄어쓰기 없는 언어는 글자 단위로 자동 전환된다.
{
  assert.equal(detectRepetitionUnit("she looked at the door again"), "word");
  assert.equal(detectRepetitionUnit("그는 아득한 눈빛으로 하늘을 보았다"), "word");
  assert.equal(detectRepetitionUnit("彼は静かに息を呑んだ。窓の外は雨だった。"), "char");
  assert.equal(detectRepetitionUnit("他轻轻地吸了一口气，窗外下着雨。"), "char");

  const jp = [
    "彼は静かに息を呑んだ。",
    "彼は静かに息を呑んだ。",
    "彼は静かに息を呑んだ。",
  ].join("\n");
  const items = findRepetitions(jp, settings({ minCount: 3, commonRatio: 0 }));
  assert.ok(
    items.some((i) => i.text.includes("息を呑")),
    `글자 단위 집계가 안 됐다: ${JSON.stringify(items.map((i) => i.text))}`
  );
}

// 4) 제외 단어는 목록에서 빠진다.
{
  const text = Array(4).fill("라온은 조용히 미소를 지었다").join("\n");
  const withName = findRepetitions(text, settings({ minCount: 3, commonRatio: 0 }));
  assert.ok(withName.some((i) => i.text.includes("라온은")));

  const excluded = findRepetitions(
    text,
    settings({ minCount: 3, commonRatio: 0, excludes: ["라온"] })
  );
  assert.ok(
    !excluded.some((i) => i.text.includes("라온")),
    `제외 단어가 목록에 남았다: ${JSON.stringify(excluded.map((i) => i.text))}`
  );
  // 이름을 뺀 나머지 반복은 그대로 잡혀야 한다.
  assert.ok(excluded.some((i) => i.text.includes("미소를")));
}

// 5) 같은 횟수의 포함 관계는 긴 쪽만 남는다.
{
  const text = Array(3).fill("아득한 눈빛으로 하늘을 보았다").join("\n");
  const items = findRepetitions(text, settings({ minCount: 3, commonRatio: 0 }));
  const texts = items.map((i) => i.text);
  assert.ok(!texts.includes("아득한 눈빛으로"), `짧은 포함 항목이 남았다: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.startsWith("아득한 눈빛으로")));
}

// 6) 반복이 없으면 기여가 없다(빈 문자열) — 확장이 조용히 빠지는 자리.
{
  const items = findRepetitions("한 번만 나오는 문장입니다.", settings());
  assert.equal(items.length, 0);
  assert.equal(composeRepetitionNote(REPETITION_DEFAULTS.template, formatRepetitionList(items)), "");
}

// 7) 지시문 템플릿 — 자리표시자에 목록이 들어가고, 없으면 뒤에 붙는다.
{
  const list = formatRepetitionList([{ text: "숨을 삼켰다", count: 4 }]);
  assert.equal(list, '- "숨을 삼켰다" ×4');
  assert.equal(composeRepetitionNote("피하라:\n{{list}}", list), "피하라:\n" + list);
  assert.equal(composeRepetitionNote("피하라.", list), "피하라.\n\n" + list);
}

// 8) 설정 정규화 — 깨진 값은 기본값/범위 안으로.
{
  const s = normalizeRepetitionSettings({ windowNodes: -3, unit: "nope", excludes: [1, "a"] });
  assert.equal(s.windowNodes, 1);
  assert.equal(s.unit, "auto");
  assert.deepEqual(s.excludes, ["a"]);
  assert.equal(normalizeRepetitionSettings(undefined).minCount, REPETITION_DEFAULTS.minCount);
}

// 9) 반복된 한 문장은 조각 여덟 개가 아니라 한 줄로 이어진다.
{
  const line = "she let out a breath she didn't know she was holding";
  const text = [
    `${line} and looked at the door.`,
    `${line} and turned away.`,
    `${line} while the rain kept falling.`,
  ].join("\n");
  const items = findRepetitions(text, settings({ minCount: 3 }));
  const fragments = items.filter((i) => i.text.includes("breath"));
  assert.equal(
    fragments.length,
    1,
    `같은 문장 조각이 여러 줄을 차지했다: ${JSON.stringify(fragments.map((f) => f.text))}`
  );
  assert.ok(
    fragments[0].text.includes("breath") && fragments[0].text.includes("holding"),
    `조각이 이어지지 않았다: ${fragments[0].text}`
  );
}

// 10) 찾으려는 반복 표현이 "흔한 말"로 오인돼 사라지지 않는다.
//     (빈도만 보면 늘 같은 짝으로 붙어 다니는 상투구가 1순위 기능어가 된다.)
{
  const text = [
    "그는 아득한 눈빛으로 창밖을 바라보았다.",
    "아득한 눈빛으로 그를 보던 그녀가 고개를 저었다.",
    "그는 아득한 눈빛으로 그녀를 바라보았다.",
    "바람이 불었다. 아무도 입을 열지 않았다.",
  ].join("\n");
  const items = findRepetitions(text, settings({ minCount: 3 }));
  assert.ok(
    items.some((i) => i.text.includes("아득한 눈빛으로")),
    `반복 표현이 흔한 말 필터에 삼켜졌다: ${JSON.stringify(items.map((i) => i.text))}`
  );
}

console.log("repetition tests passed");
