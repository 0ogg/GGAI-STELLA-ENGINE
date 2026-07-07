import { TFile, Vault } from "obsidian";
import type { StellaPreset } from "../types/preset";

/**
 * `GGAI/PRESETS/<이름>.json` 단일 파일을 읽어 `StellaPreset` 으로 복원.
 *  - 파일이 없거나 형식 불일치면 null + warn.
 */
export async function readPreset(
  vault: Vault,
  presetFile: string
): Promise<StellaPreset | null> {
  const f = vault.getAbstractFileByPath(presetFile);
  if (!(f instanceof TFile)) return null;
  try {
    const text = await vault.read(f);
    const parsed = JSON.parse(text);
    if (!isValidPreset(parsed)) {
      console.warn("[GGAI Stella] preset 형식 불일치:", presetFile);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn("[GGAI Stella] preset 파싱 실패:", presetFile, err);
    return null;
  }
}

function isValidPreset(o: unknown): o is StellaPreset {
  if (!o || typeof o !== "object") return false;
  const obj = o as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    typeof obj.favorite === "boolean"
  );
}
