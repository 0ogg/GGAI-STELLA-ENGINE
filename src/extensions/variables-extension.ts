/**
 * 변수 확장 — 게임형 카드가 기억하는 값(애정도·소지금·시스템 토글 등)을 다룬다.
 *
 * 지금 이 확장이 하는 일은 **설정 패널 등록**뿐이다. 값을 읽고 쓰는 기계는
 * `plugin.variables`(VariablesService)가 소유하고, 전송본에 값이 반영되는 자리는
 * `planSessionRequest` 한 곳이다(전송본 단일 진실 소스 — CLAUDE.md 7).
 *
 * 확장을 끄면 패널이 사라지고 전송본도 예전 동작(`meta.variables` 그대로)으로
 * 돌아간다 — 걷어내기 1단계(`게임형 카드 지원 스펙.md` 롤백 경계).
 */

import type StellaEnginePlugin from "../main";
import { createVariablesSettingsPanel } from "../views/detail/panels/variables-panel";

export function registerVariablesExtension(
  plugin: StellaEnginePlugin
): () => void {
  return plugin.registerSettingsPanel(createVariablesSettingsPanel());
}
