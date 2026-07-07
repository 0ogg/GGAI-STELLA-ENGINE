import { Notice, setIcon } from "obsidian";
import type StellaEnginePlugin from "../../main";
import type {
  PromptChoiceBlock,
  PromptRole,
  StellaPromptItem,
  StellaPromptTextItem,
} from "../../types/prompt";
import { MARKER_MACRO } from "../../types/prompt";
import {
  buildDefaultPromptPreset,
  NEW_PRESET_BASE_NAME,
} from "../../util/default-prompt-preset";
import type { PromptListItem } from "../../util/scan-prompts";
import { uuidv4 } from "../../util/uuid";
import { exportPromptPreset } from "../entity-actions";
import { ConfirmModal } from "../modals";

export interface PromptsSectionUiState {
  collapsed: boolean;
  expandedItemIds: string[];
}

/**
 * PromptsSection — 활성 프롬프트 세트 편집기.
 *
 * 사용자 스펙:
 *   ├── (드롭다운)(임포트)(익스포트)(+)        ← 세트 선택 + 세트 단위
 *   ├── (+항목 추가)(접기/펼치기)(새탭에서 편집)
 *   └── prompts[] 리스트 — 드래그 정렬, 항목명+토글, 클릭 시 편집창 드롭다운.
 *
 * 동작:
 *   - row 전체 draggable. 핸들 따로 없음.
 *   - row 클릭 → 편집창 펼침/접힘. 토글/삭제는 stopPropagation.
 *   - 이름 편집은 펼친 편집창 내부에서만.
 *   - 토글 = 스위치 (체크박스 X).
 *   - 펼친 항목 row 의 이름은 굵게.
 *   - 삭제 버튼은 편집창 안. 빈 항목 외에는 ConfirmModal.
 */
export class PromptsSection {
  private root: HTMLElement;
  private contentEl!: HTMLElement;
  private selectorEl!: HTMLSelectElement;
  private foldBtnEl!: HTMLElement;
  private bodyEl!: HTMLElement;

  private promptList: PromptListItem[] = [];
  private activePresetFile: string | null = null;
  private activePreset: import("../../types/prompt").StellaPromptPreset | null =
    null;
  private activeSessionFile: string | null;
  private choiceValues: Record<string, string[]> = {};

  private dragSourceIdx: number | null = null;
  private expandedItemIds = new Set<string>();
  private collapsed = false;
  private headerEl: HTMLElement | null = null;
  private naiFormat = false;
  private naiCheckbox: HTMLInputElement | null = null;
  private continueAnchor = false;
  private continueAnchorCheckbox: HTMLInputElement | null = null;
  private savingSelf = false;

  constructor(
    container: HTMLElement,
    private plugin: StellaEnginePlugin,
    activeSessionFile: string | null,
    uiState?: Partial<PromptsSectionUiState>
  ) {
    this.root = container.createDiv({ cls: "ggai-prompts-section" });
    this.activeSessionFile = activeSessionFile;
    if (uiState?.collapsed !== undefined) this.collapsed = uiState.collapsed;
    if (uiState?.expandedItemIds) {
      this.expandedItemIds = new Set(uiState.expandedItemIds);
    }
    this.renderShell();
  }

  getUiState(): PromptsSectionUiState {
    return {
      collapsed: this.collapsed,
      expandedItemIds: Array.from(this.expandedItemIds),
    };
  }

  setCollapsed(v: boolean): void {
    if (v === this.collapsed) return;
    this.collapsed = v;
    this.contentEl.toggleClass("is-collapsed", v);
    this.headerEl?.setAttr("aria-expanded", String(!v));
  }

  async load(): Promise<void> {
    this.promptList = await this.plugin.store.getPromptPresets();
    // PROMPTS/ 가 비었으면 Default 자동 생성 — "세트 없음" 상태를 만들지 않는다.
    if (this.promptList.length === 0) {
      await this.plugin.ensureDefaultPromptPreset();
      this.promptList = await this.plugin.store.getPromptPresets();
    }
    const settings = await this.plugin.resolveActiveSettings(
      this.activeSessionFile
    );
    this.setNaiFormat(await this.resolveEffectiveNai(settings.naiFormat));
    this.setContinueAnchor(settings.continueAnchor ?? false);
    this.resolveActive(settings.promptSetId);
    // 활성 세트가 비었지만 list 가 있으면 첫 항목을 자동 활성화 (사용자에게 "비어있는" 화면 안 보이게).
    if (!this.activePreset && this.promptList.length > 0) {
      const first = this.promptList[0];
      this.activePresetFile = first.presetFile;
      this.activePreset = first.preset;
      try {
        await this.plugin.patchActiveSettings(
          { promptSetId: first.preset.meta.id },
          this.activeSessionFile
        );
      } catch {
        // 활성 설정 저장 실패는 무시 — 다음 명시적 액션에서 재시도.
      }
    }
    await this.loadChoiceValues();
    this.renderSelector();
    this.renderBody();
    this.refreshFoldBtn();
  }

  setActiveSessionFile(file: string | null): void {
    this.activeSessionFile = file;
  }

  async refresh(): Promise<void> {
    this.promptList = await this.plugin.store.getPromptPresets();
    const settings = await this.plugin.resolveActiveSettings(
      this.activeSessionFile
    );
    this.setNaiFormat(await this.resolveEffectiveNai(settings.naiFormat));
    this.setContinueAnchor(settings.continueAnchor ?? false);
    this.resolveActive(settings.promptSetId);
    await this.loadChoiceValues();
    this.renderSelector();
    if (!this.savingSelf) this.renderBody();
    this.refreshFoldBtn();
  }

  async syncActiveSettings(
    promptSetId: string | undefined,
    naiFormatRaw?: boolean,
    continueAnchorRaw?: boolean
  ): Promise<void> {
    this.setNaiFormat(await this.resolveEffectiveNai(naiFormatRaw));
    this.setContinueAnchor(continueAnchorRaw ?? false);
    this.resolveActive(promptSetId);
    this.renderSelector();
    if (!this.savingSelf) this.renderBody();
    this.refreshFoldBtn();
  }

  /** 미설정이면 텍스트 모델일 때 ON 이 기본값 — 전송 로직과 동일하게 맞춘다. */
  private async resolveEffectiveNai(raw: boolean | undefined): Promise<boolean> {
    if (raw !== undefined) return raw;
    return this.activeModelIsText();
  }

  /** NAI 형식 상태 갱신 + 체크박스 반영. */
  private setNaiFormat(value: boolean): void {
    this.naiFormat = value;
    if (this.naiCheckbox) this.naiCheckbox.checked = value;
  }

  private async handleNaiFormatToggle(checked: boolean): Promise<void> {
    this.naiFormat = checked;
    await this.plugin.patchActiveSettings(
      { naiFormat: checked },
      this.activeSessionFile
    );
  }

  /** 이어쓰기 이음새 보정 상태 갱신 + 체크박스 반영. */
  private setContinueAnchor(value: boolean): void {
    this.continueAnchor = value;
    if (this.continueAnchorCheckbox) {
      this.continueAnchorCheckbox.checked = value;
    }
  }

  private async handleContinueAnchorToggle(checked: boolean): Promise<void> {
    this.continueAnchor = checked;
    await this.plugin.patchActiveSettings(
      { continueAnchor: checked },
      this.activeSessionFile
    );
  }

  // ─── private helpers ─────────────────────────────────────────────

  private resolveActive(id: string | undefined): void {
    if (!id) {
      this.activePresetFile = null;
      this.activePreset = null;
      return;
    }
    const item = this.promptList.find((p) => p.preset.meta.id === id);
    if (item) {
      this.activePresetFile = item.presetFile;
      this.activePreset = item.preset;
    } else {
      this.activePresetFile = null;
      this.activePreset = null;
    }
  }

  private async loadChoiceValues(): Promise<void> {
    this.choiceValues = {};
    if (!this.activeSessionFile) return;
    const session = await this.plugin.store.getSession(this.activeSessionFile);
    this.choiceValues = { ...(session?.meta.choiceValues ?? {}) };
  }

  // ─── render shell (once) ─────────────────────────────────────────

  private renderShell(): void {
    const header = this.root.createDiv({
      cls: "ggai-section-header is-clickable",
    });
    this.headerEl = header;
    header.createSpan({ cls: "ggai-section-title", text: "프롬프트" });

    // Toolbar 1: (드롭다운)(임포트)(익스포트)(+)
    header.setAttr("role", "button");
    header.setAttr("tabindex", "0");
    header.setAttr("aria-expanded", String(!this.collapsed));
    const toggleCollapsed = () => {
      this.collapsed = !this.collapsed;
      this.contentEl.toggleClass("is-collapsed", this.collapsed);
      header.setAttr("aria-expanded", String(!this.collapsed));
    };
    header.addEventListener("click", toggleCollapsed);
    header.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      toggleCollapsed();
    });

    this.contentEl = this.root.createDiv({ cls: "ggai-prompts-content" });
    this.contentEl.toggleClass("is-collapsed", this.collapsed);

    const tb1 = this.contentEl.createDiv({ cls: "ggai-prompts-toolbar" });
    this.selectorEl = tb1.createEl("select", { cls: "ggai-prompts-select" });
    this.selectorEl.addEventListener("change", () =>
      void this.handleSelectorChange()
    );
    this.makeIconBtn(tb1, "download", "임포트", () => this.handleImport());
    this.makeIconBtn(tb1, "upload", "익스포트", () => void this.handleExport());
    this.makeIconBtn(tb1, "plus", "새 세트", () => void this.handleAddSet());
    this.makeIconBtn(tb1, "trash-2", "이 세트 삭제", () =>
      void this.handleDeleteSet()
    );

    // Toolbar 2: (+ 항목 추가)(접기/펼치기 통합)(새탭에서 편집)
    const tb2 = this.contentEl.createDiv({ cls: "ggai-prompts-toolbar" });
    this.makeTextBtn(tb2, "plus", "항목 추가", () => void this.handleAddItem());
    this.foldBtnEl = this.makeIconBtn(
      tb2,
      "chevrons-down-up",
      "전부 접기",
      () => this.toggleFoldAll()
    );
    this.makeIconBtn(tb2, "external-link", "프롬프트 탭에서 편집", () =>
      void this.handleOpenInTab()
    );

    // NAI 형식으로 보내기 — 텍스트 컴플리션 전송 시 역할 토큰으로 감싸기.
    const naiRow = this.contentEl.createDiv({ cls: "ggai-prompts-nai-row" });
    const naiLabel = naiRow.createEl("label", { cls: "ggai-prompts-nai-label" });
    this.naiCheckbox = naiLabel.createEl("input", {
      cls: "ggai-form-checkbox",
      attr: { type: "checkbox" },
    });
    this.naiCheckbox.checked = this.naiFormat;
    this.naiCheckbox.addEventListener("change", () =>
      void this.handleNaiFormatToggle(this.naiCheckbox!.checked)
    );
    naiLabel.createSpan({
      text: "NAI 형식으로 보내기 (<|system|>/<|user|>/<|assistant|>)",
    });

    // 이어쓰기 이음새 보정 (챗 모델) — 마지막 문장 반복 유도 후 응답에서 제거.
    const anchorRow = this.contentEl.createDiv({ cls: "ggai-prompts-nai-row" });
    const anchorLabel = anchorRow.createEl("label", {
      cls: "ggai-prompts-nai-label",
      attr: {
        title:
          "챗 모델 전용. 본문 마지막 문장을 그대로 받아쓰며 시작하라고 지시하고, 응답 앞의 반복된 문장은 자동으로 제거합니다.",
      },
    });
    this.continueAnchorCheckbox = anchorLabel.createEl("input", {
      cls: "ggai-form-checkbox",
      attr: { type: "checkbox" },
    });
    this.continueAnchorCheckbox.checked = this.continueAnchor;
    this.continueAnchorCheckbox.addEventListener("change", () =>
      void this.handleContinueAnchorToggle(this.continueAnchorCheckbox!.checked)
    );
    anchorLabel.createSpan({
      text: "이어쓰기 이음새 보정 (챗 모델 — 마지막 문장 반복 후 제거)",
    });

    this.bodyEl = this.contentEl.createDiv({ cls: "ggai-prompts-body" });
  }

  private makeIconBtn(
    parent: HTMLElement,
    icon: string,
    aria: string,
    onClick: () => void
  ): HTMLElement {
    const btn = parent.createEl("button", {
      cls: "ggai-prompts-tb-btn",
      attr: { "aria-label": aria, title: aria },
    });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private makeTextBtn(
    parent: HTMLElement,
    icon: string,
    text: string,
    onClick: () => void
  ): HTMLElement {
    const btn = parent.createEl("button", {
      cls: "ggai-prompts-tb-btn ggai-prompts-tb-text",
    });
    setIcon(btn, icon);
    btn.createSpan({ text });
    btn.addEventListener("click", onClick);
    return btn;
  }

  // ─── selector ────────────────────────────────────────────────────

  private renderSelector(): void {
    this.selectorEl.empty();
    for (const item of this.promptList) {
      const opt = this.selectorEl.createEl("option", {
        value: item.presetFile,
        text: item.folderName,
      });
      if (item.presetFile === this.activePresetFile) opt.selected = true;
    }
  }

  // ─── body (prompt list) ──────────────────────────────────────────

  private renderBody(): void {
    this.bodyEl.empty();

    if (!this.activePreset) {
      this.bodyEl.createDiv({
        cls: "ggai-detail-empty",
        text: "프롬프트 세트를 선택하거나 임포트하세요.",
      });
      return;
    }

    const list = this.bodyEl.createDiv({ cls: "ggai-prompts-list" });
    const items = this.activePreset.prompts;
    for (let i = 0; i < items.length; i++) {
      this.renderItem(list, items[i], i);
    }
    this.renderChoiceBlocks();
  }

  /** 모두 펼쳐져 있는지 여부에 따라 fold 버튼 아이콘/aria 갱신. */
  private refreshFoldBtn(): void {
    if (!this.foldBtnEl) return;
    const items = this.activePreset?.prompts ?? [];
    const allExpanded =
      items.length > 0 && items.every((item) => this.expandedItemIds.has(item.id));
    setIcon(
      this.foldBtnEl,
      allExpanded ? "chevrons-down-up" : "chevrons-up-down"
    );
    const label = allExpanded ? "전부 접기" : "전부 펼치기";
    this.foldBtnEl.setAttribute("aria-label", label);
    this.foldBtnEl.setAttribute("title", label);
  }

  private toggleFoldAll(): void {
    if (!this.activePreset) return;
    const items = this.activePreset.prompts;
    const allExpanded =
      items.length > 0 && items.every((item) => this.expandedItemIds.has(item.id));
    if (allExpanded) {
      for (const item of items) this.expandedItemIds.delete(item.id);
    } else {
      for (const item of items) this.expandedItemIds.add(item.id);
    }
    this.renderBody();
    this.refreshFoldBtn();
  }

  private renderItem(
    list: HTMLElement,
    item: StellaPromptItem,
    idx: number
  ): void {
    const expanded = this.expandedItemIds.has(item.id);

    const wrapper = list.createDiv({ cls: "ggai-prompt-item" });
    if (!item.enabled) wrapper.addClass("is-disabled");
    if (expanded) wrapper.addClass("is-expanded");

    // ── Row (클릭 = 펼침/접힘, 드래그 핸들) ──
    // 드래그는 제목 바(row) 에서만 시작한다. 펼친 편집 영역에서는 드래그로 이동하지 않는다.
    const row = wrapper.createDiv({ cls: "ggai-prompt-row" });
    row.draggable = true;
    this.bindDrag(wrapper, row, idx);
    row.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".ggai-prompt-toggle")) return;
      if (this.expandedItemIds.has(item.id)) this.expandedItemIds.delete(item.id);
      else this.expandedItemIds.add(item.id);
      this.renderBody();
      this.refreshFoldBtn();
    });

    // Toggle switch
    this.appendToggleSwitch(row, item.enabled, (v) =>
      void this.handleToggleEnabled(idx, v)
    );

    // Name (display only)
    row.createDiv({
      cls: "ggai-prompt-name",
      text:
        item.name ||
        (item.kind === "marker" ? item.identifier : "이름 없음"),
    });

    // Kind/role badge
    const badge = row.createDiv({ cls: "ggai-prompt-badge" });
    if (item.kind === "marker") {
      badge.addClass("is-marker");
      badge.textContent = "M";
      badge.title = item.identifier;
    } else {
      const role = (item as StellaPromptTextItem).role ?? "system";
      badge.addClass(`is-${role}`);
      badge.textContent =
        role === "system" ? "SYS" : role === "user" ? "USR" : "AST";
    }

    // Caret indicator
    const caret = row.createDiv({ cls: "ggai-prompt-caret" });
    setIcon(caret, expanded ? "chevron-up" : "chevron-down");

    // ── Expanded edit panel ──
    if (expanded) this.renderEditPanel(wrapper, item, idx);
  }

  /** 토글 스위치(체크박스 + 시각 스위치). 클릭 이벤트는 row 펼침에 영향 X. */
  private appendToggleSwitch(
    row: HTMLElement,
    checked: boolean,
    onChange: (v: boolean) => void
  ): void {
    const label = row.createEl("label", { cls: "ggai-prompt-toggle" });
    label.addEventListener("click", (e) => e.stopPropagation());
    const input = label.createEl("input", {
      attr: { type: "checkbox" },
    }) as HTMLInputElement;
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    label.createSpan({ cls: "ggai-prompt-toggle-track" });
  }

  private renderEditPanel(
    wrapper: HTMLElement,
    item: StellaPromptItem,
    idx: number
  ): void {
    const panel = wrapper.createDiv({ cls: "ggai-prompt-edit-panel" });
    panel.addEventListener("click", (e) => e.stopPropagation());

    if (item.kind === "marker") {
      const info = panel.createDiv({ cls: "ggai-prompt-edit-info" });
      info.createSpan({ text: "marker 항목 — identifier: " });
      info.createEl("code", { text: item.identifier });
      this.appendMarkerWrapField(panel, item, idx);
      return;
    }

    // text item
    this.appendNameField(panel, item.name, idx);

    const roleRow = panel.createDiv({ cls: "ggai-prompt-edit-row" });
    roleRow.createSpan({ cls: "ggai-prompt-edit-label", text: "역할" });
    const roleSel = roleRow.createEl("select", {
      cls: "ggai-prompt-edit-select",
    });
    for (const r of ["system", "user", "assistant"] as PromptRole[]) {
      const opt = roleSel.createEl("option", { value: r, text: r });
      if (item.role === r) opt.selected = true;
    }
    roleSel.addEventListener("change", () =>
      void this.handleRoleEdit(idx, roleSel.value as PromptRole)
    );

    const taRow = panel.createDiv({ cls: "ggai-prompt-edit-row" });
    taRow.createSpan({ cls: "ggai-prompt-edit-label", text: "내용" });
    const ta = taRow.createEl("textarea", {
      cls: "ggai-prompt-content-ta",
    });
    ta.value = item.content ?? "";
    ta.rows = 6;
    ta.placeholder = "프롬프트 내용...";
    ta.addEventListener("blur", () =>
      void this.handleContentEdit(idx, ta.value)
    );

    this.appendDeleteRow(panel, item, idx);
  }

  private renderChoiceBlocks(): void {
    const choices = this.activePreset?.choices ?? [];
    if (choices.length === 0) return;

    const wrap = this.bodyEl.createDiv({ cls: "ggai-prompt-choices" });
    const header = wrap.createDiv({ cls: "ggai-section-header" });
    header.createSpan({ cls: "ggai-section-title", text: "선택 변수" });

    if (!this.activeSessionFile) {
      wrap.createDiv({
        cls: "ggai-detail-empty",
        text: "선택 변수는 열린 세션에 저장됩니다.",
      });
      return;
    }

    for (const block of choices) {
      this.renderChoiceBlock(wrap, block);
    }
  }

  private renderChoiceBlock(parent: HTMLElement, block: PromptChoiceBlock): void {
    const box = parent.createDiv({ cls: "ggai-prompt-choice-block" });
    const title = box.createDiv({ cls: "ggai-prompt-choice-title" });
    title.createSpan({ text: block.name || block.id });
    if (block.random) title.createSpan({ cls: "ggai-prompt-badge", text: "RND" });

    if (block.random) {
      box.createDiv({
        cls: "ggai-prompt-choice-hint",
        text: "생성할 때마다 가중치로 자동 선택됩니다.",
      });
      return;
    }

    const selected =
      this.choiceValues[block.id] ??
      (block.options[0] ? [block.options[0].id] : []);
    const groupName = `choice-${block.id}`;

    for (const option of block.options) {
      const label = box.createEl("label", { cls: "ggai-prompt-choice-option" });
      const input = label.createEl("input", {
        attr: { type: block.multiSelect ? "checkbox" : "radio", name: groupName },
      }) as HTMLInputElement;
      input.value = option.id;
      input.checked = selected.includes(option.id);
      input.addEventListener("change", () => {
        const next = block.multiSelect
          ? this.readMultiChoice(box, block)
          : [option.id];
        void this.handleChoiceChange(block.id, next);
      });
      label.createSpan({ text: option.label || option.id });
    }
  }

  private readMultiChoice(
    box: HTMLElement,
    block: PromptChoiceBlock
  ): string[] {
    const checked = Array.from(
      box.querySelectorAll<HTMLInputElement>("input:checked")
    );
    return checked.map((input) => input.value);
  }

  private appendNameField(
    panel: HTMLElement,
    name: string,
    idx: number
  ): void {
    const row = panel.createDiv({ cls: "ggai-prompt-edit-row" });
    row.createSpan({ cls: "ggai-prompt-edit-label", text: "이름" });
    const input = row.createEl("input", {
      cls: "ggai-prompt-edit-input",
    }) as HTMLInputElement;
    input.type = "text";
    input.value = name;
    input.addEventListener("blur", () =>
      void this.handleNameEdit(idx, input.value)
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    });
  }

  /**
   * 마커 본문 가공 — 체크 시 매크로가 들어간 입력란이 뜨고 앞뒤 가공을 할 수 있다.
   * 기본은 체크 해제(가공 안 함). 매크로를 지워도 내용은 순서 맨 뒤에 들어간다.
   */
  private appendMarkerWrapField(
    panel: HTMLElement,
    item: import("../../types/prompt").StellaPromptMarkerItem,
    idx: number
  ): void {
    const macro = MARKER_MACRO[item.identifier];
    // 내용이 없는 마커(enhanceDefinitions)는 가공 대상이 아니다.
    if (!macro) return;

    const row = panel.createDiv({ cls: "ggai-prompt-edit-row" });
    const head = row.createEl("label", { cls: "ggai-prompt-wrap-head" });
    const cb = head.createEl("input", { attr: { type: "checkbox" } });
    cb.checked = item.wrap !== undefined;
    head.createSpan({ text: "본문 가공" });

    const taWrap = row.createDiv({ cls: "ggai-prompt-wrap-body" });
    if (item.wrap === undefined) taWrap.addClass("is-hidden");
    const ta = taWrap.createEl("textarea", { cls: "ggai-prompt-content-ta" });
    ta.rows = 3;
    ta.value = item.wrap ?? "";
    ta.placeholder = `예: (관련 설정: ${macro})`;
    ta.addEventListener("blur", () =>
      void this.handleMarkerWrapEdit(idx, ta.value, false)
    );
    taWrap.createDiv({
      cls: "ggai-prompt-wrap-hint",
      text:
        `${macro} 자리에 이 항목 내용이 들어갑니다. 매크로를 지우면 내용이 맨 뒤에 붙습니다. 앞뒤 줄바꿈은 자동으로 넣지 않습니다.`,
    });

    cb.addEventListener("change", () => {
      // 켜면 그 마커의 해당 매크로가 채워진 템플릿, 끄면 가공 해제. (입력란 표시 위해 재렌더)
      void this.handleMarkerWrapEdit(idx, cb.checked ? macro : undefined, true);
    });
  }

  /** 편집 패널 하단 — 삭제 버튼. 빈 항목이 아니면 ConfirmModal. */
  private appendDeleteRow(
    panel: HTMLElement,
    item: StellaPromptItem,
    idx: number
  ): void {
    const row = panel.createDiv({ cls: "ggai-prompt-edit-actions" });
    const del = row.createEl("button", {
      cls: "ggai-prompt-edit-del",
    });
    setIcon(del, "trash-2");
    del.createSpan({ text: "삭제" });
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleDelete(idx, item);
    });
  }

  // ─── drag-and-drop ───────────────────────────────────────────────

  // 드래그 시작은 제목 바(row)에서만. 드롭 대상/하이라이트는 항목 전체(wrapper).
  private bindDrag(wrapper: HTMLElement, row: HTMLElement, idx: number): void {
    row.addEventListener("dragstart", (e) => {
      this.dragSourceIdx = idx;
      wrapper.addClass("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(idx));
      }
    });

    row.addEventListener("dragend", () => {
      wrapper.removeClass("is-dragging");
      this.dragSourceIdx = null;
      this.bodyEl.querySelectorAll(".drag-over").forEach((el) => {
        (el as HTMLElement).removeClass("drag-over");
      });
    });

    wrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      if (this.dragSourceIdx !== null && this.dragSourceIdx !== idx) {
        wrapper.addClass("drag-over");
      }
    });

    wrapper.addEventListener("dragleave", () => {
      wrapper.removeClass("drag-over");
    });

    wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      wrapper.removeClass("drag-over");
      if (this.dragSourceIdx === null || this.dragSourceIdx === idx) return;
      void this.handleReorder(this.dragSourceIdx, idx);
    });
  }

  // ─── handlers ────────────────────────────────────────────────────

  private async handleSelectorChange(): Promise<void> {
    const val = this.selectorEl.value;
    const item = this.promptList.find((p) => p.presetFile === val);
    if (!item) return;
    try {
      await this.plugin.patchActiveSettings(
        { promptSetId: item.preset.meta.id },
        this.activeSessionFile
      );
    } catch (err) {
      new Notice(
        `프롬프트 세트 변경 실패: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    this.activePresetFile = item.presetFile;
    this.activePreset = item.preset;
    this.renderBody();
    this.refreshFoldBtn();
  }

  private handleImport(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.style.display = "none";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await this.plugin.store.importFile(bytes, file.name);
        if (result.kind !== "prompt") {
          new Notice(
            `이 곳에서는 프롬프트 프리셋만 임포트됩니다 (감지: ${result.kind}).`
          );
          return;
        }
        if (!result.write.ok) {
          new Notice(`임포트 실패: ${result.write.reason}`);
          return;
        }
        const filePath = result.write.file;
        new Notice(`프롬프트 임포트: ${filePath.split("/").pop()}`);
        this.promptList = await this.plugin.store.getPromptPresets();
        const newItem = this.promptList.find(
          (p) => p.presetFile === filePath
        );
        if (newItem) {
          await this.plugin.patchActiveSettings(
            { promptSetId: newItem.preset.meta.id },
            this.activeSessionFile
          );
          this.activePresetFile = newItem.presetFile;
          this.activePreset = newItem.preset;
        }
        this.renderSelector();
        this.renderBody();
        this.refreshFoldBtn();
      } catch (err) {
        console.error("[GGAI Stella] 임포트 실패:", err);
        new Notice(
          `임포트 실패: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  /**
   * 새 세트 = 항상 Default 구조 박제 (모델 종류 무관).
   * NovelAI 구분자/역할 토큰은 세트가 아니라 "NAI 형식으로 보내기" 옵션이 담당.
   */
  private async handleAddSet(): Promise<void> {
    try {
      const baseName = NEW_PRESET_BASE_NAME;
      const init = buildDefaultPromptPreset(baseName);
      const result = await this.plugin.store.createPromptPreset(baseName, init);
      this.promptList = await this.plugin.store.getPromptPresets();
      this.activePresetFile = result.presetFile;
      this.activePreset = result.preset;
      await this.plugin.patchActiveSettings(
        { promptSetId: result.preset.meta.id },
        this.activeSessionFile
      );
      this.renderSelector();
      this.renderBody();
      this.refreshFoldBtn();
      new Notice(`프롬프트 세트 생성: ${result.presetFile.split("/").pop()}`);
    } catch (err) {
      new Notice(
        `세트 생성 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** 현재 활성 프롬프트 세트 파일을 삭제 (확인 후). 다른 세트로 자동 전환. */
  private async handleDeleteSet(): Promise<void> {
    if (!this.activePreset || !this.activePresetFile) {
      new Notice("삭제할 프롬프트 세트가 없습니다.");
      return;
    }
    const file = this.activePresetFile;
    const name = this.activePreset.meta.name || file.split("/").pop() || "세트";
    const confirmed = await new Promise<boolean>((resolve) => {
      new ConfirmModal(
        this.plugin.app,
        "프롬프트 세트 삭제",
        `"${name}" 세트를 삭제할까요? (되돌릴 수 없습니다)`,
        "삭제",
        (v) => resolve(v)
      ).open();
    });
    if (!confirmed) return;
    try {
      await this.plugin.store.deletePromptPreset(file);
      this.promptList = await this.plugin.store.getPromptPresets();
      const next = this.promptList[0] ?? null;
      if (next) {
        this.activePresetFile = next.presetFile;
        this.activePreset = next.preset;
        await this.plugin.patchActiveSettings(
          { promptSetId: next.preset.meta.id },
          this.activeSessionFile
        );
      } else {
        this.activePresetFile = null;
        this.activePreset = null;
      }
      this.renderSelector();
      this.renderBody();
      this.refreshFoldBtn();
      new Notice(`프롬프트 세트 삭제: ${name}`);
    } catch (err) {
      new Notice(
        `삭제 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** 현재 활성 모델이 텍스트 컴플리션인지. */
  private async activeModelIsText(): Promise<boolean> {
    const settings = await this.plugin.resolveActiveSettings(
      this.activeSessionFile
    );
    const profile = settings.modelProfileId
      ? this.plugin.ai.getProfileById(settings.modelProfileId)
      : this.plugin.ai.getDefaultGenerationProfile();
    return profile?.kind === "text";
  }

  private async handleOpenInTab(): Promise<void> {
    await this.plugin.openStellaDashboardTab("prompt");
  }

  private async handleExport(): Promise<void> {
    if (!this.activePresetFile) {
      new Notice("내보낼 프롬프트 세트가 없습니다.");
      return;
    }
    await exportPromptPreset(this.plugin, this.activePresetFile);
  }

  private async handleToggleEnabled(
    idx: number,
    enabled: boolean
  ): Promise<void> {
    if (!this.activePreset || !this.activePresetFile) return;
    this.activePreset.prompts[idx] = {
      ...this.activePreset.prompts[idx],
      enabled,
    };
    await this.save();
    this.renderBody();
  }

  private async handleNameEdit(idx: number, rawName: string): Promise<void> {
    if (!this.activePreset || !this.activePresetFile) return;
    const name = rawName.trim();
    if (!name || name === this.activePreset.prompts[idx].name) return;
    this.activePreset.prompts[idx] = {
      ...this.activePreset.prompts[idx],
      name,
    };
    await this.save();
    this.renderBody();
  }

  private async handleMarkerWrapEdit(
    idx: number,
    wrap: string | undefined,
    rerender: boolean
  ): Promise<void> {
    if (!this.activePreset || !this.activePresetFile) return;
    const item = this.activePreset.prompts[idx];
    if (item.kind !== "marker") return;
    if (item.wrap === wrap) return;
    const next = { ...item };
    if (wrap === undefined) delete next.wrap;
    else next.wrap = wrap;
    this.activePreset.prompts[idx] = next;
    await this.save();
    // 체크박스 토글일 때만 입력란 표시가 바뀌어 재렌더. blur 저장은 값만 바뀌니 포커스 보존.
    if (rerender) this.renderBody();
  }

  private async handleRoleEdit(idx: number, role: PromptRole): Promise<void> {
    if (!this.activePreset || !this.activePresetFile) return;
    const item = this.activePreset.prompts[idx];
    if (item.kind !== "text" || item.role === role) return;
    this.activePreset.prompts[idx] = { ...item, role };
    await this.save();
    this.renderBody();
  }

  private async handleContentEdit(
    idx: number,
    content: string
  ): Promise<void> {
    if (!this.activePreset || !this.activePresetFile) return;
    const item = this.activePreset.prompts[idx];
    if (item.kind !== "text" || content === item.content) return;
    this.activePreset.prompts[idx] = { ...item, content };
    await this.save();
  }

  private async handleChoiceChange(
    blockId: string,
    selectedIds: string[]
  ): Promise<void> {
    if (!this.activeSessionFile) {
      new Notice("선택 변수는 열린 세션에 저장됩니다.");
      return;
    }
    const session = await this.plugin.store.getSession(this.activeSessionFile);
    if (!session) return;
    session.meta.choiceValues = {
      ...(session.meta.choiceValues ?? {}),
      [blockId]: selectedIds,
    };
    this.choiceValues = { ...session.meta.choiceValues };
    await this.plugin.store.saveSession(this.activeSessionFile, session);
  }

  private async handleReorder(from: number, to: number): Promise<void> {
    if (!this.activePreset || !this.activePresetFile) return;
    const arr = [...this.activePreset.prompts];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    this.activePreset = { ...this.activePreset, prompts: arr };
    await this.save();
    this.renderBody();
  }

  private async handleAddItem(): Promise<void> {
    if (!this.activePreset || !this.activePresetFile) {
      new Notice("프롬프트 세트를 먼저 선택하거나 만드세요.");
      return;
    }
    const newItem: StellaPromptTextItem = {
      id: uuidv4(),
      kind: "text",
      identifier: uuidv4(),
      name: "새 프롬프트",
      role: "system",
      content: "",
      enabled: true,
    };
    this.activePreset = {
      ...this.activePreset,
      prompts: [...this.activePreset.prompts, newItem],
    };
    this.expandedItemIds.add(newItem.id);
    await this.save();
    this.renderBody();
    this.refreshFoldBtn();
  }

  private async handleDelete(idx: number, item: StellaPromptItem): Promise<void> {
    if (!this.activePreset || !this.activePresetFile) return;
    if (!isEmptyItem(item)) {
      const confirmed = await new Promise<boolean>((resolve) => {
        new ConfirmModal(
          this.plugin.app,
          "프롬프트 항목 삭제",
          `"${item.name || item.identifier}" 항목을 삭제할까요?`,
          "삭제",
          (v) => resolve(v)
        ).open();
      });
      if (!confirmed) return;
    }
    const arr = [...this.activePreset.prompts];
    arr.splice(idx, 1);
    this.expandedItemIds.delete(item.id);
    this.activePreset = { ...this.activePreset, prompts: arr };
    await this.save();
    this.renderBody();
    this.refreshFoldBtn();
  }

  private async save(): Promise<void> {
    if (!this.activePreset || !this.activePresetFile) return;
    this.savingSelf = true;
    try {
      await this.plugin.store.savePromptPreset(
        this.activePresetFile,
        this.activePreset
      );
    } catch (err) {
      new Notice(
        `프롬프트 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.savingSelf = false;
    }
  }
}

/** 빈 항목 = marker 는 항상 false (마커는 잃기 쉬워 항상 확인). text 는 이름 비고 content 도 비면 빈 항목. */
function isEmptyItem(item: StellaPromptItem): boolean {
  if (item.kind === "marker") return false;
  const t = item as StellaPromptTextItem;
  return (!t.name || t.name === "새 프롬프트") && !t.content?.trim();
}

/** 배열 재정렬 후 expanded index set 을 일관되게 이동. */
