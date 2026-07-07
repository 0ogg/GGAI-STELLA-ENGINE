/**
 * 통합 로어북/월드인포 엔트리 스키마.
 *
 * SillyTavern 월드인포가 가장 정보량이 많으므로 그 필드를 기준으로 통일한다.
 * NovelAI/CCv3 입력은 이 형태로 변환해 저장한다.
 *
 * 저장 형태 (R1 부터): `GGAI/LOREBOOKS/[name]/lorebook.json` 단일 파일.
 *   - meta + entries 통째로 직렬화.
 *   - L1 부터 meta.id (UUID) 가 시나리오/세션의 참조 키로 쓰인다.
 *     id 가 없는 레거시 파일은 read 시 자동 생성 후 write-back.
 */

/** 삽입 위치. SillyTavern position 필드의 의미를 따른다. */
export type LorebookPosition =
  | "before_char"       // ST 0
  | "after_char"        // ST 1 (기본값)
  | "before_examples"   // ST 2
  | "after_examples"    // ST 3
  | "at_depth";         // ST 4 — depth 필드와 함께 사용

/** at_depth 위치일 때의 메시지 역할. */
export type LorebookRole = "system" | "user" | "assistant";

/** 보조 키워드 논리. */
export type LorebookSelectiveLogic = 0 /* AND */ | 1 /* NOT */;

/** 원본 임포트 포맷 — 익스포트/디버깅용 추적. */
export type LorebookSource = "sillytavern" | "novelai" | "charactercard";

/**
 * 로어북 엔트리 (통합 스키마).
 * 프론트매터로 직렬화되므로 모든 값은 JSON/YAML 호환이어야 한다.
 */
export interface StellaLorebookEntry {
  // 식별
  uid: string;
  name: string;

  // 키워드
  keys: string[];
  secondaryKeys: string[];
  useRegex: boolean;
  caseSensitive: boolean | null;     // null = 전역 설정 따름
  matchWholeWords: boolean | null;   // null = 전역 설정 따름
  selective: boolean;
  selectiveLogic: LorebookSelectiveLogic;

  // 내용 (본문) — 파일 저장 시 프론트매터가 아닌 md 본문으로 간다
  content: string;

  // 활성화
  enabled: boolean;
  constant: boolean;       // 항상 활성화 (ST constant / NAI forceActivation / CCv3 constant)
  probability: number;     // 0-100
  /** 활성화 후 N턴 동안 키워드 없이 유지. 0=비활성. */
  sticky?: number;
  /** 활성화 후 N턴 동안 재활성화 금지. 0=비활성. */
  cooldown?: number;
  /** 세션 시작 후 N턴 동안 활성화 금지. 0=비활성. */
  delay?: number;

  // 삽입 위치
  position: LorebookPosition;
  depth: number;           // position=at_depth 일 때만 의미
  role: LorebookRole;      // at_depth 시 메시지 역할
  order: number;           // 같은 위치 내 정렬, 큰 값이 우선

  // 스캔
  scanDepth: number | null;

  // 재귀
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;

  // 그룹
  group: string;
  groupWeight: number;

  // 표시
  addMemo: boolean;

  // 출처 추적
  _source: LorebookSource;
}

/** 책(파일) 레벨 메타데이터. `lorebook.json` 의 meta 필드로 저장. */
export interface StellaLorebookMeta {
  /**
   * 책 단위 고유 ID (UUID). 시나리오/세션의 로어북 참조에 쓰인다.
   * 폴더 이름이 바뀌어도 안정적이도록 설계.
   * L1 이전(레거시) 파일은 비어있을 수 있으며, 그 경우 read 시 자동 생성된다.
   */
  id: string;
  name: string;
  description: string;
  /** 임포트 PNG 카드의 썸네일 (NAI .lorebook png / 캐릭터카드 png). 폴더 기준 상대 경로 (보통 "thumbnail.png"). */
  thumbnail?: string | null;
  scanDepth: number | null;
  tokenBudget: number | null;
  recursiveScanning: boolean;
  _source: LorebookSource;
}

export interface StellaLorebook {
  meta: StellaLorebookMeta;
  entries: StellaLorebookEntry[];
}

/**
 * 통합 로어북 메타 기본값 팩토리. 파서가 쓰면 id 가 자동 생성된다.
 * `id` 인자를 명시하면 그걸 사용 (테스트·라운드트립용).
 */
export function defaultLorebookMeta(
  source: LorebookSource,
  name = "",
  id?: string
): StellaLorebookMeta {
  // 외부 의존(uuid util) 회피 — 단순 random hex 16자리.
  // 정식 UUID 가 필요하면 호출부에서 id 인자로 주입.
  const fallbackId =
    id ??
    (typeof crypto !== "undefined" && (crypto as any).randomUUID
      ? (crypto as any).randomUUID()
      : "lb-" + Math.random().toString(16).slice(2, 14));
  return {
    id: fallbackId,
    name,
    description: "",
    thumbnail: null,
    scanDepth: null,
    tokenBudget: null,
    recursiveScanning: false,
    _source: source,
  };
}

/** 엔트리 기본값 팩토리. 파서가 비어있는 필드를 이 값으로 채운다. */
export function defaultLorebookEntry(source: LorebookSource): StellaLorebookEntry {
  return {
    uid: "",
    name: "",
    keys: [],
    secondaryKeys: [],
    useRegex: false,
    caseSensitive: null,
    matchWholeWords: null,
    selective: false,
    selectiveLogic: 0,
    content: "",
    enabled: true,
    constant: false,
    probability: 100,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    position: "after_char",
    depth: 4,
    role: "system",
    order: 100,
    scanDepth: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    group: "",
    groupWeight: 100,
    addMemo: true,
    _source: source,
  };
}
