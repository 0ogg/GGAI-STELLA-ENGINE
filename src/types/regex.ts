/**
 * 정규식 스크립트 스키마 — SillyTavern 호환.
 *
 * ST 는 정규식 스크립트를 세 곳에 저장한다: 전역(extension_settings.regex),
 * 캐릭터별(card.data.extensions.regex_scripts), 프리셋별. 우리는 전역과 시나리오별
 * 두 단계만 쓴다.
 *  - 전역: `PluginData.regexScripts` (모든 세션 공통)
 *  - 시나리오별: `scenario.data.extensions.regex_scripts` (ST 와 같은 위치 — 카드
 *    임포트/익스포트가 그대로 라운드트립된다)
 *
 * 필드 이름·의미는 ST(`char-data.js` RegexScriptData)와 1:1. 남이 만든 ST 정규식을
 * 임포트해도 값을 잃지 않도록 UI 에 노출하지 않는 필드(trimStrings/runOnEdit/
 * substituteRegex/minDepth/maxDepth)도 보존하고, 엔진은 ST 의미대로 해석한다.
 */

/**
 * 적용 위치. ST `regex_placement` 그대로.
 * 우리 UI 는 USER_INPUT / AI_OUTPUT 만 노출한다(나머지는 임포트 보존용).
 */
export const REGEX_PLACEMENT = {
  /** @deprecated ST 에서도 폐기. */
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  // 4 = sendAs (레거시)
  WORLD_INFO: 5,
  REASONING: 6,
} as const;

/**
 * find 정규식의 매크로 치환 방식. ST `substitute_find_regex` 그대로.
 * NONE = 원본 유지, RAW = 매크로 치환, ESCAPED = 매크로 치환 + 정규식 특수문자 이스케이프.
 */
export const SUBSTITUTE_FIND_REGEX = {
  NONE: 0,
  RAW: 1,
  ESCAPED: 2,
} as const;

/**
 * 확장 결과물 후가공 대상 — Stella 전용(ST 에 대응 개념 없음).
 * 확장마다 별도 후가공 목록(`PluginData.extensionRegex[target]`)을 가지고,
 * LLM 생성물을 받자마자 그 목록을 순서대로 돌린다.
 *  - translation  : AI 가 돌려준 번역문을 저장/표시 전에 가공.
 *  - illustration : AI 가 만든 삽화 프롬프트를 이미지 생성 전에 가공.
 * 후가공 스크립트는 placement/timing 을 쓰지 않는다(목록에 있으면 무조건 적용,
 * disabled 만 존중). 시나리오 카드에는 저장하지 않는다 — 봇카드 정규 양식 유지.
 */
export type RegexExtensionTarget = "translation" | "illustration";

/**
 * 정규식 스크립트 한 개. ST RegexScriptData 와 필드 호환.
 */
export interface RegexScript {
  /** UUID. */
  id: string;
  /** 목록 표시용 이름. */
  scriptName: string;
  /** 찾을 정규식. `/pattern/flags` 또는 순수 패턴 문자열. */
  findRegex: string;
  /** 바꿀 내용. `$1`/`$<name>` 캡처, `{{match}}`(=$0) 지원. */
  replaceString: string;
  /** 매치에서 제거할 문자열들. UI 미노출(임포트 보존). */
  trimStrings: string[];
  /** 적용 위치 배열 (REGEX_PLACEMENT 값). */
  placement: number[];
  /** 꺼짐. */
  disabled: boolean;
  /**
   * 표시용 전용 — 화면 렌더 시점에만 적용, 저장 원문·전송본은 안 건드림.
   * 우리 UI "적용 시점"의 `display`.
   */
  markdownOnly: boolean;
  /**
   * 전송본 전용 — API 로 보낼 프롬프트에만 적용, 저장 원문은 안 건드림.
   * 우리 UI "적용 시점"의 `prompt`.
   */
  promptOnly: boolean;
  /** 사용자가 본문을 편집할 때도 적용. UI 미노출(임포트 보존). */
  runOnEdit: boolean;
  /** find 매크로 치환 방식 (SUBSTITUTE_FIND_REGEX). UI 미노출(임포트 보존). */
  substituteRegex: number;
  /** 최소 깊이(최근 N번째 메시지). UI 미노출(임포트 보존). -1 = 무제한. */
  minDepth: number;
  /** 최대 깊이. UI 미노출(임포트 보존). NaN/음수 = 무제한. */
  maxDepth: number;
}

/**
 * 우리 UI 의 "적용 시점" 3택 — ST 의 (markdownOnly, promptOnly) 플래그 조합을 하나로 묶은 것.
 *  - prompt  : 전송본만 (promptOnly=true)
 *  - display : 표시용    (markdownOnly=true) — 표시 렌더링 확장이 소비. 지금은 아무 일도 안 함.
 *  - raw     : 저장 원문 (둘 다 false) — 생성 완료 후 저장 전에 원문 치환.
 */
export type RegexApplyTiming = "prompt" | "display" | "raw";

/** (markdownOnly, promptOnly) → 적용 시점. */
export function timingOf(script: Pick<RegexScript, "markdownOnly" | "promptOnly">): RegexApplyTiming {
  if (script.promptOnly) return "prompt";
  if (script.markdownOnly) return "display";
  return "raw";
}

/** 적용 시점 → (markdownOnly, promptOnly). */
export function timingFlags(timing: RegexApplyTiming): Pick<RegexScript, "markdownOnly" | "promptOnly"> {
  return {
    markdownOnly: timing === "display",
    promptOnly: timing === "prompt",
  };
}

/** 새 빈 스크립트 (UI 기본값 — AI 출력 대상, 전송본 시점). */
export function createBlankRegexScript(id: string): RegexScript {
  return {
    id,
    scriptName: "",
    findRegex: "",
    replaceString: "",
    trimStrings: [],
    placement: [REGEX_PLACEMENT.AI_OUTPUT],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: false,
    substituteRegex: SUBSTITUTE_FIND_REGEX.NONE,
    minDepth: -1,
    maxDepth: NaN,
  };
}

/**
 * 임포트/외부 데이터의 느슨한 객체를 RegexScript 로 정규화.
 * 필드가 빠졌거나 타입이 어긋나도 안전한 기본값으로 채운다(라운드트립 관용).
 * 반환 null = 스크립트로 볼 수 없음(findRegex 없음).
 */
export function normalizeRegexScript(raw: unknown, fallbackId: string): RegexScript | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const find = typeof src.findRegex === "string" ? src.findRegex : "";
  if (!find) return null;
  const num = (v: unknown, d: number): number =>
    typeof v === "number" && !Number.isNaN(v) ? v : d;
  return {
    id: typeof src.id === "string" && src.id ? src.id : fallbackId,
    scriptName: typeof src.scriptName === "string" ? src.scriptName : "",
    findRegex: find,
    replaceString: typeof src.replaceString === "string" ? src.replaceString : "",
    trimStrings: Array.isArray(src.trimStrings) ? src.trimStrings.map(String) : [],
    placement: Array.isArray(src.placement)
      ? src.placement.filter((p): p is number => typeof p === "number")
      : [REGEX_PLACEMENT.AI_OUTPUT],
    disabled: Boolean(src.disabled),
    markdownOnly: Boolean(src.markdownOnly),
    promptOnly: Boolean(src.promptOnly),
    runOnEdit: Boolean(src.runOnEdit),
    substituteRegex: num(src.substituteRegex, SUBSTITUTE_FIND_REGEX.NONE),
    minDepth: num(src.minDepth, -1),
    maxDepth: typeof src.maxDepth === "number" ? src.maxDepth : NaN,
  };
}
