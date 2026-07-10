import { App, Modal, setIcon } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { StellaSession } from "../types/session";
import type { SessionListItem } from "../util/scan-sessions";
import { planChatEpisodeTail } from "../util/new-session";
import {
  planEpisodeTail,
  resolveSeriesPlan,
  startNextEpisode,
} from "./entity-actions";
import { createModalShell } from "./modal-shell";

/**
 * 다음화 만들기 모달 — 실행 전에 무엇이 만들어지고 무엇이 인계되는지 보여준다.
 *
 *  - 만들어질 화: "시리즈명 N화" (단독 세션이면 이 세션이 1화로 승격됨을 안내)
 *  - 이어갈 최근 노드 수 조절 + 실제로 넘어갈 본문 미리보기 (글자 수 포함)
 *  - 인계 항목 안내 (누적 요약 / 최근 본문 / 설정 일체)
 *  - [다음화 만들기] 실행 중 버튼 잠금 — 이중 실행 방지, 진행 상태 표시
 *
 * 실제 생성은 startNextEpisode 한 곳 — 이 모달은 같은 계산(resolveSeriesPlan /
 * planEpisodeTail)으로 미리 보여주기만 한다.
 */
export class NextEpisodeModal extends Modal {
  private session: StellaSession | null = null;
  private count = 3;
  private running = false;

  private previewEl: HTMLElement | null = null;
  private previewMetaEl: HTMLElement | null = null;

  constructor(
    app: App,
    private plugin: StellaEnginePlugin,
    private sessionFile: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("다음화 만들기");
    void this.loadAndRender();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async loadAndRender(): Promise<void> {
    const session = await this.plugin.store.getSession(this.sessionFile);
    if (!session) {
      this.contentEl.createEl("p", { text: "세션을 불러올 수 없습니다." });
      return;
    }
    this.session = session;

    const scenarioFolder = this.sessionFile.split("/SESSIONS/")[0];
    const siblings: SessionListItem[] = await this.plugin.store
      .getSessions(scenarioFolder)
      .catch(() => []);
    const plan = resolveSeriesPlan(session, siblings);
    const settings = await this.plugin.resolveActiveSettings(this.sessionFile);
    const summaryOn = settings.summarize?.enabled === true;

    const { body, footerAux, footerMain } = createModalShell(this, "l");
    body.addClass("ggai-next-ep-body");

    // ── 만들어질 화 ──
    const head = body.createDiv({ cls: "ggai-next-ep-head" });
    head.createDiv({
      cls: "ggai-next-ep-title",
      text: `"${plan.seriesName}" ${plan.newIndex}화를 만듭니다.`,
    });
    if (plan.seriesId === null) {
      head.createDiv({
        cls: "ggai-next-ep-sub",
        text: "지금 세션은 시리즈 1화가 됩니다.",
      });
    }
    // 루트 분기 경고 — 같은 번호의 화가 이미 있으면 이번 생성은 다른 루트다.
    if (plan.alternates.length > 0) {
      head.createDiv({
        cls: "ggai-next-ep-warn",
        text: `이미 ${plan.newIndex}화가 ${plan.alternates.length}개 있습니다 — 새로 만들면 이 화에서 갈라지는 다른 루트의 ${plan.newIndex}화가 됩니다. 기존 ${plan.newIndex}화는 그대로 남고, 시리즈 화 목록에서 루트를 골라 오갈 수 있습니다.`,
      });
    }

    // ── 이어갈 분량 ──
    const countRow = body.createDiv({ cls: "ggai-next-ep-count-row" });
    countRow.createSpan({
      cls: "ggai-next-ep-label",
      // 챗은 메시지 단위로 인계한다 — 사용자에게도 그 단위로 보여준다.
      text:
        session.meta.mode === "chat"
          ? "새 화 시작에 그대로 넣을 최근 메시지"
          : "새 화 시작에 그대로 넣을 최근 노드",
    });
    const input = countRow.createEl("input", {
      type: "number",
      cls: "ggai-next-episode-count",
    });
    input.value = String(this.count);
    input.min = "1";
    input.addEventListener("input", () => {
      this.count = Math.max(1, Math.floor(Number(input.value)) || 3);
      this.renderPreview();
    });

    this.previewMetaEl = body.createDiv({ cls: "ggai-next-ep-preview-meta" });
    this.previewEl = body.createDiv({ cls: "ggai-next-ep-preview" });
    this.renderPreview();

    // ── 인계 안내 ──
    const inherit = body.createDiv({ cls: "ggai-next-ep-inherit" });
    inherit.createDiv({
      cls: "ggai-next-ep-label",
      text: "다음 화에 인계되는 것",
    });
    const list = inherit.createEl("ul", { cls: "ggai-next-ep-inherit-list" });
    list.createEl("li", {
      text: summaryOn
        ? "그 앞의 이전 내용 — 누적 요약으로 압축되어 이어집니다 (필요하면 만들기 전에 요약을 먼저 정리합니다)."
        : "그 앞의 이전 내용 — 지금은 [요약 사용]이 꺼져 있어 요약 없이 위의 최근 본문만 이어갑니다.",
    });
    list.createEl("li", { text: "모델 · 파라미터 · 프롬프트 세트" });
    list.createEl("li", { text: "번역 · 삽화 · 요약 설정" });
    list.createEl("li", {
      text: "메모리 · 작가노트 · 로어북 선택 · 페르소나 · 변수",
    });

    // ── 실행 ──
    const status = footerAux;
    const cancel = footerMain.createEl("button", {
      cls: "ggai-btn",
      text: "취소",
    });
    cancel.addEventListener("click", () => this.close());
    const create = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
    });
    setIcon(create.createSpan(), "book-plus");
    create.createSpan({ text: "다음화 만들기" });
    create.addEventListener("click", () => {
      if (this.running) return;
      this.running = true;
      create.disabled = true;
      cancel.disabled = true;
      input.disabled = true;
      status?.setText(
        summaryOn ? "요약 정리 및 생성 중…" : "다음 화 생성 중…"
      );
      void (async () => {
        // 실패 시 모달을 닫지 않는다 — 실패 Notice 는 startNextEpisode 가 띄우고,
        // 사용자는 여기서 바로 재시도하거나 취소할 수 있다.
        const ok = await startNextEpisode(
          this.plugin,
          this.sessionFile,
          this.count
        );
        if (ok) {
          this.close();
          return;
        }
        this.running = false;
        create.disabled = false;
        cancel.disabled = false;
        input.disabled = false;
        status?.setText("");
      })();
    });
  }

  /** 이어갈 본문 미리보기 — 노드(챗은 메시지) 수를 바꾸면 즉시 갱신. */
  private renderPreview(): void {
    if (!this.session || !this.previewEl || !this.previewMetaEl) return;
    const isChat = this.session.meta.mode === "chat";
    let boundaryNodeId: string | null;
    let trimmed: string;
    if (isChat) {
      // 실행(startNextEpisode)과 같은 챗 전용 계산 — 메시지 단위 인계.
      const plan = planChatEpisodeTail(this.session, this.count);
      boundaryNodeId = plan.boundaryNodeId;
      trimmed = plan.messages.map((m) => m.text).join("\n\n").trim();
    } else {
      const plan = planEpisodeTail(this.session, this.count);
      boundaryNodeId = plan.boundaryNodeId;
      trimmed = plan.tail.trim();
    }
    const unit = isChat ? "메시지" : "노드";
    this.previewMetaEl.setText(
      boundaryNodeId
        ? `본문 끝 ${trimmed.length.toLocaleString()}자가 새 화 시작 부분에 그대로 들어갑니다.`
        : `${unit}가 ${this.count}개보다 적어 본문 전체(${trimmed.length.toLocaleString()}자)가 그대로 들어갑니다.`
    );
    this.previewEl.setText(trimmed || "(이어갈 본문이 없습니다)");
  }
}
