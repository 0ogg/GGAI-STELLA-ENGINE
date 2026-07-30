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
  isAllowedTag,
  isDroppedTag,
  isSafeUrl,
  replaceCardImageTags,
  sanitizeStyleValue,
} from "../src/util/safe-html";

// ── 1. 태그 정책 ──
{
  // 그릴 수 있는 것 — 카드가 상태창에 실제로 쓰는 것들.
  for (const tag of ["div", "span", "table", "tr", "td", "img", "details", "progress", "b"]) {
    assert.equal(isAllowedTag(tag), true, `${tag} 는 그려야 한다`);
  }
  assert.equal(isAllowedTag("DIV"), true, "대문자도 같은 태그다");

  // 실행/외부요청 통로 — 내용까지 버린다.
  for (const tag of ["script", "iframe", "object", "embed", "link", "form", "input", "svg"]) {
    assert.equal(isDroppedTag(tag), true, `${tag} 는 통째로 버려야 한다`);
    assert.equal(isAllowedTag(tag), false);
  }
  // <style> 은 전역 CSS 라 앱 화면을 망칠 수 있다 — 받지 않는다.
  assert.equal(isDroppedTag("style"), true);

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
  assert.equal(isAllowedAttr("a", "href"), false, "링크는 아직 열지 않는다");
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

  // 외부 요청·코드 실행 통로만 골라 뺀다.
  assert.equal(sanitizeStyleValue("color: red; background: url(http://x/a.png)"), "color: red");
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

console.log("safe-html harness passed");
