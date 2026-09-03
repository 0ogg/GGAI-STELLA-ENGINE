/**
 * 임포트 포맷 자동 분류.
 * JSON 구조의 키 시그니처만으로 판별한다 (파일명은 보조일 뿐).
 */
export type ImportFormat =
  | "sillytavern-worldinfo"
  | "sillytavern-prompt-preset"
  | "sillytavern-quick-reply"
  | "sillytavern-regex"
  | "sillytavern-persona-backup"
  | "novelai-lorebook"
  | "novelai-scenario"
  | "novelai-story"
  | "charx"
  | "charactercard-v3"
  | "charactercard-v2"
  | "charactercard-v1"
  | "unknown";

/**
 * 파싱된 JSON 을 분류한다.
 *
 *  - CCv3:           `spec === 'chara_card_v3'`
 *  - V2:             `spec === 'chara_card_v2'`
 *  - V1:             spec 없음 + name/description/first_mes 가 탑레벨에 있음
 *  - NAI 로어북:     `lorebookVersion` 이 숫자 + `entries` 가 배열
 *  - ST 월드인포:    `entries` 가 객체(딕셔너리)
 *  - ST 프롬프트 프리셋:
 *      `prompts` 배열 + `prompt_order` 배열 (양쪽 다 필수).
 *      `chat_completion_source` 는 일부 프리셋에만 있어 옵셔널로 둔다.
 *      이 두 키 조합은 캐릭터카드/로어북/월드인포 어느 것과도 겹치지 않는다.
 *  - ST 정규식:      `findRegex` 문자열 (파일 하나 = 스크립트 하나)
 */
export function detectFormat(data: unknown): ImportFormat {
  if (!data || typeof data !== "object") return "unknown";
  const d = data as Record<string, any>;

  if (d.spec === "chara_card_v3") return "charactercard-v3";
  if (d.spec === "chara_card_v2") return "charactercard-v2";

  // NAI 시나리오 (.scenario): scenarioVersion 숫자 + prompt 문자열.
  // lorebook 은 객체로 중첩되어 있어 NAI 로어북 단독 시그니처와 겹치지 않는다.
  if (typeof d.scenarioVersion === "number" && typeof d.prompt === "string") {
    return "novelai-scenario";
  }

  // NAI 스토리 (.story): storyContainerVersion 숫자 + metadata/content 객체.
  if (
    typeof d.storyContainerVersion === "number" &&
    d.metadata &&
    typeof d.metadata === "object" &&
    d.content &&
    typeof d.content === "object"
  ) {
    return "novelai-story";
  }

  if (typeof d.lorebookVersion === "number" && Array.isArray(d.entries)) {
    return "novelai-lorebook";
  }

  // ST 프롬프트 프리셋 — prompts[] + prompt_order[] 가 동시에 있으면 충분.
  if (Array.isArray(d.prompts) && Array.isArray(d.prompt_order)) {
    return "sillytavern-prompt-preset";
  }

  // ST 빠른 답장(QR) 세트 — qrList[] 는 다른 어느 포맷과도 겹치지 않는다.
  if (Array.isArray(d.qrList)) {
    return "sillytavern-quick-reply";
  }

  // 버튼 **1개짜리** QR 파일 — ST 는 버튼 하나만 내보내면 세트 껍데기 없이
  // 버튼 객체를 통째로 저장한다(예: `🏭 서사공장.qr.json`). message + contextList
  // 조합은 다른 포맷에 없으므로 이것으로 판별하고, 임포트에서 세트 1개로 감싼다.
  if (typeof d.message === "string" && Array.isArray(d.contextList)) {
    return "sillytavern-quick-reply";
  }

  // ST 정규식 스크립트 — 파일 하나 = 스크립트 하나(ST 가 그렇게 내보낸다).
  // `findRegex` 는 다른 어느 포맷에도 없는 키다.
  if (typeof d.findRegex === "string") {
    return "sillytavern-regex";
  }

  // ST 페르소나 백업(personas.js onBackupPersonas) — personas + persona_descriptions
  // 두 객체(딕셔너리, 배열 아님) 조합은 다른 어느 포맷과도 겹치지 않는다.
  if (
    d.personas &&
    typeof d.personas === "object" &&
    !Array.isArray(d.personas) &&
    d.persona_descriptions &&
    typeof d.persona_descriptions === "object" &&
    !Array.isArray(d.persona_descriptions)
  ) {
    return "sillytavern-persona-backup";
  }

  if (d.entries && typeof d.entries === "object" && !Array.isArray(d.entries)) {
    return "sillytavern-worldinfo";
  }

  // V1 캐릭터카드: spec 없음, 하지만 카드 모양
  if (
    typeof d.name === "string" &&
    typeof d.description === "string" &&
    typeof d.first_mes === "string"
  ) {
    return "charactercard-v1";
  }

  return "unknown";
}
