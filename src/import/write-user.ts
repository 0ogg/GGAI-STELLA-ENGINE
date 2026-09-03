/**
 * ST 페르소나 백업을 `GGAI/USERS/<이름>.json` 페르소나 카드들로 쓴다.
 * 이름이 기존 페르소나와 겹치면 건너뛴다(ST 자체 복원 동작과 동일한 정책).
 */

import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import { BASE_FOLDER } from "../constants";
import { uuidv4 } from "../util/uuid";
import type { StellaUserProfile } from "../types/user";
import type { ParsedPersona } from "./parse-sillytavern-persona";

const ROOT = `${BASE_FOLDER}/USERS`;

export interface WriteUsersResult {
  created: { userFile: string; name: string }[];
  skipped: { name: string; reason: string }[];
  /** 백업에서 기본 페르소나였던 것 — 참고용, 활성 페르소나로 자동 전환하지 않는다. */
  defaultName: string | null;
}

export async function writeImportedPersonas(
  vault: Vault,
  personas: ParsedPersona[]
): Promise<WriteUsersResult> {
  const result: WriteUsersResult = { created: [], skipped: [], defaultName: null };
  if (personas.length === 0) return result;

  if (!(await ensureFolder(vault))) {
    for (const p of personas) {
      result.skipped.push({ name: p.name, reason: "USERS 폴더 생성 실패" });
    }
    return result;
  }

  const existingNames = new Set(
    (await existingProfileNames(vault)).map((n) => n.toLowerCase())
  );
  const now = Date.now();

  for (const persona of personas) {
    if (persona.isDefault) result.defaultName = persona.name;

    if (existingNames.has(persona.name.toLowerCase())) {
      result.skipped.push({
        name: persona.name,
        reason: "같은 이름의 페르소나가 이미 있어 건너뜀",
      });
      continue;
    }

    const profile: StellaUserProfile = {
      id: uuidv4(),
      name: persona.name,
      description: persona.description,
      aliases: [],
      favorite: false,
      createdAt: now,
      modifiedAt: now,
    };

    const file = await resolveUniqueFile(vault, sanitizeName(persona.name) || "User");
    await vault.create(file, JSON.stringify(profile, null, 2));
    existingNames.add(persona.name.toLowerCase());
    result.created.push({ userFile: file, name: persona.name });
  }

  return result;
}

async function existingProfileNames(vault: Vault): Promise<string[]> {
  const folder = vault.getAbstractFileByPath(ROOT);
  if (!(folder instanceof TFolder)) return [];
  const names: string[] = [];
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "json") continue;
    try {
      const raw = JSON.parse(await vault.read(child));
      if (typeof raw?.name === "string" && raw.name.trim()) names.push(raw.name.trim());
    } catch {
      // 손상된 파일은 이름 목록에서 제외 — 겹침 판정에만 쓰이므로 무시해도 안전.
    }
  }
  return names;
}

async function resolveUniqueFile(vault: Vault, baseName: string): Promise<string> {
  const first = normalizePath(`${ROOT}/${baseName}.json`);
  if (!(await vault.adapter.exists(first))) return first;
  for (let i = 2; i < 1000; i++) {
    const p = normalizePath(`${ROOT}/${baseName}-${i}.json`);
    if (!(await vault.adapter.exists(p))) return p;
  }
  throw new Error("페르소나 파일 경로 충돌 해결 실패");
}

async function ensureFolder(vault: Vault): Promise<boolean> {
  if (await vault.adapter.exists(ROOT)) return true;
  try {
    if (!(await vault.adapter.exists(BASE_FOLDER))) {
      await vault.createFolder(BASE_FOLDER);
    }
    await vault.createFolder(ROOT);
    return true;
  } catch {
    return false;
  }
}

function sanitizeName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\n\r]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
