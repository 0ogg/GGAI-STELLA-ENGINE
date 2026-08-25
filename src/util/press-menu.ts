import { Platform } from "obsidian";

/**
 * 우클릭 + 모바일 롱프레스 컨텍스트 메뉴 부착기 (사이드바/대시보드 공용).
 *
 * 롱프레스로 메뉴를 띄운 직후 발생하는 click 이벤트가 카드 열기 동작을
 * 오발동시키지 않도록, 카드 click 핸들러 첫 줄에서 consumeSuppressedClick()
 * 을 호출해 그 클릭 한 번을 삼킨다.
 */

export interface PressMenuOptions {
  /**
   * 글자 위 꾹 누르기를 OS 에 양보한다(모바일 전용).
   *
   * 읽는 글에 붙는 메뉴 전용 — 단어를 골라 사전(iOS 조회)·웹 검색에 넣으려면
   * OS 기본 선택 메뉴가 떠야 하는데, 그건 **사람이 직접 만든 선택**에만 붙는다
   * (코드로 잡아준 선택에는 iOS·안드로이드 둘 다 안 뜬다). 우리 메뉴가 그 자리를
   * 가져가면 단어 하나를 사전에 넣을 방법이 아예 없어진다.
   *
   * 판정은 타이밍이 아니라 **손가락이 글자 위에 떨어졌는지**로 한다 — OS·버전마다
   * 롱프레스 임계값이 달라 타이밍으로 가르면 동작이 갈린다.
   */
  yieldToTextSelection?: boolean;
}

/** (x, y) 가 el 안 글자 위인지 — 여백·줄 끝 빈 곳은 false. */
function pointIsOverGlyph(el: HTMLElement, x: number, y: number): boolean {
  const doc = el.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = doc.caretRangeFromPoint?.(x, y) ?? null;
  const node = caret?.startContainer;
  if (!caret || !(node instanceof Text) || !el.contains(node)) return false;
  // caretRangeFromPoint 는 여백을 짚어도 가장 가까운 글자 자리를 돌려준다.
  // 그 글자의 실제 사각형이 좌표를 품는지까지 봐야 "글자 위"가 판별된다.
  const offset = Math.min(caret.startOffset, Math.max(0, node.data.length - 1));
  const char = doc.createRange();
  char.setStart(node, offset);
  char.setEnd(node, Math.min(offset + 1, node.data.length));
  const rect = char.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return (
    x >= rect.left - 2 &&
    x <= rect.right + 2 &&
    y >= rect.top - 2 &&
    y <= rect.bottom + 2
  );
}

export class PressMenuController {
  private suppressNextClick = false;

  attachContextMenu(
    el: HTMLElement,
    showMouse: (event: MouseEvent) => void,
    showPosition: (x: number, y: number) => void,
    opts?: PressMenuOptions
  ): void {
    el.addEventListener("contextmenu", (e) => {
      // 안드로이드는 롱프레스가 contextmenu 로도 온다 — 여기서 막으면 OS 선택
      // 메뉴까지 함께 사라지므로, 글자 위면 손대지 않고 그대로 흘려보낸다.
      if (this.yieldsToText(el, e.clientX, e.clientY, opts)) return;
      e.preventDefault();
      showMouse(e);
    });
    this.attachLongPressMenu(el, showPosition, opts);
  }

  private yieldsToText(
    el: HTMLElement,
    x: number,
    y: number,
    opts?: PressMenuOptions
  ): boolean {
    if (!opts?.yieldToTextSelection || !Platform.isMobile) return false;
    return pointIsOverGlyph(el, x, y);
  }

  attachLongPressMenu(
    el: HTMLElement,
    showPosition: (x: number, y: number) => void,
    opts?: PressMenuOptions
  ): void {
    let timer: number | null = null;
    let startX = 0;
    let startY = 0;
    const clear = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.pointerType === "mouse") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input,textarea,select")) return;
      const button = target?.closest("button");
      if (button && !button.classList.contains("ggai-session-name")) return;
      startX = e.clientX;
      startY = e.clientY;
      clear();
      if (this.yieldsToText(el, startX, startY, opts)) return; // 글자 위 = OS 몫
      timer = window.setTimeout(() => {
        timer = null;
        this.suppressNextClick = true;
        showPosition(startX, startY);
        window.setTimeout(() => {
          this.suppressNextClick = false;
        }, 500);
      }, 950);
    });
    el.addEventListener("pointermove", (e) => {
      if (Math.abs(e.clientX - startX) > 6 || Math.abs(e.clientY - startY) > 6) {
        clear();
      }
    });
    el.addEventListener("pointerup", clear);
    el.addEventListener("pointercancel", clear);
    el.addEventListener("pointerleave", clear);
  }

  consumeSuppressedClick(e: MouseEvent): boolean {
    if (!this.suppressNextClick) return false;
    e.preventDefault();
    e.stopPropagation();
    this.suppressNextClick = false;
    return true;
  }
}
