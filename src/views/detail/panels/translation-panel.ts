import type { SettingsPanel, SettingsPanelContext } from "../../../services/settings-panel-registry";
import type { TranslationActiveSettings, TranslationOutputMode } from "../../../types/preset";
import { getDefaultPrompts } from "../../../util/default-media-prompts";
import { TRANSLATION_CONTEXT_SETS_DEFAULT } from "../../../util/translate-paragraphs";
import {
  renderMediaLorebookPicker,
  renderMediaModelPicker,
  renderMediaPromptPicker,
} from "../media-prompt-panel";
import {
  renderEnableToggle,
  renderNumberRow,
  renderOptionGrid,
} from "../setting-controls";

/**
 * 번역 설정 — 확장 탭 패널 (구 기본 탭 미디어 영역 `MediaSection` 에서 이관).
 * 번역 확장 모듈(`extensions/translation-extension.ts`)이 함께 등록한다.
 */
export function createTranslationSettingsPanel(): SettingsPanel {
  return {
    id: "stella:translation",
    title: "번역",
    order: 0,
    render(body, ctx) {
      const { plugin, settings } = ctx;

      renderEnableToggle({
        parent: body,
        label: "번역 사용",
        checked: settings.translation?.enabled === true,
        onChange: (enabled) => void patchTranslation(ctx, { enabled }),
      });

      renderEnableToggle({
        parent: body,
        label: "오류시 번역 자동 재시도",
        checked: settings.translation?.retryOnFormatError === true,
        onChange: (retryOnFormatError) =>
          void patchTranslation(ctx, { retryOnFormatError }),
      });

      renderMediaModelPicker({
        plugin,
        parent: body,
        label: "모델",
        profiles: plugin.ai.listGenerationProfiles(),
        activeId: settings.translation?.modelProfileId,
        onSelect: (modelProfileId) => void patchTranslation(ctx, { modelProfileId }),
        emptyText: "Core 텍스트 모델이 없습니다.",
      });

      renderMediaPromptPicker({
        plugin,
        parent: body,
        label: "프롬프트",
        bucket: "translation",
        activeId: settings.translation?.promptId,
        onSelect: (promptId) => void patchTranslation(ctx, { promptId }),
        onChanged: () => ctx.rerender(),
        onDeleted: (promptId) => {
          if (settings.translation?.promptId === promptId) {
            void patchTranslation(ctx, { promptId: undefined });
          } else {
            ctx.rerender();
          }
        },
      });

      // 출력 방식 — translations.json 의 문단별 번역을 어디에 표시할지 선택.
      renderOptionGrid<TranslationOutputMode>({
        parent: body,
        label: "출력 방식",
        options: [
          { id: "replace", label: "원문 치환" },
          { id: "split-h", label: "2분할" },
        ],
        activeId: settings.translation?.output ?? "replace",
        onSelect: (output) => void patchTranslation(ctx, { output }),
      });

      renderMediaLorebookPicker({
        plugin,
        parent: body,
        label: "로어북",
        selectedIds: settings.translation?.lorebookIds ?? [],
        onToggle: (lorebookIds) => void patchTranslation(ctx, { lorebookIds }),
      });

      // 앞 문맥/앞 번역 첨부 — 로어북과 같은 참고자료 위치에 삽입. 1세트=직전 6문단.
      renderNumberRow({
        parent: body,
        label: "앞 문맥 첨부 (세트 · 1세트=직전 6문단, 0=끄기)",
        value: settings.translation?.contextSets ?? TRANSLATION_CONTEXT_SETS_DEFAULT,
        fallback: TRANSLATION_CONTEXT_SETS_DEFAULT,
        min: 0,
        step: 1,
        integer: true,
        onChange: (contextSets) => void patchTranslation(ctx, { contextSets }),
      });
    },
  };
}

async function patchTranslation(
  ctx: SettingsPanelContext,
  patch: Partial<TranslationActiveSettings>
): Promise<void> {
  let translation = { ...(ctx.settings.translation ?? {}), ...patch };
  // 번역 사용 시 기본 프롬프트 자동 지정 (사용자가 아직 아무 것도 선택하지 않은 경우)
  if (translation.enabled && !translation.promptId) {
    const def = getDefaultPrompts("translation")[0];
    if (def) translation = { ...translation, promptId: def.id };
  }
  await ctx.patchSettings({ translation });
}
