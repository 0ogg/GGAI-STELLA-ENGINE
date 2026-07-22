/**
 * 집필 프로(PRO) — 한→영 집필 변환 순수 로직 (집필 프로 스펙.md §3).
 *
 * 이 파일은 **순수 함수**만 담는다 (vault/AI 의존성 없음). 실제 AI 호출과 세션/번역
 * 저장은 services/pro-service.ts 가 담당한다.
 *
 * 프로토콜은 번역 세그먼트(JSON 배열, id 1:1)와 같은 모양을 쓴다 — 응답 파싱은
 * translate-paragraphs 의 `parseTranslationResponse` 를 그대로 재사용한다.
 *  - "context" = 영어판 꼬리 문단(문체 참조, 반환하지 않음)
 *  - "write"   = 저자의 새/수정 한국어 문단(각각 영어 문단 하나로 변환)
 *
 * 한 요청은 여러 접합 연산(op — 문단 교체/끝 덧붙임)을 함께 나른다: op 마다 한국어를
 * 문단 토큰으로 나누고 위치 기반 id(`w<op>_<n>`)로 write 세그먼트를 만들어, 응답을
 * 순서·개수로 검증한다. 영어 문단 내부 줄바꿈은 공백으로 접어 문단 해시 구조를 지킨다
 * (줄바꿈이 남으면 본문 토큰화 때 문단이 쪼개져 한국어 짝이 어긋난다).
 */

import type { SessionTranslations } from "../types/media";
import { tokenizeParagraphs, type ParagraphToken } from "./translate-paragraphs";

/** 문체 예시로 첨부할 문단 쌍 수 기본값 (0 = 끄기). 설정 UI 로 조절. */
export const PRO_STYLE_PAIRS_DEFAULT = 3;

/**
 * 장면 전환 구분선(`***` 류) 문단인가. 저자가 장면 전환용으로 넣은 별표 줄은
 * 언어 중립이라 집필 변환이 필요 없다 — 영어판에도 같은 기호를 그대로 넣는다.
 * 공백을 무시하고 별표 3개 이상(`***`, `* * *`)이면 참 (문단 토큰은 줄바꿈이 없다).
 */
export function isSceneBreakParagraph(source: string): boolean {
  return /^\*{3,}$/.test(source.replace(/\s+/g, ""));
}

/**
 * 접합 텍스트의 마지막 문단이 장면 전환(***)인가 — 끝(append)에 붙는데 뒤 줄바꿈이
 * 없으면, 이어질 생성/집필이 그 구분선에 한 문단으로 들러붙는다. 호출자가 이 경우
 * 문단 구분 줄바꿈을 덧붙여 다음 내용이 새 문단으로 시작하게 한다.
 */
export function endsWithSceneBreak(text: string): boolean {
  const tokens = tokenizeParagraphs(text);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token.kind === "separator") continue;
    return isSceneBreakParagraph(token.source);
  }
  return false;
}

/** 엔진 고정 IO 규약 — 사용자 프롬프트 앞(시스템 지시 자리)에 결합된다. */
export const PRO_CONVERT_IO_INSTRUCTIONS = [
  "Input is a JSON array of segments:",
  '[{ "id": string, "role": "context" | "write", "source": string }]',
  '"context" segments are the tail of the existing English manuscript — style reference only; never return them.',
  '"write" segments are the author\'s new or revised passage, written in Korean.',
  'For every "write" segment, compose the English paragraph that belongs at that point of the manuscript, following the instructions above.',
  "Never merge, split, or omit segments — exactly one output item per \"write\" segment, same order.",
  "Do not use line breaks inside an output — one flowing paragraph per segment.",
  "Respond with a JSON array only — no markdown fences, no commentary:",
  '[{ "id": string, "translation": string }]',
  "Keep each id exactly as given in the input.",
].join("\n");

export interface ProConvertSegment {
  id: string;
  role: "context" | "write";
  source: string;
}

/** 접합 연산 하나의 조립 재료 — 응답을 원래 문단 구조로 되돌릴 때 쓴다. */
export interface ProConvertOpPlan {
  /** 이 op 의 write 세그먼트 id (문서 순서). */
  writeIds: string[];
  /** 이 op 한국어의 토큰 분해 — 구분자 구조를 그대로 재현한다. */
  koTokens: ParagraphToken[];
}

export interface ProSpliceRequest {
  segments: ProConvertSegment[];
  /** 입력 ops 와 같은 순서. */
  perOp: ProConvertOpPlan[];
}

/**
 * 변환 요청 세그먼트 조립.
 *  - styleTail: 영어판 꼬리(호출자가 글자 수 제한/문단 경계 정리) → context 세그먼트.
 *  - kos: 접합 연산별 한국어(양끝 공백 제거) → write 세그먼트 (문단별, 위치 id).
 */
export function buildProSpliceRequest(
  kos: string[],
  styleTail: string
): ProSpliceRequest {
  const segments: ProConvertSegment[] = [];
  let ctx = 0;
  for (const token of tokenizeParagraphs(styleTail)) {
    if (token.kind !== "paragraph") continue;
    ctx++;
    segments.push({ id: `ctx${ctx}`, role: "context", source: token.source });
  }
  const perOp: ProConvertOpPlan[] = [];
  kos.forEach((ko, opIdx) => {
    const koTokens = tokenizeParagraphs(ko.trim());
    const writeIds: string[] = [];
    for (const token of koTokens) {
      if (token.kind !== "paragraph") continue;
      // 장면 전환(***) 문단은 변환 없이 그대로 통과 — write 세그먼트를 만들지 않는다.
      if (isSceneBreakParagraph(token.source)) continue;
      const id = `w${opIdx + 1}_${writeIds.length + 1}`;
      writeIds.push(id);
      segments.push({ id, role: "write", source: token.source });
    }
    perOp.push({ writeIds, koTokens });
  });
  return { segments, perOp };
}

export interface ProConvertPair {
  /** 변환된 영어 문단 (내부 줄바꿈 없음). */
  en: string;
  /** 저자가 쓴 한국어 문단 원문. */
  ko: string;
}

export interface ProConvertAssembly {
  ok: boolean;
  /** 이 op 자리에 들어갈 영어 텍스트 — 한국어 입력의 구분자 구조를 그대로 재현. */
  englishText: string;
  /** 문단 짝 (문서 순서) — authored variant 기록용. */
  pairs: ProConvertPair[];
  errors: string[];
}

/**
 * 응답(id→영어)을 한 op 의 입력 토큰 구조에 접합한다.
 * write 세그먼트가 하나라도 비거나 누락되면 실패 (부분 접합은 원고를 어긋나게 한다).
 */
export function assembleProConversion(
  plan: ProConvertOpPlan,
  translationById: Map<string, string>
): ProConvertAssembly {
  const errors: string[] = [];
  const pairs: ProConvertPair[] = [];
  let englishText = "";
  let writeIndex = 0;
  for (const token of plan.koTokens) {
    if (token.kind === "separator") {
      englishText += token.text;
      continue;
    }
    // 장면 전환(***) — AI 변환 없이 원문 기호 그대로, 짝도 동일(en=ko).
    if (isSceneBreakParagraph(token.source)) {
      englishText += token.source;
      pairs.push({ en: token.source, ko: token.source });
      continue;
    }
    const id = plan.writeIds[writeIndex++];
    const raw = id !== undefined ? translationById.get(id) : undefined;
    // 내부 줄바꿈은 공백으로 접는다 — 문단 해시/짝 구조 보존 (파일 상단 주석 참조).
    const en = raw?.replace(/\s*\n+\s*/g, " ").trim() ?? "";
    if (en === "") {
      errors.push(`문단 ${writeIndex} 의 변환이 응답에 없습니다.`);
      continue;
    }
    englishText += en;
    pairs.push({ en, ko: token.source });
  }
  if (errors.length > 0) {
    return { ok: false, englishText: "", pairs: [], errors };
  }
  return { ok: true, englishText, pairs, errors };
}

/**
 * 문체 예시용 문단 쌍 수집 — 본문 끝에서부터 거슬러 올라가며, active 번역 variant 가
 * `authored`(저자가 직접 쓴 한국어)인 문단만 최대 max 개. 반환은 문서 순서.
 * 저자의 원문이 섞인 예시라 쓸수록 AI 한/영이 저자 문체를 닮는 자기강화 재료다.
 */
export function collectStylePairs(
  baselineText: string,
  translations: SessionTranslations,
  max: number
): ProConvertPair[] {
  if (max <= 0) return [];
  const seen = new Set<string>();
  const collected: ProConvertPair[] = [];
  const tokens = tokenizeParagraphs(baselineText);
  for (let i = tokens.length - 1; i >= 0 && collected.length < max; i--) {
    const token = tokens[i];
    if (token.kind !== "paragraph" || seen.has(token.hash)) continue;
    seen.add(token.hash);
    if (isSceneBreakParagraph(token.source)) continue; // 장면 전환은 문체 예시 대상 아님
    const entry = translations.paragraphs[token.hash];
    const active = entry ? entry.variants[entry.activeVariantId] : undefined;
    if (active?.kind !== "authored" || active.text.trim() === "") continue;
    collected.push({ en: token.source, ko: active.text });
  }
  return collected.reverse();
}

/**
 * 문단 쌍을 프롬프트 첨부 블록으로 — `{{pairs}}` 자리(없으면 본문 뒤)에 결합된다.
 * direction 에 따라 "어느 쪽 목소리를 따라야 하는지" 한 줄이 달라진다.
 */
export function formatStylePairs(
  pairs: ProConvertPair[],
  direction: "koToEn" | "enToKo"
): string {
  if (pairs.length === 0) return "";
  const guide =
    direction === "koToEn"
      ? "Match the English voice shown in \"en\" when composing new English."
      : "Match the author's Korean voice shown in \"ko\" when writing Korean.";
  const payload = JSON.stringify(pairs.map((p) => ({ ko: p.ko, en: p.en })));
  return [
    "Paired style examples from this manuscript (ko = the author's own Korean, en = the English manuscript):",
    guide,
    payload,
  ].join("\n");
}

export interface AuthoredPairScan {
  /** 스캔 대상 짝 (오래된 것부터 — 상한 초과분은 다음 스캔으로 넘어간다). */
  pairs: ProConvertPair[];
  /** 포함된 마지막 짝의 createdAt — 성공 시 다음 scanAt. 짝이 없으면 sinceAt 그대로. */
  lastAt: number;
  /** 상한에 걸려 이번에 못 실은 미스캔 짝 수. */
  remaining: number;
}

/**
 * 번역 용어집 스캔 대상 수집 — active variant 가 `authored` 이고 sinceAt 이후에
 * 만들어진 문단 짝. 오래된 것부터 max 개 (남은 분은 remaining 으로 보고).
 */
export function collectUnscannedAuthoredPairs(
  translations: SessionTranslations,
  sinceAt: number,
  max: number
): AuthoredPairScan {
  const candidates: Array<ProConvertPair & { at: number }> = [];
  for (const entry of Object.values(translations.paragraphs)) {
    const active = entry.variants[entry.activeVariantId];
    if (active?.kind !== "authored" || active.text.trim() === "") continue;
    if (active.createdAt <= sinceAt) continue;
    candidates.push({ en: entry.source, ko: active.text, at: active.createdAt });
  }
  candidates.sort((a, b) => a.at - b.at);
  const take = max > 0 ? candidates.slice(0, max) : [];
  return {
    pairs: take.map((p) => ({ en: p.en, ko: p.ko })),
    lastAt: take.length > 0 ? take[take.length - 1].at : sinceAt,
    remaining: candidates.length - take.length,
  };
}

/**
 * 영어판 꼬리를 문체 참조용으로 자른다 — maxChars 로 끝에서 자르고, 잘린 앞쪽
 * 부분 문단은 버린다(문단 경계 정렬). 본문 전체가 한 문단이면 그대로 쓴다.
 */
export function sliceStyleTail(baseline: string, maxChars: number): string {
  if (maxChars <= 0 || baseline.length === 0) return "";
  if (baseline.length <= maxChars) return baseline;
  const tail = baseline.slice(-maxChars);
  const cut = tail.indexOf("\n");
  return cut >= 0 ? tail.slice(cut + 1) : tail;
}
