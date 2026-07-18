import { App, Modal } from "obsidian";
import type { RegexScript } from "../types/regex";
import { REGEX_PLACEMENT, timingFlags, timingOf, type RegexApplyTiming } from "../types/regex";
import { regexFromString, runRegexScript } from "../util/regex-engine";
import { createModalShell } from "./modal-shell";

/**
 * 정규식 스크립트 편집 모달 — 이름/찾을 정규식/바꿀 내용/대상/적용 시점 + 테스트
 * 미리보기. store 미접근(스크립트 객체만 받음). 저장은 호출부(onSubmit)가 담당.
 *
 * UI 미노출 필드(trimStrings/runOnEdit/substituteRegex/minDepth/maxDepth 및 노출
 * 안 한 placement 값)는 원본 그대로 보존한다 — ST 임포트 스크립트 라운드트립.
 */
export class RegexEditModal extends Modal {
  private draft: RegexScript;
  private timing: RegexApplyTiming;

  private findInput!: HTMLInputElement;
  private findError!: HTMLElement;
  private testInput!: HTMLTextAreaElement;
  private testOutput!: HTMLElement;

  constructor(
    appRef: App,
    script: RegexScript,
    private onSubmit: (script: RegexScript) => void | Promise<void>,
    /**
     * "post" = 확장 결과물 후가공 스크립트 — 받자마자 무조건 적용이라
     * 대상(placement)/적용 시점(timing) 필드를 숨긴다. 기본 "full".
     */
    private mode: "full" | "post" = "full"
  ) {
    super(appRef);
    // 원본 불변 — placement 배열까지 복사해 취소 시 흔적이 남지 않게 한다.
    this.draft = { ...script, placement: [...script.placement], trimStrings: [...script.trimStrings] };
    this.timing = timingOf(script);
  }

  onOpen(): void {
    this.titleEl.setText(this.draft.scriptName ? "정규식 편집" : "정규식 추가");
    const { body, footerMain } = createModalShell(this, "m");

    // ── 이름 ──
    const nameField = body.createDiv({ cls: "ggai-regex-field" });
    nameField.createEl("label", { cls: "ggai-regex-label", text: "이름" });
    const nameInput = nameField.createEl("input", {
      type: "text",
      cls: "ggai-regex-input",
    });
    nameInput.value = this.draft.scriptName;
    nameInput.placeholder = "예: 별표 지우기";
    nameInput.addEventListener("input", () => {
      this.draft.scriptName = nameInput.value;
    });

    // ── 찾을 정규식 ──
    const findField = body.createDiv({ cls: "ggai-regex-field" });
    findField.createEl("label", { cls: "ggai-regex-label", text: "찾을 정규식" });
    this.findInput = findField.createEl("input", {
      type: "text",
      cls: "ggai-regex-input ggai-regex-mono",
    });
    this.findInput.value = this.draft.findRegex;
    this.findInput.placeholder = "예: /\\*+/g — 끝의 g 가 있어야 전부 바꿈";
    this.findInput.addEventListener("input", () => {
      this.draft.findRegex = this.findInput.value;
      this.syncValidity();
      this.syncTest();
    });
    this.findError = findField.createDiv({ cls: "ggai-regex-error" });

    // ── 바꿀 내용 ──
    const replaceField = body.createDiv({ cls: "ggai-regex-field" });
    replaceField.createEl("label", { cls: "ggai-regex-label", text: "바꿀 내용" });
    const replaceTa = replaceField.createEl("textarea", {
      cls: "ggai-regex-textarea ggai-regex-mono",
    });
    replaceTa.rows = 3;
    replaceTa.value = this.draft.replaceString;
    replaceTa.placeholder =
      "비우면 지움. $1, $2, {{match}} 사용 가능 · 줄바꿈은 \\n 이 아니라 Enter 로";
    replaceTa.addEventListener("input", () => {
      this.draft.replaceString = replaceTa.value;
      this.syncTest();
    });

    // ── 대상/적용 시점 — 후가공 모드에서는 숨김(받자마자 무조건 적용) ──
    if (this.mode === "full") {
      const targetField = body.createDiv({ cls: "ggai-regex-field" });
      targetField.createEl("label", { cls: "ggai-regex-label", text: "대상" });
      const targetWrap = targetField.createDiv({ cls: "ggai-regex-checks" });
      const mkTarget = (value: number, label: string) => {
        const row = targetWrap.createEl("label", { cls: "ggai-regex-check" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = this.draft.placement.includes(value);
        cb.addEventListener("change", () => {
          // 노출 안 한 placement 값(월드인포 등 임포트 보존분)은 건드리지 않는다.
          const rest = this.draft.placement.filter((p) => p !== value);
          this.draft.placement = cb.checked ? [...rest, value] : rest;
        });
        row.createEl("span", { text: label });
      };
      mkTarget(REGEX_PLACEMENT.AI_OUTPUT, "AI 응답");
      mkTarget(REGEX_PLACEMENT.USER_INPUT, "내 입력");

      const timingField = body.createDiv({ cls: "ggai-regex-field" });
      timingField.createEl("label", { cls: "ggai-regex-label", text: "적용 시점" });
      const timingSeg = timingField.createDiv({ cls: "ggai-regex-timing" });
      const timingBtns = new Map<RegexApplyTiming, HTMLButtonElement>();
      const mkTiming = (value: RegexApplyTiming, label: string, hint: string) => {
        const btn = timingSeg.createEl("button", { cls: "ggai-btn ggai-regex-timing-btn" });
        btn.createDiv({ cls: "ggai-regex-timing-title", text: label });
        btn.createDiv({ cls: "ggai-regex-timing-hint", text: hint });
        btn.addEventListener("click", () => {
          this.timing = value;
          for (const [k, b] of timingBtns) b.toggleClass("is-active", k === value);
        });
        timingBtns.set(value, btn);
      };
      mkTiming("prompt", "전송본", "AI에게 보낼 때만 바꿈 · 저장된 글은 그대로");
      mkTiming("raw", "저장 원문", "받은 응답 자체를 바꿔서 저장");
      mkTiming("display", "표시", "화면에 보일 때만 바꿈 · 채팅 세션 전용");
      for (const [k, b] of timingBtns) b.toggleClass("is-active", k === this.timing);
    }

    // ── 사용 안 함 ──
    const disabledRow = body.createEl("label", { cls: "ggai-regex-check" });
    const disabledCb = disabledRow.createEl("input", { type: "checkbox" });
    disabledCb.checked = this.draft.disabled;
    disabledCb.addEventListener("change", () => {
      this.draft.disabled = disabledCb.checked;
    });
    disabledRow.createEl("span", { text: "잠시 끄기" });

    // ── 테스트 ──
    const testField = body.createDiv({ cls: "ggai-regex-field" });
    testField.createEl("label", { cls: "ggai-regex-label", text: "테스트" });
    this.testInput = testField.createEl("textarea", {
      cls: "ggai-regex-textarea",
    });
    this.testInput.rows = 3;
    this.testInput.placeholder = "여기에 예시 문장을 넣으면 바뀐 결과를 바로 보여줍니다.";
    this.testInput.addEventListener("input", () => this.syncTest());
    this.testOutput = testField.createDiv({ cls: "ggai-regex-test-output" });

    // ── 액션줄 ──
    const cancel = footerMain.createEl("button", { cls: "ggai-btn", text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const save = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "저장",
    });
    save.addEventListener("click", () => {
      void this.submit();
    });

    this.syncValidity();
  }

  private syncValidity(): void {
    const find = this.draft.findRegex;
    const invalid = !!find && regexFromString(find) === null;
    this.findError.setText(invalid ? "정규식이 올바르지 않습니다." : "");
    this.findInput.toggleClass("is-invalid", invalid);
  }

  /** 테스트 입력에 현재 초안 스크립트를 그대로 돌려 결과를 보여준다 (시점/대상 무시). */
  private syncTest(): void {
    const input = this.testInput.value;
    if (!input) {
      this.testOutput.setText("");
      return;
    }
    const probe: RegexScript = { ...this.draft, disabled: false };
    this.testOutput.setText(runRegexScript(probe, input));
  }

  private async submit(): Promise<void> {
    const result: RegexScript = {
      ...this.draft,
      scriptName: this.draft.scriptName.trim() || "이름 없는 정규식",
      ...timingFlags(this.timing),
    };
    await this.onSubmit(result);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
