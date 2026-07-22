/**
 * 문단 재생성 순수 로직 — 미디어 확장 스펙 "문단 재생성 버튼 구상" 구현.
 *
 * 이 파일은 **순수 함수**만 담는다 (vault/AI 의존성 없음).
 * 실제 AI 호출은 services/paragraph-regen-service.ts, 본문 교체(user-edit 노드 파생)는
 * session-view 가 담당한다. 원문 교체는 사용자가 패널에서 승인했을 때에만 일어난다.
 */

import { composeMediaPrompt } from "./media-prompt-body";
import { tokenizeParagraphs } from "./translate-paragraphs";

/** 본문 내 문단 하나의 위치 정보 (raw = baseline 본문 char offset). */
export interface ParagraphRangeInfo {
  /** 문서 순서 인덱스 (구분자 제외, 중복 내용 문단도 각각 하나). */
  index: number;
  hash: string;
  source: string;
  from: number;
  to: number;
}

/** 본문의 문단 목록 — 각 문단의 raw offset 범위 포함 (클릭 매핑/범위 선택용). */
export function listParagraphRanges(text: string): ParagraphRangeInfo[] {
  const out: ParagraphRangeInfo[] = [];
  let offset = 0;
  for (const token of tokenizeParagraphs(text)) {
    if (token.kind === "separator") {
      offset += token.text.length;
      continue;
    }
    out.push({
      index: out.length,
      hash: token.hash,
      source: token.source,
      from: offset,
      to: offset + token.source.length,
    });
    offset += token.source.length;
  }
  return out;
}

/**
 * raw offset → 문단 인덱스. 구분자(빈 줄)에 떨어지면 바로 앞 문단을 택한다.
 * 문단이 하나도 없으면 null.
 */
export function paragraphIndexAtOffset(
  ranges: ParagraphRangeInfo[],
  offset: number
): number | null {
  if (ranges.length === 0) return null;
  for (const r of ranges) {
    if (offset < r.from) return r.index > 0 ? r.index - 1 : r.index;
    if (offset <= r.to) return r.index;
  }
  return ranges.length - 1;
}

/**
 * 사용자 재생성 프롬프트 뒤에 붙는 엔진 고정 규약.
 * 프롬프트 내용(문체 지시 등)과 무관하게 "고쳐쓴 본문만 출력"을 강제한다.
 */
export const PARAGRAPH_REGEN_IO_INSTRUCTIONS = [
  "Input contains a passage from an ongoing story and rewriting instructions.",
  "Rewrite the passage according to the instructions.",
  "Unless the instructions explicitly ask you to translate or change the language, keep the same language as the original passage. Preserve paragraph breaks where they still make sense.",
  "Respond with the rewritten passage only — no commentary, no quotes, no markdown fences.",
].join("\n");

/**
 * 재생성 요청 본문 조립.
 *  - instruction: 저장된 재생성 프롬프트 (`{{main}}` 매크로로 본문 위치 지정 가능).
 *  - source: 재생성 대상 원문 (현재 편집 영역의 값 — 범위 원문, 사용자 직접 수정, 또는
 *    직전 AI 결과 중 현재 커서가 가리키는 단계의 텍스트).
 *  - feedback: 사용자의 일회성 추가 지시.
 *  - context: 세션 참고 맥락(앞뒤 문단+요약) 블록 — 대상 passage/지침과 분리해 맨 앞에.
 *    없으면 기존 동작(대상 문장 + 지침만) 그대로.
 */
export function buildParagraphRegenBody(
  instruction: string,
  source: string,
  opts?: { feedback?: string; context?: string }
): string {
  const feedback = opts?.feedback?.trim() ?? "";
  const context = opts?.context?.trim() ?? "";
  let text = composeMediaPrompt(instruction, source);
  if (feedback) {
    text += `\n\nAdditional instruction: ${feedback}`;
  }
  return context ? `${context}\n\n${text}` : text;
}

/** 재생성 맥락 첨부 세트 수 (1세트=6문단, 앞·뒤 각 방향). 체크박스로 끄면 미첨부. */
export const PARAGRAPH_REGEN_CONTEXT_SETS = 3;
/** 1세트 = 6문단. */
export const PARAGRAPH_REGEN_CONTEXT_SET_SIZE = 6;

/**
 * 재생성 대상 범위 앞/뒤 문단 원문 수집 — baseline 기준, 각 방향 sets*setSize 문단.
 * sets<=0 이면 빈 배열. startIndex/endIndex 는 대상 범위의 문단 인덱스(포함).
 */
export function collectRegenContext(
  baselineText: string,
  startIndex: number,
  endIndex: number,
  sets: number,
  setSize = PARAGRAPH_REGEN_CONTEXT_SET_SIZE
): { before: string[]; after: string[] } {
  if (sets <= 0) return { before: [], after: [] };
  const ranges = listParagraphRanges(baselineText);
  const span = sets * setSize;
  return {
    before: ranges
      .slice(Math.max(0, startIndex - span), Math.max(0, startIndex))
      .map((r) => r.source),
    after: ranges.slice(endIndex + 1, endIndex + 1 + span).map((r) => r.source),
  };
}

/**
 * 재생성 참고 블록 — 대상 passage 와 확실히 구분해 "다시 쓰지/출력하지 말 것, 참고용"
 * 을 명시한다. 요약/앞 문단/뒤 문단 중 있는 것만. 전부 비면 "".
 */
export function formatRegenContext(
  before: string[],
  after: string[],
  summary: string
): string {
  const sections: string[] = [];
  if (summary.trim()) sections.push(`[Story so far]\n${summary.trim()}`);
  if (before.length) sections.push(`[Preceding paragraphs]\n${before.join("\n\n")}`);
  if (after.length) sections.push(`[Following paragraphs]\n${after.join("\n\n")}`);
  if (sections.length === 0) return "";
  return [
    "── Story context (reference only) ──",
    "The passage to rewrite is given separately below. Everything here is the surrounding story and its current state, provided ONLY for continuity — do NOT rewrite, translate, repeat, or output any of it.",
    ...sections,
  ].join("\n\n");
}
