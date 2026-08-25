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

/** 재생성 대상 passage 를 감싸는 구분자 — 고쳐 쓸 범위를 문자 단위로 확정한다. */
export const PASSAGE_OPEN = "<<<";
export const PASSAGE_CLOSE = ">>>";
const PASSAGE_HEADING =
  "── Passage to rewrite (rewrite exactly this, nothing else) ──";
const INSTRUCTIONS_HEADING = "── Instructions ──";

/**
 * 사용자 재생성 프롬프트 뒤에 붙는 엔진 고정 규약.
 * 프롬프트 내용(문체 지시 등)과 무관하게 "고쳐쓴 본문만 출력"을 강제한다.
 */
export const PARAGRAPH_REGEN_IO_INSTRUCTIONS = [
  "You are rewriting one passage inside an ongoing story.",
  "Your output will REPLACE the marked passage exactly — the paragraphs before and after it stay as they are.",
  "",
  `- Rewrite only the text between the ${PASSAGE_OPEN} and ${PASSAGE_CLOSE} markers. Do not continue the story past its final sentence, and do not re-narrate what came before it.`,
  "- Cover the same events, in the same order, at roughly the same length. Do not add or remove scenes, and do not resolve anything the passage leaves open.",
  "- The passage may start or end mid-scene. Leave it that way.",
  "- Keep the original language unless the instructions explicitly ask otherwise. Preserve paragraph breaks where they still make sense.",
  "- Output the rewritten passage only — no commentary, no quotes, no markdown fences, no markers.",
].join("\n");

/**
 * 재생성 요청 본문 조립.
 *  - instruction: 저장된 재생성 프롬프트 (`{{main}}` 매크로로 본문 위치 지정 가능).
 *  - source: 재생성 대상 원문 (현재 편집 영역의 값 — 범위 원문, 사용자 직접 수정, 또는
 *    직전 AI 결과 중 현재 커서가 가리키는 단계의 텍스트).
 *  - feedback: 사용자의 일회성 추가 지시 — 언제나 대상 passage 바로 앞에 놓는다
 *    (프롬프트 꼬리에 붙이면 생성 유도 문구 뒤 = AI 가 답을 쓸 자리로 들어간다).
 *  - context: 세션 참고 맥락(앞뒤 문단+요약) 블록 — 대상 passage/지침과 분리해 맨 앞에.
 *  - lorebook: 대상 본문에 매칭된 로어북(용어집) 텍스트. `{{lorebook}}` 매크로가 있으면
 *    그 자리에, 없으면 참고 블록으로 맨 앞에.
 *
 * 배치: 용어집 → 참고 맥락 → 지침(+추가 지시) → 대상 passage(구분자로 감쌈, 맨 마지막).
 * 컨텍스트가 앞에 길게 붙어도 "고쳐 쓸 범위"가 흐려지지 않게 대상을 끝에 둔다.
 * `{{main}}` 을 쓴 프롬프트는 사용자가 위치를 직접 정한 것이므로 그 자리 치환을 존중한다.
 */
export function buildParagraphRegenBody(
  instruction: string,
  source: string,
  opts?: { feedback?: string; context?: string; lorebook?: string }
): string {
  const feedback = opts?.feedback?.trim() ?? "";
  const context = opts?.context?.trim() ?? "";
  const lorebook = opts?.lorebook?.trim() ?? "";
  const hasMain = /\{\{\s*main\s*\}\}/i.test(instruction);
  const hasLore = /\{\{\s*lorebook\s*\}\}/i.test(instruction);

  // 대상 passage 는 어디에 놓이든 구분자로 감싼다 — 고정 규약이 이 구분자를 가리킨다.
  // 추가 지시는 언제나 대상 바로 앞 (프롬프트 꼬리 = 생성 유도 문구 뒤로 밀리면 안 된다).
  const passage =
    (feedback ? `Additional instruction: ${feedback}\n\n` : "") +
    `${PASSAGE_OPEN}\n${source}\n${PASSAGE_CLOSE}`;

  // `{{lorebook}}` 을 쓴 프롬프트는 그 자리가 "참고 자료" 슬롯이다 — 세션 맥락도
  // 거기 합류시킨다(번역과 같은 규약). 매크로가 없을 때만 맨 앞에 따로 붙인다.
  const reference = hasLore
    ? [lorebook, context].filter((s) => s).join("\n\n")
    : "";

  const text = hasMain
    ? composeMediaPrompt(instruction, passage, reference)
    : [
        `${INSTRUCTIONS_HEADING}\n${
          hasLore
            ? instruction.replace(/\{\{\s*lorebook\s*\}\}/gi, () => reference).trim()
            : instruction.trim()
        }`,
        `${PASSAGE_HEADING}\n${passage}`,
      ].join("\n\n");

  if (hasLore) return text;
  // 매크로를 안 쓴 프롬프트는 용어집·맥락을 라벨 붙은 참고 블록으로 맨 앞에.
  const loreBlock = lorebook
    ? [
        "── Glossary / world info (reference only) ──",
        "Terminology, names, and setting facts relevant to the passage. Follow them for consistency — do NOT translate, repeat, or output this section.",
        lorebook,
      ].join("\n\n")
    : "";
  return [loreBlock, context, text].filter((s) => s).join("\n\n");
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
    `The passage to rewrite appears at the very end, between ${PASSAGE_OPEN} and ${PASSAGE_CLOSE} markers. Everything here is the surrounding story and its current state, provided ONLY for continuity — do NOT rewrite, translate, repeat, or output any of it.`,
    ...sections,
  ].join("\n\n");
}
