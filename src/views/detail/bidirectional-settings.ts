import { Notice } from "obsidian";
import type { SettingsPanelContext } from "../../services/settings-panel-registry";
import { DEFAULT_GLOSSARY_INTERVAL } from "../../services/pro-glossary-service";
import type { ProActiveSettings } from "../../types/preset";
import { PRO_STYLE_TAIL_CHARS_DEFAULT } from "../../services/pro-service";
import { PRO_STYLE_PAIRS_DEFAULT } from "../../util/pro-convert";
import {
  discardPendingReflections,
  summarizePendingReflections,
} from "../../util/translate-paragraphs";
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
    renderPendingReflectionRow(body, ctx, activeSessionFile);

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

/**
 * 반영 대기 현황 + 일괄 취소 — **막혔을 때의 탈출구**.
 *
 * 집필 변환이 실패하면 대기함은 재시도를 위해 보존된다(성공해야 비운다). 그래서 그 건이
 * 끝내 반영될 수 없는 내용이면(잘못 쓴 초고, 원문 쪽에서 이미 다시 쓴 문단) 이어쓰기가
 * 계속 그 반영부터 시도하다 멈춰 **사용자가 풀 방법이 없었다**. 여기서 대기분을 통째로
 * 취소하면 원문은 지금 상태 그대로, 내가 쓴 문장도 화면에 그대로 남은 채 잠금만 풀린다.
 */
function renderPendingReflectionRow(
  body: HTMLElement,
  ctx: SettingsPanelContext,
  sessionFile: string
): void {
  const { plugin } = ctx;
  const row = body.createDiv({ cls: "ggai-media-block" });
  const label = row.createDiv({ cls: "ggai-media-label", text: "반영 대기" });
  const hint = row.createDiv({ cls: "ggai-media-hint", text: "확인 중…" });
  const btn = row.createEl("button", {
    cls: "ggai-preset-btn",
    text: "반영 대기 취소",
  });
  btn.disabled = true;
  // 되돌릴 수 없으므로 두 번 눌러야 실행된다(모달 없이 그 자리에서 확인).
  let armed = false;

  const disarm = (): void => {
    armed = false;
    btn.setText("반영 대기 취소");
  };

  const refresh = async (): Promise<void> => {
    const translations = await plugin.store.getSessionTranslations(sessionFile);
    const { paragraphs, draftChars } = summarizePendingReflections(translations);
    const empty = paragraphs === 0 && draftChars === 0;
    hint.setText(
      empty
        ? "원문에 반영되지 않고 기다리는 내용이 없습니다."
        : `수정한 문단 ${paragraphs}개 · 쓰던 초고 ${draftChars}자가 이어쓰기 때 원문에 반영됩니다. ` +
          "반영이 계속 실패해 이어쓰기가 막히면 취소해서 풀 수 있습니다 " +
          "(원문은 지금 그대로, 내가 쓴 문장도 번역 화면에 그대로 남습니다)."
    );
    btn.disabled = empty;
    disarm();
  };

  btn.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      btn.setText("정말 취소할까요? 한 번 더");
      return;
    }
    btn.disabled = true;
    void (async () => {
      const translations = await plugin.store.getSessionTranslations(sessionFile);
      const { paragraphs, draftChars } = discardPendingReflections(translations);
      await plugin.store.saveSessionTranslations(sessionFile, translations);
      new Notice(
        `반영 대기를 취소했습니다 — 문단 ${paragraphs}개 · 초고 ${draftChars}자.`
      );
      await refresh();
    })();
  });

  void refresh();
}

async function patchPro(
  ctx: SettingsPanelContext,
  patch: Partial<ProActiveSettings>
): Promise<void> {
  await ctx.patchSettings({ pro: { ...ctx.settings.pro, ...patch } });
}
