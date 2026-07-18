/**
 * 정규식 스크립트 저장/조립 — 전역(PluginData) + 시나리오별(카드 extensions.regex_scripts).
 *
 * 엔진(regex-engine.ts)은 "이미 합쳐·정렬된 배열"을 받는다. 이 파일이 그 배열을 만든다:
 * 전역 → 시나리오별 순서(ST GLOBAL → SCOPED 우선순위). 시나리오별은 사용자가 허용한
 * 시나리오만 포함한다.
 */

import type { StellaScenario } from "../types/scenario";
import type { RegexScript } from "../types/regex";
import { normalizeRegexScript, REGEX_PLACEMENT, SUBSTITUTE_FIND_REGEX } from "../types/regex";

/** 기본 제공 삽화 프롬프트 후가공 정규식의 고정 id. */
export const DEFAULT_ILLUSTRATION_REGEX_ID = "builtin:regex:illustration:sceneinfo";

/**
 * 기본 제공 삽화 프롬프트 후가공 정규식 한 개.
 * 삽화 프롬프트 응답의 `... sceneInfo: ` 앞부분(offscreen/onscreen 나열)을 지워
 * 실제 이미지 프롬프트만 남긴다. 사용자는 목록에서 끄거나 지울 수 있다.
 */
export function buildDefaultIllustrationRegexScript(): RegexScript {
  return {
    id: DEFAULT_ILLUSTRATION_REGEX_ID,
    scriptName: "sceneInfo 접두 제거",
    findRegex: ".*sceneInfo:\\s",
    replaceString: "",
    trimStrings: [],
    placement: [REGEX_PLACEMENT.AI_OUTPUT],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: SUBSTITUTE_FIND_REGEX.NONE,
    minDepth: -1,
    maxDepth: NaN,
  };
}

/** 시나리오 카드의 정규식 스크립트를 읽어 정규화. ST 와 같은 `data.extensions.regex_scripts` 위치. */
export function readScenarioRegexScripts(scenario: StellaScenario | undefined): RegexScript[] {
  const raw = scenario?.data?.extensions?.regex_scripts;
  if (!Array.isArray(raw)) return [];
  const out: RegexScript[] = [];
  raw.forEach((item, i) => {
    const script = normalizeRegexScript(item, `imported-${i}`);
    if (script) out.push(script);
  });
  return out;
}

/** 시나리오 카드에 정규식 스크립트를 써넣는다(정규화된 배열 → extensions.regex_scripts). */
export function writeScenarioRegexScripts(
  scenario: StellaScenario,
  scripts: RegexScript[]
): void {
  scenario.data.extensions.regex_scripts = scripts;
}

export interface CollectRegexOptions {
  /** 전역 스크립트(PluginData.regexScripts). */
  global?: RegexScript[];
  /** 현재 활성 시나리오(없으면 시나리오별 스크립트 없음). */
  scenario?: StellaScenario;
  /** 이 시나리오의 정규식 실행을 사용자가 허용했는가(PluginData.regexScriptsAllowedScenarios). */
  scenarioAllowed?: boolean;
}

/**
 * 실행에 쓸 스크립트 배열을 조립한다. 전역 먼저, 그 뒤 (허용된) 시나리오별.
 * disabled 스크립트도 그대로 넘긴다 — skip 은 엔진의 runRegexScript 가 처리(ST 동일).
 */
export function collectRegexScripts(opts: CollectRegexOptions): RegexScript[] {
  const global = opts.global ?? [];
  const scoped =
    opts.scenario && opts.scenarioAllowed ? readScenarioRegexScripts(opts.scenario) : [];
  return [...global, ...scoped];
}
