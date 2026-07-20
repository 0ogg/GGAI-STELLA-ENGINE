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
  GenerationCompleteInput,
  StellaExtension,
} from "../services/extension-registry";
import { createSummarySettingsPanel } from "../views/detail/panels/summary-panel";
import { composeSummaryContextForPath } from "../util/summarize-session";
import { Notice } from "obsidian";

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
      const text = composeSummaryContextForPath(
        input.session,
        summaries,
        input.leafId
      );
      return text ? [{ slot: "summary", text }] : [];
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
