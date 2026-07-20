/**
 * 삽화 확장 — 요약 확장과 같은 확장 API 위에서만 동작한다 (본체 생성 경로에 하드코딩 없음).
 *
 *  - `onGenerationComplete` : 삽화 사용 + 자동 삽화가 켜져 있으면, 밀도 게이트
 *    (마지막 삽화 이후 완성 문단 수 ≥ 주기)를 통과할 때만 새 원문 노드의 삽화를
 *    생성한다. 카운터를 저장하지 않고 매번 현재 브랜치 기준으로 계산하므로 분기
 *    이동/편집으로 어긋나지 않는다. 결과는 store 이벤트로 각 뷰/출력 뷰에 반영된다.
 *  - 설정 UI 는 확장 탭 패널(`createIllustrationSettingsPanel`)로 함께 등록한다
 *    (모델/프롬프트/출력 위치/로어북 선택 — 로어북 선택 UI 는 설정 패널에 유지).
 *
 * 실제 삽화 작업(프롬프트 생성 LLM → image() → variant 기록)은 `plugin.illustration`
 * (IllustrationService)이 소유한다. 수동 생성(툴바 탭/재생성 모달)은 각 세션 뷰가
 * 같은 서비스를 직접 호출한다.
 */

import type StellaEnginePlugin from "../main";
import type {
  GenerationCompleteInput,
  StellaExtension,
} from "../services/extension-registry";
import { createIllustrationSettingsPanel } from "../views/detail/panels/illustration-panel";
import { buildChatMessages } from "../util/chat-messages";
import {
  completedParagraphsAfter,
  computeIllustrationAnchors,
  DEFAULT_ILLUSTRATION_AUTO_MIN_PARAGRAPHS,
} from "../util/illustration-anchors";
import { getActiveIllustration } from "../util/illustrations";
import { buildSpans, spansToText } from "../util/session-text";
import { tokenizeParagraphs } from "../util/translate-paragraphs";
import type { StellaSession } from "../types/session";

function createIllustrationExtension(): StellaExtension {
  return {
    id: "stella:illustration",

    async onGenerationComplete(input: GenerationCompleteInput): Promise<void> {
      const { plugin, sessionFile, nodeId } = input;
      const session = await plugin.store.getSession(sessionFile);
      if (!session) return;
      const i = session.meta.illustration;
      if (i?.enabled !== true || i?.auto !== true) return;

      // 자동 생성 주기 — 0 = 매 생성마다(게이트 없음). 수동(툴바 탭)은 이 게이트를 안 탄다.
      const threshold =
        i.autoMinParagraphs ?? DEFAULT_ILLUSTRATION_AUTO_MIN_PARAGRAPHS;
      if (threshold > 0) {
        const fresh =
          session.meta.mode === "chat"
            ? await freshParagraphsChat(plugin, sessionFile, session)
            : await freshParagraphsNovel(plugin, sessionFile, session);
        if (fresh < threshold) return;
      }

      const r = await plugin.illustration.generateForNode(sessionFile, nodeId);
      if (!r.ok) console.warn("[GGAI Stella] 자동 삽화 실패:", r.errors);
    },
  };
}

/** 소설 세션 — 마지막 삽화 앵커 이후 완성 문단 수 (활성 브랜치 기준). */
async function freshParagraphsNovel(
  plugin: StellaEnginePlugin,
  sessionFile: string,
  session: StellaSession
): Promise<number> {
  const illustrations = await plugin.store.getSessionIllustrations(sessionFile);
  const anchors = computeIllustrationAnchors(session, illustrations);
  const last = anchors.length > 0 ? anchors[anchors.length - 1].offset : 0;
  return completedParagraphsAfter(spansToText(buildSpans(session)), last);
}

/** 챗 세션 — 마지막 삽화가 붙은 메시지 이후 메시지들의 문단 수. */
async function freshParagraphsChat(
  plugin: StellaEnginePlugin,
  sessionFile: string,
  session: StellaSession
): Promise<number> {
  const ill = await plugin.store.getSessionIllustrations(sessionFile);
  const msgs = buildChatMessages(session);
  let lastIdx = -1;
  msgs.forEach((m, idx) => {
    if (getActiveIllustration(ill, m.nodeId)) lastIdx = idx;
  });
  return msgs
    .slice(lastIdx + 1)
    .reduce(
      (n, m) =>
        n + tokenizeParagraphs(m.text).filter((t) => t.kind === "paragraph").length,
      0
    );
}

/**
 * 삽화 확장 모듈 등록 — 확장(생성-완료 훅) + 설정 패널을 한 번에 꽂는다.
 * 반환된 함수를 호출하면 둘 다 해제된다(설정 '확장' 탭에서 끌 때 사용).
 */
export function registerIllustrationExtension(plugin: StellaEnginePlugin): () => void {
  const disposeExt = plugin.extensions.register(createIllustrationExtension());
  const disposePanel = plugin.registerSettingsPanel(createIllustrationSettingsPanel());
  return () => {
    disposeExt();
    disposePanel();
  };
}
