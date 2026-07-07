import { ImportedScenario, StellaScenario } from "../types/scenario";
import { uuidv4 } from "./uuid";

/**
 * 빈 CCv3 시나리오 템플릿.
 * 사이드바의 "추가" 버튼이 호출한다.
 * 세부 필드는 실제 사용감 테스트 후 조정 예정 (CLAUDE.md 참조).
 */
export function createBlankScenario(name: string): ImportedScenario {
  const now = Math.floor(Date.now() / 1000);
  const scenario: StellaScenario = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name,
      description: "",
      tags: [],
      creator: "",
      character_version: "1.0",
      mes_example: "",
      extensions: {
        stella: {
          id: uuidv4(),
          favorite: false,
          lastPlayedAt: 0,
          playCount: 0,
          thumbnail: null,
        },
      },
      system_prompt: "",
      post_history_instructions: "",
      first_mes: "",
      alternate_greetings: [],
      personality: "",
      scenario: "",
      creator_notes: "",
      group_only_greetings: [],
      creation_date: now,
      modification_date: now,
    },
  };
  return { scenario };
}
