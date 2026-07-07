/**
 * 통합 로어북을 `GGAI/LOREBOOKS/[name]/lorebook.json` 단일 JSON 으로 저장한다.
 *
 *  - 폴더 안에 `lorebook.json` 하나. 향후 `assets/` 등 부산물 추가 여지.
 *  - thumbnail 옵션이 주어지면 `thumbnail.<ext>` 도 같이 저장하고 meta.thumbnail 갱신 (L3c).
 *  - 같은 이름 폴더에 레거시 마크다운 분해 형태(`_lorebook.md`) 가 있으면
 *    `conflicted: "legacy-markdown"` 으로 중단.
 *  - 정상 폴더 충돌 시 `-2`, `-3` 접미사로 새 폴더.
 */

import { Vault, normalizePath } from "obsidian";
import { BASE_FOLDER } from "../constants";
import { StellaLorebook } from "../types/lorebook";

/** 로어북 폴더에도 같이 저장할 썸네일 (L3c — 캐릭터카드의 캐릭터 이미지 등). */
export interface LorebookThumbnailInput {
  bytes: Uint8Array;
  ext: "png" | "apng" | "jpg" | "jpeg" | "webp";
}

export type WriteLorebookResult =
  | {
      ok: true;
      conflicted: false;
      folder: string;
      file: string;
      thumbnailFile?: string;
    }
  | {
      ok: false;
      conflicted: "legacy-markdown" | "name-collision-unresolved";
      folder: string;
      reason: string;
    };

export async function writeLorebook(
  vault: Vault,
  book: StellaLorebook,
  thumbnail?: LorebookThumbnailInput
): Promise<WriteLorebookResult> {
  const safeName = sanitizeName(book.meta.name) || "로어북";
  const baseFolder = normalizePath(`${BASE_FOLDER}/LOREBOOKS/${safeName}`);

  if (await vault.adapter.exists(`${baseFolder}/_lorebook.md`)) {
    return {
      ok: false,
      conflicted: "legacy-markdown",
      folder: baseFolder,
      reason: "기존 마크다운 분해 폴더(_lorebook.md)가 존재합니다. 폴더를 옮기거나 이름을 바꾼 뒤 다시 임포트하세요.",
    };
  }

  const folder = await uniquePath(vault, baseFolder);
  try {
    await vault.createFolder(folder);
  } catch (err) {
    return {
      ok: false,
      conflicted: "name-collision-unresolved",
      folder,
      reason: `폴더 생성 실패: ${errMsg(err)}`,
    };
  }

  // 썸네일 먼저 저장해서 meta.thumbnail 박은 채로 lorebook.json 직렬화.
  let thumbnailFile: string | undefined;
  if (thumbnail) {
    const path = `${folder}/thumbnail.${thumbnail.ext}`;
    try {
      const copy = new Uint8Array(thumbnail.bytes);
      await vault.createBinary(path, copy.buffer);
      thumbnailFile = path;
      book.meta.thumbnail = `thumbnail.${thumbnail.ext}`;
    } catch (err) {
      // 썸네일 실패는 치명적이지 않음 — 본문은 계속.
      console.warn("[GGAI Stella] 로어북 썸네일 저장 실패:", path, err);
    }
  }

  const file = `${folder}/lorebook.json`;
  await vault.create(file, JSON.stringify(book, null, 2));

  return { ok: true, conflicted: false, folder, file, thumbnailFile };
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
