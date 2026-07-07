import { TFolder, Vault } from "obsidian";
import { BASE_FOLDER } from "../constants";
import type { StellaScenario } from "../types/scenario";

export interface ScenarioListItem {
  folder: string;
  folderName: string;
  scenarioFile: string;
  thumbnailPath: string | null;
  scenario: StellaScenario;
  lastSessionAt: number;
  sessionCount: number;
}

export async function scanScenarios(vault: Vault): Promise<ScenarioListItem[]> {
  const root = vault.getAbstractFileByPath(`${BASE_FOLDER}/SCENARIOS`);
  if (!(root instanceof TFolder)) return [];

  const items: ScenarioListItem[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;

    const scenarioPath = `${child.path}/scenario.json`;
    if (!(await vault.adapter.exists(scenarioPath))) continue;

    try {
      const text = await vault.adapter.read(scenarioPath);
      const scenario = JSON.parse(text) as StellaScenario;

      const thumbRel = resolveThumbnail(scenario);
      const thumbAbs = thumbRel ? `${child.path}/${thumbRel}` : null;
      const thumbnailPath =
        thumbAbs && (await vault.adapter.exists(thumbAbs)) ? thumbAbs : null;
      const sessionStats = await scanSessionStats(vault, child.path);

      items.push({
        folder: child.path,
        folderName: child.name,
        scenarioFile: scenarioPath,
        thumbnailPath,
        scenario,
        lastSessionAt: sessionStats.lastSessionAt,
        sessionCount: sessionStats.sessionCount,
      });
    } catch (err) {
      console.warn(`[GGAI Stella] scenario.json load failed: ${scenarioPath}`, err);
    }
  }
  return items;
}

async function scanSessionStats(
  vault: Vault,
  scenarioFolder: string
): Promise<{ lastSessionAt: number; sessionCount: number }> {
  const root = vault.getAbstractFileByPath(`${scenarioFolder}/SESSIONS`);
  if (!(root instanceof TFolder)) return { lastSessionAt: 0, sessionCount: 0 };

  let lastSessionAt = 0;
  let sessionCount = 0;
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    const path = `${child.path}/session.json`;
    if (!(await vault.adapter.exists(path))) continue;

    sessionCount += 1;
    try {
      const raw = JSON.parse(await vault.adapter.read(path)) as {
        meta?: { lastPlayedAt?: number; modifiedAt?: number; createdAt?: number };
      };
      const meta = raw.meta ?? {};
      lastSessionAt = Math.max(
        lastSessionAt,
        meta.lastPlayedAt ?? 0,
        meta.modifiedAt ?? 0,
        meta.createdAt ?? 0
      );
    } catch (err) {
      console.warn(`[GGAI Stella] session stats load failed: ${path}`, err);
    }
  }
  return { lastSessionAt, sessionCount };
}

function resolveThumbnail(scenario: StellaScenario): string | null {
  const stella = scenario.data?.extensions?.stella;
  const stellaThumb = stella?.thumbnail;
  if (typeof stellaThumb === "string" && stellaThumb) return stellaThumb;

  const assets = scenario.data?.assets;
  if (Array.isArray(assets)) {
    const main = assets.find((a) => a?.type === "icon" && a?.name === "main");
    if (
      main &&
      typeof main.uri === "string" &&
      main.uri &&
      !main.uri.startsWith("http") &&
      !main.uri.startsWith("ccdefault")
    ) {
      return main.uri;
    }
  }
  return null;
}
