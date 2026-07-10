/**
 * SummaryManagerModal — 요약 관리 고급 창.
 *
 * 두 가지를 한 창에서 한다:
 *  1. 현재 요약 컨텍스트({{summary}} 로 실제 주입되는 events 나열 + 마지막 state) 확인.
 *     "번역해서 보기" 토글로 현재 번역 설정(모델/프롬프트)으로 번역해 읽을 수 있다.
 *  2. 활성 경로 위 개별 요약 앵커를 하나씩 수정(사건/현재 상황 직접 편집)·삭제하거나
 *     재생성(그 노드 기준으로 다시 요약). 경로 전체를 한꺼번에 지우거나
 *     처음부터 다시 만드는 것도 가능.
 *
 * 요약 데이터는 summaries.json(store 경유)만 읽고 쓴다. 원문 세션 노드는 불변.
 */

import { Modal, Notice, setIcon, type EventRef } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { SummaryAnchor } from "../types/summary";
import {
  collectAnchorChain,
  composeSummaryContextForPath,
} from "../util/summarize-session";
import { pathToLeaf } from "../util/session-text";
import { ConfirmModal } from "./modals";
import { createModalShell } from "./modal-shell";

export class SummaryManagerModal extends Modal {
  private translateView = false;
  private translatedContext: string | null = null;
  private translating = false;
  private busy = false;
  /** 전체 재작성 진행 표시 — 조각 하나 끝날 때마다 갱신해 버튼에 보여준다. */
  private bulkStatus: string | null = null;
  /** 몰아서 요약할 때 진행률(완료/전체 요청 수) — 목록 위 진행 줄에 % 로 표시. */
  private bulkProgress: { done: number; total: number } | null = null;
  /** 아코디언: 한 번에 한 패널만 펼친다. 기본은 현재 요약. */
  private openPanel: "context" | "manage" = "context";

  private bodyEl!: HTMLElement;
  private summariesRef: EventRef | null = null;

  static open(plugin: StellaEnginePlugin, sessionFile: string): void {
    new SummaryManagerModal(plugin, sessionFile).open();
  }

  private constructor(
    private readonly plugin: StellaEnginePlugin,
    private readonly sessionFile: string
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("요약 관리");
    const { body, footerMain } = createModalShell(this, "l");
    this.bodyEl = body;
    // body 자체는 스크롤하지 않는다 — 열린 패널이 높이를 채우고 그 안에서만 스크롤한다.
    this.bodyEl.addClass("ggai-summary-mgr-modal-body");

    const closeBtn = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "닫기",
    });
    closeBtn.addEventListener("click", () => this.close());

    // 요약이 쌓이는 대로(주기 단위 구간이 하나씩 저장될 때) 카드를 실시간 반영한다.
    // 단, 사용자가 카드를 편집·재생성 중이면 입력이 날아가니 갱신을 건너뛴다.
    this.summariesRef = this.plugin.store.on(
      "session-summaries-changed",
      (file: string) => {
        if (file !== this.sessionFile) return;
        if (this.busy || this.isEditingCard()) return;
        void this.renderBody();
      }
    );

    void this.renderBody();
  }

  onClose(): void {
    if (this.summariesRef) {
      this.plugin.store.offref(this.summariesRef);
      this.summariesRef = null;
    }
    this.contentEl.empty();
  }

  /** 카드 textarea 에 포커스가 있으면(편집 중) 자동 갱신을 미룬다. */
  private isEditingCard(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && this.bodyEl.contains(active);
  }

  private async renderBody(): Promise<void> {
    // 데이터를 먼저 받아온 뒤 비우고 다시 그린다 — empty() 와 재구성 사이에 await 가
    // 없어야, 진행 중 onProgress 가 renderBody 를 겹쳐 불러도 버튼이 중복 생성되지 않는다.
    const session = await this.plugin.store.getSession(this.sessionFile);
    const summaries = await this.plugin.store.getSessionSummaries(this.sessionFile);

    this.bodyEl.empty();
    if (!session) {
      this.bodyEl.setText("세션을 불러올 수 없습니다.");
      return;
    }
    const anchors = collectAnchorChain(session, summaries);
    // 압축(컴팩트) 반영 합성 — 전송본과 같은 로직. 카드 목록은 개별 앵커 그대로 보여준다.
    const composed = composeSummaryContextForPath(session, summaries);

    // 아코디언 두 패널 — 한 번에 하나만 펼쳐 스크롤이 한 곳으로만 생기게 한다.
    this.renderPanel(
      "현재 요약",
      "context",
      (panelBody) => this.renderContextBody(panelBody, anchors, composed)
    );
    this.renderPanel(
      "요약 관리",
      "manage",
      (panelBody) => this.renderManageBody(panelBody, anchors)
    );
  }

  /**
   * 아코디언 패널 하나 — 헤더 클릭으로 펼침/접힘을 토글한다. 접힌 상태에서는
   * 본문을 아예 그리지 않아 한 창에 스크롤이 하나만 생긴다.
   */
  private renderPanel(
    title: string,
    key: "context" | "manage",
    build: (body: HTMLElement) => void
  ): void {
    const open = this.openPanel === key;
    const panel = this.bodyEl.createDiv({
      cls: `ggai-summary-mgr-panel${open ? " is-open" : ""}`,
    });
    const head = panel.createEl("button", { cls: "ggai-summary-mgr-panel-head" });
    setIcon(head.createSpan({ cls: "ggai-summary-mgr-panel-caret" }), open ? "chevron-down" : "chevron-right");
    head.createSpan({ cls: "ggai-summary-mgr-panel-title", text: title });
    head.addEventListener("click", () => {
      // 이미 열린 패널을 다시 눌러도 유지 — 다른 패널을 눌러야 그쪽이 펼쳐진다.
      if (this.openPanel === key) return;
      this.openPanel = key;
      void this.renderBody();
    });
    if (open) build(panel.createDiv({ cls: "ggai-summary-mgr-panel-body" }));
  }

  // ─────────────────────────── 현재 요약 컨텍스트 ───────────────────────────

  private renderContextBody(
    parent: HTMLElement,
    anchors: SummaryAnchor[],
    composed: string
  ): void {
    const toolRow = parent.createDiv({ cls: "ggai-summary-mgr-context-tools" });
    const toggle = toolRow.createEl("button", {
      cls: "ggai-preset-btn",
      text: this.translateView ? "원문 보기" : "번역해서 보기",
    });
    if (this.translateView) toggle.addClass("is-active");
    toggle.disabled = this.translating || anchors.length === 0;
    toggle.addEventListener("click", () => void this.toggleTranslateView());

    const box = parent.createDiv({ cls: "ggai-media-summary-context" });
    if (anchors.length === 0) {
      box.setText("아직 누적된 요약이 없습니다.");
      return;
    }
    if (this.translating) {
      box.setText("번역 중…");
    } else if (this.translateView) {
      box.setText(this.translatedContext ?? composed);
    } else {
      box.setText(composed);
    }
  }

  private async toggleTranslateView(): Promise<void> {
    if (this.translating) return;
    // 원문 ↔ 번역 전환. 번역이 아직 없으면 지금 요청한다.
    if (this.translateView) {
      this.translateView = false;
      await this.renderBody();
      return;
    }
    if (this.translatedContext !== null) {
      this.translateView = true;
      await this.renderBody();
      return;
    }
    const session = await this.plugin.store.getSession(this.sessionFile);
    const summaries = await this.plugin.store.getSessionSummaries(this.sessionFile);
    if (!session) return;
    const composed = composeSummaryContextForPath(session, summaries);
    if (composed.trim() === "") return;

    this.translateView = true;
    this.translating = true;
    await this.renderBody();
    const result = await this.plugin.translation.translateText(this.sessionFile, composed);
    this.translating = false;
    if (!result.ok) {
      this.translateView = false;
      new Notice(`번역 실패: ${result.error ?? "알 수 없는 오류"}`);
      await this.renderBody();
      return;
    }
    this.translatedContext = result.text;
    await this.renderBody();
  }

  // ─────────────────────────── 개별 요약 앵커 ───────────────────────────

  private renderManageBody(
    parent: HTMLElement,
    anchors: SummaryAnchor[]
  ): void {
    // 요약이 하나도 없어도 그린다 — 빈 상태에서도 [전체 요약]으로 여기서 바로
    // 첫 요약을 시작할 수 있어야 한다 (지금 요약에만 의존하지 않게).
    const hasAnchors = anchors.length > 0;

    // 일괄 동작 줄(이어하기/재작성/삭제) — 카드 목록 위에 둔다.
    const bulk = parent.createDiv({ cls: "ggai-summary-mgr-bulk" });

    // [이어하기] — 저장된 요약은 그대로 두고 마지막 지점부터 남은 구간만 계속.
    // 몰아서 요약하다 중간에 멈췄을 때(창 닫음/오류) 그 다음부터 이어간다.
    if (hasAnchors) {
      const resumeBtn = bulk.createEl("button", {
        cls: "ggai-preset-btn",
        attr: {
          title: "저장된 요약은 그대로 두고 마지막 지점부터 남은 구간만 이어서 요약한다",
        },
      });
      setIcon(resumeBtn.createSpan(), "play");
      resumeBtn.createSpan({ text: "이어하기" });
      resumeBtn.disabled = this.busy;
      resumeBtn.addEventListener("click", () => void this.resumeAll());
    }

    const regenAllBtn = bulk.createEl("button", {
      cls: "ggai-preset-btn",
      attr: {
        title: hasAnchors
          ? "현재 경로의 요약을 모두 지우고 처음부터 다시 만든다"
          : "지금까지의 본문을 처음부터 요약한다",
      },
    });
    setIcon(regenAllBtn.createSpan(), "rotate-ccw");
    regenAllBtn.createSpan({
      text: this.bulkStatus ?? (hasAnchors ? "전체 재작성" : "전체 요약"),
    });
    regenAllBtn.disabled = this.busy;
    regenAllBtn.addEventListener("click", () => void this.regenAll(hasAnchors));

    const clearAllBtn = bulk.createEl("button", {
      cls: "ggai-preset-btn ggai-summary-mgr-danger",
      attr: { title: "현재 경로의 요약을 모두 삭제한다" },
    });
    setIcon(clearAllBtn.createSpan(), "trash-2");
    clearAllBtn.createSpan({ text: "전체 삭제" });
    clearAllBtn.disabled = this.busy || !hasAnchors;
    clearAllBtn.addEventListener("click", () => void this.clearAll());

    // 진행 중이면 정지 버튼 — 남은 구간을 진행하지 않고 멈춘다(저장된 조각은 유지).
    if (this.busy) {
      const stopBtn = bulk.createEl("button", {
        cls: "ggai-preset-btn ggai-summary-mgr-danger",
        attr: { title: "진행 중인 요약을 정지한다 (여기까지 만든 조각은 유지)" },
      });
      setIcon(stopBtn.createSpan(), "square");
      stopBtn.createSpan({ text: "정지" });
      stopBtn.addEventListener("click", () => this.plugin.summary.cancelAll());
    }

    // 진행률 줄 — 몰아서 요약하는 동안 완료/전체(%)와 진행 막대를 크게 보여준다.
    if (this.busy && this.bulkProgress && this.bulkProgress.total > 1) {
      const { done, total } = this.bulkProgress;
      const pct = Math.round((done / total) * 100);
      const prog = parent.createDiv({ cls: "ggai-summary-mgr-progress" });
      prog.createDiv({
        cls: "ggai-summary-mgr-progress-label",
        text: `요약 중… ${done}/${total} (${pct}%)`,
      });
      const bar = prog.createDiv({ cls: "ggai-summary-mgr-progress-bar" });
      bar.createDiv({
        cls: "ggai-summary-mgr-progress-fill",
        attr: { style: `width:${pct}%` },
      });
    } else if (this.busy) {
      parent.createDiv({
        cls: "ggai-summary-mgr-progress-label",
        text: "요약 중…",
      });
    }

    // 카드 목록만 스크롤 — 일괄 동작 줄은 위에 고정된다.
    const list = parent.createDiv({ cls: "ggai-summary-mgr-scroll" });
    if (!hasAnchors) {
      list.createDiv({
        cls: "ggai-summary-mgr-empty",
        text: "아직 요약 조각이 없습니다. [전체 요약]으로 시작하세요.",
      });
      return;
    }
    anchors.forEach((anchor, idx) => {
      this.renderAnchorCard(list, anchor, idx + 1, idx === anchors.length - 1);
    });
  }

  /**
   * 사건 조각 카드 — 사건 요약을 내용 높이에 맞춰 쭉 읽으면서 그 자리에서 바로
   * 고치고, 헤더의 [재생성]으로 그 조각 구간만 다시 요약한다. 현재 상황 스냅샷은
   * 마지막 조각의 것만 실제로 주입되므로 접어서 덜 강조한다 (마지막 조각만 펼침).
   */
  private renderAnchorCard(
    parent: HTMLElement,
    anchor: SummaryAnchor,
    order: number,
    isLast: boolean
  ): void {
    const card = parent.createDiv({ cls: "ggai-summary-mgr-card" });

    const head = card.createDiv({ cls: "ggai-summary-mgr-card-head" });
    head.createDiv({ cls: "ggai-summary-mgr-card-title", text: `#${order}` });
    const actions = head.createDiv({ cls: "ggai-summary-mgr-card-actions" });

    const eventsField = card.createEl("textarea", {
      cls: "ggai-form-textarea ggai-summary-mgr-events",
    });
    eventsField.value = anchor.events;
    eventsField.rows = 2;
    attachAutoResize(eventsField);

    const stateBox = card.createEl("details", { cls: "ggai-summary-mgr-state" });
    if (isLast) stateBox.setAttr("open", "");
    stateBox.createEl("summary", {
      text: isLast ? "현재 상황 스냅샷 (주입됨)" : "현재 상황 스냅샷",
    });
    const stateField = stateBox.createEl("textarea", {
      cls: "ggai-form-textarea ggai-summary-mgr-events",
    });
    stateField.value = anchor.state;
    stateField.rows = 2;
    attachAutoResize(stateField);
    // 접힌 상태에서는 내용 높이를 잴 수 없으니 펼치는 순간 다시 맞춘다.
    stateBox.addEventListener("toggle", () => {
      if (stateBox.open) fitTextarea(stateField);
    });

    const regenBtn = actions.createEl("button", {
      cls: "ggai-preset-btn",
      attr: { title: "이 조각이 덮는 구간만 다시 요약" },
    });
    const regenIcon = regenBtn.createSpan();
    setIcon(regenIcon, "rotate-ccw");
    regenBtn.createSpan({ text: "재생성" });
    regenBtn.disabled = this.busy;
    regenBtn.addEventListener("click", () => void this.regenAnchor(anchor.nodeId));

    const saveBtn = actions.createEl("button", { cls: "ggai-preset-btn", text: "저장" });
    saveBtn.disabled = true;
    const markDirty = () => {
      const changed =
        eventsField.value !== anchor.events || stateField.value !== anchor.state;
      saveBtn.disabled = !changed || this.busy;
    };
    eventsField.addEventListener("input", markDirty);
    stateField.addEventListener("input", markDirty);
    saveBtn.addEventListener("click", () =>
      void this.saveAnchor(anchor.nodeId, eventsField.value, stateField.value)
    );

    const deleteBtn = actions.createEl("button", {
      cls: "ggai-preset-btn ggai-summary-mgr-danger",
      attr: { title: "이 조각만 삭제" },
    });
    setIcon(deleteBtn.createSpan(), "trash-2");
    deleteBtn.disabled = this.busy;
    deleteBtn.addEventListener("click", () => void this.deleteAnchor(anchor.nodeId, order));
  }

  private async saveAnchor(
    nodeId: string,
    events: string,
    state: string
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    // 호출 시점 최신 summaries 를 읽어 해당 앵커만 갱신 (외부 변경 보존).
    const summaries = await this.plugin.store.getSessionSummaries(this.sessionFile);
    const anchor = summaries.anchors[nodeId];
    if (!anchor) {
      this.busy = false;
      new Notice("요약 항목을 찾을 수 없습니다.");
      return;
    }
    anchor.events = events;
    anchor.state = state;
    anchor.updatedAt = Date.now();
    await this.plugin.store.saveSessionSummaries(this.sessionFile, summaries);
    this.translatedContext = null; // 컨텍스트가 바뀌었으니 번역 캐시 무효화.
    this.busy = false;
    new Notice("요약을 저장했습니다.");
    await this.renderBody();
  }

  private async regenAnchor(nodeId: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    new Notice("요약을 다시 생성하는 중…");
    const result = await this.plugin.summary.summarize(this.sessionFile, nodeId);
    this.translatedContext = null;
    this.busy = false;
    if (result.cancelled) {
      new Notice("요약을 취소했습니다.");
      await this.renderBody();
      return;
    }
    if (!result.ok) {
      new Notice(`요약 재생성 실패: ${result.errors[0] ?? "알 수 없는 오류"}`);
      return;
    }
    if (result.skipped) {
      new Notice("이 지점에는 다시 요약할 새 내용이 없습니다.");
    }
    await this.renderBody();
  }

  /** 조각 하나만 삭제 — summaries.json 에서 해당 앵커만 제거한다. */
  private async deleteAnchor(nodeId: string, order: number): Promise<void> {
    if (this.busy) return;
    const ok = await this.confirm(
      "요약 조각 삭제",
      `요약 조각 #${order} 을(를) 삭제할까요? 이 조각의 사건 요약이 컨텍스트에서 빠집니다.`,
      "삭제"
    );
    if (!ok) return;
    this.busy = true;
    const summaries = await this.plugin.store.getSessionSummaries(this.sessionFile);
    if (!summaries.anchors[nodeId]) {
      this.busy = false;
      new Notice("이미 삭제된 조각입니다.");
      await this.renderBody();
      return;
    }
    delete summaries.anchors[nodeId];
    await this.plugin.store.saveSessionSummaries(this.sessionFile, summaries);
    this.translatedContext = null;
    this.busy = false;
    new Notice("요약 조각을 삭제했습니다.");
    await this.renderBody();
  }

  /** 현재 경로의 모든 요약 조각을 삭제한다. */
  private async clearAll(): Promise<void> {
    if (this.busy) return;
    const ok = await this.confirm(
      "요약 전체 삭제",
      "현재 경로에 쌓인 요약을 모두 삭제할까요? 직접 수정한 요약도 함께 사라집니다.",
      "전체 삭제"
    );
    if (!ok) return;
    this.busy = true;
    const removed = await this.clearPathAnchors();
    this.busy = false;
    new Notice(removed > 0 ? "요약을 모두 삭제했습니다." : "삭제할 요약이 없습니다.");
    await this.renderBody();
  }

  /**
   * 현재 경로의 요약을 모두 지우고 처음부터 다시 만든다. 밀린 구간을 주기 단위로
   * 나눠 재요약하며, 조각 하나가 저장될 때마다 즉시 목록에 반영한다 — 전체가
   * 끝날 때까지 기다렸다가 한꺼번에 보여주지 않는다.
   */
  private async regenAll(hasAnchors: boolean): Promise<void> {
    if (this.busy) return;
    // 기존 요약이 있을 때만 확인 — 빈 상태의 첫 요약은 잃을 게 없으니 바로 시작.
    if (hasAnchors) {
      const ok = await this.confirm(
        "요약 전체 재작성",
        "현재 경로의 요약을 모두 지우고 처음부터 다시 만들까요? 직접 수정한 요약도 사라집니다.",
        "재작성"
      );
      if (!ok) return;
    }
    this.busy = true;
    this.bulkStatus = "재작성 중…";
    this.bulkProgress = null;
    await this.renderBody();
    const session = await this.plugin.store.getSession(this.sessionFile);
    if (!session) {
      this.busy = false;
      this.bulkStatus = null;
      new Notice("세션을 불러올 수 없습니다.");
      await this.renderBody();
      return;
    }
    await this.clearPathAnchors();
    await this.renderBody(); // 지운 직후 빈 목록부터 바로 보여준다.
    const result = await this.plugin.summary.summarize(
      this.sessionFile,
      session.meta.activeLeafId,
      {
        // 조각 하나가 끝나 저장될 때마다(summarize 내부에서 즉시 saveSessionSummaries)
        // 여기서도 바로 다시 그려 목록에 반영한다.
        onProgress: (done, total) => {
          this.bulkProgress = { done, total };
          this.bulkStatus = total > 1 ? `재작성 중… ${done}/${total}` : "재작성 중…";
          void this.renderBody();
        },
      }
    );
    this.busy = false;
    this.bulkStatus = null;
    this.bulkProgress = null;
    if (result.cancelled) {
      new Notice("요약을 취소했습니다. 여기까지 만든 조각은 남아 있습니다.");
    } else if (!result.ok) {
      new Notice(`재작성 실패: ${result.errors[0] ?? "알 수 없는 오류"}`);
    } else if (result.skipped) {
      new Notice("요약할 내용이 없습니다.");
    } else {
      new Notice("요약을 다시 만들었습니다.");
    }
    await this.renderBody();
  }

  /**
   * [이어하기] — 저장된 요약은 그대로 두고 마지막 앵커 다음 구간부터 이어서 요약한다.
   * 몰아서 요약하다 중간에 멈췄을 때(창 닫음/일시 오류) 다시 눌러 남은 구간을 채운다.
   * 요약 주기와 무관하게 즉시 남은 구간을 처리한다.
   */
  private async resumeAll(): Promise<void> {
    if (this.busy) return;
    const session = await this.plugin.store.getSession(this.sessionFile);
    if (!session) {
      new Notice("세션을 불러올 수 없습니다.");
      return;
    }
    this.busy = true;
    this.bulkStatus = "이어하는 중…";
    this.bulkProgress = null;
    await this.renderBody();
    const result = await this.plugin.summary.summarize(
      this.sessionFile,
      session.meta.activeLeafId,
      {
        onProgress: (done, total) => {
          this.bulkProgress = { done, total };
          this.bulkStatus = total > 1 ? `이어하는 중… ${done}/${total}` : "이어하는 중…";
          void this.renderBody();
        },
      }
    );
    this.busy = false;
    this.bulkStatus = null;
    this.bulkProgress = null;
    if (result.cancelled) {
      new Notice("요약을 취소했습니다. 여기까지 만든 조각은 남아 있습니다.");
    } else if (!result.ok) {
      new Notice(`이어하기 실패: ${result.errors[0] ?? "알 수 없는 오류"}`);
    } else if (result.skipped) {
      new Notice("이어서 요약할 내용이 없습니다. 이미 최신입니다.");
    } else {
      new Notice("남은 구간을 이어서 요약했습니다.");
    }
    await this.renderBody();
  }

  /** 활성 경로 위 앵커 + 압축본 + 이어하기 체크포인트를 지우고 저장한다. 지운 앵커 개수 반환. */
  private async clearPathAnchors(): Promise<number> {
    const session = await this.plugin.store.getSession(this.sessionFile);
    const summaries = await this.plugin.store.getSessionSummaries(this.sessionFile);
    if (!session) return 0;
    const chain = collectAnchorChain(session, summaries);
    for (const anchor of chain) delete summaries.anchors[anchor.nodeId];
    // 경로 위 압축본도 함께 제거 — 안 그러면 스테일 압축이 계속 요약을 덮어쓴다.
    if (summaries.compactions) {
      const onPath = new Set(pathToLeaf(session, session.meta.activeLeafId).map((n) => n.id));
      for (const key of Object.keys(summaries.compactions)) {
        if (onPath.has(summaries.compactions[key].throughNodeId)) {
          delete summaries.compactions[key];
        }
      }
    }
    delete summaries.pending;
    await this.plugin.store.saveSessionSummaries(this.sessionFile, summaries);
    this.translatedContext = null;
    return chain.length;
  }

  private confirm(title: string, message: string, confirmText: string): Promise<boolean> {
    return new Promise((resolve) => {
      new ConfirmModal(this.plugin.app, title, message, confirmText, resolve).open();
    });
  }
}

// ─────────────────────────── textarea 내용 맞춤 ───────────────────────────

/** 사건 조각을 상자 스크롤 없이 쭉 읽도록 textarea 높이를 내용에 맞춘다. */
function fitTextarea(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

function attachAutoResize(ta: HTMLTextAreaElement): void {
  ta.addEventListener("input", () => fitTextarea(ta));
  // 레이아웃이 잡힌 뒤에야 내용 높이를 잴 수 있다.
  window.requestAnimationFrame(() => fitTextarea(ta));
}
