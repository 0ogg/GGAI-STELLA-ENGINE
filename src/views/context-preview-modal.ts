import { App, Modal, Notice } from "obsidian";
import type { SessionContextDryRun } from "../util/build-session-context";
import { createModalShell } from "./modal-shell";

/**
 * ContextPreviewModal — AI 에 보낼 최종 컨텍스트 미리보기.
 *
 * 입력: dry-run 결과 (buildSessionContextDryRun).
 * 표시:
 *  - 상단 메타 (모델/세션/시나리오/프롬프트셋/로어북/토큰 예산·사용)
 *  - 매치된 로어북 엔트리 목록 (있으면)
 *  - 메시지 리스트 (role 별 색)
 *  - [복사] 버튼: 전체 메시지를 텍스트로 클립보드에
 */
export class ContextPreviewModal extends Modal {
  /** 찾기 상태 — 전송본 본문에서 키워드 하이라이트/이동. */
  private hits: HTMLElement[] = [];
  private activeHit = 0;
  private renderBody: ((query: string) => void) | null = null;
  private countEl: HTMLElement | null = null;

  constructor(app: App, private dry: SessionContextDryRun) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("현재 컨텍스트 미리보기");
    const { toolbar, body, footerAux, footerMain } = createModalShell(this, "l", {
      toolbar: true,
      wide: true,
    });
    body.addClass("ggai-ctx-preview");

    const out = this.dry.output;
    const meta = this.dry.meta;
    const profile = this.dry.profile;

    // 메타 박스 — 도구줄(고정). 찾기 바와 함께 항상 보인다.
    const summary = toolbar!.createDiv({ cls: "ggai-ctx-summary" });
    addMeta(summary, "세션", meta.sessionName);
    addMeta(summary, "시나리오", meta.scenarioName);
    addMeta(
      summary,
      "모델",
      `${profile.name}${profile.provider ? ` (${profile.provider})` : ""} · ${profile.kind === "text" ? "텍스트" : "채팅"}`
    );
    if (profile.kind === "text") {
      addMeta(summary, "NAI 형식", this.dry.textPrompt?.startsWith("[gMASK]") ? "켬" : "끔");
    }
    addMeta(
      summary,
      "토큰",
      `${out.tokensUsed.toLocaleString()} / ${meta.tokenBudget.toLocaleString()}`
    );
    addMeta(
      summary,
      "프롬프트 세트",
      meta.promptSetName ?? "(폴백 — 활성 세트 없음)"
    );
    addMeta(summary, "활성 로어북", `${meta.lorebookCount}개`);
    if (out.droppedLogTurns > 0) {
      addMeta(summary, "잘림", `세션 로그 ${out.droppedLogTurns} 턴 토큰 부족으로 제외됨`);
    }

    // 찾기 바 — 도구줄(고정), 아래 전송본(본문) 안에서 키워드 검색/이동.
    this.renderFindBar(toolbar!);

    // ── API 전송 직전 컨텍스트 = 실제 전송본 (이 화면의 핵심, 본문의 유일한 스크롤 영역) ──
    const reqWrap = body.createDiv({ cls: "ggai-ctx-section" });
    if (this.dry.textPrompt !== undefined) {
      // 텍스트 컴플리션: 실제로 보내는 단일 프롬프트 문자열 그대로 (파트별 색칠).
      reqWrap.createEl("h4", { text: "API 전송 직전 컨텍스트 (실제 전송본)" });
      this.renderPartLegend(reqWrap);
      const pre = reqWrap.createEl("pre", { cls: "ggai-ctx-textprompt" });
      const segs = this.dry.textSegments;
      this.renderBody = (query) => {
        pre.empty();
        this.hits = [];
        if (segs && segs.length > 0) {
          for (const seg of segs) {
            const span = pre.createSpan({ cls: `ggai-ctx-part ggai-ctx-part-${seg.part}` });
            appendHighlighted(span, seg.text, query, this.hits);
          }
        } else {
          appendHighlighted(pre, this.dry.textPrompt ?? "", query, this.hits);
        }
      };
    } else {
      // 채팅: 실제로 chatStream() 에 보내는 메시지 배열 그대로 (normalize 적용 후 = 전송본).
      const sentMessages = this.dry.chatMessages ?? out.messages;
      reqWrap.createEl("h4", {
        text: `API 전송 직전 메시지 (${sentMessages.length})`,
      });
      const msgList = reqWrap.createDiv({ cls: "ggai-ctx-msg-list" });
      const tokens = this.dry.chatMessageTokens;
      this.renderBody = (query) => {
        msgList.empty();
        this.hits = [];
        sentMessages.forEach((m, i) => {
          const card = msgList.createDiv({ cls: `ggai-ctx-msg ggai-ctx-msg-${m.role}` });
          const head = card.createDiv({ cls: "ggai-ctx-msg-head" });
          head.createSpan({ cls: "ggai-ctx-msg-caret", text: "▾" });
          head.createSpan({ cls: "ggai-ctx-msg-role", text: m.role });
          if (m.source) {
            const source = head.createSpan({
              cls: "ggai-ctx-msg-source",
              text: m.source.detail
                ? `${m.source.label}: ${m.source.detail}`
                : m.source.label,
            });
            if (m.source.detail) source.title = m.source.detail;
          }
          const tok = tokens?.[i];
          head.createSpan({
            cls: "ggai-ctx-msg-len",
            text: tok != null ? `~${tok.toLocaleString()}토큰 · ${m.content.length}자` : `${m.content.length}자`,
          });
          const body = card.createDiv({ cls: "ggai-ctx-msg-body" });
          appendHighlighted(body, m.content, query, this.hits);
          head.addEventListener("click", () => card.toggleClass("is-collapsed", !card.hasClass("is-collapsed")));
        });
      };
    }
    this.renderBody("");

    // 매치된 로어북 엔트리 (참고용 — 실제 내용은 위 전송본에 포함됨)
    if (out.matchedLorebookEntries.length > 0) {
      const lbWrap = body.createDiv({ cls: "ggai-ctx-section" });
      lbWrap.createEl("h4", { text: `매치된 로어북 엔트리 (${out.matchedLorebookEntries.length})` });
      const list = lbWrap.createDiv({ cls: "ggai-ctx-tag-list" });
      for (const name of out.matchedLorebookEntries) {
        list.createSpan({ cls: "ggai-ctx-tag", text: name });
      }
    }

    // 액션 — 좌: 복사(보조), 우: 닫기(주 동작). 액션줄(고정).
    const copyBtn = footerAux.createEl("button", {
      cls: "ggai-btn",
      text: "전체 복사",
    });
    copyBtn.addEventListener("click", () => {
      // 텍스트 컴플리션이면 실제 전송본(평탄화 프롬프트), 아니면 role 별 메시지.
      const text =
        this.dry.textPrompt ??
        (this.dry.chatMessages ?? out.messages)
          .map((m) => `[${m.role}${m.source ? ` | ${m.source.label}` : ""}]\n${m.content}`)
          .join("\n\n");
      void navigator.clipboard
        .writeText(text)
        .then(() => new Notice("컨텍스트를 클립보드에 복사했습니다."))
        .catch(() => new Notice("복사 실패."));
    });
    const closeBtn = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "닫기",
    });
    closeBtn.addEventListener("click", () => this.close());
  }

  /** 색상 범례 — 어떤 색이 어떤 파트인지 + 파트별 근사 토큰 합. 등장 파트만 표시. */
  private renderPartLegend(parent: HTMLElement): void {
    const segs = this.dry.textSegments ?? [];
    const segTokens = this.dry.textSegmentTokens;
    const present = new Set(segs.map((s) => s.part));
    // 파트별 토큰 합 (근사) — 같은 파트 세그먼트를 모두 더한다.
    const partTokens = new Map<string, number>();
    segs.forEach((s, i) => {
      partTokens.set(s.part, (partTokens.get(s.part) ?? 0) + (segTokens?.[i] ?? 0));
    });
    const items: Array<{ part: string; label: string }> = [
      { part: "token", label: "역할 토큰" },
      { part: "system", label: "시스템/메인" },
      { part: "scenario", label: "시나리오" },
      { part: "description", label: "캐릭터 설명" },
      { part: "personality", label: "캐릭터 성격" },
      { part: "examples", label: "대화 예시" },
      { part: "lorebook", label: "로어북" },
      { part: "memory", label: "메모리" },
      { part: "body", label: "본문" },
      { part: "authornote", label: "작가노트" },
      { part: "other", label: "기타" },
    ].filter((it) => present.has(it.part as any));
    if (items.length === 0) return;
    const legend = parent.createDiv({ cls: "ggai-ctx-legend" });
    for (const it of items) {
      const chip = legend.createSpan({ cls: "ggai-ctx-legend-item" });
      chip.createSpan({ cls: `ggai-ctx-legend-dot ggai-ctx-part-${it.part}` });
      const tok = partTokens.get(it.part);
      chip.createSpan({
        cls: "ggai-ctx-legend-label",
        text: tok != null && segTokens ? `${it.label} (~${tok.toLocaleString()}토큰)` : it.label,
      });
    }
  }

  /** 찾기 입력란 + 일치 개수 + 이전/다음 이동. */
  private renderFindBar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "ggai-ctx-find" });
    const input = bar.createEl("input", { cls: "ggai-ctx-find-input", type: "search" });
    input.placeholder = "내용에서 찾기…";
    this.countEl = bar.createSpan({ cls: "ggai-ctx-find-count" });

    const prev = bar.createEl("button", { cls: "ggai-btn ggai-btn-small", text: "‹" });
    prev.setAttr("aria-label", "이전 일치");
    const next = bar.createEl("button", { cls: "ggai-btn ggai-btn-small", text: "›" });
    next.setAttr("aria-label", "다음 일치");

    const runSearch = (query: string): void => {
      this.renderBody?.(query);
      this.activeHit = 0;
      this.updateActiveHit(query.length > 0);
    };
    input.addEventListener("input", () => runSearch(input.value.trim()));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      this.stepHit(e.shiftKey ? -1 : 1);
    });
    prev.addEventListener("click", () => this.stepHit(-1));
    next.addEventListener("click", () => this.stepHit(1));
    window.setTimeout(() => input.focus(), 0);
  }

  private stepHit(delta: number): void {
    if (this.hits.length === 0) return;
    this.activeHit = (this.activeHit + delta + this.hits.length) % this.hits.length;
    this.updateActiveHit(true);
  }

  private updateActiveHit(scroll: boolean): void {
    this.hits.forEach((h, i) => h.toggleClass("is-active", i === this.activeHit));
    if (scroll && this.hits[this.activeHit]) {
      this.hits[this.activeHit].scrollIntoView({ block: "center" });
    }
    if (this.countEl) {
      this.countEl.textContent = this.hits.length
        ? `${this.activeHit + 1} / ${this.hits.length}`
        : "일치 없음";
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * `text` 를 `parent` 에 그리되, `query` 와 일치하는 부분만 하이라이트 span 으로 감싼다.
 * 대소문자 무시. 생성된 하이라이트 span 은 `hits` 에 순서대로 쌓인다(이동용).
 */
function appendHighlighted(
  parent: HTMLElement,
  text: string,
  query: string,
  hits: HTMLElement[]
): void {
  if (!query) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parent.appendChild(document.createTextNode(text.slice(i)));
      break;
    }
    if (idx > i) parent.appendChild(document.createTextNode(text.slice(i, idx)));
    const mark = parent.createSpan({
      cls: "ggai-ctx-hit",
      text: text.slice(idx, idx + query.length),
    });
    hits.push(mark);
    i = idx + query.length;
  }
}

function addMeta(parent: HTMLElement, label: string, value: string): void {
  const row = parent.createDiv({ cls: "ggai-ctx-meta-row" });
  row.createSpan({ cls: "ggai-ctx-meta-label", text: label });
  row.createSpan({ cls: "ggai-ctx-meta-value", text: value });
}
