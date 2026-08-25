/**
 * 카드에 박힌 지침 3종(시스템 프롬프트 / 포스트 히스토리 지시문 / 깊이 프롬프트)이
 * **자동으로** 전송본에 들어가는지 검사.
 *
 * 이게 빠지면 상태창·시트를 강제하는 게임형 카드가 조용히 평범한 롤플 카드가 된다
 * (화면상 정상, 실리태번과 결과만 다름). 규칙은 페르소나/요약과 같다 —
 * 자리 지정 매크로가 있으면 그 자리, 없으면 ST 기본 자리.
 */

import assert from "node:assert/strict";
import { buildContext, buildFallbackPreset } from "../src/util/context-builder";
import type { ContextBuilderInputV2 } from "../src/util/context-builder";
import { buildDefaultPromptPreset } from "../src/util/default-prompt-preset";

const CARD_SYSTEM = "You are a game master. Never break character.";
const CARD_JB = "[Always output the character sheet at the end of every reply.]";
const CARD_DEPTH = "[Reminder: the status window is mandatory.]";

function input(over: Partial<ContextBuilderInputV2> = {}): ContextBuilderInputV2 {
  return {
    preset: buildDefaultPromptPreset("Default"),
    scenario: {
      name: "짱돌이",
      description: "설명",
      system_prompt: CARD_SYSTEM,
      post_history_instructions: CARD_JB,
      depth_prompt: { prompt: CARD_DEPTH, depth: 4, role: "system" },
    },
    persona: { name: "유저", description: "" },
    lorebooks: [],
    mode: "chat",
    sessionLog: [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
    ],
    tokenBudget: 100000,
    countTokens: (s) => Math.ceil(s.length / 4),
    ...over,
  };
}

const idx = (ms: { content: string }[], needle: string) =>
  ms.findIndex((m) => m.content.includes(needle));

// 1) 기본 세트 — 카드 시스템 프롬프트가 메인 프롬프트 자리를 대체한다.
{
  const out = buildContext(input());
  const contents = out.messages.map((m) => m.content);
  assert.ok(idx(out.messages, CARD_SYSTEM) >= 0, "카드 시스템 프롬프트가 빠졌다");
  assert.ok(
    !contents.some((c) => c.includes("Write {{char}}'s next reply")),
    "메인 프롬프트가 카드 것으로 대체되지 않았다"
  );
  assert.equal(
    contents.filter((c) => c.includes(CARD_SYSTEM)).length,
    1,
    "카드 시스템 프롬프트가 두 번 들어갔다"
  );
}

// 2) 포스트 히스토리 지시문은 대화 기록 **뒤**에 온다.
{
  const out = buildContext(input());
  const jb = idx(out.messages, CARD_JB);
  const lastTurn = idx(out.messages, "u3");
  assert.ok(jb >= 0, "포스트 히스토리 지시문이 빠졌다");
  assert.ok(lastTurn >= 0 && jb > lastTurn, "지시문이 대화 기록 앞에 놓였다");
}

// 3) 깊이 프롬프트 — 끝에서 depth 번째 자리에 주입.
{
  const out = buildContext(input());
  const dp = idx(out.messages, CARD_DEPTH);
  // depth 4 = 뒤에 대화 4개가 남는 자리(로어북 at_depth 와 같은 ST 규칙).
  assert.ok(dp >= 0, "깊이 프롬프트가 빠졌다");
  assert.equal(
    out.messages.slice(dp + 1).filter((m) => m.contextKind === "history").length,
    4,
    "깊이 프롬프트 뒤에 남은 대화 수가 depth 와 다르다"
  );
}

// 4) 자리 지정 매크로가 있으면 그 자리만 — 자동 삽입은 하지 않는다.
{
  const preset = buildDefaultPromptPreset("Default");
  const aux = preset.prompts.find((p) => p.identifier === "nsfw");
  assert.ok(aux && aux.kind === "text");
  (aux as { content: string }).content = "머리말 {{charInstruction}}";
  const out = buildContext(input({ preset }));
  const hits = out.messages.filter((m) => m.content.includes(CARD_JB));
  assert.equal(hits.length, 1, "매크로로 자리를 지정했는데 중복 삽입됐다");
  assert.ok(hits[0].content.includes("머리말"), "매크로 자리가 무시됐다");
}

// 4-b) 대체될 자리(main)에 쓴 매크로는 "자리 지정"으로 세지 않는다.
//      세면 매크로도 대체로 지워지고 자동 삽입까지 막혀 내용이 통째로 증발한다.
{
  const preset = buildDefaultPromptPreset("Default");
  const main = preset.prompts.find((p) => p.identifier === "main");
  assert.ok(main && main.kind === "text");
  (main as { content: string }).content = "{{charInstruction}}";
  const out = buildContext(input({ preset }));
  const hits = out.messages.filter((m) => m.content.includes(CARD_JB));
  assert.equal(hits.length, 1, "카드 지시문이 증발했거나 중복됐다");
}

// 5) 폴백 프리셋(main/jailbreak 항목 자체가 없는 세트)에서도 들어간다.
{
  const out = buildContext(input({ preset: buildFallbackPreset() }));
  const sys = idx(out.messages, CARD_SYSTEM);
  const jb = idx(out.messages, CARD_JB);
  const lastTurn = idx(out.messages, "u3");
  assert.equal(sys, 0, "카드 시스템 프롬프트가 맨 앞에 놓이지 않았다");
  assert.ok(jb > lastTurn, "지시문이 대화 기록 뒤에 놓이지 않았다");
}

// 6) 사용자가 그 자리를 **꺼두면** 넣지 않는다 (의도적 숨김 존중).
{
  const preset = buildDefaultPromptPreset("Default");
  for (const p of preset.prompts) {
    if (p.identifier === "main" || p.identifier === "jailbreak") p.enabled = false;
  }
  const out = buildContext(input({ preset }));
  assert.equal(idx(out.messages, CARD_SYSTEM), -1, "꺼둔 메인 자리에 들어갔다");
  assert.equal(idx(out.messages, CARD_JB), -1, "꺼둔 지시문 자리에 들어갔다");
}

// 7) 카드에 지침이 없으면 프리셋 내용이 그대로 (기존 동작 불변).
{
  const out = buildContext(
    input({
      scenario: { name: "짱돌이", description: "설명" },
    })
  );
  assert.ok(
    out.messages.some((m) => m.content.includes("Write 짱돌이's next reply")),
    "카드 지침이 없는데 메인 프롬프트가 사라졌다"
  );
}

console.log("card-instructions.test.ts OK");
