/**
 * 노드 귀속 세그먼트 — 순수 함수.
 *
 * 활성 경로의 패치를 전부 적용해 만든 **최종 본문**을 "이 구간을 마지막으로 쓴 노드"
 * 단위로 분해한다. 세그먼트 텍스트를 순서대로 이으면 buildSpans 결과와 정확히 같다.
 *
 * 용도: 노드 귀속 미디어(삽화)의 인라인 표시 위치 계산 — 노드가 현재 본문에서
 * 차지하는 구간을 렌더 시점에 찾는다 (미디어 확장 스펙.md 삽화 절).
 */

import type { Patch, SessionNode, Span, StellaSession } from "../types/session";
import { normalize, pathToLeaf } from "./session-text";

export interface NodeSegment {
  /** 이 구간을 마지막으로 쓴(소유한) 노드 id. */
  nodeId: string;
  text: string;
}

/** 소유 노드 + 저자를 함께 들고 있는 미병합 조각 (내부 표현). */
interface AuthoredSegment extends NodeSegment {
  author: Span["author"];
  /**
   * 이 구간을 **처음 만들어낸** 노드 id — 나중의 국소 수정(`user-edit`)은 남의 글을
   * 덮어쓴 것이므로 덮기 전 주인을 그대로 물려받는다. "이 문단을 만든 생성 턴"을
   * 물을 때 쓰는 값이라 `nodeId`(마지막으로 쓴 노드)와 다를 수 있다.
   */
  genNodeId: string;
}

export function buildNodeSegments(
  session: StellaSession,
  leafId: string = session.meta.activeLeafId
): NodeSegment[] {
  const out: NodeSegment[] = [];
  for (const s of buildAuthoredSegments(session, leafId)) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && last.nodeId === s.nodeId) last.text += s.text;
    else out.push({ nodeId: s.nodeId, text: s.text });
  }
  return out;
}

/**
 * 특정 노드들의 구간을 뺀 본문 스팬 — "AI에게 숨김"(`node-meta.json`) 노드를
 * 전송본에서 걷어내는 데 쓴다. 화면·저장 원문은 건드리지 않는다(표시는 그대로).
 * 제외 집합이 비면 `buildSpans` 와 완전히 같은 결과다.
 */
export function spansExcludingNodes(
  session: StellaSession,
  leafId: string,
  exclude: ReadonlySet<string>
): Span[] {
  const segs = buildAuthoredSegments(session, leafId);
  return normalize(
    segs
      .filter((s) => !exclude.has(s.nodeId))
      .map((s) => ({ author: s.author, text: s.text }))
  );
}

function buildAuthoredSegments(
  session: StellaSession,
  leafId: string
): AuthoredSegment[] {
  const path = pathToLeaf(session, leafId);
  let segs: AuthoredSegment[] = [];
  for (const node of path) {
    for (const patch of node.patches) {
      segs = applySegmentPatch(segs, patch, node);
    }
  }
  return segs;
}

/** session-text.ts applyPatch 와 같은 의미론 — 소유/생성 노드 추적만 추가. */
function applySegmentPatch(
  segs: AuthoredSegment[],
  patch: Patch,
  node: SessionNode
): AuthoredSegment[] {
  const nodeId = node.id;
  // 국소 수정은 새 글을 "만든" 게 아니라 있던 글을 고친 것 — 생성 노드는 물려받는다.
  const edit = node.kind === "user-edit";
  switch (patch.op) {
    case "append": {
      const inherited = edit
        ? segs[segs.length - 1]?.genNodeId ?? nodeId
        : nodeId;
      return [
        ...segs,
        ...patch.spans.map((s) => ({
          nodeId,
          genNodeId: inherited,
          author: s.author,
          text: s.text,
        })),
      ];
    }
    case "delete": {
      const [left, rest] = splitSegments(segs, patch.from);
      const [, right] = splitSegments(rest, patch.to - patch.from);
      return [...left, ...right];
    }
    case "replace": {
      const [left, rest] = splitSegments(segs, patch.from);
      const [mid, right] = splitSegments(rest, patch.to - patch.from);
      // 덮어쓴 자리의 주인 → 없으면(빈 자리 삽입) 앞뒤 이웃 → 그래도 없으면 자기 자신.
      const inherited = edit
        ? mid[0]?.genNodeId ??
          left[left.length - 1]?.genNodeId ??
          right[0]?.genNodeId ??
          nodeId
        : nodeId;
      return [
        ...left,
        ...patch.spans.map((s) => ({
          nodeId,
          genNodeId: inherited,
          author: s.author,
          text: s.text,
        })),
        ...right,
      ];
    }
  }
}

function splitSegments(
  segs: AuthoredSegment[],
  at: number
): [AuthoredSegment[], AuthoredSegment[]] {
  if (at <= 0) return [[], segs.slice()];
  const left: AuthoredSegment[] = [];
  const right: AuthoredSegment[] = [];
  let consumed = 0;
  let i = 0;
  for (; i < segs.length; i++) {
    const s = segs[i];
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
      if (cut > 0) left.push({ ...s, text: s.text.slice(0, cut) });
      if (cut < len) right.push({ ...s, text: s.text.slice(cut) });
      i++;
      break;
    }
  }
  for (; i < segs.length; i++) right.push(segs[i]);
  return [left, right];
}

/**
 * 경로상 두 노드 사이 구간의 **지금 본문** — `afterNodeId` 다음부터 `throughNodeId`
 * 까지의 노드가 만든 글을, 나중의 편집·삭제가 모두 반영된 최종 본문에서 잘라 낸다.
 * `afterNodeId` 를 생략하면 맨 앞부터.
 *
 * 요약·로어북 자동 생성처럼 "이 구간에서 새로 진행된 내용"을 재료로 쓰는 쪽이 쓴다.
 * `buildSpans(session, 경계노드)` 로 **그 시점 본문**을 다시 만들면 뒤에서 지우거나
 * 고친 대목이 그 시점에는 살아 있어, 요약을 전부 지우고 다시 만들어도 지운 내용이
 * 계속 되살아난다(제보된 회귀).
 *
 * 귀속은 `genNodeId`(그 글을 처음 만든 생성 턴) 기준이라, 나중에 손본 문단도 원래
 * 자리에 **고친 내용으로** 남는다. `exclude` 는 "AI에게 숨김" 노드 — 통째로 빠진다.
 */
export function textBetweenNodes(
  session: StellaSession,
  leafId: string,
  afterNodeId: string | undefined,
  throughNodeId: string,
  exclude: ReadonlySet<string> = new Set()
): string {
  const path = pathToLeaf(session, leafId);
  const indexOf = new Map<string, number>();
  path.forEach((n, i) => indexOf.set(n.id, i));
  const through = indexOf.get(throughNodeId);
  if (through === undefined) return "";
  const after = afterNodeId !== undefined ? indexOf.get(afterNodeId) ?? -1 : -1;
  if (after >= through) return "";

  let out = "";
  for (const seg of buildAuthoredSegments(session, leafId)) {
    if (exclude.has(seg.nodeId)) continue;
    const i = indexOf.get(seg.genNodeId);
    if (i === undefined || i <= after || i > through) continue;
    out += seg.text;
  }
  return out;
}

/** 노드별 구간 범위(최종 본문 기준) — 표시(흐리게)나 이름표 앵커 계산용. */
export interface NodeSpanRange {
  nodeId: string;
  from: number;
  to: number;
}

/**
 * "이 구간을 만든 생성 턴" 기준 구간들 — 되돌리기(과거 노드로 이동)의 착지점 계산용.
 *
 * `nodeSpanRanges` 와 달리 나중의 국소 수정(`user-edit`)에 가려지지 않는다. 2화의 한
 * 문단을 나중에 고쳐도 그 문단은 여전히 "2화를 쓴 노드"의 구간으로 잡힌다.
 */
export function generatorSpanRanges(
  session: StellaSession,
  leafId: string = session.meta.activeLeafId
): NodeSpanRange[] {
  const out: NodeSpanRange[] = [];
  let offset = 0;
  for (const seg of buildAuthoredSegments(session, leafId)) {
    if (!seg.text) continue;
    const from = offset;
    offset += seg.text.length;
    const last = out[out.length - 1];
    if (last && last.nodeId === seg.genNodeId && last.to === from) {
      last.to = offset;
    } else {
      out.push({ nodeId: seg.genNodeId, from, to: offset });
    }
  }
  return out;
}

/** 노드가 최종 본문에서 차지하는 구간들 (등장 순서, 인접한 같은 노드는 합침). */
export function nodeSpanRanges(
  session: StellaSession,
  leafId: string = session.meta.activeLeafId
): NodeSpanRange[] {
  const out: NodeSpanRange[] = [];
  let offset = 0;
  for (const seg of buildNodeSegments(session, leafId)) {
    out.push({ nodeId: seg.nodeId, from: offset, to: offset + seg.text.length });
    offset += seg.text.length;
  }
  return out;
}
