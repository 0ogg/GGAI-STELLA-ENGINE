import {
  StellaLorebook,
  StellaLorebookEntry,
  defaultLorebookEntry,
} from "../types/lorebook";
import { uuidv4 } from "../util/uuid";

/**
 * NovelAI lorebook JSON -> Stella's shared lorebook shape.
 *
 * NovelAI's contextConfig is not the same model as SillyTavern position/depth.
 * In modern exports, insertionPosition -1 is the default bottom-of-context
 * placement, not ST at_depth=1. Until Stella supports NAI placement/advanced
 * conditions directly, import those entries with normal lorebook defaults.
 */
export function parseNovelAILorebook(
  data: any,
  fallbackName: string
): StellaLorebook {
  const rawEntries = Array.isArray(data?.entries) ? data.entries : [];
  const entries: StellaLorebookEntry[] = rawEntries.map((e: any) => {
    const base = defaultLorebookEntry("novelai");

    return {
      ...base,
      uid: typeof e.id === "string" && e.id ? e.id : uuidv4(),
      name:
        typeof e.displayName === "string" && e.displayName
          ? e.displayName
          : Array.isArray(e.keys) && e.keys.length > 0
          ? String(e.keys[0])
          : "",
      keys: Array.isArray(e.keys) ? e.keys.map(String) : [],
      content: typeof e.text === "string" ? e.text : "",

      enabled: e.enabled !== false,
      constant: !!e.forceActivation,

      position: base.position,
      depth: base.depth,
      role: base.role,
      order: base.order,

      scanDepth: typeof e.searchRange === "number" ? e.searchRange : null,
      group: "",

      addMemo: false,
    };
  });

  return {
    meta: {
      id: uuidv4(),
      name: fallbackName,
      description: "",
      thumbnail: null,
      scanDepth: null,
      tokenBudget: null,
      recursiveScanning: false,
      _source: "novelai",
    },
    entries,
  };
}
