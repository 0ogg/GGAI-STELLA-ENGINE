/**
 * 메시지 본문 표시용 마크다운 렌더 (챗 말풍선 / 소설 본문 공용).
 *
 * 실리태번과 같은 자리를 맡는 계층이다(`messageFormatting` 의 마크다운 단계).
 * 표(table)·목록·인용·제목·코드블록·링크·강조를 전부 그리고, 카드가 낸 HTML 은
 * 그대로 통과시킨다 — **살균은 여기서 하지 않는다.** 그리는 쪽(`safe-html.ts`
 * `renderSafeHtml`)이 화이트리스트로 걸러 DOM 에 넣는 것이 보안 경계다.
 *
 * 우리 규칙 하나가 마크다운과 다르다: **빈 줄을 접지 않는다.**
 * 마크다운은 빈 줄이 몇 개든 문단 하나로 접지만, 챗/소설은 원문에 준 빈 줄
 * 개수만큼 간격이 보여야 한다(문단 간격 슬라이더는 그 위에 더한다). 그래서
 * 빈 줄이 2개 이상인 자리에 `<ggai-sep n="…">` 표식을 심고, 그리는 쪽이 그것을
 * 여백 블록으로 바꾼다. 문단 사이 기본 1줄 간격은 CSS 가 맡으므로 표식에는
 * **그보다 더 준 줄 수만** 담는다.
 */

import { marked } from "marked";

/** 빈 줄 표식 태그 — 렌더러가 여백 블록으로 바꾼다. */
export const SEPARATOR_TAG = "ggai-sep";

export interface MessageFormatOptions {
  /**
   * 카드가 낸 HTML 태그를 살릴지. 끄면 `<`/`>` 를 글자로 escape 해서
   * 태그가 그대로 보인다(카드 표시 확장 off = 도입 전과 같은 화면).
   */
  allowHtml?: boolean;
}

/**
 * 태그를 글자로 — 실리태번 `encode_tags` 와 같은 규칙.
 * 줄 앞 `>` 는 인용문 표기라 남긴다(escape 하면 인용이 죽는다).
 */
function escapeTags(text: string): string {
  return text.replace(/</g, "&lt;").replace(/(?<!^|\n\s*)>/g, "&gt;");
}

/** 태그 속성 안의 따옴표를 잠시 치워 둘 자리표 (대사 감싸기가 태그를 깨지 않게). */
const QUOTE_GUARD = "￾";

/**
 * 대사를 `<q>` 로 감싼다 — 실리태번과 같은 처리(테마가 대사에 색을 준다).
 *
 * 코드블록·인라인 코드·`<style>` 안은 건드리지 않는다(ST 의 교체 순서 그대로:
 * 그것들을 먼저 매치해 원문으로 돌려보낸다). 태그를 살리는 경우에는 속성 안의
 * 따옴표를 자리표로 치워 둔 뒤 되돌린다 — `class="hud"` 가 대사로 잡히면
 * 마크업이 통째로 깨진다.
 */
function wrapQuotes(text: string, allowHtml: boolean): string {
  const guarded = allowHtml
    ? text.replace(/<([^>]+)>/g, (_m, inner: string) =>
        "<" + inner.replace(/"/g, QUOTE_GUARD) + ">"
      )
    : text;
  const wrapped = guarded.replace(
    /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/gim,
    (match, ...groups: (string | undefined)[]) => {
      const quoted = groups.slice(0, 6).find((g) => g != null);
      return quoted == null ? match : `<q>${quoted}</q>`;
    }
  );
  return allowHtml ? wrapped.split(QUOTE_GUARD).join('"') : wrapped;
}

/** 코드 울타리 여는/닫는 줄인가 — ``` 또는 ~~~ (앞 공백 3칸까지 허용). */
function fenceCharOf(line: string): string | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return m ? m[1][0] : null;
}

/**
 * 빈 줄 2개 이상인 자리에 표식을 심는다. 코드블록 안은 건드리지 않는다
 * (그 안의 빈 줄은 코드의 일부다).
 */
function markBlankRuns(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let blanks = 0;
  const flush = (): void => {
    if (blanks === 0) return;
    // 문단 사이 기본 간격이 1줄이므로, 그보다 더 준 만큼만 표식으로 남긴다.
    if (blanks >= 2) {
      out.push("", `<${SEPARATOR_TAG} n="${blanks - 1}"></${SEPARATOR_TAG}>`, "");
    } else {
      out.push("");
    }
    blanks = 0;
  };

  for (const line of text.split("\n")) {
    const fenceChar = fenceCharOf(line);
    if (fence != null) {
      if (fenceChar === fence) fence = null;
      out.push(line);
      continue;
    }
    if (fenceChar != null) {
      flush();
      fence = fenceChar;
      out.push(line);
      continue;
    }
    if (line.trim() === "") {
      blanks++;
      continue;
    }
    flush();
    out.push(line);
  }
  // 끝에 남은 빈 줄은 버린다 — 말풍선 아래 여백은 CSS 몫이다.
  return out.join("\n");
}

/**
 * 마크다운 → HTML 문자열. 결과는 **아직 안전하지 않다** —
 * 반드시 `renderSafeHtml` 로 그린다.
 */
export function formatMessageHtml(
  text: string,
  opts: MessageFormatOptions = {}
): string {
  if (!text) return "";
  const allowHtml = opts.allowHtml === true;
  const source = wrapQuotes(allowHtml ? text : escapeTags(text), allowHtml);
  return marked.parse(markBlankRuns(source), {
    gfm: true, // 표·취소선·자동 링크
    breaks: true, // 한 줄 바꿈 = <br> (채팅 관례, ST simpleLineBreaks 와 같다)
    async: false,
  }) as string;
}
