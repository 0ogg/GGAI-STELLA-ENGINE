import {
  StellaLorebook,
  StellaLorebookEntry,
  defaultLorebookEntry,
} from "../types/lorebook";
import { uuidv4 } from "../util/uuid";

/** SillyTavern position(number) → 통합 enum. */
const POSITION_MAP: Record<number, StellaLorebookEntry["position"]> = {
  0: "before_char",
  1: "after_char",
  2: "before_examples",
  3: "after_examples",
  4: "at_depth",
};

/** SillyTavern role(number) → 통합 enum. */
const ROLE_MAP: Record<number, StellaLorebookEntry["role"]> = {
  0: "system",
  1: "user",
  2: "assistant",
};

/**
 * SillyTavern 월드인포 JSON → 통합 포맷.
 *
 * `entries` 는 배열이 아닌 객체 딕셔너리라는 점을 유의.
 * 누락 필드는 `defaultLorebookEntry` 의 기본값으로 채운다.
 */
export function parseSillyTavernWorldInfo(
  data: any,
  fallbackName: string
): StellaLorebook {
  const entriesDict = (data?.entries ?? {}) as Record<string, any>;
  const entries: StellaLorebookEntry[] = Object.values(entriesDict).map((e) => {
    const base = defaultLorebookEntry("sillytavern");
    return {
      ...base,
      uid: uuidv4(),
      name: typeof e.comment === "string" ? e.comment : "",
      keys: Array.isArray(e.key) ? e.key.map(String) : [],
      secondaryKeys: Array.isArray(e.keysecondary) ? e.keysecondary.map(String) : [],
      content: typeof e.content === "string" ? e.content : "",

      enabled: e.disable !== true,
      constant: !!e.constant,
      probability:
        typeof e.probability === "number"
          ? e.probability
          : base.probability,
      sticky: typeof e.sticky === "number" ? e.sticky : base.sticky,
      cooldown: typeof e.cooldown === "number" ? e.cooldown : base.cooldown,
      delay: typeof e.delay === "number" ? e.delay : base.delay,

      position: POSITION_MAP[typeof e.position === "number" ? e.position : 1] ?? "after_char",
      depth: typeof e.depth === "number" ? e.depth : base.depth,
      role: ROLE_MAP[typeof e.role === "number" ? e.role : 0] ?? "system",
      order: typeof e.order === "number" ? e.order : base.order,

      caseSensitive: typeof e.caseSensitive === "boolean" ? e.caseSensitive : null,
      matchWholeWords: typeof e.matchWholeWords === "boolean" ? e.matchWholeWords : null,
      selective: !!e.selective,
      selectiveLogic: e.selectiveLogic === 1 ? 1 : 0,
      scanDepth: typeof e.scanDepth === "number" ? e.scanDepth : null,

      excludeRecursion: !!e.excludeRecursion,
      preventRecursion: !!e.preventRecursion,
      delayUntilRecursion: !!e.delayUntilRecursion,

      group: typeof e.group === "string" ? e.group : "",
      groupWeight: typeof e.groupWeight === "number" ? e.groupWeight : 100,

      addMemo: e.addMemo !== false,
    };
  });

  return {
    meta: {
      id: uuidv4(),
      name: typeof data?.name === "string" && data.name ? data.name : fallbackName,
      description: "",
      thumbnail: null,
      scanDepth: null,
      tokenBudget: null,
      recursiveScanning: false,
      _source: "sillytavern",
    },
    entries,
  };
}
