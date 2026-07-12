import { App, Modal } from "obsidian";
import { renderThumb } from "../util/render-thumb";
import { createModalShell } from "./modal-shell";

/** 멤버 관리 모달에 넘기는 한 줄 — 표시에 필요한 것만(모달은 store 접근 안 함). */
export interface GroupMemberRow {
  scenarioId: string;
  name: string;
  thumbnailPath: string | null;
  /** 세션 주인공 — 체크 해제(내보내기) 불가. */
  isHost: boolean;
}

/** 그룹 챗 대화 설정 — 자동 연쇄/중복 발화 상한 (채팅 그룹에서만 노출). */
export interface GroupChatSettings {
  /** 유저 발화 뒤 자동으로 이어지는 최대 AI 발화 수 (0 = 기본 = 멤버 수, 최대 3). */
  autoChainMax: number;
  /** 같은 캐릭터가 연속으로 말할 수 있는 최대 횟수 (1 = 매번 다른 캐릭터). */
  maxConsecutiveSpeaker: number;
}

export interface GroupMemberResult {
  keptScenarioIds: string[];
  /** 채팅 그룹일 때만 의미 (소설 그룹은 입력 UI 미노출, 값 불변). */
  settings: GroupChatSettings;
}

/**
 * 그룹 멤버 관리 팝업 (G1/G3) — 세션에 참여 중인 캐릭터 목록 + (채팅 그룹) 대화 설정.
 * 체크 해제 = 내보내기. 주인공은 항상 체크·비활성. 저장은 호출부(onSubmit)가 담당.
 */
export class GroupMemberModal extends Modal {
  private kept: Set<string>;
  private settings: GroupChatSettings;

  constructor(
    app: App,
    private sessionName: string,
    private rows: GroupMemberRow[],
    /** 채팅 그룹이면 대화 설정 섹션을 보여준다 (소설 그룹은 숨김). */
    private showChatSettings: boolean,
    initialSettings: GroupChatSettings,
    private onSubmit: (result: GroupMemberResult) => void | Promise<void>
  ) {
    super(app);
    // 시작 상태 = 전원 참여(체크됨).
    this.kept = new Set(rows.map((r) => r.scenarioId));
    this.settings = { ...initialSettings };
  }

  onOpen(): void {
    this.titleEl.setText("그룹 멤버 관리");
    const { toolbar, body, footerMain } = createModalShell(this, "l", {
      toolbar: true,
    });
    toolbar!.createEl("p", {
      text: `"${this.sessionName}" 세션에 참여 중인 캐릭터입니다. 체크를 해제하면 내보냅니다.`,
    });

    const list = body.createDiv({ cls: "ggai-group-member-list" });
    // 주인공을 맨 위로.
    const ordered = [...this.rows].sort(
      (a, b) => (b.isHost ? 1 : 0) - (a.isHost ? 1 : 0)
    );
    for (const row of ordered) {
      const label = list.createEl("label", { cls: "ggai-group-member-row" });
      const input = label.createEl("input", { type: "checkbox" });
      input.checked = true;
      if (row.isHost) input.disabled = true;
      input.addEventListener("change", () => {
        if (input.checked) this.kept.add(row.scenarioId);
        else this.kept.delete(row.scenarioId);
      });
      const thumb = label.createDiv({ cls: "ggai-group-member-thumb" });
      renderThumb(this.app, thumb, row.thumbnailPath, row.name, "user");
      const nameWrap = label.createDiv({ cls: "ggai-group-member-name" });
      nameWrap.createEl("span", { text: row.name });
      if (row.isHost) {
        nameWrap.createEl("span", {
          cls: "ggai-group-member-badge",
          text: "주인공",
        });
      }
    }

    if (this.showChatSettings) this.renderChatSettings(body);

    const cancel = footerMain.createEl("button", {
      cls: "ggai-btn",
      text: "취소",
    });
    cancel.addEventListener("click", () => this.close());
    const save = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "저장",
    });
    save.addEventListener("click", () => {
      void this.onSubmit({
        keptScenarioIds: Array.from(this.kept),
        settings: this.settings,
      });
      this.close();
    });
  }

  /** 채팅 그룹 대화 설정 — 자동 연쇄 상한 + 중복 발화 상한. */
  private renderChatSettings(body: HTMLElement): void {
    const wrap = body.createDiv({ cls: "ggai-group-settings" });
    wrap.createEl("div", {
      cls: "ggai-group-settings-title",
      text: "대화 설정",
    });

    const stepper = (
      title: string,
      hint: string,
      value: number,
      min: number,
      max: number,
      display: (v: number) => string,
      onChange: (v: number) => void
    ) => {
      const rowEl = wrap.createDiv({ cls: "ggai-group-settings-row" });
      const textWrap = rowEl.createDiv({ cls: "ggai-group-settings-text" });
      textWrap.createDiv({ cls: "ggai-group-settings-label", text: title });
      textWrap.createDiv({ cls: "ggai-group-settings-hint", text: hint });
      const ctl = rowEl.createDiv({ cls: "ggai-group-settings-stepper" });
      const minus = ctl.createEl("button", { cls: "ggai-btn", text: "−" });
      const valEl = ctl.createEl("span", {
        cls: "ggai-group-settings-value",
        text: display(value),
      });
      const plus = ctl.createEl("button", { cls: "ggai-btn", text: "+" });
      let cur = value;
      const sync = () => {
        valEl.setText(display(cur));
        minus.disabled = cur <= min;
        plus.disabled = cur >= max;
      };
      minus.addEventListener("click", () => {
        if (cur > min) {
          cur--;
          onChange(cur);
          sync();
        }
      });
      plus.addEventListener("click", () => {
        if (cur < max) {
          cur++;
          onChange(cur);
          sync();
        }
      });
      sync();
    };

    stepper(
      "한 번에 이어지는 발화 수",
      "내가 말한 뒤 캐릭터끼리 자동으로 주고받는 최대 횟수 (0 = 자동).",
      this.settings.autoChainMax,
      0,
      10,
      (v) => (v === 0 ? "자동" : `${v}회`),
      (v) => (this.settings.autoChainMax = v)
    );
    stepper(
      "같은 캐릭터 연속 발화 상한",
      "한 캐릭터가 연달아 말할 수 있는 최대 횟수 (1 = 매번 다른 캐릭터).",
      this.settings.maxConsecutiveSpeaker,
      1,
      5,
      (v) => `${v}회`,
      (v) => (this.settings.maxConsecutiveSpeaker = v)
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
