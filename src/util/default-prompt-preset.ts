/**
 * Default 프롬프트 세트 빌더.
 *
 * SillyTavern 의 Default 프리셋 (사용자 첨부 `Default.json`) 의 prompts + prompt_order
 * 를 박제. 그 이상의 ST 메타 (temperature 등) 는 임포트 정책상 무시.
 *
 * 기본 세트는 **두 개** — "Default" 와 "Default (NovelAI)". 구조(마커 구성·순서)는
 * 완전히 같고, 차이는 **Main Prompt 내용뿐**이다. NovelAI 구분자(`***`/`Write./nothink`)
 * 나 역할 토큰은 세트가 아니라 "NAI 형식으로 보내기" 체크박스(전송 직전 가공,
 * text-completion-prompt.ts) 소관이다.
 *
 * 첫 실행 시 (PROMPTS 폴더에 아무것도 없을 때) 둘 다 자동 생성, 초기 활성은 NovelAI.
 * 새 프롬프트 세트 추가 (`+`) 는 항상 Default 구조를 baseline 으로.
 */

import { parseSillyTavernPromptPreset } from "../import/parse-sillytavern-prompt";
import { StellaPromptPreset } from "../types/prompt";

const DEFAULT_RAW = {
  prompts: [
    {
      name: "Main Prompt",
      system_prompt: true,
      role: "system",
      content:
        "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
      identifier: "main",
    },
    {
      name: "Auxiliary Prompt",
      system_prompt: true,
      role: "system",
      content: "",
      identifier: "nsfw",
    },
    {
      identifier: "dialogueExamples",
      name: "Chat Examples",
      system_prompt: true,
      marker: true,
    },
    {
      name: "Post-History Instructions",
      system_prompt: true,
      role: "system",
      content: "",
      identifier: "jailbreak",
    },
    {
      identifier: "chatHistory",
      name: "Chat History",
      system_prompt: true,
      marker: true,
    },
    // chatSummary 마커는 기본 세트에 넣지 않는다 — 요약은 확장(요약 설정) 소관.
    // 요약 사용 시 작가노트 바로 위에 자동 삽입되고, 사용자가 {{summary}} 매크로나
    // 마커를 직접 배치하면 그 위치를 존중한다.
    {
      identifier: "worldInfoAfter",
      name: "Lorebook (after)",
      system_prompt: true,
      marker: true,
    },
    {
      identifier: "worldInfoBefore",
      name: "Lorebook (before)",
      system_prompt: true,
      marker: true,
    },
    {
      identifier: "enhanceDefinitions",
      role: "system",
      name: "Enhance Definitions",
      content:
        "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
      system_prompt: true,
      marker: false,
    },
    {
      identifier: "charDescription",
      name: "Char Description",
      system_prompt: true,
      marker: true,
    },
    {
      identifier: "charPersonality",
      name: "Char Personality",
      system_prompt: true,
      marker: true,
    },
    {
      identifier: "scenario",
      name: "Scenario",
      system_prompt: true,
      marker: true,
    },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "charDescription", enabled: true },
        { identifier: "charPersonality", enabled: true },
        { identifier: "scenario", enabled: true },
        { identifier: "enhanceDefinitions", enabled: false },
        { identifier: "nsfw", enabled: true },
        { identifier: "worldInfoAfter", enabled: true },
        { identifier: "dialogueExamples", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "jailbreak", enabled: true },
      ],
    },
  ],
};

/** Default 프롬프트 세트 (메모리 객체) 빌드. */
export function buildDefaultPromptPreset(name: string): StellaPromptPreset {
  return parseSillyTavernPromptPreset(DEFAULT_RAW, name);
}

/** ST 호환 raw 형태 그대로 반환 — `writePromptPresetFromImport` 에 넘길 때 사용. */
export function defaultPromptRaw(): any {
  return JSON.parse(JSON.stringify(DEFAULT_RAW));
}

/** 첫 실행 시 자동 생성되는 두 기본 세트의 이름. */
export const DEFAULT_PRESET_NAME = "Default";
export const NOVELAI_PRESET_NAME = "Default (NovelAI)";
/** `+` 로 새 세트를 만들 때의 기본 이름 (구조는 Default 와 동일). */
export const NEW_PRESET_BASE_NAME = "프롬프트 세트";

/**
 * "Default (NovelAI)" — Default 와 마커 구성·순서가 완전히 같고,
 * Main Prompt 내용(NovelAI Xialong 시스템 프롬프트)만 다르다.
 */
const NOVELAI_MAIN_PROMPT =
  "You are Xialong (夏龍), an AI model finetuned by Anlatan. You follow the user's instructions precisely while bringing creativity, nuance, and depth to every response. Adapt your voice and style to match what the task demands.";

/** NovelAI 기본 프롬프트 세트 (메모리 객체) 빌드. */
export function buildNovelAIDefaultPromptPreset(name: string): StellaPromptPreset {
  const raw = defaultPromptRaw();
  const main = raw.prompts.find((p: any) => p.identifier === "main");
  if (main) main.content = NOVELAI_MAIN_PROMPT;
  return parseSillyTavernPromptPreset(raw, name);
}
