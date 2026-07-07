import { EventRef, Notice, setIcon } from "obsidian";
import type StellaEnginePlugin from "../../main";
import {
  MARKER_MACRO,
  type PromptRole,
  type StellaPromptItem,
  type StellaPromptMarkerItem,
  type StellaPromptPreset,
  type StellaPromptTextItem,
} from "../../types/prompt";
import { uuidv4 } from "../../util/uuid";
import { EditGuard } from "../edit-guard";
import { renderEditableTitle, renderIconActionButton } from "../editor-cover";
import { exportPromptPreset } from "../entity-actions";
import { ConfirmModal } from "../modals";

export interface PromptSetEditorSectionOpts {
  /** 삭제 후 편집 페이지를 벗어날 때(대시보드 뒤로가기). */
  onClose: () => void;
}

/**
 * 프롬프트 세트 편집기 — 대시보드 `프롬프트` 탭에서 세트 하나를 여는 편집 페이지.
 *
 * **세션과 무관하다.** 우측 디테일의 `PromptsSection` 은 "현재 세션의 활성 세트"를
 * 고르고 편집하는 세션 연동 화면이라, 그걸 재사용하면 대시보드에서 세트를 만질 때
 * 세션 설정까지 바뀐다. 이 편집기는 오직 지정한 세트 파일(`presetFile`)만
 * 읽고/쓰며, 활성 설정(promptSetId·naiFormat 등)에는 전혀 손대지 않는다.
 * 표시는 `PromptsSection` 과 같은 CSS 클래스를 써서 모양을 공유한다.
 */
export class PromptSetEditorSection {
  private root: HTMLElement;
  private bodyEl!: HTMLElement;
  private foldBtnEl: HTMLElement | null = null;
  private preset: StellaPromptPreset | null = null;
  private expandedItemIds = new Set<string>();
  private dragSourceIdx: number | null = null;
  /** 조합/포커스/자기저장 공용 가드 — 복붙 금지, edit-guard.ts 참조. */
  private guard = new EditGuard();
  private eventRef: EventRef | null = null;

  constructor(
    container: HTMLElement,
    private plugin: StellaEnginePlugin,
    private presetFile: string,
    private opts: PromptSetEditorSectionOpts
  ) {
    this.root = container.createDiv({
      cls: "ggai-prompt-set-editor ggai-editor-embed",
    });
    this.guard.attach(this.root);
  }

  async load(): Promise<void> {
    await this.reloadAndRender();
    this.eventRef = this.plugin.store.on(
      "prompt-preset-changed",
      (file: string) => {
        if (file !== this.presetFile) return;
        if (this.guard.isSavingSelf || this.guard.isEditing()) return;
        void this.reloadAndRender();
      }
    );
  }

  /** 라우트 이동/뷰 종료 시 — 구독 해제. 편집은 각 액션에서 즉시 저장돼 flush 불필요. */
  async dispose(): Promise<void> {
    if (this.eventRef) {
      this.plugin.store.offref(this.eventRef);
      this.eventRef = null;
    }
  }

  private async reloadAndRender(): Promise<void> {
    this.preset = await this.plugin.store.getPromptPreset(this.presetFile);
    this.render();
  }

  private render(): void {
    this.root.empty();
    const preset = this.preset;
    if (!preset) {
      this.root.createDiv({
        cls: "ggai-detail-empty",
        text: "프롬프트 세트를 찾을 수 없습니다.",
      });
      return;
    }

    const header = this.root.createDiv({ cls: "ggai-editor-header is-hero" });
    renderEditableTitle(
      header,
      preset.meta.name || this.presetFile.split("/").pop() || "프롬프트 세트",
      (next) => {
        preset.meta.name = next;
        void this.save();
        this.render();
      }
    );
    const actions = header.createDiv({ cls: "ggai-editor-actions" });
    renderIconActionButton(actions, {
      icon: "upload",
      label: "내보내기",
      onClick: () => void exportPromptPreset(this.plugin, this.presetFile),
    });
    renderIconActionButton(actions, {
      icon: "trash-2",
      label: "삭제",
      danger: true,
      onClick: () => this.handleDeleteSet(),
    });

    // 항목 툴바: (+ 항목 추가)(전부 접기/펼치기)
    const toolbar = this.root.createDiv({ cls: "ggai-prompts-toolbar" });
    const add = toolbar.createEl("button", {
      cls: "ggai-prompts-tb-btn ggai-prompts-tb-text",
    });
    setIcon(add, "plus");
    add.createSpan({ text: "항목 추가" });
    add.addEventListener("click", () => void this.handleAddItem());
    this.foldBtnEl = toolbar.createEl("button", {
      cls: "ggai-prompts-tb-btn",
    });
    this.foldBtnEl.addEventListener("click", () => this.toggleFoldAll());

    this.bodyEl = this.root.createDiv({ cls: "ggai-prompts-content" });
    this.renderBody();
    this.refreshFoldBtn();
  }

  // ─── body (prompt list) ──────────────────────────────────────────

  private renderBody(): void {
    this.bodyEl.empty();
    const preset = this.preset;
    if (!preset) return;
    const list = this.bodyEl.createDiv({ cls: "ggai-prompts-list" });
    for (let i = 0; i < preset.prompts.length; i++) {
      this.renderItem(list, preset.prompts[i], i);
    }
  }

  private refreshFoldBtn(): void {
    if (!this.foldBtnEl) return;
    const items = this.preset?.prompts ?? [];
    const allExpanded =
      items.length > 0 && items.every((it) => this.expandedItemIds.has(it.id));
    setIcon(this.foldBtnEl, allExpanded ? "chevrons-down-up" : "chevrons-up-down");
    const label = allExpanded ? "전부 접기" : "전부 펼치기";
    this.foldBtnEl.setAttribute("aria-label", label);
    this.foldBtnEl.setAttribute("title", label);
  }

  private toggleFoldAll(): void {
    const items = this.preset?.prompts ?? [];
    const allExpanded =
      items.length > 0 && items.every((it) => this.expandedItemIds.has(it.id));
    if (allExpanded) for (const it of items) this.expandedItemIds.delete(it.id);
    else for (const it of items) this.expandedItemIds.add(it.id);
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

    const row = wrapper.createDiv({ cls: "ggai-prompt-row" });
    row.draggable = true;
    this.bindDrag(wrapper, row, idx);
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".ggai-prompt-toggle")) return;
      if (this.expandedItemIds.has(item.id)) this.expandedItemIds.delete(item.id);
      else this.expandedItemIds.add(item.id);
      this.renderBody();
      this.refreshFoldBtn();
    });

    // Toggle switch
    const toggle = row.createEl("label", { cls: "ggai-prompt-toggle" });
    toggle.addEventListener("click", (e) => e.stopPropagation());
    const cb = toggle.createEl("input", {
      attr: { type: "checkbox" },
    }) as HTMLInputElement;
    cb.checked = item.enabled;
    cb.addEventListener("change", () =>
      void this.handleToggleEnabled(idx, cb.checked)
    );
    toggle.createSpan({ cls: "ggai-prompt-toggle-track" });

    row.createDiv({
      cls: "ggai-prompt-name",
      text: item.name || (item.kind === "marker" ? item.identifier : "이름 없음"),
    });

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

    const caret = row.createDiv({ cls: "ggai-prompt-caret" });
    setIcon(caret, expanded ? "chevron-up" : "chevron-down");

    if (expanded) this.renderEditPanel(wrapper, item, idx);
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
    const ta = taRow.createEl("textarea", { cls: "ggai-prompt-content-ta" });
    ta.value = item.content ?? "";
    ta.rows = 6;
    ta.placeholder = "프롬프트 내용...";
    ta.addEventListener("blur", () => void this.handleContentEdit(idx, ta.value));

    this.appendDeleteRow(panel, item, idx);
  }

  private appendNameField(panel: HTMLElement, name: string, idx: number): void {
    const row = panel.createDiv({ cls: "ggai-prompt-edit-row" });
    row.createSpan({ cls: "ggai-prompt-edit-label", text: "이름" });
    const input = row.createEl("input", {
      cls: "ggai-prompt-edit-input",
    }) as HTMLInputElement;
    input.type = "text";
    input.value = name;
    input.addEventListener("blur", () => void this.handleNameEdit(idx, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    });
  }

  private appendMarkerWrapField(
    panel: HTMLElement,
    item: StellaPromptMarkerItem,
    idx: number
  ): void {
    const macro = MARKER_MACRO[item.identifier];
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
      text: `${macro} 자리에 이 항목 내용이 들어갑니다. 매크로를 지우면 내용이 맨 뒤에 붙습니다. 앞뒤 줄바꿈은 자동으로 넣지 않습니다.`,
    });

    cb.addEventListener("change", () => {
      void this.handleMarkerWrapEdit(idx, cb.checked ? macro : undefined, true);
    });
  }

  private appendDeleteRow(
    panel: HTMLElement,
    item: StellaPromptItem,
    idx: number
  ): void {
    const row = panel.createDiv({ cls: "ggai-prompt-edit-actions" });
    const del = row.createEl("button", { cls: "ggai-prompt-edit-del" });
    setIcon(del, "trash-2");
    del.createSpan({ text: "삭제" });
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleDelete(idx, item);
    });
  }

  // ─── drag-and-drop ───────────────────────────────────────────────

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
    wrapper.addEventListener("dragleave", () => wrapper.removeClass("drag-over"));
    wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      wrapper.removeClass("drag-over");
      if (this.dragSourceIdx === null || this.dragSourceIdx === idx) return;
      void this.handleReorder(this.dragSourceIdx, idx);
    });
  }

  // ─── handlers (파일 전용 저장) ──────────────────────────────────

  private async handleToggleEnabled(idx: number, enabled: boolean): Promise<void> {
    if (!this.preset) return;
    this.preset.prompts[idx] = { ...this.preset.prompts[idx], enabled };
    await this.save();
    this.renderBody();
  }

  private async handleNameEdit(idx: number, rawName: string): Promise<void> {
    if (!this.preset) return;
    const name = rawName.trim();
    if (!name || name === this.preset.prompts[idx].name) return;
    this.preset.prompts[idx] = { ...this.preset.prompts[idx], name };
    await this.save();
    this.renderBody();
  }

  private async handleMarkerWrapEdit(
    idx: number,
    wrap: string | undefined,
    rerender: boolean
  ): Promise<void> {
    if (!this.preset) return;
    const item = this.preset.prompts[idx];
    if (item.kind !== "marker" || item.wrap === wrap) return;
    const next = { ...item };
    if (wrap === undefined) delete next.wrap;
    else next.wrap = wrap;
    this.preset.prompts[idx] = next;
    await this.save();
    if (rerender) this.renderBody();
  }

  private async handleRoleEdit(idx: number, role: PromptRole): Promise<void> {
    if (!this.preset) return;
    const item = this.preset.prompts[idx];
    if (item.kind !== "text" || item.role === role) return;
    this.preset.prompts[idx] = { ...item, role };
    await this.save();
    this.renderBody();
  }

  private async handleContentEdit(idx: number, content: string): Promise<void> {
    if (!this.preset) return;
    const item = this.preset.prompts[idx];
    if (item.kind !== "text" || content === item.content) return;
    this.preset.prompts[idx] = { ...item, content };
    await this.save();
  }

  private async handleReorder(from: number, to: number): Promise<void> {
    if (!this.preset) return;
    const arr = [...this.preset.prompts];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    this.preset = { ...this.preset, prompts: arr };
    await this.save();
    this.renderBody();
  }

  private async handleAddItem(): Promise<void> {
    if (!this.preset) return;
    const newItem: StellaPromptTextItem = {
      id: uuidv4(),
      kind: "text",
      identifier: uuidv4(),
      name: "새 프롬프트",
      role: "system",
      content: "",
      enabled: true,
    };
    this.preset = { ...this.preset, prompts: [...this.preset.prompts, newItem] };
    this.expandedItemIds.add(newItem.id);
    await this.save();
    this.renderBody();
    this.refreshFoldBtn();
  }

  private async handleDelete(idx: number, item: StellaPromptItem): Promise<void> {
    if (!this.preset) return;
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
    const arr = [...this.preset.prompts];
    arr.splice(idx, 1);
    this.expandedItemIds.delete(item.id);
    this.preset = { ...this.preset, prompts: arr };
    await this.save();
    this.renderBody();
    this.refreshFoldBtn();
  }

  private handleDeleteSet(): void {
    const preset = this.preset;
    if (!preset) return;
    const name = preset.meta.name || this.presetFile.split("/").pop() || "세트";
    new ConfirmModal(
      this.plugin.app,
      "프롬프트 세트 삭제",
      `"${name}" 세트를 삭제할까요? (되돌릴 수 없습니다)`,
      "삭제",
      (confirmed) => {
        if (!confirmed) return;
        void (async () => {
          try {
            await this.plugin.store.deletePromptPreset(this.presetFile);
            new Notice(`프롬프트 세트 삭제: ${name}`);
            this.opts.onClose();
          } catch (err) {
            new Notice(
              `삭제 실패: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })();
      }
    ).open();
  }

  /** 이 세트 파일에만 저장한다 — 활성 설정/세션에는 손대지 않는다. */
  private async save(): Promise<void> {
    if (!this.preset) return;
    const preset = this.preset;
    try {
      await this.guard.runSave(() =>
        this.plugin.store.savePromptPreset(this.presetFile, preset)
      );
    } catch (err) {
      new Notice(
        `프롬프트 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/** 빈 항목 = marker 는 항상 확인. text 는 이름 비고 content 도 비면 빈 항목. */
function isEmptyItem(item: StellaPromptItem): boolean {
  if (item.kind === "marker") return false;
  const t = item as StellaPromptTextItem;
  return (!t.name || t.name === "새 프롬프트") && !t.content?.trim();
}
