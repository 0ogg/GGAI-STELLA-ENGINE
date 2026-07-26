import { App, TFile, setIcon } from "obsidian";
import { openImageCrop } from "./image-crop-modal";

/** 표지가 실제로 보이는 비율 — 자르기 창이 이 비율로 열린다. */
const COVER_RATIO = 3 / 4;

/**
 * 편집기 헤더용 공용 표지 — 클릭하면 이미지 선택창, 고르면 자르기 창이 뜬다.
 * 시나리오/로어북/페르소나 편집기가 동일한 크기·동작을 공유한다.
 */
export function renderEditorCover(
  app: App,
  parent: HTMLElement,
  opts: {
    imagePath: string | null;
    altText: string;
    fallbackIcon: string;
    onPick: (bytes: ArrayBuffer, ext: string) => void | Promise<void>;
  }
): void {
  const cover = parent.createDiv({ cls: "ggai-editor-cover" });
  if (opts.imagePath && app.vault.getAbstractFileByPath(opts.imagePath) instanceof TFile) {
    const img = cover.createEl("img");
    img.src = app.vault.adapter.getResourcePath(opts.imagePath);
    img.alt = opts.altText;
  } else {
    const placeholder = cover.createDiv({ cls: "ggai-thumb-placeholder" });
    setIcon(placeholder, opts.fallbackIcon);
  }

  const hint = cover.createDiv({ cls: "ggai-editor-cover-hint" });
  setIcon(hint, "image");
  hint.createSpan({ text: "변경" });

  cover.setAttr("role", "button");
  cover.setAttr("tabindex", "0");
  cover.setAttr("aria-label", "표지 변경");

  const openPicker = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/avif";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const cropped = await openImageCrop(app, file, COVER_RATIO);
      if (!cropped) return;
      await opts.onPick(cropped.bytes, cropped.ext);
    });
    document.body.appendChild(input);
    input.click();
  };
  cover.addEventListener("click", openPicker);
  cover.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openPicker();
  });
}

/**
 * 편집기 헤더 이름 — 평소엔 제목처럼 보이지만 클릭하면 인라인 입력으로 바뀌어
 * 이름을 바로 고칠 수 있다. 시나리오/페르소나/로어북/프롬프트세트 편집기가 공유한다.
 *
 * **저장 트리거를 blur 하나에 걸지 않는다** (모바일에서 blur 는 신뢰 불가 — 회귀금지).
 * 글자를 칠 때마다 `onEdit(next)` 로 모델에 즉시 반영하고, 각 편집기의 debounce
 * 저장(queueSave)과 flush(dispose/visibilitychange/window blur)가 그 값을 디스크로
 * 안전하게 넘긴다. 그래서 blur 가 오지 않는 화면 이탈·앱 전환에도 이름이 유실되지
 * 않는다. `onEdit` 는 모델 갱신 + 저장 예약만 하고 **재렌더는 하지 않아야** 한다
 * (재렌더하면 입력 중 input 이 파괴된다). 표시 텍스트는 이 함수가 직접 갱신한다.
 * Enter/blur 로 표시 확정, Esc 로 원래 이름 복원.
 */
export function renderEditableTitle(
  parent: HTMLElement,
  name: string,
  onEdit: (next: string) => void | Promise<void>
): void {
  const el = parent.createDiv({ cls: "ggai-editor-name is-editable" });
  el.setText(name || "이름 없음");
  el.setAttr("role", "button");
  el.setAttr("tabindex", "0");
  el.setAttr("title", "클릭하여 이름 편집");

  // 확정된 현재 이름 — 재렌더 없이 연속 편집해도 다음 편집이 최신값에서 열리도록
  // finish() 가 갱신한다(캐릭터 render() 를 지운 뒤 closure name 이 낡던 문제 방지).
  let current = name;

  const beginEdit = () => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ggai-editor-name-input";
    input.value = current;
    el.replaceWith(input);
    input.focus();
    input.select();

    const base = current;
    // 마지막으로 모델에 넘긴 값 — 중복 호출/Esc 복원 판단용.
    let applied = base;
    const pushLive = (): void => {
      const next = input.value.trim();
      if (next && next !== applied) {
        applied = next;
        void onEdit(next);
      }
    };
    // 글자마다 모델 반영 — blur 가 없어도 유실되지 않는다. 재렌더가 없어 IME 안전.
    input.addEventListener("input", pushLive);

    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save) {
        pushLive();
        current = input.value.trim() || base;
      } else if (applied !== base) {
        void onEdit(base); // Esc: 라이브로 바뀐 모델을 원복
        current = base;
      }
      el.setText(current || "이름 없음");
      input.replaceWith(el);
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
  };

  el.addEventListener("click", beginEdit);
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    beginEdit();
  });
}

/**
 * 편집기 헤더용 아이콘 액션 버튼 — 한글 네모 버튼 대신 아이콘 + 툴팁.
 * 시나리오/페르소나/로어북 편집기 헤더가 공유한다.
 */
export function renderIconActionButton(
  parent: HTMLElement,
  opts: { icon: string; label: string; danger?: boolean; onClick: () => void }
): HTMLElement {
  const btn = parent.createEl("button", { cls: "ggai-editor-action-btn" });
  if (opts.danger) btn.addClass("is-danger");
  setIcon(btn, opts.icon);
  // aria-label 만 둔다 — 옵시디언 툴팁(검은 배경)만 뜬다. title 을 같이 주면 OS
  // 기본 툴팁(하얀 배경)이 겹쳐 두 개가 동시에 뜬다.
  btn.setAttr("aria-label", opts.label);
  btn.addEventListener("click", opts.onClick);
  return btn;
}
