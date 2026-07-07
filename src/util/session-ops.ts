import { TFile, TFolder, Vault, normalizePath } from "obsidian";
import type { ActiveSettings } from "../types/preset";
import type { StellaSession } from "../types/session";
import { createBlankSession, type SessionSeed } from "./new-session";

/**
 * 시나리오 폴더 안에 새 세션을 만든다.
 * 폴더 레이아웃: `<scenarioFolder>/SESSIONS/<safeName>/session.json`
 *
 * 이름 충돌 시 `-2`, `-3` 접미사.
 * SESSIONS 폴더는 시나리오 생성 시점에 이미 만들어져 있지만 없으면 생성한다.
 */
export async function createNewSession(
  vault: Vault,
  scenarioFolder: string,
  scenarioId: string,
  name: string,
  seedText: SessionSeed = "",
  initial?: ActiveSettings
): Promise<{ folder: string; sessionFile: string; session: StellaSession }> {
  const safe = sanitizeName(name) || "세션";
  const sessionsRoot = normalizePath(`${scenarioFolder}/SESSIONS`);
  await ensureFolder(vault, sessionsRoot);

  const folder = await uniquePath(vault, `${sessionsRoot}/${safe}`);
  await vault.createFolder(folder);

  const session = createBlankSession(name, scenarioId, seedText, initial);
  const sessionFile = `${folder}/session.json`;
  await vault.create(sessionFile, JSON.stringify(session, null, 2));
  return { folder, sessionFile, session };
}

/** session.json 을 직렬화해 덮어쓴다. modifiedAt 자동 갱신. */
export async function saveSession(
  vault: Vault,
  sessionFile: string,
  session: StellaSession
): Promise<void> {
  session.meta.modifiedAt = Date.now();
  const text = JSON.stringify(session, null, 2);
  const file = vault.getAbstractFileByPath(sessionFile);
  if (file instanceof TFile) {
    await vault.modify(file, text);
  } else {
    await vault.create(sessionFile, text);
  }
}

/** 세션 폴더 통째로 휴지통으로. */
export async function trashSession(
  vault: Vault,
  folderPath: string
): Promise<void> {
  const f = vault.getAbstractFileByPath(folderPath);
  if (!f) return;
  await vault.trash(f, true);
}

// --- helpers ---

function sanitizeName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\n\r]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function uniquePath(vault: Vault, basePath: string): Promise<string> {
  if (!(await vault.adapter.exists(basePath))) return basePath;
  for (let i = 2; i < 1000; i++) {
    const p = `${basePath}-${i}`;
    if (!(await vault.adapter.exists(p))) return p;
  }
  throw new Error("폴더 경로 충돌 해결 실패");
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFolder) return;
  if (existing) return; // 같은 경로에 파일이 있는 비정상 상태는 그대로 둔다
  await vault.createFolder(path);
}
