import { TFolder, Vault } from "obsidian";
import { BASE_FOLDER } from "../constants";
import type { StellaGroup } from "../types/group";
import { readGroup } from "./read-group";

export interface GroupListItem {
  /** 예: "GGAI/GROUPS/우리 파티" */
  folder: string;
  /** 마지막 세그먼트 — 사용자가 보는 폴더명. */
  folderName: string;
  /** 예: "GGAI/GROUPS/우리 파티/group.json" */
  groupFile: string;
  group: StellaGroup;
}

/** `GGAI/GROUPS/` 아래 폴더들을 스캔해 group.json 이 있는 것만 수집. */
export async function scanGroups(vault: Vault): Promise<GroupListItem[]> {
  const root = vault.getAbstractFileByPath(`${BASE_FOLDER}/GROUPS`);
  if (!(root instanceof TFolder)) return [];

  const items: GroupListItem[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    const groupFile = `${child.path}/group.json`;
    const group = await readGroup(vault, groupFile);
    if (!group) continue;
    items.push({
      folder: child.path,
      folderName: child.name,
      groupFile,
      group,
    });
  }
  return items;
}
