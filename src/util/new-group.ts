import type { StellaGroup } from "../types/group";
import { uuidv4 } from "./uuid";

/**
 * 빈 그룹 객체를 만든다 (순수 — 디스크 접근 없음).
 * 멤버 시나리오 id 목록을 받아 그대로 담는다(중복 제거).
 */
export function createBlankGroup(
  name: string,
  memberScenarioIds: string[] = []
): { group: StellaGroup } {
  const now = Date.now();
  const seen = new Set<string>();
  const members = memberScenarioIds
    .filter((id) => id && !seen.has(id) && (seen.add(id), true))
    .map((scenarioId) => ({ scenarioId }));
  const group: StellaGroup = {
    schemaVersion: 1,
    id: uuidv4(),
    name: name.trim() || "그룹",
    favorite: false,
    createdAt: now,
    modifiedAt: now,
    lastPlayedAt: 0,
    playCount: 0,
    members,
  };
  return { group };
}
