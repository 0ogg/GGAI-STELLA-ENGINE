import { TFile, TFolder, Vault } from "obsidian";
import { BASE_FOLDER } from "../constants";
import type { StellaPreset } from "../types/preset";
import { readPreset } from "./read-preset";

export interface PresetListItem {
  presetFile: string; // "GGAI/PRESETS/<name>.json"
  preset: StellaPreset;
}

/**
 * `GGAI/PRESETS/` 의 `*.json` 파일을 모두 스캔.
 *  - 폴더가 없으면 빈 배열.
 *  - 형식 불일치 파일은 warn 후 skip.
 */
export async function scanPresets(vault: Vault): Promise<PresetListItem[]> {
  const root = vault.getAbstractFileByPath(`${BASE_FOLDER}/PRESETS`);
  if (!(root instanceof TFolder)) return [];

  const items: PresetListItem[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFile)) continue;
    if (!child.name.endsWith(".json")) continue;
    const preset = await readPreset(vault, child.path);
    if (!preset) continue;
    items.push({ presetFile: child.path, preset });
  }
  return items;
}
