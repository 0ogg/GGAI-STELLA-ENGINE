import { TFile, TFolder, Vault } from "obsidian";
import { StellaLorebook } from "../types/lorebook";
import { uuidv4 } from "./uuid";

/**
 * 로어북 폴더에서 `lorebook.json` 을 읽어 `StellaLorebook` 으로 복원한다.
 *
 * - 정상 JSON 폴더 → 객체 반환.
 * - L1 이전(레거시) 파일에 meta.id 가 비어있으면 자동 생성 + write-back (시나리오/세션 참조 안정).
 * - 레거시 마크다운 분해 폴더(`lorebook.json` 없고 `_lorebook.md` 만 있음) → null + warn.
 * - 폴더 자체가 없거나 둘 다 없음 → null.
 */
export async function readLorebook(
  vault: Vault,
  folder: TFolder
): Promise<StellaLorebook | null> {
  const jsonPath = `${folder.path}/lorebook.json`;
  const jsonFile = vault.getAbstractFileByPath(jsonPath);
  if (jsonFile instanceof TFile) {
    try {
      const text = await vault.read(jsonFile);
      const parsed = JSON.parse(text);
      if (!isValidLorebook(parsed)) {
        console.warn("[GGAI Stella] lorebook.json 형식 불일치:", jsonPath);
        return null;
      }
      // L1 마이그레이션: id 없으면 생성 + 디스크 write-back.
      if (!parsed.meta.id || typeof parsed.meta.id !== "string") {
        parsed.meta.id = uuidv4();
        try {
          await vault.modify(jsonFile, JSON.stringify(parsed, null, 2));
        } catch (err) {
          console.warn(
            "[GGAI Stella] lorebook.json id write-back 실패 (in-memory 만 유효):",
            jsonPath,
            err
          );
        }
      }
      return parsed;
    } catch (err) {
      console.warn("[GGAI Stella] lorebook.json 파싱 실패:", jsonPath, err);
      return null;
    }
  }

  const legacyPath = `${folder.path}/_lorebook.md`;
  if (await vault.adapter.exists(legacyPath)) {
    console.warn(
      "[GGAI Stella] 레거시 마크다운 분해 로어북 발견 — 무시:",
      folder.path
    );
  }
  return null;
}

function isValidLorebook(o: unknown): o is StellaLorebook {
  if (!o || typeof o !== "object") return false;
  const obj = o as Record<string, unknown>;
  const meta = obj.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta.name !== "string") return false;
  if (!Array.isArray(obj.entries)) return false;
  return true;
}
