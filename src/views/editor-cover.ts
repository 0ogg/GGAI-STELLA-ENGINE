import { App, TFile, setIcon } from "obsidian";

/**
 * 편집기 헤더용 공용 표지 — 클릭하면 바로 이미지 선택창이 뜬다.
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
      await opts.onPick(await file.arrayBuffer(), imageExt(file));
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
 * 이름을 바로 고칠 수 있다. Enter/blur 로 확정, Esc 로 취소.
 * 시나리오/페르소나/로어북 편집기가 공유한다 (JSON 경로 표시는 두지 않는다).
 */
export function renderEditableTitle(
  parent: HTMLElement,
  name: string,
  onCommit: (next: string) => void | Promise<void>
): void {
  const el = parent.createDiv({ cls: "ggai-editor-name is-editable" });
  el.setText(name || "이름 없음");
  el.setAttr("role", "button");
  el.setAttr("tabindex", "0");
  el.setAttr("title", "클릭하여 이름 편집");

  const beginEdit = () => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ggai-editor-name-input";
    input.value = name;
    el.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save: boolean) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      input.replaceWith(el);
      if (save && next && next !== name) void onCommit(next);
    };
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
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

function imageExt(file: File): string {
  const byType = file.type.split("/")[1];
  const byName = file.name.split(".").pop();
  return (byType || byName || "png").replace("jpeg", "jpg");
}
