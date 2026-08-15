/**
 * 반복 표현 확장 — 최근 AI 본문에서 되풀이된 표현을 세어 전송본에 짧은 목록으로 넣는다.
 * (설계·경계는 `반복 표현 감지 스펙.md`)
 *
 * 삽입 자리는 외부 확장 공용 `custom` 슬롯 하나 — `planSessionRequest` 가 수집하므로
 * 미리보기와 실제 전송이 자동으로 같다. 확장을 끄면 기여 자체가 없어 전송본이
 * 이전과 byte 단위로 같다(롤백 경계).
 *
 * **AI 를 부르지 않는다.** 집계는 전송본을 만들 때 이미 재구성된 본문 위에서 선형 1회다.
 */

import type StellaEnginePlugin from "../main";
import type { StellaSession } from "../types/session";
import type { ContextContribution } from "../services/extension-registry";
import { scenarioFileOfSessionFile } from "../util/build-session-context";
import {
  collectRecentAiText,
  composeRepetitionNote,
  findRepetitions,
  formatRepetitionList,
  normalizeRepetitionSettings,
} from "../util/repetition";
import { createRepetitionSettingsPanel } from "../views/detail/panels/repetition-panel";

export const REPETITION_EXTENSION_ID = "stella:repetition";

/**
 * 같은 지점에서 재생성·미리보기를 반복할 때 다시 계산하지 않는다.
 * 키에 노드 수와 설정을 넣어, 본문이나 설정이 바뀌면 자연히 무효가 된다.
 */
const cache = new Map<string, string>();
const CACHE_MAX = 8;

export function registerRepetitionExtension(plugin: StellaEnginePlugin): () => void {
  const offExtension = plugin.extensions.register({
    id: REPETITION_EXTENSION_ID,
    async contributeContext({ sessionFile, session, leafId }): Promise<ContextContribution[]> {
      const settings = normalizeRepetitionSettings(plugin.data.repetition);
      // 패널의 켜기/끄기 — 꺼 두면 기여 자체가 없어 전송본이 예전과 byte 단위로 같다.
      if (!settings.enabled) return [];
      const key = `${sessionFile}|${leafId}|${Object.keys(session.nodes).length}|${JSON.stringify(settings)}`;
      let note = cache.get(key);
      if (note == null) {
        const excludes = [
          ...settings.excludes,
          ...(await collectNameExcludes(plugin, sessionFile, session)),
        ];
        const text = collectRecentAiText(session, leafId, settings.windowNodes);
        const items = findRepetitions(text, { ...settings, excludes });
        note = composeRepetitionNote(settings.template, formatRepetitionList(items));
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
        cache.set(key, note);
      }
      if (!note) return [];
      return [
        {
          slot: "custom",
          text: note,
          name: "반복 표현",
          position: "at_depth",
          // 최근 맥락에 붙어야 효과가 있다 — 얕게.
          depth: 2,
          role: "system",
          order: 120,
        },
      ];
    },
  });

  const offPanel = plugin.registerSettingsPanel(createRepetitionSettingsPanel());

  return () => {
    offExtension();
    offPanel();
    cache.clear();
  };
}

/**
 * 목록에 올라오면 안 되는 이름들 — 캐릭터·페르소나(별칭 포함)·그룹 멤버.
 * 이름은 원래 자주 나오는 게 정상이라, 걸리면 목록이 통째로 쓸모없어진다.
 */
async function collectNameExcludes(
  plugin: StellaEnginePlugin,
  sessionFile: string,
  session: StellaSession
): Promise<string[]> {
  const names: string[] = [];
  try {
    const scenarios = await plugin.store.getScenarios();
    const scenarioFile = scenarioFileOfSessionFile(sessionFile);
    const mine = scenarios.find((i) => i.scenarioFile === scenarioFile);
    const push = (v: string | undefined) => {
      const s = v?.trim();
      if (s) names.push(s);
    };
    push(mine?.scenario.data?.name);

    if (session.meta.groupId) {
      const group = (await plugin.store.getGroupById(session.meta.groupId))?.group;
      if (group) {
        const byStellaId = new Map(
          scenarios.map((i) => [i.scenario.data?.extensions?.stella?.id, i] as const)
        );
        for (const m of group.members) push(byStellaId.get(m.scenarioId)?.scenario.data?.name);
      }
    }

    const { profile } = await plugin.resolveActiveUserProfile();
    push(profile.name);
    for (const alias of profile.aliases ?? []) push(alias);
  } catch (err) {
    // 이름을 못 읽어도 집계는 돌아야 한다 — 이름이 목록에 섞일 뿐이다.
    console.warn("[GGAI Stella] 반복 표현 — 이름 제외 목록 수집 실패:", err);
  }
  return names;
}
