import { Vault } from "obsidian";
import { BASE_FOLDER, SUBFOLDERS } from "../constants";

/**
 * ensureBaseFolders
 * ---------------------------------------------------------------
 * vault 루트에 GGAI/ 및 그 하위 필수 폴더들을 생성한다.
 * 이미 존재하면 건너뛴다 (멱등).
 *
 * 설계 원칙:
 * - 에이전트 tool로 나중에 노출 가능하도록 순수하게 유지.
 * - 입력: vault 하나. 출력: JSON-직렬화 가능한 결과 객체.
 * - throw 하지 않음 → 부분 실패 시에도 가능한 폴더는 생성.
 *
 * @returns 생성된/건너뛴/실패한 경로 목록
 */
export interface EnsureBaseFoldersResult {
  created: string[];
  skipped: string[];
  errors: { path: string; message: string }[];
}

export async function ensureBaseFolders(
  vault: Vault
): Promise<EnsureBaseFoldersResult> {
  const result: EnsureBaseFoldersResult = {
    created: [],
    skipped: [],
    errors: [],
  };

  // 베이스 + 하위 폴더 경로를 순서대로 생성 시도
  const paths: string[] = [
    BASE_FOLDER,
    ...SUBFOLDERS.map((name) => `${BASE_FOLDER}/${name}`),
  ];

  for (const path of paths) {
    try {
      const exists = await vault.adapter.exists(path);
      if (exists) {
        result.skipped.push(path);
        continue;
      }
      await vault.createFolder(path);
      result.created.push(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ path, message });
    }
  }

  return result;
}
