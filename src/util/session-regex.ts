import type StellaEnginePlugin from "../main";
import { REGEX_PLACEMENT, type RegexExtensionTarget } from "../types/regex";
import { scenarioFileOfSessionFile } from "./build-session-context";
import { applyMacros } from "./macros";
import { getRegexedString, runRegexScript } from "./regex-engine";
import { collectRegexScripts } from "./regex-scripts";

/** 세션 파일 기준 정규식 매크로 치환({{char}}/{{user}}) + 시나리오 항목 조회. */
async function resolveRegexContext(
  plugin: StellaEnginePlugin,
  sessionFile: string
): Promise<{
  item: Awaited<ReturnType<StellaEnginePlugin["store"]["getScenarios"]>>[number] | undefined;
  substitute: (s: string) => string;
}> {
  const scenarioFile = scenarioFileOfSessionFile(sessionFile);
  const scenarios = await plugin.store.getScenarios();
  const item = scenarios.find((i) => i.scenarioFile === scenarioFile);
  const { profile: user } = await plugin.resolveActiveUserProfile();
  const substitute = (s: string) =>
    applyMacros(s, {
      char: item?.scenario.data?.name?.trim() || "Character",
      user: user.name?.trim() || "User",
    });
  return { item, substitute };
}

/**
 * 저장 원문(raw) 시점 정규식 — 생성 결과를 세션에 저장하기 직전에 치환한다.
 *
 * 전송본(promptOnly)/표시(markdownOnly) 시점 스크립트는 엔진의 timing 필터에
 * 걸러져 여기서 돌지 않는다(isPrompt/isMarkdown 미지정 = raw 경로). depth 는
 * 항상 0 — 방금 생성된 메시지가 가장 최근이다.
 *
 * 호출처: 소설 뷰·챗 뷰의 생성 finally, 선채팅 서비스. 셋 다 노드 저장 전에
 * 부른다. 실패는 조용히 원문 유지(생성 결과를 잃지 않는 게 우선).
 */
export async function applyRawRegexToGeneration(
  plugin: StellaEnginePlugin,
  sessionFile: string,
  text: string
): Promise<string> {
  if (!text) return text;
  try {
    const { item, substitute } = await resolveRegexContext(plugin, sessionFile);
    const stellaId = item?.scenario.data?.extensions?.stella?.id;
    const scripts = collectRegexScripts({
      global: plugin.data.regexScripts,
      scenario: item?.scenario,
      scenarioAllowed:
        !!stellaId &&
        (plugin.data.regexScriptsAllowedScenarios ?? []).includes(stellaId),
    });
    if (scripts.length === 0) return text;
    return getRegexedString(text, REGEX_PLACEMENT.AI_OUTPUT, scripts, {
      depth: 0,
      substitute,
    });
  } catch (err) {
    console.warn("[GGAI Stella] 저장 원문 정규식 적용 실패:", err);
    return text;
  }
}

/**
 * 확장 결과물(번역문/삽화 프롬프트) 후가공기 — 해당 확장의 후가공 목록
 * (`PluginData.extensionRegex[target]`)을 순서대로 돌리는 함수를 돌려준다.
 * 목록이 비어 있으면 null. 후가공 스크립트는 placement/timing 을 쓰지 않는다
 * (disabled 는 runRegexScript 가 존중). 번역처럼 항목이 여러 개인 호출부가
 * 매크로 컨텍스트 조회를 한 번만 하도록 함수를 돌려준다.
 * 실패는 조용히 null(원문 유지 — 확장 결과를 잃지 않는 게 우선).
 */
export async function createExtensionRegexApplier(
  plugin: StellaEnginePlugin,
  sessionFile: string,
  target: RegexExtensionTarget
): Promise<((text: string) => string) | null> {
  try {
    const scripts = (plugin.data.extensionRegex?.[target] ?? []).filter(
      (s) => !s.disabled
    );
    if (scripts.length === 0) return null;
    const { substitute } = await resolveRegexContext(plugin, sessionFile);
    return (text: string) => {
      if (!text) return text;
      let out = text;
      for (const script of scripts) {
        out = runRegexScript(script, out, { substitute });
      }
      return out;
    };
  } catch (err) {
    console.warn("[GGAI Stella] 확장 결과물 정규식 준비 실패:", err);
    return null;
  }
}
