/**
 * 카드가 낸 HTML 을 안전하게 그리기 (게임형 카드 지원 스펙.md U4).
 *
 * 게임형 카드는 상태창·게이지·표·선택지를 HTML 로 낸다. 그런데 그 HTML 은
 * **남이 만든 카드에서 온 것**이고, 그대로 그리면 스크립트·앱 UI 파괴가 열린다.
 * 그래서 화이트리스트로 통과시킨다 — 모르는 것은 막고, 아는 것만 그린다.
 *
 * 통과 범위는 **실리태번과 같은 수준**으로 맞춘다(ST 는 DOMPurify 기본 허용을
 * 쓴다): 링크·버튼·입력요소·접기·표·SVG 가 다 그려지고, `on*` 이벤트 속성만
 * 사라진다. "이건 되고 저건 안 되는" 부분 지원은 카드가 깨져 보이는 원인이다.
 *
 * 정책 함수(`isAllowedTag`/`isAllowedAttr`/`isSafeUrl`/`sanitizeStyleValue`/
 * `scopeCss`)는 순수 함수라 하네스가 직접 검사한다. 트리 순회는 그 판정을
 * 그대로 따르는 얇은 껍데기다.
 *
 * 네 가지 원칙:
 *  1. **실행되는 것은 전부 막는다** — script/iframe/object/embed/link/form,
 *     `on*` 속성, `javascript:` 주소.
 *  2. **모르는 태그는 벗기되 내용은 남긴다** — 카드들이 `<stat>` `<choices>` 처럼
 *     약속된 가짜 태그를 쓰는데, 통째로 지우면 본문이 사라진다. 껍데기만 벗긴다.
 *  3. **남의 이름이 우리 화면을 건드리지 못하게 한다** — 카드가 쓴 class/id 는
 *     `custom-` 접두사를 붙이고(ST 와 같은 처리), `<style>` 은 말풍선 안으로
 *     선택자를 가둔다. 그래서 카드 CSS 가 옵시디언 화면을 망칠 수 없다.
 *  4. **화면을 덮는 배치는 막는다** — `position: fixed/sticky`, `z-index`.
 */

/** 카드가 쓴 이름(class/id)에 붙이는 접두사 — 우리 화면 이름과 섞이지 않게. */
export const CUSTOM_PREFIX = "custom-";

/** 빈 줄 표식 태그 (`message-format.ts` 가 심는다) — 여백 블록으로 바뀐다. */
const SEPARATOR_TAG = "ggai-sep";

const SVG_NS = "http://www.w3.org/2000/svg";

/** 그릴 수 있는 태그. 여기 없는 태그는 껍데기를 벗기고 내용만 남긴다. */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "div", "span", "p", "br", "hr", "section", "article", "header", "footer",
  "main", "nav", "aside", "address", "center",
  "a", "button", "label", "input", "select", "option", "optgroup", "textarea",
  "fieldset", "legend", "output", "datalist",
  "b", "strong", "i", "em", "u", "s", "del", "ins", "mark", "small", "sub", "sup",
  "code", "pre", "kbd", "samp", "blockquote", "q", "cite", "abbr", "dfn", "var",
  "ruby", "rt", "rp", "font", "big",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "details", "summary", "figure", "figcaption",
  "img", "picture", "video", "audio", "source", "progress", "meter", "time",
  "data", "bdi", "bdo", "wbr",
]);

/** 그릴 수 있는 SVG 태그 — 게이지·아이콘. 스크립트가 붙는 것들은 뺀다. */
export const ALLOWED_SVG_TAGS: ReadonlySet<string> = new Set([
  "svg", "g", "defs", "symbol", "title", "desc",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textpath",
  "linegradient", "lineargradient", "radialgradient", "stop",
  "clippath", "mask", "pattern", "marker", "filter",
  "fegaussianblur", "fedropshadow", "feoffset", "feblend", "femerge", "femergenode",
]);

/**
 * 내용까지 통째로 버릴 태그 — 벗기면 코드/주소가 글자로 튀어나온다.
 * (2번 원칙의 예외: 이건 "모르는 태그"가 아니라 "위험한 걸 아는 태그"다.)
 *
 * `form` 은 실리태번에도 그려지지만 우리는 버린다 — 서버가 없어 원래 동작하지
 * 않는 데다, 제출이 일어나면 옵시디언 창 자체가 바깥으로 이동한다.
 */
export const DROPPED_TAGS: ReadonlySet<string> = new Set([
  "script", "iframe", "object", "embed", "link", "meta", "base",
  "form", "template", "noscript", "math", "canvas",
  "applet", "frame", "frameset", "portal", "slot",
  "foreignobject", "use", "animate", "animatetransform", "animatemotion", "set",
]);

/** 모든 태그에 허용되는 속성. */
const GLOBAL_ATTRS: ReadonlySet<string> = new Set([
  "class", "style", "title", "dir", "lang", "id", "hidden", "role", "translate",
]);

/** 태그별 추가 허용 속성. */
const TAG_ATTRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["a", new Set(["href", "target", "rel", "type"])],
  ["img", new Set(["src", "alt", "width", "height", "loading", "decoding"])],
  ["picture", new Set([])],
  ["source", new Set(["src", "srcset", "type", "media", "sizes"])],
  ["video", new Set(["src", "poster", "controls", "loop", "muted", "playsinline", "preload", "width", "height"])],
  ["audio", new Set(["src", "controls", "loop", "muted", "preload"])],
  ["button", new Set(["type", "disabled", "value", "name"])],
  ["input", new Set(["type", "value", "checked", "disabled", "readonly", "placeholder", "name", "min", "max", "step", "maxlength", "size", "list", "multiple", "pattern"])],
  ["label", new Set(["for"])],
  ["select", new Set(["name", "disabled", "multiple", "size"])],
  ["option", new Set(["value", "selected", "disabled", "label"])],
  ["optgroup", new Set(["label", "disabled"])],
  ["textarea", new Set(["name", "rows", "cols", "disabled", "readonly", "placeholder", "maxlength", "wrap"])],
  ["output", new Set(["for", "name"])],
  ["datalist", new Set([])],
  ["fieldset", new Set(["disabled", "name"])],
  ["td", new Set(["colspan", "rowspan", "align", "valign", "headers"])],
  ["th", new Set(["colspan", "rowspan", "align", "valign", "scope", "abbr"])],
  ["col", new Set(["span", "width"])],
  ["colgroup", new Set(["span"])],
  ["details", new Set(["open"])],
  ["progress", new Set(["value", "max"])],
  ["meter", new Set(["value", "min", "max", "low", "high", "optimum"])],
  ["ol", new Set(["start", "reversed", "type"])],
  ["li", new Set(["value"])],
  ["time", new Set(["datetime"])],
  ["data", new Set(["value"])],
  ["bdo", new Set(["dir"])],
  ["blockquote", new Set(["cite"])],
  ["q", new Set(["cite"])],
  ["font", new Set(["color", "face", "size"])],
  ["pre", new Set(["wrap"])],
]);

/** SVG 에서 허용하는 속성 — 그리기 기하/색만. */
const SVG_ATTRS: ReadonlySet<string> = new Set([
  "viewbox", "xmlns", "width", "height", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "r", "rx", "ry", "d", "points", "transform", "preserveaspectratio",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset",
  "opacity", "offset", "stop-color", "stop-opacity", "gradientunits",
  "gradienttransform", "spreadmethod", "clip-path", "mask", "filter",
  "font-size", "font-family", "font-weight", "text-anchor", "dominant-baseline",
  "dx", "dy", "class", "style", "id", "clip-rule", "vector-effect",
  "stddeviation", "flood-color", "flood-opacity", "result", "in", "in2", "mode",
  "patternunits", "markerwidth", "markerheight", "refx", "refy", "orient",
]);

export function isAllowedTag(tag: string): boolean {
  return ALLOWED_TAGS.has(tag.toLowerCase());
}

export function isAllowedSvgTag(tag: string): boolean {
  return ALLOWED_SVG_TAGS.has(tag.toLowerCase());
}

export function isDroppedTag(tag: string): boolean {
  return DROPPED_TAGS.has(tag.toLowerCase());
}

/**
 * 속성 허용 판정. `on*`(이벤트 연결)은 어떤 경우에도 통과하지 못한다 —
 * 화이트리스트에 없어서가 아니라 **명시적으로** 막는다(정책이 눈에 보이게).
 * `data-*` 는 그리기에 영향이 없어 통과시킨다(카드 CSS 가 골라 쓴다).
 */
export function isAllowedAttr(tag: string, attr: string): boolean {
  const name = attr.toLowerCase();
  if (name.startsWith("on")) return false;
  if (name === "srcdoc" || name === "formaction" || name === "xlink:href") return false;
  if (name === "action" || name === "form" || name === "ping") return false;
  if (name.startsWith("data-") || name.startsWith("aria-")) return true;
  if (GLOBAL_ATTRS.has(name)) return true;
  return TAG_ATTRS.get(tag.toLowerCase())?.has(name) === true;
}

export function isAllowedSvgAttr(attr: string): boolean {
  const name = attr.toLowerCase();
  if (name.startsWith("on")) return false;
  if (name.startsWith("xlink:") || name === "href") return false;
  if (name.startsWith("data-") || name.startsWith("aria-")) return true;
  return SVG_ATTRS.has(name);
}

/**
 * 주소 안전 판정 — 이미지·링크·CSS `url()` 에 쓴다.
 * 허용: 상대 경로, `app://`(옵시디언 내부 리소스), `data:image/*`, `http(s)://`,
 * `mailto:`. 막음: `javascript:` `vbscript:` `file:` 및 그 변형.
 */
export function isSafeUrl(url: string): boolean {
  // 제어문자/공백을 걷어낸 뒤 판정한다 — `java\nscript:` 같은 회피 시도 방지.
  const cleaned = (url ?? "").replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (!cleaned) return false;
  if (/^(javascript|vbscript|file|blob|about|chrome|resource):/.test(cleaned)) return false;
  if (cleaned.startsWith("data:")) return /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml);/.test(cleaned);
  if (/^[a-z][a-z0-9+.-]*:/.test(cleaned)) {
    return /^(https?|app|mailto):/.test(cleaned);
  }
  return true; // 스킴 없음 = 상대 경로 또는 앵커(#)
}

/** 선언 목록을 `;` 로 자른다 — 괄호·따옴표 안의 `;`(data: URI)는 자르지 않는다. */
function splitDeclarations(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = "";
  for (const ch of css ?? "") {
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/** 선언 안의 모든 `url(...)` 이 안전한 주소인가. */
function declarationUrlsAreSafe(decl: string): boolean {
  const re = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(decl)) != null) {
    if (!isSafeUrl(m[2])) return false;
  }
  return true;
}

/**
 * `style` 값 정리 — 코드를 부르는 것과 화면을 덮는 것만 걷어낸다.
 * 남은 선언은 그대로 둔다(카드 디자인을 살리는 게 목적).
 * `url()` 은 주소가 안전할 때만 통과한다(그림 배경을 쓰는 카드가 많다).
 */
export function sanitizeStyleValue(css: string): string {
  const out: string[] = [];
  for (const decl of splitDeclarations(css ?? "")) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    // 코드 실행 통로.
    if (/expression\s*\(|@import|behavior\s*:|-moz-binding/.test(lower)) continue;
    // 바깥을 부르는 주소.
    if (/url\s*\(/.test(lower) && !declarationUrlsAreSafe(trimmed)) continue;
    // 화면 전체를 덮어 앱 조작을 가로채는 배치.
    if (/^position\s*:\s*(fixed|sticky)/.test(lower)) continue;
    if (/^z-index\s*:/.test(lower)) continue;
    out.push(trimmed);
  }
  return out.join("; ");
}

/**
 * 이름 하나에 접두사를 붙인다. 이미 붙었거나 **우리가 만든 이름(`ggai-`)** 이면
 * 그대로 둔다 — 살균기는 우리 자신이 넣은 마크업(카드 이미지 등)도 지나간다.
 */
function prefixName(name: string): string {
  if (name.startsWith(CUSTOM_PREFIX) || name.startsWith("ggai-")) return name;
  return CUSTOM_PREFIX + name;
}

/** 카드가 쓴 이름(.foo / #bar)에 접두사를 붙인다 — 우리 화면 이름과 격리. */
export function prefixCustomNames(selector: string): string {
  return (selector ?? "").replace(
    /([.#])(-?[A-Za-z_][\w-]*)/g,
    (_m, sigil: string, name: string) => `${sigil}${prefixName(name)}`
  );
}

/** 여는 중괄호의 짝 위치 (문자열 안 중괄호는 세지 않는다). -1 = 짝 없음. */
function matchBrace(css: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function scopeSelector(selector: string, scope: string): string | null {
  const trimmed = selector.trim();
  if (!trimmed) return null;
  // 화면 전체를 노리는 선택자는 우리 범위 자신으로 바꾼다.
  const rooted = trimmed.replace(/^(:root|html|body)\b\s*/i, "");
  const named = prefixCustomNames(rooted);
  return named ? `${scope} ${named}` : scope;
}

/**
 * 카드가 낸 `<style>` 을 말풍선 안으로 가둔다 (RisuAI·실리태번과 같은 처리).
 * 선택자마다 `scope` 를 앞에 붙이고 class/id 이름에 접두사를 단다.
 * `scope` 가 null 이면 선택자를 건드리지 않는다(@keyframes 안쪽 `0%` 등).
 */
export function scopeCss(css: string, scope: string | null): string {
  const out: string[] = [];
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf("{", i);
    if (brace < 0) break;
    const prelude = css.slice(i, brace).trim();
    const end = matchBrace(css, brace);
    if (end < 0) break;
    const body = css.slice(brace + 1, end);
    i = end + 1;
    if (!prelude) continue;

    if (prelude.startsWith("@")) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? "";
      if (["media", "supports", "container", "layer", "scope"].includes(name)) {
        const inner = scopeCss(body, scope);
        if (inner.trim()) out.push(`${prelude} {\n${inner}\n}`);
        continue;
      }
      if (name.endsWith("keyframes")) {
        const inner = scopeCss(body, null); // 안쪽은 `0% { … }` — 선택자 유지
        if (inner.trim()) out.push(`${prelude} {\n${inner}\n}`);
        continue;
      }
      if (name === "font-face") {
        const decls = sanitizeStyleValue(body);
        if (decls) out.push(`${prelude} { ${decls} }`);
        continue;
      }
      continue; // @import 등 모르는 at-rule 은 버린다
    }

    const decls = sanitizeStyleValue(body);
    if (!decls) continue;
    if (scope == null) {
      out.push(`${prelude} { ${decls} }`);
      continue;
    }
    const selectors = prelude
      .split(",")
      .map((sel) => scopeSelector(sel, scope))
      .filter((sel): sel is string => sel != null);
    if (selectors.length === 0) continue;
    out.push(`${selectors.join(", ")} { ${decls} }`);
  }
  return out.join("\n");
}

/** 카드 전용 이미지 태그 `{{img::파일명.jpg}}` — ST 쪽 카드들이 쓰는 관례. */
const CARD_IMAGE_RE = /\{\{\s*img::([^}]+?)\s*\}\}/gi;

export function hasCardImageTag(text: string): boolean {
  CARD_IMAGE_RE.lastIndex = 0;
  return CARD_IMAGE_RE.test(text ?? "");
}

/** 실제 태그처럼 생긴 게 있는가 — 없으면 HTML 경로를 타지 않는다(`3 < 5` 오인 방지). */
export function hasHtmlMarkup(text: string): boolean {
  return /<\/?[a-zA-Z][\w:-]*(\s[^<>]*)?\/?>/.test(text ?? "");
}

/**
 * `{{img::파일명}}` 을 `<img>` 로 바꾼다. 못 찾은 이름은 **지운다** —
 * 내부 약속 태그라 글자로 남으면 그게 더 이상하다.
 */
export function replaceCardImageTags(
  text: string,
  resolve: (name: string) => string | null
): string {
  return (text ?? "").replace(CARD_IMAGE_RE, (_m, name: string) => {
    const src = resolve(name.trim());
    if (!src || !isSafeUrl(src)) return "";
    const escaped = src.replace(/"/g, "&quot;");
    const alt = name.trim().replace(/"/g, "&quot;");
    return `<img class="ggai-card-img" src="${escaped}" alt="${alt}">`;
  });
}

export interface SafeHtmlOptions {
  /**
   * 카드가 낸 `<style>` 을 이 선택자 밑으로 가둔다(예: `.ggai-chat-bubble`).
   * 주지 않으면 `<style>` 을 버린다 — 전역 CSS 는 앱 화면을 망친다.
   */
  styleScope?: string;
}

/**
 * HTML 문자열을 화이트리스트로 걸러 `target` 안에 그린다.
 * 들어오는 문자열은 이미 마크다운이 적용된 HTML 이다(`message-format.ts`).
 */
export function renderSafeHtml(
  target: HTMLElement,
  html: string,
  opts: SafeHtmlOptions = {}
): void {
  // 옵시디언 전용 헬퍼(empty/createDiv) 대신 표준 DOM 만 쓴다 —
  // 이 파일이 하네스에서도 그대로 컴파일되게(정책 검사가 돌아야 한다).
  target.textContent = "";
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${html}</body>`,
    "text/html"
  );
  for (const node of Array.from(doc.body.childNodes)) {
    const clean = sanitizeNode(node, opts);
    if (clean) target.appendChild(clean);
  }
}

/** 노드 하나를 정책대로 복제. 통과 못 하면 null (내용만 남기는 경우는 조각으로). */
function sanitizeNode(node: Node, opts: SafeHtmlOptions): Node | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.textContent ?? "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const isSvg = el.namespaceURI === SVG_NS;

  const children = (): DocumentFragment => {
    const frag = document.createDocumentFragment();
    for (const child of Array.from(el.childNodes)) {
      const clean = sanitizeNode(child, opts);
      if (clean) frag.appendChild(clean);
    }
    return frag;
  };

  // 빈 줄 표식 — 원문에 준 빈 줄만큼 여백을 그린다.
  if (tag === SEPARATOR_TAG) {
    const lines = Number(el.getAttribute("n"));
    const sep = document.createElement("div");
    sep.className = "ggai-chat-para-sep";
    sep.style.setProperty(
      "--ggai-sep-lines",
      String(Number.isFinite(lines) && lines > 0 ? lines : 1)
    );
    return sep;
  }

  // 카드 CSS — 말풍선 안으로 가둬서 받는다(범위를 안 주면 버린다).
  if (tag === "style" && !isSvg) {
    if (!opts.styleScope) return null;
    const scoped = scopeCss(el.textContent ?? "", opts.styleScope);
    if (!scoped.trim()) return null;
    const style = document.createElement("style");
    style.textContent = scoped;
    return style;
  }

  if (isDroppedTag(tag)) return null;

  // 모르는 태그 — 껍데기만 벗기고 내용은 살린다.
  const allowed = isSvg ? isAllowedSvgTag(tag) : isAllowedTag(tag);
  if (!allowed) return children();

  const out = isSvg
    ? (document.createElementNS(SVG_NS, tag) as unknown as HTMLElement)
    : document.createElement(tag);

  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (isSvg ? !isAllowedSvgAttr(name) : !isAllowedAttr(tag, name)) continue;
    if (name === "src" || name === "poster") {
      if (!isSafeUrl(attr.value)) continue;
      out.setAttribute(name, attr.value);
      continue;
    }
    if (name === "href") {
      if (!isSafeUrl(attr.value)) continue;
      // 앵커(#foo)는 카드 이름 접두사와 같이 맞춰야 서로 가리킨다.
      out.setAttribute(
        name,
        attr.value.startsWith("#") ? prefixCustomNames(attr.value) : attr.value
      );
      continue;
    }
    if (name === "style") {
      const style = sanitizeStyleValue(attr.value);
      if (style) out.setAttribute("style", style);
      continue;
    }
    if (name === "class" || name === "id" || name === "for") {
      const prefixed = attr.value
        .split(/\s+/)
        .filter((v) => v)
        .map(prefixName)
        .join(" ");
      if (prefixed) out.setAttribute(name, prefixed);
      continue;
    }
    out.setAttribute(name, attr.value);
  }

  // 링크는 바깥 브라우저로 — 옵시디언 창 자체가 이동하면 앱이 날아간다.
  if (tag === "a" && !isSvg && out.hasAttribute("href")) {
    out.setAttribute("target", "_blank");
    out.setAttribute("rel", "noopener noreferrer");
    out.classList.add("external-link");
  }
  // 카드 버튼 — 눌렀을 때 무엇을 할지는 그리는 화면이 정한다(표식만 남긴다).
  if (tag === "button" && !isSvg) {
    out.setAttribute("type", "button");
    out.classList.add("ggai-card-btn");
  }

  out.appendChild(children());
  return out;
}
