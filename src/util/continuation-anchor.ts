/**
 * 이어쓰기 이음새 보정 (챗 모델 전용) — 순수 로직.
 *
 * 챗 컴플리션 모델은 assistant 로 끝나는 본문을 "이전 발화"로 보고 새 응답을
 * 시작해 버려서 문장이 중간에서 안 이어지는 경우가 있다. 보정 방식:
 *   1) 본문의 마지막 문장(앵커)을 추출해 "이 문장을 그대로 받아쓰며 시작한 뒤
 *      이어서 계속 써라"는 지시문을 전송본 끝에 user 메시지로 붙인다.
 *   2) 응답 앞머리에서 반복된 앵커를 찾아 잘라내고 이어지는 부분만 본문에 붙인다.
 *
 * 모든 함수는 순수 함수 — 입력 문자열 → 결과. 스트리밍 중에는
 * `anchorSkipStreaming` 이 "아직 판정 불가(null)" 를 돌려줄 수 있고,
 * 종료 시 `anchorSkipFinal` 이 항상 숫자를 돌려준다.
 */

/**
 * 문장 종결 부호. 연속(…, ?!, ...)은 한 덩어리로 취급.
 * ASCII(.!?) 외에 전각/CJK(。！？．)·말줄임표(…‥)·데바나가리(।॥)·아랍(؟۔) 포함.
 */
const TERMINATORS = /[.!?…‥。．！？।॥؟۔]/;
/**
 * 공백 없이도 문장 경계가 되는 "자기 완결형" 종결 부호.
 * 일본어·중국어 등은 문장 끝(。！？) 뒤에 공백을 넣지 않으므로, ASCII(.!?) 처럼
 * 뒤 공백을 강제하면 CJK 본문 전체가 한 문장으로 뭉쳐 앵커가 부풀어버린다.
 * ASCII 마침표/물음표/느낌표는 약어·소수점 오분할을 막기 위해 여기서 제외한다.
 */
const SELF_DELIM_TERMINATORS = /[…‥。．！？।॥؟۔]/;
/** 종결 부호 뒤에 붙을 수 있는 닫는 따옴표/괄호류(전각·CJK 포함). */
const CLOSERS = /["'’”」』）】〕》〉］)\]»›]/;

const WS = /\s/;

/** 앵커 최대 길이 — 너무 긴 문장은 뒷부분만 쓴다 (토큰 낭비 방지). */
const ANCHOR_MAX_LEN = 240;
/** 앵커 최소 실질 글자 수 — 이보다 짧으면 앞 문장까지 포함해 늘린다. */
const ANCHOR_MIN_CHARS = 4;
/** 응답 앞머리에서 앵커를 찾는 시작 오프셋 한계 (선행 공백/따옴표 등 허용). */
const HEAD_SEARCH_WINDOW = 160;
/** 폴백(부분 반복) 매칭이 유효하려면 필요한 최소 실질 글자 수 (한글 기준). */
const FALLBACK_MIN_CHARS = 5;
/** 앵커가 속한 문단이 "이미 길다"고 보는 실질 글자 수 — 넘으면 곧 문단을 닫으라는 지시를 덧붙인다. */
const PARAGRAPH_LONG_MIN = 200;

/**
 * 본문 마지막 문장(앵커) 추출.
 *
 * 문장 경계 = 종결 부호(., !, ?, …, 。 등) 연속 + 닫는 따옴표/괄호류 + 공백,
 * 또는 줄바꿈. 소수점(숫자.숫자)은 경계로 보지 않는다. 홀로 있는 따옴표는
 * 인용 삽입("..." 하고 말했다)을 자르지 않도록 경계로 취급하지 않는다 —
 * 대사 줄 끝의 따옴표는 뒤따르는 공백/줄바꿈이 경계를 만든다.
 *
 * 마지막 문장이 너무 짧으면(감탄사 등) 앞 문장까지 포함한다.
 * 경계를 못 찾으면 본문 끝 ANCHOR_MAX_LEN 자 이내로 자른다.
 */
export function extractAnchorSentence(bodyText: string): string | null {
  const t = bodyText.replace(/\s+$/, "");
  if (!t) return null;
  const starts = sentenceStarts(t);
  for (let i = starts.length - 1; i >= 0; i--) {
    const cand = t.slice(starts[i]);
    if (nonWsLength(cand) >= ANCHOR_MIN_CHARS) return capAnchor(cand);
  }
  return capAnchor(t);
}

/**
 * 앵커 반복 지시문 — 전송본 끝에 user 메시지로 붙는 내용.
 *
 * 앵커는 대개 쓰다 만 문단의 끝인데, 모델에게는 응답 첫 줄이라 새 문단의
 * 시작처럼 보여 한 문단 분량을 통째로 더 쓰는 문제가 있다("이음새 문단 2배").
 * 그래서 앵커가 속한 문단이 이미 길면(paragraphChars ≥ PARAGRAPH_LONG_MIN)
 * "한두 문장 안에 이 문단을 닫고 새 문단으로 넘어가라"는 지시를 덧붙인다.
 */
export function buildAnchorInstruction(
  sentence: string,
  paragraphChars?: number
): string {
  const longParagraph =
    paragraphChars !== undefined && paragraphChars >= PARAGRAPH_LONG_MIN;
  return (
    "[Continuation] Below is the last sentence of the story so far. " +
    "Your response must begin by transcribing this sentence exactly, without changing a single character, " +
    "then continue the story naturally from that exact point, following the instructions above. " +
    "This sentence is the tail end of a paragraph already in progress — do not treat it as the opening of a new paragraph." +
    (longParagraph
      ? " That paragraph is already long: bring it to a close within a sentence or two, then move on to a new paragraph."
      : "") +
    " Output only story prose — no summary, commentary, or greetings.\n" +
    sentence
  );
}

/**
 * 본문 마지막 문단(마지막 줄바꿈 이후)의 실질 글자 수.
 * buildAnchorInstruction 의 paragraphChars 로 넘겨 문단 길이 맞춤 지시에 쓴다.
 */
export function currentParagraphLength(bodyText: string): number {
  const t = bodyText.replace(/\s+$/, "");
  const nl = t.lastIndexOf("\n");
  return nonWsLength(nl >= 0 ? t.slice(nl + 1) : t);
}

/**
 * 스트리밍 중 판정 — 응답 앞머리에서 앵커 반복이 끝나는 위치(잘라낼 길이).
 *  - 숫자: 판정 완료. `raw.slice(반환값)` 이 표시할 본문.
 *  - null: 아직 데이터 부족 — 표시를 보류하고 다음 delta 를 기다린다.
 * 같은 raw 접두사에 대해 항상 같은 결과를 돌려주므로 delta 마다 재호출해도 안전.
 */
export function anchorSkipStreaming(raw: string, anchor: string): number | null {
  const end = findAnchorEnd(raw, anchor);
  if (end !== null) return end;
  if (raw.length < anchor.length + HEAD_SEARCH_WINDOW + 40) return null;
  return fallbackSkip(raw, anchor);
}

/**
 * 종료 시 판정 — 항상 잘라낼 길이를 돌려준다.
 * 앵커 전체 → 부분 반복(앵커 꼬리) 순으로 찾고, 반복이 없으면 0 (그대로 사용).
 */
export function anchorSkipFinal(raw: string, anchor: string): number {
  const end = findAnchorEnd(raw, anchor);
  if (end !== null) return end;
  return fallbackSkip(raw, anchor);
}

// ─────────────────────────── internal ───────────────────────────

/** 각 문장이 시작하는 위치 목록 (0 포함, 오름차순). */
function sentenceStarts(t: string): number[] {
  const starts = [0];
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === "\n") {
      let j = i + 1;
      while (j < t.length && WS.test(t[j])) j++;
      if (j < t.length) starts.push(j);
      i = Math.max(j, i + 1);
      continue;
    }
    if (TERMINATORS.test(ch)) {
      let j = i;
      let selfDelim = false;
      while (j < t.length && TERMINATORS.test(t[j])) {
        if (SELF_DELIM_TERMINATORS.test(t[j])) selfDelim = true;
        j++;
      }
      // 소수점: 숫자 사이의 단독 '.' 은 경계가 아니다.
      if (
        j === i + 1 &&
        ch === "." &&
        i > 0 &&
        isDigit(t[i - 1]) &&
        j < t.length &&
        isDigit(t[j])
      ) {
        i = j;
        continue;
      }
      while (j < t.length && CLOSERS.test(t[j])) j++;
      // 종결 부호 뒤 공백/줄바꿈 → 그 뒤에서 새 문장.
      if (j < t.length && WS.test(t[j])) {
        let k = j;
        while (k < t.length && WS.test(t[k])) k++;
        if (k < t.length) starts.push(k);
        i = k;
        continue;
      }
      // 공백이 없어도 전각/CJK 종결 부호는 그 자리에서 문장 경계
      // (일본어·중국어는 마침표 뒤에 공백을 넣지 않는다).
      if (selfDelim && j < t.length) {
        starts.push(j);
        i = j;
        continue;
      }
      i = Math.max(j, i + 1);
      continue;
    }
    i++;
  }
  return starts;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function nonWsLength(s: string): number {
  return s.replace(/\s/g, "").length;
}

/** 너무 긴 앵커는 뒤에서 자르되 단어 경계에서 시작하게 한다. */
function capAnchor(s: string): string {
  if (s.length <= ANCHOR_MAX_LEN) return s;
  const cut = s.slice(s.length - ANCHOR_MAX_LEN);
  const m = cut.match(/^\S*\s+/);
  if (m && m[0].length < cut.length) return cut.slice(m[0].length);
  return cut;
}

/**
 * raw[start..] 가 anchor 로 시작하는지 공백 차이를 허용하며 매칭.
 * 성공 시 매칭이 끝난 raw 인덱스, 실패(또는 raw 가 짧아 미완) 시 null.
 */
function matchAnchorEnd(
  raw: string,
  start: number,
  anchor: string
): number | null {
  let i = start;
  let j = 0;
  while (j < anchor.length) {
    if (WS.test(anchor[j])) {
      if (i >= raw.length || !WS.test(raw[i])) return null;
      while (j < anchor.length && WS.test(anchor[j])) j++;
      while (i < raw.length && WS.test(raw[i])) i++;
      continue;
    }
    if (i >= raw.length || raw[i] !== anchor[j]) return null;
    i++;
    j++;
  }
  return i;
}

/** 응답 앞머리(오프셋 0~window)에서 앵커 전체 반복을 찾는다. */
function findAnchorEnd(raw: string, anchor: string): number | null {
  const limit = Math.min(HEAD_SEARCH_WINDOW, raw.length);
  for (let s = 0; s <= limit; s++) {
    const end = matchAnchorEnd(raw, s, anchor);
    if (end !== null) return end;
  }
  return null;
}

/**
 * 폴백 — 모델이 앵커의 뒷부분만 반복한 경우: 앵커의 꼬리(최소 실질
 * FALLBACK_MIN_CHARS 자)가 응답 시작과 겹치면 그만큼 잘라낸다.
 * 반복이 전혀 없으면 0 (모델이 지시 없이 바로 이어쓴 경우 — 그대로 사용).
 */
function fallbackSkip(raw: string, anchor: string): number {
  for (let idx = 1; idx < anchor.length; idx++) {
    const suffix = anchor.slice(idx).replace(/^\s+/, "");
    if (nonWsLength(suffix) < FALLBACK_MIN_CHARS) break;
    for (let s = 0; s <= 8; s++) {
      const end = matchAnchorEnd(raw, s, suffix);
      if (end !== null) return end;
    }
  }
  return 0;
}
