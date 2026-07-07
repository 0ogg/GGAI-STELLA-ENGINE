import type StellaEnginePlugin from "../main";
import { scenarioFileOfSessionFile } from "../util/build-session-context";
import { buildSpans, spansToText } from "../util/session-text";
import { requestSessionTitle } from "../util/session-title";

/**
 * 세션 관리 화면에서 수동으로 요청하는 세션 제목 생성 — 자동 생성(첫 전개 후 1회)과
 * 별개로, 언제든 현재까지의 본문을 바탕으로 다시 만들 수 있다.
 */
export async function generateSessionTitleNow(
  plugin: StellaEnginePlugin,
  sessionFile: string
): Promise<{ ok: true; title: string; newSessionFile: string } | { ok: false; error: string }> {
  if (!plugin.ai.isAvailable()) {
    return { ok: false, error: "GGAI Core가 설치되어 있지 않거나 꺼져 있습니다." };
  }
  const session = await plugin.store.getSession(sessionFile);
  if (!session) return { ok: false, error: "세션을 불러올 수 없습니다." };

  const settings = await plugin.resolveActiveSettings(sessionFile);
  const allProfiles = plugin.ai.listGenerationProfiles();
  const profile = settings.modelProfileId
    ? allProfiles.find((p) => p.id === settings.modelProfileId) ?? null
    : plugin.ai.getDefaultGenerationProfile();
  if (!profile) {
    return { ok: false, error: "활성 프로필이 없습니다. 우측 사이드바에서 모델을 선택하세요." };
  }

  const scenarioFile = scenarioFileOfSessionFile(sessionFile);
  const scenarios = await plugin.store.getScenarios();
  const scenarioName =
    scenarios.find((i) => i.scenarioFile === scenarioFile)?.scenario.data?.name ?? "(unknown)";

  const text = spansToText(buildSpans(session));
  const story = [text.slice(0, 800), text.slice(-1800)].filter(Boolean).join("\n\n");
  if (!story.trim()) {
    return { ok: false, error: "제목을 만들 본문이 없습니다." };
  }

  const title = await requestSessionTitle(plugin.ai, {
    story,
    profile,
    scenarioName,
    params: settings.params,
  });
  if (!title) return { ok: false, error: "제목 생성 결과가 비어 있습니다." };

  const result = await plugin.store.renameSession(sessionFile, title);
  return { ok: true, title, newSessionFile: result.newSessionFile };
}
