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

/**
 * 그룹 멤버 관리 팝업 (G1) — 세션에 참여 중인 캐릭터 목록.
 * 체크 해제 = 내보내기. 주인공은 항상 체크·비활성. 저장은 호출부(onSubmit)가 담당.
 */
export class GroupMemberModal extends Modal {
  private kept: Set<string>;

  constructor(
    app: App,
    private sessionName: string,
    private rows: GroupMemberRow[],
    private onSubmit: (keptScenarioIds: string[]) => void | Promise<void>
  ) {
    super(app);
    // 시작 상태 = 전원 참여(체크됨).
    this.kept = new Set(rows.map((r) => r.scenarioId));
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
      void this.onSubmit(Array.from(this.kept));
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
