import { TFolder, Vault } from "obsidian";
import type { StellaSession } from "../types/session";

export interface SessionListItem {
  /** 예: "GGAI/SCENARIOS/Natasha/SESSIONS/세션1" */
  folder: string;
  /** 마지막 세그먼트 — 사용자가 보는 폴더명. */
  folderName: string;
  /** 예: "GGAI/SCENARIOS/Natasha/SESSIONS/세션1/session.json" */
  sessionFile: string;
  session: StellaSession;
}

/**
 * 주어진 시나리오 폴더 아래의 `SESSIONS/*` 를 스캔해
 * `session.json` 이 있는 폴더만 반환한다.
 */
export async function scanSessions(
  vault: Vault,
  scenarioFolder: string
): Promise<SessionListItem[]> {
  const root = vault.getAbstractFileByPath(`${scenarioFolder}/SESSIONS`);
  if (!(root instanceof TFolder)) return [];

  const items: SessionListItem[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    const path = `${child.path}/session.json`;
    if (!(await vault.adapter.exists(path))) continue;

    try {
      const text = await vault.adapter.read(path);
      const session = JSON.parse(text) as StellaSession;
      items.push({
        folder: child.path,
        folderName: child.name,
        sessionFile: path,
        session,
      });
    } catch (err) {
      console.warn(`[GGAI Stella] session.json 로드 실패: ${path}`, err);
    }
  }
  return items;
}
