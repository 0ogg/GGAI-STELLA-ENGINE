import type { SettingsPanel, SettingsPanelContext } from "../../../services/settings-panel-registry";
import type {
  IllustrationActiveSettings,
  IllustrationOutputPosition,
} from "../../../types/preset";
import { DEFAULT_ILLUSTRATION_AUTO_MIN_PARAGRAPHS } from "../../../util/illustration-anchors";
import { resolveIllustrationOutput } from "../../../util/illustrations";
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

const DEFAULT_ILLUSTRATION_CONTEXT_CHARS = 4000;

/**
 * 삽화 설정 — 확장 탭 패널 (구 기본 탭 미디어 영역 `MediaSection` 에서 이관).
 * 삽화 확장 모듈(`extensions/illustration-extension.ts`)이 함께 등록한다.
 */
export function createIllustrationSettingsPanel(): SettingsPanel {
  return {
    id: "stella:illustration",
    title: "삽화 설정",
    order: 1,
    render(body, ctx) {
      const { plugin, settings } = ctx;

      renderEnableToggle({
        parent: body,
        label: "삽화 사용",
        checked: settings.illustration?.enabled === true,
        onChange: (enabled) => void patchIllustration(ctx, { enabled }),
      });

      // 출력 위치 — 출력 뷰(전용 패널) / 인라인(본문 안, 2분할이면 넓은 쪽).
      renderOptionGrid<IllustrationOutputPosition>({
        parent: body,
        label: "출력 위치",
        options: [
          { id: "panel", label: "출력 뷰" },
          { id: "inline", label: "인라인" },
        ],
        activeId: resolveIllustrationOutput(settings.illustration?.output),
        onSelect: (output) => {
          void patchIllustration(ctx, { output });
          if (output === "panel") void plugin.revealIllustrationOutput();
        },
      });

      renderMediaModelPicker({
        plugin,
        parent: body,
        label: "모델",
        profiles: plugin.ai.listImageProfiles(),
        activeId: settings.illustration?.imageProfileId,
        onSelect: (imageProfileId) => void patchIllustration(ctx, { imageProfileId }),
        emptyText: "Core 그림 모델이 없습니다.",
      });

      renderMediaModelPicker({
        plugin,
        parent: body,
        label: "삽화프롬프트 생성 모델",
        profiles: plugin.ai.listGenerationProfiles(),
        activeId: settings.illustration?.promptGenModelProfileId,
        onSelect: (promptGenModelProfileId) =>
          void patchIllustration(ctx, { promptGenModelProfileId }),
        emptyText: "Core 텍스트 모델이 없습니다.",
      });

      renderMediaPromptPicker({
        plugin,
        parent: body,
        label: "삽화 프롬프트 생성용 프롬프트",
        bucket: "illustrationPromptGen",
        activeId: settings.illustration?.promptGenPromptId,
        onSelect: (promptGenPromptId) =>
          void patchIllustration(ctx, { promptGenPromptId }),
        onChanged: () => ctx.rerender(),
        onDeleted: (promptId) => {
          if (settings.illustration?.promptGenPromptId === promptId) {
            void patchIllustration(ctx, { promptGenPromptId: undefined });
          } else {
            ctx.rerender();
          }
        },
      });

      renderMediaLorebookPicker({
        plugin,
        parent: body,
        label: "로어북",
        selectedIds: settings.illustration?.lorebookIds ?? [],
        onToggle: (lorebookIds) => void patchIllustration(ctx, { lorebookIds }),
      });

      renderNumberRow({
        parent: body,
        label: "본문 첨부량",
        value: settings.illustration?.contextChars ?? DEFAULT_ILLUSTRATION_CONTEXT_CHARS,
        fallback: 0,
        min: 0,
        step: 500,
        onChange: (contextChars) => void patchIllustration(ctx, { contextChars }),
      });

      renderNumberRow({
        parent: body,
        label: "자동 생성 주기(문단, 0=매번)",
        value:
          settings.illustration?.autoMinParagraphs ??
          DEFAULT_ILLUSTRATION_AUTO_MIN_PARAGRAPHS,
        fallback: DEFAULT_ILLUSTRATION_AUTO_MIN_PARAGRAPHS,
        min: 0,
        step: 1,
        integer: true,
        onChange: (autoMinParagraphs) =>
          void patchIllustration(ctx, { autoMinParagraphs }),
      });
    },
  };
}

async function patchIllustration(
  ctx: SettingsPanelContext,
  patch: Partial<IllustrationActiveSettings>
): Promise<void> {
  const illustration = { ...(ctx.settings.illustration ?? {}), ...patch };
  await ctx.patchSettings({ illustration });
}
