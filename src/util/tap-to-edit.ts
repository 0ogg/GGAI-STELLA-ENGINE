import { Platform } from "obsidian";
import { isImeComposing } from "../views/edit-guard";

/**
 * 모바일에서 "스크롤하다 손을 뗐을 뿐인데 편집이 시작되는" 오인을 없앤다.
 *
 * 원인은 편집 대상(본문·번역칸·말풍선)이 항상 contenteditable 로 깔려 있는 것 —
 * 스크롤 제스처의 끝에서 브라우저가 그 자리에 caret 을 놓아버리고 키보드가 뜬다.
 * 그래서 평소엔 contenteditable 을 떼 두고, **제자리 짧은 탭**일 때만 되돌려
 * 붙인 뒤 포커스 + 탭한 자리에 caret 을 놓는다.
 *
 * - 데스크톱은 이 오인이 없으므로 게이트를 걸지 않는다(마우스는 원래대로).
 * - 꾹 누르기는 탭이 아니라 편집이 열리지 않는다 — 그 자리는 컨텍스트 메뉴 몫.
 * - 편집을 끝내면(blur) 다시 잠근다.
 *
 * contenteditable 속성의 소유권이 이 모듈로 넘어오므로, 생성 중 잠금처럼
 * 편집 자체를 막던 코드는 `setEditAllowed` 를 거쳐야 한다(직접 setAttr 금지).
 */

/** 부착 시점의 contenteditable 값 — 편집을 열 때 되돌려 붙인다. */
const MODE = new WeakMap<HTMLElement, string>();
/** 탭 게이트가 걸린 요소(모바일). */
const GATED = new WeakSet<HTMLElement>();
/** 편집 자체가 금지된 상태(생성 중 등). */
const BLOCKED = new WeakSet<HTMLElement>();

const MOVE_TOLERANCE_PX = 8;
const MAX_TAP_MS = 700;
/** 스크롤 직후(관성 멈춤 탭 포함)에는 편집을 열지 않는다. */
const SCROLL_QUIET_MS = 300;

let lastScrollAt = 0;
let scrollWatchInstalled = false;

function watchScroll(doc: Document): void {
  if (scrollWatchInstalled) return;
  scrollWatchInstalled = true;
  // 캡처 단계 — 어느 스크롤 컨테이너에서 났든 한 곳에서 받는다.
  doc.addEventListener(
    "scroll",
    (e) => {
      lastScrollAt = e.timeStamp;
    },
    { capture: true, passive: true }
  );
}

export function attachTapToEdit(el: HTMLElement): void {
  const mode = el.getAttribute("contenteditable");
  if (!mode || MODE.has(el)) return;
  MODE.set(el, mode);
  if (!Platform.isMobile) return; // 데스크톱 — 값만 기억하고 게이트는 걸지 않는다
  GATED.add(el);
  el.removeAttribute("contenteditable");
  watchScroll(el.ownerDocument);

  let startX = 0;
  let startY = 0;
  let startedAt = 0;
  let moved = false;
  let tracking = false;

  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return; // 모바일에 붙인 마우스 — 원래대로
    tracking = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    startedAt = e.timeStamp;
  });
  el.addEventListener("pointermove", (e) => {
    if (!tracking) return;
    if (
      Math.abs(e.clientX - startX) > MOVE_TOLERANCE_PX ||
      Math.abs(e.clientY - startY) > MOVE_TOLERANCE_PX
    ) {
      moved = true; // 스크롤 — 손을 떼도 편집을 열지 않는다
    }
  });
  el.addEventListener("pointercancel", () => {
    tracking = false;
  });
  el.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    if (moved || e.timeStamp - startedAt > MAX_TAP_MS) return;
    if (e.timeStamp - lastScrollAt < SCROLL_QUIET_MS) return; // 관성 멈춤 탭
    beginEdit(el, e.clientX, e.clientY); // 제스처 안이라 키보드가 정상적으로 뜬다
  });
  el.addEventListener("blur", () => {
    if (GATED.has(el) && !BLOCKED.has(el)) el.removeAttribute("contenteditable");
  });
}

/**
 * 게이트를 건너뛰고 지금 편집을 연다 — 의도가 이미 확실한 경로(탭 판정 통과,
 * 메뉴 항목 등)용. 좌표를 주면 그 자리에 caret 을 놓는다.
 */
export function beginEdit(el: HTMLElement, x?: number, y?: number): void {
  if (BLOCKED.has(el)) return;
  const mode = MODE.get(el);
  if (mode && el.getAttribute("contenteditable") !== mode) {
    el.setAttribute("contenteditable", mode);
  }
  el.focus({ preventScroll: true });
  // 게이트 때문에 브라우저의 기본 caret 배치가 일어나지 않았으므로 우리가 놓는다.
  // 조합 중에는 선택영역을 건드리지 않는다(입력 마비 회귀 방어).
  if (x != null && y != null && !isImeComposing()) placeCaretAtPoint(el, x, y);
}

/**
 * 편집 가능 여부 자체를 바꾼다(생성 중 잠금 등). 게이트가 걸린 요소는 "허용"이
 * 곧 열림이 아니라 **탭을 기다리는 상태**로 돌아가는 것이다.
 */
export function setEditAllowed(el: HTMLElement, allowed: boolean): void {
  if (!allowed) {
    BLOCKED.add(el);
    el.setAttribute("contenteditable", "false");
    return;
  }
  BLOCKED.delete(el);
  if (GATED.has(el)) el.removeAttribute("contenteditable");
  else el.setAttribute("contenteditable", MODE.get(el) ?? "true");
}

function placeCaretAtPoint(el: HTMLElement, x: number, y: number): void {
  const doc = el.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null;
  };
  let range = doc.caretRangeFromPoint?.(x, y) ?? null;
  if (!range && doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) {
      range = doc.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (!range || !el.contains(range.startContainer)) return;
  const sel = doc.defaultView?.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}
