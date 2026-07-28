import { Notice } from "obsidian";
import type { SettingsPanelContext } from "../../services/settings-panel-registry";
import { DEFAULT_GLOSSARY_INTERVAL } from "../../services/pro-glossary-service";
import type { ProActiveSettings } from "../../types/preset";
import { PRO_STYLE_TAIL_CHARS_DEFAULT } from "../../services/pro-service";
import { PRO_STYLE_PAIRS_DEFAULT } from "../../util/pro-convert";
import { renderMediaModelPicker, renderMediaPromptPicker } from "./media-prompt-panel";
import { renderEnableToggle, renderNumberRow } from "./setting-controls";

/**
 * 양방향 집필 변환 + 번역 용어집 자동 수집 설정 — 공용 렌더러.
 *
 * 번역 패널('양방향 번역' 켰을 때)과 집필 프로 패널이 **같은 컨트롤·같은 활성 설정
 * (`ActiveSettings.pro`)** 을 그린다. 두 패널에 복붙하지 않기 위한 단일 소스.
 */
export function renderBidirectionalConvertSettings(
  body: HTMLElement,
  ctx: SettingsPanelContext
): void {
  const { plugin, activeSessionFile, settings } = ctx;

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

  // 문체 참조 첨부량 — 변환 요청에 함께 보내는 원장 꼬리 글자 수.
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

  // 문체 예시 쌍 — 내 초고↔원장 최근 짝을 변환·번역 프롬프트에 예시로 첨부.
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

  // ── 번역 용어집 자동 수집 — 내 문단 쌍에서 고유명사 표기/말투 수집.
  renderEnableToggle({
    parent: body,
    label: "번역 용어집 자동 수집",
    checked: settings.pro?.glossaryEnabled !== false,
    onChange: (glossaryEnabled) => void patchPro(ctx, { glossaryEnabled }),
    help:
      "내가 쓴 문장과 원문의 짝에서 고유명사 표기·말투를 모아 시나리오 전용 " +
      "용어집 로어북에 자동으로 쌓습니다. 번역과 집필 변환이 이 용어집을 함께 참고해 " +
      "표기가 일관돼집니다.",
  });
  renderNumberRow({
    parent: body,
    label: "용어집 스캔 주기(짝 수)",
    value: settings.pro?.glossaryInterval ?? DEFAULT_GLOSSARY_INTERVAL,
    fallback: DEFAULT_GLOSSARY_INTERVAL,
    min: 1,
    step: 1,
    integer: true,
    onChange: (glossaryInterval) => void patchPro(ctx, { glossaryInterval }),
  });
  renderMediaModelPicker({
    plugin,
    parent: body,
    label: "용어집 모델",
    profiles: plugin.ai.listGenerationProfiles(),
    activeId: settings.pro?.glossaryModelProfileId,
    onSelect: (glossaryModelProfileId) =>
      void patchPro(ctx, { glossaryModelProfileId }),
    emptyText: "Core 텍스트 모델이 없습니다.",
  });
  renderMediaPromptPicker({
    plugin,
    parent: body,
    label: "용어집 프롬프트",
    bucket: "translationGlossary",
    activeId: settings.pro?.glossaryPromptId,
    onSelect: (glossaryPromptId) => void patchPro(ctx, { glossaryPromptId }),
    onChanged: () => ctx.rerender(),
    onDeleted: (promptId) => {
      if (settings.pro?.glossaryPromptId === promptId) {
        void patchPro(ctx, { glossaryPromptId: undefined });
      } else {
        ctx.rerender();
      }
    },
  });
  if (activeSessionFile) {
    const scanRow = body.createDiv({ cls: "ggai-media-block" });
    const scanBtn = scanRow.createEl("button", {
      cls: "ggai-preset-btn",
      text: "용어집 지금 스캔",
    });
    scanBtn.addEventListener("click", () => {
      scanBtn.disabled = true;
      void plugin.pro.glossary
        .scan(activeSessionFile)
        .then((r) => {
          if (!r.ok) new Notice("용어집 스캔 실패: " + (r.errors[0] ?? ""));
          else if (r.skipped) new Notice("스캔할 새 문단 쌍이 없습니다.");
          else if (r.added === 0) new Notice("새로 기록할 용어가 없습니다.");
        })
        .finally(() => {
          scanBtn.disabled = false;
        });
    });
  }
}

async function patchPro(
  ctx: SettingsPanelContext,
  patch: Partial<ProActiveSettings>
): Promise<void> {
  await ctx.patchSettings({ pro: { ...ctx.settings.pro, ...patch } });
}
