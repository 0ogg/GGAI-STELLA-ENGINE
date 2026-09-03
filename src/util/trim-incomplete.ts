/**
 * 미완성 문장 자르기 — 생성이 토큰 한도/자연 종료로 문장 한복판에서 끊겼을 때,
 * 마지막 완결 지점까지만 남긴다.
 *
 * SillyTavern 의 같은 옵션(`power_user.trim_sentences` → `trimToEndSentence`,
 * public/scripts/utils.js)을 기준으로 삼되, 두 가지를 다르게 한다.
 *  - **판정 범위**: ST 는 메시지 전체를 뒤에서부터 훑는다. 우리는 **마지막 문단
 *    하나**만 본다 — 앞 문단들은 이미 완결된 것으로 보고 따옴표 짝조차 세지 않는다.
 *  - **따옴표**: ST 는 `"` 를 그냥 종결 문자 목록에 넣어 둔다. 우리는 여닫는 짝을
 *    센다. `'` `"` 처럼 모양이 같은 문자는 **줄 첫머리이거나 앞이 띄어쓰기/여는
 *    괄호일 때만** 대사를 여는 것으로 본다 (don't · dogs' · 강조 표기 오인 방지).
 *
 * ST 에서 그대로 가져온 것:
 *  - 종결로 인정하는 문자 집합(닫는 괄호·백틱·`*`·`_`·`$` 등)과 **이모지**.
 *  - 종결 문자 앞이 공백이면 그 문자는 종결이 아니라 **열다 만 표시**로 본다
 *    (`끝났다. *그는` 의 `*`).
 *  - 스트리밍 중에는 적용하지 않고 응답이 끝난 뒤 한 번만 적용한다.
 *
 * 안전장치: 마지막 문단에 완결 지점이 없으면 그 문단만 통째로 걷어내고,
 * 문단이 하나뿐이면 원문을 그대로 둔다. 생성 결과를 통째로 잃는 일은 없다.
 */

/** 짝이 있는 구분자 — 여는 문자 → 닫는 문자. */
const PAIRS: Record<string, string> = {
  "\u201C": "\u201D", // “ ”
  "\u2018": "\u2019", // ‘ ’
  "\u300C": "\u300D", // 「 」
  "\u300E": "\u300F", // 『 』
  "\u300A": "\u300B", // 《 》
  "\u3008": "\u3009", // 〈 〉
  "\uFF08": "\uFF09", // （ ）
  "(": ")",
  "[": "]",
  "{": "}",
};
const CLOSERS = new Set(Object.values(PAIRS));

/** 여닫는 모양이 같아 문맥으로 판정해야 하는 구분자. */
const TOGGLES = new Set(['"', "'"]);

/** 여기서 끝나면 완결로 보는 문자 (ST trimToEndSentence 의 punctuation 집합). */
const END_CHARS = new Set([
  ".", "!", "?", "*", "_", "`", "$", "~",
  "\u2026", "\u2047", "\u2048", "\u2049",
  "\u3002", "\uFF01", "\uFF1F", "\uFF0E", "\uFF5E",
  ...CLOSERS,
  "\u3011", // 】
]);

const EMOJI = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u;

/** 대사를 여는 자리인가 — 문단 첫머리이거나 앞이 공백/여는 괄호. */
function opensHere(prev: string | undefined): boolean {
  if (prev === undefined) return true;
  return /\s/.test(prev) || prev in PAIRS || TOGGLES.has(prev);
}

/**
 * 문단 안에서 잘라도 되는 마지막 지점(문자 오프셋, exclusive). 없으면 -1.
 * 구분자가 전부 닫힌 상태에서 종결 문자/이모지로 끝나는 자리.
 */
function completePoint(para: string): number {
  const stack: string[] = [];
  let cut = -1;
  let pos = 0;
  let prev: string | undefined;
  for (const ch of para) {
    const at = pos;
    pos += ch.length;
    const top = stack[stack.length - 1];
    let closed = false;
    if (TOGGLES.has(ch)) {
      if (top === ch) {
        stack.pop();
        closed = true;
      } else if (opensHere(prev)) {
        stack.push(ch);
        prev = ch;
        continue;
      } else {
        prev = ch; // 축약형·소유격·강조 표기 — 대사가 아니다.
        continue;
      }
    } else if (PAIRS[ch]) {
      stack.push(PAIRS[ch]);
      prev = ch;
      continue;
    } else if (CLOSERS.has(ch) && top === ch) {
      stack.pop();
      closed = true;
    }
    prev = ch;
    if (stack.length > 0) continue;
    // 짝을 닫은 구분자(closed)는 그 자체로 완결 지점이다 — `"안녕."` 의 닫는 따옴표.
    if (!closed && !END_CHARS.has(ch) && !EMOJI.test(ch)) continue;
    // 앞이 공백인 종결 문자는 "열다 만 표시"로 본다 (`끝났다. *그는` 의 `*`).
    // 실제로 짝을 닫은 문자와 이모지는 예외.
    if (!closed && !EMOJI.test(ch) && at > 0 && /\s/.test(para[at - 1])) continue;
    cut = pos;
  }
  return cut;
}

/** 마지막 문단이 시작하는 위치 (빈 줄 기준). 문단이 하나면 0. */
function lastParagraphStart(body: string): number {
  const sep = /\n[ \t]*\n\s*/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = sep.exec(body)) !== null) start = m.index + m[0].length;
  return start;
}

/** 마지막 완결 지점까지만 남긴 텍스트. */
export function trimIncompleteTail(text: string): string {
  const body = text.replace(/\s+$/, "");
  if (!body) return text;

  const start = lastParagraphStart(body);
  const cut = completePoint(body.slice(start));

  if (cut < 0) {
    // 마지막 문단이 통째로 미완성 — 문단이 하나뿐이면 손대지 않는다.
    if (start === 0) return text;
    return body.slice(0, start).replace(/\s+$/, "");
  }
  if (start + cut >= body.length) return text; // 이미 완결 — 원문 그대로.
  return body.slice(0, start + cut);
}
