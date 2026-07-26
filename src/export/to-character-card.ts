/**
 * 시나리오 → 캐릭터카드 익스포트 (CCv3 + V2 호환본).
 *
 * 공유용이므로 스텔라 전용 메타(`data.extensions.stella` — 플레이 횟수/즐겨찾기/로어북
 * 참조 id 등)는 제거한다. 받는 쪽 vault 에는 없는 id 라 남겨봐야 쓰레기 값이다.
 * 시나리오별 정규식(`data.extensions.regex_scripts`)은 ST 와 같은 위치라 그대로 둔다.
 *
 * 연결된 로어북은 `character_book` 으로 카드 안에 넣는다 — 받는 사람이 카드 하나만
 * 넣어도 로어북이 딸려간다. ST 는 character_book 을 월드인포로 되돌릴 때
 * `entry.extensions` 의 ST 필드를 읽으므로, 위치/깊이/재귀 같은 정보는 거기 담는다.
 *
 * 순수 함수 — vault 접근 없음.
 */

import type { StellaLorebook, StellaLorebookEntry } from "../types/lorebook";
import type {
  CCv3Lorebook,
  CCv3LorebookEntry,
  StellaScenario,
} from "../types/scenario";

/** PNG 카드는 이미지 자체가 아이콘이라 CCv3 규약대로 `ccdefault:` 를 쓴다. */
const CCDEFAULT_ICON = {
  type: "icon",
  uri: "ccdefault:",
  name: "main",
  ext: "png",
};

const POSITION_NUM: Record<StellaLorebookEntry["position"], number> = {
  before_char: 0,
  after_char: 1,
  before_examples: 2,
  after_examples: 3,
  at_depth: 4,
};

const ROLE_NUM: Record<StellaLorebookEntry["role"], number> = {
  system: 0,
  user: 1,
  assistant: 2,
};

/** 통합 로어북 여러 권 → CCv3 character_book 한 권 (카드에는 한 권만 들어간다). */
export function lorebooksToCharacterBook(
  books: StellaLorebook[],
  fallbackName: string
): CCv3Lorebook | undefined {
  const merged: StellaLorebookEntry[] = [];
  const seen = new Set<string>();
  for (const book of books) {
    for (const entry of book.entries) {
      if (entry.uid && seen.has(entry.uid)) continue;
      if (entry.uid) seen.add(entry.uid);
      merged.push(entry);
    }
  }
  if (merged.length === 0) return undefined;

  const first = books.find((b) => b.entries.length > 0) ?? books[0];
  const entries: CCv3LorebookEntry[] = merged.map((entry, i) => ({
    keys: [...entry.keys],
    content: entry.content,
    extensions: {
      // ST 가 월드인포로 되돌릴 때 읽는 필드들 (convertCharacterBook 대응).
      position: POSITION_NUM[entry.position] ?? 1,
      depth: entry.depth,
      role: ROLE_NUM[entry.role] ?? 0,
      probability: entry.probability,
      useProbability: true,
      selectiveLogic: entry.selectiveLogic,
      exclude_recursion: entry.excludeRecursion,
      prevent_recursion: entry.preventRecursion,
      delay_until_recursion: entry.delayUntilRecursion,
      scan_depth: entry.scanDepth,
      case_sensitive: entry.caseSensitive,
      match_whole_words: entry.matchWholeWords,
      use_group_scoring: null,
      group: entry.group,
      group_override: false,
      group_weight: entry.groupWeight,
      sticky: entry.sticky ?? 0,
      cooldown: entry.cooldown ?? 0,
      delay: entry.delay ?? 0,
      automation_id: "",
      vectorized: false,
      display_index: i,
    },
    enabled: entry.enabled,
    insertion_order: entry.order,
    case_sensitive: entry.caseSensitive ?? undefined,
    use_regex: entry.useRegex,
    constant: entry.constant,
    name: entry.name,
    comment: entry.name,
    selective: entry.selective,
    secondary_keys: [...entry.secondaryKeys],
    position: entry.position === "before_char" ? "before_char" : "after_char",
  }));

  return {
    name: first?.meta.name || fallbackName,
    description: first?.meta.description ?? "",
    scan_depth: first?.meta.scanDepth ?? undefined,
    token_budget: first?.meta.tokenBudget ?? undefined,
    recursive_scanning: first?.meta.recursiveScanning ?? false,
    extensions: {},
    entries,
  };
}

export interface CharacterCardExport {
  /** CCv3 카드 (JSON 익스포트 본문 / PNG `ccv3` 청크). */
  v3: Record<string, any>;
  /** V2 카드 (PNG `chara` 청크 — CCv3 를 모르는 구형 툴 폴백). */
  v2: Record<string, any>;
}

/**
 * 시나리오 + 연결 로어북 → 익스포트용 카드 객체 두 벌.
 *
 * @param forPng PNG 카드로 내보내는가. true 면 아이콘 애셋을 `ccdefault:` 로 바꾸고,
 *               false 면 받는 쪽에 없는 로컬 파일 참조 애셋을 아예 뺀다.
 */
export function buildCharacterCardExport(
  scenario: StellaScenario,
  books: StellaLorebook[],
  forPng: boolean
): CharacterCardExport {
  const src = scenario.data ?? ({} as StellaScenario["data"]);

  const extensions: Record<string, any> = { ...(src.extensions ?? {}) };
  delete extensions.stella;

  const characterBook =
    lorebooksToCharacterBook(books, src.name || "lorebook") ?? src.character_book;

  const assets = forPng
    ? [CCDEFAULT_ICON]
    : (src.assets ?? []).filter(
        (a) => typeof a?.uri === "string" && /^(https?:|ccdefault:|embeded:)/.test(a.uri)
      );

  const v3: Record<string, any> = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: src.name ?? "",
      description: src.description ?? "",
      personality: src.personality ?? "",
      scenario: src.scenario ?? "",
      first_mes: src.first_mes ?? "",
      mes_example: src.mes_example ?? "",
      creator_notes: src.creator_notes ?? "",
      system_prompt: src.system_prompt ?? "",
      post_history_instructions: src.post_history_instructions ?? "",
      alternate_greetings: [...(src.alternate_greetings ?? [])],
      tags: [...(src.tags ?? [])],
      creator: src.creator ?? "",
      character_version: src.character_version ?? "",
      extensions,
      group_only_greetings: [...(src.group_only_greetings ?? [])],
      creation_date: src.creation_date ?? Math.floor(Date.now() / 1000),
      modification_date: Math.floor(Date.now() / 1000),
    },
  };
  if (characterBook) v3.data.character_book = characterBook;
  if (assets.length > 0) v3.data.assets = assets;
  if (src.nickname) v3.data.nickname = src.nickname;
  if (src.creator_notes_multilingual) {
    v3.data.creator_notes_multilingual = src.creator_notes_multilingual;
  }
  if (src.source) v3.data.source = [...src.source];

  // V2 = V3 에서 V3 전용 필드를 뺀 것. 구형 툴이 읽는 `chara` 청크용.
  const v2Data: Record<string, any> = { ...v3.data };
  delete v2Data.assets;
  delete v2Data.nickname;
  delete v2Data.creator_notes_multilingual;
  delete v2Data.source;
  delete v2Data.group_only_greetings;
  delete v2Data.creation_date;
  delete v2Data.modification_date;

  const v2: Record<string, any> = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: v2Data,
    // V2 이전 툴은 탑레벨 필드만 읽는다.
    name: v2Data.name,
    description: v2Data.description,
    personality: v2Data.personality,
    scenario: v2Data.scenario,
    first_mes: v2Data.first_mes,
    mes_example: v2Data.mes_example,
  };

  return { v3, v2 };
}
