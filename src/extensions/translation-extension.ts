/**
 * 번역 확장 — 요약 확장과 같은 확장 API 위에서만 동작한다 (본체 생성 경로에 하드코딩 없음).
 *
 *  - `onGenerationComplete` : 번역 사용 + 자동 번역이 켜져 있으면, 이번 생성으로
 *    새로 생긴/바뀐 구간의 문단만 자동 번역한다 (과거의 미번역 본문 전체를 보내지 않음).
 *    소설/챗 세션 공통 — 결과는 store 이벤트(`session-translations-changed`)로 각 뷰에
 *    실시간 반영된다.
 *  - 설정 UI 는 확장 탭 패널(`createTranslationSettingsPanel`)로 함께 등록한다
 *    (모델/프롬프트/출력 방식/로어북 선택 — 로어북 선택 UI 는 설정 패널에 유지).
 *
 * 실제 번역 작업(청크 분할/모델 호출/variant 기록)은 `plugin.translation`
 * (TranslationService)이 소유한다 — 확장은 "언제 무엇을 실행할지"만 정한다.
 * 수동 번역(툴바/뷰어 버튼)은 각 세션 뷰가 같은 서비스를 직접 호출한다.
 */

import type StellaEnginePlugin from "../main";
import type {
  GenerationCompleteInput,
  StellaExtension,
} from "../services/extension-registry";
import { createTranslationSettingsPanel } from "../views/detail/panels/translation-panel";
import { buildSpans, spansToText } from "../util/session-text";
import { collectUntranslatedParagraphsFrom } from "../util/translate-paragraphs";

function createTranslationExtension(): StellaExtension {
  return {
    id: "stella:translation",

    async onGenerationComplete(input: GenerationCompleteInput): Promise<void> {
      const { plugin, sessionFile, parentText } = input;
      const session = await plugin.store.getSession(sessionFile);
      if (!session) return;
      const t = session.meta.translation;
      if (t?.enabled !== true || t?.auto !== true) return;

      // 생성 시작 지점이 속한 문단부터 (직전 문단 경계로 한 칸 양보).
      const fromOffset = Math.max(0, parentText.length - 1);
      const translations = await plugin.store.getSessionTranslations(sessionFile);
      const flat = spansToText(buildSpans(session));
      const targets = collectUntranslatedParagraphsFrom(
        flat,
        translations,
        fromOffset
      );
      if (targets.length === 0) return;
      const r = await plugin.translation.translateParagraphs(sessionFile, {
        hashes: targets.map((p) => p.hash),
      });
      if (!r.ok) {
        console.warn("[GGAI Stella] 자동 번역 실패:", r.errors);
        return;
      }
      // 소설 세션은 자동 번역 뒤 번역 보기로 전환한다 (구 세션창 runTranslate 동작 보존).
      // displayMode 저장 → session-translations-changed → 열린 세션창이 모드를 따라간다.
      if (session.meta.mode !== "chat" && r.updatedHashes.length > 0) {
        const latest = await plugin.store.getSessionTranslations(sessionFile);
        if (latest.displayMode !== "translation") {
          latest.displayMode = "translation";
          await plugin.store.saveSessionTranslations(sessionFile, latest);
        }
      }
    },
  };
}

/**
 * 번역 확장 모듈 등록 — 확장(생성-완료 훅) + 설정 패널을 한 번에 꽂는다.
 * 반환된 함수를 호출하면 둘 다 해제된다(설정 '확장' 탭에서 끌 때 사용).
 */
export function registerTranslationExtension(plugin: StellaEnginePlugin): () => void {
  const disposeExt = plugin.extensions.register(createTranslationExtension());
  const disposePanel = plugin.registerSettingsPanel(createTranslationSettingsPanel());
  return () => {
    disposeExt();
    disposePanel();
  };
}
