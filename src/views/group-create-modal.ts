import { App, Modal } from "obsidian";
import { renderThumb } from "../util/render-thumb";
import { createModalShell } from "./modal-shell";

/** 그룹 만들기 모달에 넘기는 한 줄 — 표시에 필요한 것만(모달은 store 접근 안 함). */
export interface GroupCreateRow {
  scenarioId: string;
  name: string;
  thumbnailPath: string | null;
  /** 이 캐릭터에 첫 대사(first_mes)가 있는가 — "멤버 첫 대사로 시작" 후보. */
  hasFirstMes: boolean;
}

/** 세션 시작 방식 3택. */
export type GroupOpening =
  | { kind: "member"; scenarioId: string }
  | { kind: "text"; text: string }
  | { kind: "empty" };

export interface GroupCreateResult {
  /** 체크된 멤버, 표시 순서. [0] = 주인공(호스트, 세션이 이 시나리오 밑에 생성). */
  memberScenarioIds: string[];
  groupName: string;
  opening: GroupOpening;
  /** 세션 종류 — 소설(이어쓰기) / 채팅(발화자 번갈아). */
  mode: "novel" | "chat";
}

/**
 * 홈 [그룹 만들기] 진입점 모달 (G1) — 시나리오 다중 선택 + 그룹 이름 + 시작 3택.
 * store 미접근(행 데이터만 받음). 생성은 호출부(onSubmit)가 담당.
 */
export class GroupCreateModal extends Modal {
  private checked = new Set<string>();
  private groupName = "";
  private nameEdited = false;
  private openingKind: "member" | "text" | "empty" = "member";
  private openingTouched = false;
  private openingMemberId = "";
  private openingText = "";
  private mode: "novel" | "chat" = "chat";

  // 실시간 갱신 핸들들.
  private hostBadgeByRow = new Map<string, HTMLElement>();
  private radioByKind = new Map<string, HTMLInputElement>();
  private nameInput!: HTMLInputElement;
  private memberSelect!: HTMLSelectElement;
  private memberRadioWrap!: HTMLElement;
  private textArea!: HTMLTextAreaElement;
  private createBtn!: HTMLButtonElement;

  constructor(
    private appRef: App,
    private rows: GroupCreateRow[],
    private onSubmit: (result: GroupCreateResult) => void | Promise<void>
  ) {
    super(appRef);
  }

  onOpen(): void {
    this.titleEl.setText("그룹 만들기");
    const { toolbar, body, footerMain } = createModalShell(this, "l", {
      toolbar: true,
    });
    toolbar!.createEl("p", {
      text: "함께 등장할 캐릭터를 2명 이상 고르세요. 맨 위 체크된 캐릭터가 주인공이 됩니다.",
    });

    // ── 캐릭터 선택 ──────────────────────────────
    const list = body.createDiv({ cls: "ggai-group-create-list" });
    for (const row of this.rows) {
      const label = list.createEl("label", { cls: "ggai-group-member-row" });
      const input = label.createEl("input", { type: "checkbox" });
      input.addEventListener("change", () => {
        if (input.checked) this.checked.add(row.scenarioId);
        else this.checked.delete(row.scenarioId);
        this.onSelectionChanged();
      });
      const thumb = label.createDiv({ cls: "ggai-group-member-thumb" });
      renderThumb(this.appRef, thumb, row.thumbnailPath, row.name, "user");
      const nameWrap = label.createDiv({ cls: "ggai-group-member-name" });
      nameWrap.createEl("span", { text: row.name });
      const badge = nameWrap.createEl("span", {
        cls: "ggai-group-member-badge",
        text: "주인공",
      });
      badge.hide();
      this.hostBadgeByRow.set(row.scenarioId, badge);
    }

    // ── 세션 종류 (소설 / 채팅) ──────────────────
    const modeField = body.createDiv({ cls: "ggai-group-create-field" });
    modeField.createEl("label", {
      cls: "ggai-group-create-label",
      text: "세션 종류",
    });
    const modeSeg = modeField.createDiv({ cls: "ggai-group-create-mode" });
    const mkMode = (value: "novel" | "chat", label: string, hint: string) => {
      const btn = modeSeg.createEl("button", {
        cls: "ggai-btn ggai-group-create-mode-btn",
      });
      btn.createDiv({ cls: "ggai-group-create-mode-title", text: label });
      btn.createDiv({ cls: "ggai-group-create-mode-hint", text: hint });
      btn.toggleClass("is-active", this.mode === value);
      btn.addEventListener("click", () => {
        this.mode = value;
        for (const el of Array.from(modeSeg.children)) {
          el.toggleClass("is-active", el === btn);
        }
      });
      return btn;
    };
    mkMode("chat", "채팅", "캐릭터들이 번갈아 대화");
    mkMode("novel", "소설", "한 흐름으로 이어쓰기");

    // ── 그룹 이름 ────────────────────────────────
    const nameField = body.createDiv({ cls: "ggai-group-create-field" });
    nameField.createEl("label", {
      cls: "ggai-group-create-label",
      text: "그룹 이름",
    });
    this.nameInput = nameField.createEl("input", {
      type: "text",
      cls: "ggai-group-create-input",
    });
    this.nameInput.placeholder = "예: 삼총사";
    this.nameInput.addEventListener("input", () => {
      this.nameEdited = true;
      this.groupName = this.nameInput.value;
      this.refreshCreateEnabled();
    });

    // ── 시작 방식 3택 ────────────────────────────
    const startField = body.createDiv({ cls: "ggai-group-create-field" });
    startField.createEl("label", {
      cls: "ggai-group-create-label",
      text: "시작 방식",
    });

    // (1) 멤버 첫 대사
    this.memberRadioWrap = this.makeRadioRow(
      startField,
      "member",
      "멤버의 첫 대사로 시작"
    );
    this.memberSelect = this.memberRadioWrap.createEl("select", {
      cls: "ggai-group-create-input",
    });
    this.memberSelect.addEventListener("change", () => {
      this.openingMemberId = this.memberSelect.value;
    });

    // (2) 직접 쓰기
    const textRow = this.makeRadioRow(
      startField,
      "text",
      "오프닝을 직접 쓰기"
    );
    this.textArea = textRow.createEl("textarea", {
      cls: "ggai-group-create-textarea",
    });
    this.textArea.placeholder = "첫 장면을 직접 적습니다.";
    this.textArea.rows = 4;
    this.textArea.addEventListener("input", () => {
      this.openingText = this.textArea.value;
      this.refreshCreateEnabled();
    });

    // (3) 빈 시작
    this.makeRadioRow(startField, "empty", "빈 시작 (내가 먼저 씀)");

    // ── 액션줄 ───────────────────────────────────
    const cancel = footerMain.createEl("button", {
      cls: "ggai-btn",
      text: "취소",
    });
    cancel.addEventListener("click", () => this.close());
    this.createBtn = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "만들기",
    });
    this.createBtn.addEventListener("click", () => {
      void this.submit();
    });

    this.selectOpening("member");
    this.onSelectionChanged();
  }

  /** 라디오 한 줄 + 그 아래 부속 컨트롤을 담을 컨테이너를 만든다. */
  private makeRadioRow(
    parent: HTMLElement,
    kind: "member" | "text" | "empty",
    text: string
  ): HTMLElement {
    const wrap = parent.createDiv({ cls: "ggai-group-create-opt" });
    const label = wrap.createEl("label", { cls: "ggai-group-create-radio" });
    const radio = label.createEl("input", { type: "radio" });
    radio.name = "ggai-group-opening";
    radio.value = kind;
    radio.addEventListener("change", () => {
      if (radio.checked) {
        this.openingTouched = true;
        this.selectOpening(kind);
      }
    });
    label.createEl("span", { text });
    // 부속 컨트롤(select/textarea)은 호출부가 wrap 에 이어 붙인다.
    this.radioByKind.set(kind, radio);
    return wrap;
  }

  private selectOpening(kind: "member" | "text" | "empty"): void {
    this.openingKind = kind;
    const radio = this.radioByKind.get(kind);
    if (radio) radio.checked = true;
    this.memberSelect.toggle(kind === "member");
    this.textArea.toggle(kind === "text");
    this.refreshCreateEnabled();
  }

  /** 체크 변화 → 주인공 뱃지, 기본 이름, 멤버 첫대사 후보, 만들기 활성 재계산. */
  private onSelectionChanged(): void {
    const chosen = this.rows.filter((r) => this.checked.has(r.scenarioId));

    // 주인공 뱃지 = 체크된 것 중 표시 순서 첫 번째.
    const hostId = chosen[0]?.scenarioId ?? null;
    for (const [id, badge] of this.hostBadgeByRow) {
      badge.toggle(id === hostId);
    }

    // 기본 그룹 이름 (사용자가 직접 안 고쳤을 때만).
    if (!this.nameEdited) {
      this.groupName = chosen.map((r) => r.name).join(", ");
      this.nameInput.value = this.groupName;
    }

    // 멤버 첫 대사 후보 = 체크됐고 first_mes 있는 멤버.
    const eligible = chosen.filter((r) => r.hasFirstMes);
    this.memberSelect.empty();
    for (const r of eligible) {
      const opt = this.memberSelect.createEl("option", {
        text: r.name,
        value: r.scenarioId,
      });
      if (r.scenarioId === this.openingMemberId) opt.selected = true;
    }
    if (!eligible.some((r) => r.scenarioId === this.openingMemberId)) {
      this.openingMemberId = eligible[0]?.scenarioId ?? "";
      this.memberSelect.value = this.openingMemberId;
    }
    // 후보가 없으면 "멤버 첫 대사" 옵션을 못 쓰게 한다.
    const memberRadio = this.radioByKind.get("member");
    if (memberRadio) memberRadio.disabled = eligible.length === 0;
    // 사용자가 아직 라디오를 직접 건드리지 않았으면 좋은 기본값을 고른다:
    // 첫 대사 가진 멤버가 있으면 그 방식, 없으면 빈 시작.
    if (!this.openingTouched) {
      this.selectOpening(eligible.length > 0 ? "member" : "empty");
    } else if (eligible.length === 0 && this.openingKind === "member") {
      this.selectOpening("empty");
    }

    this.refreshCreateEnabled();
  }

  private refreshCreateEnabled(): void {
    const enoughMembers = this.checked.size >= 2;
    const hasName = this.groupName.trim().length > 0;
    const openingOk =
      this.openingKind !== "text" || this.openingText.trim().length > 0;
    this.createBtn.disabled = !(enoughMembers && hasName && openingOk);
  }

  private async submit(): Promise<void> {
    const memberScenarioIds = this.rows
      .filter((r) => this.checked.has(r.scenarioId))
      .map((r) => r.scenarioId);
    if (memberScenarioIds.length < 2) return;

    let opening: GroupOpening;
    if (this.openingKind === "member" && this.openingMemberId) {
      opening = { kind: "member", scenarioId: this.openingMemberId };
    } else if (this.openingKind === "text") {
      opening = { kind: "text", text: this.openingText };
    } else {
      opening = { kind: "empty" };
    }

    await this.onSubmit({
      memberScenarioIds,
      groupName: this.groupName.trim(),
      opening,
      mode: this.mode,
    });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
