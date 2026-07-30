/**
 * VariablesService (`plugin.variables`) — 게임형 카드 변수의 단일 진입점.
 *
 * 값이 사는 곳은 둘이다:
 *  - **세션 값** — 기존 `session.meta.variables` 그대로(스키마 변경 없음).
 *    바뀔 때마다 그 지점(활성 리프)에 변화를 `variables.json` 에 기록해,
 *    재생성·과거 점프로 되돌아가면 값도 함께 되돌아간다.
 *  - **전역 값** — `PluginData.globalVariables`. 모든 세션 공통(ST global variable).
 *
 * 저장은 전부 `plugin.store` 경유(CLAUDE.md 6). 되짚기 계산은 `util/variables.ts` 순수 함수.
 */

import type StellaEnginePlugin from "../main";
import type { StellaSession } from "../types/session";
import type { SessionVariableLog, VariableDelta } from "../types/variables";
import { isEmptyVariableLog } from "../types/variables";
import { mergeDelta, resolveVariablesAt } from "../util/variables";

export class VariablesService {
  constructor(private plugin: StellaEnginePlugin) {}

  // ── 전역 값 ──

  getGlobals(): Record<string, string> {
    return { ...(this.plugin.data.globalVariables ?? {}) };
  }

  /** 전역 값 부분 갱신. `null` 이면 그 이름을 지운다. */
  async setGlobals(patch: Record<string, string | null>): Promise<void> {
    const next = this.getGlobals();
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    await this.plugin.savePluginData({ globalVariables: next });
  }

  // ── 세션 값 ──

  getLog(sessionFile: string): Promise<SessionVariableLog> {
    return this.plugin.store.getSessionVariableLog(sessionFile);
  }

  /**
   * 지금 보고 있는 지점의 세션 값.
   *
   * 기록이 아직 없으면 기존 `meta.variables` 를 그대로 돌려준다 — 이 기능을 쓰지 않는
   * 세션(대다수)은 예전과 완전히 동일하게 동작해야 한다.
   */
  async resolveActive(sessionFile: string): Promise<Record<string, string>> {
    const session = await this.plugin.store
      .getSession(sessionFile)
      .catch(() => null);
    if (!session) return {};
    const log = await this.getLog(sessionFile);
    return this.resolveFor(session, log);
  }

  /**
   * 이미 읽어둔 세션/기록으로 값 계산 — 파일을 두 번 읽지 않으려는 호출부용.
   * `leafId` 를 주면 그 지점 기준(전송본은 활성 리프가 아니라 "이어쓸 지점" 기준이다).
   */
  resolveFor(
    session: StellaSession,
    log: SessionVariableLog,
    leafId?: string
  ): Record<string, string> {
    if (isEmptyVariableLog(log)) return { ...(session.meta.variables ?? {}) };
    return resolveVariablesAt(session, log, leafId ?? session.meta.activeLeafId);
  }

  /**
   * 세션 값 변경 — 활성 리프에 변화를 기록하고, 재구성한 결과를 `meta.variables`
   * 에도 반영한다(기존 매크로/QR 이 읽는 자리를 그대로 유지).
   * `null` 값은 삭제. 바뀐 게 없으면 아무것도 저장하지 않는다.
   */
  async setSessionVars(
    sessionFile: string,
    patch: Record<string, string | null>
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    const session = await this.plugin.store
      .getSession(sessionFile)
      .catch(() => null);
    if (!session) return;

    const log = await this.getLog(sessionFile);
    // 첫 기록이면, 기록 이전부터 있던 값을 base 로 붙잡아 둔다.
    // 이게 없으면 기존 세션의 변수가 갑자기 사라진 것처럼 보인다.
    if (isEmptyVariableLog(log) && session.meta.variables) {
      const base = { ...session.meta.variables };
      if (Object.keys(base).length > 0) log.base = base;
    }

    const leafId = session.meta.activeLeafId;
    const current = this.resolveFor(session, log);
    const delta: VariableDelta = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        if (key in current) delta[key] = null;
      } else if (current[key] !== value) {
        delta[key] = value;
      }
    }
    if (Object.keys(delta).length === 0) return;

    log.nodes[leafId] = mergeDelta(log.nodes[leafId] ?? {}, delta);
    await this.plugin.store.saveSessionVariableLog(sessionFile, log);

    // 저장 직전에 세션을 다시 읽는다 — 기록을 쓰는 동안 바뀌었을 수 있다.
    const fresh = await this.plugin.store.getSession(sessionFile).catch(() => null);
    if (!fresh) return;
    fresh.meta.variables = this.resolveFor(fresh, log);
    await this.plugin.store.saveSession(sessionFile, fresh, {
      kinds: ["settings"],
    });
  }
}
