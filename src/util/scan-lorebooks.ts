import { TFolder, Vault } from "obsidian";
import { BASE_FOLDER } from "../constants";
import { StellaLorebook } from "../types/lorebook";
import { readLorebook } from "./read-lorebook";

export interface LorebookListItem {
  folder: TFolder;
  folderName: string;
  lorebookFile: string;     // "GGAI/LOREBOOKS/<name>/lorebook.json"
  lorebook: StellaLorebook;
}

/**
 * `GGAI/LOREBOOKS/` 하위 폴더를 스캔해 `lorebook.json` 이 있는 것만 반환한다.
 * 레거시 마크다운 분해 폴더는 무시한다.
 */
export async function scanLorebooks(vault: Vault): Promise<LorebookListItem[]> {
  const root = vault.getAbstractFileByPath(`${BASE_FOLDER}/LOREBOOKS`);
  if (!(root instanceof TFolder)) return [];

  const items: LorebookListItem[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    const lorebook = await readLorebook(vault, child);
    if (!lorebook) continue;
    items.push({
      folder: child,
      folderName: child.name,
      lorebookFile: `${child.path}/lorebook.json`,
      lorebook,
    });
  }
  return items;
}
