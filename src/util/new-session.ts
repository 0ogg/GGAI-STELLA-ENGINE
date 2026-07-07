import type { ActiveSettings } from "../types/preset";
import type { SessionNode, Span, StellaSession } from "../types/session";
import {
  SESSION_SEED_CHUNK_CHARS,
  SESSION_SEED_SPLIT_MIN,
  splitTextByBudget,
} from "./split-passage";
import { uuidv4 } from "./uuid";

/**
 * 임포트 진행분 씨드 — 문단(스팬 목록) 단위로 저자(ai/user) 정보를 보존한다.
 * NAI .story 처럼 글자 범위 출처가 있는 임포트가 사용. 문단 사이 구분자는 "\n".
 */
export type StorySeedParagraph = Span[];
export interface StorySeed {
  story: StorySeedParagraph[];
}

export type SessionSeed = string | string[] | StorySeed;

function isStorySeed(seed: SessionSeed): seed is StorySeed {
  return (
    !!seed &&
    typeof seed === "object" &&
    !Array.isArray(seed) &&
    Array.isArray((seed as StorySeed).story)
  );
}

/**
 * 빈 세션 하나를 만든다.
 *
 * @param name         표시용 이름
 * @param scenarioId   소속 시나리오의 stella.id
 * @param seedText     선택: 루트에 넣을 초기 텍스트 (예: first_mes — AI 로 간주),
 *                     또는 저자 정보가 있는 StorySeed (.story 임포트 진행분)
 * @param initial      선택: 새 세션이 상속할 활성 설정 (= PluginData.current).
 *                     사용자가 마지막에 박은 모델/파라미터/프롬프트 세트가 그대로 따라온다.
 */
export function createBlankSession(
  name: string,
  scenarioId: string,
  seedText: SessionSeed = "",
  initial?: ActiveSettings
): StellaSession {
  const now = Date.now();
  const { nodes, rootId, activeLeafId } = isStorySeed(seedText)
    ? buildStorySeedNodes(seedText.story, now)
    : buildSeedNodes(normalizeSeedTexts(seedText), now);

  const session: StellaSession = {
    schemaVersion: 1,
    meta: {
      id: uuidv4(),
      name,
      scenarioId,
      mode: "novel",
      createdAt: now,
      modifiedAt: now,
      lastPlayedAt: 0,
      favorite: false,
      rootId,
      activeLeafId,
      modelProfileId: initial?.modelProfileId,
      params: initial?.params ? { ...initial.params } : undefined,
      promptSetId: initial?.promptSetId,
      translation: initial?.translation ? { ...initial.translation } : undefined,
      illustration: initial?.illustration ? { ...initial.illustration } : undefined,
      summarize: initial?.summarize ? { ...initial.summarize } : undefined,
      naiFormat: initial?.naiFormat,
      continueAnchor: initial?.continueAnchor,
    },
    nodes,
  };
  return session;
}

/**
 * 씨드 텍스트들로 초기 노드 집합을 만든다.
 *  - 씨드 하나 = 하나의 루트(분기). alternate greetings 는 형제 루트가 된다.
 *  - 큰 씨드(임포트한 진행분 등)는 문단 경계로 잘라 root → ai-continue 체인으로 심는다.
 *    (이어붙이면 원문과 동일하므로 화면 본문은 그대로, 대신 중간에 삽화/요약 앵커를
 *    걸 수 있는 노드가 여러 개 생긴다.)
 *  - 활성 리프는 첫 씨드 체인의 마지막 노드 = 사용자가 이어서 쓸 지점.
 */
function buildSeedNodes(
  seedTexts: string[],
  now: number
): { nodes: Record<string, SessionNode>; rootId: string; activeLeafId: string } {
  const nodes: Record<string, SessionNode> = {};
  const seeds = seedTexts.length > 0 ? seedTexts : [""];
  let order = 0;
  let rootId = "";
  let firstLeafId = "";

  seeds.forEach((text, seedIdx) => {
    const chunks =
      text.length > SESSION_SEED_SPLIT_MIN
        ? splitTextByBudget(text, SESSION_SEED_CHUNK_CHARS)
        : text
        ? [text]
        : [];
    const label = seeds.length > 1 ? `First message ${seedIdx + 1}` : undefined;

    let parent: string | null = null;
    let seedRootId = "";
    let leafId = "";
    if (chunks.length === 0) {
      // 빈 씨드 — 빈 루트 하나.
      const id = uuidv4();
      nodes[id] = {
        id,
        parent: null,
        kind: "root",
        patches: [],
        createdAt: now + order++,
        label,
      };
      seedRootId = id;
      leafId = id;
    } else {
      chunks.forEach((chunk, chunkIdx) => {
        const id = uuidv4();
        nodes[id] = {
          id,
          parent,
          kind: chunkIdx === 0 ? "root" : "ai-continue",
          patches: [{ op: "append", spans: [{ author: "ai", text: chunk }] }],
          createdAt: now + order++,
          label: chunkIdx === 0 ? label : undefined,
        };
        if (chunkIdx === 0) seedRootId = id;
        parent = id;
        leafId = id;
      });
    }

    if (seedIdx === 0) {
      // 첫 씨드의 루트가 세션 rootId, 그 체인의 리프가 활성 리프.
      rootId = seedRootId;
      firstLeafId = leafId;
    }
  });

  return { nodes, rootId, activeLeafId: firstLeafId };
}

/**
 * 저자 정보가 있는 진행분 씨드 → 노드 체인.
 *  - 문단의 턴 종류: 유저가 쓴 글자가 더 많으면 user 턴, 아니면 ai 턴.
 *    (AI 인사말의 접두어만 고친 문단이 user 턴으로 쏠리지 않게 다수 기준)
 *  - 연속 같은 턴 문단은 chunk 예산까지 병합 (전부-AI 소설도 노드가 폭증하지 않게).
 *  - 노드 kind: 첫 노드 root, ai 턴 ai-continue, user 턴 user-write.
 *  - 이어붙이면 문단들을 "\n" 으로 join 한 원문과 동일하다 (구분자는 다음 노드 앞에 붙음).
 */
function buildStorySeedNodes(
  paragraphs: StorySeedParagraph[],
  now: number
): { nodes: Record<string, SessionNode>; rootId: string; activeLeafId: string } {
  // 1) 문단 → 턴 종류 + 길이
  type Turn = { spans: Span[]; user: boolean; length: number };
  const turns: Turn[] = paragraphs.map((spans) => {
    const userLen = spans.reduce(
      (sum, s) => sum + (s.author === "user" ? s.text.length : 0),
      0
    );
    const length = spans.reduce((sum, s) => sum + s.text.length, 0);
    return { spans, user: userLen * 2 > length, length };
  });

  // 2) 연속 같은 턴 병합 (빈 문단은 중립 — 현재 묶음에 흡수)
  type Chunk = { paragraphs: Span[][]; user: boolean; length: number };
  const chunks: Chunk[] = [];
  for (const turn of turns) {
    const last = chunks[chunks.length - 1];
    const neutral = turn.length === 0;
    if (
      last &&
      (neutral || last.user === turn.user) &&
      last.length + turn.length <= SESSION_SEED_CHUNK_CHARS
    ) {
      last.paragraphs.push(turn.spans);
      last.length += turn.length + 1;
    } else {
      chunks.push({ paragraphs: [turn.spans], user: turn.user, length: turn.length });
    }
  }

  // 3) 노드 생성
  const nodes: Record<string, SessionNode> = {};
  let rootId = "";
  let leafId = "";
  let parent: string | null = null;
  let order = 0;

  chunks.forEach((chunk, chunkIdx) => {
    const spans: Span[] = [];
    chunk.paragraphs.forEach((para, paraIdx) => {
      // 문단 구분자 — 첫 노드의 첫 문단만 제외하고 항상 문단 앞에 "\n"
      if (chunkIdx > 0 || paraIdx > 0) pushSpan(spans, { author: "ai", text: "\n" });
      for (const s of para) {
        if (s.text) pushSpan(spans, { author: s.author, text: s.text });
      }
    });

    const id = uuidv4();
    nodes[id] = {
      id,
      parent,
      kind: chunkIdx === 0 ? "root" : chunk.user ? "user-write" : "ai-continue",
      patches: spans.length > 0 ? [{ op: "append", spans }] : [],
      createdAt: now + order++,
    };
    if (chunkIdx === 0) rootId = id;
    parent = id;
    leafId = id;
  });

  if (!rootId) {
    const id = uuidv4();
    nodes[id] = { id, parent: null, kind: "root", patches: [], createdAt: now };
    rootId = id;
    leafId = id;
  }

  return { nodes, rootId, activeLeafId: leafId };
}

/** 같은 저자의 인접 스팬은 병합해서 push. */
function pushSpan(spans: Span[], span: Span): void {
  const last = spans[spans.length - 1];
  if (last && last.author === span.author) last.text += span.text;
  else spans.push({ ...span });
}

function normalizeSeedTexts(seedText: string | string[]): string[] {
  const raw = Array.isArray(seedText) ? seedText : [seedText];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const text of raw) {
    const value = text.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
