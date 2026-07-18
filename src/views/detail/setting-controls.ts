import { setIcon } from "obsidian";
import type {
  GenerationProfileLite,
  ImageProfileLite,
} from "../../services/ai-service";
import { attachLongPress } from "../../util/long-press";

/**
 * 스텔라 설정 컨트롤 킷.
 *
 * 기본 탭·확장 탭·미디어 설정 등 모든 설정 화면이 같은 모양·같은 동작을 갖도록
 * 접이식 패널, 모델 선택, 옵션 그리드, 숫자 입력, 슬라이더, 온오프 토글을 한 곳에 모은다.
 * CSS 클래스는 기존 것을 그대로 써 화면이 바뀌지 않는다 — 여기서 규칙만 통일한다.
 *
 * 새 확장 설정 항목을 추가할 때는 이 함수들을 재사용해 UI 일관성을 유지한다.
 */

export type SettingModelProfile = GenerationProfileLite | ImageProfileLite;

/**
 * 접이식 패널 껍데기 — 헤더(클릭/Enter/Space 토글, aria-expanded) + 본문.
 * `container` 는 호출부가 만든 패널 루트(보통 `ggai-collapsible` 포함). 본문 엘리먼트를 반환한다.
 * 접힘 상태는 호출부가 소유하며 `onToggle` 로 전달받는다.
 */
export function renderCollapsibleShell(opts: {
  container: HTMLElement;
  title: string;
  bodyCls: string;
  collapsed: boolean;
  onToggle: (collapsed: boolean) => void;
}): {
  header: HTMLElement;
  body: HTMLElement;
  /** 외부에서 접힘 상태를 특정 값으로 강제 (전체 접기/펼치기용). onToggle 도 함께 발화. */
  setCollapsed: (collapsed: boolean) => void;
} {
  let collapsed = opts.collapsed;
  const header = opts.container.createDiv({
    cls: "ggai-section-header is-clickable",
  });
  header.createSpan({ cls: "ggai-section-title", text: opts.title });
  header.setAttr("role", "button");
  header.setAttr("tabindex", "0");
  header.setAttr("aria-expanded", String(!collapsed));

  const body = opts.container.createDiv({ cls: opts.bodyCls });
  body.toggleClass("is-collapsed", collapsed);

  const apply = (next: boolean) => {
    collapsed = next;
    body.toggleClass("is-collapsed", collapsed);
    header.setAttr("aria-expanded", String(!collapsed));
    opts.onToggle(collapsed);
  };
  const toggle = () => apply(!collapsed);
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    toggle();
  });

  return {
    header,
    body,
    setCollapsed: (v: boolean) => {
      if (v !== collapsed) apply(v);
    },
  };
}

/**
 * 모델 선택 버튼줄 — 프로필 버튼(이름 + TEXT/IMG 태그 + 기본/활성 표시) + ⚙ Core 설정 버튼.
 * `onLongPressEdit` 를 주면 버튼을 꾹 눌러 Core 의 해당 프로필 편집으로 바로 이동한다.
 * (텍스트/이미지/요약 등 어느 설정에서 써도 같은 동작.)
 */
export function renderModelPicker(opts: {
  parent: HTMLElement;
  profiles: SettingModelProfile[];
  activeId: string | undefined;
  emptyText: string;
  onSelect: (profile: SettingModelProfile) => void;
  onOpenSettings: () => void;
  onLongPressEdit?: (profile: SettingModelProfile) => void;
}): void {
  const row = opts.parent.createDiv({ cls: "ggai-model-row" });

  if (opts.profiles.length === 0) {
    row.createDiv({ cls: "ggai-detail-empty", text: opts.emptyText });
  } else {
    for (const p of opts.profiles) {
      const btn = row.createEl("button", {
        cls: "ggai-model-btn",
        attr: { title: modelBtnTitle(p, !!opts.onLongPressEdit) },
      });
      btn.createSpan({ cls: "ggai-model-name", text: p.name });
      if (p.kind === "text") {
        btn.createSpan({ cls: "ggai-model-kind-tag", text: "TEXT" });
      } else if (p.kind === "image") {
        btn.createSpan({ cls: "ggai-model-kind-tag", text: "IMG" });
      }
      if (p.isDefault) btn.addClass("is-default");
      if (p.id === opts.activeId) btn.addClass("is-active");
      if (opts.onLongPressEdit) {
        attachLongPress(btn, {
          onLongPress: () => opts.onLongPressEdit!(p),
          onTap: () => opts.onSelect(p),
        });
      } else {
        btn.addEventListener("click", () => opts.onSelect(p));
      }
    }
  }

  const settingsBtn = row.createEl("button", {
    cls: "ggai-model-btn ggai-model-settings",
    attr: { "aria-label": "GGAI Core 설정 열기" },
  });
  setIcon(settingsBtn, "settings");
  settingsBtn.addEventListener("click", () => opts.onOpenSettings());
}

function modelBtnTitle(p: SettingModelProfile, longPress: boolean): string {
  const prefix = p.kind === "text" ? "Text · " : "";
  const base = `${prefix}${p.provider} · ${p.model}`;
  return longPress ? `${base} · 길게 눌러 편집` : base;
}

/**
 * 다중 택일 옵션 그리드 (예: 번역 "출력 방식", 삽화 "출력 위치").
 * 프리셋 버튼 스타일 한 줄. 비활성 옵션은 disabled + 안내 title.
 */
export function renderOptionGrid<T extends string>(opts: {
  parent: HTMLElement;
  label: string;
  options: Array<{ id: T; label: string; disabled?: boolean; disabledTitle?: string }>;
  activeId: T;
  onSelect: (id: T) => void;
}): void {
  const block = opts.parent.createDiv({ cls: "ggai-media-block" });
  block.createDiv({ cls: "ggai-media-label", text: opts.label });
  const row = block.createDiv({ cls: "ggai-preset-grid ggai-media-prompt-grid" });
  for (const opt of opts.options) {
    const btn = row.createEl("button", { cls: "ggai-preset-btn", text: opt.label });
    if (opt.id === opts.activeId) btn.addClass("is-active");
    if (opt.disabled) {
      btn.disabled = true;
      if (opt.disabledTitle) btn.setAttr("title", opt.disabledTitle);
    } else {
      btn.addEventListener("click", () => opts.onSelect(opt.id));
    }
  }
}

/**
 * 라벨 + 숫자 입력 한 줄. change 시 최솟값/정수 클램프 후 콜백.
 * 입력 엘리먼트를 반환하므로 외부 동기화가 필요하면 호출부가 참조를 보관한다.
 */
export function renderNumberRow(opts: {
  parent: HTMLElement;
  label: string;
  value: number;
  fallback: number;
  min?: number;
  step?: number;
  integer?: boolean;
  onChange: (value: number) => void;
}): HTMLInputElement {
  const row = opts.parent.createDiv({ cls: "ggai-media-number-row" });
  row.createSpan({ cls: "ggai-media-label", text: opts.label });
  const attr: Record<string, string> = {};
  if (opts.min != null) attr.min = String(opts.min);
  if (opts.step != null) attr.step = String(opts.step);
  const input = row.createEl("input", {
    cls: "ggai-media-number-input",
    type: "number",
    attr,
  });
  input.value = String(opts.value);
  input.addEventListener("change", () => {
    const parsed = Number(input.value);
    // "|| fallback" 는 0 을 falsy 로 오인해 사용자가 의도적으로 입력한 0 을 지워버린다
    // (예: 삽화 자동 생성 주기의 "0 = 매번"). NaN 일 때만 fallback 으로 되돌린다.
    const raw = Number.isNaN(parsed) ? opts.fallback : parsed;
    let v = Math.max(opts.min ?? -Infinity, raw);
    if (opts.integer) v = Math.round(v);
    input.value = String(v);
    opts.onChange(v);
  });
  return input;
}

/**
 * 라벨 + 한 줄 텍스트 입력 (change 시점 커밋 — 타이핑 중 재렌더를 유발하지 않는다).
 */
export function renderTextRow(opts: {
  parent: HTMLElement;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}): HTMLInputElement {
  const row = opts.parent.createDiv({ cls: "ggai-media-number-row" });
  row.createSpan({ cls: "ggai-media-label", text: opts.label });
  const input = row.createEl("input", {
    cls: "ggai-media-text-input",
    type: "text",
    attr: opts.placeholder ? { placeholder: opts.placeholder } : {},
  });
  input.value = opts.value;
  input.addEventListener("change", () => opts.onChange(input.value.trim()));
  return input;
}

/**
 * 온오프 토글 — 박스 안에 라벨 + 체크박스. 박스 아무 곳이나 눌러도 토글.
 */
export function renderEnableToggle(opts: {
  parent: HTMLElement;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): void {
  const block = opts.parent.createDiv({ cls: "ggai-media-block ggai-media-enable" });
  block.createSpan({ cls: "ggai-media-label", text: opts.label });
  const toggle = block.createEl("input", {
    cls: "ggai-form-checkbox",
    type: "checkbox",
  });
  toggle.checked = opts.checked;
  toggle.addEventListener("change", () => opts.onChange(toggle.checked));
  block.addEventListener("click", (e) => {
    if (e.target === toggle) return;
    opts.onChange(!toggle.checked);
  });
}

/**
 * 라벨 + 숫자 입력 + 슬라이더 한 줄. 슬라이더와 숫자 입력이 서로 동기화된다.
 * 값 정규화/표시는 호출부가 `normalize`/`format` 으로 넘긴다.
 *
 *  - `onChange(v)` — 슬라이더 드래그/입력 중 (라이브 저장 예약).
 *  - `onCommit()`  — release/blur (즉시 저장 flush).
 *  - `unset` — 미설정 값이면 라벨/입력/슬라이더를 흐리게(`is-unset`). 만지면 `markSet()` 이 해제.
 */
export function renderSliderRow(opts: {
  parent: HTMLElement;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unset: boolean;
  format: (v: number) => string;
  normalize: (raw: number) => number;
  onChange: (v: number) => void;
  onCommit: () => void;
}): { markSet: () => void } {
  const row = opts.parent.createDiv({ cls: "ggai-param-row" });

  const labelRow = row.createDiv({ cls: "ggai-param-label-row" });
  const labelEl = labelRow.createSpan({ cls: "ggai-param-label", text: opts.label });
  if (opts.unset) labelEl.addClass("is-unset");

  const valueInput = labelRow.createEl("input", {
    cls: "ggai-param-value",
    attr: {
      type: "number",
      min: String(opts.min),
      max: String(opts.max),
      step: String(opts.step),
      value: opts.format(opts.value),
    },
  }) as HTMLInputElement;
  if (opts.unset) valueInput.addClass("is-unset");

  const slider = row.createEl("input", {
    cls: "ggai-param-slider",
    attr: {
      type: "range",
      min: String(opts.min),
      max: String(opts.max),
      step: String(opts.step),
      value: String(opts.value),
    },
  }) as HTMLInputElement;
  if (opts.unset) slider.addClass("is-unset");

  const markSet = () => {
    labelEl.removeClass("is-unset");
    valueInput.removeClass("is-unset");
    slider.removeClass("is-unset");
  };

  slider.addEventListener("input", () => {
    const v = opts.normalize(Number(slider.value));
    valueInput.value = opts.format(v);
    markSet();
    opts.onChange(v);
  });
  // 슬라이더 release / blur 즉시 저장 — debounce 가 후속 클릭에 못 따라가는 race 방지.
  slider.addEventListener("change", () => opts.onCommit());

  valueInput.addEventListener("input", () => {
    const raw = Number(valueInput.value);
    if (!Number.isFinite(raw) || raw < opts.min || raw > opts.max) return;
    const v = opts.normalize(raw);
    slider.value = String(v);
    markSet();
    opts.onChange(v);
  });
  valueInput.addEventListener("change", () => {
    const v = opts.normalize(Number(valueInput.value));
    valueInput.value = opts.format(v);
    slider.value = String(v);
    markSet();
    opts.onChange(v);
    opts.onCommit();
  });

  return { markSet };
}
