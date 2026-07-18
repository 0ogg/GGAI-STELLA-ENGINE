/**
 * 미디어(번역 / 삽화 프롬프트 생성)용 로어북 해석 + 본문 매칭.
 *
 * 메인 컨텍스트 빌더와 같은 매칭 엔진(`matchLorebookEntries`)을 재사용하되,
 * 스캔 대상은 "지금 번역/삽화할 본문"이다 — 그 본문에 등장하는 키의 엔트리만
 * (그리고 constant 엔트리) 골라 content 를 이어붙여 프롬프트에 끼울 텍스트로 만든다.
 */

import type { StellaLorebook } from "../types/lorebook";
import type { StellaStore } from "../state/store";
import { matchLorebookEntries } from "./lorebook-match";
import { scenarioFileOfSessionFile } from "./build-session-context";

/**
 * 세션이 속한 시나리오의 미디어(번역/삽화) 공유 로어북 id 목록.
 * 시나리오 탭에서 선택하며, **그 시나리오의 모든 세션이 공유**한다.
 * 시나리오를 못 찾으면 빈 배열.
 */
export async function getScenarioMediaLorebookIds(
  store: StellaStore,
  sessionFile: string,
  kind: "translation" | "illustration"
): Promise<string[]> {
  const scenarioFile = scenarioFileOfSessionFile(sessionFile);
  if (!scenarioFile) return [];
  const scenarios = await store.getScenarios();
  const stella = scenarios.find((i) => i.scenarioFile === scenarioFile)?.scenario
    .data?.extensions?.stella;
  return (
    (kind === "translation"
      ? stella?.translationLorebookIds
      : stella?.illustrationLorebookIds) ?? []
  );
}

/** 활성 설정 로어북 ∪ 시나리오 공유 로어북 — 순서 보존 + 중복 제거. */
export function mergeLorebookIds(
  settingsIds: string[] | undefined,
  scenarioIds: string[]
): string[] {
  const out: string[] = [];
  for (const id of [...(settingsIds ?? []), ...scenarioIds]) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** id 목록으로 로어북 객체를 로드한다. 사라진 id 는 조용히 스킵. */
export async function loadMediaLorebooks(
  store: StellaStore,
  ids: string[] | undefined
): Promise<StellaLorebook[]> {
  if (!ids || ids.length === 0) return [];
  const out: StellaLorebook[] = [];
  for (const id of ids) {
    const item = await store.getLorebookById(id);
    if (item) out.push(item.lorebook);
  }
  return out;
}

/**
 * 본문(scanText)에 매칭되는 로어북 엔트리 content 를 이어붙인다. 없으면 빈 문자열.
 * forcedEntryKeys(AI 선별 결과)가 있으면 키워드 매칭과 합집합으로 강제 포함된다.
 *
 * 확장(번역/삽화 등)에서 직접 부르지 말 것 — `plugin.lorebookPlus.buildTaskLorebookText`
 * 허브를 지나가야 AI 선별 옵션이 자동 적용된다.
 */
export function buildLorebookText(
  books: StellaLorebook[],
  scanText: string,
  forcedEntryKeys?: Set<string>
): string {
  if (books.length === 0) return "";
  const matched = matchLorebookEntries(books, {
    recentMessages: [scanText],
    activeText: scanText,
    forcedEntryKeys,
  });
  return matched
    .map((m) => m.entry.content.trim())
    .filter((c) => c.length > 0)
    .join("\n");
}
