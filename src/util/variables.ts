/**
 * 게임형 카드 변수 — 순수 로직 (vault/DOM 의존 없음).
 *
 *  - 가지 되짚기: 루트 → 지정 지점 경로의 변화를 순서대로 접어 그 지점의 값을 만든다.
 *  - 스코프 합치기: 전역 값은 `global::` 접두를 달아 매크로용 맵에 얹는다.
 *    **세션에 저장될 맵에는 절대 남으면 안 된다** — 내보내기 전에 `stripGlobalScope`.
 *
 * 단계 있는 이름(`children.ra.affection`)은 키 문자열 그대로 다룬다. 중첩 객체로
 * 펼치는 일은 조건부 로어북(U3)이 필요해질 때 그쪽에서 한다 — 여기서 미리 만들지 않는다.
 */

import type { StellaSession } from "../types/session";
import type { SessionVariableLog, VariableDelta } from "../types/variables";

/** 매크로용 맵에서 전역 값을 구분하는 접두. ST `{{getglobalvar::x}}` 가 이 자리를 읽는다. */
export const GLOBAL_VAR_PREFIX = "global::";

/**
 * 루트 → leafId 경로의 노드 id 목록 (루트가 앞). 끊긴 부모/순환은 거기서 멈춘다.
 * 본문 재구성(`buildSpans`)이 쓰는 경로와 같은 의미다.
 */
export function nodePathTo(session: StellaSession, leafId: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = leafId;
  while (cur && session.nodes[cur] && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    cur = session.nodes[cur].parent;
  }
  return path.reverse();
}

/**
 * 그 지점에서의 값 — base 위에 루트→leaf 경로의 변화를 순서대로 적용한다.
 * `null` 변화는 삭제로 처리한다(빈 문자열과 구분).
 */
export function resolveVariablesAt(
  session: StellaSession,
  log: SessionVariableLog,
  leafId: string
): Record<string, string> {
  const out: Record<string, string> = { ...(log.base ?? {}) };
  for (const nodeId of nodePathTo(session, leafId)) {
    const delta = log.nodes[nodeId];
    if (!delta) continue;
    for (const [key, value] of Object.entries(delta)) {
      if (value === null) delete out[key];
      else out[key] = value;
    }
  }
  return out;
}

/**
 * 이전 값 → 다음 값의 차이를 변화 기록으로. 사라진 키는 `null`(삭제).
 * 바뀐 게 없으면 빈 객체를 돌려준다(빈 기록을 쌓지 않기 위한 판단 재료).
 */
export function diffVariables(
  prev: Record<string, string>,
  next: Record<string, string>
): VariableDelta {
  const delta: VariableDelta = {};
  for (const [key, value] of Object.entries(next)) {
    if (prev[key] !== value) delta[key] = value;
  }
  for (const key of Object.keys(prev)) {
    if (!(key in next)) delta[key] = null;
  }
  return delta;
}

/** 같은 노드의 기존 변화에 새 변화를 누적 병합. */
export function mergeDelta(base: VariableDelta, patch: VariableDelta): VariableDelta {
  return { ...base, ...patch };
}

/**
 * 매크로용 맵 — 세션 값 + `global::` 접두를 단 전역 값.
 * 세션 값이 우선이 아니라 **이름 공간이 아예 다르다**(ST 와 같은 의미).
 */
export function withGlobalScope(
  sessionVars: Record<string, string>,
  globals: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = { ...sessionVars };
  for (const [key, value] of Object.entries(globals)) {
    out[GLOBAL_VAR_PREFIX + key] = value;
  }
  return out;
}

/**
 * 세션에 저장하기 전 전역 값을 걷어낸다.
 * **이 함수를 빠뜨리면 전역 값이 session.json 에 새어 들어간다** — 롤백 경계 위반
 * (`게임형 카드 지원 스펙.md` C급 금지: session.json 스키마 오염).
 */
export function stripGlobalScope(
  vars: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!key.startsWith(GLOBAL_VAR_PREFIX)) out[key] = value;
  }
  return out;
}
