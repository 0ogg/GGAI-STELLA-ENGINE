/**
 * IllustrationRegenModal — 삽화 재생성 UI.
 *
 * 현재 active 삽화의 프롬프트/UC 를 보여주고(여기서만 노출), 사용자가 수동으로 다듬은 뒤
 * 재생성을 요청한다. 결과는 이 노드의 새 삽화 variant 로 등록된다.
 */

import { App, Modal, Notice } from "obsidian";
import { createModalShell } from "./modal-shell";

export interface IllustrationRegenModalOptions {
  prompt: string;
  negativePrompt: string;
  onSubmit: (prompt: string, negativePrompt: string) => void;
}

export class IllustrationRegenModal extends Modal {
  constructor(
    app: App,
    private opts: IllustrationRegenModalOptions
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("삽화 재생성");
    const { body, footerMain } = createModalShell(this, "m");
    body.addClass("ggai-modal-body-col");

    const promptField = body.createDiv({ cls: "ggai-media-modal-field ggai-modal-grow" });
    promptField.createDiv({ cls: "ggai-media-label", text: "프롬프트" });
    const promptTa = promptField.createEl("textarea", { cls: "ggai-regen-textarea" });
    promptTa.value = this.opts.prompt;

    const ucField = body.createDiv({ cls: "ggai-media-modal-field" });
    ucField.createDiv({ cls: "ggai-media-label", text: "UC (네거티브)" });
    const ucTa = ucField.createEl("textarea", { cls: "ggai-regen-textarea" });
    ucTa.value = this.opts.negativePrompt;
    ucTa.rows = 3;

    const cancel = footerMain.createEl("button", { cls: "ggai-btn", text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const go = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "재생성",
    });
    go.addEventListener("click", () => {
      const prompt = promptTa.value.trim();
      if (!prompt) {
        new Notice("프롬프트를 입력하세요.");
        return;
      }
      this.opts.onSubmit(prompt, ucTa.value.trim());
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
