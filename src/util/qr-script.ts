/**
 * 빠른 답장(QR) 스크립트 파서 — 순수 함수, DOM/플러그인 의존 없음.
 *
 * 실물 QR 파일은 커맨드 나열이 아니라 작은 스크립트 언어를 쓴다(QR 스펙.md 실측):
 *
 *   /input 소재는? | /setvar key=소재 {{pipe}} ||
 *   /if left={{getvar::소재}} right="" rule=eq {: /echo 취소 | /abort :} ||
 *
 * 그래서 커맨드를 하나씩 늘리는 게 아니라 **문법이 먼저** 있어야 한다:
 *   - `|` 파이프 연결(앞 결과를 `{{pipe}}` 로 전달) / `||` 는 파이프 값을 끊는다
 *   - `{: ... :}` 클로저 블록 (조건문 몸통, 중첩 가능)
 *   - `key=value` 이름붙은 인자 (따옴표 또는 공백까지의 맨 토큰)
 *   - `\|` `\{` `\}` 이스케이프
 *
 * 매크로({{pipe}}/{{getvar::x}})는 여기서 풀지 않는다 — 실행 시점마다 값이 달라지므로
 * 실행기(`services/qr-runner.ts`)가 커맨드 단위로 치환한다. 파서는 원문을 그대로 넘긴다.
 */

/** 파이프라인의 커맨드 하나. */
export interface QrCommand {
  /** 슬래시를 뗀 소문자 이름. 커맨드가 아니면 "" (실행기가 건너뛴다). */
  name: string;
  /** 이름붙은 인자 — 값은 매크로 치환 전 원문(따옴표는 벗겨진 상태). */
  named: Record<string, string>;
  /** 이름붙은 인자와 클로저를 뺀 나머지 본문 (매크로 치환 전 원문). */
  body: string;
  /** 본문에 있던 `{: :}` 블록 안쪽 원문 — 등장 순서 그대로. */
  closures: string[];
  /** `||` 로 끝났다 = 다음 커맨드에 파이프 값을 넘기지 않는다. */
  breaksPipe: boolean;
  /** 파싱 전 원문 조각 — 오류 안내용. */
  raw: string;
}

/** 스크립트 전체 = 커맨드 파이프라인. */
export function parseQrScript(text: string): QrCommand[] {
  return splitPipeline(text).map((seg) => parseQrCommand(seg.raw, seg.breaksPipe));
}

/** `message` 가 커맨드 스크립트인가 — `/` 로 시작하면 커맨드(ST 규칙). */
export function isQrCommandScript(message: string): boolean {
  return message.trim().startsWith("/");
}

interface PipelineSegment {
  raw: string;
  breaksPipe: boolean;
}

/**
 * 최상위 `|` / `||` 로 자른다.
 * 클로저 `{: :}` 안, 매크로 `{{ }}` 안, 따옴표 안의 파이프는 자르지 않는다.
 */
function splitPipeline(text: string): PipelineSegment[] {
  const out: PipelineSegment[] = [];
  let buf = "";
  let closure = 0;
  let macro = 0;
  let quote = false;
  let i = 0;

  const push = (breaksPipe: boolean) => {
    if (buf.trim()) out.push({ raw: buf.trim(), breaksPipe });
    buf = "";
  };

  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      buf += c + text[i + 1];
      i += 2;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      buf += c;
      i++;
      continue;
    }
    if (!quote) {
      if (c === "{" && text[i + 1] === ":") {
        closure++;
        buf += "{:";
        i += 2;
        continue;
      }
      if (c === ":" && text[i + 1] === "}" && closure > 0) {
        closure--;
        buf += ":}";
        i += 2;
        continue;
      }
      if (c === "{" && text[i + 1] === "{") {
        macro++;
        buf += "{{";
        i += 2;
        continue;
      }
      if (c === "}" && text[i + 1] === "}" && macro > 0) {
        macro--;
        buf += "}}";
        i += 2;
        continue;
      }
      if (c === "|" && closure === 0 && macro === 0) {
        const double = text[i + 1] === "|";
        push(double);
        i += double ? 2 : 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  push(false);
  return out;
}

const NAME_RE = /^\/([A-Za-z_][A-Za-z0-9_-]*)/;
const NAMED_ARG_RE = /^([A-Za-z_][A-Za-z0-9_-]*)=/;

/** 커맨드 조각 하나 파싱. */
export function parseQrCommand(raw: string, breaksPipe = false): QrCommand {
  const trimmed = raw.trim();
  const empty: QrCommand = {
    name: "",
    named: {},
    body: trimmed,
    closures: [],
    breaksPipe,
    raw: trimmed,
  };
  const nameMatch = NAME_RE.exec(trimmed);
  if (!nameMatch) return empty;

  let rest = trimmed.slice(nameMatch[0].length);
  const named: Record<string, string> = {};

  // 이름붙은 인자는 **앞쪽에 연속으로만** 온다 (ST 규칙). 본문 중간의 `a=b` 는 본문이다.
  for (;;) {
    const lead = rest.match(/^\s+/);
    if (!lead) break;
    const after = rest.slice(lead[0].length);
    const argMatch = NAMED_ARG_RE.exec(after);
    if (!argMatch) break;
    const valueStart = argMatch[0].length;
    const { value, end } = readArgValue(after, valueStart);
    named[argMatch[1]] = value;
    rest = after.slice(end);
  }

  const { body, closures } = extractClosures(rest);
  return {
    name: nameMatch[1].toLowerCase(),
    named,
    body: unescapeQr(body.trim()),
    closures,
    breaksPipe,
    raw: trimmed,
  };
}

/** 인자 값 하나 읽기 — `"따옴표"` 또는 공백까지의 맨 토큰(매크로 중괄호 존중). */
function readArgValue(text: string, from: number): { value: string; end: number } {
  let i = from;
  if (text[i] === '"') {
    i++;
    let value = "";
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\" && i + 1 < text.length) {
        value += text[i] + text[i + 1];
        i += 2;
        continue;
      }
      value += text[i];
      i++;
    }
    return { value: unescapeQr(value), end: i < text.length ? i + 1 : i };
  }
  let macro = 0;
  // `labels=["학생 정보","자유게시판"]` 처럼 값이 배열이면 그 안의 공백은
  // 구분자가 아니다 — 대괄호/따옴표 안에서는 토큰을 끊지 않는다.
  let bracket = 0;
  let quote = false;
  let value = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      value += c + text[i + 1];
      i += 2;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      value += c;
      i++;
      continue;
    }
    if (!quote) {
      if (c === "{" && text[i + 1] === "{") {
        macro++;
        value += "{{";
        i += 2;
        continue;
      }
      if (c === "}" && text[i + 1] === "}" && macro > 0) {
        macro--;
        value += "}}";
        i += 2;
        continue;
      }
      if (c === "[") bracket++;
      else if (c === "]" && bracket > 0) bracket--;
    }
    if (macro === 0 && bracket === 0 && !quote && /\s/.test(c)) break;
    value += c;
    i++;
  }
  return { value: unescapeQr(value), end: i };
}

/** 본문에서 최상위 `{: :}` 블록을 떼어낸다 — 중첩은 안쪽 원문에 그대로 남긴다. */
function extractClosures(text: string): { body: string; closures: string[] } {
  const closures: string[] = [];
  let body = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length) {
      body += text[i] + text[i + 1];
      i += 2;
      continue;
    }
    if (text[i] === "{" && text[i + 1] === ":") {
      let depth = 1;
      let j = i + 2;
      let inner = "";
      while (j < text.length && depth > 0) {
        if (text[j] === "{" && text[j + 1] === ":") {
          depth++;
          inner += "{:";
          j += 2;
          continue;
        }
        if (text[j] === ":" && text[j + 1] === "}") {
          depth--;
          if (depth === 0) {
            j += 2;
            break;
          }
          inner += ":}";
          j += 2;
          continue;
        }
        inner += text[j];
        j++;
      }
      closures.push(inner.trim());
      i = j;
      continue;
    }
    body += text[i];
    i++;
  }
  return { body, closures };
}

/** ST 이스케이프 해제 — `\|` `\{` `\}` 만. 그 외 백슬래시는 본문 글자다. */
export function unescapeQr(text: string): string {
  return text.replace(/\\([|{}])/g, "$1");
}

/**
 * 본문 앞뒤 따옴표 벗기기 — `/echo color=blue "작성 취소!"` 처럼 맨 인자가
 * 통째로 따옴표에 싸인 관례를 위한 것. 안쪽에 따옴표가 또 있으면 건드리지 않는다.
 */
export function unquoteQrBody(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1);
  }
  return t;
}

/** `/if rule=` 비교 — ST 규칙. 아는 규칙이 아니면 null(실행기가 건너뛴다). */
export function compareQrRule(
  left: string,
  right: string,
  rule: string
): boolean | null {
  const l = left ?? "";
  const r = right ?? "";
  const ln = Number.parseFloat(l);
  const rn = Number.parseFloat(r);
  const bothNum = Number.isFinite(ln) && Number.isFinite(rn);
  switch ((rule || "eq").toLowerCase()) {
    case "eq":
      return bothNum ? ln === rn : l === r;
    case "neq":
      return bothNum ? ln !== rn : l !== r;
    case "lt":
      return bothNum ? ln < rn : l < r;
    case "gt":
      return bothNum ? ln > rn : l > r;
    case "lte":
      return bothNum ? ln <= rn : l <= r;
    case "gte":
      return bothNum ? ln >= rn : l >= r;
    case "in":
      return l.includes(r);
    case "nin":
      return !l.includes(r);
    case "not":
      return !isTruthyQr(l);
    default:
      return null;
  }
}

/** ST 진리값 — 빈 문자열/`0`/`false`/`null`/`undefined` 가 거짓. */
export function isTruthyQr(value: string): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "null" && v !== "undefined";
}

/**
 * `/buttons labels=[...]` 의 labels 인자 파싱 — JSON 배열이 원칙이지만 실물 파일은
 * 작은따옴표·홑따옴표가 섞이므로 실패 시 손으로 쪼갠다. 빈 배열이면 커맨드를 건너뛴다.
 */
export function parseQrLabels(raw: string): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v).trim()).filter((v) => v.length > 0);
    }
  } catch {
    /* JSON 이 아니면 아래 수동 분해 */
  }
  return text
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((v) => v.trim().replace(/^["']|["']$/g, "").trim())
    .filter((v) => v.length > 0);
}

/**
 * `/re-exec find="/pattern/flags"` 의 정규식 실행 (ST 정규식 확장 호환).
 * 실물 QR 은 AI 응답에서 값을 뽑는 데 쓴다 — `find` 에 캡처 그룹이 있으면 그 값을,
 * 없으면 매치 전체를 돌려준다. 매치가 없거나 패턴이 깨졌으면 "" (스크립트의
 * `/if` 가 "못 찾음"으로 분기할 수 있게 예외를 던지지 않는다).
 *
 * @param first true = 첫 매치만. false = 매치들을 줄바꿈으로 이어 붙인다.
 */
export function runQrRegex(
  find: string,
  input: string,
  first: boolean
): string {
  const raw = (find ?? "").trim();
  if (!raw) return "";
  const m = /^\/([\s\S]*)\/([a-z]*)$/i.exec(raw);
  const source = m ? m[1] : raw;
  let flags = m ? m[2] : "";
  if (!flags.includes("g")) flags += "g";
  let re: RegExp;
  try {
    re = new RegExp(source, flags);
  } catch {
    return "";
  }
  const out: string[] = [];
  for (const match of (input ?? "").matchAll(re)) {
    // 캡처 그룹이 있으면 첫 번째 비어 있지 않은 그룹 — 없으면 매치 전체.
    const captured = match.slice(1).find((g) => g !== undefined && g !== "");
    out.push((captured ?? match[0] ?? "").trim());
    if (first) break;
  }
  return out.filter((v) => v).join("\n");
}

/**
 * `<details><summary>제목</summary>본문</details>` 에서 제목/본문만 뽑는다.
 * 원시 HTML 을 렌더하지 않는다(QR 스펙.md) — 뜻하는 건 "제목 달린 접이식 블록" 하나뿐이라
 * 우리 접이식 위젯으로 그린다. details 가 없으면 제목 없는 블록으로 본다.
 */
export function parseDetailsBlock(text: string): { title: string; body: string } {
  const src = text ?? "";
  const details = /<details[^>]*>([\s\S]*?)<\/details>/i.exec(src);
  const inner = details ? details[1] : src;
  const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
  const title = summary ? stripTags(summary[1]).trim() : "";
  const body = (summary ? inner.replace(summary[0], "") : inner).trim();
  return { title, body: stripTags(body).trim() };
}

/** 남은 HTML 태그 제거 — AI 생성물에 섞인 마크업이 글자로 보이지 않게. */
function stripTags(text: string): string {
  return text.replace(/<\/?[A-Za-z][^>]*>/g, "");
}
