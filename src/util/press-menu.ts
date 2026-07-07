/**
 * 우클릭 + 모바일 롱프레스 컨텍스트 메뉴 부착기 (사이드바/대시보드 공용).
 *
 * 롱프레스로 메뉴를 띄운 직후 발생하는 click 이벤트가 카드 열기 동작을
 * 오발동시키지 않도록, 카드 click 핸들러 첫 줄에서 consumeSuppressedClick()
 * 을 호출해 그 클릭 한 번을 삼킨다.
 */
export class PressMenuController {
  private suppressNextClick = false;

  attachContextMenu(
    el: HTMLElement,
    showMouse: (event: MouseEvent) => void,
    showPosition: (x: number, y: number) => void
  ): void {
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showMouse(e);
    });
    this.attachLongPressMenu(el, showPosition);
  }

  attachLongPressMenu(
    el: HTMLElement,
    showPosition: (x: number, y: number) => void
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
