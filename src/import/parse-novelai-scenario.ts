import { ImportedScenario, StellaScenario } from "../types/scenario";
import { StellaLorebook } from "../types/lorebook";
import { parseNovelAILorebook } from "./parse-novelai";
import { uuidv4 } from "../util/uuid";

/**
 * NovelAI `.scenario` JSON → 통합 시나리오(+파생 로어북).
 *
 * NAI 시나리오 한 파일에는 본문(prompt), 로어북(lorebook), 컨텍스트(메모리/작가노트),
 * 생성 설정(settings)이 모두 담겨 있다. 매핑:
 *   - title        → 시나리오 이름
 *   - prompt       → first_mes (세션 첫 본문으로 깔림)
 *   - description  → creator_notes (파일 메타이지 캐릭터 설명이 아님)
 *   - context[0]   → NAI Memory → scenario.data.scenario ({{scenario}} 로 항상 포함)
 *   - lorebook     → 통합 로어북 (parseNovelAILorebook 재사용)
 *
 * NAI 고유 데이터(settings/parameters/model/context/attg/storyContextConfig 등)는
 * 손실 없이 `extensions.novelai` 에 원본 그대로 보존한다. 모델/파라미터는 NAI 전용이라
 * 활성 설정으로 강제하지 않는다 (ST 프리셋 임포트와 같은 정책).
 */
export function parseNovelAIScenario(data: any): ImportedScenario {
  const now = Math.floor(Date.now() / 1000);
  const src = data ?? {};

  const name = str(src.title) || "NAI 시나리오";

  // NAI context: [0] = Memory, [1] = Author's Note (관례). 비어있으면 무시.
  const ctx = Array.isArray(src.context) ? src.context : [];
  const memory = str(ctx[0]?.text).trim();

  // 이미 first_mes / 로어북으로 매핑된 큰 필드는 중복 저장하지 않는다.
  // 나머지 NAI 고유 설정(settings/context/attg 등)만 손실 없이 보존.
  const { prompt: _p, lorebook: _l, ...novelaiRest } = src;

  const scenario: StellaScenario = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name,
      description: "",
      tags: arr(src.tags).map(String),
      creator: str(src.author),
      character_version: "1.0",
      mes_example: "",
      extensions: {
        // NAI 고유 설정 보존 (활성 동작에는 쓰지 않음).
        novelai: novelaiRest,
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
      first_mes: str(src.prompt),
      alternate_greetings: [],
      personality: "",
      scenario: memory,
      creator_notes: str(src.description),
      group_only_greetings: [],
      creation_date: now,
      modification_date: now,
    },
  };

  const lorebook = parseScenarioLorebook(src.lorebook, name);

  return { scenario, lorebook };
}

/** NAI 시나리오/스토리에 내장된 lorebook 객체 → 통합 로어북. 없으면 undefined. */
export function parseScenarioLorebook(
  lb: any,
  fallbackName: string
): StellaLorebook | undefined {
  if (!lb || typeof lb !== "object" || !Array.isArray(lb.entries)) {
    return undefined;
  }
  if (lb.entries.length === 0) return undefined;
  const book = parseNovelAILorebook(lb, fallbackName);
  book.meta._source = "novelai";
  return book;
}

// --- helpers ---

function str(v: any): string {
  return typeof v === "string" ? v : "";
}
function arr(v: any): any[] {
  return Array.isArray(v) ? v : [];
}
