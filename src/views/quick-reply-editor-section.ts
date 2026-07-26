/**
 * 빠른 답장(QR) 버튼 편집 페이지 — 대시보드 내부 편집 라우트.
 *
 * 실리태번 QR 편집기가 복잡한 주원인은 자동실행 체크박스 8개를 평면으로 깔고
 * 하위 메뉴 편집을 그 사이에 파묻은 것이다. 여기서는
 *   표시 → 동작 → (접힘) 자동 실행 시점 → (접힘) 하위 메뉴
 * 순서로 접어 두고, 접힌 줄에는 요약만 보여 준다. 상세는 `QR 스펙.md`.
 *
 * 저장 규약(회귀금지.md): 모델 반영은 input 에서 즉시, 디스크 저장은 debounce +
 * blur + dispose + visibilitychange/window blur. "blur 에서만 저장" 금지.
 */

import { Notice, Platform, setIcon } from "obsidian";
import type StellaEnginePlugin from "../main";
import {
  AUTO_EXECUTE_FLAGS,
  describeQuickReply,
  type AutoExecuteFlagKey,
  type StellaQuickReply,
  type StellaQuickReplySet,
} from "../types/quick-reply";
import type { QuickReplyListItem } from "../util/scan-quick-replies";
import { EditGuard } from "./edit-guard";
import { ConfirmModal } from "./modals";

const SAVE_DEBOUNCE_MS = 600;

export interface QuickReplyEditorOptions {
  onClose: () => void;
}

export class QuickReplyEditorSection {
  private host: HTMLElement;
  private plugin: StellaEnginePlugin;
  private setFile: string;
  private itemId: number;
  private opts: QuickReplyEditorOptions;

  private set: StellaQuickReplySet | null = null;
  private qr: StellaQuickReply | null = null;
  private allSets: QuickReplyListItem[] = [];

  private guard = new EditGuard();
  private saveTimer: number | null = null;
  private dirty = false;
  private disposed = false;

  private bodyEl: HTMLElement | null = null;
  private modeHintEl: HTMLElement | null = null;
  private messageEl: HTMLTextAreaElement | null = null;
  private autoSummaryEl: HTMLElement | null = null;
  private subSummaryEl: HTMLElement | null = null;

  private onWindowBlur = (): void => void this.flush();
  private onVisibility = (): void => {
    if (document.visibilityState === "hidden") void this.flush();
  };

  constructor(
    host: HTMLElement,
    plugin: StellaEnginePlugin,
    setFile: string,
    itemId: number,
    opts: QuickReplyEditorOptions
  ) {
    this.host = host;
    this.plugin = plugin;
    this.setFile = setFile;
    this.itemId = itemId;
    this.opts = opts;
  }

  async load(): Promise<void> {
    this.guard.attach(this.host);
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("visibilitychange", this.onVisibility);

    this.set = await this.plugin.store.getQuickReplySet(this.setFile);
    this.allSets = await this.plugin.store.getQuickReplySets();
    this.qr = this.set?.qrList.find((q) => q.id === this.itemId) ?? null;
    this.render();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    window.removeEventListener("blur", this.onWindowBlur);
    document.removeEventListener("visibilitychange", this.onVisibility);
    await this.flush();
  }

  // ─── 저장 ────────────────────────────────────────────────────────

  /** 모델이 바뀌었음을 표시하고 debounce 저장을 건다. */
  private touch(): void {
    this.dirty = true;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (!this.dirty || !this.set) return;
    this.dirty = false;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await this.guard.runSave(() =>
        this.plugin.store.saveQuickReplySet(this.setFile, this.set!)
      );
    } catch (err) {
      console.warn("[GGAI Stella] QR 저장 실패:", err);
      new Notice("빠른 답장 저장 실패");
    }
  }

  // ─── 렌더 ────────────────────────────────────────────────────────

  private render(): void {
    this.host.empty();
    const body = this.host.createDiv({ cls: "ggai-qr-editor" });
    this.bodyEl = body;

    if (!this.set || !this.qr) {
      body.createDiv({
        cls: "ggai-qr-empty",
        text: "이 버튼을 찾을 수 없습니다. 삭제되었을 수 있어요.",
      });
      return;
    }
    const qr = this.qr;

    // ── 표시 ──
    this.sectionLabel(body, "표시");
    const displayRow = body.createDiv({ cls: "ggai-qr-row" });
    const iconInput = displayRow.createEl("input", {
      cls: "ggai-qr-icon-input",
      attr: { type: "text", placeholder: "아이콘", "aria-label": "아이콘" },
    });
    iconInput.value = qr.icon;
    iconInput.addEventListener("input", () => {
      qr.icon = iconInput.value;
      this.touch();
    });
    iconInput.addEventListener("blur", () => void this.flush());

    const labelInput = displayRow.createEl("input", {
      cls: "ggai-qr-label-input",
      attr: { type: "text", placeholder: "버튼 이름", "aria-label": "버튼 이름" },
    });
    labelInput.value = qr.label;
    labelInput.addEventListener("input", () => {
      qr.label = labelInput.value;
      this.touch();
    });
    labelInput.addEventListener("blur", () => void this.flush());
    body.createDiv({
      cls: "ggai-qr-hint",
      text: "아이콘 칸은 비워도 됩니다. Lucide 아이콘 이름을 넣으면 그림으로 보여요.",
    });

    // ── 동작 ──
    this.sectionLabel(body, "동작");
    const seg = body.createDiv({ cls: "ggai-qr-seg" });
    const textBtn = seg.createEl("button", {
      cls: "ggai-qr-seg-btn",
      text: "입력/전송",
    });
    const cmdBtn = seg.createEl("button", {
      cls: "ggai-qr-seg-btn",
      text: "커맨드",
    });
    const syncSeg = (): void => {
      const isCmd = qr.message.trim().startsWith("/");
      textBtn.toggleClass("is-active", !isCmd);
      cmdBtn.toggleClass("is-active", isCmd);
      if (this.modeHintEl) {
        this.modeHintEl.setText(
          isCmd
            ? "커맨드로 실행됩니다. 지원하지 않는 커맨드는 건너뜁니다."
            : "이 내용이 그대로 입력되고 전송됩니다."
        );
      }
    };
    textBtn.addEventListener("click", () => {
      qr.message = qr.message.replace(/^\/+/, "");
      if (this.messageEl) this.messageEl.value = qr.message;
      syncSeg();
      this.touch();
    });
    cmdBtn.addEventListener("click", () => {
      if (!qr.message.trim().startsWith("/")) qr.message = `/${qr.message}`;
      if (this.messageEl) this.messageEl.value = qr.message;
      syncSeg();
      this.messageEl?.focus();
      this.touch();
    });

    const ta = body.createEl("textarea", { cls: "ggai-qr-message" });
    ta.rows = 4;
    ta.placeholder = "버튼을 누르면 실행할 내용";
    ta.value = qr.message;
    this.messageEl = ta;
    ta.addEventListener("input", () => {
      qr.message = ta.value;
      syncSeg();
      this.touch();
    });
    ta.addEventListener("blur", () => void this.flush());
    this.modeHintEl = body.createDiv({ cls: "ggai-qr-hint" });
    syncSeg();

    // ── 자동 실행 시점 (접힘) ──
    const autoWrap = this.foldable(body, "자동 실행 시점", (sum) => {
      this.autoSummaryEl = sum;
      this.syncAutoSummary();
    });
    for (const flag of AUTO_EXECUTE_FLAGS) {
      const key = flag.key as AutoExecuteFlagKey;
      const row = autoWrap.createDiv({ cls: "ggai-qr-check-row" });
      const cb = row.createEl("input", { attr: { type: "checkbox" } });
      cb.checked = qr[key] === true;
      cb.addEventListener("change", () => {
        (qr as unknown as Record<string, boolean>)[key] = cb.checked;
        this.syncAutoSummary();
        this.touch();
      });
      row.createSpan({ text: flag.label });
    }
    autoWrap.createDiv({
      cls: "ggai-qr-hint",
      text: "아무것도 고르지 않으면 눌렀을 때만 실행됩니다.",
    });

    // ── 하위 메뉴 (접힘) ──
    const subWrap = this.foldable(body, "하위 메뉴", (sum) => {
      this.subSummaryEl = sum;
      this.syncSubSummary();
    });
    subWrap.createDiv({
      cls: "ggai-qr-hint",
      text: "이 버튼을 누르면 고른 세트의 버튼들이 함께 열립니다.",
    });
    const others = this.allSets.filter((s) => s.set.name !== this.set!.name);
    if (others.length === 0) {
      subWrap.createDiv({
        cls: "ggai-qr-hint",
        text: "다른 세트가 아직 없습니다.",
      });
    }
    for (const other of others) {
      const name = other.set.name;
      const row = subWrap.createDiv({ cls: "ggai-qr-check-row" });
      const cb = row.createEl("input", { attr: { type: "checkbox" } });
      const linked = qr.contextList.find((c) => c.set === name);
      cb.checked = !!linked;
      row.createSpan({ text: name });

      const chain = row.createEl("button", {
        cls: "ggai-qr-chain-btn",
        text: "이어붙이기",
      });
      const syncChain = (): void => {
        const cur = qr.contextList.find((c) => c.set === name);
        chain.toggleClass("is-active", !!cur?.isChained);
        chain.toggleClass("is-hidden", !cur);
      };
      chain.setAttr(
        "aria-label",
        "하위 버튼 내용을 이 버튼 내용 뒤에 이어붙여 실행"
      );
      chain.addEventListener("click", () => {
        const cur = qr.contextList.find((c) => c.set === name);
        if (!cur) return;
        cur.isChained = !cur.isChained;
        syncChain();
        this.touch();
      });
      cb.addEventListener("change", () => {
        if (cb.checked) {
          if (!qr.contextList.some((c) => c.set === name)) {
            qr.contextList.push({ set: name, isChained: false });
          }
        } else {
          qr.contextList = qr.contextList.filter((c) => c.set !== name);
        }
        syncChain();
        this.syncSubSummary();
        this.touch();
      });
      syncChain();
    }

    // ── 삭제 ──
    const footer = body.createDiv({ cls: "ggai-qr-editor-footer" });
    const del = footer.createEl("button", {
      cls: "ggai-btn ggai-btn-danger",
      text: "이 버튼 삭제",
    });
    del.addEventListener("click", () => void this.handleDelete());
  }

  private sectionLabel(parent: HTMLElement, text: string): void {
    parent.createDiv({ cls: "ggai-qr-section-label", text });
  }

  /** 접히는 섹션 — 헤더에 요약을 띄우고 본문을 반환. */
  private foldable(
    parent: HTMLElement,
    title: string,
    onSummary: (el: HTMLElement) => void
  ): HTMLElement {
    const wrap = parent.createDiv({ cls: "ggai-qr-fold" });
    const head = wrap.createDiv({ cls: "ggai-qr-fold-head" });
    head.setAttr("role", "button");
    head.setAttr("tabindex", "0");
    head.createSpan({ cls: "ggai-qr-fold-title", text: title });
    const summary = head.createSpan({ cls: "ggai-qr-fold-summary" });
    const chev = head.createSpan({ cls: "ggai-qr-fold-chev" });
    setIcon(chev, "chevron-down");
    const bodyEl = wrap.createDiv({ cls: "ggai-qr-fold-body" });
    let open = false;
    const apply = (): void => {
      wrap.toggleClass("is-open", open);
      head.setAttr("aria-expanded", String(open));
    };
    const toggle = (): void => {
      open = !open;
      apply();
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    });
    apply();
    onSummary(summary);
    return bodyEl;
  }

  private syncAutoSummary(): void {
    if (!this.autoSummaryEl || !this.qr) return;
    const on = AUTO_EXECUTE_FLAGS.filter(
      (f) => this.qr![f.key as AutoExecuteFlagKey] === true
    );
    this.autoSummaryEl.setText(
      on.length === 0 ? "눌렀을 때만" : on.map((f) => f.label).join(", ")
    );
  }

  private syncSubSummary(): void {
    if (!this.subSummaryEl || !this.qr) return;
    const names = this.qr.contextList.map((c) => c.set);
    this.subSummaryEl.setText(names.length === 0 ? "없음" : names.join(", "));
  }

  private async handleDelete(): Promise<void> {
    if (!this.set || !this.qr) return;
    const label = this.qr.label || "이름 없는 버튼";
    const ok = await new Promise<boolean>((resolve) => {
      new ConfirmModal(
        this.plugin.app,
        "빠른 답장 삭제",
        `"${label}" 버튼을 삭제할까요?`,
        "삭제",
        resolve
      ).open();
    });
    if (!ok) return;
    this.set.qrList = this.set.qrList.filter((q) => q.id !== this.itemId);
    this.dirty = true;
    await this.flush();
    if (!this.disposed) this.opts.onClose();
  }

  /** 목록 꼬리표와 같은 요약 — 헤더 부제로 쓴다. */
  get subtitle(): string {
    return this.qr ? describeQuickReply(this.qr) : "";
  }

  /** 모바일에서 헤더가 좁을 때 쓰는 축약 여부. */
  get isNarrow(): boolean {
    return Platform.isMobile;
  }
}
