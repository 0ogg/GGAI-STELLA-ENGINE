import { Modal } from "obsidian";
import type StellaEnginePlugin from "../main";
import { createModalShell } from "./modal-shell";

/**
 * 시나리오 다중 선택 모달 — 체크박스로 시나리오(stella id)를 고른다.
 * SNS 참가 시나리오(폰 설정, 체크 해제 = 제외)에서 쓴다.
 * LorebookSelectModal 과 같은 골격/클래스 재사용. 확인 시 선택 id 배열 반환.
 */
export class ScenarioSelectModal extends Modal {
  private settled = false;
  private loaded = false;
  private selected: Set<string>;
  private candidateIds = new Set<string>();
  private rows: Array<{ name: string; el: HTMLElement }> = [];

  static open(
    plugin: StellaEnginePlugin,
    selectedIds: string[],
    opts?: { title?: string }
  ): Promise<string[] | null> {
    return new Promise((resolve) => {
      new ScenarioSelectModal(plugin, selectedIds, resolve, opts).open();
    });
  }

  private constructor(
    private readonly plugin: StellaEnginePlugin,
    selectedIds: string[],
    private readonly onResult: (ids: string[] | null) => void,
    private readonly opts?: { title?: string }
  ) {
    super(plugin.app);
    this.selected = new Set(selectedIds);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(this.opts?.title ?? "시나리오 선택");
    const { toolbar, body, footerMain } = createModalShell(this, "l", {
      toolbar: true,
    });

    const search = toolbar!.createEl("input", {
      cls: "ggai-form-input ggai-media-lorebook-search",
      attr: { type: "text", placeholder: "시나리오 검색…" },
    });
    const listEl = body.createDiv({
      cls: "ggai-lorebook-checklist ggai-lorebook-checklist-fill",
    });
    listEl.createDiv({ cls: "ggai-detail-empty", text: "불러오는 중…" });

    const cancelBtn = footerMain.createEl("button", { cls: "ggai-btn", text: "취소" });
    cancelBtn.addEventListener("click", () => this.settle(null));
    const confirmBtn = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "확인",
    });
    confirmBtn.addEventListener("click", () => this.confirm());

    const list = (await this.plugin.store.getScenarios().catch(() => [])).filter(
      (i) => i.scenario.data?.name?.trim() && i.scenario.data.extensions?.stella?.id
    );
    listEl.empty();
    if (list.length === 0) {
      listEl.createDiv({ cls: "ggai-detail-empty", text: "시나리오가 없습니다." });
      this.loaded = true;
      return;
    }

    for (const sc of list) {
      const id = sc.scenario.data.extensions!.stella!.id!;
      const name = sc.scenario.data.name!.trim();
      this.candidateIds.add(id);
      const row = listEl.createDiv({ cls: "ggai-lorebook-checklist-row" });
      const cb = row.createEl("input", {
        cls: "ggai-form-checkbox",
        type: "checkbox",
      });
      const sync = () => {
        cb.checked = this.selected.has(id);
      };
      sync();
      // 행 전체가 단일 토글 지점 (체크박스 클릭도 행으로 버블링).
      row.addEventListener("click", () => {
        if (this.selected.has(id)) this.selected.delete(id);
        else this.selected.add(id);
        sync();
      });
      row.createSpan({ cls: "ggai-lorebook-checklist-label", text: name });
      this.rows.push({ name, el: row });
    }
    this.loaded = true;

    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      for (const r of this.rows) {
        r.el.toggleClass("is-hidden", q.length > 0 && !r.name.toLowerCase().includes(q));
      }
    });
  }

  /** 확인 — 실제 표시된(=후보) 시나리오 중 선택된 것만 반환. */
  private confirm(): void {
    if (!this.loaded) {
      this.settle(null);
      return;
    }
    this.settle([...this.selected].filter((id) => this.candidateIds.has(id)));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.onResult(null);
  }

  private settle(ids: string[] | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onResult(ids);
    this.close();
  }
}
