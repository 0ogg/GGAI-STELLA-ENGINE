import type { SessionNode, StellaSession } from "../types/session";
import { getChildren } from "./session-tree";

/**
 * 지도의 이음선 하나. 일직선 구간을 접었으면 runKey/count 가 붙는다
 * (접힘: toId = 구간 끝 노드 / 펼침: toId = 구간 첫 노드 + expanded).
 */
export interface MapEdge {
  toId: string;
  runKey?: string;
  count?: number;
  expanded?: boolean;
}

/**
 * 지도용 축약 그래프 — keep 를 통과한 노드만 남기고, 그 사이 일직선 구간은
 * 이음선 하나로 접는다. expandedRuns 에 든 구간(키 = 구간 끝 노드)은 원래 사슬로
 * 되살려 그린다.
 */
export function buildMapGraph(
  session: StellaSession,
  rootIds: string[],
  keep: (node: SessionNode) => boolean,
  expandedRuns: Set<string>
): { edgesOf: Map<string, MapEdge[]>; hiddenTotal: number } {
  const edgesOf = new Map<string, MapEdge[]>();
  let hiddenTotal = 0;

  /** 한 갈래를 다음 "남길 노드"까지 따라간다 — 그 사이가 접히는 구간. */
  const walkRun = (startId: string): { endId: string; hidden: string[] } => {
    const hidden: string[] = [];
    let curId = startId;
    const guard = new Set<string>();
    while (!guard.has(curId)) {
      guard.add(curId);
      const node = session.nodes[curId];
      if (!node || keep(node)) break;
      const children = getChildren(session, curId);
      if (children.length !== 1) break;
      hidden.push(curId);
      curId = children[0].id;
    }
    return { endId: curId, hidden };
  };

  const seen = new Set<string>();
  const queue = rootIds.slice();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id) || !session.nodes[id]) continue;
    seen.add(id);

    const edges: MapEdge[] = [];
    for (const child of getChildren(session, id)) {
      const run = walkRun(child.id);
      if (run.hidden.length === 0) {
        edges.push({ toId: run.endId });
      } else if (expandedRuns.has(run.endId)) {
        // 펼친 구간 — 숨긴 노드를 사슬 그대로 되살리고, 첫 이음선에 접기 표시.
        const chain = [...run.hidden, run.endId];
        edges.push({
          toId: chain[0],
          runKey: run.endId,
          count: run.hidden.length,
          expanded: true,
        });
        for (let i = 0; i < chain.length - 1; i++) {
          edgesOf.set(chain[i], [{ toId: chain[i + 1] }]);
          seen.add(chain[i]);
        }
      } else {
        hiddenTotal += run.hidden.length;
        edges.push({ toId: run.endId, runKey: run.endId, count: run.hidden.length });
      }
      queue.push(run.endId);
    }
    edgesOf.set(id, edges);
  }

  return { edgesOf, hiddenTotal };
}
