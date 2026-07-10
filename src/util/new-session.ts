import type { ActiveSettings } from "../types/preset";
import type { SessionMode, SessionNode, Span, StellaSession } from "../types/session";
import { buildChatMessages, CHAT_MESSAGE_SEPARATOR } from "./chat-messages";
import { pathToLeaf } from "./session-text";
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
 * @param mode         선택: 세션 모드 (기본 novel). 챗 세션은 first_mes = 첫 AI 메시지
 *                     통짜 1노드 (대형 씨드 분할 안 함 — 노드 1개 = 메시지 1개 대전제).
 */
export function createBlankSession(
  name: string,
  scenarioId: string,
  seedText: SessionSeed = "",
  initial?: ActiveSettings,
  mode: SessionMode = "novel"
): StellaSession {
  const now = Date.now();
  const { nodes, rootId, activeLeafId } = isStorySeed(seedText)
    ? buildStorySeedNodes(seedText.story, now)
    : buildSeedNodes(normalizeSeedTexts(seedText), now, {
        split: mode !== "chat",
      });

  const session: StellaSession = {
    schemaVersion: 1,
    meta: {
      id: uuidv4(),
      name,
      scenarioId,
      mode,
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
  now: number,
  opts: { split: boolean } = { split: true }
): { nodes: Record<string, SessionNode>; rootId: string; activeLeafId: string } {
  const nodes: Record<string, SessionNode> = {};
  const seeds = seedTexts.length > 0 ? seedTexts : [""];
  let order = 0;
  let rootId = "";
  let firstLeafId = "";

  seeds.forEach((text, seedIdx) => {
    const chunks =
      opts.split && text.length > SESSION_SEED_SPLIT_MIN
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

/**
 * 다음화(시리즈) 전용 — 빈 root 밑에 "물려받은 최근 본문(tail)"을 ai-continue 체인으로
 * 심는다. root 자체는 비워 두고(상속 요약 앵커만 붙는 지점) tail 을 자식으로 두므로,
 * 새 화에서 tail 도 정상적으로 요약 대상이 된다(요약이 root 앵커의 빈 패시지를 접두사로
 * 보고 그 뒤 tail 부터 새 패시지로 잡는다). 이어붙이면 tail 원문과 동일하다.
 *
 * @returns 추가할 노드들(root 제외)과 활성 리프 id(체인 끝, tail 이 비면 rootId).
 */
export function buildEpisodeTailNodes(
  rootId: string,
  tailText: string,
  now: number
): { nodes: Record<string, SessionNode>; leafId: string } {
  const nodes: Record<string, SessionNode> = {};
  const text = tailText.trim() === "" ? "" : tailText;
  if (text === "") return { nodes, leafId: rootId };

  const chunks =
    text.length > SESSION_SEED_SPLIT_MIN
      ? splitTextByBudget(text, SESSION_SEED_CHUNK_CHARS)
      : [text];

  let parent = rootId;
  let leafId = rootId;
  let order = 1;
  for (const chunk of chunks) {
    const id = uuidv4();
    nodes[id] = {
      id,
      parent,
      kind: "ai-continue",
      patches: [{ op: "append", spans: [{ author: "ai", text: chunk }] }],
      createdAt: now + order++,
    };
    parent = id;
    leafId = id;
  }
  return { nodes, leafId };
}

/** 챗 다음화 인계 메시지 — 역할만 유지한 최소 형태 (planChatEpisodeTail 이 만든다). */
export interface ChatEpisodeTailMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * 챗 세션 전용 다음화 인계 계획 — 최근 N **메시지**와 그 직전 요약 경계 노드.
 * 챗은 "노드 1개 = 메시지 1개" 대전제라 tail 을 평문 뭉치가 아니라 역할을 유지한
 * 메시지 목록으로 넘긴다 (buildChatEpisodeTailNodes 가 그대로 노드 체인으로 심음).
 * 실행(startNextEpisode)과 미리보기(NextEpisodeModal)가 같은 계산을 쓴다.
 * 메시지가 N개보다 적으면 전체가 tail 이고 경계는 null (요약 catch-up 없음 — 소설과 동일).
 */
export function planChatEpisodeTail(
  prev: StellaSession,
  count: number
): { boundaryNodeId: string | null; messages: ChatEpisodeTailMessage[] } {
  const all = buildChatMessages(prev);
  const tailMsgs = all.slice(Math.max(0, all.length - count));
  let boundaryNodeId: string | null = null;
  if (tailMsgs.length > 0 && tailMsgs.length < all.length) {
    // 경계 = 첫 인계 메시지 노드의 직전 path 노드 (요약이 그 지점까지 정리됨).
    const path = pathToLeaf(prev, prev.meta.activeLeafId);
    const idx = path.findIndex((n) => n.id === tailMsgs[0].nodeId);
    boundaryNodeId = idx > 0 ? path[idx - 1].id : null;
  }
  return {
    boundaryNodeId,
    messages: tailMsgs
      .map((m) => ({ role: m.role, text: m.text.trim() }))
      .filter((m) => m.text.length > 0),
  };
}

/**
 * 챗 다음화 전용 — 빈 root 밑에 인계 메시지들을 **메시지 1개 = 노드 1개** 체인으로
 * 심는다 (챗 대전제 유지 — 문단 뭉치로 합치면 역할/말풍선 경계가 사라진다).
 * 역할 유지: user → user-write, assistant → ai-continue. 두 번째 메시지부터
 * CHAT_MESSAGE_SEPARATOR 를 앞에 붙여 챗 뷰가 native 로 만드는 노드와 같은
 * 평탄화 체계를 지킨다 (root 가 비어 있으므로 첫 메시지는 구분자 없음).
 *
 * @returns 추가할 노드들(root 제외)과 활성 리프 id(체인 끝, 메시지가 없으면 rootId).
 */
export function buildChatEpisodeTailNodes(
  rootId: string,
  messages: ChatEpisodeTailMessage[],
  now: number
): { nodes: Record<string, SessionNode>; leafId: string } {
  const nodes: Record<string, SessionNode> = {};
  let parent = rootId;
  let leafId = rootId;
  let order = 1;
  let first = true;
  for (const msg of messages) {
    const text = msg.text.trim();
    if (!text) continue;
    const id = uuidv4();
    nodes[id] = {
      id,
      parent,
      kind: msg.role === "user" ? "user-write" : "ai-continue",
      patches: [
        {
          op: "append",
          spans: [
            {
              author: msg.role === "user" ? "user" : "ai",
              text: (first ? "" : CHAT_MESSAGE_SEPARATOR) + text,
            },
          ],
        },
      ],
      createdAt: now + order++,
    };
    parent = id;
    leafId = id;
    first = false;
  }
  return { nodes, leafId };
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
