/**
 * 프롬프트 세트 스키마.
 *
 * 핵심: `prompts[]` 단일 배열의 순서 = 컨텍스트 조립 순서.
 * 사이드바에서 드래그로 직접 조작한다.
 *
 * 저장 형태: `GGAI/PROMPTS/[세트명]/preset.json` 단일 JSON 파일.
 *
 * **이 파일에는 프롬프트만 들어간다.** 모델/파라미터 같은 SillyTavern 의 부가 메타는
 * 임포트 시 버린다. 활성 모델/파라미터는 PRESETS/<이름>.json 또는 세션 메타가 보유.
 *
 * ST 호환 깊은 메타(injectionPosition / injectionDepth / injectionOrder /
 * injectionTrigger / forbidOverrides) 는 prompt 항목 단위로 보존 — 컨텍스트 빌더가 사용.
 */

export type PromptRole = "system" | "user" | "assistant";

/** 핵심 플레이스홀더(marker) 식별자. 일반 text 항목의 identifier 는 자유 string. */
export type MarkerIdentifier =
  | "chatHistory"
  | "worldInfoBefore"
  | "worldInfoAfter"
  | "charDescription"
  | "charPersonality"
  | "scenario"
  | "dialogueExamples"
  | "memory"
  | "authorNote"
  | "chatSummary"
  | "enhanceDefinitions";

export const MARKER_IDENTIFIERS: readonly MarkerIdentifier[] = [
  "chatHistory",
  "worldInfoBefore",
  "worldInfoAfter",
  "charDescription",
  "charPersonality",
  "scenario",
  "dialogueExamples",
  "memory",
  "authorNote",
  "chatSummary",
  "enhanceDefinitions",
];

const MARKER_SET: ReadonlySet<string> = new Set(MARKER_IDENTIFIERS);

export function isMarkerIdentifier(s: string): s is MarkerIdentifier {
  return MARKER_SET.has(s);
}

/** 일반 텍스트 항목. content 는 매크로 포함 가능. */
export interface StellaPromptTextItem {
  id: string;            // uuid v4 — 라운드트립 고유 식별자
  kind: "text";
  identifier: string;    // ST 호환 (main/nsfw/jailbreak 등) 또는 uuid
  name: string;
  role: PromptRole;
  content: string;
  enabled: boolean;
  // ST 호환 깊은 메타 — 데이터 보존만, 사이드바 편집기는 미노출
  injectionPosition?: 0 | 1;        // 0=relative(기본), 1=absolute(in chatHistory)
  injectionDepth?: number;
  injectionOrder?: number;
  injectionTrigger?: string[];      // ["normal"|"continue"|"impersonate"|...]
  forbidOverrides?: boolean;
}

/** 플레이스홀더 항목. 자기 자리 = 컨텍스트 안에서 본문/시나리오/로어북 등으로 치환됨. */
export interface StellaPromptMarkerItem {
  id: string;
  kind: "marker";
  identifier: MarkerIdentifier;
  name: string;
  enabled: boolean;
  /**
   * 본문 가공 템플릿. undefined = 가공 안 함(기본).
   * 문자열이면 이 마커의 "해당 매크로"(MARKER_MACRO, 예: charDescription→`{{description}}`)
   * 자리에 마커 내용이 들어간다 (앞뒤 가공). 매크로가 없으면 내용을 맨 뒤에 붙인다.
   * 앞뒤 줄바꿈은 자동으로 넣지 않는다.
   */
  wrap?: string;
  /**
   * chatHistory 마커 전용 — **소설모드에서만** 본문 전체를 어느 롤로 보낼지.
   * undefined | "assistant" = 지금까지 동작(본문을 어시스턴트 발화로 합쳐 전송).
   * "user" = 본문을 유저 발화로 전송(모델이 자기 이전 문장을 흉내내 반복하는 걸
   * 줄이려는 용도). 챗 모드는 각 메시지가 제 롤대로 나가므로 이 값과 무관.
   */
  historyRole?: "user" | "assistant";
}

export type StellaPromptItem = StellaPromptTextItem | StellaPromptMarkerItem;

export interface PromptPresetParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  maxContext?: number;
  maxOutputTokens?: number;
}

export interface StellaPromptPresetMeta {
  id: string;             // 프롬프트 세트 고유 uuid
  name: string;
  favorite: boolean;
}

export interface PromptChoiceOption {
  id: string;
  label: string;
  value: string;
  weight?: number;
}

export interface PromptChoiceBlock {
  id: string;
  name: string;
  multiSelect: boolean;
  random: boolean;
  options: PromptChoiceOption[];
}

export interface StellaPromptPreset {
  meta: StellaPromptPresetMeta;
  /** 순서 = 컨텍스트 조립 순서. */
  prompts: StellaPromptItem[];
  /** 프롬프트 안에서 {{choice:name}} 으로 참조하는 선택 변수. */
  choices?: PromptChoiceBlock[];
}

// ─── 기본값/생성 헬퍼 ───────────────────────────────────────────────

export function defaultParams(): PromptPresetParams {
  return {};
}

/**
 * 마커별 "해당 매크로" — 본문 가공 입력란에 기본으로 채워지는 매크로.
 * 이 자리에 마커 내용이 들어간다. enhanceDefinitions 는 내용이 없어 가공 대상 아님.
 */
export const MARKER_MACRO: Record<MarkerIdentifier, string> = {
  chatHistory: "{{history}}",
  worldInfoBefore: "{{loreBefore}}",
  worldInfoAfter: "{{loreAfter}}",
  charDescription: "{{description}}",
  charPersonality: "{{personality}}",
  scenario: "{{scenario}}",
  dialogueExamples: "{{mesExamples}}",
  memory: "{{memory}}",
  authorNote: "{{authorNote}}",
  chatSummary: "{{summary}}",
  enhanceDefinitions: "",
};

/**
 * 마커 매크로로 인식할 토큰명(소문자, 별칭 포함). 본문 가공에서 이 토큰을 마커 내용으로
 * 치환하고, 토큰이 없으면 내용을 맨 뒤에 붙일지 판단하는 데 쓴다.
 */
export const MARKER_MACRO_TOKENS: Record<MarkerIdentifier, string[]> = {
  chatHistory: ["history"],
  worldInfoBefore: ["lorebefore", "wibefore"],
  worldInfoAfter: ["loreafter", "wiafter"],
  charDescription: ["description"],
  charPersonality: ["personality"],
  scenario: ["scenario"],
  dialogueExamples: ["mesexamples", "mesexamplesraw", "example_dialogue"],
  memory: ["memory"],
  authorNote: ["authornote", "anote"],
  chatSummary: ["summary"],
  enhanceDefinitions: [],
};

/** marker identifier 의 사람이 읽기 좋은 기본 이름. */
export function defaultMarkerName(id: MarkerIdentifier): string {
  switch (id) {
    case "chatHistory":
      return "Chat History";
    case "worldInfoBefore":
      return "Lorebook (before)";
    case "worldInfoAfter":
      return "Lorebook (after)";
    case "charDescription":
      return "Character Description";
    case "charPersonality":
      return "Character Personality";
    case "scenario":
      return "Scenario";
    case "dialogueExamples":
      return "Dialogue Examples";
    case "memory":
      return "Memory";
    case "authorNote":
      return "Author's Note";
    case "chatSummary":
      return "Chat Summary";
    case "enhanceDefinitions":
      return "Enhance Definitions";
  }
}
