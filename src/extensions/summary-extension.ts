/**
 * 요약 확장 — 스텔라 내장 확장 1호이자 외부 확장의 표본.
 *
 * "요약"은 본체 생성 로직에 하드코딩돼 있지 않고, 확장 API 위에서만 동작한다:
 *  - `contributeContext` : 요약 사용 중일 때 누적 요약을 `summary` 슬롯에 채운다
 *    (엔진이 작가노트 바로 위 자동 삽입 / `{{summary}}` 매크로 / chatSummary 마커로 배치).
 *  - `onGenerationComplete` : 생성 직후 주기 도달 시 자동 요약(SummaryService 위임).
 *  - 설정 UI 는 확장 탭 패널(`createSummarySettingsPanel`)로, 같은 확장 모듈이 함께 등록한다.
 *
 * 실제 요약 작업(패시지 추출/모델 호출/앵커 기록)은 `plugin.summary`(SummaryService)가
 * 소유한다 — 확장은 "언제 무엇을 붙이고 실행할지"만 정한다.
 */

import type StellaEnginePlugin from "../main";
import type {
  ContextContribution,
  ExtensionContextInput,
  ExtensionReviseInput,
  GenerationCompleteInput,
  StellaExtension,
} from "../services/extension-registry";
import { createSummarySettingsPanel } from "../views/detail/panels/summary-panel";
import {
  composeSummaryParts,
  composeSummaryPartsExcludingVisible,
} from "../util/summarize-session";
import { Notice } from "obsidian";

/**
 * 합성한 두 블록을 기여 형태로 — 나눠 배치면 「지난 이야기」를 확장 custom 슬롯으로
 * 본문 앞(로어북 뒤)에 보내고 `summary` 슬롯에는 「현재 상황」만 남긴다.
 * 기본 배치면 둘을 한 덩어리로 `summary` 슬롯에 넣는다(기존 자리 그대로).
 */
function summaryContributions(
  parts: { past: string; state: string },
  split: boolean
): ContextContribution[] {
  if (split) {
    const out: ContextContribution[] = [];
    if (parts.past) {
      out.push({
        slot: "custom",
        text: parts.past,
        name: "요약: 지난 이야기",
        position: "after_char",
        order: 90,
      });
    }
    if (parts.state) out.push({ slot: "summary", text: parts.state });
    return out;
  }
  const text = [parts.past, parts.state].filter((t) => t !== "").join("\n\n");
  return text ? [{ slot: "summary", text }] : [];
}

function createSummaryExtension(): StellaExtension {
  return {
    id: "stella:summary",

    async contributeContext(
      input: ExtensionContextInput
    ): Promise<ContextContribution[]> {
      // 요약 사용이 꺼져 있으면 아무것도 기여하지 않는다 → {{summary}} 도 빈 값.
      if (input.settings.summarize?.enabled !== true) return [];
      const summaries = await input.plugin.store.getSessionSummaries(
        input.sessionFile
      );

      return summaryContributions(
        composeSummaryParts(input.session, summaries, input.leafId),
        input.settings.summarize.splitPlacement === true
      );
    },

    /**
     * 2차 기여 — 본문이 예산에 얼마나 들어갔는지 확정된 뒤, **본문에 그대로 남아
     * 있는 구간의 사건 요약을 뺀다**(같은 내용을 두 번 보내지 않기). 뺄 게 없으면
     * null 을 돌려 재조립을 시키지 않는다.
     */
    async reviseContext(
      input: ExtensionReviseInput
    ): Promise<ContextContribution[] | null> {
      const summarize = input.settings.summarize;
      if (summarize?.enabled !== true) return null;
      if (summarize.skipVisibleBody !== true) return null;

      // 살아남은 본문 구간의 시작 위치. 여유(10%)를 둬 경계에 걸친 앵커는 남긴다 —
      // 글자 수는 근사치라, 덜 빼는 쪽으로 틀리는 게 맞다.
      const visibleFromChar = Math.max(
        0,
        input.bodyText.length - Math.floor(input.visibleBodyChars * 0.9)
      );
      const summaries = await input.plugin.store.getSessionSummaries(
        input.sessionFile
      );
      const full = composeSummaryParts(input.session, summaries, input.leafId);
      const trimmed = composeSummaryPartsExcludingVisible(
        input.session,
        summaries,
        input.leafId,
        input.hiddenNodeIds,
        visibleFromChar
      );
      if (trimmed.past === full.past) return null; // 뺄 게 없다 → 재조립 안 함
      return summaryContributions(
        trimmed,
        summarize.splitPlacement === true
      );
    },

    async onGenerationComplete(input: GenerationCompleteInput): Promise<void> {
      // summarizeIfNeeded 가 사용 여부/주기/새 패시지 유무를 스스로 판정한다.
      const result = await input.plugin.summary.summarizeIfNeeded(
        input.sessionFile,
        input.nodeId
      );
      if (!result.ok && result.errors.length > 0) {
        new Notice(`자동 요약 실패: ${result.errors[0]}`);
      }
    },
  };
}

/**
 * 요약 확장 모듈 등록 — 확장(컨텍스트/생성-완료 훅) + 설정 패널을 한 번에 꽂는다.
 * 반환된 함수를 호출하면 둘 다 해제된다(설정 '확장' 탭에서 끌 때 사용).
 */
export function registerSummaryExtension(plugin: StellaEnginePlugin): () => void {
  const disposeExt = plugin.extensions.register(createSummaryExtension());
  const disposePanel = plugin.registerSettingsPanel(createSummarySettingsPanel());
  return () => {
    disposeExt();
    disposePanel();
  };
}
