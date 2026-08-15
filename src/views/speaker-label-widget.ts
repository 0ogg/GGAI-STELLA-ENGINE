/**
 * 익명 발화자 이름표(QR `/sendas name=`) 위젯 — 소설 본문에 꽂히는 작은 이름 칩.
 *
 * **글자 0개 규칙**: 세션창은 `bodyEl.textContent` 를 그대로 편집 diff 기준으로 쓴다.
 * 이름을 텍스트 노드로 넣으면 그 글자가 본문으로 저장되고 오프셋 매핑까지 어긋난다
 * (회귀금지.md). 그래서 노트 위젯 제목과 같은 방식 — `data-name` + CSS `content` 로 그린다.
 */

export function createSpeakerLabelEl(name: string): HTMLElement {
  const el = document.createElement("div");
  el.classList.add("ggai-speaker-label");
  el.setAttribute("contenteditable", "false");
  // 텍스트 노드 대신 data 속성 + CSS content (본문 diff 오염 방지).
  el.setAttribute("data-name", name);
  el.setAttribute("aria-label", name);
  return el;
}
