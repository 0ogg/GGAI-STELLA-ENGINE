/**
 * 이미지 자르기 창 — 고른 이미지를 올리기 전에 원하는 부분만 남긴다.
 * 자유 크롭이 기본이고, 비율 버튼으로 고정할 수 있다. 편집기 표지가 쓴다.
 */
import { App, Modal, Notice } from "obsidian";
import { createModalShell } from "./modal-shell";

export interface CroppedImage {
  bytes: ArrayBuffer;
  ext: string;
}

/** 자연 좌표(원본 픽셀) 기준 crop 영역. */
interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const RATIOS: { label: string; value: number | null }[] = [
  { label: "자유", value: null },
  { label: "3:4", value: 3 / 4 },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "16:9", value: 16 / 9 },
];

const HANDLES = ["nw", "ne", "sw", "se"] as const;
type Handle = (typeof HANDLES)[number];
type DragMode = Handle | "move" | "new";

/**
 * 자르기 창을 띄우고 결과를 돌려준다. 취소하면 null.
 * `defaultRatio` 를 주면 그 비율 버튼이 눌린 채로 열린다.
 */
export function openImageCrop(
  app: App,
  file: File,
  defaultRatio: number | null = null
): Promise<CroppedImage | null> {
  return new Promise((resolve) => {
    new ImageCropModal(app, file, defaultRatio, resolve).open();
  });
}

class ImageCropModal extends Modal {
  private img = new Image();
  private url: string;
  private ratio: number | null;
  /** 표시 크기 ÷ 원본 크기. */
  private scale = 1;
  private rect: CropRect = { x: 0, y: 0, w: 0, h: 0 };
  private settled = false;

  private stageEl!: HTMLElement;
  private canvasEl!: HTMLElement;
  private rectEl!: HTMLElement;
  private sizeEl!: HTMLElement;
  private ratioBtns: { value: number | null; el: HTMLElement }[] = [];
  private observer: ResizeObserver | null = null;
  private drag: { mode: DragMode; anchorX: number; anchorY: number } | null =
    null;

  constructor(
    app: App,
    private file: File,
    defaultRatio: number | null,
    private resolve: (result: CroppedImage | null) => void
  ) {
    super(app);
    this.ratio = defaultRatio;
    this.url = URL.createObjectURL(file);
  }

  onOpen(): void {
    const shell = createModalShell(this, "l", { toolbar: true, wide: true });
    this.titleEl.setText("이미지 자르기");

    const row = shell.toolbar!.createDiv({ cls: "ggai-modal-toolbar-row" });
    for (const r of RATIOS) {
      const btn = row.createEl("button", {
        cls: "ggai-crop-ratio-btn",
        text: r.label,
      });
      btn.addEventListener("click", () => this.setRatio(r.value));
      this.ratioBtns.push({ value: r.value, el: btn });
    }
    this.sizeEl = row.createDiv({ cls: "ggai-crop-size" });

    this.stageEl = shell.body.createDiv({ cls: "ggai-crop-stage" });
    this.canvasEl = this.stageEl.createDiv({ cls: "ggai-crop-canvas" });
    this.rectEl = this.canvasEl.createDiv({ cls: "ggai-crop-rect" });
    for (const h of HANDLES) {
      this.rectEl.createDiv({
        cls: `ggai-crop-handle is-${h}`,
        attr: { "data-handle": h },
      });
    }

    const original = shell.footerAux.createEl("button", { text: "원본 그대로" });
    original.addEventListener("click", () => void this.useOriginal());
    const cancel = shell.footerMain.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const done = shell.footerMain.createEl("button", {
      cls: "mod-cta",
      text: "완료",
    });
    done.addEventListener("click", () => void this.commit());

    this.canvasEl.addEventListener("pointerdown", (e) => this.onPointerDown(e));

    this.img.addEventListener("load", () => {
      this.canvasEl.prepend(this.img);
      this.layout();
      this.setRatio(this.ratio);
      this.observer = new ResizeObserver(() => this.layout());
      this.observer.observe(this.stageEl);
    });
    this.img.addEventListener("error", () => {
      new Notice("이미지를 열 수 없습니다.");
      this.close();
    });
    this.img.alt = "";
    this.img.src = this.url;
  }

  onClose(): void {
    this.observer?.disconnect();
    URL.revokeObjectURL(this.url);
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(null);
    }
  }

  // ─── 배치 ───────────────────────────────────────────

  /** 창 크기에 맞춰 이미지 표시 배율을 다시 잡는다 (원본보다 키우지는 않는다). */
  private layout(): void {
    const boxW = this.stageEl.clientWidth;
    const boxH = this.stageEl.clientHeight;
    const natW = this.img.naturalWidth;
    const natH = this.img.naturalHeight;
    if (!boxW || !boxH || !natW || !natH) return;
    this.scale = Math.min(boxW / natW, boxH / natH, 1);
    this.canvasEl.style.width = `${natW * this.scale}px`;
    this.canvasEl.style.height = `${natH * this.scale}px`;
    this.paint();
  }

  private paint(): void {
    const s = this.scale;
    this.rectEl.style.left = `${this.rect.x * s}px`;
    this.rectEl.style.top = `${this.rect.y * s}px`;
    this.rectEl.style.width = `${this.rect.w * s}px`;
    this.rectEl.style.height = `${this.rect.h * s}px`;
    this.sizeEl.setText(
      `${Math.round(this.rect.w)} × ${Math.round(this.rect.h)}`
    );
  }

  private setRatio(value: number | null): void {
    this.ratio = value;
    for (const b of this.ratioBtns) b.el.toggleClass("is-active", b.value === value);
    this.rect = this.largestRect(value);
    this.paint();
  }

  /** 이미지 안에 들어가는 최대 크기 영역을 가운데에. */
  private largestRect(ratio: number | null): CropRect {
    const natW = this.img.naturalWidth;
    const natH = this.img.naturalHeight;
    if (ratio === null) return { x: 0, y: 0, w: natW, h: natH };
    let w = natW;
    let h = w / ratio;
    if (h > natH) {
      h = natH;
      w = h * ratio;
    }
    return { x: (natW - w) / 2, y: (natH - h) / 2, w, h };
  }

  // ─── 드래그 ─────────────────────────────────────────

  private onPointerDown(e: PointerEvent): void {
    const target = e.target as HTMLElement;
    const handle = target.dataset.handle as Handle | undefined;
    const p = this.toNatural(e);
    let mode: DragMode;
    let anchorX: number;
    let anchorY: number;
    if (handle) {
      // 반대쪽 모서리를 고정점으로 잡는다.
      mode = handle;
      anchorX = handle === "nw" || handle === "sw" ? this.rect.x + this.rect.w : this.rect.x;
      anchorY = handle === "nw" || handle === "ne" ? this.rect.y + this.rect.h : this.rect.y;
    } else if (target === this.rectEl) {
      mode = "move";
      anchorX = p.x - this.rect.x;
      anchorY = p.y - this.rect.y;
    } else {
      mode = "new";
      anchorX = p.x;
      anchorY = p.y;
    }
    this.drag = { mode, anchorX, anchorY };
    this.canvasEl.setPointerCapture(e.pointerId);
    e.preventDefault();

    const onMove = (ev: PointerEvent) => this.onPointerMove(ev);
    const onUp = (ev: PointerEvent) => {
      this.drag = null;
      this.canvasEl.releasePointerCapture(ev.pointerId);
      this.canvasEl.removeEventListener("pointermove", onMove);
      this.canvasEl.removeEventListener("pointerup", onUp);
      this.canvasEl.removeEventListener("pointercancel", onUp);
    };
    this.canvasEl.addEventListener("pointermove", onMove);
    this.canvasEl.addEventListener("pointerup", onUp);
    this.canvasEl.addEventListener("pointercancel", onUp);
    if (mode === "new") this.onPointerMove(e);
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const p = this.toNatural(e);
    if (drag.mode === "move") {
      const natW = this.img.naturalWidth;
      const natH = this.img.naturalHeight;
      this.rect.x = clamp(p.x - drag.anchorX, 0, natW - this.rect.w);
      this.rect.y = clamp(p.y - drag.anchorY, 0, natH - this.rect.h);
    } else {
      this.rect = this.rectFromAnchor(drag.anchorX, drag.anchorY, p.x, p.y);
    }
    this.paint();
  }

  /** 고정점 → 커서 방향으로 영역을 만든다. 비율 고정이면 비율을 맞춰 줄인다. */
  private rectFromAnchor(ax: number, ay: number, px: number, py: number): CropRect {
    const natW = this.img.naturalWidth;
    const natH = this.img.naturalHeight;
    const min = Math.max(8, 20 / this.scale);
    const signX = px >= ax ? 1 : -1;
    const signY = py >= ay ? 1 : -1;
    const maxW = signX > 0 ? natW - ax : ax;
    const maxH = signY > 0 ? natH - ay : ay;
    let w = Math.min(Math.abs(px - ax), maxW);
    let h = Math.min(Math.abs(py - ay), maxH);
    if (this.ratio !== null) {
      // 커서가 더 많이 움직인 축을 기준으로 잡고, 경계를 넘으면 다시 줄인다.
      w = Math.max(w, h * this.ratio);
      h = w / this.ratio;
      if (w > maxW) {
        w = maxW;
        h = w / this.ratio;
      }
      if (h > maxH) {
        h = maxH;
        w = h * this.ratio;
      }
      if (w < min || h < min) {
        w = Math.max(min, min * this.ratio);
        h = w / this.ratio;
      }
    } else {
      w = Math.max(w, Math.min(min, maxW));
      h = Math.max(h, Math.min(min, maxH));
    }
    return {
      x: signX > 0 ? ax : ax - w,
      y: signY > 0 ? ay : ay - h,
      w,
      h,
    };
  }

  private toNatural(e: PointerEvent): { x: number; y: number } {
    const box = this.canvasEl.getBoundingClientRect();
    return {
      x: clamp((e.clientX - box.left) / this.scale, 0, this.img.naturalWidth),
      y: clamp((e.clientY - box.top) / this.scale, 0, this.img.naturalHeight),
    };
  }

  // ─── 결과 ───────────────────────────────────────────

  private async useOriginal(): Promise<void> {
    this.settle({ bytes: await this.file.arrayBuffer(), ext: imageExt(this.file) });
  }

  private async commit(): Promise<void> {
    const w = Math.max(1, Math.round(this.rect.w));
    const h = Math.max(1, Math.round(this.rect.h));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      new Notice("이미지를 자를 수 없습니다.");
      return;
    }
    ctx.drawImage(
      this.img,
      Math.round(this.rect.x),
      Math.round(this.rect.y),
      w,
      h,
      0,
      0,
      w,
      h
    );
    const mime = outputMime(this.file.type);
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, mime, 0.92)
    );
    if (!blob) {
      new Notice("이미지를 자를 수 없습니다.");
      return;
    }
    this.settle({ bytes: await blob.arrayBuffer(), ext: extFromMime(mime) });
  }

  private settle(result: CroppedImage): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(result);
    this.close();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** 캔버스가 그대로 다시 뽑을 수 있는 형식만 유지하고, 나머지는 png. */
function outputMime(type: string): string {
  if (type === "image/jpeg" || type === "image/webp") return type;
  return "image/png";
}

function extFromMime(mime: string): string {
  return mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
}

export function imageExt(file: File): string {
  const byType = file.type.split("/")[1];
  const byName = file.name.split(".").pop();
  return (byType || byName || "png").replace("jpeg", "jpg");
}
