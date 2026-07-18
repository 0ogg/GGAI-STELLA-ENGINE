/**
 * IllustrationGalleryModal — 이 세션에서 생성된 삽화를 전부 그리드로 보여주는 팝업.
 *  - 썸네일 클릭 → 전체 화면 라이트박스
 *  - hover 시 "이동"(그 삽화의 원문 노드로) / "삭제"(그 삽화만) 버튼
 *  - 우클릭/롱프레스 → 즐겨찾기/이동/네트워크 게시/삭제 메뉴
 */

import { App, Menu, Modal, setIcon } from "obsidian";
import type StellaEnginePlugin from "../main";
import { openImageLightbox } from "./image-lightbox";
import { createModalShell, type ModalShellRegions } from "./modal-shell";
import { PressMenuController } from "../util/press-menu";

export interface GalleryItem {
  src: string;
  nodeId: string;
  variantId: string;
  createdAt: number;
  favorite?: boolean;
  /** vault 전체 경로 — 스텔라 네트워크 게시용 (없으면 게시 메뉴 미표시). */
  path?: string;
  /** 게시 시 이미지 캡션 (이미지 못 보는 모델용 정보). */
  caption?: string;
}

/** 삽화 생성 프롬프트 → 네트워크 게시 캡션 (첫 줄, 200자). */
export function illustrationCaption(prompt: string | undefined): string {
  return (prompt ?? "").split("\n")[0].trim().slice(0, 200);
}

/**
 * 갤러리 이미지를 스텔라 네트워크에 공유 (갤러리 3곳 공용) — 진짜 폰 공유처럼
 * 스텔라 폰의 SNS 작성창이 사진을 첨부한 채 열리고, 코멘트를 쓴 뒤 게시한다.
 */
export function shareGalleryImageToNetwork(
  plugin: StellaEnginePlugin,
  path: string,
  caption?: string
): void {
  void plugin.phone.shareImageToNetwork({ path, caption: caption ?? "" });
}

export interface GalleryModalOptions {
  items: GalleryItem[];
  /** 그 삽화의 원문 노드로 이동 (모달은 자동으로 닫힘). */
  onJump: (nodeId: string) => void;
  /** 그 삽화 variant 삭제. */
  onDelete: (nodeId: string, variantId: string) => Promise<void>;
  /** 즐겨찾기 토글 — 동기적으로 새 상태 반환. */
  onToggleFavorite: (nodeId: string, variantId: string) => boolean;
  /** 스텔라 네트워크(SNS)에 공유 — 폰 사용중일 때만 넘긴다 (메뉴 노출 게이트). */
  onShareToNetwork?: (item: GalleryItem) => void;
}

export class IllustrationGalleryModal extends Modal {
  private items: GalleryItem[];
  /** 정렬/필터를 적용해 현재 그려지는 목록 — 라이트박스·삭제 갱신의 기준. */
  private view: GalleryItem[] = [];
  private sortOrder: "new" | "old" = "new";
  private favOnly = false;
  private regions!: ModalShellRegions;
  private pressMenu = new PressMenuController();

  constructor(
    app: App,
    private opts: GalleryModalOptions
  ) {
    super(app);
    this.items = [...opts.items];
  }

  onOpen(): void {
    this.regions = createModalShell(this, "l", { wide: true });
    const closeBtn = this.regions.footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "닫기",
    });
    closeBtn.addEventListener("click", () => this.close());
    this.renderGrid();
  }

  /** 즐겨찾기 필터 + 정렬을 적용한 표시 목록을 만든다. */
  private computeView(): void {
    const base = this.favOnly
      ? this.items.filter((it) => it.favorite)
      : this.items.slice();
    base.sort((a, b) =>
      this.sortOrder === "new"
        ? b.createdAt - a.createdAt
        : a.createdAt - b.createdAt
    );
    this.view = base;
  }

  private renderGrid(): void {
    const c = this.regions.body;
    c.empty();
    this.computeView();
    this.titleEl.setText(`삽화 갤러리 (${this.view.length})`);

    if (this.items.length === 0) {
      c.createDiv({
        cls: "ggai-detail-empty",
        text: "이 세션에 생성된 삽화가 없습니다.",
      });
      return;
    }

    this.renderToolbar(c);

    if (this.view.length === 0) {
      c.createDiv({
        cls: "ggai-detail-empty",
        text: "즐겨찾기한 삽화가 없습니다.",
      });
      return;
    }

    const grid = c.createDiv({ cls: "ggai-gallery-grid" });
    this.view.forEach((item) => {
      const cell = grid.createDiv({ cls: "ggai-gallery-cell" });
      const img = cell.createEl("img", { cls: "ggai-gallery-thumb" });
      img.src = item.src;
      img.addEventListener("click", (e) => {
        if (this.pressMenu.consumeSuppressedClick(e)) return;
        const idx = this.view.findIndex(
          (it) => it.variantId === item.variantId
        );
        openImageLightbox(
          this.view.map((it) => ({ src: it.src })),
          Math.max(0, idx)
        );
      });

      const fav = cell.createEl("button", { cls: "ggai-gallery-fav" });
      setIcon(fav, "star");
      fav.toggleClass("is-favorited", !!item.favorite);
      fav.setAttr("aria-label", "즐겨찾기");
      fav.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleFavorite(item, fav);
      });

      const actions = cell.createDiv({ cls: "ggai-gallery-actions" });
      const jump = actions.createEl("button", { cls: "ggai-gallery-action" });
      setIcon(jump, "locate-fixed");
      jump.setAttr("aria-label", "이 삽화의 원문으로 이동");
      jump.addEventListener("click", (e) => {
        e.stopPropagation();
        this.opts.onJump(item.nodeId);
        this.close();
      });
      const del = actions.createEl("button", {
        cls: "ggai-gallery-action ggai-gallery-delete",
      });
      setIcon(del, "trash-2");
      del.setAttr("aria-label", "이 삽화 삭제");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.deleteItem(item, cell);
      });

      this.pressMenu.attachContextMenu(
        cell,
        (e) => this.buildItemMenu(item, cell, fav).showAtMouseEvent(e),
        (x, y) => this.buildItemMenu(item, cell, fav).showAtPosition({ x, y })
      );
    });
  }

  private toggleFavorite(item: GalleryItem, favBtn: HTMLElement): void {
    const next = this.opts.onToggleFavorite(item.nodeId, item.variantId);
    item.favorite = next;
    favBtn.toggleClass("is-favorited", next);
    // 즐겨찾기만 보기 중에 해제하면 목록에서 빠지므로 다시 그린다.
    if (this.favOnly && !next) this.renderGrid();
  }

  /** 삭제 실행 중 variant — 연타(모바일)·메뉴 중복 삭제 방지. */
  private deleting = new Set<string>();

  private async deleteItem(item: GalleryItem, cell: HTMLElement): Promise<void> {
    if (this.deleting.has(item.variantId)) return;
    this.deleting.add(item.variantId);
    try {
      await this.opts.onDelete(item.nodeId, item.variantId);
    } catch (err) {
      this.deleting.delete(item.variantId);
      return;
    }
    // 그리드를 통째로 다시 그리지 않고 해당 셀만 제거 (모바일 멈춤 방지).
    this.items = this.items.filter((it) => it.variantId !== item.variantId);
    this.view = this.view.filter((it) => it.variantId !== item.variantId);
    cell.remove();
    this.titleEl.setText(`삽화 갤러리 (${this.view.length})`);
    if (this.view.length === 0) this.renderGrid();
  }

  /** 셀 우클릭/롱프레스 메뉴 — hover 버튼과 같은 액션 + 네트워크 게시. */
  private buildItemMenu(
    item: GalleryItem,
    cell: HTMLElement,
    favBtn: HTMLElement
  ): Menu {
    const menu = new Menu()
      .addItem((mi) =>
        mi
          .setTitle(item.favorite ? "즐겨찾기 해제" : "즐겨찾기")
          .setIcon("star")
          .onClick(() => this.toggleFavorite(item, favBtn))
      )
      .addItem((mi) =>
        mi
          .setTitle("원문으로 이동")
          .setIcon("locate-fixed")
          .onClick(() => {
            this.opts.onJump(item.nodeId);
            this.close();
          })
      );
    if (this.opts.onShareToNetwork && item.path) {
      menu.addItem((mi) =>
        mi
          .setTitle("스텔라 네트워크에 공유")
          .setIcon("share-2")
          .onClick(() => {
            // 공유 = 폰(SNS 작성창)으로 넘어가는 것 — 갤러리는 닫는다.
            this.close();
            this.opts.onShareToNetwork!(item);
          })
      );
    }
    return menu.addSeparator().addItem((mi) =>
      mi
        .setTitle("삭제")
        .setIcon("trash-2")
        .onClick(() => void this.deleteItem(item, cell))
    );
  }

  /** 정렬(최신/오래된순)과 즐겨찾기만 보기 토글 줄. */
  private renderToolbar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "ggai-gallery-toolbar" });

    const favBtn = bar.createEl("button", { cls: "ggai-gallery-toolbtn" });
    setIcon(favBtn.createSpan(), "star");
    favBtn.createSpan({ text: "즐겨찾기만" });
    favBtn.toggleClass("is-active", this.favOnly);
    favBtn.addEventListener("click", () => {
      this.favOnly = !this.favOnly;
      this.renderGrid();
    });

    const sort = bar.createEl("select", {
      cls: "dropdown ggai-gallery-sort",
    });
    for (const opt of [
      { value: "new", label: "최신순" },
      { value: "old", label: "오래된순" },
    ]) {
      const el = sort.createEl("option", { text: opt.label, value: opt.value });
      if (opt.value === this.sortOrder) el.selected = true;
    }
    sort.addEventListener("change", () => {
      this.sortOrder = sort.value as "new" | "old";
      this.renderGrid();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
