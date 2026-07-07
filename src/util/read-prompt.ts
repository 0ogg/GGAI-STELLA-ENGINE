import { TFile, Vault } from "obsidian";
import { parseSillyTavernPromptPreset } from "../import/parse-sillytavern-prompt";
import { StellaPromptPreset } from "../types/prompt";

/**
 * `GGAI/PROMPTS/<이름>.json` 한 파일을 읽어 `StellaPromptPreset` 으로 복원.
 *
 *  - 파일은 ST 호환 raw 형태. `prompts` 배열과 `prompt_order` (default character_id=100000) 만 사용.
 *  - 나머지 ST 필드 (temperature 등) 는 무시 — 호환성 보존(파일 자체는 그대로 둠).
 *  - `stella` 키가 있으면 메타(id/favorite) 보존, 없으면 새 uuid + favorite=false.
 */
export async function readPromptPreset(
  vault: Vault,
  filePath: string
): Promise<StellaPromptPreset | null> {
  const f = vault.getAbstractFileByPath(filePath);
  if (!(f instanceof TFile)) return null;
  try {
    const text = await vault.read(f);
    const raw = JSON.parse(text);
    const fallbackName = filePath
      .split("/")
      .pop()!
      .replace(/\.json$/i, "");
    const preset = parseSillyTavernPromptPreset(raw, fallbackName);
    // stella 메타 보존
    const stella = (raw && typeof raw === "object" ? (raw as any).stella : null);
    if (stella && typeof stella === "object") {
      if (typeof stella.id === "string") preset.meta.id = stella.id;
      if (typeof stella.favorite === "boolean")
        preset.meta.favorite = stella.favorite;
    }
    return preset;
  } catch (err) {
    console.warn("[GGAI Stella] 프롬프트 JSON 파싱 실패:", filePath, err);
    return null;
  }
}
