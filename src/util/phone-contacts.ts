/**
 * 스텔라 폰 연락처 파생 (PH1).
 *
 * 연락처는 저장하지 않는다 — "이 페르소나로 세션을 1개 이상 함께 한 시나리오"를
 * 세션 기록(`session.meta.personaFile`)에서 매번 계산한다 (스텔라폰 스펙.md 원칙 4).
 * 그룹 세션을 함께 플레이한 경우 그 그룹의 멤버 시나리오 전원도 후보가 된다.
 * 엑스트라(모르는 번호) 스레드는 messages.json 에 저장되므로 여기 대상이 아니다.
 */
import type { StellaStore } from "../state/store";

export interface PhoneContact {
  /** 시나리오 stella id — 스레드 매칭 키. */
  scenarioId: string;
  scenarioFile: string;
  name: string;
  thumbnailPath: string | null;
  /** 이 페르소나와의 마지막 세션 활동 시각 (정렬용). */
  lastSessionAt: number;
}

/**
 * 로그인 페르소나(파일 경로)로 세션을 함께 한 시나리오 목록.
 * 최근 활동순 정렬. 시나리오/세션 로드 실패는 조용히 건너뛴다.
 */
export async function listPhoneContacts(
  store: StellaStore,
  personaFile: string
): Promise<PhoneContact[]> {
  const scenarios = await store
    .getScenarios()
    .catch((): Awaited<ReturnType<StellaStore["getScenarios"]>> => []);

  // scenarioId → 시나리오 목록 항목 (그룹 멤버 해석·표시용).
  type ScenarioItem = (typeof scenarios)[number];
  const byId = new Map<string, { item: ScenarioItem; name: string }>();
  for (const item of scenarios) {
    const scenarioId = item.scenario.data?.extensions?.stella?.id;
    const name = item.scenario.data?.name?.trim();
    if (!scenarioId || !name) continue;
    byId.set(scenarioId, { item, name });
  }

  // scenarioId → 이 페르소나와의 마지막 세션 활동 시각 (직접 세션 + 그룹 참가).
  const lastById = new Map<string, number>();
  const bump = (id: string, at: number): void => {
    if (!byId.has(id)) return;
    lastById.set(id, Math.max(lastById.get(id) ?? 0, at));
  };

  let groups: Awaited<ReturnType<StellaStore["getGroups"]>> | null = null;
  for (const item of scenarios) {
    const scenarioId = item.scenario.data?.extensions?.stella?.id;
    if (!scenarioId || !byId.has(scenarioId)) continue;
    const sessions = await store
      .getSessions(item.folder)
      .catch((): Awaited<ReturnType<StellaStore["getSessions"]>> => []);
    for (const s of sessions) {
      if (s.session.meta.personaFile !== personaFile) continue;
      const at = s.session.meta.modifiedAt ?? 0;
      bump(scenarioId, at);
      // 그룹 세션이면 함께 참가한 멤버 시나리오 전원도 연락처 후보.
      const groupId = s.session.meta.groupId;
      if (!groupId) continue;
      if (!groups) {
        groups = await store
          .getGroups()
          .catch((): Awaited<ReturnType<StellaStore["getGroups"]>> => []);
      }
      const group = groups.find((g) => g.group.id === groupId)?.group;
      if (!group) continue;
      for (const m of group.members) bump(m.scenarioId, at);
    }
  }

  const out: PhoneContact[] = [];
  for (const [scenarioId, lastAt] of lastById) {
    const entry = byId.get(scenarioId);
    if (!entry) continue;
    out.push({
      scenarioId,
      scenarioFile: entry.item.scenarioFile,
      name: entry.name,
      thumbnailPath: entry.item.thumbnailPath,
      lastSessionAt: lastAt,
    });
  }
  out.sort((a, b) => b.lastSessionAt - a.lastSessionAt);
  return out;
}
