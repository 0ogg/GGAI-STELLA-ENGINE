/**
 * 로어북 조건부 내용 — `<% if (...) { %> … <% } %>` (게임형 카드 지원 스펙.md U3).
 *
 * 커뮤니티 카드들은 로어북 항목 하나에 여러 벌의 내용을 넣어두고 변수로 골라 쓴다
 * (아동기/성인기 설명, 주사위 규칙 on/off, 언어 전환). 실리태번 쪽은 이걸 EJS
 * 템플릿(= 임의 JavaScript 실행)으로 하지만, **우리는 JS 를 실행하지 않는다** —
 * 로어북은 남이 만든 파일을 임포트하는 자리라 임의 코드 실행은 위험하다.
 *
 * 그래서 실제 카드가 쓰는 만큼만 해석한다:
 *  - 조건 분기 `if / else if / else`
 *  - 값 비교 `=== !== == != > < >= <=`, 논리 `&& || !`, 괄호
 *  - 값 읽기 `getvar('이름')` / `getGlobalVar('이름')`
 *  - 지역 변수 `const x = …;` `let x = …;` `x = …;`
 *  - 문자열 거들기 `.trim() .length .toLowerCase() .toUpperCase() .includes(…)`
 *  - 값 출력 `<%- 식 %>` / `<%= 식 %>`, 주석 `<%# … %>`
 *
 * **해석하지 못하는 코드는 지우고 본문은 남긴다.** 반복문(`forEach`)처럼 우리가 안
 * 다루는 코드가 있으면 그 조건은 "항상 참"처럼 흘러가되, 안쪽 글은 살아서 AI 에게
 * 간다. 내용을 통째로 잃는 것보다 조건이 안 걸리는 쪽이 덜 위험하다. 이때 여는 중괄호
 * 수를 세어 블록 짝을 유지하므로 뒤따르는 `<% } %>` 가 엉뚱한 블록을 닫지 않는다.
 */

export interface TemplateScope {
  /** 세션 값 (`getvar`). */
  vars: Record<string, string>;
  /** 전역 값 (`getGlobalVar`). */
  globals: Record<string, string>;
}

export interface TemplateResult {
  text: string;
  /** 해석하지 못해 지운 코드 조각 수 — 호출부 안내용. */
  skipped: number;
}

/** 템플릿 문법이 들어 있는가 — 없으면 렌더 자체를 건너뛴다. */
export function hasLorebookTemplate(text: string): boolean {
  return text.includes("<%");
}

type Value = string | number | boolean | null;

/** 한 조각 = 글이거나 코드. */
interface Segment {
  kind: "text" | "code";
  /** 코드면 태그 안쪽 원문, 글이면 글 자체. */
  body: string;
  /** 코드 전용 — `<%-` / `<%=` 출력 태그인가. */
  output?: boolean;
  /** 코드 전용 — 여는 태그가 공백을 먹는가 (`<%_`). */
  trimBefore?: boolean;
  /** 코드 전용 — 닫는 태그가 공백을 먹는가 (`-%>` / `_%>`). */
  trimAfter?: boolean;
}

/** 조건 블록 한 겹. */
interface Frame {
  /** 지금 가지의 글을 내보내는가. */
  active: boolean;
  /** 이 블록에서 이미 참인 가지가 지나갔는가 (else if / else 판정용). */
  taken: boolean;
  /** 해석 못 한 코드가 연 블록 — else 를 붙일 수 없고, 바깥 상태를 그대로 잇는다. */
  opaque: boolean;
}

export function renderLorebookTemplate(
  text: string,
  scope: TemplateScope
): TemplateResult {
  const segments = splitSegments(text);
  const locals = new Map<string, Value>();
  const stack: Frame[] = [];
  let skipped = 0;
  let out = "";

  /** 지금 글을 내보내는 상태인가 (모든 겹이 활성이어야 한다). */
  const emitting = (): boolean => stack.every((f) => f.active);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg.kind === "text") {
      if (emitting()) out += seg.body;
      continue;
    }

    const code = seg.body.trim();

    // 주석 — 아무것도 하지 않는다.
    if (code.startsWith("#")) continue;

    // 값 출력.
    if (seg.output) {
      if (!emitting()) continue;
      const value = tryEvaluate(code, scope, locals);
      if (value === undefined) skipped++;
      else out += stringify(value);
      continue;
    }

    // 블록 닫기 / else 계열.
    if (code.startsWith("}")) {
      const rest = code.slice(1).trim();
      const frame = stack.pop();
      if (!frame) {
        // 짝이 안 맞는 닫기 — 무시한다(원본이 깨져 있어도 본문은 살린다).
        skipped++;
        applyOpaqueBraces(rest, stack);
        continue;
      }
      if (rest === "" || rest === ";") continue; // 그냥 닫기

      const elseIf = /^else\s+if\s*\(([\s\S]*)\)\s*\{$/.exec(rest);
      const plainElse = /^else\s*\{$/.exec(rest);
      if (!elseIf && !plainElse) {
        // `});` 나 `} catch {` 같은 모르는 형태 — 남은 중괄호 증감만 반영한다.
        // 여기서 무조건 블록을 다시 열면 `});` 뒤의 진짜 `<% } %>` 가 그 가짜 블록을
        // 닫아버려, 바깥 블록이 안 닫힌 채로 남고 그 뒤 본문이 통째로 사라진다.
        skipped++;
        applyOpaqueBraces(rest, stack);
        continue;
      }
      if (frame.opaque) {
        // 해석 못 한 블록에는 가지 판정을 붙일 수 없다 — 그대로 이어서 연다.
        stack.push({ active: frame.active, taken: true, opaque: true });
        continue;
      }
      const parentActive = stack.every((f) => f.active);
      if (frame.taken) {
        stack.push({ active: false, taken: true, opaque: false });
        continue;
      }
      if (plainElse) {
        stack.push({ active: parentActive, taken: true, opaque: false });
        continue;
      }
      const verdict = tryEvaluate(elseIf![1], scope, locals);
      if (verdict === undefined) {
        skipped++;
        stack.push({ active: parentActive, taken: true, opaque: true });
        continue;
      }
      const truthy = isTruthy(verdict);
      stack.push({ active: parentActive && truthy, taken: truthy, opaque: false });
      continue;
    }

    // 지역 변수 선언들 + 마지막에 오는 `if (…) {` (실물 카드가 쓰는 형태).
    const parsed = parseStatements(code);
    if (!parsed) {
      // 모르는 코드 — 지우고 중괄호 짝만 맞춘다.
      skipped++;
      applyOpaqueBraces(code, stack);
      continue;
    }

    let failed = false;
    for (const assign of parsed.assignments) {
      const value = tryEvaluate(assign.expr, scope, locals);
      if (value === undefined) {
        failed = true;
        break;
      }
      locals.set(assign.name, value);
    }
    if (failed) {
      skipped++;
      applyOpaqueBraces(code, stack);
      continue;
    }
    if (!parsed.condition) continue; // 선언만 있는 조각

    const parentActive = emitting();
    const verdict = tryEvaluate(parsed.condition, scope, locals);
    if (verdict === undefined) {
      skipped++;
      stack.push({ active: parentActive, taken: true, opaque: true });
      continue;
    }
    const truthy = isTruthy(verdict);
    stack.push({ active: parentActive && truthy, taken: truthy, opaque: false });
  }

  return { text: out, skipped };
}

/** 모르는 코드의 중괄호 증감만큼 불투명 블록을 열고 닫는다. */
function applyOpaqueBraces(code: string, stack: Frame[]): void {
  const delta = netBraces(code);
  for (let i = 0; i < delta; i++) {
    const active = stack.every((f) => f.active);
    stack.push({ active, taken: true, opaque: true });
  }
  for (let i = 0; i < -delta; i++) stack.pop();
}

/** 문자열 리터럴 밖의 `{` - `}` 개수. */
function netBraces(code: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth;
}

// ─────────────────────────── 조각 나누기 ───────────────────────────

function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  let buf = "";

  const pushText = () => {
    if (buf) segments.push({ kind: "text", body: buf });
    buf = "";
  };

  while (i < text.length) {
    const open = text.indexOf("<%", i);
    if (open < 0) {
      buf += text.slice(i);
      break;
    }
    buf += text.slice(i, open);

    // 닫는 태그 찾기 — 문자열 리터럴 안의 `%>` 는 건너뛴다.
    const close = findClose(text, open + 2);
    if (!close) {
      // 안 닫힌 태그 — 남은 건 글로 본다.
      buf += text.slice(open);
      break;
    }

    let inner = text.slice(open + 2, close.at);
    const trimBefore = inner.startsWith("_");
    if (trimBefore) inner = inner.slice(1);
    const output = inner.startsWith("-") || inner.startsWith("=");
    if (output) inner = inner.slice(1);

    if (trimBefore) buf = buf.replace(/[ \t]*$/, "");
    pushText();
    segments.push({
      kind: "code",
      body: inner,
      output,
      trimBefore,
      trimAfter: close.trim,
    });
    i = close.next;

    // 출력이 없는 태그가 한 줄을 통째로 차지하면 그 줄을 지운다 —
    // 조건문마다 빈 줄이 남아 프롬프트가 너덜너덜해지는 걸 막는다.
    if (close.trim) {
      i = skipToLineEnd(text, i);
    } else if (!output) {
      const prev = segments[segments.length - 2];
      const startsLine =
        !prev || prev.kind !== "text" || /(^|\n)[ \t]*$/.test(prev.body);
      const endsLine = /^[ \t]*(\r?\n|$)/.test(text.slice(i));
      if (startsLine && endsLine) {
        if (prev && prev.kind === "text") {
          prev.body = prev.body.replace(/[ \t]*$/, "");
        }
        i = skipToLineEnd(text, i);
      }
    }
  }
  pushText();
  return segments;
}

/** `%>` 위치와 공백 먹기 여부. 문자열 리터럴 안은 건너뛴다. */
function findClose(
  text: string,
  from: number
): { at: number; next: number; trim: boolean } | null {
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "%" && text[i + 1] === ">") {
      const trimmed = text[i - 1] === "-" || text[i - 1] === "_";
      return { at: trimmed ? i - 1 : i, next: i + 2, trim: trimmed };
    }
  }
  return null;
}

/** 줄 끝(개행 포함)까지 건너뛴다. 그 줄에 공백 말고 다른 게 있으면 그대로 둔다. */
function skipToLineEnd(text: string, from: number): number {
  const m = /^[ \t]*\r?\n/.exec(text.slice(from));
  return m ? from + m[0].length : from;
}

// ─────────────────────────── 문장 ───────────────────────────

interface ParsedStatements {
  assignments: { name: string; expr: string }[];
  /** 마지막에 온 `if (…) {` 의 조건식. 없으면 null. */
  condition: string | null;
}

const ASSIGN_RE = /^(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=(?!=)/;

/**
 * `const a = …; let b = …; if (…) {` 형태만 받는다.
 * 하나라도 모르는 모양이면 null (호출부가 통째로 건너뛴다).
 */
function parseStatements(code: string): ParsedStatements | null {
  const assignments: { name: string; expr: string }[] = [];
  let rest = code.trim();

  for (let guard = 0; guard < 50; guard++) {
    if (!rest) return { assignments, condition: null };

    if (rest.startsWith("if")) {
      const m = /^if\s*\(/.exec(rest);
      if (!m) return null;
      const end = matchParen(rest, m[0].length - 1);
      if (end < 0) return null;
      const tail = rest.slice(end + 1).trim();
      if (tail !== "{") return null; // `if (…) 한줄;` 형태는 안 받는다
      return { assignments, condition: rest.slice(m[0].length, end) };
    }

    const assign = ASSIGN_RE.exec(rest);
    if (!assign) return null;
    const after = rest.slice(assign[0].length);
    const semi = findSemicolon(after);
    if (semi < 0) return null;
    assignments.push({ name: assign[1], expr: after.slice(0, semi) });
    rest = after.slice(semi + 1).trim();
  }
  return null;
}

/** 문자열/괄호 밖의 첫 `;`. */
function findSemicolon(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return i;
  }
  return -1;
}

/** `(` 위치에서 짝이 되는 `)` 의 위치. 없으면 -1. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ─────────────────────────── 식 ───────────────────────────

/** 해석 성공이면 값, 우리가 모르는 문법이면 undefined. */
function tryEvaluate(
  source: string,
  scope: TemplateScope,
  locals: Map<string, Value>
): Value | undefined {
  try {
    const tokens = tokenize(source);
    if (!tokens) return undefined;
    const parser = new ExprParser(tokens, scope, locals);
    const value = parser.parseExpression();
    return parser.done() ? value : undefined;
  } catch {
    return undefined;
  }
}

type Token = { t: "str" | "num" | "id" | "op"; v: string };

const OPERATORS = [
  "===",
  "!==",
  "==",
  "!=",
  ">=",
  "<=",
  "&&",
  "||",
  ">",
  "<",
  "!",
  "(",
  ")",
  ",",
  ".",
];

function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let value = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") {
          value += unescapeChar(src[i + 1]);
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      if (i >= src.length) return null; // 안 닫힌 문자열
      if (c === "`" && value.includes("${")) return null; // 문자열 안 식은 안 받는다
      i++;
      out.push({ t: "str", v: value });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let num = "";
      while (i < src.length && /[0-9.]/.test(src[i])) num += src[i++];
      out.push({ t: "num", v: num });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let id = "";
      while (i < src.length && /[\w$]/.test(src[i])) id += src[i++];
      out.push({ t: "id", v: id });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) return null; // 모르는 기호 (= + - * 등) → 통째로 포기
    out.push({ t: "op", v: op });
    i += op.length;
  }
  return out;
}

function unescapeChar(c: string): string {
  if (c === "n") return "\n";
  if (c === "t") return "\t";
  if (c === "r") return "\r";
  return c ?? "";
}

class ExprParser {
  private pos = 0;
  constructor(
    private tokens: Token[],
    private scope: TemplateScope,
    private locals: Map<string, Value>
  ) {}

  done(): boolean {
    return this.pos >= this.tokens.length;
  }

  parseExpression(): Value {
    return this.parseOr();
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eatOp(...ops: string[]): string | null {
    const tok = this.peek();
    if (tok && tok.t === "op" && ops.includes(tok.v)) {
      this.pos++;
      return tok.v;
    }
    return null;
  }

  private parseOr(): Value {
    let left = this.parseAnd();
    while (this.eatOp("||")) {
      const right = this.parseAnd();
      // JS 와 같은 의미 — 왼쪽이 참이면 왼쪽 값, 아니면 오른쪽 값.
      left = isTruthy(left) ? left : right;
    }
    return left;
  }

  private parseAnd(): Value {
    let left = this.parseComparison();
    while (this.eatOp("&&")) {
      const right = this.parseComparison();
      left = isTruthy(left) ? right : left;
    }
    return left;
  }

  private parseComparison(): Value {
    const left = this.parseUnary();
    const op = this.eatOp("===", "!==", "==", "!=", ">=", "<=", ">", "<");
    if (!op) return left;
    return compare(left, op, this.parseUnary());
  }

  private parseUnary(): Value {
    if (this.eatOp("!")) return !isTruthy(this.parseUnary());
    return this.parsePostfix();
  }

  /** 기본값 + `.trim()` `.length` 같은 꼬리. */
  private parsePostfix(): Value {
    let value = this.parsePrimary();
    while (this.eatOp(".")) {
      const name = this.peek();
      if (!name || name.t !== "id") throw new Error("bad member");
      this.pos++;
      const args: Value[] = [];
      if (this.eatOp("(")) {
        if (!this.eatOp(")")) {
          for (;;) {
            args.push(this.parseExpression());
            if (this.eatOp(")")) break;
            if (!this.eatOp(",")) throw new Error("bad args");
          }
        }
      }
      value = applyMember(value, name.v, args);
    }
    return value;
  }

  private parsePrimary(): Value {
    const tok = this.peek();
    if (!tok) throw new Error("unexpected end");

    if (tok.t === "str") {
      this.pos++;
      return tok.v;
    }
    if (tok.t === "num") {
      this.pos++;
      return Number(tok.v);
    }
    if (tok.t === "op" && tok.v === "(") {
      this.pos++;
      const value = this.parseExpression();
      if (!this.eatOp(")")) throw new Error("unbalanced");
      return value;
    }
    if (tok.t !== "id") throw new Error("unexpected token");
    this.pos++;

    const lower = tok.v.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    if (lower === "null" || lower === "undefined") return null;

    // 함수 호출 — 값 읽기 두 가지만 안다.
    if (this.peek()?.t === "op" && this.peek()!.v === "(") {
      this.pos++;
      const args: Value[] = [];
      if (!this.eatOp(")")) {
        for (;;) {
          args.push(this.parseExpression());
          if (this.eatOp(")")) break;
          if (!this.eatOp(",")) throw new Error("bad args");
        }
      }
      const name = String(args[0] ?? "").trim();
      if (lower === "getvar") return this.scope.vars[name] ?? null;
      if (lower === "getglobalvar") return this.scope.globals[name] ?? null;
      throw new Error("unknown call");
    }

    // 지역 변수.
    if (this.locals.has(tok.v)) return this.locals.get(tok.v)!;
    throw new Error("unknown identifier");
  }
}

function applyMember(value: Value, name: string, args: Value[]): Value {
  const text = value === null ? "" : String(value);
  switch (name) {
    case "trim":
      return text.trim();
    case "length":
      return text.length;
    case "toLowerCase":
      return text.toLowerCase();
    case "toUpperCase":
      return text.toUpperCase();
    case "includes":
      return text.includes(String(args[0] ?? ""));
    case "startsWith":
      return text.startsWith(String(args[0] ?? ""));
    case "endsWith":
      return text.endsWith(String(args[0] ?? ""));
    default:
      throw new Error("unknown member");
  }
}

/**
 * 비교 — 우리 값은 전부 문자열로 저장되므로, 양쪽이 숫자로 읽히면 숫자로 견준다
 * (`getvar('affection') >= 70` 이 문자열 비교로 어긋나지 않게).
 * `===`/`!==` 는 타입이 다르면 거짓(JS 와 같은 의미)이되, 문자열↔숫자처럼
 * 우리 저장 방식 때문에 갈리는 경우만 숫자로 견준다.
 */
function compare(left: Value, op: string, right: Value): boolean {
  const ln = toNumber(left);
  const rn = toNumber(right);
  const bothNumeric = ln !== null && rn !== null;

  switch (op) {
    case ">":
      return bothNumeric ? ln! > rn! : String(left) > String(right);
    case "<":
      return bothNumeric ? ln! < rn! : String(left) < String(right);
    case ">=":
      return bothNumeric ? ln! >= rn! : String(left) >= String(right);
    case "<=":
      return bothNumeric ? ln! <= rn! : String(left) <= String(right);
    case "===":
    case "==":
      return bothNumeric ? ln === rn : looseEqual(left, right);
    case "!==":
    case "!=":
      return !(bothNumeric ? ln === rn : looseEqual(left, right));
    default:
      return false;
  }
}

function looseEqual(left: Value, right: Value): boolean {
  if (left === null || right === null) return left === right;
  if (typeof left === "boolean" || typeof right === "boolean") {
    return isTruthy(left) === isTruthy(right);
  }
  return String(left) === String(right);
}

function toNumber(value: Value): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** 빈 값·0·false·없음이 거짓. 우리 변수는 문자열이라 `"0"` 도 거짓으로 본다(ST 동일). */
function isTruthy(value: Value): boolean {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

function stringify(value: Value): string {
  return value === null ? "" : String(value);
}

// ─────────────────────────── 로어북에 적용 ───────────────────────────

/** 최소한의 로어북 모양 — 이 모듈이 세션/스토어 타입에 묶이지 않게. */
interface TemplatableBook<E extends { content: string }> {
  entries: E[];
}

/**
 * 로어북 목록에 조건부 내용을 적용한 **사본**을 돌려준다.
 * 템플릿이 없는 책/항목은 원본 객체를 그대로 재사용한다(불필요한 복사 없음).
 * 조건 때문에 내용이 통째로 비면 그 항목은 빠진다 — 빈 항목이 전송본에
 * 제목만 남기지 않도록.
 */
export function renderLorebookTemplates<
  E extends { content: string },
  B extends TemplatableBook<E>,
>(books: B[], scope: TemplateScope): B[] {
  return books.map((book) => {
    if (!book.entries.some((e) => hasLorebookTemplate(e.content))) return book;
    const entries: E[] = [];
    for (const entry of book.entries) {
      if (!hasLorebookTemplate(entry.content)) {
        entries.push(entry);
        continue;
      }
      const rendered = renderLorebookTemplate(entry.content, scope).text;
      if (!rendered.trim()) continue;
      entries.push({ ...entry, content: rendered });
    }
    return { ...book, entries };
  });
}
