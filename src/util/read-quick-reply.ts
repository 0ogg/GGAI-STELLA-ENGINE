import { TFile, Vault } from "obsidian";
import {
  normalizeQuickReplySet,
  type StellaQuickReplySet,
} from "../types/quick-reply";

/** 세트 파일 하나를 읽어 정규화. 없거나 깨졌으면 null. */
export async function readQuickReplySet(
  vault: Vault,
  file: string
): Promise<StellaQuickReplySet | null> {
  const f = vault.getAbstractFileByPath(file);
  if (!(f instanceof TFile)) return null;
  try {
    const raw = JSON.parse(await vault.read(f));
    return normalizeQuickReplySet(raw, f.basename);
  } catch (err) {
    console.warn(`[GGAI Stella] QR 세트 읽기 실패 (${file}):`, err);
    return null;
  }
}
