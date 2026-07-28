import type { SettingsPanel } from "../../../services/settings-panel-registry";
import { renderBidirectionalConvertSettings } from "../bidirectional-settings";
import { renderEnableToggle } from "../setting-controls";

/**
 * 집필 프로(PRO) 설정 패널.
 *
 * 휴면 원칙: main.ts 가 아니라 `plugin.pro.activate()` 가 등록한다 — PRO 비활성
 * 환경의 확장 탭에는 아예 나타나지 않는다. 세션 전환 토글 + 집필 변환/용어집 설정
 * (공용 렌더러 `bidirectional-settings.ts` — 번역 패널 '양방향 번역'과 같은 컨트롤).
 */
export function createProSettingsPanel(): SettingsPanel {
  // 렌더 호출 간 비동기 경합 방지 카운터 (summary-panel 의 syncSummaryContext 패턴).
  let renderSeq = 0;
  return {
    id: "stella:pro",
    title: "집필 프로",
    order: 90,
    render(body, ctx) {
      const { plugin, activeSessionFile } = ctx;
      const seq = ++renderSeq;
      if (!activeSessionFile) return;
      void plugin.store.getSession(activeSessionFile).then((session) => {
        if (seq !== renderSeq || !session) return;
        if (session.meta.mode === "chat") {
          body.createDiv({
            cls: "ggai-media-block",
            text: "집필 프로는 소설 세션 전용입니다.",
          });
          return;
        }
        // 집중 설정 뷰(핀 카탈로그) 진입 — PRO 활성 표면 안에서만 노출.
        const openRow = body.createDiv({ cls: "ggai-media-block" });
        const openBtn = openRow.createEl("button", {
          cls: "ggai-preset-btn",
          text: "집중 설정 열기",
        });
        openBtn.addEventListener("click", () => void plugin.pro.openFocusView());

        renderEnableToggle({
          parent: body,
          label: "이 세션을 집필 세션으로",
          checked: session.meta.proWriting === true,
          onChange: (on) => {
            void plugin.pro
              .setSessionPro(activeSessionFile, on)
              .then(async (ok) => {
                if (!ok) {
                  ctx.rerender();
                  return;
                }
                // 뷰 타입이 바뀌므로(소설 ↔ 집필) 같은 세션을 다시 열어 라우팅 반영.
                await plugin.openStellaSession(activeSessionFile);
              });
          },
        });
        if (session.meta.proWriting !== true) return;

        renderBidirectionalConvertSettings(body, ctx);
      });
    },
  };
}
