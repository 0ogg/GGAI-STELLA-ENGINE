/**
 * ViewStylePopover — 세션창 본문 보기 설정(문단 간격/들여쓰기/최대폭/글자 크기).
 * 툴바 버튼에 앵커된 작은 플로팅 카드(이북 뷰어의 보기 설정 느낌). 큰 모달 대신
 * 버튼 위에 붙어 뜨고, 바깥 클릭·Esc 로 닫힌다. 슬라이더는 즉시 미리보기(onChange)
 * 되고 손을 떼면 전역 PluginData 에 저장 — 모든 세션창 공통.
 */
import { setIcon } from "obsidian";
import type StellaEnginePlugin from "../main";
import {
  DEFAULT_SESSION_VIEW_STYLE,
  SESSION_VIEW_STYLE_LIMITS,
  type SessionViewStyle,
} from "../util/view-style";

interface RowSpec {
  key: keyof SessionViewStyle;
  label: string;
  icon: string;
  format: (v: number) => string;
}

const ROWS: RowSpec[] = [
  {
    key: "fontScale",
    label: "글자 크기",
    icon: "a-large-small",
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: "paragraphGap",
    label: "문단 간격",
    icon: "unfold-vertical",
    format: (v) => `${Math.round(v)}`,
  },
  {
    key: "indent",
    label: "들여쓰기",
    icon: "indent-increase",
    format: (v) => v.toFixed(1),
  },
  {
    key: "maxWidth",
    label: "본문 폭",
    icon: "move-horizontal",
    format: (v) => `${Math.round(v)}`,
  },
];

export class ViewStylePopover {
  private el: HTMLElement | null = null;
  private style: SessionViewStyle;
  private onDocMouseDown = (e: MouseEvent) => this.onOutside(e);
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.close();
  };

  constructor(
    private plugin: StellaEnginePlugin,
    current: SessionViewStyle,
    /** 슬라이더 조작 중 실시간 미리보기 — 세션창이 즉시 반영. */
    private onChange: (style: SessionViewStyle) => void
  ) {
    this.style = { ...current };
  }

  /** anchor 버튼 위에 카드를 띄운다. 이미 열려 있으면 토글로 닫는다. */
  open(anchor: HTMLElement): void {
    const doc = anchor.ownerDocument;
    const card = doc.body.createDiv({ cls: "ggai-vs-popover" });
    this.el = card;

    const head = card.createDiv({ cls: "ggai-vs-head" });
    head.createSpan({ cls: "ggai-vs-title", text: "보기 설정" });
    const reset = head.createEl("button", {
      cls: "clickable-icon ggai-vs-reset",
      attr: { "aria-label": "기본값으로" },
    });
    setIcon(reset, "rotate-ccw");
    reset.addEventListener("click", () => this.reset());

    for (const spec of ROWS) this.renderRow(card, spec);

    this.position(anchor, card);

    // 여는 클릭이 곧바로 바깥 클릭으로 잡혀 닫히지 않도록 다음 tick 에 리스너 등록.
    window.setTimeout(() => {
      doc.addEventListener("mousedown", this.onDocMouseDown, true);
      doc.addEventListener("keydown", this.onKeyDown, true);
    }, 0);
  }

  close(): void {
    if (!this.el) return;
    const doc = this.el.ownerDocument;
    doc.removeEventListener("mousedown", this.onDocMouseDown, true);
    doc.removeEventListener("keydown", this.onKeyDown, true);
    this.el.remove();
    this.el = null;
  }

  isOpen(): boolean {
    return this.el != null;
  }

  private onOutside(e: MouseEvent): void {
    if (this.el && !this.el.contains(e.target as Node)) this.close();
  }

  private reset(): void {
    this.style = { ...DEFAULT_SESSION_VIEW_STYLE };
    this.onChange(this.style);
    void this.plugin.saveViewStyle(this.style);
    // 카드 안 값/슬라이더 갱신.
    if (!this.el) return;
    this.el
      .querySelectorAll<HTMLInputElement>(".ggai-vs-slider")
      .forEach((slider) => {
        const key = slider.dataset.key as keyof SessionViewStyle;
        slider.value = String(this.style[key]);
        slider.dispatchEvent(new Event("refresh"));
      });
  }

  private renderRow(parent: HTMLElement, spec: RowSpec): void {
    const lim = SESSION_VIEW_STYLE_LIMITS[spec.key];
    const row = parent.createDiv({ cls: "ggai-vs-row" });

    const iconEl = row.createSpan({ cls: "ggai-vs-icon" });
    setIcon(iconEl, spec.icon);
    row.createSpan({ cls: "ggai-vs-row-label", text: spec.label });
    const valueEl = row.createSpan({
      cls: "ggai-vs-value",
      text: spec.format(this.style[spec.key]),
    });

    const slider = row.createEl("input", {
      cls: "ggai-vs-slider",
      attr: {
        type: "range",
        min: String(lim.min),
        max: String(lim.max),
        step: String(lim.step),
        value: String(this.style[spec.key]),
      },
    }) as HTMLInputElement;
    slider.dataset.key = spec.key;

    const sync = () => valueEl.setText(spec.format(this.style[spec.key]));
    slider.addEventListener("input", () => {
      this.style = { ...this.style, [spec.key]: Number(slider.value) };
      sync();
      this.onChange(this.style);
    });
    slider.addEventListener("change", () =>
      void this.plugin.saveViewStyle(this.style)
    );
    // reset() 이 값만 바꾼 뒤 라벨 갱신을 요청하는 커스텀 이벤트.
    slider.addEventListener("refresh", sync);
  }

  /** 버튼 위에 카드를 배치 — 우측 정렬, 화면 밖으로 나가지 않게 클램프. */
  private position(anchor: HTMLElement, card: HTMLElement): void {
    const a = anchor.getBoundingClientRect();
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const margin = 8;
    let left = a.right - cw;
    left = Math.max(margin, Math.min(left, window.innerWidth - cw - margin));
    let top = a.top - ch - margin;
    if (top < margin) top = a.bottom + margin; // 위 공간 부족하면 아래로.
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }
}
