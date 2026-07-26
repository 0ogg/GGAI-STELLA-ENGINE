/**
 * 세션창 빠른 답장(QR) 바 — 하단 툴바 바로 위 좌측의 `QR △` 토글과 버튼 줄.
 *
 * 소설/챗 세션 뷰가 공유한다 (뷰별 복붙 금지 — session-command-bar.ts 와 같은 규약).
 * 실제로 무엇을 실행할지는 호스트가 `runText` 로 넘긴다:
 *   - 챗: 입력창에 넣고 (disableSend 아니면) 전송
 *   - 소설: 본문 끝에 user-write 로 붙이고 (disableSend 아니면) 이어쓰기
 *
 * `/` 로 시작하는 버튼은 커맨드 스크립트 — 파싱/실행은 `services/qr-runner.ts`.
 * 상세는 `QR 스펙.md`.
 */

import { Menu, Notice, setIcon } from "obsidian";
import type StellaEnginePlugin from "../main";
import { runQuickReplyScript } from "../services/qr-runner";
import { isQrCommandScript } from "../util/qr-script";
import { collectAutoQuickReplies } from "../types/quick-reply";
import type {
  AutoExecuteFlagKey,
  StellaQuickReply,
  StellaQuickReplySet,
} from "../types/quick-reply";
import type { QuickReplyListItem } from "../util/scan-quick-replies";

export interface QuickReplyBarHost {
  /**
   * 이 세션의 파일 경로. 없으면 바를 그리지 않는다.
   * 스냅샷이 아니라 함수 — 뷰가 다른 세션으로 갈아끼워져도 최신 값을 본다.
   */
  sessionFile(): string | null;
  /**
   * 버튼 내용을 실제로 실행한다.
   * @param text 매크로/입력 합성이 끝난 최종 텍스트
   * @param send 전송까지 할지 (세트의 disableSend 반영 결과)
   */
  runText(text: string, send: boolean): void | Promise<void>;
  /** 입력창의 현재 텍스트 — injectInput 합성용. 없으면 "". */
  currentInput?(): string;
}

export class SessionQuickReplyBar {
  private plugin: StellaEnginePlugin;
  private host: QuickReplyBarHost;
  private root: HTMLElement;

  private sets: QuickReplyListItem[] = [];
  private activeIds: string[] = [];
  private toggleEl: HTMLElement | null = null;
  private stripEl: HTMLElement | null = null;
  private open = false;
  /** 자동 실행 재진입 가드 — 자동 실행이 부른 생성이 또 자동 실행을 부르지 않게. */
  private autoBusy = false;

  constructor(
    parent: HTMLElement,
    plugin: StellaEnginePlugin,
    host: QuickReplyBarHost
  ) {
    this.plugin = plugin;
    this.host = host;
    this.root = parent.createDiv({ cls: "ggai-qr-bar" });
    this.open = plugin.data.quickReplyBarOpen === true;
  }

  /** 세트 목록 + 활성 설정을 읽어 다시 그린다. */
  async refresh(): Promise<void> {
    this.sets = await this.plugin.store
      .getQuickReplySets()
      .catch((): QuickReplyListItem[] => []);
    this.activeIds = await this.readActiveIds();
    this.render();
  }

  private async readActiveIds(): Promise<string[]> {
    const file = this.host.sessionFile();
    if (file) {
      const session = await this.plugin.store.getSession(file);
      const ids = session?.meta.quickReply?.setIds;
      if (Array.isArray(ids)) return ids;
    }
    return this.plugin.data.current?.quickReply?.setIds ?? [];
  }

  private activeSets(): QuickReplyListItem[] {
    if (this.activeIds.length === 0) return [];
    const byId = new Map(this.sets.map((s) => [s.set.meta.id, s]));
    return this.activeIds
      .map((id) => byId.get(id))
      .filter((s): s is QuickReplyListItem => !!s);
  }

  private render(): void {
    this.root.empty();
    this.toggleEl = null;
    this.stripEl = null;
    if (!this.host.sessionFile()) return;

    const head = this.root.createDiv({ cls: "ggai-qr-bar-head" });
    const toggle = head.createEl("button", { cls: "ggai-qr-bar-toggle" });
    toggle.createSpan({ cls: "ggai-qr-bar-toggle-text", text: "QR" });
    const chev = toggle.createSpan({ cls: "ggai-qr-bar-toggle-chev" });
    setIcon(chev, this.open ? "chevron-down" : "chevron-up");
    toggle.setAttr("aria-expanded", String(this.open));
    toggle.setAttr("aria-label", "빠른 답장");
    toggle.addEventListener("click", () => void this.toggleOpen());
    this.toggleEl = toggle;

    if (!this.open) return;

    const strip = this.root.createDiv({ cls: "ggai-qr-bar-strip" });
    this.stripEl = strip;

    const active = this.activeSets();
    const visible = active.flatMap((item) =>
      item.set.qrList
        .filter((qr) => !qr.isHidden)
        .map((qr) => ({ item, qr }))
    );

    if (visible.length === 0) {
      strip.createSpan({
        cls: "ggai-qr-bar-empty",
        text:
          this.sets.length === 0
            ? "세트가 없습니다 — 대시보드 [빠른 답장] 탭에서 만드세요"
            : "켜진 세트가 없습니다 — 오른쪽 톱니로 고르세요",
      });
    }

    for (const { item, qr } of visible) {
      const btn = strip.createEl("button", { cls: "ggai-qr-chip" });
      if (qr.icon) {
        const ic = btn.createSpan({ cls: "ggai-qr-chip-icon" });
        setIcon(ic, qr.icon);
      }
      if (!qr.icon || qr.showLabel || !qr.label) {
        btn.createSpan({
          cls: "ggai-qr-chip-label",
          text: qr.label || "(이름 없음)",
        });
      }
      if (qr.title) btn.setAttr("aria-label", qr.title);
      btn.setAttr("data-tooltip-position", "top");
      if (item.set.color) {
        if (item.set.onlyBorderColor) btn.style.borderColor = item.set.color;
        else btn.style.backgroundColor = item.set.color;
      }
      if (qr.contextList.length > 0) {
        const mark = btn.createSpan({ cls: "ggai-qr-chip-sub" });
        setIcon(mark, "chevron-up");
      }
      btn.addEventListener("click", (e) => {
        if (qr.contextList.length > 0) {
          this.openSubMenu(qr, { x: e.clientX, y: e.clientY });
          return;
        }
        void this.execute(item.set, qr);
      });
    }

    const gear = strip.createEl("button", {
      cls: "ggai-qr-bar-gear clickable-icon",
    });
    setIcon(gear, "settings-2");
    gear.setAttr("aria-label", "세트 고르기");
    gear.addEventListener("click", (e) => this.openSetMenu(e));
  }

  private async toggleOpen(): Promise<void> {
    this.open = !this.open;
    await this.plugin.savePluginData({ quickReplyBarOpen: this.open });
    this.render();
  }

  /** 하위 메뉴(QR 안의 QR) — 링크된 세트의 버튼들을 위로 띄운다. */
  private openSubMenu(
    parent: StellaQuickReply,
    at: { x: number; y: number },
    opts?: {
      /** 이어붙이기(isChained)로 앞에 붙일 상위 버튼들 — 위에서 아래 순서. */
      chain?: StellaQuickReply[];
      /** 지금까지 거쳐온 세트 이름 — 순환 참조 방지(ST 와 같은 방식). */
      hierarchy?: string[];
      /** 상위 메뉴 다시 열기 (드릴다운에서 잘못 들어갔을 때). */
      back?: () => void;
    }
  ): void {
    const chain = opts?.chain ?? [];
    const hierarchy = opts?.hierarchy ?? [];
    const menu = new Menu();
    if (opts?.back) {
      menu.addItem((mi) =>
        mi
          .setTitle("← 뒤로")
          .setIcon("arrow-left")
          .onClick(() => opts.back!())
      );
      menu.addSeparator();
    }
    let any = false;
    for (const link of parent.contextList) {
      // 이미 거쳐온 세트는 건너뛴다 — 서로를 하위로 단 세트가 있어도 무한히
      // 파고들지 않는다(ST 의 hierarchy 가드와 같은 규칙).
      if (hierarchy.includes(link.set)) continue;
      const target = this.sets.find((s) => s.set.name === link.set);
      if (!target) continue;
      // 이 링크 아래에서 실행되는 버튼에 앞에 붙을 내용 — 이어붙이기면 상위가 쌓인다.
      const nextChain = link.isChained ? [...chain, parent] : [];
      const nextHierarchy = [...hierarchy, link.set];
      for (const qr of target.set.qrList) {
        if (qr.isHidden) continue;
        any = true;
        // 하위 메뉴를 또 가진 버튼 = 다음 단계로 내려간다(ST 는 단계 제한이 없다).
        // 옵시디언 메뉴의 서브메뉴 API 대신 **드릴다운**으로 편다 — 모바일에서도
        // 같게 동작하고 설치된 옵시디언 버전을 타지 않는다.
        const drill =
          qr.contextList.length > 0 &&
          qr.contextList.some((c) => !nextHierarchy.includes(c.set));
        menu.addItem((mi) => {
          mi.setTitle(
            (qr.label || "(이름 없음)") + (drill ? "  ▸" : "")
          ).setIcon(qr.icon || "message-square");
          mi.onClick(() => {
            if (drill) {
              this.openSubMenu(qr, at, {
                chain: nextChain,
                hierarchy: nextHierarchy,
                back: () => this.openSubMenu(parent, at, opts),
              });
              return;
            }
            void this.execute(target.set, qr, { chainWith: nextChain });
          });
        });
      }
    }
    if (!any) {
      menu.addItem((mi) =>
        mi.setTitle("하위 버튼이 없습니다").setDisabled(true)
      );
    }
    menu.showAtPosition(at);
  }

  /** 세트 켜기/끄기 + 대시보드 이동. */
  private openSetMenu(e: MouseEvent): void {
    const menu = new Menu();
    if (this.sets.length === 0) {
      menu.addItem((mi) => mi.setTitle("세트가 없습니다").setDisabled(true));
    }
    for (const item of this.sets) {
      const on = this.activeIds.includes(item.set.meta.id);
      menu.addItem((mi) =>
        mi
          .setTitle(item.set.name)
          .setChecked(on)
          .onClick(() => void this.toggleSet(item.set.meta.id))
      );
    }
    menu.addSeparator();
    menu.addItem((mi) =>
      mi
        .setTitle("빠른 답장 관리")
        .setIcon("zap")
        .onClick(() => void this.plugin.openStellaDashboardTab("quickReply"))
    );
    menu.showAtMouseEvent(e);
  }

  private async toggleSet(id: string): Promise<void> {
    const next = this.activeIds.includes(id)
      ? this.activeIds.filter((x) => x !== id)
      : [...this.activeIds, id];
    this.activeIds = next;
    const file = this.host.sessionFile();
    if (file) {
      await this.plugin.patchActiveSettings({ quickReply: { setIds: next } }, file);
    } else {
      await this.plugin.savePluginData({
        current: {
          ...(this.plugin.data.current ?? {}),
          quickReply: { setIds: next },
        },
      });
    }
    this.render();
  }

  /**
   * 자동 실행 — 이 시점 플래그가 켜진 버튼을 **누른 것과 똑같은 경로**로 돌린다.
   * (별도 실행 경로를 만들지 않는다 — 체인/injectInput/커맨드 판정이 갈라지면
   *  "눌렀을 땐 되는데 자동으로는 안 되는" 버튼이 생긴다.)
   *
   * 재진입 금지: 자동 실행이 만든 생성/입력이 다시 자동 실행을 부르는 고리를 끊는다
   * (`AI 응답 뒤` 버튼이 전송까지 하면 응답 → 자동 실행 → 응답 … 으로 무한히 돈다).
   */
  async runAuto(trigger: AutoExecuteFlagKey): Promise<void> {
    if (this.autoBusy) return;
    if (!this.host.sessionFile()) return;
    // 바가 아직 안 열렸어도 자동 실행은 돌아야 한다 — 목록을 직접 읽는다.
    if (this.sets.length === 0) {
      this.sets = await this.plugin.store
        .getQuickReplySets()
        .catch((): QuickReplyListItem[] => []);
    }
    this.activeIds = await this.readActiveIds();
    const targets = collectAutoQuickReplies(
      this.activeSets().map((i) => i.set),
      trigger
    );
    if (targets.length === 0) return;

    this.autoBusy = true;
    try {
      for (const { set, qr } of targets) {
        try {
          await this.execute(set, qr);
        } catch (err) {
          console.warn("[GGAI Stella] 빠른 답장 자동 실행 실패:", qr.label, err);
        }
      }
    } finally {
      this.autoBusy = false;
    }
  }

  /**
   * 버튼 실행. `/` 로 시작하면 커맨드 스크립트(qr-runner), 아니면 입력/전송.
   * 세트 플래그(injectInput/placeBeforeInput/disableSend)는 ST 규칙 그대로 반영.
   */
  private async execute(
    set: StellaQuickReplySet,
    qr: StellaQuickReply,
    opts?: { chainWith?: StellaQuickReply[] }
  ): Promise<void> {
    let text = qr.message;
    // isChained — 상위 버튼 내용 뒤에 이어붙인다(ST 규칙). 하위 메뉴가 여러 단이면
    // 이어붙이기가 켜진 단계들이 위에서부터 차례로 쌓인다. 한쪽이 커맨드면 파이프로
    // 이어야 두 스크립트가 순서대로 실행된다(줄바꿈은 한 덩어리로 붙는다).
    for (const ancestor of [...(opts?.chainWith ?? [])].reverse()) {
      const joiner =
        isQrCommandScript(ancestor.message) || isQrCommandScript(text)
          ? " | "
          : "\n";
      text = `${ancestor.message}${joiner}${text}`;
    }

    if (isQrCommandScript(text)) {
      try {
        await runQuickReplyScript(this.plugin, {
          sessionFile: () => this.host.sessionFile(),
          runText: (t, send) => this.host.runText(t, send),
        }, text);
      } catch (err) {
        console.warn("[GGAI Stella] 빠른 답장 커맨드 실패:", err);
        new Notice("빠른 답장 커맨드 실행 실패");
      }
      return;
    }

    if (set.injectInput) {
      const cur = this.host.currentInput?.() ?? "";
      if (cur) text = set.placeBeforeInput ? `${text}${cur}` : `${cur}${text}`;
    }

    try {
      await this.host.runText(text, !set.disableSend);
    } catch (err) {
      console.warn("[GGAI Stella] 빠른 답장 실행 실패:", err);
      new Notice("빠른 답장 실행 실패");
    }
  }
}
