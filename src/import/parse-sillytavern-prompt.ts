/**
 * SillyTavern Chat Completion Preset → Stella 프롬프트 세트.
 *
 * **프롬프트만 가져온다.** 모델/파라미터/기타 ST 메타(temperature, openai_max_*, wi_format 등)는 무시.
 *
 * ST 의 두 배열(prompts[] + prompt_order[default].order[]) 을 단일 prompts[] 로 펼친다.
 *  - 펼치는 순서 = prompt_order 의 순서. 그 항목의 enabled 가 그대로 적용.
 *  - prompt_order 에 없는 prompts 항목은 끝에 enabled=false 로 보존만.
 *  - default(character_id=100000) 가 없으면 첫 블록 사용.
 *
 * marker 판정: ST 항목의 `marker:true` OR identifier 가 marker 식별자(MARKER_IDENTIFIERS) 인 경우.
 */

import { uuidv4 } from "../util/uuid";
import {
  MARKER_IDENTIFIERS,
  MarkerIdentifier,
  PromptRole,
  StellaPromptItem,
  StellaPromptPreset,
  StellaPromptPresetMeta,
  defaultMarkerName,
  isMarkerIdentifier,
} from "../types/prompt";

interface RawSTPromptPreset {
  chat_completion_source?: string;
  prompts?: any[];
  prompt_order?: { character_id: number; order?: any[] }[];
  [k: string]: any;
}

interface RawSTPrompt {
  identifier?: string;
  name?: string;
  role?: string;
  content?: string;
  marker?: boolean;
  enabled?: boolean;
  stella_wrap?: string;
  stella_history_role?: string;
  injection_position?: number;
  injection_depth?: number;
  injection_order?: number;
  injection_trigger?: string[];
  forbid_overrides?: boolean;
}

/** ST 프리셋 → 통합 단일 배열 모델. */
export function parseSillyTavernPromptPreset(
  raw: unknown,
  fallbackName: string
): StellaPromptPreset {
  const r: RawSTPromptPreset =
    raw && typeof raw === "object" ? (raw as RawSTPromptPreset) : {};

  // 1) ST prompts[] 를 identifier → 항목 맵으로.
  const rawPrompts = Array.isArray(r.prompts) ? (r.prompts as RawSTPrompt[]) : [];
  const byIdent = new Map<string, RawSTPrompt>();
  for (const p of rawPrompts) {
    if (p && typeof p === "object" && typeof p.identifier === "string") {
      byIdent.set(p.identifier, p);
    }
  }

  // 2) prompt_order[default].order[] 순서로 펼친다.
  const orderArr = pickDefaultOrder(r.prompt_order);
  const used = new Set<string>();
  const prompts: StellaPromptItem[] = [];

  for (const o of orderArr) {
    const ident = String(o.identifier ?? "");
    if (!ident || used.has(ident)) continue;
    used.add(ident);
    const src = byIdent.get(ident);
    const enabled = bool(o.enabled, true);
    prompts.push(toItem(ident, src, enabled));
  }

  // 3) prompt_order 에 없는 ST prompts[] 항목은 끝에 disabled 로 보존.
  for (const p of rawPrompts) {
    const ident = String(p?.identifier ?? "");
    if (!ident || used.has(ident)) continue;
    used.add(ident);
    prompts.push(toItem(ident, p, false));
  }

  // 4) 메타 — id / name / favorite 만. ST 의 모델/파라미터/raw 는 전부 버린다.
  const meta: StellaPromptPresetMeta = {
    id: uuidv4(),
    name: fallbackName.trim() || "프롬프트 세트",
    favorite: false,
  };

  return { meta, prompts };
}

// ─── helpers ─────────────────────────────────────────────────────

function pickDefaultOrder(
  raw: unknown
): { identifier?: string; enabled?: boolean }[] {
  if (!Array.isArray(raw)) return [];
  // 현재 ST 는 global 전략 dummyId=100001 블록에 순서를 저장한다.
  // 100000 은 구버전 기본 블록 — 100001 이 있으면 그쪽이 최신. 둘 다 없으면 첫 블록.
  let currentBlock: { character_id?: number; order?: any[] } | undefined;
  let legacyBlock: { character_id?: number; order?: any[] } | undefined;
  let firstBlock: { character_id?: number; order?: any[] } | undefined;
  for (const block of raw as { character_id?: number; order?: any[] }[]) {
    if (!block || typeof block !== "object") continue;
    if (firstBlock === undefined) firstBlock = block;
    if (block.character_id === 100001 && currentBlock === undefined) {
      currentBlock = block;
    }
    if (block.character_id === 100000 && legacyBlock === undefined) {
      legacyBlock = block;
    }
  }
  const block = currentBlock ?? legacyBlock ?? firstBlock;
  return Array.isArray(block?.order) ? (block!.order as any[]) : [];
}

function toItem(
  identifier: string,
  src: RawSTPrompt | undefined,
  enabled: boolean
): StellaPromptItem {
  const explicitMarker = bool(src?.marker, false);
  const marker = explicitMarker || isMarkerIdentifier(identifier);

  if (marker) {
    const id = (isMarkerIdentifier(identifier)
      ? identifier
      : firstMarker(identifier)) as MarkerIdentifier;
    return {
      id: uuidv4(),
      kind: "marker",
      identifier: id,
      name: str(src?.name) || defaultMarkerName(id),
      enabled,
      ...(typeof src?.stella_wrap === "string" ? { wrap: src.stella_wrap } : {}),
      ...(src?.stella_history_role === "user" || src?.stella_history_role === "assistant"
        ? { historyRole: src.stella_history_role }
        : {}),
    };
  }

  return {
    id: uuidv4(),
    kind: "text",
    identifier,
    name: str(src?.name) || identifier,
    role: normalizeRole(src?.role),
    content: str(src?.content),
    enabled,
    injectionPosition: src?.injection_position === 1 ? 1 : 0,
    injectionDepth: typeof src?.injection_depth === "number" ? src.injection_depth : 4,
    injectionOrder: typeof src?.injection_order === "number" ? src.injection_order : 100,
    injectionTrigger: Array.isArray(src?.injection_trigger)
      ? src!.injection_trigger.filter((s) => typeof s === "string")
      : [],
    forbidOverrides: bool(src?.forbid_overrides, false),
  };
}

function firstMarker(_unused: string): MarkerIdentifier {
  // 도달 불가 — explicitMarker 가 true 인데 identifier 가 marker 가 아닌
  // 케이스의 안전한 fallback. enhanceDefinitions 로 떨어뜨려 보존만 한다.
  return MARKER_IDENTIFIERS[MARKER_IDENTIFIERS.length - 1];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function bool(v: unknown, def: boolean): boolean {
  return typeof v === "boolean" ? v : def;
}
function normalizeRole(v: unknown): PromptRole {
  return v === "user" || v === "assistant" ? v : "system";
}
