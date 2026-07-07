import { Menu, Notice, setIcon } from "obsidian";
import type StellaEnginePlugin from "../../main";
import type { StellaStore } from "../../state/store";
import type { ActiveSettings, StellaPreset } from "../../types/preset";
import { uuidv4 } from "../../util/uuid";
import type { PresetListItem } from "../../util/scan-presets";
import { ConfirmModal, PromptModal } from "../modals";

const LONG_PRESS_MS = 500;

/**
 * PresetSection — 활성 설정을 한 번에 적용/저장하는 "북마크" 그리드.
 *
 *  - 클릭 → 활성 설정에 통째 적용 (`plugin.applyPreset`).
 *  - `+` → 이름 입력 모달 → 현재 활성 설정으로 새 PRESETS/<이름>.json 저장.
 *  - 길게 누르기 또는 우클릭 → 메뉴 (현재 설정으로 갱신 / 이름 변경 / 즐겨찾기 / 삭제).
 *
 * 프리셋 없이도 모델/파라미터/프롬프트는 정상 동작 — 단순 단축키.
 */
export class PresetSection {
  private root: HTMLElement;
  private headerEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private collapsed = false;

  private store: StellaStore;
  private list: PresetListItem[] = [];
  private activeId: string | undefined;
  private activeSessionFile: string | null;

  constructor(
    container: HTMLElement,
    private plugin: StellaEnginePlugin,
    activeSessionFile: string | null,
    private onAppliedActiveChanged?: () => void,
    collapsed = false
  ) {
    this.root = container.createDiv({ cls: "ggai-preset-section ggai-collapsible" });
    this.store = plugin.store;
    this.activeSessionFile = activeSessionFile;
    this.collapsed = collapsed;
    this.renderShell();
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  setCollapsed(v: boolean): void {
    if (v === this.collapsed) return;
    this.collapsed = v;
    this.bodyEl.toggleClass("is-collapsed", v);
    this.headerEl.setAttr("aria-expanded", String(!v));
  }

  async load(): Promise<void> {
    this.list = await this.store.getPresets();
    this.activeId = this.plugin.data.lastActivePresetId;
    this.render();
  }

  setActiveSessionFile(file: string | null): void {
    this.activeSessionFile = file;
  }

  async refresh(): Promise<void> {
    this.list = await this.store.getPresets();
    this.activeId = this.plugin.data.lastActivePresetId;
    this.render();
  }

  // ─── render ──────────────────────────────────────────────────────────

  private renderShell(): void {
    this.headerEl = this.root.createDiv({ cls: "ggai-section-header is-clickable" });
    this.headerEl.createSpan({ cls: "ggai-section-title", text: "프리셋" });
    this.headerEl.setAttr("role", "button");
    this.headerEl.setAttr("tabindex", "0");
    this.headerEl.setAttr("aria-expanded", String(!this.collapsed));
    const toggle = () => {
      this.collapsed = !this.collapsed;
      this.bodyEl.toggleClass("is-collapsed", this.collapsed);
      this.headerEl.setAttr("aria-expanded", String(!this.collapsed));
    };
    this.headerEl.addEventListener("click", toggle);
    this.headerEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    });
    this.bodyEl = this.root.createDiv({ cls: "ggai-preset-body" });
    this.bodyEl.toggleClass("is-collapsed", this.collapsed);
  }

  private render(): void {
    this.bodyEl.empty();
    const grid = this.bodyEl.createDiv({ cls: "ggai-preset-grid" });

    if (this.list.length === 0) {
      grid.createDiv({
        cls: "ggai-detail-empty",
        text: "프리셋이 없습니다. + 로 현재 설정을 저장하세요.",
      });
    } else {
      const sorted = [...this.list].sort(comparePresets);
      for (const item of sorted) {
        const btn = grid.createEl("button", {
          cls: "ggai-preset-btn",
          text: item.preset.name || "이름 없음",
        });
        if (item.preset.favorite) btn.addClass("is-favorite");
        if (item.preset.id === this.activeId) btn.addClass("is-active");
        btn.addEventListener("click", () => void this.handleApply(item));
        this.attachLongPressMenu(btn, item);
        // 우클릭 = 데스크탑 컨텍스트 메뉴
        btn.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.openItemMenu(item, e.clientX, e.clientY);
        });
      }
    }

    const addBtn = grid.createEl("button", {
      cls: "ggai-preset-btn ggai-preset-add",
      attr: { "aria-label": "현재 설정을 프리셋으로 저장" },
    });
    setIcon(addBtn, "plus");
    addBtn.addEventListener("click", () => void this.handleAdd());

    this.renderRotateToggle();
  }

  /** 생성(이어쓰기/재생성) 시 즐겨찾기 프리셋 중 하나를 무작위로 자동 적용하는 옵션 토글. */
  private renderRotateToggle(): void {
    const row = this.bodyEl.createDiv({ cls: "ggai-preset-rotate-row" });
    const label = row.createEl("label", { cls: "ggai-preset-rotate-label" });
    const cb = label.createEl("input", { attr: { type: "checkbox" } });
    cb.checked = this.plugin.data.presetRotationEnabled === true;
    label.createSpan({
      text: "생성 시 즐겨찾기 프리셋 랜덤 순환",
    });
    cb.addEventListener("change", () => {
      void this.plugin.savePluginData({ presetRotationEnabled: cb.checked });
    });
  }

  /** 길게 누르기 (모바일 친화) — 500ms 유지 시 메뉴. */
  private attachLongPressMenu(
    btn: HTMLElement,
    item: PresetListItem
  ): void {
    let timer: number | null = null;
    let triggered = false;
    const start = (x: number, y: number) => {
      triggered = false;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        triggered = true;
        timer = null;
        this.openItemMenu(item, x, y);
      }, LONG_PRESS_MS);
    };
    const cancel = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      start(e.clientX, e.clientY);
    });
    btn.addEventListener("mouseup", cancel);
    btn.addEventListener("mouseleave", cancel);
    btn.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      if (!t) return;
      start(t.clientX, t.clientY);
    });
    btn.addEventListener("touchend", cancel);
    btn.addEventListener("touchcancel", cancel);
    // long-press 후 click 이 발화하면 apply 가 일어나는데, 그건 막는다.
    btn.addEventListener("click", (e) => {
      if (triggered) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }

  private openItemMenu(item: PresetListItem, x: number, y: number): void {
    const menu = new Menu();
    menu.addItem((mi) =>
      mi
        .setTitle("현재 설정으로 갱신")
        .setIcon("refresh-cw")
        .onClick(() => void this.handleUpdateFromActive(item))
    );
    menu.addItem((mi) =>
      mi
        .setTitle("이름 변경")
        .setIcon("pencil")
        .onClick(() => void this.handleRename(item))
    );
    menu.addItem((mi) =>
      mi
        .setTitle(item.preset.favorite ? "즐겨찾기 해제" : "즐겨찾기")
        .setIcon(item.preset.favorite ? "star-off" : "star")
        .onClick(() => void this.handleToggleFavorite(item))
    );
    menu.addSeparator();
    menu.addItem((mi) =>
      mi
        .setTitle("삭제")
        .setIcon("trash-2")
        .onClick(() => void this.handleDelete(item))
    );
    menu.showAtPosition({ x, y });
  }

  private async handleApply(item: PresetListItem): Promise<void> {
    try {
      await this.plugin.applyPreset(item.preset, this.activeSessionFile);
    } catch (err) {
      console.error("[GGAI Stella] 프리셋 적용 실패:", err);
      new Notice(
        `프리셋 적용 실패: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    this.activeId = item.preset.id;
    this.render();
    this.onAppliedActiveChanged?.();
  }

  /** + 클릭 → 이름 입력 → 현재 활성 설정으로 새 프리셋 저장. */
  private async handleAdd(): Promise<void> {
    const name = await new Promise<string | null>((resolve) => {
      new PromptModal(
        this.plugin.app,
        "새 프리셋 이름",
        "예: 빠른 글쓰기",
        "프리셋",
        (v) => resolve(v)
      ).open();
    });
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const active: ActiveSettings = await this.plugin.resolveActiveSettings(
        this.activeSessionFile
      );
      const newPreset: StellaPreset = {
        id: uuidv4(),
        name: trimmed,
        favorite: false,
        modelProfileId: active.modelProfileId,
        params: active.params ? { ...active.params } : undefined,
        promptSetId: active.promptSetId,
        translation: active.translation ? { ...active.translation } : undefined,
        illustration: active.illustration ? { ...active.illustration } : undefined,
        summarize: active.summarize ? { ...active.summarize } : undefined,
        naiFormat: active.naiFormat,
        continueAnchor: active.continueAnchor,
      };
      const result = await this.store.createPreset(trimmed, newPreset);
      await this.plugin.savePluginData({ lastActivePresetId: newPreset.id });
      this.list = await this.store.getPresets();
      this.activeId = newPreset.id;
      this.render();
      new Notice(`프리셋 저장: ${result.presetFile.split("/").pop()}`);
    } catch (err) {
      console.error("[GGAI Stella] 프리셋 저장 실패:", err);
      new Notice(
        `프리셋 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async handleUpdateFromActive(item: PresetListItem): Promise<void> {
    try {
      const active = await this.plugin.resolveActiveSettings(this.activeSessionFile);
      const next: StellaPreset = {
        ...item.preset,
        modelProfileId: active.modelProfileId,
        params: active.params ? { ...active.params } : undefined,
        promptSetId: active.promptSetId,
        translation: active.translation ? { ...active.translation } : undefined,
        illustration: active.illustration ? { ...active.illustration } : undefined,
        summarize: active.summarize ? { ...active.summarize } : undefined,
        naiFormat: active.naiFormat,
        continueAnchor: active.continueAnchor,
      };
      await this.store.savePreset(item.presetFile, next);
      this.list = await this.store.getPresets();
      this.render();
      new Notice(`프리셋 갱신: ${item.preset.name}`);
    } catch (err) {
      new Notice(`갱신 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleRename(item: PresetListItem): Promise<void> {
    const name = await new Promise<string | null>((resolve) => {
      new PromptModal(
        this.plugin.app,
        "프리셋 이름 변경",
        "",
        item.preset.name,
        (v) => resolve(v)
      ).open();
    });
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === item.preset.name) return;
    try {
      const next: StellaPreset = { ...item.preset, name: trimmed };
      await this.store.savePreset(item.presetFile, next);
      this.list = await this.store.getPresets();
      this.render();
    } catch (err) {
      new Notice(`이름 변경 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleToggleFavorite(item: PresetListItem): Promise<void> {
    try {
      await this.store.togglePresetFavorite(item.presetFile);
      this.list = await this.store.getPresets();
      this.render();
    } catch (err) {
      new Notice(`즐겨찾기 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleDelete(item: PresetListItem): Promise<void> {
    const confirmed = await new Promise<boolean>((resolve) => {
      new ConfirmModal(
        this.plugin.app,
        "프리셋 삭제",
        `"${item.preset.name}" 프리셋을 삭제할까요? (활성 설정 자체는 그대로 유지됩니다.)`,
        "삭제",
        (v) => resolve(v)
      ).open();
    });
    if (!confirmed) return;
    try {
      await this.store.deletePreset(item.presetFile);
      if (this.activeId === item.preset.id) {
        await this.plugin.savePluginData({ lastActivePresetId: undefined });
        this.activeId = undefined;
      }
      this.list = await this.store.getPresets();
      this.render();
    } catch (err) {
      new Notice(`삭제 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function comparePresets(a: PresetListItem, b: PresetListItem): number {
  const fa = a.preset.favorite ? 0 : 1;
  const fb = b.preset.favorite ? 0 : 1;
  if (fa !== fb) return fa - fb;
  return (a.preset.name ?? "").localeCompare(b.preset.name ?? "");
}
