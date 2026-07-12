import { Vault } from "obsidian";
import type { StellaGroup } from "../types/group";

/**
 * `GGAI/GROUPS/<이름>/group.json` 을 읽어 `StellaGroup` 으로 복원.
 *  - 파일이 없거나 형식 불일치면 null + warn.
 */
export async function readGroup(
  vault: Vault,
  groupFile: string
): Promise<StellaGroup | null> {
  if (!(await vault.adapter.exists(groupFile))) return null;
  try {
    const parsed = JSON.parse(await vault.adapter.read(groupFile));
    if (!isValidGroup(parsed)) {
      console.warn("[GGAI Stella] group 형식 불일치:", groupFile);
      return null;
    }
    return normalizeGroup(parsed);
  } catch (err) {
    console.warn("[GGAI Stella] group 파싱 실패:", groupFile, err);
    return null;
  }
}

function isValidGroup(o: unknown): o is StellaGroup {
  if (!o || typeof o !== "object") return false;
  const obj = o as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.name === "string";
}

/** 누락 필드 기본값 보정 — 손으로 편집했거나 구버전 파일 대비. */
function normalizeGroup(g: StellaGroup): StellaGroup {
  return {
    schemaVersion: 1,
    id: g.id,
    name: g.name,
    favorite: g.favorite === true,
    createdAt: g.createdAt ?? 0,
    modifiedAt: g.modifiedAt ?? 0,
    lastPlayedAt: g.lastPlayedAt ?? 0,
    playCount: g.playCount ?? 0,
    members: Array.isArray(g.members)
      ? g.members.filter((m) => m && typeof m.scenarioId === "string")
      : [],
  };
}
