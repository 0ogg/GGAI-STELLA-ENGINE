/**
 * 세션 노트(QR `/comment`) 인라인 위젯 — 제목 달린 접이식 블록.
 *
 * 소설/챗 세션창이 공유한다 (뷰별 복붙 금지).
 *
 * 원시 HTML 을 렌더하지 않는다(QR 스펙.md): `<details><summary>` 가 뜻하는 건
 * "제목 달린 접이식 블록" 하나뿐이므로 제목/본문만 뽑아 네이티브 위젯으로 그린다.
 *
 * **글자 0개 규칙(중요)**: 이 위젯은 contenteditable 본문 안에 꽂히고, 세션창은
 * `bodyEl.textContent` 를 그대로 편집 diff 기준으로 쓴다. 위젯이 텍스트 노드를 하나라도
 * 가지면 그 글자가 본문으로 저장된다. 그래서 삽화 캐러셀 카운터와 같은 방식으로
 *   - 제목: `data-title` + CSS `content: attr(...)`
 *   - 본문: readonly `<textarea>` 의 **value**(자식 텍스트 노드가 아니다 — 선택·복사는 가능)
 * 를 쓴다. 둘 다 `textContent` 에 잡히지 않는다.
 */

import { Menu, setIcon } from "obsidian";
import type { SessionNote } from "../types/note";
import { attachLongPress } from "../util/long-press";

export interface NoteWidgetHandlers {
  onDelete(note: SessionNote): void;
}

export function createNoteWidgetEl(
  note: SessionNote,
  handlers: NoteWidgetHandlers
): HTMLElement {
  const el = document.createElement("div");
  el.classList.add("ggai-note-block");
  el.setAttribute("contenteditable", "false");
  el.dataset.noteId = note.id;

  const head = document.createElement("div");
  head.classList.add("ggai-note-head");
  head.setAttribute("role", "button");
  head.setAttribute("aria-label", note.title || "노트");
  const chev = document.createElement("span");
  chev.classList.add("ggai-note-chev");
  setIcon(chev, "chevron-right");
  head.appendChild(chev);
  const title = document.createElement("span");
  title.classList.add("ggai-note-title");
  // 텍스트 노드 대신 data 속성 + CSS content (본문 diff 오염 방지).
  title.setAttribute("data-title", note.title || "노트");
  head.appendChild(title);
  el.appendChild(head);

  const body = document.createElement("textarea");
  body.classList.add("ggai-note-body");
  body.readOnly = true;
  body.spellcheck = false;
  // value 로만 넣는다 — 자식 텍스트 노드를 만들지 않으므로 textContent 는 계속 "".
  body.value = note.body;
  el.appendChild(body);

  // 접힘 상태는 블록의 `is-open` 클래스 **하나로만** 관리한다.
  // (`hidden` 속성 금지 — `.ggai-note-body { display: … }` 같은 우리 CSS 가
  //  브라우저 기본 `[hidden] { display: none }` 을 이겨서 접혀도 그대로 보인다.
  //  그게 "안 접힘 / 두 줄만 보이고 잘림"의 원인이었다.)
  const isOpen = () => el.hasClass("is-open");
  const setOpen = (open: boolean) => {
    el.toggleClass("is-open", open);
    setIcon(chev, open ? "chevron-down" : "chevron-right");
    if (open) fitNoteHeight(body);
  };

  // 펼친 채로 폭이 바뀌면(창 크기, 사이드바 여닫기, 화면 회전) 줄 수가 달라져
  // 맞춰 둔 높이가 짧아진다 — overflow:hidden 이라 뒷부분이 소리 없이 잘린다.
  let lastWidth = 0;
  new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? 0;
    if (width === 0 || width === lastWidth) return;
    lastWidth = width;
    if (isOpen()) fitNoteHeight(body);
  }).observe(body);

  const deleteMenu = (x: number, y: number) => {
    const menu = new Menu();
    menu.addItem((mi) =>
      mi
        .setTitle("노트 삭제")
        .setIcon("trash-2")
        .onClick(() => handlers.onDelete(note))
    );
    menu.showAtPosition({ x, y });
  };

  // 탭 = 펼치기/접기, 꾹 누르기·우클릭 = 삭제 메뉴 (PC/모바일 공통 규약).
  attachLongPress(head, {
    onTap: () => setOpen(!isOpen()),
    onLongPress: deleteMenu,
  });
  head.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    deleteMenu(e.clientX, e.clientY);
  });

  return el;
}

/** 펼칠 때 내용 높이에 맞춘다 (스크롤바 없이 통째로 읽히게). */
function fitNoteHeight(body: HTMLTextAreaElement): void {
  body.style.height = "auto";
  body.style.height = `${body.scrollHeight}px`;
}
