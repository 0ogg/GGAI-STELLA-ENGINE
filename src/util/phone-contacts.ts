/**
 * 스텔라 폰 연락처 파생 (PH1).
 *
 * 연락처는 저장하지 않는다 — "이 페르소나로 세션을 1개 이상 함께 한 시나리오"를
 * 세션 기록(`session.meta.personaFile`)에서 매번 계산한다 (스텔라폰 스펙.md 원칙 4).
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
  const out: PhoneContact[] = [];
  for (const item of scenarios) {
    const scenarioId = item.scenario.data?.extensions?.stella?.id;
    const name = item.scenario.data?.name?.trim();
    if (!scenarioId || !name) continue;
    const sessions = await store
      .getSessions(item.folder)
      .catch((): Awaited<ReturnType<StellaStore["getSessions"]>> => []);
    let lastAt = 0;
    for (const s of sessions) {
      if (s.session.meta.personaFile !== personaFile) continue;
      lastAt = Math.max(lastAt, s.session.meta.modifiedAt ?? 0);
    }
    if (lastAt === 0) continue;
    out.push({
      scenarioId,
      scenarioFile: item.scenarioFile,
      name,
      thumbnailPath: item.thumbnailPath,
      lastSessionAt: lastAt,
    });
  }
  out.sort((a, b) => b.lastSessionAt - a.lastSessionAt);
  return out;
}
