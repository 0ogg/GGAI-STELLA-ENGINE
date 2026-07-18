/**
 * 정규식 치환 엔진 — 순수 함수. SillyTavern `regex/engine.js` 의 동작을 그대로 옮겼다.
 *
 * ST 와의 차이: ST 는 전역/캐릭터/프리셋 스크립트를 내부에서 읽어오지만, 여기서는
 * 이미 합쳐·정렬된 스크립트 배열을 인자로 받는다(전역 → 시나리오별 순서로 caller 가 조립).
 * 매크로 치환도 caller 가 주입한 함수로 처리해 이 파일은 세션/플러그인에 의존하지 않는다.
 *
 * 나중에 GGAI Core agent() tool 로 노출할 가치가 있어 순수 함수로 유지한다.
 */

import type { RegexScript } from "../types/regex";
import { SUBSTITUTE_FIND_REGEX } from "../types/regex";

/** 정규식 적용 시 caller 가 넘기는 컨텍스트. ST getRegexedString params 대응. */
export interface RegexRunParams {
  /** 표시용 경로(화면 렌더). ST isMarkdown. */
  isMarkdown?: boolean;
  /** 전송본 경로(프롬프트 조립). ST isPrompt. */
  isPrompt?: boolean;
  /** 사용자 편집 경로. ST isEdit — runOnEdit 스크립트만 통과. */
  isEdit?: boolean;
  /** 최근 N번째 메시지(0 = 마지막). min/maxDepth 필터용. */
  depth?: number;
  /**
   * 매크로 치환 함수. ST substituteParams 대응. replaceString·trimStrings·find(RAW/ESCAPED)에
   * 적용된다. 미지정 시 치환 없이 원문 유지.
   */
  substitute?: (text: string) => string;
  /**
   * find 정규식용 이스케이프 매크로 치환. ST substituteParamsExtended(.., sanitizeRegexMacro).
   * 미지정 시 substitute 를 그대로 쓴다.
   */
  substituteEscaped?: (text: string) => string;
}

/** 컴파일된 정규식 캐시 (ST RegexProvider 축약판 — LRU 없이 단순 Map). */
const regexCache = new Map<string, RegExp | null>();

/**
 * `/pattern/flags` 또는 순수 패턴 문자열 → RegExp. ST utils.regexFromString 그대로.
 * 잘못된 정규식이면 null.
 */
export function regexFromString(input: string): RegExp | null {
  if (regexCache.has(input)) {
    const cached = regexCache.get(input) ?? null;
    if (cached && (cached.global || cached.sticky)) cached.lastIndex = 0;
    return cached;
  }
  let result: RegExp | null = null;
  try {
    const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
    if (!m) {
      result = new RegExp(input);
    } else if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
      // 유효하지 않은 플래그 조합 — 통째로 패턴 취급.
      result = new RegExp(input);
    } else {
      result = new RegExp(m[2], m[3]);
    }
  } catch {
    result = null;
  }
  regexCache.set(input, result);
  return result;
}

/** find 정규식에서 매크로가 정규식 특수문자를 깨지 않도록 이스케이프. ST sanitizeRegexMacro. */
export function sanitizeRegexMacro(x: string): string {
  if (typeof x !== "string") return x;
  return x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (s) => {
    switch (s) {
      case "\n": return "\\n";
      case "\r": return "\\r";
      case "\t": return "\\t";
      case "\v": return "\\v";
      case "\f": return "\\f";
      case "\0": return "\\0";
      default: return "\\" + s;
    }
  });
}

/**
 * 스크립트 하나를 문자열에 적용. ST runRegexScript 그대로.
 * disabled·빈 find·빈 입력이면 원문 반환.
 */
export function runRegexScript(
  script: RegexScript,
  rawString: string,
  params: RegexRunParams = {}
): string {
  if (!script || script.disabled || !script.findRegex || !rawString) {
    return rawString;
  }

  const sub = params.substitute ?? ((s: string) => s);
  const subEscaped =
    params.substituteEscaped ?? ((s: string) => sanitizeRegexMacro(sub(s)));

  const getRegexString = (): string => {
    switch (Number(script.substituteRegex)) {
      case SUBSTITUTE_FIND_REGEX.NONE:
        return script.findRegex;
      case SUBSTITUTE_FIND_REGEX.RAW:
        return sub(script.findRegex);
      case SUBSTITUTE_FIND_REGEX.ESCAPED:
        return subEscaped(script.findRegex);
      default:
        return script.findRegex;
    }
  };

  const findRegex = regexFromString(getRegexString());
  if (!findRegex) return rawString;

  return rawString.replace(findRegex, function (match: string) {
    const args = [...arguments];
    const replaceString = script.replaceString.replace(/{{match}}/gi, "$0");
    const replaceWithGroups = replaceString.replace(
      /\$(\d+)|\$<([^>]+)>/g,
      (_full, num?: string, groupName?: string) => {
        let value: unknown = match;
        if (num) {
          value = args[Number(num)];
        } else if (groupName) {
          const groups = args[args.length - 1];
          value = groups && typeof groups === "object" ? groups[groupName] : undefined;
        }
        if (!value) return "";
        return filterString(String(value), script.trimStrings, sub);
      }
    );
    return sub(replaceWithGroups);
  });
}

/** 매치에서 trimStrings 를 제거. ST filterString. */
function filterString(
  rawString: string,
  trimStrings: string[],
  substitute: (s: string) => string
): string {
  let finalString = rawString;
  for (const trimString of trimStrings) {
    const sub = substitute(trimString);
    if (sub) finalString = finalString.split(sub).join("");
  }
  return finalString;
}

/**
 * 조건에 맞는 스크립트만 골라 순서대로 적용. ST getRegexedString 그대로.
 *
 * @param scripts 이미 합쳐·정렬된 스크립트 배열(전역 → 시나리오별). "허용" 필터는 caller 책임.
 * @param placement 현재 적용 위치(REGEX_PLACEMENT 값).
 */
export function getRegexedString(
  rawString: string,
  placement: number,
  scripts: RegexScript[],
  params: RegexRunParams = {}
): string {
  if (typeof rawString !== "string" || !rawString || placement === undefined) {
    return typeof rawString === "string" ? rawString : "";
  }

  const { isMarkdown, isPrompt, isEdit, depth } = params;
  let finalString = rawString;

  for (const script of scripts) {
    const timingMatch =
      (script.markdownOnly && isMarkdown) ||
      (script.promptOnly && isPrompt) ||
      // 둘 다 아니면(저장 원문 대상) 표시·전송 경로가 아닐 때만 — 원문 자체가 이미 바뀌어 있어야 함.
      (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt);
    if (!timingMatch) continue;

    if (isEdit && !script.runOnEdit) continue;

    if (typeof depth === "number") {
      if (
        !Number.isNaN(script.minDepth) &&
        script.minDepth !== null &&
        script.minDepth >= -1 &&
        depth < script.minDepth
      ) {
        continue;
      }
      if (
        !Number.isNaN(script.maxDepth) &&
        script.maxDepth !== null &&
        script.maxDepth >= 0 &&
        depth > script.maxDepth
      ) {
        continue;
      }
    }

    if (script.placement.includes(placement)) {
      finalString = runRegexScript(script, finalString, params);
    }
  }

  return finalString;
}
