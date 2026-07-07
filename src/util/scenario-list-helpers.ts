import type { ScenarioListItem } from "./scan-scenarios";
import type { SessionListItem } from "./scan-sessions";
import { formatRelativeTime } from "./relative-time";

/** 시나리오 목록 정렬 옵션. 즐겨찾기는 어떤 옵션이든 항상 최상단 그룹으로 고정된다. */
export type SortKey = "recent" | "alpha" | "most-played";

export function getFavorite(item: ScenarioListItem): boolean {
  return item.scenario.data?.extensions?.stella?.favorite === true;
}

export function getLastPlayed(item: ScenarioListItem): number {
  return Math.max(
    item.scenario.data?.extensions?.stella?.lastPlayedAt ?? 0,
    item.lastSessionAt ?? 0
  );
}

export function getPlayCount(item: ScenarioListItem): number {
  return Math.max(
    item.scenario.data?.extensions?.stella?.playCount ?? 0,
    item.sessionCount ?? 0
  );
}

export function sessionMetaLabel(
  sessionCount: number,
  lastSessionAt: number
): string {
  if (sessionCount === 0) return "세션 없음";
  const time = formatRelativeTime(lastSessionAt);
  return time ? `세션 ${sessionCount} · ${time}` : `세션 ${sessionCount}`;
}

export function sessionRecentTime(item: SessionListItem): number {
  const meta = item.session.meta;
  return Math.max(
    meta.lastPlayedAt ?? 0,
    meta.modifiedAt ?? 0,
    meta.createdAt ?? 0
  );
}

/** 새 세션 루트에 심을 first_mes + alternate_greetings 분기 목록. */
export function firstMessageBranches(item: ScenarioListItem): string[] {
  const data = item.scenario.data;
  return [
    data.first_mes,
    ...(Array.isArray(data.alternate_greetings) ? data.alternate_greetings : []),
  ];
}

export function defaultSessionName(item: ScenarioListItem): string {
  const charName = (item.scenario.data.name || item.folderName).trim() || "Session";
  return `${charName} ${formatYYMMDD(new Date())}`;
}

function formatYYMMDD(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** 시나리오의 태그 목록 (CCv3 data.tags, 공백 정리 + 빈 값 제거). */
export function scenarioTags(item: ScenarioListItem): string[] {
  const tags = item.scenario.data?.tags;
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const clean = t.trim();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/** 전체 시나리오에서 태그를 모아 (사용 수 내림차순, 동률 이름순) 정렬해 반환. */
export function collectScenarioTags(
  items: ScenarioListItem[]
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of scenarioTags(item)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export interface ScenarioRecommendation {
  item: ScenarioListItem;
  /** 사용자에게 보여줄 추천 이유 한 줄. */
  reason: string;
}

/**
 * 로비 홈의 추천 — AI 없이 플레이 이력만으로 고른다.
 *  1) 아직 세션이 없는 시나리오 (새로 들인 것 우선 노출).
 *  2) 플레이한 지 가장 오래된 시나리오 (오래 쉰 것 다시 만나기).
 * exclude 로 "이어서 하기"에 이미 떠 있는 시나리오를 빼 중복을 피한다.
 */
export function pickRecommendedScenarios(
  items: ScenarioListItem[],
  opts: { excludeFolders?: Set<string>; limit?: number; now?: number } = {}
): ScenarioRecommendation[] {
  const limit = opts.limit ?? 6;
  const exclude = opts.excludeFolders ?? new Set<string>();
  const now = opts.now ?? Date.now();
  const candidates = items.filter((i) => !exclude.has(i.folder));

  const fresh = candidates.filter((i) => getLastPlayed(i) === 0);
  const dormant = candidates
    .filter((i) => getLastPlayed(i) > 0)
    .sort((a, b) => getLastPlayed(a) - getLastPlayed(b));

  const out: ScenarioRecommendation[] = [];
  for (const item of fresh) {
    if (out.length >= limit) break;
    out.push({ item, reason: "아직 안 해본 시나리오" });
  }
  for (const item of dormant) {
    if (out.length >= limit) break;
    const time = formatRelativeTime(getLastPlayed(item), now);
    // 바로 어제까지 하던 건 "추천"이라기 어색하니 3일 이상 쉰 것만.
    if (now - getLastPlayed(item) < 3 * 24 * 60 * 60 * 1000) continue;
    out.push({ item, reason: time ? `${time}에 마지막 플레이` : "오랜만에 다시" });
  }
  return out;
}

/** 즐겨찾기는 어떤 정렬 기준이든 항상 최상단 그룹으로 고정한다. */
export function compareBy(
  key: SortKey
): (a: ScenarioListItem, b: ScenarioListItem) => number {
  const byName = (a: ScenarioListItem, b: ScenarioListItem) =>
    (a.scenario.data.name || a.folderName).localeCompare(
      b.scenario.data.name || b.folderName
    );
  const base: (a: ScenarioListItem, b: ScenarioListItem) => number = (() => {
    switch (key) {
      case "recent":
        return (a, b) => getLastPlayed(b) - getLastPlayed(a) || byName(a, b);
      case "alpha":
        return byName;
      case "most-played":
        return (a, b) => getPlayCount(b) - getPlayCount(a) || byName(a, b);
    }
  })();
  return (a, b) => {
    const fa = getFavorite(a) ? 1 : 0;
    const fb = getFavorite(b) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    return base(a, b);
  };
}
