import type { Modal } from "obsidian";

export type ModalShellSize = "l" | "m";

export interface ModalShellRegions {
  /** 검색창/토글처럼 스크롤 없이 항상 보이는 도구줄. `opts.toolbar` 를 주지 않으면 null. */
  toolbar: HTMLElement | null;
  /** 이 창의 유일한 스크롤 영역. 내용이 늘어나도 창 자체는 커지지 않는다. */
  body: HTMLElement;
  /** 하단 고정 액션줄. 왼쪽은 보조 동작(`footerAux`), 오른쪽은 취소/주 동작(`footerMain`). */
  footer: HTMLElement;
  footerAux: HTMLElement;
  footerMain: HTMLElement;
}

/**
 * 파생 창(팝업) 공통 뼈대 — 고정 크기(L/M) + 제목(Obsidian 기본 titleEl)
 * + 도구줄(고정, 선택) + 본문(유일한 스크롤 영역) + 액션줄(고정) 4구역.
 *
 * Modal 서브클래스의 `onOpen()` 맨 앞에서 한 번 호출해 contentEl 을 이 구조로 초기화한다.
 * 내용을 다시 그릴 때는 반환된 `body` 만 비우고 다시 채운다 — toolbar/footer 는 그대로 둔다.
 * 제목은 `contentEl` 안에 직접 만들지 않고 `modal.titleEl.setText(...)` 로 채운다
 * (그래야 제목도 스크롤 없이 항상 보인다).
 *
 *  - `size: "l"` — 탐색·관리형(목록/미리보기/갤러리). 화면의 80%, 최대 680px.
 *  - `size: "m"` — 집중 편집형(프롬프트/문단·삽화 재생성). 화면의 66%, 최대 540px.
 *  - `opts.wide` — 내용이 가로로 넓어야 하는 창(컨텍스트 미리보기, 갤러리)에 폭을 더 준다.
 */
export function createModalShell(
  modal: Modal,
  size: ModalShellSize,
  opts?: { toolbar?: boolean; wide?: boolean }
): ModalShellRegions {
  modal.modalEl.addClass("ggai-modal-shell", `ggai-modal-size-${size}`);
  if (opts?.wide) modal.modalEl.addClass("ggai-modal-wide");

  const contentEl = modal.contentEl;
  contentEl.empty();
  contentEl.addClass("ggai-modal-shell-content");

  const toolbar = opts?.toolbar
    ? contentEl.createDiv({ cls: "ggai-modal-toolbar" })
    : null;
  const body = contentEl.createDiv({ cls: "ggai-modal-body" });
  const footer = contentEl.createDiv({ cls: "ggai-modal-footer" });
  const footerAux = footer.createDiv({ cls: "ggai-modal-footer-aux" });
  footer.createDiv({ cls: "ggai-modal-footer-spacer" });
  const footerMain = footer.createDiv({ cls: "ggai-modal-footer-main" });

  return { toolbar, body, footer, footerAux, footerMain };
}
