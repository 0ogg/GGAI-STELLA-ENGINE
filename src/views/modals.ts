import { App, Modal, Setting } from "obsidian";
import type { SessionListItem } from "../util/scan-sessions";
import { createModalShell } from "./modal-shell";

/**
 * 간단한 텍스트 입력 모달.
 * Enter 또는 확인 → resolve(value). Esc 또는 취소 → resolve(null).
 */
export class PromptModal extends Modal {
  private value = "";
  private settled = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly placeholder: string,
    private readonly initial: string,
    private readonly onResult: (value: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.title);
    this.value = this.initial;

    const input = contentEl.createEl("input", { type: "text" });
    input.value = this.initial;
    input.placeholder = this.placeholder;
    input.style.width = "100%";
    input.addEventListener("input", () => {
      this.value = input.value;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.settle(this.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.settle(null);
      }
    });

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("취소").onClick(() => this.settle(null))
      )
      .addButton((b) =>
        b
          .setButtonText("확인")
          .setCta()
          .onClick(() => this.settle(this.value))
      );

    setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.onResult(null);
  }

  private settle(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onResult(value);
    this.close();
  }
}

/**
 * 선택 모달 — 취소 외에 여러 동작 버튼 중 하나를 고른다.
 * 버튼 클릭 → resolve(value), 취소/닫기 → resolve(null).
 */
export interface ChoiceModalButton {
  text: string;
  value: string;
  cta?: boolean;
  warning?: boolean;
}

export class ChoiceModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly buttons: ChoiceModalButton[],
    private readonly onResult: (value: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.message });

    const setting = new Setting(this.contentEl);
    setting.addButton((b) =>
      b.setButtonText("취소").onClick(() => this.settle(null))
    );
    for (const btn of this.buttons) {
      setting.addButton((b) => {
        b.setButtonText(btn.text).onClick(() => this.settle(btn.value));
        if (btn.cta) b.setCta();
        if (btn.warning) b.setWarning();
        return b;
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.onResult(null);
  }

  private settle(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onResult(value);
    this.close();
  }
}

/**
 * 확인 모달. 확인 → resolve(true), 취소/닫기 → resolve(false).
 */
export class ConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly onResult: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.message });

    new Setting(this.contentEl)
      .addButton((b) =>
        b.setButtonText("취소").onClick(() => this.settle(false))
      )
      .addButton((b) =>
        b
          .setButtonText(this.confirmText)
          .setWarning()
          .onClick(() => this.settle(true))
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.onResult(false);
  }

  private settle(v: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.onResult(v);
    this.close();
  }
}

/**
 * 시나리오 복사 시 포함할 세션을 고르는 모달.
 */
export class ScenarioSessionCopyModal extends Modal {
  private selected = new Set<string>();

  constructor(
    app: App,
    private scenarioName: string,
    private sessions: SessionListItem[],
    private onSubmit: (sessionFiles: string[]) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("시나리오 복사");
    const { toolbar, body, footerMain } = createModalShell(this, "l", {
      toolbar: true,
    });
    toolbar!.createEl("p", {
      text: `"${this.scenarioName}" 복사본에 포함할 세션을 선택하세요.`,
    });
    const list = body.createDiv({ cls: "ggai-copy-session-list" });
    if (this.sessions.length === 0) {
      list.createEl("div", {
        cls: "ggai-session-empty",
        text: "복사할 세션이 없습니다. 시나리오만 복사됩니다.",
      });
    }
    for (const session of this.sessions) {
      const label = list.createEl("label", { cls: "ggai-copy-session-row" });
      const input = label.createEl("input", { type: "checkbox" });
      input.addEventListener("change", () => {
        if (input.checked) this.selected.add(session.sessionFile);
        else this.selected.delete(session.sessionFile);
      });
      label.createEl("span", {
        text: session.session.meta.name || session.folderName,
      });
    }

    const cancel = footerMain.createEl("button", {
      cls: "ggai-btn",
      text: "취소",
    });
    cancel.addEventListener("click", () => this.close());
    const copy = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "복제",
    });
    copy.addEventListener("click", () => {
      void this.onSubmit(Array.from(this.selected));
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
