import { TFile, Vault, normalizePath } from "obsidian";
import { BASE_FOLDER } from "../constants";
import type { StellaGroup } from "../types/group";
import { createBlankGroup } from "./new-group";

/** 그룹 폴더(및 내부 전체)를 옵시디언 휴지통으로 이동. */
export async function trashGroup(vault: Vault, folderPath: string): Promise<void> {
  const f = vault.getAbstractFileByPath(folderPath);
  if (!f) return;
  await vault.trash(f, true);
}

/** group.json 을 다시 직렬화해 덮어쓴다. */
export async function saveGroupJson(
  vault: Vault,
  groupFile: string,
  group: StellaGroup
): Promise<void> {
  group.modifiedAt = Date.now();
  const text = JSON.stringify(group, null, 2);
  const file = vault.getAbstractFileByPath(groupFile);
  if (file instanceof TFile) {
    await vault.modify(file, text);
  } else {
    await vault.create(groupFile, text);
  }
}

/**
 * 새 그룹을 만든다. 이름 충돌 시 `-2`, `-3` 접미사 자동 부여.
 * 세션 폴더는 이 시점에 만들지 않는다 (세션 호스팅 위치는 시작/초대 슬라이스에서 결정).
 * @returns 생성된 폴더 경로 + group.json 경로 + 그룹 객체(id 확인용)
 */
export async function createNewGroup(
  vault: Vault,
  name: string,
  memberScenarioIds: string[] = []
): Promise<{ folder: string; groupFile: string; group: StellaGroup }> {
  const { group } = createBlankGroup(name, memberScenarioIds);

  const safe = sanitizeName(name) || "그룹";
  const folder = await uniquePath(
    vault,
    normalizePath(`${BASE_FOLDER}/GROUPS/${safe}`)
  );
  await vault.createFolder(folder);
  const groupFile = `${folder}/group.json`;
  await vault.create(groupFile, JSON.stringify(group, null, 2));
  return { folder, groupFile, group };
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
