/**
 * 로어북 조건부 내용 검사 (게임형 카드 지원 스펙.md U3).
 *
 * 못 박는 것 셋:
 *  1) 값에 따라 남는 내용이 실제로 갈린다 (실물 카드가 쓰는 형태 그대로).
 *  2) **태그가 프롬프트로 새지 않는다** — `<%` 가 하나라도 남으면 AI 가 그걸 읽는다.
 *  3) 모르는 코드는 지우되 **본문은 살리고 블록 짝은 유지**한다. 짝이 어긋나면
 *     뒤따르는 `<% } %>` 가 엉뚱한 블록을 닫아 내용이 통째로 사라진다(조용한 손실).
 */

import assert from "node:assert/strict";
import {
  hasLorebookTemplate,
  renderLorebookTemplate,
  renderLorebookTemplates,
} from "../src/util/lorebook-template";

const scope = (
  vars: Record<string, string>,
  globals: Record<string, string> = {}
) => ({ vars, globals });

const render = (
  text: string,
  vars: Record<string, string>,
  globals: Record<string, string> = {}
) => renderLorebookTemplate(text, scope(vars, globals));

/** 태그가 남지 않았는지 항상 함께 본다. */
function out(
  text: string,
  vars: Record<string, string>,
  globals: Record<string, string> = {}
): string {
  const result = render(text, vars, globals);
  assert.equal(result.text.includes("<%"), false, "템플릿 태그가 남았다");
  return result.text.trim();
}

// ── 1. 없으면 안 건드린다 ──
{
  assert.equal(hasLorebookTemplate("그냥 설명글 {{user}}"), false);
  assert.equal(out("그냥 설명글", {}), "그냥 설명글");
}

// ── 2. if / else — 실물 카드 형태 (마녀의 숲 캐릭터 항목) ──
{
  const src =
    "<% if (getvar('stat_data.growth_phase') === 'child') { %>아이 시절<% } else { %>성인<% } %>";
  assert.equal(out(src, { "stat_data.growth_phase": "child" }), "아이 시절");
  assert.equal(out(src, { "stat_data.growth_phase": "adult" }), "성인");
  assert.equal(out(src, {}), "성인", "값이 없으면 조건 미충족");
}

// ── 3. else if 사슬 ──
{
  const src =
    "<% if (getvar('r') === 'a') { %>A<% } else if (getvar('r') === 'b') { %>B<% } else { %>C<% } %>";
  assert.equal(out(src, { r: "a" }), "A");
  assert.equal(out(src, { r: "b" }), "B");
  assert.equal(out(src, { r: "z" }), "C");
}

// ── 4. 세션 값과 전역 값은 다른 칸 (D&H 시스템 토글) ──
{
  const src = "<% if (getGlobalVar('DHDiceSystem') === 'Y') { %>주사위 규칙<% } %>";
  assert.equal(out(src, {}, { DHDiceSystem: "Y" }), "주사위 규칙");
  assert.equal(out(src, {}, { DHDiceSystem: "N" }), "");
  assert.equal(
    out(src, { DHDiceSystem: "Y" }, {}),
    "",
    "세션 값이 전역 자리로 읽히면 안 된다"
  );

  // `!==` 도 (D&H 언어 토글이 이 형태를 쓴다)
  const lang = "<% if (getGlobalVar('DHLanguage') !== 'english') { %>한국어 규칙<% } -%>";
  assert.equal(out(lang, {}, { DHLanguage: "korean" }), "한국어 규칙");
  assert.equal(out(lang, {}, { DHLanguage: "english" }), "");
}

// ── 5. 숫자 비교 — 값은 문자열로 저장된다 ──
{
  const src = "<% if (getvar('aff') >= 70) { %>호감<% } %>";
  assert.equal(out(src, { aff: "70" }), "호감");
  assert.equal(out(src, { aff: "100" }), "호감", "문자열 비교면 '100' < '70' 이 된다");
  assert.equal(out(src, { aff: "69" }), "");
  assert.equal(out(src, { aff: "-5" }), "");
}

// ── 6. 지역 변수 선언 + 문자열 거들기 (D&H LI 지시) ──
{
  const src =
    "<% const li = getvar('LI_list'); if (li && li.trim()) { %>연애 지시<% } %>";
  assert.equal(out(src, { LI_list: "백영현,진강" }), "연애 지시");
  assert.equal(out(src, { LI_list: "   " }), "", "공백뿐이면 조건 미충족");
  assert.equal(out(src, {}), "");
}

// ── 7. 값 출력 ──
{
  assert.equal(out("대상: <%- getvar('who') %>", { who: "노아" }), "대상: 노아");
  assert.equal(out("대상: <%= getvar('who') %>", { who: "노아" }), "대상: 노아");
  // 조건에 걸려 빠진 자리는 출력도 안 한다
  assert.equal(out("<% if (getvar('on') === 'Y') { %><%- getvar('who') %><% } %>", { on: "N", who: "노아" }), "");
}

// ── 8. 논리 연산 / 괄호 / 부정 ──
{
  const src = "<% if (!(getvar('a') === '1') || getvar('b') === '2') { %>OK<% } %>";
  assert.equal(out(src, { a: "9" }), "OK");
  assert.equal(out(src, { a: "1", b: "2" }), "OK");
  assert.equal(out(src, { a: "1", b: "9" }), "");
}

// ── 9. 모르는 코드 — 본문은 살고 블록 짝은 유지된다 ──
{
  // 마녀의 숲 "성장 변수" 형태: 해석 못 하는 선언 + forEach 뒤에 if 가 열린다.
  const src = [
    "<%",
    "  const data = getvar('stat_data.children') || {};",
    "  const keys = ['ra', 'no'];",
    "  keys.forEach(key => {",
    "    if (data[key]) { out.push(key); }",
    "  });",
    "  if (out.length > 0) {",
    "%>",
    "지시문 묶음",
    "<% } %>",
    "꼬리",
  ].join("\n");
  const result = render(src, {});
  assert.equal(result.text.includes("<%"), false, "태그가 남았다");
  assert.match(result.text, /지시문 묶음/, "모르는 코드가 본문까지 삼키면 안 된다");
  assert.match(result.text, /꼬리/, "짝이 어긋나면 뒤 내용이 사라진다");
  assert.ok(result.skipped > 0, "건너뛴 조각을 세어야 한다");

  // 바깥이 거짓이면 모르는 코드가 안에 있어도 새어 나오지 않는다.
  const nested =
    "<% if (getvar('on') === 'Y') { %>" +
    "<% weird.forEach(x => { %>안쪽<% }); %>" +
    "<% } %>바깥";
  assert.equal(out(nested, { on: "N" }), "바깥");
  assert.match(out(nested, { on: "Y" }), /안쪽/);
}

// ── 10. 짝 안 맞는 닫기 / 안 닫힌 태그에도 본문을 잃지 않는다 ──
{
  assert.equal(out("<% } %>본문", {}), "본문");
  const unclosed = renderLorebookTemplate("본문 <% if (", scope({}));
  assert.match(unclosed.text, /본문/);
}

// ── 11. 조건문만 있는 줄은 통째로 사라진다 (빈 줄 누더기 방지) ──
{
  const src = ["앞", "<% if (getvar('on') === 'Y') { %>", "안", "<% } %>", "뒤"].join("\n");
  assert.equal(out(src, { on: "Y" }), "앞\n안\n뒤");
  assert.equal(out(src, { on: "N" }), "앞\n뒤");
}

// ── 12. 로어북 적용 — 원본 불변 + 빈 항목 제거 ──
{
  const book = {
    meta: { id: "b1" },
    entries: [
      { uid: "1", content: "<% if (getvar('on') === 'Y') { %>조건부<% } %>" },
      { uid: "2", content: "평범한 항목" },
    ],
  };
  const original = JSON.parse(JSON.stringify(book));

  const on = renderLorebookTemplates([book], scope({ on: "Y" }));
  assert.equal(on[0].entries.length, 2);
  assert.equal(on[0].entries[0].content, "조건부");

  const off = renderLorebookTemplates([book], scope({ on: "N" }));
  assert.equal(off[0].entries.length, 1, "비어버린 항목은 빠진다");
  assert.equal(off[0].entries[0].uid, "2");

  assert.deepEqual(book, original, "원본 로어북 객체를 건드리면 파일까지 오염된다");

  // 템플릿이 없는 책은 같은 객체를 그대로 재사용한다(불필요한 복사 없음).
  const plain = { meta: { id: "b2" }, entries: [{ uid: "1", content: "그냥 글" }] };
  assert.equal(renderLorebookTemplates([plain], scope({}))[0], plain);
}

console.log("lorebook-template harness passed");
