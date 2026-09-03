/**
 * 메시지 표시 마크다운 — 챗 말풍선/소설 본문이 무엇을 그리는지 못 박는다.
 *
 * 살균은 여기 책임이 아니다(safe-html). 여기서 지키는 것은 두 가지:
 *  - 마크다운 전반이 실제로 그려진다(표·코드·링크·강조·목록).
 *  - **빈 줄을 접지 않는다** — 원문에 준 빈 줄 개수가 화면에 남는다.
 */

import assert from "node:assert/strict";
import { formatMessageHtml } from "../src/util/message-format";

// ── 1. 마크다운 전반 ──
{
  const html = formatMessageHtml("**굵게** 와 *기울임*");
  assert.match(html, /<strong>굵게<\/strong>/);
  assert.match(html, /<em>기울임<\/em>/);

  assert.match(formatMessageHtml("# 제목"), /<h1[^>]*>제목<\/h1>/);
  assert.match(formatMessageHtml("- 하나\n- 둘"), /<ul>[\s\S]*<li>하나<\/li>/);
  assert.match(formatMessageHtml("> 인용"), /<blockquote>/);
  assert.match(formatMessageHtml("~~취소~~"), /<del>취소<\/del>/);

  // 표 — 상태창을 마크다운으로 내는 카드가 많다.
  const table = formatMessageHtml("| 항목 | 값 |\n|---|---|\n| 체력 | 12 |");
  assert.match(table, /<table>/);
  assert.match(table, /<th>항목<\/th>/);
  assert.match(table, /<td>12<\/td>/);

  // 링크 — 주소만 써도 링크가 된다(GFM 자동 링크).
  assert.match(formatMessageHtml("[집](https://example.com)"), /<a href="https:\/\/example\.com">집<\/a>/);
  assert.match(formatMessageHtml("https://example.com 참고"), /<a href="https:\/\/example\.com">/);

  // 한 줄 바꿈 = 줄바꿈 (채팅 관례).
  assert.match(formatMessageHtml("첫 줄\n둘째 줄"), /<br>/);
}

// ── 2. 코드블록 — 복사할 수 있는 스크립트 영역의 재료 ──
{
  const html = formatMessageHtml("```js\nlet x = 1;\n\nlet y = 2;\n```");
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /let x = 1;/);
  // 코드 안의 빈 줄은 코드의 일부다 — 여백 표식을 심지 않는다.
  assert.equal(/ggai-sep/.test(html), false, "코드블록 안에 표식이 들어가면 안 된다");
  // 코드 안에서는 마크다운 표기를 해석하지 않는다.
  assert.equal(/<em>/.test(formatMessageHtml("```\n*그대로*\n```")), false);

  assert.match(formatMessageHtml("`인라인`"), /<code>인라인<\/code>/);
}

// ── 3. 빈 줄 보존 — 원문에 준 만큼 보인다 ──
{
  // 빈 줄 1개 = 보통 문단 경계. 간격은 CSS 가 준다(표식 없음).
  assert.equal(/ggai-sep/.test(formatMessageHtml("앞\n\n뒤")), false);

  // 빈 줄 2개 = 기본보다 1줄 더.
  assert.match(formatMessageHtml("앞\n\n\n뒤"), /<ggai-sep n="1">/);
  // 빈 줄 4개 = 기본보다 3줄 더.
  assert.match(formatMessageHtml("앞\n\n\n\n\n뒤"), /<ggai-sep n="3">/);

  // 표식을 심어도 앞뒤 글은 그대로 문단이 된다.
  const html = formatMessageHtml("앞\n\n\n뒤");
  assert.match(html, /<p>앞<\/p>/);
  assert.match(html, /<p>뒤<\/p>/);
}

// ── 4. 카드 HTML — 켜면 통과, 끄면 글자 ──
{
  const on = formatMessageHtml('<div class="hud">체력</div>', { allowHtml: true });
  assert.match(on, /<div class="hud">/);

  const off = formatMessageHtml('<div class="hud">체력</div>');
  assert.equal(/<div/.test(off), false, "끄면 태그가 그려지면 안 된다");
  assert.match(off, /&lt;div/);

  // 줄 앞 > 는 인용 표기라 살린다(escape 하면 인용이 죽는다).
  assert.match(formatMessageHtml("> 인용문"), /<blockquote>/);
}

// ── 5. 대사 ── 실리태번처럼 <q> 로 감싼다(테마가 색을 준다) ──
{
  // 큰따옴표는 마크다운 단계에서 &quot; 로 escape 된다(화면에는 그대로 보인다).
  assert.match(formatMessageHtml('그가 말했다. "안녕."'), /<q>&quot;안녕\.&quot;<\/q>/);
  assert.match(formatMessageHtml('“안녕”'), /<q>“안녕”<\/q>/);
  assert.match(formatMessageHtml('「안녕」'), /<q>「안녕」<\/q>/);

  // 코드 안의 따옴표는 코드다.
  assert.equal(/<q>/.test(formatMessageHtml('`let a = "x"`')), false);
  const fenced = ["```", 'let a = "x";', "```"].join("\n");
  assert.equal(/<q>/.test(formatMessageHtml(fenced)), false);

  // 태그 속성의 따옴표를 대사로 잡으면 마크업이 깨진다.
  const card = formatMessageHtml('<div class="hud">체력</div>', { allowHtml: true });
  assert.match(card, /<div class="hud">/);
  assert.equal(/<q>/.test(card), false);
}

console.log("message-format harness passed");
