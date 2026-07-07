/**
 * 버튼 long-press 헬퍼 — 마우스/터치 공통.
 *
 * 꾹 누르기(기본 500ms)가 발동하면 직후의 click 을 캡처 단계에서 억제해
 * 탭 동작과 충돌하지 않는다. `onTap` 을 주면 일반 클릭도 여기서 처리한다
 * (별도 click 리스너를 쓰는 호출부는 생략 가능).
 */

const DEFAULT_LONG_PRESS_MS = 500;

export interface LongPressOptions {
  onLongPress: (x: number, y: number) => void;
  onTap?: () => void;
  durationMs?: number;
}

export function attachLongPress(el: HTMLElement, opts: LongPressOptions): void {
  const duration = opts.durationMs ?? DEFAULT_LONG_PRESS_MS;
  let timer: number | null = null;
  let triggered = false;

  const start = (x: number, y: number) => {
    triggered = false;
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      triggered = true;
      timer = null;
      opts.onLongPress(x, y);
    }, duration);
  };
  const cancel = () => {
    if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    start(e.clientX, e.clientY);
  });
  el.addEventListener("mouseup", cancel);
  el.addEventListener("mouseleave", cancel);
  el.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    if (t) start(t.clientX, t.clientY);
  });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
  el.addEventListener(
    "click",
    (e) => {
      if (triggered) {
        e.preventDefault();
        e.stopImmediatePropagation();
        triggered = false;
        return;
      }
      opts.onTap?.();
    },
    true
  );
}
