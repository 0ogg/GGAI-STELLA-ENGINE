/**
 * ParagraphRegenModal — 문단 재생성 패널 (AI 보조 문단 편집기).
 *
 * 문단 선택 모드에서 문단을 클릭하면 열린다.
 *  - 위/아래 화살표로 윗문단을 더 포함할지 범위 선택 (드래그가 불편한 모바일/노트북 배려).
 *  - 저장 프롬프트 선택/추가/편집 (우측 사이드바 프롬프트 선택과 같은 방식) + 직접 입력.
 *  - **편집 영역 하나**가 원문으로 시작한다: [재생성]하면 AI 결과로 교체되고, 손으로도
 *    고칠 수 있다 (원문 미리보기와 결과 칸을 합쳐 공간을 아낀다). [적용] 시에만 본문의
 *    해당 구간을 교체한다 (user-edit 노드 파생 — session-view 담당).
 *  - **source = 항상 편집 영역의 현재 값**. 사용자가 직접 고쳤거나, 직전 AI 결과 커서
 *    위치의 텍스트가 AI 재생성의 입력이 된다. 단계(history) 스택으로 재생성/수정
 *    시도를 여러 개 쌓고 ◀/▶ 또는 "초안으로"로 되돌릴 수 있다. 중간 단계에서 새로
 *    재생성하면 cursor 뒤의 단계는 버려진다(선형 스택).
 *  - [재번역]도 같은 원칙 — 클릭 즉시 반영하지 않고 편집 영역에 미리보기만 띄운다.
 *    [적용]을 눌러야 translations.json 에 실제로 반영된다(읽기 전용 미리보기라 손으로
 *    고칠 수는 없음). 번역 미리보기 중에는 단계 UI가 숨겨지고 재생성은 비활성화된다.
 *  - 창은 고정 높이 — 문단 길이나 범위 변경으로 창이 커지거나 줄어들지 않는다.
 */

import { Menu, Modal, Notice, setIcon } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { MediaPromptItem } from "../types/preset";
import {
  getDefaultPrompts,
  isBuiltinMediaPrompt,
} from "../util/default-media-prompts";
import {
  listParagraphRanges,
  type ParagraphRangeInfo,
} from "../util/paragraph-regen";
import { attachLongPress } from "../util/long-press";
import { uuidv4 } from "../util/uuid";
import { PromptEditModal, getBucketIoInstructions } from "./detail/media-prompt-panel";
import { createModalShell } from "./modal-shell";

const BUCKET = "paragraphRegen" as const;

/** 단계 종류 — 초안(원본) / AI 재생성 결과. 사용자 직접 수정은 dirty 플래그로 표시. */
type StepKind = "original" | "ai";

interface Step {
  kind: StepKind;
  text: string;
  /** 이 단계가 사용자에 의해 직접 수정됐는지 (AI 결과를 고쳤거나 초안을 고친 경우). */
  dirty: boolean;
}

export interface ParagraphRegenModalOptions {
  sessionFile: string;
  /** 열던 시점의 baseline 본문 — 범위/미리보기/적용 검증 기준. */
  baselineText: string;
  /** 클릭한 문단 인덱스 (범위의 마지막 문단으로 고정, 위로만 확장). */
  anchorIndex: number;
  /** 적용 — 성공 시 true (모달이 닫힌다). */
  onApply: (
    from: number,
    to: number,
    expected: string,
    text: string
  ) => Promise<boolean>;
  /** 번역 사용 중이면 재번역 버튼 노출. */
  translationEnabled?: boolean;
  /**
   * 선택 범위 문단들 재번역 — **아직 반영하지 않는다.** 미리보기 텍스트와, 사용자가
   * [적용]을 눌렀을 때만 실제로 translations.json 에 반영하는 commit 콜백을 돌려준다.
   * 실패/무반영이면 null (모달은 닫히지 않는다).
   */
  onRetranslate?: (
    from: number,
    to: number,
    hashes: string[]
  ) => Promise<{ previewText: string; commit: () => Promise<boolean> } | null>;
}

export class ParagraphRegenModal extends Modal {
  private ranges: ParagraphRangeInfo[];
  private startIndex: number;
  private busy = false;
  /**
   * 재생성/수정 시도 단계 스택(선형). history[0] 는 항상 초안(선택 범위 원본).
   * cursor 는 현재 editTa 가 가리키는 단계 인덱스. 중간 단계에서 [재생성]하면
   * cursor 뒤의 단계들을 버리고 새 ai 단계를 push 한다.
   */
  private history: Step[] = [];
  private cursor = 0;
  /**
   * 편집 영역이 지금 (아직 반영 안 된) 번역 결과 미리보기를 보여주고 있는지.
   * 이 상태에선 편집 영역이 읽기 전용이고, 단계 UI는 숨겨지며, [적용]은 본문 패치 대신
   * 이 미리보기를 translations.json 에 실제로 반영(commit)하는 동작으로 바뀐다.
   */
  private translationPreview = false;
  /** translationPreview 상태에서 [적용] 시 실행할 반영 콜백. */
  private pendingTranslationCommit: (() => Promise<boolean>) | null = null;

  private countEl!: HTMLElement;
  private upBtn!: HTMLButtonElement;
  private downBtn!: HTMLButtonElement;
  private promptGridEl!: HTMLElement;
  private inputTa!: HTMLTextAreaElement;
  private editTa!: HTMLTextAreaElement;
  private generateBtn!: HTMLButtonElement;
  private retranslateBtn: HTMLButtonElement | null = null;
  private applyBtn!: HTMLButtonElement;
  private stepsEl!: HTMLElement;
  private stepPrevBtn!: HTMLButtonElement;
  private stepNextBtn!: HTMLButtonElement;
  private stepCountEl!: HTMLElement;
  private stepLabelEl!: HTMLElement;
  private stepToOriginalBtn!: HTMLButtonElement;

  constructor(
    private plugin: StellaEnginePlugin,
    private opts: ParagraphRegenModalOptions
  ) {
    super(plugin.app);
    this.ranges = listParagraphRanges(opts.baselineText);
    this.startIndex = opts.anchorIndex;
  }

  onOpen(): void {
    this.titleEl.setText("문단 재생성");
    const { toolbar, body, footerAux, footerMain } = createModalShell(this, "m", {
      toolbar: true,
    });
    // 이 창의 스크롤은 편집 textarea(.ggai-pr-edit-ta) 혼자 담당한다. 셸 기본값인
    // .ggai-modal-body 의 overflow-y:auto 를 그대로 두면 textarea 내부 스크롤과
    // 겹쳐 이중 스크롤바가 생기므로, 바깥쪽은 꺼둔다.
    body.addClass("ggai-pr-body");

    // ── 컨트롤 줄: 범위(▲ N개 ▼) + 재번역 + 프롬프트 ──
    const ctrl = toolbar!.createDiv({ cls: "ggai-modal-toolbar-row ggai-pr-ctrl" });
    this.upBtn = ctrl.createEl("button", {
      cls: "ggai-btn ggai-icon-btn",
      attr: { "aria-label": "윗문단 포함" },
    });
    setIcon(this.upBtn, "chevron-up");
    this.upBtn.addEventListener("click", () => this.adjustRange(-1));
    this.countEl = ctrl.createSpan({ cls: "ggai-pr-count" });
    this.downBtn = ctrl.createEl("button", {
      cls: "ggai-btn ggai-icon-btn",
      attr: { "aria-label": "윗문단 제외" },
    });
    setIcon(this.downBtn, "chevron-down");
    this.downBtn.addEventListener("click", () => this.adjustRange(1));

    // 재번역 — 번역 사용 중일 때만. 프롬프트 선택 앞에 둬서 먼저 눈에 띄게.
    if (this.opts.translationEnabled && this.opts.onRetranslate) {
      this.retranslateBtn = ctrl.createEl("button", {
        cls: "ggai-pr-retranslate-btn",
        text: "재번역",
      });
      this.retranslateBtn.addEventListener(
        "click",
        () => void this.retranslate()
      );
    }

    // 프롬프트 — 컨트롤 줄에 이어서(저장 라이브러리, 우측 사이드바와 같은 버튼 그리드).
    this.promptGridEl = ctrl.createDiv({
      cls: "ggai-preset-grid ggai-media-prompt-grid ggai-pr-prompts",
    });
    this.renderPromptPicker();

    // ── 직접 입력 + 재생성 (프롬프트 없이 이 입력만으로도 재생성) ──
    const genRow = toolbar!.createDiv({ cls: "ggai-modal-toolbar-row ggai-pr-gen-row" });
    this.inputTa = genRow.createEl("textarea", {
      cls: "ggai-regen-textarea ggai-pr-input",
    });
    this.inputTa.rows = 1;
    this.inputTa.placeholder = "직접 지시 입력";
    this.inputTa.addEventListener("input", () => this.updateButtons());
    this.generateBtn = genRow.createEl("button", {
      cls: "ggai-pr-gen-btn",
      text: "재생성",
    });
    this.generateBtn.addEventListener("click", () => void this.generate());

    // ── 편집 영역 (원문으로 시작 → 재생성하면 결과, 직접 수정 가능). 본문의 유일한 스크롤 영역. ──
    this.editTa = body.createEl("textarea", { cls: "ggai-pr-edit-ta" });
    this.editTa.addEventListener("input", () => this.onEditInput());

    // ── 액션: [단계 UI 왼쪽] / [취소 / 적용 오른쪽] ──
    this.stepsEl = footerAux.createDiv({ cls: "ggai-pr-steps" });
    this.stepPrevBtn = this.stepsEl.createEl("button", {
      cls: "ggai-btn ggai-icon-btn ggai-pr-step-btn",
      attr: { "aria-label": "이전 단계" },
    });
    setIcon(this.stepPrevBtn, "chevron-left");
    this.stepPrevBtn.addEventListener("click", () => this.moveStep(-1));
    this.stepCountEl = this.stepsEl.createSpan({ cls: "ggai-pr-step-count" });
    this.stepNextBtn = this.stepsEl.createEl("button", {
      cls: "ggai-btn ggai-icon-btn ggai-pr-step-btn",
      attr: { "aria-label": "다음 단계" },
    });
    setIcon(this.stepNextBtn, "chevron-right");
    this.stepNextBtn.addEventListener("click", () => this.moveStep(1));
    this.stepLabelEl = this.stepsEl.createSpan({ cls: "ggai-pr-step-label" });
    this.stepToOriginalBtn = this.stepsEl.createEl("button", {
      cls: "ggai-pr-to-original",
      text: "초안으로",
    });
    this.stepToOriginalBtn.addEventListener("click", () => this.jumpToOriginal());

    const cancelBtn = footerMain.createEl("button", { cls: "ggai-btn", text: "취소" });
    cancelBtn.addEventListener("click", () => this.close());
    this.applyBtn = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "적용",
    });
    this.applyBtn.addEventListener("click", () => void this.apply());

    this.loadSliceIntoEditor();
    this.renderRange();
    this.updateButtons();
  }

  /** 편집 영역을 현재 범위의 원문으로 리셋 (창 열 때 / 범위 변경 시). 단계 스택도 새 원본 하나로 리셋. */
  private loadSliceIntoEditor(): void {
    const text = this.currentSlice().text;
    this.history = [{ kind: "original", text, dirty: false }];
    this.cursor = 0;
    this.editTa.value = text;
    this.editTa.readOnly = false;
    this.translationPreview = false;
    this.pendingTranslationCommit = null;
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ── 범위 ──

  private currentSlice(): { from: number; to: number; text: string } {
    const from = this.ranges[this.startIndex].from;
    const to = this.ranges[this.opts.anchorIndex].to;
    return { from, to, text: this.opts.baselineText.slice(from, to) };
  }

  private adjustRange(delta: number): void {
    if (this.busy) return;
    const next = Math.max(
      0,
      Math.min(this.opts.anchorIndex, this.startIndex + delta)
    );
    if (next === this.startIndex) return;
    this.startIndex = next;
    // 편집 영역을 새 범위의 원문으로 다시 채운다 (이전 결과는 다른 범위 기준이라 폐기).
    this.loadSliceIntoEditor();
    this.renderRange();
    this.updateButtons();
  }

  private renderRange(): void {
    const count = this.opts.anchorIndex - this.startIndex + 1;
    this.countEl.setText(`문단 ${count}개`);
    this.upBtn.disabled = this.busy || this.startIndex <= 0;
    this.downBtn.disabled = this.busy || this.startIndex >= this.opts.anchorIndex;
  }

  // ── 프롬프트 라이브러리 (bucket = paragraphRegen, PluginData.mediaPrompts) ──

  private get selectedPromptId(): string | undefined {
    return this.plugin.data.paragraphRegenPromptId;
  }

  private renderPromptPicker(): void {
    const grid = this.promptGridEl;
    grid.empty();
    // 기본 프롬프트를 자동 선택하지 않는다 — 아무것도 안 고르면 직접 입력만으로 처리.
    const effectiveActive = this.selectedPromptId;
    for (const prompt of this.getPrompts()) {
      const btn = grid.createEl("button", {
        cls: "ggai-preset-btn",
        text: prompt.title || "이름 없음",
      });
      if (prompt.id === effectiveActive) btn.addClass("is-active");
      if (isBuiltinMediaPrompt(prompt.id)) {
        btn.addClass("is-builtin");
        if (this.isBuiltinOverridden(prompt.id)) btn.addClass("is-modified");
      }
      // 이미 선택된 프롬프트를 다시 누르면 선택 해제(직접 입력 전용 상태로).
      btn.addEventListener("click", () =>
        void this.selectPrompt(
          prompt.id === this.selectedPromptId ? undefined : prompt.id
        )
      );
      attachLongPress(btn, {
        onLongPress: (x, y) => this.openPromptMenu(prompt, x, y),
      });
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openPromptMenu(prompt, e.clientX, e.clientY);
      });
    }
    const addBtn = grid.createEl("button", {
      cls: "ggai-preset-btn ggai-preset-add",
      attr: { "aria-label": "프롬프트 추가" },
    });
    setIcon(addBtn, "plus");
    addBtn.addEventListener("click", () => void this.addPrompt());
  }

  private openPromptMenu(prompt: MediaPromptItem, x: number, y: number): void {
    const menu = new Menu();
    menu.addItem((mi) =>
      mi
        .setTitle("편집")
        .setIcon("pencil")
        .onClick(() => void this.editPrompt(prompt))
    );
    if (isBuiltinMediaPrompt(prompt.id)) {
      if (this.isBuiltinOverridden(prompt.id)) {
        menu.addItem((mi) =>
          mi
            .setTitle("기본값으로 되돌리기")
            .setIcon("rotate-ccw")
            .onClick(() => void this.restoreDefaultPrompt(prompt.id))
        );
      }
    } else {
      menu.addItem((mi) =>
        mi
          .setTitle("삭제")
          .setIcon("trash-2")
          .onClick(() => void this.deletePrompt(prompt.id))
      );
    }
    menu.showAtPosition({ x, y });
  }

  private async selectPrompt(promptId: string | undefined): Promise<void> {
    await this.plugin.savePluginData({ paragraphRegenPromptId: promptId });
    this.renderPromptPicker();
    this.updateButtons();
  }

  private async addPrompt(): Promise<void> {
    const result = await PromptEditModal.open(
      this.plugin,
      "프롬프트 추가",
      { id: uuidv4(), title: "", prompt: "" },
      {
        bodyMacroHint: true,
        ioInstructions: getBucketIoInstructions("paragraphRegen") ?? undefined,
      }
    );
    if (!result) return;
    await this.savePrompts([...this.getUserPrompts(), result]);
    await this.plugin.savePluginData({ paragraphRegenPromptId: result.id });
    this.renderPromptPicker();
  }

  private async editPrompt(prompt: MediaPromptItem): Promise<void> {
    const result = await PromptEditModal.open(
      this.plugin,
      "프롬프트 편집",
      prompt,
      {
        bodyMacroHint: true,
        ioInstructions: getBucketIoInstructions("paragraphRegen") ?? undefined,
      }
    );
    if (!result) return;
    const users = this.getUserPrompts();
    const nextUsers = users.some((p) => p.id === prompt.id)
      ? users.map((p) => (p.id === prompt.id ? result : p))
      : [...users, result];
    await this.savePrompts(nextUsers);
    this.renderPromptPicker();
  }

  private async restoreDefaultPrompt(promptId: string): Promise<void> {
    await this.savePrompts(
      this.getUserPrompts().filter((p) => p.id !== promptId)
    );
    this.renderPromptPicker();
  }

  private async deletePrompt(promptId: string): Promise<void> {
    if (isBuiltinMediaPrompt(promptId)) {
      new Notice("기본 프롬프트는 삭제할 수 없습니다.");
      return;
    }
    await this.savePrompts(
      this.getUserPrompts().filter((p) => p.id !== promptId)
    );
    if (this.selectedPromptId === promptId) {
      await this.plugin.savePluginData({ paragraphRegenPromptId: undefined });
    }
    this.renderPromptPicker();
  }

  private getUserPrompts(): MediaPromptItem[] {
    return [...(this.plugin.data.mediaPrompts?.[BUCKET] ?? [])];
  }

  private getPrompts(): MediaPromptItem[] {
    // 기본(내장) + 사용자 추가. 기본을 편집하면 같은 builtin id 의 override 가 우선.
    const users = this.getUserPrompts();
    const overrides = new Map(
      users.filter((u) => isBuiltinMediaPrompt(u.id)).map((u) => [u.id, u])
    );
    const merged = getDefaultPrompts(BUCKET).map(
      (d) => overrides.get(d.id) ?? d
    );
    return [...merged, ...users.filter((u) => !isBuiltinMediaPrompt(u.id))];
  }

  private isBuiltinOverridden(promptId: string): boolean {
    return this.getUserPrompts().some((p) => p.id === promptId);
  }

  private async savePrompts(prompts: MediaPromptItem[]): Promise<void> {
    await this.plugin.savePluginData({
      mediaPrompts: {
        ...(this.plugin.data.mediaPrompts ?? {}),
        [BUCKET]: prompts,
      },
    });
  }

  // ── 생성 / 적용 ──

  /** editTa 수동 수정 — 현재 cursor 단계의 text 를 덮어쓰고 dirty 표시. */
  private onEditInput(): void {
    if (this.translationPreview) return;
    const step = this.history[this.cursor];
    if (!step) return;
    step.text = this.editTa.value;
    step.dirty = true;
    this.renderSteps();
    this.updateButtons();
  }

  private async generate(): Promise<void> {
    if (this.busy) return;
    const direct = this.inputTa.value.trim();
    const promptId = this.selectedPromptId;
    if (!promptId && !direct) {
      new Notice("프롬프트를 고르거나 직접 입력을 채워주세요.");
      return;
    }
    // source 는 항상 편집 영역의 현재 값(현재 cursor 단계의 text).
    const source = this.editTa.value;
    // 프롬프트를 골랐으면 그 지침 + 직접 입력(추가 지시). 안 골랐으면 직접 입력이 지침.
    const rewriteOpts = promptId
      ? { promptId, feedback: direct || undefined }
      : { instruction: direct };
    this.setBusy(true);
    try {
      const result = await this.plugin.paragraphRegen.rewrite(
        this.opts.sessionFile,
        { source, ...rewriteOpts }
      );
      if (!result.ok) {
        new Notice(result.errors.join("\n") || "문단 재생성에 실패했습니다.");
        return;
      }
      // cursor 뒤의 단계는 버리고 새 ai 단계 push (선형 스택).
      this.history = [
        ...this.history.slice(0, this.cursor + 1),
        { kind: "ai", text: result.text, dirty: false },
      ];
      this.cursor = this.history.length - 1;
      this.editTa.value = result.text;
      this.editTa.readOnly = false;
      this.translationPreview = false;
      this.pendingTranslationCommit = null;
      this.renderSteps();
      this.updateButtons();
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 재번역 — 아직 아무것도 반영하지 않는다. 결과를 편집 영역에 미리보기로 띄워
   * 확인한 뒤 [적용]을 눌러야 translations.json 에 실제로 반영된다. 마음에 안 들면
   * 적용 없이 그 자리에서 재번역을 다시 눌러본다 (문단 재선택 불필요, 이전 미리보기는
   * 그냥 버려진다 — 아직 반영 전이라 되돌릴 것도 없다).
   */
  private async retranslate(): Promise<void> {
    if (this.busy || !this.opts.onRetranslate) return;
    // 현재 범위 문단 해시 (중복 내용 문단은 1회 — 번역 공유).
    const hashes: string[] = [];
    const seen = new Set<string>();
    for (let i = this.startIndex; i <= this.opts.anchorIndex; i++) {
      const h = this.ranges[i].hash;
      if (!seen.has(h)) {
        seen.add(h);
        hashes.push(h);
      }
    }
    if (hashes.length === 0) return;
    const slice = this.currentSlice();
    this.setBusy(true);
    try {
      const result = await this.opts.onRetranslate(
        slice.from,
        slice.to,
        hashes
      );
      if (result == null) return;
      this.editTa.value = result.previewText;
      this.editTa.readOnly = true;
      this.translationPreview = true;
      this.pendingTranslationCommit = result.commit;
      this.renderSteps();
      this.updateButtons();
    } finally {
      this.setBusy(false);
    }
  }

  private async apply(): Promise<void> {
    if (this.busy) return;
    // 번역 미리보기 확인 중이면 본문 대신 미리보기를 실제로 반영(commit)한다.
    if (this.translationPreview) {
      if (!this.pendingTranslationCommit) {
        this.close();
        return;
      }
      this.setBusy(true);
      try {
        const ok = await this.pendingTranslationCommit();
        if (ok) this.close();
      } finally {
        this.setBusy(false);
      }
      return;
    }
    const text = this.editTa.value;
    const slice = this.currentSlice();
    // 편집 영역이 비었거나 원문 그대로면 적용할 것이 없다.
    if (!text.trim() || text === slice.text) return;
    this.setBusy(true);
    try {
      const ok = await this.opts.onApply(slice.from, slice.to, slice.text, text);
      if (ok) this.close();
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.generateBtn.setText(busy ? "생성 중..." : "재생성");
    this.updateButtons();
  }

  private updateButtons(): void {
    // 프롬프트를 골랐거나 직접 입력이 있어야 재생성 가능. 번역 미리보기 중엔 비활성.
    const canGenerate =
      !this.translationPreview &&
      (!!this.selectedPromptId || this.inputTa.value.trim() !== "");
    this.generateBtn.disabled = this.busy || !canGenerate;
    if (this.retranslateBtn) this.retranslateBtn.disabled = this.busy;
    if (this.translationPreview) {
      // 단계 UI 숨김 — 번역 미리보기 중엔 의미 없음.
      this.stepsEl.addClass("is-hidden");
      this.applyBtn.setText("적용");
      this.applyBtn.disabled = this.busy || !this.pendingTranslationCommit;
    } else {
      this.stepsEl.removeClass("is-hidden");
      this.applyBtn.setText("적용");
      // 편집 영역이 초원본과 달라졌을 때만 적용 가능.
      const text = this.editTa.value;
      const changed =
        text.trim() !== "" && text !== this.history[0]?.text;
      this.applyBtn.disabled = this.busy || !changed;
    }
    this.upBtn.disabled = this.busy || this.startIndex <= 0;
    this.downBtn.disabled = this.busy || this.startIndex >= this.opts.anchorIndex;
    this.renderSteps();
  }

  // ── 단계(history) ──

  private moveStep(delta: number): void {
    if (this.busy || this.translationPreview) return;
    const next = this.cursor + delta;
    if (next < 0 || next >= this.history.length) return;
    this.cursor = next;
    this.editTa.value = this.history[next].text;
    this.renderSteps();
    this.updateButtons();
  }

  private jumpToOriginal(): void {
    if (this.busy || this.translationPreview) return;
    if (this.cursor === 0) return;
    this.cursor = 0;
    this.editTa.value = this.history[0].text;
    this.renderSteps();
    this.updateButtons();
  }

  private renderSteps(): void {
    const total = this.history.length;
    const idx = this.cursor + 1;
    this.stepCountEl.setText(`${idx}/${total}`);
    this.stepPrevBtn.disabled =
      this.busy || this.translationPreview || this.cursor <= 0;
    this.stepNextBtn.disabled =
      this.busy ||
      this.translationPreview ||
      this.cursor >= this.history.length - 1;
    this.stepToOriginalBtn.disabled =
      this.busy || this.translationPreview || this.cursor === 0;
    const step = this.history[this.cursor];
    if (!step) {
      this.stepLabelEl.setText("");
      return;
    }
    let label = step.kind === "original" ? "초안" : "AI";
    if (step.dirty) label += "•수정됨";
    this.stepLabelEl.setText(label);
  }
}
