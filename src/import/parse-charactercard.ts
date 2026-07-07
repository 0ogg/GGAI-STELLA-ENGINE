import {
  CCv3Lorebook,
  ImportedScenario,
  StellaScenario,
} from "../types/scenario";
import {
  StellaLorebook,
  StellaLorebookEntry,
  defaultLorebookEntry,
} from "../types/lorebook";
import { uuidv4 } from "../util/uuid";

/**
 * 캐릭터카드 JSON (V3 / V2 / V1) → 통합 시나리오.
 *
 * V2/V1 은 V3 형태로 마이그레이션해 저장한다:
 *  - spec: 'chara_card_v3', spec_version: '3.0' 강제
 *  - group_only_greetings 없으면 [] 로 보강
 *  - 알 수 없는 필드는 extensions/그대로 보존
 *
 * character_book 이 있으면 통합 로어북으로도 변환해 같이 반환.
 */
export function parseCharacterCard(data: any): ImportedScenario {
  const spec = data?.spec;
  let src: any;
  if (spec === "chara_card_v3" || spec === "chara_card_v2") {
    src = data.data ?? {};
  } else {
    // V1: 탑레벨 필드를 그대로 사용
    src = data ?? {};
  }

  const now = Math.floor(Date.now() / 1000);

  const scenario: StellaScenario = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: str(src.name),
      description: str(src.description),
      tags: arr(src.tags).map(String),
      creator: str(src.creator),
      character_version: str(src.character_version) || "1.0",
      mes_example: str(src.mes_example),
      extensions: {
        ...(isObj(src.extensions) ? src.extensions : {}),
        stella: {
          id: uuidv4(),
          favorite: false,
          lastPlayedAt: 0,
          playCount: 0,
          thumbnail: null,
        },
      },
      system_prompt: str(src.system_prompt),
      post_history_instructions: str(src.post_history_instructions),
      first_mes: str(src.first_mes),
      alternate_greetings: arr(src.alternate_greetings).map(String),
      personality: str(src.personality),
      scenario: str(src.scenario),

      creator_notes: str(src.creator_notes),
      character_book: isObj(src.character_book) ? (src.character_book as CCv3Lorebook) : undefined,
      assets: Array.isArray(src.assets) ? src.assets : undefined,
      nickname: typeof src.nickname === "string" ? src.nickname : undefined,
      creator_notes_multilingual: isObj(src.creator_notes_multilingual)
        ? src.creator_notes_multilingual
        : undefined,
      source: Array.isArray(src.source) ? src.source.map(String) : undefined,
      group_only_greetings: arr(src.group_only_greetings).map(String),
      creation_date:
        typeof src.creation_date === "number" ? src.creation_date : now,
      modification_date: now,
    },
  };

  const lorebook = scenario.data.character_book
    ? ccv3BookToUnified(scenario.data.character_book, scenario.data.name)
    : undefined;

  return { scenario, lorebook };
}

/** CCv3 character_book → 통합 로어북. */
function ccv3BookToUnified(book: CCv3Lorebook, fallbackName: string): StellaLorebook {
  const entries: StellaLorebookEntry[] = (book.entries ?? []).map((e) => {
    const base = defaultLorebookEntry("charactercard");
    return {
      ...base,
      uid: e.id != null ? String(e.id) : uuidv4(),
      name: e.name ?? e.comment ?? "",
      keys: Array.isArray(e.keys) ? e.keys.map(String) : [],
      secondaryKeys: Array.isArray(e.secondary_keys) ? e.secondary_keys.map(String) : [],
      content: e.content ?? "",

      enabled: e.enabled !== false,
      constant: !!e.constant,

      position: e.position === "before_char" ? "before_char" : "after_char",
      order:
        typeof e.insertion_order === "number"
          ? e.insertion_order
          : typeof e.priority === "number"
          ? e.priority
          : base.order,

      useRegex: !!e.use_regex,
      caseSensitive: typeof e.case_sensitive === "boolean" ? e.case_sensitive : null,
      selective: !!e.selective,
    };
  });

  return {
    meta: {
      id: uuidv4(),
      name: book.name ?? fallbackName,
      description: book.description ?? "",
      thumbnail: null,
      scanDepth: typeof book.scan_depth === "number" ? book.scan_depth : null,
      tokenBudget: typeof book.token_budget === "number" ? book.token_budget : null,
      recursiveScanning: !!book.recursive_scanning,
      _source: "charactercard",
    },
    entries,
  };
}

// --- helpers ---

function str(v: any): string {
  return typeof v === "string" ? v : "";
}
function arr(v: any): any[] {
  return Array.isArray(v) ? v : [];
}
function isObj(v: any): v is Record<string, any> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}
