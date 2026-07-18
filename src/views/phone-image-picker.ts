/**
 * 폰 이미지 피커 (PH5) — SNS 게시 사진 첨부용. 폰 갤러리 + 전 세션 삽화를
 * 한 그리드에서 고르거나 새 파일을 업로드한다.
 */
import { Modal, Notice } from "obsidian";
import type StellaEnginePlugin from "../main";
import {
  collectAllGalleryImages,
  type AnyGalleryImage,
} from "../util/phone-gallery";
import { parseGeneratedImageMeta } from "../util/image-meta";

export interface PickedPhoneImage {
  /** vault 전체 경로. */
  path: string;
  /** 새로 업로드한 파일인지 (게시 시 폰 갤러리에 등록). */
  isNewUpload: boolean;
  /** 갤러리 캡션/라벨 — 이미지 못 보는 모델에게 정보를 주는 텍스트 (없으면 ""). */
  caption: string;
}

export class PhoneImagePickerModal extends Modal {
  constructor(
    private plugin: StellaEnginePlugin,
    private onPick: (image: PickedPhoneImage) => void
  ) {
    super(plugin.app);
    // 회귀금지.md — 세션 파생 모달은 닫힐 때 이전 선택영역 복원 금지.
    (this as unknown as { shouldRestoreSelection?: boolean }).shouldRestoreSelection =
      false;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ggai-phone-picker");
    contentEl.createEl("h3", { text: "사진 첨부" });

    // 새 파일 업로드.
    const fileInput = contentEl.createEl("input", { type: "file" });
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    const uploadBtn = contentEl.createEl("button", {
      cls: "ggai-phone-sns-post-btn",
      text: "새 이미지 업로드…",
    });
    uploadBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const bytes = await file.arrayBuffer();
        const path = await this.plugin.phone.saveIncomingImage(bytes, file.name);
        // 이미지 이해 파이프라인 (v2 §5 출처 C) — AI 생성 이미지(NAI/A1111/
        // ComfyUI)면 PNG 메타의 생성 프롬프트를 캡션으로 재활용한다. 아니면
        // 파일명 폴백 (비전 모델 연동 전까지의 D 폴백).
        const meta = parseGeneratedImageMeta(new Uint8Array(bytes));
        this.onPick({
          path,
          isNewUpload: true,
          caption: meta?.description ?? file.name.replace(/\.[^.]+$/, ""),
        });
        this.close();
      } catch (err) {
        new Notice(
          `업로드 실패: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    const gridHost = contentEl.createDiv({ cls: "ggai-phone-picker-grid" });
    gridHost.createDiv({ cls: "ggai-phone-empty", text: "이미지 불러오는 중…" });
    void this.loadGrid(gridHost);
  }

  private async loadGrid(host: HTMLElement): Promise<void> {
    const images = await collectAllGalleryImages(
      this.plugin.store,
      this.app.vault
    ).catch((): AnyGalleryImage[] => []);
    host.empty();
    if (images.length === 0) {
      host.createDiv({
        cls: "ggai-phone-empty",
        text: "아직 이미지가 없습니다. 카메라로 찍거나 업로드해 보세요.",
      });
      return;
    }
    for (const item of images.slice(0, 120)) {
      const cell = host.createDiv({ cls: "ggai-phone-picker-cell" });
      const img = cell.createEl("img");
      img.src = this.app.vault.adapter.getResourcePath(item.path);
      img.loading = "lazy";
      cell.createDiv({ cls: "ggai-phone-picker-label", text: item.label });
      cell.addEventListener("click", () => {
        this.onPick({
          path: item.path,
          isNewUpload: false,
          caption: item.caption || item.label,
        });
        this.close();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
