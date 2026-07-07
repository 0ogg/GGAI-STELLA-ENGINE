/**
 * 문단 기준 번역 순수 로직 — 미디어 확장 스펙 "번역" 절 (2026-06-13 문단 개편) 구현.
 *
 * 이 파일은 **순수 함수**만 담는다 (vault/AI 의존성 없음).
 * 실제 AI 호출과 translations.json 저장은 services/translation-service.ts 가 담당한다.
 *
 * 모델:
 *  - 최종 본문을 줄바꿈 기준 문단으로 나누고, 문단 원문 내용의 해시가 번역 키.
 *  - 원문 문단이 바뀌면 키가 바뀌어 "번역 안 됨"이 된다. 같은 내용 문단은 번역 공유.
 *  - 번역문은 슬롯 안에서 내부 구조(대사/서술 줄바꿈 등)가 자유로운 통짜 텍스트.
 */

import type {
  SessionTranslations,
  TranslationUndoItem,
  TranslationVariant,
  TranslationVariantKind,
} from "../types/media";
import { uuidv4 } from "./uuid";

// ─────────────────────────── 문단 분해 ───────────────────────────

export interface SourceParagraph {
  /** hashText(source) — translations.json paragraphs 의 키. */
  hash: string;
  /** 문단 원문 (양 끝 줄바꿈 제외, 내용 그대로). */
  source: string;
}

/** 본문 → 문단/구분자 토큰. 토큰을 순서대로 이으면 원문과 동일. */
export type ParagraphToken =
  | { kind: "paragraph"; hash: string; source: string }
  | { kind: "separator"; text: string };

/**
 * 최종 본문을 줄바꿈 구분자 기준으로 문단 토큰화한다.
 * 구분자(연속 줄바꿈)는 별도 토큰으로 보존 — 표시 계층이 원문 구조를 그대로 재현.
 */
export function tokenizeParagraphs(text: string): ParagraphToken[] {
  if (!text) return [];
  const out: ParagraphToken[] = [];
  for (const piece of text.split(/(\n+)/)) {
    if (!piece) continue;
    if (/^\n+$/.test(piece)) {
      out.push({ kind: "separator", text: piece });
    } else {
      out.push({ kind: "paragraph", hash: hashText(piece), source: piece });
    }
  }
  return out;
}

/** 본문의 문단 목록 (중복 내용 문단은 1회 — 번역 공유). */
export function collectParagraphs(text: string): SourceParagraph[] {
  const seen = new Set<string>();
  const out: SourceParagraph[] = [];
  for (const token of tokenizeParagraphs(text)) {
    if (token.kind !== "paragraph") continue;
    if (seen.has(token.hash)) continue;
    seen.add(token.hash);
    out.push({ hash: token.hash, source: token.source });
  }
  return out;
}

/**
 * 문단에 쓸 만한 번역이 있는지 — active variant 가 있고 내용이 비어있지 않을 때만 true.
 * 빈(공백뿐인) 번역은 없는 것으로 취급해 미번역/재번역 대상에 다시 들어오게 한다.
 */
export function hasTranslation(
  translations: SessionTranslations,
  hash: string
): boolean {
  const t = getActiveTranslation(translations, hash);
  return !!t && t.text.trim() !== "";
}

/** active 번역이 없는(또는 빈) 문단만 (일괄 번역 대상). */
export function collectUntranslatedParagraphs(
  text: string,
  translations: SessionTranslations
): SourceParagraph[] {
  return collectParagraphs(text).filter(
    (p) => !hasTranslation(translations, p.hash)
  );
}

/**
 * fromOffset 이후에 끝나는 미번역 문단만 — 자동 번역 대상.
 * 생성 직후 "새로 생긴/이어쓰기로 바뀐 구간"만 번역하고, 과거의 번역 안 된
 * 본문 전체를 자동으로 보내지 않기 위한 경계.
 */
export function collectUntranslatedParagraphsFrom(
  text: string,
  translations: SessionTranslations,
  fromOffset: number
): SourceParagraph[] {
  const seen = new Set<string>();
  const out: SourceParagraph[] = [];
  let offset = 0;
  for (const token of tokenizeParagraphs(text)) {
    const len =
      token.kind === "separator" ? token.text.length : token.source.length;
    const end = offset + len;
    if (
      token.kind === "paragraph" &&
      end > fromOffset &&
      !seen.has(token.hash) &&
      !hasTranslation(translations, token.hash)
    ) {
      seen.add(token.hash);
      out.push({ hash: token.hash, source: token.source });
    }
    offset = end;
  }
  return out;
}

/**
 * 번역 대상을 요청 단위로 분할 — 대량 번역을 한 번에 보내지 않고 순차 전송해
 * 중간 실패 시에도 이미 받은 번역을 보존하기 위함. 문단 수/글자 수 중 먼저
 * 차는 기준으로 끊는다 (단일 문단이 maxChars 를 넘으면 그 문단 하나가 한 청크).
 */
export function chunkParagraphs(
  targets: SourceParagraph[],
  maxParagraphs: number,
  maxChars: number
): SourceParagraph[][] {
  const chunks: SourceParagraph[][] = [];
  let current: SourceParagraph[] = [];
  let chars = 0;
  for (const p of targets) {
    if (
      current.length > 0 &&
      (current.length >= maxParagraphs || chars + p.source.length > maxChars)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(p);
    chars += p.source.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ─────────────────────────── AI 입출력 규약 ───────────────────────────

export interface TranslationRequestSegment {
  /** 문단 해시 — 응답 매칭 키. */
  id: string;
  /** translate = 번역 대상, context = 연속성용 문맥 (번역을 돌려줘도 반영됨). */
  role: "translate" | "context";
  source: string;
}

export interface TranslationResultItem {
  id: string;
  translation: string;
}

/**
 * 사용자 번역 프롬프트 뒤에 붙는 엔진 고정 입출력 규약.
 * 프롬프트 내용(언어/문체)과 무관하게 JSON 배열 입출력을 강제한다.
 */
export const TRANSLATION_IO_INSTRUCTIONS = [
  "Input is a JSON array of story paragraphs in document order:",
  '[{ "id": string, "role": "translate" | "context", "source": string }]',
  'Translate the source of every "translate" segment according to the instructions above.',
  '"context" segments are surrounding paragraphs provided for continuity; you may include an improved translation for them as well.',
  "Inside each translation you may freely restructure line breaks (e.g. separating dialogue and narration) — but never merge or omit segments.",
  "Respond with a JSON array only — no markdown fences, no commentary:",
  '[{ "id": string, "translation": string }]',
  "Keep each id exactly as given in the input.",
].join("\n");

/**
 * 번역 요청 세그먼트 조립.
 *  - targets: 번역 대상 문단 (문서 순서).
 *  - 각 대상 바로 앞 문단이 대상이 아니면 context 로 끼워 연속성을 준다.
 */
export function buildTranslationRequest(
  text: string,
  targets: SourceParagraph[]
): TranslationRequestSegment[] {
  const targetHashes = new Set(targets.map((t) => t.hash));
  const ordered = collectParagraphs(text);
  const segments: TranslationRequestSegment[] = [];
  const included = new Set<string>();
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    if (!targetHashes.has(p.hash)) continue;
    const prev = ordered[i - 1];
    if (prev && !targetHashes.has(prev.hash) && !included.has(prev.hash)) {
      segments.push({ id: prev.hash, role: "context", source: prev.source });
      included.add(prev.hash);
    }
    if (!included.has(p.hash)) {
      segments.push({ id: p.hash, role: "translate", source: p.source });
      included.add(p.hash);
    }
  }
  return segments;
}

/** 응답 텍스트에서 번역 JSON 배열 추출. 코드펜스/잡담 허용, 실패 시 null. */
export function parseTranslationResponse(
  text: string
): TranslationResultItem[] | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    const out: TranslationResultItem[] = [];
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as any).id === "string" &&
        typeof (item as any).translation === "string"
      ) {
        out.push({
          id: (item as any).id,
          translation: (item as any).translation,
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

// ─────────────────────────── variant 관리 ───────────────────────────

/** FNV-1a 32bit — 문단 키. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface RecordTranslationInput {
  /** 문단 원문 — 키(해시)와 entry.source 에 기록. */
  source: string;
  text: string;
  modelProfileId?: string;
  promptId?: string;
  /** 생략 시 첫 번역은 ai-translation, 재번역은 translation-regen. */
  kind?: TranslationVariantKind;
  /** 테스트용 시각 고정. */
  now?: number;
}

/**
 * 문단의 새 translation variant 를 쌓고 active 로 선택한다 (translations 직접 변경).
 * 기존 variant 는 삭제하지 않는다 — 정리는 명시적 다이어트 기능의 몫.
 */
export function recordTranslationVariant(
  translations: SessionTranslations,
  input: RecordTranslationInput
): TranslationVariant {
  const hash = hashText(input.source);
  const entry = translations.paragraphs[hash] ?? {
    source: input.source,
    activeVariantId: "",
    variants: {},
  };
  const kind =
    input.kind ??
    (Object.keys(entry.variants).length > 0
      ? "translation-regen"
      : "ai-translation");
  const now = input.now ?? Date.now();
  const variant: TranslationVariant = {
    id: uuidv4(),
    kind,
    sourceHash: hash,
    text: input.text,
    modelProfileId: input.modelProfileId,
    promptId: input.promptId,
    createdAt: now,
    updatedAt: now,
  };
  entry.source = input.source;
  entry.variants[variant.id] = variant;
  entry.activeVariantId = variant.id;
  translations.paragraphs[hash] = entry;
  return variant;
}

/** 문단의 현재 active 번역 variant. 없으면 null. */
export function getActiveTranslation(
  translations: SessionTranslations,
  hash: string
): TranslationVariant | null {
  const entry = translations.paragraphs[hash];
  if (!entry) return null;
  return entry.variants[entry.activeVariantId] ?? null;
}

/** 문단의 번역 variant 목록 — createdAt 오름차순 (되돌리기용). */
export function listTranslationVariants(
  translations: SessionTranslations,
  hash: string
): TranslationVariant[] {
  const entry = translations.paragraphs[hash];
  if (!entry) return [];
  return Object.values(entry.variants).sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  );
}

/** active variant 를 지정 variant 로 이동. 대상이 없으면 false. */
export function setActiveTranslationVariant(
  translations: SessionTranslations,
  hash: string,
  variantId: string
): boolean {
  const entry = translations.paragraphs[hash];
  if (!entry || !entry.variants[variantId]) return false;
  entry.activeVariantId = variantId;
  return true;
}

// ─────────────────────────── 실행 되돌리기 스택 ───────────────────────────

/** 되돌리기 스택 최대 길이 — 오래된 항목부터 버린다. */
const MAX_UNDO_ENTRIES = 50;

/**
 * "방금 한 번역" 한 건을 되돌리기 스택에 쌓는다 (translations 직접 변경).
 * items 는 이 실행이 건드린 문단별 되돌리기 정보. 비어 있으면 아무것도 안 한다.
 * 새 실행이 생기면 그 이후의 되돌리기는 의미가 없어지므로 redo 스택을 비운다
 * (표준 undo/redo 관례).
 */
export function pushTranslationUndoEntry(
  translations: SessionTranslations,
  items: TranslationUndoItem[],
  now?: number
): void {
  if (items.length === 0) return;
  const stack = translations.undoStack ?? [];
  stack.push({ id: uuidv4(), at: now ?? Date.now(), items });
  while (stack.length > MAX_UNDO_ENTRIES) stack.shift();
  translations.undoStack = stack;
  translations.redoStack = [];
}

/** 되돌릴 번역 실행이 스택에 있는지. */
export function canUndoTranslation(translations: SessionTranslations): boolean {
  return !!translations.undoStack && translations.undoStack.length > 0;
}

/** 다시 적용할(되돌렸던) 번역 실행이 스택에 있는지. */
export function canRedoTranslation(translations: SessionTranslations): boolean {
  return !!translations.redoStack && translations.redoStack.length > 0;
}

export interface UndoTranslationResult {
  /** 실제로 이전 상태로 되돌린 문단 해시. */
  revertedHashes: string[];
  /** 되돌린 뒤 스택에 남은 실행 수. */
  remaining: number;
}

/**
 * 스택 맨 위(가장 최근) 번역 실행을 한 단계 되돌린다 (translations 직접 변경).
 *  - variant 는 삭제하지 않는다("정리는 명시적 다이어트 기능의 몫" 원칙) — active
 *    포인터만 실행 직전 상태로 되돌린다(이전 번역이 있으면 그 번역, 없으면 "번역 안 됨").
 *    variant 를 지우지 않으므로 redo 로 다시 적용할 수 있다.
 *  - 되돌린 뒤 사용자가 그 문단을 직접 고쳤으면(active 가 그 실행 variant 가 아님)
 *    그 편집을 보존하려고 건너뛴다.
 * 스택이 비어 있으면 null.
 */
export function undoLastTranslation(
  translations: SessionTranslations
): UndoTranslationResult | null {
  const stack = translations.undoStack;
  if (!stack || stack.length === 0) return null;
  const entry = stack.pop()!;
  translations.undoStack = stack;
  const reverted: string[] = [];
  for (const item of entry.items) {
    const para = translations.paragraphs[item.hash];
    if (!para) continue;
    // active 가 이 실행이 만든 variant 중 하나가 아니면 이후 편집됨 → 건너뜀.
    if (!item.createdVariantIds.includes(para.activeVariantId)) continue;
    para.activeVariantId = item.prevActiveVariantId;
    reverted.push(item.hash);
  }
  const redoStack = translations.redoStack ?? [];
  redoStack.push(entry);
  while (redoStack.length > MAX_UNDO_ENTRIES) redoStack.shift();
  translations.redoStack = redoStack;
  return { revertedHashes: reverted, remaining: stack.length };
}

export interface RedoTranslationResult {
  /** 실제로 다시 적용한 문단 해시. */
  restoredHashes: string[];
  /** 다시 적용한 뒤 redo 스택에 남은 실행 수. */
  remaining: number;
}

/**
 * 방금 되돌린 번역 실행을 한 단계 다시 적용한다 (translations 직접 변경).
 * 되돌리기 이후 해당 문단을 아무도 건드리지 않았을 때만(active 가 여전히
 * prevActiveVariantId) 복원한다 — 그 사이 새 번역/편집이 있었으면 덮어쓰지 않고 건너뛴다.
 * redo 스택이 비어 있으면 null.
 */
export function redoLastTranslation(
  translations: SessionTranslations
): RedoTranslationResult | null {
  const stack = translations.redoStack;
  if (!stack || stack.length === 0) return null;
  const entry = stack.pop()!;
  translations.redoStack = stack;
  const restored: string[] = [];
  for (const item of entry.items) {
    const para = translations.paragraphs[item.hash];
    if (!para || item.createdVariantIds.length === 0) continue;
    if (para.activeVariantId !== item.prevActiveVariantId) continue;
    const lastVariantId = item.createdVariantIds[item.createdVariantIds.length - 1];
    if (!para.variants[lastVariantId]) continue;
    para.activeVariantId = lastVariantId;
    restored.push(item.hash);
  }
  const undoStack = translations.undoStack ?? [];
  undoStack.push(entry);
  while (undoStack.length > MAX_UNDO_ENTRIES) undoStack.shift();
  translations.undoStack = undoStack;
  return { restoredHashes: restored, remaining: stack.length };
}

/**
 * 다이어트 — active variant 만 남기고 나머지를 삭제한다. 삭제한 수 반환.
 * 명시적 정리 기능 전용. 표시 정책에서 자동 호출하지 않는다.
 */
export function pruneTranslationVariants(
  translations: SessionTranslations,
  hash: string
): number {
  const entry = translations.paragraphs[hash];
  if (!entry) return 0;
  const active = entry.variants[entry.activeVariantId];
  const removed = Object.keys(entry.variants).length - (active ? 1 : 0);
  if (removed <= 0) return 0;
  entry.variants = active ? { [active.id]: active } : {};
  return removed;
}
