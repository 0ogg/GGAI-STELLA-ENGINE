import { type EventRef, Notice, setIcon } from "obsidian";
import type { SettingsPanel, SettingsPanelContext } from "../../../services/settings-panel-registry";
import type { SummaryActiveSettings } from "../../../types/preset";
import { getDefaultPrompts } from "../../../util/default-media-prompts";
import { DEFAULT_SUMMARY_THRESHOLD } from "../../../util/summarize-session";
import { SummaryManagerModal } from "../../summary-manager-modal";
import { renderMediaModelPicker, renderMediaPromptPicker } from "../media-prompt-panel";
import {
  renderEnableToggle,
  renderNumberRow,
} from "../setting-controls";

/**
 * 요약 설정 — 확장 탭에 등록되는 1호 내장 패널. 외부 확장이 같은 방식으로
 * `plugin.registerSettingsPanel(...)` 을 부르는 예시이기도 하다 (`확장 패널 스펙.md` 참고).
 */
export function createSummarySettingsPanel(): SettingsPanel {
  // 패널 객체는 플러그인 생애에 한 번만 만들어진다 — 렌더마다 이전 구독을 해제하고
  // 다시 걸어 리스너가 하나만 살아 있게 한다 (summary-running-changed 실시간 반영).
  let runningRef: EventRef | null = null;
  return {
    id: "stella:summary",
    title: "요약 설정",
    order: 2, // 번역(0)/삽화(1) 다음 — 구 미디어 영역과 같은 순서.
    render(body, ctx) {
      const { plugin, settings } = ctx;

      renderEnableToggle({
        parent: body,
        label: "요약 사용",
        checked: settings.summarize?.enabled === true,
        onChange: (enabled) => void patchSummarize(ctx, { enabled }),
      });

      renderMediaModelPicker({
        plugin,
        parent: body,
        label: "모델",
        profiles: plugin.ai.listGenerationProfiles(),
        activeId: settings.summarize?.modelProfileId,
        onSelect: (modelProfileId) => void patchSummarize(ctx, { modelProfileId }),
        emptyText: "Core 텍스트 모델이 없습니다.",
      });

      renderMediaPromptPicker({
        plugin,
        parent: body,
        label: "프롬프트",
        bucket: "summary",
        activeId: settings.summarize?.promptId,
        onSelect: (promptId) => void patchSummarize(ctx, { promptId }),
        onChanged: () => ctx.rerender(),
        onDeleted: (promptId) => {
          if (settings.summarize?.promptId === promptId) {
            void patchSummarize(ctx, { promptId: undefined });
          } else {
            ctx.rerender();
          }
        },
      });

      // 요약 주기 — 마지막 요약 이후 AI 생성이 이 횟수만큼 쌓이면 자동 요약.
      renderNumberRow({
        parent: body,
        label: "요약 주기(생성 횟수)",
        value: settings.summarize?.threshold ?? DEFAULT_SUMMARY_THRESHOLD,
        fallback: DEFAULT_SUMMARY_THRESHOLD,
        min: 1,
        step: 1,
        integer: true,
        onChange: (threshold) => void patchSummarize(ctx, { threshold }),
      });

      // 요약 최대 토큰 — 누적 요약이 이 토큰을 넘으면 오래된 상위 절반을 압축.
      // 0 = 압축 안 함.
      renderNumberRow({
        parent: body,
        label: "요약 최대 토큰(넘으면 압축, 0=안 함)",
        value: settings.summarize?.maxTokens ?? 0,
        fallback: 0,
        min: 0,
        step: 100,
        integer: true,
        onChange: (maxTokens) => void patchSummarize(ctx, { maxTokens }),
      });

      // 수동 요약 / 요약 관리 — 즉시 요약하거나, 사건 조각을 확인·수정·재생성하는
      // 관리 창을 연다. 현재 요약 컨텍스트도 관리 창에서 본다 (패널에는 안 그린다).
      // 요약이 진행 중(수동/자동)이면 [지금 요약] 버튼이 [요약 정지]로 바뀐다.
      const actions = body.createDiv({ cls: "ggai-summary-actions" });
      const summarizeNowBtn = actions.createEl("button", { cls: "ggai-btn" });
      const nowIcon = summarizeNowBtn.createSpan();
      const summarizeNowLabel = summarizeNowBtn.createSpan();
      summarizeNowBtn.addEventListener("click", () => {
        if (plugin.summary.running) {
          plugin.summary.cancelAll();
        } else {
          void runManualSummarize(ctx, () => progressEl.setText(""));
        }
      });
      const manageBtn = actions.createEl("button", { cls: "ggai-btn" });
      setIcon(manageBtn.createSpan(), "list");
      manageBtn.createSpan({ text: "요약 관리" });
      manageBtn.addEventListener("click", () => {
        if (!ctx.activeSessionFile) {
          new Notice("활성 세션이 없습니다.");
          return;
        }
        SummaryManagerModal.open(plugin, ctx.activeSessionFile);
      });
      const progressEl = body.createDiv({ cls: "ggai-summary-progress" });

      // 진행 상태에 따라 버튼 모양/라벨을 맞춘다. 실시간 반영은 store 이벤트로.
      const syncRunning = () => {
        if (!summarizeNowBtn.isConnected) return;
        const running = plugin.summary.running;
        setIcon(nowIcon, running ? "square" : "zap");
        summarizeNowLabel.setText(running ? "요약 정지" : "지금 요약");
        if (!running) progressEl.setText("");
        else if (!progressEl.textContent) progressEl.setText("요약 중…");
      };
      if (runningRef) plugin.store.offref(runningRef);
      runningRef = plugin.store.on("summary-running-changed", syncRunning);
      syncRunning();

      // 수동 요약의 진행(n/m)은 이 패널이 직접 표시한다 (자동 요약은 "요약 중…"만).
      pendingProgressSink = (text: string) => {
        if (progressEl.isConnected) progressEl.setText(text);
      };
    },
  };
}

/** 수동 요약 진행 표시를 이 패널로 흘려보내는 싱크 (렌더마다 최신 progressEl 로 교체). */
let pendingProgressSink: ((text: string) => void) | null = null;

/** "지금 요약" — 주기 판정을 건너뛰고 활성 세션을 즉시 요약한다. */
async function runManualSummarize(
  ctx: SettingsPanelContext,
  onDone: () => void
): Promise<void> {
  if (!ctx.activeSessionFile) {
    new Notice("활성 세션이 없습니다.");
    return;
  }
  const result = await ctx.plugin.summary.summarize(ctx.activeSessionFile, undefined, {
    // 밀린 구간을 주기 단위로 나눠 요약할 때 진행 표시 (구간 하나씩 즉시 저장됨).
    onProgress: (done, total) => {
      if (total > 1) pendingProgressSink?.(`요약 중… ${done}/${total}`);
    },
  });
  onDone();
  if (result.cancelled) {
    new Notice("요약을 취소했습니다.");
    ctx.rerender();
    return;
  }
  if (!result.ok) {
    new Notice(`요약 실패: ${result.errors[0] ?? "알 수 없는 오류"}`);
    return;
  }
  if (result.skipped) {
    new Notice("요약할 새 내용이 없습니다.");
    return;
  }
  new Notice("요약을 갱신했습니다.");
  ctx.rerender();
}

async function patchSummarize(
  ctx: SettingsPanelContext,
  patch: Partial<SummaryActiveSettings>
): Promise<void> {
  let summarize = { ...(ctx.settings.summarize ?? {}), ...patch };
  // 요약 사용 시 기본 프롬프트 자동 지정 (사용자가 아직 아무 것도 선택하지 않은 경우)
  if (summarize.enabled && !summarize.promptId) {
    const def = getDefaultPrompts("summary")[0];
    if (def) summarize = { ...summarize, promptId: def.id };
  }
  await ctx.patchSettings({ summarize });
}
