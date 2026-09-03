/**
 * 카드 HTML 표시 — 통과 정책 검사 (게임형 카드 지원 스펙.md U4).
 *
 * 카드는 남이 만든 파일이다. 그 안의 HTML 을 화면으로 그리는 이상,
 * **무엇을 통과시키는지가 곧 보안 경계**다. 정책 함수는 순수하니 여기서 못 박는다.
 * (트리 순회는 이 판정을 그대로 따르는 얇은 껍데기라 브라우저에서만 돈다.)
 */

import assert from "node:assert/strict";
import {
  hasCardImageTag,
  hasHtmlMarkup,
  isAllowedAttr,
  isAllowedSvgAttr,
  isAllowedSvgTag,
  isAllowedTag,
  isDroppedTag,
  isSafeUrl,
  prefixCustomNames,
  replaceCardImageTags,
  sanitizeStyleValue,
  scopeCss,
} from "../src/util/safe-html";

// ── 1. 태그 정책 ──
{
  // 그릴 수 있는 것 — 카드가 상태창에 실제로 쓰는 것들 (실리태번과 같은 범위).
  for (const tag of [
    "div", "span", "table", "tr", "td", "img", "details", "summary",
    "progress", "b", "a", "button", "label", "input", "select", "pre", "code",
  ]) {
    assert.equal(isAllowedTag(tag), true, `${tag} 는 그려야 한다`);
  }
  assert.equal(isAllowedTag("DIV"), true, "대문자도 같은 태그다");
  // 게이지·아이콘을 SVG 로 그리는 카드가 많다.
  for (const tag of ["svg", "path", "circle", "lineargradient"]) {
    assert.equal(isAllowedSvgTag(tag), true, `${tag} 는 SVG 로 그려야 한다`);
  }

  // 실행/외부요청 통로 — 내용까지 버린다.
  for (const tag of ["script", "iframe", "object", "embed", "link", "form", "foreignobject", "use"]) {
    assert.equal(isDroppedTag(tag), true, `${tag} 는 통째로 버려야 한다`);
    assert.equal(isAllowedTag(tag), false);
  }
  // <style> 은 버리지 않는다 — 말풍선 안으로 선택자를 가둬서 받는다(scopeCss).
  assert.equal(isDroppedTag("style"), false);

  // 카드들의 가짜 태그 — 허용 목록에 없다(껍데기만 벗기고 내용은 살린다).
  for (const tag of ["stat", "status", "choices", "updatevariable", "freeboard"]) {
    assert.equal(isAllowedTag(tag), false);
    assert.equal(isDroppedTag(tag), false, "가짜 태그는 내용까지 버리면 안 된다");
  }
}

// ── 2. 속성 정책 — 이벤트 연결은 어떤 경우에도 막힌다 ──
{
  assert.equal(isAllowedAttr("div", "class"), true);
  assert.equal(isAllowedAttr("div", "style"), true);
  assert.equal(isAllowedAttr("img", "src"), true);
  assert.equal(isAllowedAttr("td", "colspan"), true);

  for (const attr of ["onclick", "onerror", "onload", "ONMOUSEOVER", "onfocus"]) {
    assert.equal(isAllowedAttr("div", attr), false, `${attr} 가 통과하면 코드가 돈다`);
    assert.equal(isAllowedAttr("img", attr), false);
  }
  assert.equal(isAllowedAttr("iframe", "srcdoc"), false);
  assert.equal(isAllowedAttr("div", "src"), false, "img 전용 속성이 아무 데나 붙으면 안 된다");
  assert.equal(isAllowedAttr("a", "href"), true, "링크는 열어야 한다");
  assert.equal(isAllowedAttr("input", "checked"), true, "체크박스로 접기를 만드는 카드가 있다");
  assert.equal(isAllowedAttr("label", "for"), true);
  // 폼 제출 통로 — 눌리면 옵시디언 창이 바깥으로 이동한다.
  assert.equal(isAllowedAttr("button", "formaction"), false);
  assert.equal(isAllowedAttr("div", "action"), false);
  // 그리기에 영향 없는 부가 속성은 통과.
  assert.equal(isAllowedAttr("div", "data-hp"), true);
  assert.equal(isAllowedAttr("div", "aria-label"), true);
  // SVG 는 그리기 기하만 — 바깥을 부르는 참조는 막는다.
  assert.equal(isAllowedSvgAttr("d"), true);
  assert.equal(isAllowedSvgAttr("href"), false);
  assert.equal(isAllowedSvgAttr("onload"), false);
}

// ── 3. 주소 정책 ──
{
  assert.equal(isSafeUrl("assets/hud.png"), true, "상대 경로");
  assert.equal(isSafeUrl("app://local/x.png"), true);
  assert.equal(isSafeUrl("https://example.com/a.png"), true);
  assert.equal(isSafeUrl("data:image/png;base64,AAAA"), true);

  assert.equal(isSafeUrl("javascript:alert(1)"), false);
  assert.equal(isSafeUrl("JaVaScRiPt:alert(1)"), false, "대소문자 섞기");
  assert.equal(isSafeUrl("java\nscript:alert(1)"), false, "제어문자 끼워넣기");
  assert.equal(isSafeUrl("  javascript:alert(1)"), false, "앞 공백");
  assert.equal(isSafeUrl("vbscript:x"), false);
  assert.equal(isSafeUrl("file:///C:/x"), false);
  assert.equal(isSafeUrl("data:text/html,<script>"), false, "이미지가 아닌 data: 는 막는다");
  assert.equal(isSafeUrl(""), false);
}

// ── 4. style 값 정리 ──
{
  assert.equal(sanitizeStyleValue("color: red; font-weight: 700"), "color: red; font-weight: 700");

  // 그림 배경은 살린다 — 안전한 주소면 통과(카드 디자인의 큰 부분이다).
  assert.equal(
    sanitizeStyleValue("color: red; background: url(https://x/a.png)"),
    "color: red; background: url(https://x/a.png)"
  );
  assert.equal(
    sanitizeStyleValue("background: url(data:image/png;base64,AAAA)"),
    "background: url(data:image/png;base64,AAAA)",
    "data: URI 안의 세미콜론에서 선언이 잘리면 안 된다"
  );
  // 코드 실행 통로는 뺀다.
  assert.equal(sanitizeStyleValue("color: red; background: url(javascript:alert(1))"), "color: red");
  assert.equal(sanitizeStyleValue("width: expression(alert(1)); color: blue"), "color: blue");
  assert.equal(sanitizeStyleValue("@import 'x'; color: blue"), "color: blue");
  assert.equal(sanitizeStyleValue("behavior: url(#x); color: blue"), "color: blue");

  // 화면을 덮어 앱 조작을 가로채는 배치.
  assert.equal(sanitizeStyleValue("position: fixed; top: 0"), "top: 0");
  assert.equal(sanitizeStyleValue("z-index: 99999; color: red"), "color: red");
  assert.equal(sanitizeStyleValue("position: relative"), "position: relative", "보통 배치는 둔다");
}

// ── 5. 마크업 판별 — 평범한 글을 HTML 로 오인하지 않는다 ──
{
  assert.equal(hasHtmlMarkup("<div class='a'>x</div>"), true);
  assert.equal(hasHtmlMarkup("<stat>이름: 노아</stat>"), true);
  assert.equal(hasHtmlMarkup("<br>"), true);

  assert.equal(hasHtmlMarkup("3 < 5 이고 7 > 2"), false, "부등호는 마크업이 아니다");
  assert.equal(hasHtmlMarkup("그냥 대사입니다"), false);
  assert.equal(hasHtmlMarkup("<< 강조 >>"), false);
}

// ── 6. 카드 이미지 태그 ──
{
  assert.equal(hasCardImageTag("문단\n{{img::city.jpg}}\n문단"), true);
  assert.equal(hasCardImageTag("{{user}} 는 갔다"), false);

  const resolved = replaceCardImageTags("앞 {{img::city.jpg}} 뒤", (n) =>
    n === "city.jpg" ? "app://local/city.jpg" : null
  );
  assert.match(resolved, /<img class="ggai-card-img" src="app:\/\/local\/city\.jpg"/);
  assert.match(resolved, /alt="city\.jpg"/);
  assert.match(resolved, /^앞 /);

  // 못 찾은 이름은 지운다 — 내부 약속 태그가 글자로 남으면 더 이상하다.
  assert.equal(replaceCardImageTags("앞 {{img::없음.jpg}} 뒤", () => null), "앞  뒤");

  // 주소가 위험하면 그리지 않는다.
  assert.equal(
    replaceCardImageTags("{{img::x}}", () => "javascript:alert(1)"),
    ""
  );

  // 따옴표가 섞여도 속성이 깨지지 않는다.
  const quoted = replaceCardImageTags('{{img::a".jpg}}', () => 'app://x/a".jpg');
  assert.equal(quoted.includes('src="app://x/a".jpg"'), false, "속성 탈출 금지");
  assert.match(quoted, /&quot;/);
}

// ── 7. 카드 이름 격리 — 남의 CSS 가 우리 화면을 건드리지 못한다 ──
{
  assert.equal(prefixCustomNames(".hud .bar"), ".custom-hud .custom-bar");
  assert.equal(prefixCustomNames("#panel"), "#custom-panel");
  assert.equal(prefixCustomNames(".custom-hud"), ".custom-hud", "두 번 붙이지 않는다");
  assert.equal(
    prefixCustomNames(".ggai-card-img"),
    ".ggai-card-img",
    "우리가 넣은 마크업(ggai-)은 이름을 바꾸지 않는다 — 바꾸면 우리 CSS 가 떨어진다"
  );
  assert.equal(prefixCustomNames("div > span"), "div > span", "태그 이름은 그대로");
}

// ── 8. 카드 <style> — 말풍선 안으로 가둔다 ──
{
  const scoped = scopeCss(".hud { color: red; }", ".ggai-chat-bubble");
  assert.equal(scoped, ".ggai-chat-bubble .custom-hud { color: red }");

  // 화면 전체를 노리는 선택자는 우리 범위 자신이 된다.
  assert.match(scopeCss("body { background: black; }", ".mine"), /^\.mine \{/);

  // 여러 선택자, 중첩 at-rule.
  const media = scopeCss("@media (min-width: 10px) { .a, .b { color: red; } }", ".s");
  assert.match(media, /@media \(min-width: 10px\)/);
  assert.match(media, /\.s \.custom-a, \.s \.custom-b \{ color: red \}/);

  // @keyframes 안쪽은 선택자가 아니라 진행률이다 — 건드리지 않는다.
  const kf = scopeCss("@keyframes pulse { 0% { opacity: 0; } 100% { opacity: 1; } }", ".s");
  assert.match(kf, /0% \{ opacity: 0 \}/);
  assert.equal(/\.s 0%/.test(kf), false);

  // 바깥을 부르는 at-rule 은 버린다.
  assert.equal(scopeCss("@import url(http://x/a.css); .a { color: red; }", ".s").includes("@import"), false);

  // 화면을 덮는 배치는 선언 단계에서 걷어낸다.
  assert.equal(scopeCss(".a { position: fixed; color: red; }", ".s"), ".s .custom-a { color: red }");
}

console.log("safe-html harness passed");
