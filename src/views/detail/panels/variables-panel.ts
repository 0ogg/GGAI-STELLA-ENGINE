/**
 * 변수 설정 패널 — 게임형 카드가 쓰는 값을 사람이 직접 보고 고치는 자리.
 *
 * 실리태번 쪽 카드들이 토글 팝업을 그리려고 JS 스크립트를 통째로 끼워 넣는 이유가
 * 이것뿐이라, 이 패널 하나가 그 스크립트들을 대체한다(`게임형 카드 지원 스펙.md` U1).
 *
 * 재렌더 규칙 — 입력칸은 blur(change) 시점에만 커밋하고 **다시 그리지 않는다**.
 * 줄이 늘거나 줄 때만 전체 재렌더. 타이핑 중 재렌더가 없으므로 포커스가 날아갈 자리가
 * 애초에 없다(회귀금지: 입력 중 재렌더).
 */

import { Notice, setIcon } from "obsidian";
import type {
  SettingsPanel,
  SettingsPanelContext,
} from "../../../services/settings-panel-registry";

/** 한 구역이 다루는 값의 출처. */
type Scope = "session" | "global";

export function createVariablesSettingsPanel(): SettingsPanel {
  // 비동기(세션 로드) 결과가 옛 렌더에 꽂히지 않게 하는 카운터 (확장 패널 스펙.md).
  let renderSeq = 0;

  return {
    id: "stella:variables",
    title: "변수",
    order: 6, // 정규식(3) 뒤.
    render(body, ctx) {
      const seq = ++renderSeq;

      body.createDiv({
        cls: "ggai-regex-section-hint",
        text:
          "카드가 기억하는 값입니다. 애정도·소지금처럼 진행에 따라 변하는 값과, " +
          "카드가 켜고 끄는 설정이 여기 쌓입니다. 직접 고치면 다음 생성부터 반영됩니다.",
      });

      // ── 이 세션 ──
      const sessionSection = body.createDiv({ cls: "ggai-regex-section" });
      sessionSection.createDiv({
        cls: "ggai-regex-section-title",
        text: "이 세션",
      });
      if (!ctx.activeSessionFile) {
        sessionSection.createDiv({
          cls: "ggai-regex-section-hint",
          text: "세션을 열면 그 세션의 값이 보입니다.",
        });
      } else {
        const slot = sessionSection.createDiv();
        slot.createDiv({ cls: "ggai-regex-section-hint", text: "불러오는 중…" });
        void ctx.plugin.variables
          .resolveActive(ctx.activeSessionFile)
          .then((vars) => {
            if (seq !== renderSeq) return; // 옛 렌더 결과 — 버린다
            slot.empty();
            renderScope(slot, ctx, "session", vars);
          })
          .catch(() => {
            if (seq !== renderSeq) return;
            slot.empty();
            slot.createDiv({
              cls: "ggai-regex-section-hint",
              text: "값을 불러오지 못했습니다.",
            });
          });
      }

      // ── 모든 세션 공통 ──
      const globalSection = body.createDiv({ cls: "ggai-regex-section" });
      globalSection.createDiv({
        cls: "ggai-regex-section-title",
        text: "모든 세션 공통",
      });
      renderScope(globalSection, ctx, "global", ctx.plugin.variables.getGlobals());
    },
  };
}

/** 한 구역(세션/전역)의 값 목록 + 추가 버튼. */
function renderScope(
  parent: HTMLElement,
  ctx: SettingsPanelContext,
  scope: Scope,
  vars: Record<string, string>
): void {
  const save = (patch: Record<string, string | null>): Promise<void> =>
    scope === "global"
      ? ctx.plugin.variables.setGlobals(patch)
      : ctx.plugin.variables.setSessionVars(ctx.activeSessionFile!, patch);

  const names = Object.keys(vars).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    parent.createDiv({
      cls: "ggai-regex-section-hint",
      text: "아직 값이 없습니다.",
    });
  }

  for (const name of names) {
    const row = parent.createDiv({ cls: "ggai-var-row" });

    const nameInput = row.createEl("input", {
      cls: "ggai-var-name",
      type: "text",
      attr: { "aria-label": "이름" },
    });
    nameInput.value = name;

    const valueInput = row.createEl("input", {
      cls: "ggai-var-value",
      type: "text",
      attr: { "aria-label": "값" },
    });
    valueInput.value = vars[name];

    // 이름 변경 = 옛 이름 삭제 + 새 이름에 같은 값. 줄 수가 그대로라 재렌더하지 않는다.
    nameInput.addEventListener("change", () => {
      const next = nameInput.value.trim();
      if (next === name) return;
      if (!next) {
        nameInput.value = name;
        new Notice("이름은 비울 수 없습니다.");
        return;
      }
      if (next in vars) {
        nameInput.value = name;
        new Notice(`"${next}" 는 이미 있습니다.`);
        return;
      }
      void save({ [name]: null, [next]: valueInput.value }).then(() =>
        ctx.rerender()
      );
    });

    valueInput.addEventListener("change", () => {
      void save({ [nameInput.value.trim() || name]: valueInput.value });
    });

    const del = row.createEl("button", {
      cls: "ggai-var-del",
      attr: { type: "button", "aria-label": "삭제" },
    });
    setIcon(del, "trash-2");
    del.addEventListener("click", () => {
      void save({ [name]: null }).then(() => ctx.rerender());
    });
  }

  const add = parent.createEl("button", {
    cls: "ggai-var-add",
    text: "+ 값 추가",
    attr: { type: "button" },
  });
  add.addEventListener("click", () => {
    let name = "새 값";
    for (let i = 2; name in vars; i++) name = `새 값 ${i}`;
    void save({ [name]: "" }).then(() => ctx.rerender());
  });
}
