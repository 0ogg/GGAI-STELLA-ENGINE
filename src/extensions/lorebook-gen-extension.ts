/**
 * 로어북 자동 생성 확장 — 생성 완료 훅만 담당한다.
 *
 * 실제 판정(사용 여부/주기/새 본문 유무)과 실행은 `plugin.lorebookGen`
 * (LorebookGenService)이 소유하고, 설정 UI 는 로어북 확장 패널
 * (`stella:lorebook-plus`)에 함께 산다 — 로어북 강화 기능은 그 패널에 편입한다.
 */

import type StellaEnginePlugin from "../main";
import type {
  GenerationCompleteInput,
  StellaExtension,
} from "../services/extension-registry";

function createLorebookGenExtension(): StellaExtension {
  return {
    id: "stella:lorebook-gen",

    async onGenerationComplete(input: GenerationCompleteInput): Promise<void> {
      // generateIfNeeded 가 사용 여부/주기/새 본문 유무를 스스로 판정한다.
      // 자동 경로의 실패는 조용히 넘어간다 — 다음 생성 때 같은 구간을 다시 시도.
      await input.plugin.lorebookGen.generateIfNeeded(
        input.sessionFile,
        input.nodeId
      );
    },
  };
}

/** 반환된 함수를 호출하면 해제된다(설정 '확장' 탭에서 끌 때 사용). */
export function registerLorebookGenExtension(plugin: StellaEnginePlugin): () => void {
  return plugin.extensions.register(createLorebookGenExtension());
}
