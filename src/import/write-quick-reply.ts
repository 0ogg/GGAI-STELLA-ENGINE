/**
 * QR 세트를 `GGAI/QUICKREPLIES/<이름>.json` 단일 JSON 으로 저장한다.
 * 파일 shape 은 ST QR v2 export 그대로 + `stella` 메타 (QR 스펙.md).
 */

import { normalizePath, TFile, Vault } from "obsidian";
import { BASE_FOLDER } from "../constants";
import {
  serializeQuickReplySet,
  type StellaQuickReplySet,
} from "../types/quick-reply";

const ROOT = `${BASE_FOLDER}/QUICKREPLIES`;

export async function writeQuickReplySetFile(
  vault: Vault,
  filePath: string,
  set: StellaQuickReplySet
): Promise<void> {
  const body = JSON.stringify(serializeQuickReplySet(set), null, 2);
  const f = vault.getAbstractFileByPath(filePath);
  if (f instanceof TFile) {
    await vault.modify(f, body);
    return;
  }
  if (!(await ensureFolder(vault))) {
    throw new Error(`${ROOT} 폴더 생성 실패`);
  }
  await vault.create(filePath, body);
}

/** 파일 경로 보장: 충돌 시 -2, -3 접미사. */
export async function resolveUniqueQuickReplyFile(
  vault: Vault,
  name: string
): Promise<string> {
  const safe = sanitizeName(name) || "빠른 답장";
  const first = normalizePath(`${ROOT}/${safe}.json`);
  if (!(await vault.adapter.exists(first))) return first;
  for (let i = 2; i < 1000; i++) {
    const p = normalizePath(`${ROOT}/${safe}-${i}.json`);
    if (!(await vault.adapter.exists(p))) return p;
  }
  throw new Error("QR 세트 파일 경로 충돌 해결 실패");
}

async function ensureFolder(vault: Vault): Promise<boolean> {
  if (await vault.adapter.exists(ROOT)) return true;
  try {
    // GGAI 가 없으면 중간 경로가 자동 생성되지 않는 버전 대응.
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
