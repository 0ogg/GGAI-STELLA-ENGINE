/**
 * 세션 미디어 스키마 — 미디어 확장 스펙 기준 (2026-06-13 문단 기준 개편).
 *
 * 세션 폴더에 파일을 분리해 저장한다:
 *  - `translations.json` — 번역. **문단 + 원문 내용(해시) 기준** 번역 메모리.
 *    원문 문단이 한 글자라도 바뀌면 키가 바뀌어 "번역 안 됨"이 되고, 같은 내용의
 *    문단은 분기를 넘나들어도 번역을 재사용한다.
 *  - `illustrations.json` — 삽화. **노드 기준** ("그때 그 생성 사건"의 장면 그림이라
 *    원문 워딩을 다듬어도 유효). 인라인 표시 위치는 렌더 시점에 노드 귀속 세그먼트로 계산.
 *
 * 공통: variant 를 쌓고 activeVariantId 만 이동. 자동 삭제 금지(정리는 명시적 다이어트).
 * `session.json` 원문 노드는 불변.
 */

export type TranslationVariantKind =
  | "ai-translation"
  | "translation-regen"
  | "user-edit"
  /** 집필 프로 — 저자가 직접 쓴 한국어 원고 (한→영 변환의 원문, 왕복 번역 아님). */
  | "authored";

export interface TranslationVariant {
  id: string;
  kind: TranslationVariantKind;
  /** 소속 문단 키 (원문 내용 해시) — 엔트리 키와 동일. */
  sourceHash: string;
  /** 번역문 — 내부 문단 구조(대사/서술 줄바꿈 등)는 자유. */
  text: string;
  modelProfileId?: string;
  promptId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TranslationEntry {
  /** 원문 문단 전문 — 외부 도구가 해시 계산 없이 대조할 수 있게 보존. */
  source: string;
  activeVariantId: string;
  variants: Record<string, TranslationVariant>;
}

/** 한 번역 실행이 문단 하나에 남긴 되돌리기 정보. */
export interface TranslationUndoItem {
  /** 되돌릴 문단 키 (원문 해시). */
  hash: string;
  /** 이 실행이 새로 만든 variant id 들 (되돌리며 삭제 대상). */
  createdVariantIds: string[];
  /** 실행 직전 active variant id ("" = 그때 번역 없었음). */
  prevActiveVariantId: string;
}

/**
 * "방금 한 번역" 한 건 = 되돌리기 스택 한 항목. 실행(일괄/자동/문단 재번역)마다 하나씩
 * 쌓이고, 되돌리기 버튼이 한 단계씩 pop 한다. 되돌리면 그 실행이 만든 variant 를
 * 지우고 이전 상태(이전 번역 / 번역 안 됨)로 복원한다.
 */
export interface TranslationUndoEntry {
  id: string;
  at: number;
  items: TranslationUndoItem[];
}

/** 세션 폴더 `translations.json`. */
export interface SessionTranslations {
  schemaVersion: 1;
  /** 세션창 표시 상태 — 원문 보기 / 번역 보기. 세션별 유지. */
  displayMode?: "source" | "translation";
  /** key = hashText(문단 원문). 같은 내용 문단은 번역을 공유한다. */
  paragraphs: Record<string, TranslationEntry>;
  /** 번역 실행 되돌리기 스택 (오래된 것 → 최근 것). 없으면 되돌릴 것 없음. */
  undoStack?: TranslationUndoEntry[];
  /** 되돌린 실행을 다시 적용하는 스택 (오래된 것 → 최근 것). 새 실행이 생기면 비워진다. */
  redoStack?: TranslationUndoEntry[];
}

export function createEmptySessionTranslations(): SessionTranslations {
  return { schemaVersion: 1, paragraphs: {} };
}

export function normalizeSessionTranslations(raw: unknown): SessionTranslations {
  const empty = createEmptySessionTranslations();
  if (!raw || typeof raw !== "object") return empty;
  const obj = raw as Partial<SessionTranslations>;
  return {
    schemaVersion: 1,
    displayMode:
      obj.displayMode === "translation" || obj.displayMode === "source"
        ? obj.displayMode
        : undefined,
    paragraphs:
      obj.paragraphs && typeof obj.paragraphs === "object"
        ? obj.paragraphs
        : {},
    undoStack: Array.isArray(obj.undoStack) ? obj.undoStack : undefined,
    redoStack: Array.isArray(obj.redoStack) ? obj.redoStack : undefined,
  };
}

// ─────────────────────────── 삽화 (노드 기준 — 구현은 다음 라운드) ───────────────────────────

export type IllustrationVariantKind =
  | "ai-illustration"
  | "illustration-regen"
  | "user-edit";

export interface IllustrationVariant {
  id: string;
  kind: IllustrationVariantKind;
  /** 이 삽화가 종속된 원문 노드 id. */
  sourceNodeId: string;
  imageProfileId?: string;
  promptId?: string;
  /** 실제 이미지 생성에 쓴 최종 프롬프트(메인 합성 포함) — 표시 + 프롬프트 유지 재생성용. */
  prompt?: string;
  /** 실제 이미지 생성에 쓴 네거티브(UC). */
  negativePrompt?: string;
  assetId?: string;
  /** 세션 폴더 기준 상대 경로 (assets/...). */
  path: string;
  createdAt: number;
  updatedAt: number;
  /** 즐겨찾기 — 갤러리 분류/필터용. */
  favorite?: boolean;
}

export interface IllustrationEntry {
  activeVariantId: string;
  variants: Record<string, IllustrationVariant>;
}

/** 세션 폴더 `illustrations.json`. */
export interface SessionIllustrations {
  schemaVersion: 1;
  /** key = 원문 노드 id. */
  nodes: Record<string, IllustrationEntry>;
}

export function createEmptySessionIllustrations(): SessionIllustrations {
  return { schemaVersion: 1, nodes: {} };
}

export function normalizeSessionIllustrations(raw: unknown): SessionIllustrations {
  const empty = createEmptySessionIllustrations();
  if (!raw || typeof raw !== "object") return empty;
  const obj = raw as Partial<SessionIllustrations>;
  return {
    schemaVersion: 1,
    nodes: obj.nodes && typeof obj.nodes === "object" ? obj.nodes : {},
  };
}
