import { TFile, TFolder, Vault, normalizePath } from "obsidian";
import { BASE_FOLDER } from "../constants";
import type { StellaScenario } from "../types/scenario";
import { createBlankScenario } from "./new-scenario";

/** 시나리오 폴더(및 내부 전체) 를 휴지통으로 이동. */
export async function trashScenario(
  vault: Vault,
  folderPath: string
): Promise<void> {
  const f = vault.getAbstractFileByPath(folderPath);
  if (!f) return;
  // 첫 번째 인자: 파일, 두 번째 인자: true = 시스템 휴지통 대신 옵시디언 트래시 강제
  await vault.trash(f, true);
}

/** scenario.json 을 다시 직렬화해 덮어쓴다. */
export async function saveScenarioJson(
  vault: Vault,
  scenarioFile: string,
  scenario: StellaScenario
): Promise<void> {
  scenario.data.modification_date = Math.floor(Date.now() / 1000);
  const text = JSON.stringify(scenario, null, 2);
  const file = vault.getAbstractFileByPath(scenarioFile);
  if (file instanceof TFile) {
    await vault.modify(file, text);
  } else {
    await vault.create(scenarioFile, text);
  }
}

/**
 * 빈 시나리오를 새로 만든다 — "추가" 버튼용.
 * 이름 충돌 시 `-2`, `-3` 접미사 자동 부여.
 * @returns 생성된 폴더 경로
 */
export async function createNewScenario(
  vault: Vault,
  name: string
): Promise<{ folder: string; scenarioFile: string }> {
  const { scenario } = createBlankScenario(name);

  const safe = sanitizeName(name) || "시나리오";
  const folder = await uniquePath(
    vault,
    normalizePath(`${BASE_FOLDER}/SCENARIOS/${safe}`)
  );

  await vault.createFolder(folder);
  await vault.createFolder(`${folder}/SESSIONS`);
  const scenarioFile = `${folder}/scenario.json`;
  await vault.create(scenarioFile, JSON.stringify(scenario, null, 2));
  return { folder, scenarioFile };
}

// --- helpers ---

function sanitizeName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\n\r]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function uniquePath(vault: Vault, basePath: string): Promise<string> {
  if (!(await vault.adapter.exists(basePath))) return basePath;
  for (let i = 2; i < 1000; i++) {
    const p = `${basePath}-${i}`;
    if (!(await vault.adapter.exists(p))) return p;
  }
  throw new Error("폴더 경로 충돌 해결 실패");
}
