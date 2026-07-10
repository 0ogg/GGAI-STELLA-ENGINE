/**
 * 챗 말풍선 표시용 경량 포매터 (M6 / C4).
 *
 * AI 로플 챗의 관례대로 표시를 살린다 — 지문은 기울임, 문단은 간격.
 * **표시 전용**이다: 편집(포커스) 시에는 raw 텍스트로 스왑하고, 커밋도 raw 기준이라
 * 여기서 만든 HTML 은 diff/offset 에 영향을 주지 않는다 (챗 세션뷰 focus/blur 스왑).
 *
 * 지원 표기:
 *  - `*지문*`      → 기울임 (`<em>`)
 *  - `**강조**`    → 굵게  (`<strong>`)  — 기울임보다 먼저 처리
 *  - 빈 줄 = 문단 경계 (문단마다 `<p>`, 문단 안 단일 줄바꿈은 `<br>`)
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 이스케이프된 한 문단 텍스트에 인라인 표기(굵게/기울임)를 적용한다. */
function formatInline(escaped: string): string {
  let html = escaped;
  // 굵게 먼저 (`**` 가 `*` 에 먼저 먹히지 않게).
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  // 기울임 — 지문.
  html = html.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
  return html;
}

/**
 * 말풍선 표시용 HTML 문자열. 문단 경계(빈 줄)마다 `<p class="ggai-chat-para">`,
 * 문단 안 줄바꿈은 `<br>`. 입력은 먼저 HTML 이스케이프하므로 사용자 텍스트로
 * 인한 마크업 주입이 없다.
 */
export function formatChatText(text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs
    .map((para) => {
      const lines = para.split("\n").map((line) => formatInline(escapeHtml(line)));
      return `<p class="ggai-chat-para">${lines.join("<br>")}</p>`;
    })
    .join("");
}
