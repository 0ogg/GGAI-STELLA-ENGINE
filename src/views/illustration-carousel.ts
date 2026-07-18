/**
 * IllustrationCarousel — 한 노드의 삽화 variant 를 좌우로 슬라이드하며 보여주는 재사용 컴포넌트.
 *
 * 삽화 출력 전용 뷰와 인라인 삽화가 같은 컴포넌트를 쓴다.
 *  - 선택된 variant 를 중앙에 크게, 좌우 화살표/슬라이드로 같은 노드의 이전/다음 variant 선택.
 *  - 이미지 클릭 → 전체 화면 라이트박스 (variant 전체를 넘길 수 있음).
 *  - 조작(재생성 버튼)은 눈에 띄지 않게(hover 시 노출). 재생성은 프롬프트 유지 재생성.
 *  - active variant 의 프롬프트를 caption 으로 (hover 시) 보여준다.
 */

import { Menu, setIcon } from "obsidian";
import type { IllustrationVariant } from "../types/media";
import { openImageLightbox } from "./image-lightbox";
import { PressMenuController } from "../util/press-menu";

export interface IllustrationCarouselConfig {
  /** variant → vault 리소스 URL (없으면 null). */
  resolveSrc: (v: IllustrationVariant) => string | null;
  getVariants: () => IllustrationVariant[];
  getActiveId: () => string | null;
  /** variant 선택 (active 이동). */
  onSelect: (variantId: string) => void;
  /** 프롬프트 유지 재생성. */
  onRegen: () => void;
  isBusy?: () => boolean;
  /** 즐겨찾기 여부 조회 (없으면 즐겨찾기 버튼 미노출). */
  isFavorite?: (v: IllustrationVariant) => boolean;
  /** 즐겨찾기 토글 — 동기적으로 새 상태를 반환(illustrations 객체를 즉시 변경하는 호출자 기준). */
  onToggleFavorite?: (variantId: string) => boolean | void;
  /** 우클릭/롱프레스 메뉴 — 보이는 variant 삭제 (없으면 메뉴에 미노출). */
  onDelete?: (variantId: string) => void;
  /** 우클릭/롱프레스 메뉴 — 스텔라 네트워크에 공유 (폰 사용중일 때만 넘긴다). */
  onShare?: (v: IllustrationVariant) => void;
}

export class IllustrationCarousel {
  private trackEl!: HTMLElement;
  private counterEl: HTMLElement | null = null;
  private favBtnEl: HTMLElement | null = null;
  private variants: IllustrationVariant[] = [];
  private activeIndex = 0;
  private pressMenu = new PressMenuController();

  constructor(
    private container: HTMLElement,
    private cfg: IllustrationCarouselConfig
  ) {
    this.container.addClass("ggai-illus-carousel");
    this.render();
  }

  render(): void {
    const variants = this.cfg.getVariants();
    this.variants = variants;
    this.counterEl = null;
    this.favBtnEl = null;
    this.container.empty();
    if (variants.length === 0) {
      this.container.addClass("is-empty");
      return;
    }
    this.container.removeClass("is-empty");

    const activeId = this.cfg.getActiveId();
    this.activeIndex = Math.max(
      0,
      variants.findIndex((v) => v.id === activeId)
    );

    const viewport = this.container.createDiv({ cls: "ggai-illus-viewport" });
    this.trackEl = viewport.createDiv({ cls: "ggai-illus-track" });

    const srcs = variants.map((v) => this.cfg.resolveSrc(v));
    variants.forEach((v, i) => {
      const slide = this.trackEl.createDiv({ cls: "ggai-illus-slide" });
      const src = srcs[i];
      if (src) {
        const img = slide.createEl("img", { cls: "ggai-illus-img" });
        img.src = src;
        img.addEventListener("click", (e) => {
          if (this.pressMenu.consumeSuppressedClick(e)) return;
          openImageLightbox(
            variants
              .map((_vv, j) => ({ src: srcs[j] ?? "" }))
              .filter((it) => it.src),
            this.activeIndex
          );
        });
      }
    });

    if (variants.length > 1) {
      const prev = viewport.createDiv({
        cls: "ggai-illus-nav ggai-illus-prev",
      });
      setIcon(prev, "chevron-left");
      prev.addEventListener("click", () => this.step(-1));
      const next = viewport.createDiv({
        cls: "ggai-illus-nav ggai-illus-next",
      });
      setIcon(next, "chevron-right");
      next.addEventListener("click", () => this.step(1));
      // 카운터는 텍스트 노드 대신 data 속성 + CSS content 로 그린다 — 인라인 삽화가
      // contenteditable 본문 안에 들어갈 때 textContent(diff/offset)를 오염시키지 않게.
      this.counterEl = viewport.createDiv({ cls: "ggai-illus-counter" });
      this.counterEl.setAttr(
        "data-count",
        `${this.activeIndex + 1} / ${variants.length}`
      );
    }

    // 재생성 버튼 (눈에 띄지 않게 — hover 시 노출).
    const regen = viewport.createDiv({ cls: "ggai-illus-regen" });
    setIcon(regen, "refresh-cw");
    regen.setAttr("aria-label", "삽화 재생성 (프롬프트 유지)");
    if (this.cfg.isBusy?.()) regen.addClass("is-busy");
    regen.addEventListener("click", () => this.cfg.onRegen());

    // 즐겨찾기 별 (모서리, 즐겨찾기된 상태는 항상 노출).
    if (this.cfg.isFavorite) {
      const fav = viewport.createDiv({ cls: "ggai-illus-fav" });
      setIcon(fav, "star");
      fav.setAttr("aria-label", "삽화 즐겨찾기");
      fav.toggleClass("is-favorited", this.cfg.isFavorite(variants[this.activeIndex]));
      fav.addEventListener("click", (e) => {
        e.stopPropagation();
        const v = this.variants[this.activeIndex];
        if (!v) return;
        const next = this.cfg.onToggleFavorite?.(v.id);
        if (typeof next === "boolean") fav.toggleClass("is-favorited", next);
      });
      this.favBtnEl = fav;
    }

    // 우클릭/롱프레스 메뉴 — 보이는 variant 기준 (즐겨찾기/공유/삭제).
    if (this.hasMenu()) {
      this.pressMenu.attachContextMenu(
        viewport,
        (e) => this.buildMenu()?.showAtMouseEvent(e),
        (x, y) => this.buildMenu()?.showAtPosition({ x, y })
      );
    }

    this.layout();
  }

  /** onDelete/onShare 를 넘긴 호출자(세션창)만 메뉴를 얻는다 — 출력 뷰는 기존 그대로. */
  private hasMenu(): boolean {
    return !!(this.cfg.onShare || this.cfg.onDelete);
  }

  private buildMenu(): Menu | null {
    const v = this.variants[this.activeIndex];
    if (!v) return null;
    const menu = new Menu();
    if (this.cfg.isFavorite && this.cfg.onToggleFavorite) {
      menu.addItem((mi) =>
        mi
          .setTitle(this.cfg.isFavorite!(v) ? "즐겨찾기 해제" : "즐겨찾기")
          .setIcon("star")
          .onClick(() => {
            const next = this.cfg.onToggleFavorite!(v.id);
            if (typeof next === "boolean") {
              this.favBtnEl?.toggleClass("is-favorited", next);
            }
          })
      );
    }
    if (this.cfg.onShare) {
      menu.addItem((mi) =>
        mi
          .setTitle("스텔라 네트워크에 공유")
          .setIcon("share-2")
          .onClick(() => this.cfg.onShare!(v))
      );
    }
    if (this.cfg.onDelete) {
      menu.addSeparator().addItem((mi) =>
        mi
          .setTitle("이 삽화 삭제")
          .setIcon("trash-2")
          .onClick(() => this.cfg.onDelete!(v.id))
      );
    }
    return menu;
  }

  /** active 슬라이드가 중앙에 오도록 트랙 이동 (트랙 폭 = viewport 폭, 100% = 한 칸). */
  private layout(): void {
    if (!this.trackEl) return;
    this.trackEl.style.transform = `translateX(${-this.activeIndex * 100}%)`;
  }

  /**
   * 로컬에서 즉시 슬라이드(애니메이션) 후 영속화를 요청한다. 영속화로 인한 전체
   * 재렌더는 호출자가 suppress 하므로, 여기서 부드럽게 넘긴 화면이 그대로 유지된다.
   */
  private step(d: number): void {
    if (this.variants.length < 2) return;
    this.activeIndex =
      (this.activeIndex + d + this.variants.length) % this.variants.length;
    this.layout();
    if (this.counterEl) {
      this.counterEl.setAttr(
        "data-count",
        `${this.activeIndex + 1} / ${this.variants.length}`
      );
    }
    if (this.favBtnEl && this.cfg.isFavorite) {
      this.favBtnEl.toggleClass(
        "is-favorited",
        this.cfg.isFavorite(this.variants[this.activeIndex])
      );
    }
    this.cfg.onSelect(this.variants[this.activeIndex].id);
  }
}
