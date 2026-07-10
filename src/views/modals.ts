import { App, Modal, Setting } from "obsidian";
import type { SessionListItem } from "../util/scan-sessions";
import type { ScenarioListItem } from "../util/scan-scenarios";
import type { ParsedStChat } from "../import/parse-sillytavern-chat";
import type { SessionMode } from "../types/session";
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

/** 실리태번 채팅 임포트 등록 창의 결과. */
export interface StChatImportChoice {
  mode: SessionMode;
  /** 붙일 시나리오 파일. null = 캐릭터명으로 새 시나리오 생성. */
  scenarioFile: string | null;
}

/**
 * 실리태번 채팅(.jsonl) 임포트 등록 창.
 * 캐릭터/유저/메시지 요약을 보여주고 모드(채팅/소설)와 붙일 시나리오를 고른다.
 * 캐릭터명과 같은 이름의 시나리오가 있으면 자동 선택, 없으면 "새로 만들기".
 */
export class StChatImportModal extends Modal {
  private mode: SessionMode = "chat";
  private scenarioFile: string | null;
  private settled = false;

  constructor(
    app: App,
    private readonly parsed: ParsedStChat,
    private readonly scenarios: ScenarioListItem[],
    private readonly onSubmit: (choice: StChatImportChoice | null) => void
  ) {
    super(app);
    // 캐릭터명과 같은 이름 시나리오 자동 매칭.
    const target = parsed.characterName.trim().toLowerCase();
    const match = scenarios.find(
      (s) => scenarioName(s).trim().toLowerCase() === target
    );
    this.scenarioFile = match ? match.scenarioFile : null;
  }

  onOpen(): void {
    this.titleEl.setText("실리태번 채팅 가져오기");
    const { body, footerMain } = createModalShell(this, "m");

    const swipeTotal = this.parsed.messages.reduce(
      (n, m) => n + m.swipes.length,
      0
    );
    body.createEl("p", {
      cls: "ggai-st-chat-summary",
      text: `캐릭터 "${this.parsed.characterName}" · 유저 "${this.parsed.userName}" · 메시지 ${this.parsed.messages.length}개 (스와이프 포함 ${swipeTotal}개)`,
    });

    new Setting(body).setName("모드").addDropdown((d) => {
      d.addOption("chat", "채팅");
      d.addOption("novel", "소설");
      d.setValue(this.mode);
      d.onChange((v) => (this.mode = v === "novel" ? "novel" : "chat"));
    });

    new Setting(body)
      .setName("시나리오")
      .setDesc("이 대화를 붙일 시나리오. 캐릭터 카드는 채팅 파일에 없어 직접 골라야 합니다.")
      .addDropdown((d) => {
        d.addOption("__new__", `＋ "${this.parsed.characterName}" 새 시나리오`);
        for (const s of this.scenarios) {
          d.addOption(s.scenarioFile, scenarioName(s));
        }
        d.setValue(this.scenarioFile ?? "__new__");
        d.onChange((v) => {
          this.scenarioFile = v === "__new__" ? null : v;
        });
      });

    const cancel = footerMain.createEl("button", {
      cls: "ggai-btn",
      text: "취소",
    });
    cancel.addEventListener("click", () => this.settle(null));
    const go = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "가져오기",
    });
    go.addEventListener("click", () =>
      this.settle({ mode: this.mode, scenarioFile: this.scenarioFile })
    );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.onSubmit(null);
  }

  private settle(choice: StChatImportChoice | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onSubmit(choice);
    this.close();
  }
}

function scenarioName(s: ScenarioListItem): string {
  return s.scenario.data?.name || s.folderName;
}
