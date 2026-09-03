/**
 * 코드블록 복사 버튼 (실리태번 `addCopyToCodeBlocks` 와 같은 자리).
 *
 * 카드가 낸 스크립트·설정 덩어리는 읽으라고 있는 게 아니라 **퍼가라고** 있다.
 * 마크다운 렌더가 만든 `<pre><code>` 마다 복사 버튼을 얹는다 — 그리는 화면이
 * 챗이든 소설이든 같은 함수를 부른다.
 */

import { Notice, setIcon } from "obsidian";

export function attachCodeCopyButtons(root: HTMLElement): void {
  for (const code of Array.from(root.querySelectorAll("pre > code"))) {
    const pre = code.parentElement;
    if (!pre || pre.querySelector(".ggai-code-copy")) continue;
    pre.addClass("ggai-code-block");
    const btn = pre.createEl("button", {
      cls: "ggai-code-copy clickable-icon",
      attr: { "aria-label": "코드 복사", type: "button" },
    });
    setIcon(btn, "copy");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void copyCode(code.textContent ?? "", btn);
    });
  }
}

async function copyCode(text: string, btn: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    // 토스트 대신 버튼이 잠깐 체크로 바뀐다 — 읽던 자리를 가리지 않는다.
    setIcon(btn, "check");
    btn.addClass("is-copied");
    window.setTimeout(() => {
      setIcon(btn, "copy");
      btn.removeClass("is-copied");
    }, 1200);
  } catch {
    new Notice("복사 실패.");
  }
}
