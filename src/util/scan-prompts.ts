import { TFile, TFolder, Vault } from "obsidian";
import { BASE_FOLDER } from "../constants";
import { StellaPromptPreset } from "../types/prompt";
import { readPromptPreset } from "./read-prompt";

export interface PromptListItem {
  /** 표시용 이름 (파일/폴더 이름에서 .json 제거). */
  folderName: string;
  /** 디스크상 파일 경로 (`GGAI/PROMPTS/<X>.json` 또는 레거시 `GGAI/PROMPTS/<X>/preset.json`). */
  presetFile: string;
  preset: StellaPromptPreset;
}

/**
 * `GGAI/PROMPTS/` 하위에서 프롬프트 세트를 스캔.
 *
 * 신규 형식: `GGAI/PROMPTS/<X>.json` (단일 파일).
 * 레거시 호환: `GGAI/PROMPTS/<X>/preset.json` (폴더). 발견되면 그대로 인식하되,
 * 신규 저장은 단일 파일 형식으로 한다.
 */
export async function scanPrompts(vault: Vault): Promise<PromptListItem[]> {
  const root = vault.getAbstractFileByPath(`${BASE_FOLDER}/PROMPTS`);
  if (!(root instanceof TFolder)) return [];

  const items: PromptListItem[] = [];
  for (const child of root.children) {
    if (child instanceof TFile && child.extension === "json") {
      const preset = await readPromptPreset(vault, child.path);
      if (!preset) continue;
      items.push({
        folderName: child.basename,
        presetFile: child.path,
        preset,
      });
      continue;
    }
    if (child instanceof TFolder) {
      const legacyPath = `${child.path}/preset.json`;
      const legacy = vault.getAbstractFileByPath(legacyPath);
      if (legacy instanceof TFile) {
        const preset = await readPromptPreset(vault, legacyPath);
        if (preset) {
          items.push({
            folderName: child.name,
            presetFile: legacyPath,
            preset,
          });
        }
      }
    }
  }
  return items;
}
