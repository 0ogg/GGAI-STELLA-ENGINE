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
 * 말줄임표(…‥)도 제외 — 일본어에서 …는 문장 중간의 포즈(彼は…そう言った)로
 * 훨씬 자주 쓰여, 무공백 경계로 치면 앵커가 문장 뒷조각만 남는다. 조각 앵커를
 * 받은 모델은 그걸 완결 발화로 오해해 대사를 닫지 않거나 새 문단을 연다.
 * …가 진짜 문장 끝이면 뒤따르는 공백/줄바꿈이 경계를 만든다.
 */
const SELF_DELIM_TERMINATORS = /[。．！？।॥؟۔]/;
/** 종결 부호 뒤에 붙을 수 있는 닫는 따옴표/괄호류(전각·CJK 포함). */
const CLOSERS = /["'’”」』）】〕》〉］)\]»›]/;
/** 문장 앞에 올 수 있는 여는 따옴표/괄호류(전각·CJK 포함). */
const OPENERS = /["'“‘「『（【〔《〈［(\[«‹]/;
/**
 * 장면 구분선 한 줄 — 공백 무시 별표 3개 이상(`***`, `* * *`).
 * util/pro-convert 의 isSceneBreakParagraph 와 같은 정의(순수 모듈 유지를 위해 로컬 상수).
 */
const SCENE_BREAK = /^\*{3,}$/;

/**
 * 앵커 반복 앞에 올 수 있는 "서식 문자" — 공백/따옴표/괄호/대시/마크다운 마커.
 * 응답 앞머리에서 앵커 반복을 찾을 때, 이 문자들만 건너뛰고 실제 내용 글자를
 * 만나면 스캔을 멈춘다. (일본어처럼 짧은 앵커가 본문 중간에 자연 재등장할 때
 * 그 지점을 반복으로 오인해 앞 문장까지 지우는 것을 막는다.)
 */
const LEAD_SKIPPABLE = /[\s"'`«»‹›“”‘’「」『』（）【】〔〕《》〈〉［］()\[\]*>#~—–\-]/;

const WS = /\s/;

/** 앵커 최대 길이 — 너무 긴 문장은 뒷부분만 쓴다 (토큰 낭비 방지). */
const ANCHOR_MAX_LEN = 240;
/** 앵커 최소 실질 글자 수 — 이보다 짧으면 앞 문장까지 포함해 늘린다. */
const ANCHOR_MIN_CHARS = 4;
/** 응답 앞머리에서 앵커를 찾는 시작 오프셋 한계 (선행 공백/따옴표 등 허용). */
const HEAD_SEARCH_WINDOW = 160;
/** 폴백(부분 반복) 매칭이 유효하려면 필요한 최소 실질 글자 수 (한글 기준). */
const FALLBACK_MIN_CHARS = 5;
/**
 * 퍼지(정규화) 접두 매칭이 유효하려면 재현돼야 하는 최소 실질(내용) 글자 수.
 * 앵커 실질 전체를 재현했을 때만 인정하므로(부분 꼬리 매칭보다 강한 증거) 꼬리
 * 폴백(5자)보다 낮게 둔다 — 「行くぞ 같은 짧은 대사 앵커(실질 3자)도 잡기 위함.
 */
const FUZZY_MIN_HARD = 3;
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
 * 본문 끝의 공백/줄바꿈 범위 (없으면 null).
 *
 * 앵커는 꼬리 공백을 무시하고 뽑지만 생성 결과는 본문 맨 끝(공백 뒤)에
 * 이어붙는다. 이음새가 문장/대사 중간이면(anchorEndsParagraph=false) 이 범위를
 * 함께 지워야 이어붙는 지점에 빈 줄이 끼지 않는다.
 */
export function trailingWhitespaceRange(
  bodyText: string
): { from: number; to: number } | null {
  const trimmedLen = bodyText.replace(/\s+$/, "").length;
  if (trimmedLen === bodyText.length) return null;
  return { from: trimmedLen, to: bodyText.length };
}

/**
 * 앵커가 "문단이 끝나는 지점"인가 — 이어쓰기 이음새에 줄바꿈이 허용되는지 판정.
 *
 * true  = 완결된 문장/대사(종결 부호나 닫는 따옴표로 끝 + 열린 따옴표 없음) →
 *         새 문단이 올 수 있는 자리. 모델이 넣은 이음새 줄바꿈을 **보존**한다.
 * false = 문장/대사 중간(종결 부호 없는 조각, 또는 「…ご主人様？ 처럼 대사 미종결) →
 *         이 자리의 줄바꿈은 이어쓰기를 끊으므로 **걷어낸다**.
 *
 * 이 구분 덕분에 "새 문단이 맞는 자리"의 줄바꿈은 지워지지 않는다.
 */
export function anchorEndsParagraph(anchor: string): boolean {
  const t = anchor.replace(/\s+$/, "");
  if (!t) return false;
  // 장면 구분선(***, * * *)으로 끝나면 문단이 확실히 끝나는 자리 — 문장부호로
  // 끝나지 않아도 새 문단이 올 수 있으므로 이음새 줄바꿈을 걷어내지 않고 보존한다.
  // (구분선을 미완성 조각으로 오해해 뒤 문단이 ***에 들러붙던 버그 수정.)
  const lastLine = t.slice(t.lastIndexOf("\n") + 1);
  if (SCENE_BREAK.test(lastLine.replace(/\s+/g, ""))) return true;
  const last = t[t.length - 1];
  if (!TERMINATORS.test(last) && !CLOSERS.test(last)) return false;
  return !hasUnclosedOpener(t);
}

/** 여는 괄호/따옴표 (비대칭 쌍만; ASCII 큰따옴표는 패리티로 별도 판정). */
const BRACKET_OPEN = /[「『（(【〔《〈［\[«‹“]/;
const BRACKET_CLOSE = /[」』）)】〕》〉］\]»›”]/;

/**
 * 앵커 안에 닫히지 않은 여는 따옴표/괄호가 남아 있는가 (대사 미종결 판정).
 * 한 문장 범위라 단순 카운트로 충분하다. 아포스트로피 오검출을 피하려
 * ASCII/곡선 작은따옴표(' ’ ‘)는 세지 않는다.
 */
function hasUnclosedOpener(t: string): boolean {
  let depth = 0;
  let dquote = 0;
  for (const ch of t) {
    if (ch === '"') dquote ^= 1;
    else if (BRACKET_OPEN.test(ch)) depth++;
    else if (BRACKET_CLOSE.test(ch) && depth > 0) depth--;
  }
  return depth > 0 || dquote === 1;
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
  const fuzzy = fuzzyPrefixSkip(raw, anchor);
  if (fuzzy > 0) return fuzzy;
  return fallbackSkip(raw, anchor);
}

/**
 * 종료 시 판정 — 항상 잘라낼 길이를 돌려준다.
 * 앵커 전체(엄격) → 앵커 전체(정규화 퍼지) → 부분 반복(앵커 꼬리) 순으로 찾고,
 * 반복이 없으면 0 (그대로 사용).
 */
export function anchorSkipFinal(raw: string, anchor: string): number {
  const end = findAnchorEnd(raw, anchor);
  if (end !== null) return end;
  const fuzzy = fuzzyPrefixSkip(raw, anchor);
  if (fuzzy > 0) return fuzzy;
  return fallbackSkip(raw, anchor);
}

// ─────────────────────────── internal ───────────────────────────

/** 각 문장이 시작하는 위치 목록 (0 포함, 오름차순). */
function sentenceStarts(t: string): number[] {
  const starts = [0];
  let i = 0;
  // 열린 따옴표/괄호 추적 — 닫히지 않은 「『（" 안에서는 문장 경계를 만들지
  // 않는다. 대사 안의 。？에서 자르면 앵커가 여는 따옴표를 잃고, 따옴표 없는
  // 조각을 받은 모델은 대사 중임을 몰라 닫지 않는다. 앵커는 「부터 통째로.
  let depth = 0;
  let dquote = 0;
  const track = (c: string): void => {
    if (c === '"') dquote ^= 1;
    else if (BRACKET_OPEN.test(c)) depth++;
    else if (BRACKET_CLOSE.test(c) && depth > 0) depth--;
  };
  while (i < t.length) {
    const ch = t[i];
    if (ch === "\n") {
      let j = i + 1;
      while (j < t.length && WS.test(t[j])) j++;
      if (j < t.length) starts.push(j);
      // 문단 경계에서 리셋 — 앞선 문단의 짝 안 맞는 따옴표가 뒤로 번지지 않게.
      depth = 0;
      dquote = 0;
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
      // 문장 선두의 종결 부호 run 은 경계가 아니다 — 「…ご主人様？ 처럼 말끝을
      // 흐리며 시작하는 대사에서 여는 따옴표와 … 를 앵커에서 떼어내면, 모델이
      // 따옴표 없는 조각을 완결 발화로 오해해 대사를 닫지 않고 새 문단을 연다.
      if (leadingOnly(t, starts[starts.length - 1], i)) {
        i = j;
        continue;
      }
      while (j < t.length && CLOSERS.test(t[j])) {
        track(t[j]);
        j++;
      }
      // 따옴표/괄호가 아직 열려 있으면 경계가 아니다 (。」처럼 닫힌 뒤엔 경계).
      if (depth > 0 || dquote === 1) {
        i = j;
        continue;
      }
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
    track(ch);
    i++;
  }
  return starts;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** t[from..to) 가 공백/여는 따옴표·괄호뿐인가 — 문장 내용이 아직 시작 안 됨. */
function leadingOnly(t: string, from: number, to: number): boolean {
  for (let k = from; k < to; k++) {
    const c = t[k];
    if (!WS.test(c) && !OPENERS.test(c)) return false;
  }
  return true;
}

function nonWsLength(s: string): number {
  return s.replace(/\s/g, "").length;
}

/**
 * 너무 긴 앵커는 뒤에서 자르되 단어 경계에서 시작하게 한다.
 * 여는 따옴표/괄호로 시작하는 앵커(미종결 대사)는 잘라도 그 여는 문자를
 * 앞에 남긴다 — 모델이 대사 중임을 알고 닫을 수 있게.
 */
function capAnchor(s: string): string {
  if (s.length <= ANCHOR_MAX_LEN) return s;
  const lead = OPENERS.test(s[0]) ? s[0] : "";
  const cut = s.slice(s.length - (ANCHOR_MAX_LEN - lead.length));
  const m = cut.match(/^\S*\s+/);
  if (m && m[0].length < cut.length) return lead + cut.slice(m[0].length);
  return lead + cut;
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

/**
 * 응답 앞머리에서 앵커 전체 반복을 찾는다.
 *
 * 앵커 반복은 응답 맨 앞(선행 공백/따옴표 등 서식 문자 뒤)에만 온다. 따라서
 * 매칭 시작점은 서식 문자만 건너뛰며 찾고, 실제 내용 글자를 만나면 멈춘다 —
 * 그 뒤에서 앵커와 같은 구절이 나오면 그것은 반복이 아니라 자연 재등장이므로
 * 잘라내면 안 된다(짧은 CJK 앵커에서 완성된 앞 문장이 통째로 지워지던 버그).
 */
function findAnchorEnd(raw: string, anchor: string): number | null {
  const limit = Math.min(HEAD_SEARCH_WINDOW, raw.length);
  for (let s = 0; s <= limit; s++) {
    const end = matchAnchorEnd(raw, s, anchor);
    if (end !== null) return end;
    if (s < raw.length && !LEAD_SKIPPABLE.test(raw[s])) break;
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

/**
 * "서식/경계" 문자 — 공백 + 따옴표/괄호/대시/마크다운 + 문장 종결 부호(…포함).
 * 퍼지 매칭에서 이 문자들은 양쪽 모두 자유롭게 건너뛴다: 모델이 재현하며 구분선
 * `***`·마침표·닫는 따옴표를 빼먹거나, 여는 따옴표(「")를 빠뜨려도 실질 내용만
 * 맞으면 반복으로 인정하기 위함이다.
 */
function isSoft(ch: string): boolean {
  return LEAD_SKIPPABLE.test(ch) || TERMINATORS.test(ch);
}

/**
 * 실질(내용) 글자 정규화 — 전각 ASCII(！？３ 등)를 반각으로 통일해 비교한다.
 * 따옴표·말줄임표·대시는 isSoft 로 이미 흡수되므로 여기서 다루지 않는다.
 */
function normHard(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  return ch;
}

/**
 * 퍼지(정규화) 접두 매칭 — 모델이 앵커를 글자 그대로가 아니라 살짝 바꿔 재현한
 * 경우의 중복 제거. `findAnchorEnd`(엄격)가 실패한 뒤에만 쓴다.
 *
 * 앵커의 **실질 글자**가 응답 앞머리에서 전부 재현되면(서식/문장부호 차이·구분선
 * 누락·전각 차이는 흡수) 재현된 만큼 잘라낼 위치를 돌려준다. 실질 글자가 도중에
 * 어긋나면(모델이 단어를 바꿔 씀 등) 잘라내지 않는다(정상 이어쓰기 오삭제 방지).
 */
function fuzzyPrefixSkip(raw: string, anchor: string): number {
  const limit = Math.min(HEAD_SEARCH_WINDOW, raw.length);
  for (let s = 0; s <= limit; s++) {
    const end = matchAnchorFuzzy(raw, s, anchor);
    if (end !== null) return end;
    if (s < raw.length && !LEAD_SKIPPABLE.test(raw[s])) break;
  }
  return 0;
}

/**
 * raw[start..] 가 anchor 의 실질 글자를 전부 재현하는지 정규화 비교.
 * 서식/문장부호(isSoft)는 양쪽에서 자유롭게 건너뛰고, 내용 글자는 normHard 로
 * 통일해 비교한다. 앵커 실질 글자를 끝까지 재현했으면(최소 FUZZY_MIN_HARD 자)
 * 재현이 끝난 raw 인덱스를 돌려주고, 도중에 어긋나면 null.
 */
function matchAnchorFuzzy(
  raw: string,
  start: number,
  anchor: string
): number | null {
  let i = start;
  let j = 0;
  let matchedHard = 0;
  for (;;) {
    const jBefore = j;
    while (j < anchor.length && isSoft(anchor[j])) j++;
    if (j >= anchor.length) {
      // 앵커 실질 끝. 앵커가 소프트(마침표/구분선/닫는 따옴표)로 끝났으면 모델이
      // 재현한 꼬리 문장부호도 걷어낸다 — 단 공백은 분리자로 남긴다(다음 문단/문장이
      // 붙지 않게). 앵커가 실질 글자로 끝났으면(뒤 `」` 등은 이어쓰기일 수 있어)
      // raw 꼬리를 건드리지 않는다.
      if (j > jBefore) {
        while (i < raw.length && isSoft(raw[i]) && !WS.test(raw[i])) i++;
      }
      break;
    }
    while (i < raw.length && isSoft(raw[i])) i++; // 다음 실질 글자에 정렬
    if (i >= raw.length) return null; // raw 가 재현 도중에 끝남
    if (normHard(raw[i]) === normHard(anchor[j])) {
      i++;
      j++;
      matchedHard++;
    } else {
      return null; // 내용 글자가 어긋남 — 반복이 아니다
    }
  }
  if (matchedHard < FUZZY_MIN_HARD) return null;
  return i;
}
