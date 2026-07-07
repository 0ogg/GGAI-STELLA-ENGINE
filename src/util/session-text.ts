/**
 * 세션 트리 → 평문/스팬 재구성.
 *
 * 이 파일은 **순수 함수**만 담는다 (vault 의존성 없음).
 * 훗날 GGAI Core agent() tool 에서 "활성 본문을 평문으로 얻는" 용도로 재사용 가능.
 */

import type {
  Patch,
  SessionNode,
  Span,
  StellaSession,
} from "../types/session";

/**
 * 한 노드가 "자체적으로 추가한" 텍스트만 추출.
 *  - append/replace 패치의 spans 텍스트를 순서대로 이어붙임.
 *  - delete 만 있는 노드 (잘라내기) 는 빈 문자열.
 *  - 분기 트리 UI 의 노드 미리보기/디테일 카드 본문에 사용.
 */
export function nodeOwnText(node: SessionNode): string {
  let out = "";
  for (const p of node.patches) {
    if (p.op === "append" || p.op === "replace") {
      for (const span of p.spans) out += span.text;
    }
  }
  return out;
}

/** 루트에서 리프까지 이어지는 노드 배열. 리프 미발견/순환 시 빈 배열. */
export function pathToLeaf(
  session: StellaSession,
  leafId: string
): SessionNode[] {
  const path: SessionNode[] = [];
  let cur: SessionNode | undefined = session.nodes[leafId];
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur.id)) return []; // 순환 방지
    seen.add(cur.id);
    path.push(cur);
    if (cur.parent == null) break;
    cur = session.nodes[cur.parent];
  }
  if (path.length === 0 || path[path.length - 1].parent != null) return [];
  path.reverse();
  return path;
}

/** 주어진 리프까지의 모든 패치를 순서대로 적용해 스팬 배열을 만든다. */
export function buildSpans(
  session: StellaSession,
  leafId: string = session.meta.activeLeafId
): Span[] {
  const path = pathToLeaf(session, leafId);
  let spans: Span[] = [];
  for (const node of path) {
    for (const patch of node.patches) {
      spans = applyPatch(spans, patch);
    }
  }
  return normalize(spans);
}

/** 스팬 배열을 평문 문자열로 직렬화 (작성/카운트 용도). */
export function spansToText(spans: Span[]): string {
  let out = "";
  for (const s of spans) out += s.text;
  return out;
}

/** 스팬 배열의 총 문자 길이 (UTF-16 code unit 기준, from/to 와 동일 단위). */
export function spansLength(spans: Span[]): number {
  let n = 0;
  for (const s of spans) n += s.text.length;
  return n;
}

// --- patch application ---

export function applyPatch(spans: Span[], patch: Patch): Span[] {
  switch (patch.op) {
    case "append":
      return [...spans, ...patch.spans];
    case "delete":
      return cutRange(spans, patch.from, patch.to);
    case "replace": {
      const [left, right] = splitAt(spans, patch.from);
      const [, rest] = splitAt(right, patch.to - patch.from);
      return [...left, ...patch.spans, ...rest];
    }
  }
}

/** 스팬 배열의 [0, at) / [at, end) 로 분할. author 경계와 무관하게 문자 단위로 자른다. */
function splitAt(spans: Span[], at: number): [Span[], Span[]] {
  if (at <= 0) return [[], spans.slice()];
  const left: Span[] = [];
  const right: Span[] = [];
  let consumed = 0;
  let i = 0;
  for (; i < spans.length; i++) {
    const s = spans[i];
    const len = s.text.length;
    if (consumed + len <= at) {
      left.push(s);
      consumed += len;
      if (consumed === at) {
        i++;
        break;
      }
    } else {
      const cut = at - consumed;
      if (cut > 0) left.push({ author: s.author, text: s.text.slice(0, cut) });
      if (cut < len)
        right.push({ author: s.author, text: s.text.slice(cut) });
      i++;
      break;
    }
  }
  for (; i < spans.length; i++) right.push(spans[i]);
  return [left, right];
}

/** [from, to) 구간 제거. from >= to 또는 범위 밖이면 원본 반환(복사). */
function cutRange(spans: Span[], from: number, to: number): Span[] {
  if (from >= to) return spans.slice();
  const [left, rest] = splitAt(spans, from);
  const [, right] = splitAt(rest, to - from);
  return [...left, ...right];
}

/** 같은 author 연속 스팬 합치기 + 빈 스팬 제거. 저장/표시 모두에 유용. */
export function normalize(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    if (s.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.author === s.author) {
      last.text += s.text;
    } else {
      out.push({ author: s.author, text: s.text });
    }
  }
  return out;
}
