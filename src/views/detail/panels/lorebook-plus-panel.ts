import { Notice, setIcon } from "obsidian";
import type { SettingsPanel, SettingsPanelContext } from "../../../services/settings-panel-registry";
import type { LorebookPlusActiveSettings } from "../../../types/preset";
import { LOREBOOK_SELECT_TASK_DEFAULT_PROMPT_ID } from "../../../util/default-media-prompts";
import { DEFAULT_LOREBOOK_SELECT_CONTEXT_CHARS } from "../../../util/lorebook-ai-select";
import {
  DEFAULT_LOREBOOK_GEN_INTERVAL,
  DEFAULT_LOREBOOK_GEN_MAX_CHARS,
} from "../../../util/lorebook-auto-gen";
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

        // 다른 확장에도 적용 — 번역/삽화 등 로어북을 쓰는 확장의 로어북 텍스트도
        // AI 선별 합집합으로 만든다 (허브: LorebookPlusService.buildTaskLorebookText).
        renderEnableToggle({
          parent: body,
          label: "다른 확장에도 적용 — 번역·삽화 등",
          checked: lp.applyToExtensions === true,
          onChange: (applyToExtensions) =>
            void patchLorebookPlus(ctx, { applyToExtensions }),
        });

        if (lp.applyToExtensions === true) {
          // 확장용 선별 프롬프트 — {{task}} = 그 확장의 프롬프트 전문, {{main}} = 대상 본문.
          renderMediaPromptPicker({
            plugin,
            parent: body,
            label: "확장 선별 프롬프트",
            bucket: "lorebookSelect",
            activeId: lp.taskPromptId ?? LOREBOOK_SELECT_TASK_DEFAULT_PROMPT_ID,
            onSelect: (taskPromptId) =>
              void patchLorebookPlus(ctx, { taskPromptId }),
            onChanged: () => ctx.rerender(),
            onDeleted: (promptId) => {
              if (lp.taskPromptId === promptId) {
                void patchLorebookPlus(ctx, { taskPromptId: undefined });
              } else {
                ctx.rerender();
              }
            },
          });
        }
      }

      // ── 로어북 자동 생성 — 세션 전용 로어북에 새 인물/사건/고유명사를 자동 기록.
      renderEnableToggle({
        parent: body,
        label: "자동 생성 — 새 인물·사건을 세션 로어북에 기록",
        checked: lp.autoGen === true,
        onChange: (autoGen) => {
          void (async () => {
            await patchLorebookPlus(ctx, { autoGen });
            // 켜는 순간 세션 전용 로어북(세션명 + 시나리오 표지)을 바로 만든다.
            if (autoGen && ctx.activeSessionFile) {
              await plugin.lorebookGen.ensureSessionLorebook(
                ctx.activeSessionFile
              );
            }
          })();
        },
      });

      if (lp.autoGen === true) {
        renderMediaModelPicker({
          plugin,
          parent: body,
          label: "생성 모델",
          profiles: plugin.ai.listGenerationProfiles(),
          activeId: lp.autoGenModelProfileId,
          onSelect: (autoGenModelProfileId) =>
            void patchLorebookPlus(ctx, { autoGenModelProfileId }),
          emptyText: "Core 텍스트 모델이 없습니다.",
        });

        // 생성 프롬프트 — 편집 가능. {{lorebook}} = 기존 항목 목록, {{main}} = 새 본문.
        renderMediaPromptPicker({
          plugin,
          parent: body,
          label: "생성 프롬프트",
          bucket: "lorebookGen",
          activeId: lp.autoGenPromptId,
          onSelect: (autoGenPromptId) =>
            void patchLorebookPlus(ctx, { autoGenPromptId }),
          onChanged: () => ctx.rerender(),
          onDeleted: (promptId) => {
            if (lp.autoGenPromptId === promptId) {
              void patchLorebookPlus(ctx, { autoGenPromptId: undefined });
            } else {
              ctx.rerender();
            }
          },
        });

        renderNumberRow({
          parent: body,
          label: "생성 주기(AI 생성 횟수)",
          value: lp.autoGenInterval ?? DEFAULT_LOREBOOK_GEN_INTERVAL,
          fallback: DEFAULT_LOREBOOK_GEN_INTERVAL,
          min: 1,
          step: 1,
          integer: true,
          onChange: (autoGenInterval) =>
            void patchLorebookPlus(ctx, { autoGenInterval }),
        });

        renderNumberRow({
          parent: body,
          label: "스캔 본문 상한(자)",
          value: lp.autoGenMaxChars ?? DEFAULT_LOREBOOK_GEN_MAX_CHARS,
          fallback: DEFAULT_LOREBOOK_GEN_MAX_CHARS,
          min: 500,
          step: 1000,
          integer: true,
          onChange: (autoGenMaxChars) =>
            void patchLorebookPlus(ctx, { autoGenMaxChars }),
        });

        // 지금 스캔 — 주기를 기다리지 않고 밀린 구간을 즉시 스캔한다.
        const actions = body.createDiv({ cls: "ggai-summary-actions" });
        const scanBtn = actions.createEl("button", { cls: "ggai-btn" });
        setIcon(scanBtn.createSpan(), "book-plus");
        scanBtn.createSpan({ text: "지금 스캔" });
        scanBtn.addEventListener("click", () => {
          void (async () => {
            if (!ctx.activeSessionFile) {
              new Notice("활성 세션이 없습니다.");
              return;
            }
            scanBtn.disabled = true;
            try {
              const result = await plugin.lorebookGen.scan(ctx.activeSessionFile);
              if (!result.ok) {
                new Notice(`로어북 스캔 실패: ${result.errors[0] ?? "알 수 없는 오류"}`);
              } else if (result.skipped || result.added === 0) {
                new Notice("추가할 새 항목이 없습니다.");
              }
              // 추가 성공 Notice 는 서비스가 띄운다.
            } finally {
              scanBtn.disabled = false;
            }
          })();
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
