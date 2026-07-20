import type { SettingsPanel, SettingsPanelContext } from "../../../services/settings-panel-registry";
import type { ProActiveSettings } from "../../../types/preset";
import { PRO_STYLE_TAIL_CHARS_DEFAULT } from "../../../services/pro-service";
import { PRO_STYLE_PAIRS_DEFAULT } from "../../../util/pro-convert";
import { renderMediaModelPicker, renderMediaPromptPicker } from "../media-prompt-panel";
import { renderEnableToggle, renderNumberRow } from "../setting-controls";

/**
 * 집필 프로(PRO) 설정 패널.
 *
 * 휴면 원칙: main.ts 가 아니라 `plugin.pro.activate()` 가 등록한다 — PRO 비활성
 * 환경의 확장 탭에는 아예 나타나지 않는다. 세션 전환 토글 + 집필 변환(한→영)
 * 파이프라인 설정(모델/프롬프트/문체 첨부량).
 */
export function createProSettingsPanel(): SettingsPanel {
  // 렌더 호출 간 비동기 경합 방지 카운터 (summary-panel 의 syncSummaryContext 패턴).
  let renderSeq = 0;
  return {
    id: "stella:pro",
    title: "집필 프로",
    order: 90,
    render(body, ctx) {
      const { plugin, activeSessionFile, settings } = ctx;
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

        renderMediaModelPicker({
          plugin,
          parent: body,
          label: "집필 변환 모델",
          profiles: plugin.ai.listGenerationProfiles(),
          activeId: settings.pro?.modelProfileId,
          onSelect: (modelProfileId) => void patchPro(ctx, { modelProfileId }),
          emptyText: "Core 텍스트 모델이 없습니다.",
        });

        renderMediaPromptPicker({
          plugin,
          parent: body,
          label: "집필 변환 프롬프트",
          bucket: "proConvert",
          activeId: settings.pro?.promptId,
          onSelect: (promptId) => void patchPro(ctx, { promptId }),
          onChanged: () => ctx.rerender(),
          onDeleted: (promptId) => {
            if (settings.pro?.promptId === promptId) {
              void patchPro(ctx, { promptId: undefined });
            } else {
              ctx.rerender();
            }
          },
        });

        // 문체 참조 첨부량 — 변환 요청에 함께 보내는 영어판 꼬리 글자 수.
        renderNumberRow({
          parent: body,
          label: "문체 참조 첨부량(글자)",
          value: settings.pro?.styleTailChars ?? PRO_STYLE_TAIL_CHARS_DEFAULT,
          fallback: PRO_STYLE_TAIL_CHARS_DEFAULT,
          min: 0,
          step: 500,
          integer: true,
          onChange: (styleTailChars) => void patchPro(ctx, { styleTailChars }),
        });

        // 문체 예시 쌍 — 내 한국어↔영어판 최근 짝을 변환·번역 프롬프트에 예시로 첨부.
        renderNumberRow({
          parent: body,
          label: "문체 예시 쌍 수(0=끄기)",
          value: settings.pro?.stylePairs ?? PRO_STYLE_PAIRS_DEFAULT,
          fallback: PRO_STYLE_PAIRS_DEFAULT,
          min: 0,
          step: 1,
          integer: true,
          onChange: (stylePairs) => void patchPro(ctx, { stylePairs }),
        });
      });
    },
  };
}

async function patchPro(
  ctx: SettingsPanelContext,
  patch: Partial<ProActiveSettings>
): Promise<void> {
  await ctx.patchSettings({ pro: { ...ctx.settings.pro, ...patch } });
}
