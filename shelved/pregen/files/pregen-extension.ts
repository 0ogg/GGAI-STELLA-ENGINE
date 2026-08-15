/**
 * 이중 생성 확장 — 본 생성 직전 1차 호출의 결과를 전송본에 끼워 넣는다.
 * (설계·경계는 `이중 생성 스펙.md`)
 *
 * 확장은 "언제 부르고 어디에 넣을지"만 정한다. 실제 1차 호출은 `plugin.pregen`
 * (PregenService) 이 소유하고, 무엇을 뽑을지는 사용자가 고른 프롬프트 세트가 정한다 —
 * **용도(속마음·계획 등)를 이 파일에 넣지 않는다.**
 *
 * 미리보기(dry-run)는 AI 를 새로 부르지 않고 마지막 1차 결과를 그대로 보여준다
 * (로어북 AI 선별과 같은 규약) — 미리보기가 비용을 유발하지 않게.
 */

import type StellaEnginePlugin from "../main";
import type { ContextContribution } from "../services/extension-registry";
import { createPregenSettingsPanel } from "../views/detail/panels/pregen-panel";
import { applyPregenInjectTemplate } from "../util/pregen-prompt-preset";

export const PREGEN_EXTENSION_ID = "stella:pregen";

export function registerPregenExtension(plugin: StellaEnginePlugin): () => void {
  const offExtension = plugin.extensions.register({
    id: PREGEN_EXTENSION_ID,
    async contributeContext({
      sessionFile,
      leafId,
      excludeTailAssistant,
      speakerId,
      settings,
      dryRun,
    }): Promise<ContextContribution[]> {
      const pregen = settings.pregen;
      // 꺼져 있거나 프롬프트 세트가 없으면 아무것도 기여하지 않는다 →
      // 전송본이 이 확장이 없던 때와 byte 단위로 같다(롤백 경계).
      if (pregen?.enabled !== true || !pregen.promptSetId) return [];
      // 지금 만드는 게 1차 호출의 전송본이면 기여하지 않는다 — 1차가 자기 직전
      // 결과를 다시 읽어 되먹임하는 것을 막는다(1차는 dryRun 이라 아래 캐시 경로를 탄다).
      if (plugin.pregen.isRunning(sessionFile)) return [];

      const raw = dryRun
        ? plugin.pregen.getCached(sessionFile, leafId)
        : await plugin.pregen.run(
            sessionFile,
            // 본 생성이 보는 지점 그대로 넘긴다 — 재생성이면 부모 노드 기준이어야 한다.
            { leafId, excludeTailAssistant, speakerId },
            pregen
          );
      // 날것 그대로 넣지 않는다 — 무엇인지(대사가 아님)와 누가 알 수 있는지를
      // 표시하는 틀을 거친다. 틀은 설정에서 편집 가능(빈 틀 = 감싸지 않음).
      const text = applyPregenInjectTemplate(pregen.injectTemplate, raw);
      if (!text) return [];

      // 자리 해석(설정 3종 + {{pregen}} 매크로)은 컨텍스트 빌더가 한다 — 요약과
      // 같은 모양으로, 확장은 값만 넘긴다.
      return [{ slot: "pregen", text }];
    },
  });

  const offPanel = plugin.registerSettingsPanel(createPregenSettingsPanel());

  return () => {
    offExtension();
    offPanel();
  };
}
