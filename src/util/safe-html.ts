/**
 * 카드가 낸 HTML 을 안전하게 그리기 (게임형 카드 지원 스펙.md U4).
 *
 * 게임형 카드는 상태창·게이지·표를 HTML 로 낸다. 그런데 그 HTML 은 **남이 만든
 * 카드에서 온 것**이고, 그대로 그리면 스크립트·외부 요청·앱 UI 파괴가 전부 열린다.
 * 그래서 화이트리스트로 통과시킨다 — 모르는 것은 막고, 아는 것만 그린다.
 *
 * 정책 함수(`isAllowedTag`/`isAllowedAttr`/`isSafeUrl`/`sanitizeStyleValue`)는 순수
 * 함수라 하네스가 직접 검사한다. 트리 순회는 그 판정을 그대로 따르는 얇은 껍데기다.
 *
 * 세 가지 원칙:
 *  1. **실행되는 것은 전부 막는다** — script/iframe/object/embed/link/form/입력 요소,
 *     `on*` 속성, `javascript:` 주소.
 *  2. **모르는 태그는 벗기되 내용은 남긴다** — 카드들이 `<stat>` `<choices>` 처럼
 *     약속된 가짜 태그를 쓰는데, 통째로 지우면 본문이 사라진다. 껍데기만 벗긴다.
 *  3. **`<style>` 은 받지 않는다** — 전역 CSS 라 옵시디언 화면 전체를 망칠 수 있다.
 *     칸마다의 `style` 속성은 허용한다(그 요소에만 먹는다).
 */

/** 그릴 수 있는 태그. 여기 없는 태그는 껍데기를 벗기고 내용만 남긴다. */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "div", "span", "p", "br", "hr", "section", "article", "header", "footer",
  "b", "strong", "i", "em", "u", "s", "del", "ins", "mark", "small", "sub", "sup",
  "code", "pre", "kbd", "samp", "blockquote", "q", "cite", "abbr",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "details", "summary", "figure", "figcaption",
  "img", "progress", "meter", "time", "data", "bdi", "bdo", "wbr",
]);

/**
 * 내용까지 통째로 버릴 태그 — 벗기면 코드/주소가 글자로 튀어나온다.
 * (2번 원칙의 예외: 이건 "모르는 태그"가 아니라 "위험한 걸 아는 태그"다.)
 */
export const DROPPED_TAGS: ReadonlySet<string> = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "base",
  "form", "input", "button", "select", "option", "textarea", "template",
  "noscript", "svg", "math", "audio", "video", "source", "track", "canvas",
  "applet", "frame", "frameset", "portal", "slot",
]);

/** 모든 태그에 허용되는 속성. */
const GLOBAL_ATTRS: ReadonlySet<string> = new Set(["class", "style", "title", "dir", "lang"]);

/** 태그별 추가 허용 속성. */
const TAG_ATTRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["img", new Set(["src", "alt", "width", "height", "loading"])],
  ["td", new Set(["colspan", "rowspan", "align", "valign"])],
  ["th", new Set(["colspan", "rowspan", "align", "valign", "scope"])],
  ["col", new Set(["span", "width"])],
  ["colgroup", new Set(["span"])],
  ["details", new Set(["open"])],
  ["progress", new Set(["value", "max"])],
  ["meter", new Set(["value", "min", "max", "low", "high", "optimum"])],
  ["ol", new Set(["start", "reversed", "type"])],
  ["time", new Set(["datetime"])],
  ["data", new Set(["value"])],
  ["bdo", new Set(["dir"])],
]);

export function isAllowedTag(tag: string): boolean {
  return ALLOWED_TAGS.has(tag.toLowerCase());
}

export function isDroppedTag(tag: string): boolean {
  return DROPPED_TAGS.has(tag.toLowerCase());
}

/**
 * 속성 허용 판정. `on*`(이벤트 연결)은 어떤 경우에도 통과하지 못한다 —
 * 화이트리스트에 없어서가 아니라 **명시적으로** 막는다(정책이 눈에 보이게).
 */
export function isAllowedAttr(tag: string, attr: string): boolean {
  const name = attr.toLowerCase();
  if (name.startsWith("on")) return false;
  if (name === "srcdoc" || name === "formaction" || name === "xlink:href") return false;
  if (GLOBAL_ATTRS.has(name)) return true;
  return TAG_ATTRS.get(tag.toLowerCase())?.has(name) === true;
}

/**
 * 주소 안전 판정 — 이미지에 쓴다.
 * 허용: 상대 경로, `app://`(옵시디언 내부 리소스), `data:image/*`, `http(s)://`.
 * 막음: `javascript:` `vbscript:` `file:` 및 그 변형(공백·제어문자·대소문자 섞기).
 */
export function isSafeUrl(url: string): boolean {
  // 제어문자/공백을 걷어낸 뒤 판정한다 — `java\nscript:` 같은 회피 시도 방지.
  const cleaned = (url ?? "").replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (!cleaned) return false;
  if (/^(javascript|vbscript|file|blob|about|chrome|resource):/.test(cleaned)) return false;
  if (cleaned.startsWith("data:")) return /^data:image\/(png|jpe?g|gif|webp|avif|bmp);/.test(cleaned);
  if (/^[a-z][a-z0-9+.-]*:/.test(cleaned)) {
    return /^(https?|app):/.test(cleaned);
  }
  return true; // 스킴 없음 = 상대 경로
}

/**
 * `style` 속성 값 정리 — 바깥을 부를 수 있는 것과 화면을 덮는 것만 걷어낸다.
 * 남은 선언은 그대로 둔다(카드 디자인을 살리는 게 목적).
 */
export function sanitizeStyleValue(css: string): string {
  const out: string[] = [];
  for (const decl of (css ?? "").split(";")) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    // 외부 요청·코드 실행 통로.
    if (/url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding/.test(lower)) continue;
    // 화면 전체를 덮어 앱 조작을 가로채는 배치.
    if (/^position\s*:\s*(fixed|sticky)/.test(lower)) continue;
    if (/^z-index\s*:/.test(lower)) continue;
    out.push(trimmed);
  }
  return out.join("; ");
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

/**
 * HTML 문자열을 화이트리스트로 걸러 `target` 안에 그린다.
 * `formatText` 는 최상위 글 조각을 우리 말풍선 표기(기울임/문단)로 바꾸는 함수 —
 * 요소 **안쪽** 글에는 적용하지 않는다(카드가 직접 짠 마크업을 우리가 다시 해석하지 않는다).
 */
export function renderSafeHtml(
  target: HTMLElement,
  html: string,
  formatText: (text: string) => string
): void {
  // 옵시디언 전용 헬퍼(empty/createDiv) 대신 표준 DOM 만 쓴다 —
  // 이 파일이 하네스에서도 그대로 컴파일되게(정책 검사가 돌아야 한다).
  target.textContent = "";
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${html}</body>`,
    "text/html"
  );
  for (const node of Array.from(doc.body.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (!text.trim()) continue;
      // 최상위 글 조각만 우리 표기를 입힌다. formatText 결과는 우리가 만든 HTML.
      const holder = document.createElement("div");
      holder.className = "ggai-card-text";
      holder.innerHTML = formatText(text);
      target.appendChild(holder);
      continue;
    }
    const clean = sanitizeNode(node);
    if (clean) target.appendChild(clean);
  }
}

/** 노드 하나를 정책대로 복제. 통과 못 하면 null (내용만 남기는 경우는 조각으로). */
function sanitizeNode(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.textContent ?? "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (isDroppedTag(tag)) return null;

  const children = (): DocumentFragment => {
    const frag = document.createDocumentFragment();
    for (const child of Array.from(el.childNodes)) {
      const clean = sanitizeNode(child);
      if (clean) frag.appendChild(clean);
    }
    return frag;
  };

  // 모르는 태그 — 껍데기만 벗기고 내용은 살린다.
  if (!isAllowedTag(tag)) return children();

  const out = document.createElement(tag);
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (!isAllowedAttr(tag, name)) continue;
    if (name === "src") {
      if (!isSafeUrl(attr.value)) continue;
      out.setAttribute(name, attr.value);
      continue;
    }
    if (name === "style") {
      const style = sanitizeStyleValue(attr.value);
      if (style) out.setAttribute("style", style);
      continue;
    }
    out.setAttribute(name, attr.value);
  }
  out.appendChild(children());
  return out;
}
