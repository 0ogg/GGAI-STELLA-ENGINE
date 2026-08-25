/**
 * 실물 QR 세트(짱돌이 3.0.1)가 요구하는 커맨드·매크로 회귀 검사.
 *
 * 사고 내용:
 *  - `ephemeral=on` 을 못 알아들어 **영구 주입**이 됐다 — 버튼 한 번에 이후 모든 생성에
 *    "봇을 만들어라" 지시가 계속 따라붙어 세션이 오염됐다.
 *  - `{{random:a,b,c}}`(ST 기본형)를 못 풀어 랜덤 시드가 글자 그대로 나갔다.
 *  - `/send` `/re-replace` `/download` `{{lastCharMessage}}` 가 없어 카드 내보내기
 *    버튼이 아무것도 하지 않았다.
 */

import assert from "node:assert/strict";
import { applyMacros } from "../src/util/macros";
import { detectFormat } from "../src/import/detect";
import {
  isQrFlagOn,
  parseQrScript,
  runQrRegexReplace,
  unescapeQrBraces,
} from "../src/util/qr-script";

// ── ephemeral 플래그 ────────────────────────────────────────────────
assert.equal(isQrFlagOn("on", "on"), true, "ephemeral=on 이 꺼짐으로 읽혔다");
assert.equal(isQrFlagOn("true", "true"), true);
assert.equal(isQrFlagOn("1", "1"), true);
assert.equal(isQrFlagOn("", ""), true, "값 없는 플래그는 켬이어야 한다");
assert.equal(isQrFlagOn("off", "off"), false);
assert.equal(isQrFlagOn("false", "false"), false);
assert.equal(isQrFlagOn(undefined, ""), false, "인자가 없으면 지속 주입(ST 기본)");

// ── {{random:a,b,c}} 쉼표 목록 (ST 기본형) ──────────────────────────
{
  const opts = ["현대 오피스", "사극", "근미래", "도시 판타지", "학원", "느와르"];
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const out = applyMacros(`{{random:${opts.join(",")}}}`, {});
    assert.ok(opts.includes(out), `풀리지 않았다: ${JSON.stringify(out)}`);
    seen.add(out);
  }
  assert.ok(seen.size > 1, "항상 같은 값만 나온다");
  // 기존 형식 두 개도 그대로여야 한다.
  assert.ok(["a", "b"].includes(applyMacros("{{random::a::b}}", {})));
  const n = Number(applyMacros("{{random:1:6}}", {}));
  assert.ok(n >= 1 && n <= 6, "숫자 범위 형식이 깨졌다");
}

// ── {{lastCharMessage}} ────────────────────────────────────────────
assert.equal(
  applyMacros("{{lastCharMessage}}", { lastCharMessage: "짱돌이가 뽑은 카드" }),
  "짱돌이가 뽑은 카드"
);

// ── 카드 내보내기 — 이스케이프한 매크로는 **글자 그대로** 남아야 한다 ──
// (이걸 미리 풀어버리면 내보낸 카드에 `{{user}}` 대신 페르소나 이름이 박힌다.)
{
  const script =
    '/re-replace find=/USERTOKEN/g replace="\\{\\{user\\}\\}" {{lastCharMessage}} |';
  const cmd = parseQrScript(script)[0];
  // 파서는 브레이스 이스케이프를 남겨둔다 — 매크로 치환이 먼저 지나가야 하므로.
  assert.ok(
    (cmd.named.replace ?? '').includes('\\{'),
    '파싱 단계에서 브레이스 이스케이프가 풀려 매크로로 삼켜진다'
  );
  // 실행 경로와 같은 순서: 매크로 치환 → 브레이스 해제.
  const replace = unescapeQrBraces(
    applyMacros(cmd.named.replace ?? '', { user: '살몬' })
  );
  assert.equal(replace, '{{user}}', '내보낸 카드에 진짜 이름이 박혔다');

  const src = 'USERTOKEN이 CHARTOKEN에게 말했다. USERTOKEN은 작가다.';
  const step1 = runQrRegexReplace('/USERTOKEN/g', replace, src);
  const step2 = runQrRegexReplace('/CHARTOKEN/g', '{{char}}', step1);
  assert.equal(
    step2,
    '{{user}}이 {{char}}에게 말했다. {{user}}은 작가다.',
    '토큰 → 매크로 치환이 어긋난다'
  );
  // 깨진 패턴은 원문 통과(스크립트가 죽지 않는다).
  assert.equal(runQrRegexReplace('/[/g', 'x', src), src);
}

// ── 실물 QR 3개가 쓰는 커맨드가 전부 구현돼 있는가 ──────────────────
{
  const IMPLEMENTED = new Set([
    "abort", "echo", "comment", "input", "setvar", "flushvar", "addvar",
    "setglobalvar", "getglobalvar", "rand", "if", "gen", "buttons", "re-exec",
    "re-replace", "send", "download", "inject", "flushinject", "sendas",
    "impersonate", "trigger", "hide", "unhide",
  ]);
  const SCRIPTS: Record<string, string> = {
    "Json 카드 내보내기":
      "/input 파일 이름 |\n/setvar key=fname {{pipe}} |\n" +
      '/if left={{getvar::fname}} rule=eq right="" {: /abort :} |\n' +
      '/re-replace find=/USERTOKEN/g replace="\{\{user\}\}" {{lastCharMessage}} |\n' +
      '/re-replace find=/CHARTOKEN/g replace="\{\{char\}\}" |\n' +
      "/download name={{getvar::fname}} ext=json |",
    "봇 초안 랜덤 생성":
      '/buttons labels=["봇만","봇+세계관"] 무엇을? |\n/setvar key=plan {{pipe}} |\n' +
      "/inject id=botgen position=chat depth=0 role=user ephemeral=on 지시 |\n/trigger |",
    "페르소나 랜덤 생성":
      "/send 페르소나 시트 뽑아줘 |\n" +
      "/inject id=persona position=chat depth=0 role=user ephemeral=on 지시 |\n/trigger |",
  };
  for (const [label, script] of Object.entries(SCRIPTS)) {
    for (const cmd of parseQrScript(script)) {
      assert.ok(
        IMPLEMENTED.has(cmd.name),
        `[${label}] 미구현 커맨드: /${cmd.name}`
      );
    }
  }
}

// ── 내보낸 결과물이 "바로 가져오기"로 이어지는가 ─────────────────────
// `/download` 는 볼트에 저장한 뒤 내용이 아는 형식이면 그 자리에서 가져오기를
// 제안한다. 형식 판별이 깨지면 제안이 사라져 사용자가 가져오기를 찾아 헤맨다.
{
  const card = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: { name: "새 봇", description: "설명", first_mes: "안녕" },
  };
  assert.equal(detectFormat(card), "charactercard-v3", "카드가 인식되지 않는다");
  assert.equal(
    detectFormat({ entries: { "0": { keys: ["a"], content: "b" } } }),
    "sillytavern-worldinfo",
    "로어북이 인식되지 않는다"
  );
  // 형식이 아닌 것은 제안하지 않는다(빈 선택지 모달을 띄우지 않게).
  assert.equal(detectFormat({ hello: "world" }), "unknown");
}

console.log("qr-jjangdol.test.ts OK");
