import { ImportedScenario, StellaScenario } from "../types/scenario";
import type { Span } from "../types/session";
import type { StorySeed } from "../util/new-session";
import { uuidv4 } from "../util/uuid";
import { decodeNaiStoryDocument, NaiStorySection } from "./nai-story-document";
import { parseScenarioLorebook } from "./parse-novelai-scenario";

/**
 * NovelAI `.story` JSON → 통합 시나리오 + 진행분(세션 씨드).
 *
 * `.scenario` 임포트와 같은 처리를 기본으로 하되, `.story` 는 진행 본문이
 * 글자 범위 단위 출처(유저 입력/AI 생성)까지 기록된 document 를 담고 있어
 * 세션을 출처 기준으로 노드를 나눠 바로 만들 수 있다. 매핑:
 *   - metadata.title       → 시나리오 이름
 *   - content.document     → progress.seed (문단별 저자 스팬 — 세션 노드 체인용)
 *                            + first_mes (전문 join — 이후 새 세션의 씨드 겸 라운드트립)
 *   - content.context[0]   → progress.memory     (내용만 — 위치 설정은 가져오지 않음)
 *   - content.context[1]   → progress.authorNote (내용만)
 *   - content.lorebook     → 통합 로어북 (parseScenarioLorebook 재사용)
 *
 * 나머지 NAI 고유 데이터(settings/scenarioPreset/attg 등)는 `.scenario` 와 같은
 * 정책으로 `extensions.novelai` 에 보존한다 (이미 매핑된 document/lorebook 제외).
 */

export interface NaiStoryProgress {
  seed: StorySeed;
  memory: string;
  authorNote: string;
}

export interface ParsedNaiStory {
  imported: ImportedScenario;
  progress: NaiStoryProgress;
  warnings: string[];
}

export function parseNovelAIStory(data: any): ParsedNaiStory {
  const src = data ?? {};
  const metadata = src.metadata ?? {};
  const content = src.content ?? {};

  if (typeof content.document !== "string" || !content.document) {
    throw new Error(
      "이 .story 파일에는 document 본문이 없습니다 (구버전 포맷 미지원 — NAI 에서 다시 익스포트해 주세요)."
    );
  }

  const decoded = decodeNaiStoryDocument(content.document);
  if (!decoded.ok) {
    throw new Error(`본문 해독 실패: ${decoded.errors.join(" / ") || "알 수 없는 오류"}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const name = str(metadata.title) || "NAI 스토리";
  const fullText = decoded.sections.map((s) => s.text).join("\n");

  // NAI context: [0] = Memory, [1] = Author's Note (관례). 내용만 가져온다.
  const ctx = Array.isArray(content.context) ? content.context : [];
  const memory = str(ctx[0]?.text).trim();
  const authorNote = str(ctx[1]?.text).trim();

  // 이미 매핑된 큰 필드(document/lorebook)는 중복 저장하지 않는다.
  const { document: _d, lorebook: _l, ...contentRest } = content;

  const scenario: StellaScenario = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name,
      description: "",
      tags: arr(metadata.tags).map(String),
      creator: "",
      character_version: "1.0",
      mes_example: "",
      extensions: {
        novelai: { ...src, content: contentRest },
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
      first_mes: fullText,
      alternate_greetings: [],
      personality: "",
      scenario: "",
      creator_notes: str(metadata.description),
      group_only_greetings: [],
      creation_date: now,
      modification_date: now,
    },
  };

  const lorebook = parseScenarioLorebook(content.lorebook, name);

  return {
    imported: { scenario, lorebook },
    progress: {
      seed: { story: decoded.sections.map(sectionToSpans) },
      memory,
      authorNote,
    },
    warnings: decoded.errors,
  };
}

/**
 * section 의 글자 범위 출처 → 저자 스팬 목록.
 * data 1 = 유저 입력, 그 외(2=AI 등) = ai. 범위가 못 덮는 틈은 ai 로 채운다.
 */
function sectionToSpans(section: NaiStorySection): Span[] {
  const text = section.text;
  if (!text) return [];
  const spans: Span[] = [];
  let pos = 0;
  for (const range of section.origins) {
    const from = Math.max(pos, Math.min(range.position, text.length));
    const to = Math.min(Math.max(from, range.position + range.length), text.length);
    if (from > pos) spans.push({ author: "ai", text: text.slice(pos, from) });
    if (to > from) {
      spans.push({ author: range.data === 1 ? "user" : "ai", text: text.slice(from, to) });
    }
    pos = Math.max(pos, to);
  }
  if (pos < text.length) spans.push({ author: "ai", text: text.slice(pos) });
  return spans;
}

// --- helpers ---

function str(v: any): string {
  return typeof v === "string" ? v : "";
}
function arr(v: any): any[] {
  return Array.isArray(v) ? v : [];
}
