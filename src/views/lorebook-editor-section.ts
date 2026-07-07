import { EventRef, Notice, setIcon } from "obsidian";
import type StellaEnginePlugin from "../main";
import {
  StellaLorebook,
  StellaLorebookEntry,
  defaultLorebookEntry,
} from "../types/lorebook";
import { uuidv4 } from "../util/uuid";
import {
  renderEditableTitle,
  renderEditorCover,
  renderIconActionButton,
} from "./editor-cover";
import { EditGuard } from "./edit-guard";
import { FieldDef, renderForm } from "./form-renderer";
import { ConfirmModal } from "./modals";

const SAVE_DEBOUNCE_MS = 400;

export interface LorebookEditorSectionOpts {
  /** 삭제 후 편집 페이지를 벗어날 때(대시보드 뒤로가기 등). */
  onClose: () => void;
}

/**
 * 로어북 편집기 — 대시보드 내부 페이지로 임베드되는 편집 섹션.
 *
 * 예전 LorebookEditorView(별도 뷰) 의 편집/자동 저장 로직을 그대로 옮기되, 상단 nav 는
 * 대시보드가 소유하므로 여기서 그리지 않는다. 라우트 이동/뷰 종료 시 dispose() 가
 * 구독 해제 + 미저장 편집 flush 를 책임진다 (UserEditorSection 과 같은 임베드 패턴).
 *
 *  - 책 메타 폼 (이름/설명).
 *  - 엔트리 카드 목록 (이름 + 키워드 미리보기 + enabled 토글). 펼치면 엔트리 폼.
 *  - 엔트리 추가/삭제. 순서 변경(위/아래).
 */
export class LorebookEditorSection {
  private root: HTMLElement;
  private lorebookFile: string | null;
  private book: StellaLorebook | null = null;
  private expanded = new Set<string>(); // entry uid 들

  private metaEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  private saveTimer: number | null = null;
  private dirty = false;
  /** 조합/포커스/자기저장 공용 가드 — 복붙 금지, edit-guard.ts 참조. */
  private guard = new EditGuard();
  private eventRef: EventRef | null = null;

  private isEditing(): boolean {
    return this.guard.isEditing();
  }

  private visibilityHandler = (): void => {
    if (document.visibilityState === "hidden") void this.flushNow();
    else if (!this.dirty && !this.isEditing()) void this.reloadAndRender();
  };
  private blurHandler = (): void => void this.flushNow();
  private focusHandler = (): void => {
    if (!this.dirty && !this.isEditing()) void this.reloadAndRender();
  };

  constructor(
    container: HTMLElement,
    private plugin: StellaEnginePlugin,
    lorebookFile: string,
    private opts: LorebookEditorSectionOpts
  ) {
    this.root = container.createDiv({
      cls: "ggai-lorebook-editor ggai-editor-embed",
    });
    this.lorebookFile = lorebookFile;
    // root 는 renderShell() 에서 empty() 될 뿐 교체되지 않아 리스너가 살아남는다.
    this.guard.attach(this.root);
  }

  async load(): Promise<void> {
    await this.reloadAndRender();
    this.eventRef = this.plugin.store.on(
      "lorebook-changed",
      (file: string) => {
        if (file !== this.lorebookFile || this.dirty || this.guard.isSavingSelf)
          return;
        if (this.isEditing()) return;
        void this.reloadAndRender();
      }
    );
    document.addEventListener("visibilitychange", this.visibilityHandler);
    window.addEventListener("blur", this.blurHandler);
    window.addEventListener("focus", this.focusHandler);
  }

  /** 라우트 이동/뷰 종료 시 호출 — 구독 해제 + 미저장 편집 확정. */
  async dispose(): Promise<void> {
    if (this.eventRef) {
      this.plugin.store.offref(this.eventRef);
      this.eventRef = null;
    }
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    window.removeEventListener("blur", this.blurHandler);
    window.removeEventListener("focus", this.focusHandler);
    await this.flushNow();
  }

  private async reloadAndRender(): Promise<void> {
    if (!this.lorebookFile) {
      this.book = null;
      this.renderShell();
      return;
    }
    this.book = await this.plugin.store.refreshLorebook(this.lorebookFile);
    this.dirty = false;
    this.renderShell();
  }

  // ─── render ─────────────────────────────────────────────────

  private renderShell(): void {
    this.root.empty();
    this.metaEl = null;
    this.listEl = null;

    if (!this.book) {
      this.root.createDiv({
        cls: "ggai-detail-empty",
        text: this.lorebookFile
          ? "로어북을 불러올 수 없습니다."
          : "로어북을 선택하세요.",
      });
      return;
    }

    const header = this.root.createDiv({ cls: "ggai-editor-header is-hero" });
    this.renderCover(header);
    renderEditableTitle(header, this.book.meta.name || "Lorebook", (next) => {
      if (this.book) this.book.meta.name = next;
      this.queueSave();
      this.renderShell();
    });

    const actions = header.createDiv({ cls: "ggai-editor-actions" });
    renderIconActionButton(actions, {
      icon: "copy",
      label: "복제",
      onClick: () => void this.handleDuplicate(),
    });
    renderIconActionButton(actions, {
      icon: "trash-2",
      label: "삭제",
      danger: true,
      onClick: () => this.handleDelete(),
    });

    this.metaEl = this.root.createDiv({ cls: "ggai-lorebook-meta" });
    this.renderMeta();

    const entriesHeader = this.root.createDiv({
      cls: "ggai-lorebook-entries-header",
    });
    entriesHeader.createSpan({
      cls: "ggai-section-title",
      text: `엔트리 (${this.book.entries.length})`,
    });
    const addBtn = entriesHeader.createEl("button", {
      cls: "ggai-btn",
      text: "+ 엔트리 추가",
    });
    addBtn.addEventListener("click", () => void this.handleAddEntry());

    this.listEl = this.root.createDiv({ cls: "ggai-lorebook-entries" });
    this.renderEntries();
  }

  private renderMeta(): void {
    const wrap = this.metaEl;
    const book = this.book;
    if (!wrap || !book) return;
    wrap.empty();

    const defs: FieldDef[] = [
      // 이름은 상단 헤더(클릭 편집)에서 다룬다.
      { kind: "text", key: "description", label: "설명", rows: 2 },
    ];
    renderForm(
      wrap,
      defs,
      book.meta as any,
      (key, value) => {
        (book.meta as any)[key] = value;
        this.queueSave();
      },
      () => void this.flushNow()
    );
  }

  private renderCover(parent: HTMLElement): void {
    const book = this.book;
    if (!book || !this.lorebookFile) return;
    const folder = this.lorebookFile.replace(/\/lorebook\.json$/, "");
    const path = book.meta.thumbnail ? `${folder}/${book.meta.thumbnail}` : null;
    renderEditorCover(this.plugin.app, parent, {
      imagePath: path,
      altText: book.meta.name,
      fallbackIcon: "book-open",
      onPick: async (bytes, ext) => {
        if (!this.lorebookFile) return;
        try {
          await this.plugin.store.setLorebookThumbnail(
            this.lorebookFile,
            bytes,
            ext
          );
          await this.reloadAndRender();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`표지 저장 실패: ${msg}`);
        }
      },
    });
  }

  private renderEntries(): void {
    const wrap = this.listEl;
    const book = this.book;
    if (!wrap || !book) return;
    wrap.empty();

    if (book.entries.length === 0) {
      wrap.createDiv({
        cls: "ggai-detail-empty",
        text: "엔트리가 없습니다. [+ 엔트리 추가] 로 시작하세요.",
      });
      return;
    }

    book.entries.forEach((entry, idx) => this.renderEntryCard(wrap, entry, idx));
  }

  private renderEntryCard(
    parent: HTMLElement,
    entry: StellaLorebookEntry,
    idx: number
  ): void {
    const book = this.book;
    if (!book) return;

    const card = parent.createDiv({ cls: "ggai-entry-card" });
    const isExpanded = this.expanded.has(entry.uid);
    if (isExpanded) card.addClass("is-expanded");

    // 헤더 (접힘 상태에서도 항상 보임)
    const header = card.createDiv({ cls: "ggai-entry-header" });

    const toggle = header.createEl("button", {
      cls: "ggai-entry-toggle ggai-icon-btn",
    });
    setIcon(toggle, isExpanded ? "chevron-down" : "chevron-right");
    toggle.setAttr("aria-label", isExpanded ? "엔트리 접기" : "엔트리 펼치기");
    toggle.setAttr("aria-expanded", String(isExpanded));
    const toggleEntry = () => {
      if (isExpanded) this.expanded.delete(entry.uid);
      else this.expanded.add(entry.uid);
      this.renderEntries();
    };
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleEntry();
    });

    const enableCb = header.createEl("input", {
      cls: "ggai-form-checkbox",
      type: "checkbox",
    });
    enableCb.checked = entry.enabled !== false;
    enableCb.addEventListener("click", (e) => e.stopPropagation());
    enableCb.addEventListener("change", () => {
      entry.enabled = enableCb.checked;
      this.queueSave();
    });

    const nameEl = header.createSpan({
      cls: "ggai-entry-name",
      text: entry.name || "(이름 없음)",
    });
    nameEl.setAttr("role", "button");
    nameEl.setAttr("tabindex", "0");
    nameEl.setAttr("aria-expanded", String(isExpanded));
    nameEl.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleEntry();
    });
    nameEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggleEntry();
    });

    const keywordPreview =
      entry.keys.length > 0 ? entry.keys.slice(0, 3).join(", ") : "(키워드 없음)";
    header.createSpan({
      cls: "ggai-entry-keyword-preview",
      text: keywordPreview + (entry.keys.length > 3 ? " …" : ""),
    });

    // 액션 버튼 (위/아래/삭제)
    const actions = header.createDiv({ cls: "ggai-entry-actions" });
    const upBtn = actions.createEl("button", { cls: "ggai-btn ggai-btn-small" });
    setIcon(upBtn, "arrow-up");
    upBtn.setAttr("aria-label", "위로 이동");
    upBtn.disabled = idx === 0;
    upBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.moveEntry(idx, -1);
    });
    const downBtn = actions.createEl("button", {
      cls: "ggai-btn ggai-btn-small",
    });
    setIcon(downBtn, "arrow-down");
    downBtn.setAttr("aria-label", "아래로 이동");
    downBtn.disabled = idx === book.entries.length - 1;
    downBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.moveEntry(idx, 1);
    });
    const delBtn = actions.createEl("button", {
      cls: "ggai-btn ggai-btn-small ggai-btn-danger",
      text: "삭제",
    });
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deleteEntry(idx);
    });

    if (isExpanded) {
      const body = card.createDiv({ cls: "ggai-entry-body" });
      this.renderEntryForm(body, entry);
    }
  }

  private renderEntryForm(parent: HTMLElement, entry: StellaLorebookEntry): void {
    // 핵심 필드
    const coreDefs: FieldDef[] = [
      { kind: "text", key: "name", label: "이름 / 메모" },
      {
        kind: "tags",
        key: "keys",
        label: "키워드",
        hint: "본문에서 이 단어가 발견되면 활성화. 콤마로 구분.",
      },
      { kind: "checkbox", key: "constant", label: "항상 활성 (키워드 무시)" },
      {
        kind: "text",
        key: "content",
        label: "내용",
        rows: 8,
        placeholder: "이 엔트리가 활성화되면 컨텍스트에 들어갈 본문",
      },
      {
        kind: "select",
        key: "position",
        label: "삽입 위치",
        options: [
          { value: "before_char", label: "캐릭터 정의 앞" },
          { value: "after_char", label: "캐릭터 정의 뒤 (기본)" },
          { value: "before_examples", label: "예시 대화 앞" },
          { value: "after_examples", label: "예시 대화 뒤" },
          { value: "at_depth", label: "메시지 깊이 지정" },
        ],
      },
      {
        kind: "number",
        key: "depth",
        label: "깊이",
        min: 0,
        hint: "0 = 가장 최근 메시지 직전.",
        visibleWhen: (v) => v.position === "at_depth",
      },
      {
        kind: "select",
        key: "role",
        label: "역할",
        options: [
          { value: "system", label: "system" },
          { value: "user", label: "user" },
          { value: "assistant", label: "assistant" },
        ],
        visibleWhen: (v) => v.position === "at_depth",
      },
      {
        kind: "number",
        key: "order",
        label: "정렬 우선순위",
        hint: "큰 값이 먼저.",
      },
      {
        kind: "number",
        key: "probability",
        label: "확률 (0-100)",
        min: 0,
        max: 100,
      },
    ];

    // 보조 키워드 (selective 일 때만 노출 — 본문에 키워드와 보조키워드 모두 있어야 활성)
    const secondaryDefs: FieldDef[] = [
      { kind: "checkbox", key: "selective", label: "보조 키워드 사용" },
      {
        kind: "tags",
        key: "secondaryKeys",
        label: "보조 키워드",
        hint: "키워드와 함께 발견되어야 활성.",
        visibleWhen: (v) => v.selective === true,
      },
    ];

    // 고급 (접힘)
    const advancedDefs: FieldDef[] = [
      { kind: "checkbox", key: "useRegex", label: "키워드를 정규식으로 해석" },
      { kind: "checkbox", key: "matchWholeWords", label: "단어 전체 매칭" },
      { kind: "checkbox", key: "caseSensitive", label: "대소문자 구분" },
      {
        kind: "number",
        key: "scanDepth",
        label: "스캔 깊이",
        nullable: true,
        min: 0,
        hint: "비워두면 전역 설정. 최근 N개 메시지만 키워드 스캔.",
      },
      { kind: "checkbox", key: "preventRecursion", label: "재귀 차단" },
      { kind: "checkbox", key: "excludeRecursion", label: "재귀에서 제외" },
      {
        kind: "checkbox",
        key: "delayUntilRecursion",
        label: "재귀 후에만 활성",
      },
      { kind: "number", key: "sticky", label: "지속" },
      { kind: "number", key: "cooldown", label: "쿨다운" },
      { kind: "number", key: "delay", label: "지연" },
      { kind: "text", key: "group", label: "그룹" },
      { kind: "number", key: "groupWeight", label: "그룹 가중치" },
    ];

    const onChange = (key: string, value: any) => {
      (entry as any)[key] = value;
      this.queueSave();
    };
    const onCommit = () => void this.flushNow();

    renderForm(parent, coreDefs, entry as any, onChange, onCommit);
    renderForm(parent, secondaryDefs, entry as any, onChange, onCommit);

    // 고급 섹션 — collapsible
    const advWrap = parent.createDiv({ cls: "ggai-collapsible" });
    const advHeader = advWrap.createDiv({
      cls: "ggai-section-header is-clickable",
    });
    advHeader.createSpan({ cls: "ggai-section-title", text: "고급" });
    const advBody = advWrap.createDiv({ cls: "ggai-form-advanced is-collapsed" });
    advHeader.setAttr("role", "button");
    advHeader.setAttr("tabindex", "0");
    advHeader.setAttr("aria-expanded", "false");
    const toggleAdvanced = () => {
      const collapsed = !advBody.hasClass("is-collapsed");
      advBody.toggleClass("is-collapsed", collapsed);
      advHeader.setAttr("aria-expanded", String(!collapsed));
    };
    advHeader.addEventListener("click", toggleAdvanced);
    advHeader.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggleAdvanced();
    });
    renderForm(advBody, advancedDefs, entry as any, onChange, onCommit);
  }

  // ─── entry CRUD ─────────────────────────────────────────────

  private async handleAddEntry(): Promise<void> {
    if (!this.book) return;
    const entry = defaultLorebookEntry(this.book.meta._source ?? "sillytavern");
    entry.uid = uuidv4();
    entry.name = "새 엔트리";
    this.book.entries.push(entry);
    this.expanded.add(entry.uid); // 추가 즉시 펼침
    this.renderShell();
    this.queueSave();
  }

  private moveEntry(idx: number, delta: -1 | 1): void {
    if (!this.book) return;
    const next = idx + delta;
    if (next < 0 || next >= this.book.entries.length) return;
    const arr = this.book.entries;
    [arr[idx], arr[next]] = [arr[next], arr[idx]];
    this.renderEntries();
    this.queueSave();
  }

  private deleteEntry(idx: number): void {
    if (!this.book) return;
    const entry = this.book.entries[idx];
    if (!entry) return;
    this.book.entries.splice(idx, 1);
    this.expanded.delete(entry.uid);
    this.renderShell();
    this.queueSave();
  }

  // ─── save ───────────────────────────────────────────────────

  private queueSave(): void {
    this.dirty = true;
    if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private async flushNow(): Promise<void> {
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.book || !this.lorebookFile) return;
    const file = this.lorebookFile;
    const book = this.book;
    try {
      await this.guard.runSave(() => this.plugin.store.saveLorebook(file, book));
      this.dirty = false;
    } catch (err) {
      console.warn("[GGAI Stella] 로어북 저장 실패:", err);
      new Notice(
        `저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async handleDuplicate(): Promise<void> {
    if (!this.lorebookFile) return;
    await this.flushNow();
    try {
      const result = await this.plugin.store.copyLorebook(this.lorebookFile);
      await this.plugin.openStellaEditor("lorebook", result.lorebookFile);
      new Notice("로어북 복사 완료");
    } catch (err) {
      new Notice(
        `로어북 복사 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private handleDelete(): void {
    if (!this.lorebookFile || !this.book) return;
    const folder = this.lorebookFile.replace(/\/lorebook\.json$/, "");
    new ConfirmModal(
      this.plugin.app,
      "로어북 삭제",
      `"${this.book.meta.name || "이 로어북"}" 폴더를 휴지통으로 옮깁니다. 이 책을 참조하는 시나리오/세션의 연결은 끊깁니다. 계속할까요?`,
      "삭제",
      (confirmed) => {
        if (!confirmed) return;
        void (async () => {
          try {
            this.dirty = false;
            await this.plugin.store.deleteLorebook(folder);
            new Notice(`삭제됨: ${folder} · 휴지통에서 복구할 수 있어요`);
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
}
