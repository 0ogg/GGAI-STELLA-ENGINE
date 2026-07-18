import type { SettingsPanel, SettingsPanelContext } from "../../../services/settings-panel-registry";
import type { LorebookPlusActiveSettings } from "../../../types/preset";
import { DEFAULT_LOREBOOK_SELECT_CONTEXT_CHARS } from "../../../util/lorebook-ai-select";
import { renderMediaModelPicker, renderMediaPromptPicker } from "../media-prompt-panel";
import { renderEnableToggle, renderNumberRow, renderOptionGrid } from "../setting-controls";

/**
 * 로어북 확장 설정 — 로어북 활성화 방식을 제어하는 내장 패널.
 * 키워드/AI 매칭 각각 독립 체크 — 둘 다 켜면 합집합, 둘 다 끄면 상시 엔트리만.
 * 앞으로의 로어북 강화 기능도 이 패널에 편입한다.
 */
export function createLorebookPlusSettingsPanel(): SettingsPanel {
  return {
    id: "stella:lorebook-plus",
    title: "로어북 확장",
    order: 4, // 번역(0)/삽화(1)/요약(2)/정규식(3) 다음.
    render(body, ctx) {
      const { plugin, settings } = ctx;
      const lp = settings.lorebookPlus ?? {};

      renderEnableToggle({
        parent: body,
        label: "키워드 매칭",
        checked: lp.keywordMatching !== false,
        onChange: (keywordMatching) =>
          void patchLorebookPlus(ctx, { keywordMatching }),
      });

      renderEnableToggle({
        parent: body,
        label: "AI 매칭 — 생성 전 자동 선별",
        checked: lp.aiMatching === true,
        onChange: (aiMatching) => {
          void patchLorebookPlus(ctx, { aiMatching });
        },
      });

      if (lp.aiMatching === true) {
        renderMediaModelPicker({
          plugin,
          parent: body,
          label: "선별 모델",
          profiles: plugin.ai.listGenerationProfiles(),
          activeId: lp.modelProfileId,
          onSelect: (modelProfileId) =>
            void patchLorebookPlus(ctx, { modelProfileId }),
          emptyText: "Core 텍스트 모델이 없습니다.",
        });

        // 선별 프롬프트 — 편집 가능. {{lorebook}} = 엔트리 번호 목록, {{main}} = 최근 본문.
        renderMediaPromptPicker({
          plugin,
          parent: body,
          label: "선별 프롬프트",
          bucket: "lorebookSelect",
          activeId: lp.promptId,
          onSelect: (promptId) => void patchLorebookPlus(ctx, { promptId }),
          onChanged: () => ctx.rerender(),
          onDeleted: (promptId) => {
            if (lp.promptId === promptId) {
              void patchLorebookPlus(ctx, { promptId: undefined });
            } else {
              ctx.rerender();
            }
          },
        });

        renderNumberRow({
          parent: body,
          label: "본문 첨부량(자)",
          value: lp.contextChars ?? DEFAULT_LOREBOOK_SELECT_CONTEXT_CHARS,
          fallback: DEFAULT_LOREBOOK_SELECT_CONTEXT_CHARS,
          min: 200,
          step: 500,
          integer: true,
          onChange: (contextChars) =>
            void patchLorebookPlus(ctx, { contextChars }),
        });

        renderOptionGrid({
          parent: body,
          label: "선별 시점",
          options: [
            { id: "always", label: "매 생성마다" },
            { id: "reuse", label: "재생성 땐 재사용" },
          ],
          activeId: lp.reuseOnRegen === true ? "reuse" : "always",
          onSelect: (id) =>
            void patchLorebookPlus(ctx, { reuseOnRegen: id === "reuse" }),
        });
      }
    },
  };
}

async function patchLorebookPlus(
  ctx: SettingsPanelContext,
  patch: Partial<LorebookPlusActiveSettings>
): Promise<void> {
  await ctx.patchSettings({
    lorebookPlus: { ...(ctx.settings.lorebookPlus ?? {}), ...patch },
  });
}
