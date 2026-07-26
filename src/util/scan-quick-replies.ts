import { TFile, TFolder, Vault } from "obsidian";
import { BASE_FOLDER } from "../constants";
import type { StellaQuickReplySet } from "../types/quick-reply";
import { readQuickReplySet } from "./read-quick-reply";

export interface QuickReplyListItem {
  /** 표시용 이름 (파일명에서 .json 제거). */
  fileName: string;
  /** `GGAI/QUICKREPLIES/<X>.json` */
  setFile: string;
  set: StellaQuickReplySet;
}

/** `GGAI/QUICKREPLIES/` 하위 세트 스캔 — 단일 JSON 파일만. */
export async function scanQuickReplies(
  vault: Vault
): Promise<QuickReplyListItem[]> {
  const root = vault.getAbstractFileByPath(`${BASE_FOLDER}/QUICKREPLIES`);
  if (!(root instanceof TFolder)) return [];

  const items: QuickReplyListItem[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFile) || child.extension !== "json") continue;
    const set = await readQuickReplySet(vault, child.path);
    if (!set) continue;
    items.push({ fileName: child.basename, setFile: child.path, set });
  }
  // 파일명 순 — 트리 표시가 매번 같은 순서가 되게.
  items.sort((a, b) => a.fileName.localeCompare(b.fileName, "ko"));
  return items;
}
