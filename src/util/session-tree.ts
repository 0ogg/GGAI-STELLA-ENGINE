/**
 * 세션 트리 탐색 헬퍼 + AI 임시 텍스트 생성기.
 *
 * 모두 순수 함수 — vault/DOM 의존 없음.
 * AI placeholder 는 B3 단계에서 GGAI Core 연결 전 손맛을 테스트하기 위함.
 * B4 에서 `core.chatStream()` 등으로 교체된다.
 */

import type { SessionNode, StellaSession } from "../types/session";

/** parentId 의 자식 노드들 — createdAt 오름차순. */
export function getChildren(
  session: StellaSession,
  parentId: string | null
): SessionNode[] {
  return Object.values(session.nodes)
    .filter((n) => n.parent === parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** nodeId 의 형제들(자기 포함) — createdAt 오름차순. */
export function getSiblings(
  session: StellaSession,
  nodeId: string
): SessionNode[] {
  const node = session.nodes[nodeId];
  if (!node) return [];
  return getChildren(session, node.parent);
}

/** 해당 노드가 AI 생성 결과인지. 재생성 가능 여부 판단에 사용. */
export function isAINode(node: SessionNode | undefined | null): boolean {
  return !!node && (node.kind === "ai-continue" || node.kind === "ai-regen");
}

/** 즐겨찾기된 노드들 — 최신 즐겨찾기 우선. */
export function getFavoritedNodes(session: StellaSession): SessionNode[] {
  return Object.values(session.nodes)
    .filter((n) => n.favorite === true)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 노드에서 자손(children) 중 가장 최근에 생성된 것을 따라 가장 깊은 leaf 까지 내려간다.
 * NovelAI 의 "go to end" 와 동일한 의미.
 *  - 자손이 없는 leaf 면 자기 자신 반환.
 *  - 가지가 여러 개면 최신 child 만 따라간다 (다른 분기는 무시).
 */
export function getDeepestLatestDescendant(
  session: StellaSession,
  nodeId: string
): SessionNode | null {
  let cur = session.nodes[nodeId];
  if (!cur) return null;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(cur.id)) return cur; // 순환 방지
    seen.add(cur.id);
    const children = getChildren(session, cur.id);
    if (children.length === 0) return cur;
    cur = children[children.length - 1]; // createdAt 오름차순의 마지막 = 가장 최근
  }
}

/**
 * 생성 직전, 활성 리프까지 이어지는 **연속된 유저 작성(user-write) 노드 사슬**을
 * 노드 하나로 합친다. 타이핑을 멈출 때마다(1.5s idle) 커밋되어 자잘하게 쌓인 노드를
 * 정리한다. 결과 본문은 패치를 순서대로 이어붙이므로 바이트 단위로 동일하다.
 *
 * 안전 규칙 (분기·세이브포인트 보존):
 *  - `user-write` 가 아닌 노드(AI 노드/직접수정 user-edit/root)를 만나면 거기서 멈춘다.
 *  - 사슬 중간 노드가 두 개 이상의 자식을 가지면(다른 분기가 갈림) 합치지 않는다.
 *  - 사슬에 즐겨찾기(세이브포인트)된 노드가 하나라도 있으면 통째로 건드리지 않는다.
 *
 * 합칠 게 없으면(사슬 길이 < 2) session 을 건드리지 않고 false 를 반환한다.
 * 합쳤으면 맨 위 노드에 나머지 패치를 이어붙이고 아래 노드들을 제거한 뒤,
 * `meta.activeLeafId` 를 그 노드로 옮기고 true 를 반환한다.
 */
export function mergeTrailingUserWrites(session: StellaSession): boolean {
  const nodes = session.nodes;
  // leaf → 위로 올라가며 연속된 user-write 수집. 세이브포인트가 끼면 합치지 않는다.
  const chain: SessionNode[] = [];
  let cur: SessionNode | undefined = nodes[session.meta.activeLeafId];
  while (cur && cur.kind === "user-write") {
    if (cur.favorite) return false;
    chain.push(cur); // leaf-first
    cur = cur.parent ? nodes[cur.parent] : undefined;
  }
  chain.reverse(); // root-first [u1 … uk]
  if (chain.length < 2) return false;

  // 사슬이 순수 선형인지 검증 — 중간 노드가 정확히 다음 노드 하나만 자식으로 가져야 한다.
  for (let i = 0; i < chain.length - 1; i++) {
    const kids = getChildren(session, chain[i].id);
    if (kids.length !== 1 || kids[0].id !== chain[i + 1].id) return false;
  }

  const top = chain[0];
  for (let i = 1; i < chain.length; i++) {
    top.patches.push(...chain[i].patches);
    delete nodes[chain[i].id];
  }
  session.meta.activeLeafId = top.id;
  return true;
}

// --- B3 임시 AI 생성기 ---

const PLACEHOLDER_SAMPLES: readonly string[] = [
  "그녀는 잠시 침묵하다가 천천히 입을 열었다. 그의 눈을 바라보며 조심스레 말을 잇기 시작했다.",
  "방 안의 공기가 한층 무겁게 가라앉았다. 누구도 먼저 침묵을 깨려 하지 않았다.",
  "창밖으로 비가 내리기 시작했다. 빗소리가 두 사람 사이의 정적을 가만히 메워주었다.",
  "그는 손을 내밀어 그녀의 팔을 잡았다. 부드럽지만 단호한 손길이었다.",
  "어디선가 시계 종소리가 울려퍼졌다. 시간이 멈춘 듯한 그 순간, 모든 것이 선명해졌다.",
  "바람이 살짝 불어와 그녀의 머리카락을 흩날렸다. 멀리서 새 한 마리가 길게 울었다.",
  "그녀의 미소가 잠깐 흔들렸다. 그 짧은 흔들림이 많은 것을 말해주고 있었다.",
];

let placeholderCounter = 0;

/**
 * AI 응답 자리에 끼워넣을 임시 문장. 호출마다 다른 샘플 + 일련번호.
 * - 앞에 `\n\n` 을 붙여 기존 본문과 시각적으로 분리한다.
 * - 일련번호 덕분에 같은 위치에서 재생성을 여러 번 해도 결과가 다르게 보여 분기 테스트가 쉽다.
 */
export function generatePlaceholderAI(): string {
  placeholderCounter += 1;
  const text = PLACEHOLDER_SAMPLES[placeholderCounter % PLACEHOLDER_SAMPLES.length];
  return `\n\n${text} (#${placeholderCounter})`;
}
