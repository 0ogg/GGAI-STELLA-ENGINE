/**
 * 공통 폼 렌더러 — "필드 정의 배열 → DOM 위젯".
 *
 * 사용 의도: 로어북 책/엔트리 폼, 추후 시나리오 폼 등에서 같은 함수로 렌더링.
 * 새 편집 영역 추가 시 FieldDef[] 만 선언하면 위젯 자동 생성.
 *
 * 위젯 종류 (kind):
 *  - "text"     : 짧은 인풋 또는 textarea (rows>1).
 *  - "checkbox" : 불리언 토글.
 *  - "number"   : 숫자 (min/max/step 옵션).
 *  - "select"   : 드롭다운.
 *  - "tags"     : 콤마/엔터 구분 문자열 배열 — 키워드 같은 것.
 *
 * 값 모델: 단일 객체 `value`. FieldDef.key 가 객체의 프로퍼티 이름.
 * onChange 는 해당 필드 키와 새 값을 받음 — 호출부가 객체 mutation + 저장 처리.
 *
 * `visibleWhen` 으로 동적 표시 가능 (예: position=at_depth 일 때만 depth 노출).
 */

export type FieldDef =
  | TextFieldDef
  | CheckboxFieldDef
  | NumberFieldDef
  | SelectFieldDef
  | TagsFieldDef;

interface CommonFieldDef {
  key: string;
  label: string;
  hint?: string;
  /** 현재 값에 따라 노출 여부 결정. true 반환 시 노출. */
  visibleWhen?: (value: any) => boolean;
}

export interface TextFieldDef extends CommonFieldDef {
  kind: "text";
  /** 1 = single-line input, >=2 = textarea. */
  rows?: number;
  placeholder?: string;
}

export interface CheckboxFieldDef extends CommonFieldDef {
  kind: "checkbox";
}

export interface NumberFieldDef extends CommonFieldDef {
  kind: "number";
  min?: number;
  max?: number;
  step?: number;
  /** null 허용 — 빈 입력 시 null 로 설정. */
  nullable?: boolean;
}

export interface SelectFieldDef extends CommonFieldDef {
  kind: "select";
  options: { value: string; label: string }[];
}

export interface TagsFieldDef extends CommonFieldDef {
  kind: "tags";
  placeholder?: string;
}

/**
 * 폼 렌더링.
 *
 *  - parent: 폼이 그려질 컨테이너. 호출 시 비워지지 않으니 호출부가 필요시 비울 것.
 *  - defs: 필드 정의 배열.
 *  - value: 값 객체 (호출부가 보유). 렌더러는 read-only 로 사용.
 *  - onChange: 필드 변경 시 호출. 호출부가 `value[key] = newValue` 후 저장.
 *  - onCommit (선택): input/textarea blur 시 호출. 호출부가 debounce 펜딩을 즉시 flush 하는 데 사용.
 *    blur 시점에 디스크에 박아두면 사용자가 갑자기 앱을 닫아도 데이터 소실 안 됨.
 *
 * 반환 값: { rerender } — visibleWhen 등 의존 필드가 바뀌어 다시 그려야 할 때 호출.
 */
export function renderForm(
  parent: HTMLElement,
  defs: FieldDef[],
  value: Record<string, any>,
  onChange: (key: string, newValue: any) => void,
  onCommit?: () => void
): { rerender: () => void } {
  const root = parent.createDiv({ cls: "ggai-form" });

  let compositionActive = false;
  root.addEventListener("compositionstart", () => { compositionActive = true; });
  root.addEventListener("compositionend", () => { compositionActive = false; });

  const visibleKeys = () => {
    const keys: string[] = [];
    for (const d of defs) {
      if (!d.visibleWhen || d.visibleWhen(value)) keys.push(d.key);
    }
    keys.sort();
    return keys.join("\x00");
  };

  const draw = (force = false) => {
    root.empty();
    for (const def of defs) {
      if (def.visibleWhen && !def.visibleWhen(value)) continue;
      renderField(root, def, value, (k, v) => {
        const prev = visibleKeys();
        onChange(k, v);
        if (compositionActive) return;
        const next = visibleKeys();
        if (force || prev !== next) draw();
      }, onCommit);
    }
  };

  draw();
  return { rerender: draw };
}

// ─── 개별 필드 렌더러 ─────────────────────────────────────────────────

function renderField(
  parent: HTMLElement,
  def: FieldDef,
  value: Record<string, any>,
  onChange: (key: string, v: any) => void,
  onCommit?: () => void
): void {
  const wrap = parent.createDiv({ cls: "ggai-form-field" });
  const label = wrap.createDiv({ cls: "ggai-form-label" });
  label.textContent = def.label;
  if (def.hint) {
    wrap.createDiv({ cls: "ggai-form-hint", text: def.hint });
  }

  switch (def.kind) {
    case "text":
      renderTextField(wrap, def, value, onChange, onCommit);
      break;
    case "checkbox":
      renderCheckboxField(wrap, def, value, onChange, onCommit);
      break;
    case "number":
      renderNumberField(wrap, def, value, onChange, onCommit);
      break;
    case "select":
      renderSelectField(wrap, def, value, onChange, onCommit);
      break;
    case "tags":
      renderTagsField(wrap, def, value, onChange, onCommit);
      break;
  }
}

function renderTextField(
  wrap: HTMLElement,
  def: TextFieldDef,
  value: Record<string, any>,
  onChange: (key: string, v: any) => void,
  onCommit?: () => void
): void {
  const initial = typeof value[def.key] === "string" ? (value[def.key] as string) : "";
  const rows = def.rows ?? 1;
  if (rows <= 1) {
    const input = wrap.createEl("input", {
      cls: "ggai-form-input",
      type: "text",
    });
    input.value = initial;
    if (def.placeholder) input.placeholder = def.placeholder;
    input.addEventListener("input", () => onChange(def.key, input.value));
    if (onCommit) input.addEventListener("blur", () => onCommit());
  } else {
    const ta = wrap.createEl("textarea", { cls: "ggai-form-textarea" });
    ta.value = initial;
    ta.rows = rows;
    if (def.placeholder) ta.placeholder = def.placeholder;
    ta.addEventListener("input", () => onChange(def.key, ta.value));
    if (onCommit) ta.addEventListener("blur", () => onCommit());
  }
}

function renderCheckboxField(
  wrap: HTMLElement,
  def: CheckboxFieldDef,
  value: Record<string, any>,
  onChange: (key: string, v: any) => void,
  onCommit?: () => void
): void {
  // 체크박스는 라벨 옆에 배치하는 게 자연스러움 — 라벨 div 다시 가공.
  const labelEl = wrap.querySelector(".ggai-form-label");
  if (labelEl instanceof HTMLElement) labelEl.addClass("is-inline");
  const cb = wrap.createEl("input", { type: "checkbox", cls: "ggai-form-checkbox" });
  cb.checked = value[def.key] === true;
  cb.addEventListener("change", () => {
    onChange(def.key, cb.checked);
    onCommit?.(); // 체크는 항상 의도 있는 변경이므로 즉시 commit.
  });
  // 라벨을 체크박스 뒤로 이동
  if (labelEl) wrap.insertBefore(cb, labelEl);
}

function renderNumberField(
  wrap: HTMLElement,
  def: NumberFieldDef,
  value: Record<string, any>,
  onChange: (key: string, v: any) => void,
  onCommit?: () => void
): void {
  const input = wrap.createEl("input", { type: "number", cls: "ggai-form-input" });
  const v = value[def.key];
  input.value = v == null ? "" : String(v);
  if (def.min != null) input.min = String(def.min);
  if (def.max != null) input.max = String(def.max);
  if (def.step != null) input.step = String(def.step);
  input.addEventListener("input", () => {
    if (input.value === "") {
      onChange(def.key, def.nullable ? null : 0);
      return;
    }
    const n = Number(input.value);
    if (Number.isFinite(n)) onChange(def.key, n);
  });
  if (onCommit) input.addEventListener("blur", () => onCommit());
}

function renderSelectField(
  wrap: HTMLElement,
  def: SelectFieldDef,
  value: Record<string, any>,
  onChange: (key: string, v: any) => void,
  onCommit?: () => void
): void {
  const select = wrap.createEl("select", { cls: "ggai-form-select" });
  for (const opt of def.options) {
    const optEl = select.createEl("option", { text: opt.label });
    optEl.value = opt.value;
    if (String(value[def.key]) === opt.value) optEl.selected = true;
  }
  select.addEventListener("change", () => {
    onChange(def.key, select.value);
    onCommit?.(); // 드롭다운 변경도 즉시 commit.
  });
}

function renderTagsField(
  wrap: HTMLElement,
  def: TagsFieldDef,
  value: Record<string, any>,
  onChange: (key: string, v: any) => void,
  onCommit?: () => void
): void {
  // 단순 구현: 콤마 구분 문자열로 보여주고 입력. 추후 칩 UI 가능.
  const input = wrap.createEl("input", {
    cls: "ggai-form-input",
    type: "text",
  });
  const arr: string[] = Array.isArray(value[def.key]) ? value[def.key] : [];
  input.value = arr.join(", ");
  input.placeholder = def.placeholder ?? "콤마(,) 로 구분";
  input.addEventListener("input", () => {
    const next = input.value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    onChange(def.key, next);
  });
  if (onCommit) input.addEventListener("blur", () => onCommit());
}
