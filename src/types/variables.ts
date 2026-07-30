/**
 * 게임형 카드 변수 — 가지별 변화 기록 스키마 (`게임형 카드 지원 스펙.md` U1).
 *
 * **session.json 을 건드리지 않는다.** 현재 값은 기존 `session.meta.variables`
 * (이름→문자열 평면 맵)에 그대로 살고, 이 파일은 세션 폴더의 별도
 * `variables.json` 에만 쓴다. 기능을 걷어내면 이 파일만 지우면 된다.
 *
 * 왜 기록이 필요한가 — 우리는 재생성·과거 지점 점프가 일상이다. 값이 세션에
 * 하나뿐이면 되돌려도 애정도가 안 돌아와 게임이 깨진다. 본문(patch)과 같은 원리로
 * **지점마다의 변화**만 쌓고, 루트 → 현재 지점 경로를 되짚어 값을 재구성한다.
 *
 * 단계 있는 이름(`children.ra.affection`)은 키 문자열에 점을 찍어 표현한다 —
 * 저장 형식이 평면 맵 그대로라 스키마 변경이 없다.
 */

/** 한 지점에서 일어난 변화. 값 `null` = 그 지점에서 변수를 지웠다는 표시. */
export type VariableDelta = Record<string, string | null>;

export interface SessionVariableLog {
  version: 1;
  /**
   * 기록이 시작되기 전부터 세션에 있던 값 (레거시 `meta.variables` 스냅샷).
   * 첫 기록 시 1회 채워진다 — 이게 없으면 기존 세션의 값이 갑자기 사라진 것처럼 보인다.
   */
  base?: Record<string, string>;
  /** 노드 id → 그 지점에서의 변화. 같은 노드에서 여러 번 바뀌면 누적 병합된다. */
  nodes: Record<string, VariableDelta>;
}

export function createEmptyVariableLog(): SessionVariableLog {
  return { version: 1, nodes: {} };
}

/** 기록이 비어 있는가 (= 아직 이 세션에서 게임형 변수를 쓴 적 없음). */
export function isEmptyVariableLog(log: SessionVariableLog): boolean {
  return (
    Object.keys(log.nodes).length === 0 &&
    Object.keys(log.base ?? {}).length === 0
  );
}

/** 외부/구버전 데이터를 관용적으로 정규화. 깨진 항목은 버린다. */
export function normalizeVariableLog(raw: unknown): SessionVariableLog {
  if (!raw || typeof raw !== "object") return createEmptyVariableLog();
  const src = raw as Record<string, unknown>;
  const out = createEmptyVariableLog();

  if (src.base && typeof src.base === "object") {
    for (const [k, v] of Object.entries(src.base as Record<string, unknown>)) {
      if (typeof v === "string") (out.base ??= {})[k] = v;
    }
  }
  if (src.nodes && typeof src.nodes === "object") {
    for (const [nodeId, delta] of Object.entries(
      src.nodes as Record<string, unknown>
    )) {
      if (!delta || typeof delta !== "object") continue;
      const clean: VariableDelta = {};
      for (const [k, v] of Object.entries(delta as Record<string, unknown>)) {
        if (typeof v === "string" || v === null) clean[k] = v;
      }
      if (Object.keys(clean).length > 0) out.nodes[nodeId] = clean;
    }
  }
  return out;
}
