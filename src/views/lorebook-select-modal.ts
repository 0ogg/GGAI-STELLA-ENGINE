import { Modal } from "obsidian";
import type StellaEnginePlugin from "../main";
import { createModalShell } from "./modal-shell";

/**
 * 로어북 다중 선택 모달 — 열 때 로어북 목록을 비동기 로딩하고 체크박스로 고른다.
 * 검색 입력으로 많아진 로어북도 빠르게 찾는다. 확인 시 선택된 meta.id 배열 반환.
 *
 * 번역/삽화 설정과 시나리오 탭(추가 로어북 / 세션 추가 로어북)에서 공통으로 쓴다.
 */
export class LorebookSelectModal extends Modal {
  private settled = false;
  private loaded = false;
  private selected: Set<string>;
  private candidateIds = new Set<string>();
  private rows: Array<{ name: string; el: HTMLElement }> = [];

  static open(
    plugin: StellaEnginePlugin,
    selectedIds: string[],
    opts?: { title?: string; excludeIds?: string[] }
  ): Promise<string[] | null> {
    return new Promise((resolve) => {
      new LorebookSelectModal(plugin, selectedIds, resolve, opts).open();
    });
  }

  private constructor(
    private readonly plugin: StellaEnginePlugin,
    selectedIds: string[],
    private readonly onResult: (ids: string[] | null) => void,
    private readonly opts?: { title?: string; excludeIds?: string[] }
  ) {
    super(plugin.app);
    this.selected = new Set(selectedIds);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(this.opts?.title ?? "로어북 선택");
    const { toolbar, body, footerMain } = createModalShell(this, "l", {
      toolbar: true,
    });

    const search = toolbar!.createEl("input", {
      cls: "ggai-form-input ggai-media-lorebook-search",
      attr: { type: "text", placeholder: "로어북 검색…" },
    });
    const listEl = body.createDiv({ cls: "ggai-lorebook-checklist ggai-lorebook-checklist-fill" });
    listEl.createDiv({ cls: "ggai-detail-empty", text: "불러오는 중…" });

    const cancelBtn = footerMain.createEl("button", { cls: "ggai-btn", text: "취소" });
    cancelBtn.addEventListener("click", () => this.settle(null));
    const confirmBtn = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "확인",
    });
    confirmBtn.addEventListener("click", () => this.confirm());

    const exclude = new Set(this.opts?.excludeIds ?? []);
    const list = (await this.plugin.store.getLorebooks()).filter(
      (l) => !exclude.has(l.lorebook.meta.id)
    );
    listEl.empty();
    if (list.length === 0) {
      listEl.createDiv({ cls: "ggai-detail-empty", text: "임포트된 로어북이 없습니다." });
      this.loaded = true;
      return;
    }

    for (const lb of list) {
      const id = lb.lorebook.meta.id;
      const name = lb.lorebook.meta.name || lb.folderName;
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
      // 행 전체가 단일 토글 지점 — 멤버십 기준으로 한 번만 뒤집는다.
      // (체크박스를 직접 눌러도 클릭은 행으로 버블링되어 여기서 처리)
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

  /** 확인 — 실제 표시된(=후보) 로어북 중 선택된 것만 반환. */
  private confirm(): void {
    if (!this.loaded) {
      this.settle(null); // 아직 로딩 전이면 변경 없이 닫는다.
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
