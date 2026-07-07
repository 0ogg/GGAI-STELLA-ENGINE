/**
 * 전체 화면 이미지 라이트박스 — 삽화 캐러셀 클릭 / 갤러리 클릭 공용.
 *
 * document.body 에 오버레이를 붙이고, 좌우 화살표/키보드로 넘기며 배경 클릭·ESC 로 닫는다.
 * 플러그인 DOM 은 옵시디언 기본 이미지 줌이 적용되지 않으므로 자체 오버레이로 구현한다.
 */

export interface LightboxItem {
  src: string;
  caption?: string;
}

export function openImageLightbox(items: LightboxItem[], start = 0): void {
  if (items.length === 0) return;
  let idx = Math.max(0, Math.min(start, items.length - 1));

  const overlay = document.body.createDiv({ cls: "ggai-lightbox" });
  const img = overlay.createEl("img", { cls: "ggai-lightbox-img" });
  const caption = overlay.createDiv({ cls: "ggai-lightbox-caption" });
  const prev = overlay.createDiv({
    cls: "ggai-lightbox-nav ggai-lightbox-prev",
    text: "‹",
  });
  const next = overlay.createDiv({
    cls: "ggai-lightbox-nav ggai-lightbox-next",
    text: "›",
  });

  const update = () => {
    const item = items[idx];
    img.src = item.src;
    caption.setText(item.caption ?? "");
    caption.toggleClass("is-hidden", !item.caption);
    const single = items.length < 2;
    prev.toggleClass("is-hidden", single);
    next.toggleClass("is-hidden", single);
  };
  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const go = (d: number) => {
    idx = (idx + d + items.length) % items.length;
    update();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  img.addEventListener("click", (e) => e.stopPropagation());
  prev.addEventListener("click", (e) => {
    e.stopPropagation();
    go(-1);
  });
  next.addEventListener("click", (e) => {
    e.stopPropagation();
    go(1);
  });
  document.addEventListener("keydown", onKey);
  update();
}
