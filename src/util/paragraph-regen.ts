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
 */
export function buildParagraphRegenBody(
  instruction: string,
  source: string,
  opts?: { feedback?: string }
): string {
  const feedback = opts?.feedback?.trim() ?? "";
  let text = composeMediaPrompt(instruction, source);
  if (feedback) {
    text += `\n\nAdditional instruction: ${feedback}`;
  }
  return text;
}
