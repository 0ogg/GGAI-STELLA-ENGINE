/**
 * 삽화 variant 순수 헬퍼 — illustrations.json (노드 기준) 조작.
 *
 * 번역(translate-paragraphs)과 같은 규칙: variant 를 쌓고 activeVariantId 만 이동한다.
 * 원문 노드는 불변. 자동 삭제 없음(정리는 명시적 다이어트에서만).
 */

import type {
  IllustrationVariant,
  IllustrationVariantKind,
  SessionIllustrations,
} from "../types/media";
import type { IllustrationOutputPosition } from "../types/preset";
import { uuidv4 } from "./uuid";

/**
 * 저장된 출력 위치를 정규화한다.
 *  - "inline" / 레거시 "source-inline" / "translation-inline"(구 원문·번역 인라인
 *    분리) → "inline"
 *  - 그 외(생략/미지정/레거시 "top"=구 상단 고정/"panel") → "panel"(삽화 출력 전용 뷰)
 */
export function resolveIllustrationOutput(
  output: string | undefined | null
): IllustrationOutputPosition {
  return output === "inline" ||
    output === "source-inline" ||
    output === "translation-inline"
    ? "inline"
    : "panel";
}

/** 노드의 현재 active 삽화 variant (없으면 null). */
export function getActiveIllustration(
  illustrations: SessionIllustrations,
  nodeId: string
): IllustrationVariant | null {
  const entry = illustrations.nodes[nodeId];
  if (!entry) return null;
  return entry.variants[entry.activeVariantId] ?? null;
}

/** 노드의 삽화 variant 목록 (생성 순). */
export function listIllustrationVariants(
  illustrations: SessionIllustrations,
  nodeId: string
): IllustrationVariant[] {
  const entry = illustrations.nodes[nodeId];
  if (!entry) return [];
  return Object.values(entry.variants).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 세션에서 가장 최근 삽화 variant (없으면 null).
 * 각 노드의 active variant 중 createdAt 이 가장 큰 것 — 로비 카드 썸네일용.
 */
export function latestIllustrationVariant(
  illustrations: SessionIllustrations
): IllustrationVariant | null {
  let latest: IllustrationVariant | null = null;
  for (const nodeId of Object.keys(illustrations.nodes)) {
    const active = getActiveIllustration(illustrations, nodeId);
    if (active && (!latest || active.createdAt > latest.createdAt)) {
      latest = active;
    }
  }
  return latest;
}

export interface RecordIllustrationInput {
  nodeId: string;
  /** 세션 폴더 기준 상대 경로 (assets/...). */
  path: string;
  assetId?: string;
  imageProfileId?: string;
  promptId?: string;
  /** 실제 사용한 최종 프롬프트 / UC (표시 + 프롬프트 유지 재생성용). */
  prompt?: string;
  negativePrompt?: string;
  kind?: IllustrationVariantKind;
}

/**
 * 노드에서 삽화 variant 하나를 삭제. active 였으면 가장 최근 다른 variant 로 이동하고,
 * 마지막 variant 였으면 노드 엔트리 자체를 제거한다. 삭제한 variant(asset 경로 포함) 반환.
 */
export function removeIllustrationVariant(
  illustrations: SessionIllustrations,
  nodeId: string,
  variantId: string
): IllustrationVariant | null {
  const entry = illustrations.nodes[nodeId];
  const removed = entry?.variants[variantId];
  if (!entry || !removed) return null;
  delete entry.variants[variantId];
  const remaining = Object.values(entry.variants).sort(
    (a, b) => a.createdAt - b.createdAt
  );
  if (remaining.length === 0) {
    delete illustrations.nodes[nodeId];
  } else if (entry.activeVariantId === variantId) {
    entry.activeVariantId = remaining[remaining.length - 1].id;
  }
  return removed;
}

/** 삽화 variant 즐겨찾기 토글 (갤러리 분류/필터용). 토글 후 값 반환, 없으면 false. */
export function toggleIllustrationFavorite(
  illustrations: SessionIllustrations,
  nodeId: string,
  variantId: string
): boolean {
  const v = illustrations.nodes[nodeId]?.variants[variantId];
  if (!v) return false;
  v.favorite = !v.favorite;
  v.updatedAt = Date.now();
  return v.favorite;
}

/** 노드의 active 삽화를 다른 variant 로 이동 (변형 슬라이드 선택). 성공 시 true. */
export function setActiveIllustrationVariant(
  illustrations: SessionIllustrations,
  nodeId: string,
  variantId: string
): boolean {
  const entry = illustrations.nodes[nodeId];
  if (!entry || !entry.variants[variantId]) return false;
  entry.activeVariantId = variantId;
  return true;
}

/**
 * 새 삽화 variant 를 노드에 쌓고 active 로 선택. illustrations 를 직접 변경한다.
 * 반환: 생성된 variant id.
 */
export function recordIllustrationVariant(
  illustrations: SessionIllustrations,
  input: RecordIllustrationInput
): string {
  const now = Date.now();
  const id = uuidv4();
  const variant: IllustrationVariant = {
    id,
    kind: input.kind ?? "ai-illustration",
    sourceNodeId: input.nodeId,
    imageProfileId: input.imageProfileId,
    promptId: input.promptId,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    assetId: input.assetId,
    path: input.path,
    createdAt: now,
    updatedAt: now,
  };
  const entry = illustrations.nodes[input.nodeId] ?? {
    activeVariantId: id,
    variants: {},
  };
  entry.variants[id] = variant;
  entry.activeVariantId = id;
  illustrations.nodes[input.nodeId] = entry;
  return id;
}
