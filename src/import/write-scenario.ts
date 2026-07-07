import { Vault, normalizePath } from "obsidian";
import { BASE_FOLDER } from "../constants";
import { ImportedScenario } from "../types/scenario";
import { writeLorebook, WriteLorebookResult } from "./write-lorebook";

/** PNG/APNG 캐릭터카드 임포트 시 함께 저장할 원본 이미지. */
export interface ScenarioThumbnailInput {
  bytes: Uint8Array;
  ext: "png" | "apng" | "jpg" | "jpeg" | "webp";
}

export interface WriteScenarioResult {
  ok: boolean;
  folder: string;
  scenarioFile: string;
  thumbnailFile?: string;
  lorebook?: WriteLorebookResult;
  errors: { path: string; message: string }[];
}

/**
 * 임포트된 시나리오(+선택적 파생 로어북)를 vault 에 쓴다.
 *
 *  - `GGAI/SCENARIOS/[이름]/scenario.json`      (CCv3 JSON)
 *  - `GGAI/SCENARIOS/[이름]/thumbnail.png`       (PNG 카드에서 임포트한 경우 원본 이미지 보존)
 *  - `GGAI/SCENARIOS/[이름]/SESSIONS/`          (빈 폴더)
 *  - character_book 이 있었으면 별도 로어북으로도 `GGAI/LOREBOOKS/` 에 저장
 *
 * 폴더 이름 충돌 시 `-2`, `-3` … 접미사로 구분.
 */
export async function writeScenario(
  vault: Vault,
  imported: ImportedScenario,
  thumbnail?: ScenarioThumbnailInput
): Promise<WriteScenarioResult> {
  const result: WriteScenarioResult = {
    ok: false,
    folder: "",
    scenarioFile: "",
    errors: [],
  };

  const safeName = sanitizeName(imported.scenario.data.name) || "시나리오";
  const folder = await uniquePath(
    vault,
    normalizePath(`${BASE_FOLDER}/SCENARIOS/${safeName}`)
  );
  result.folder = folder;

  try {
    await vault.createFolder(folder);
    await vault.createFolder(`${folder}/SESSIONS`);
  } catch (err) {
    result.errors.push({ path: folder, message: errMsg(err) });
    return result;
  }

  // 1) 썸네일 이미지 먼저 저장 (시나리오 JSON 쓰기 전에 stella.thumbnail 업데이트용)
  if (thumbnail) {
    const thumbPath = `${folder}/thumbnail.${thumbnail.ext}`;
    try {
      // Uint8Array 를 독립 ArrayBuffer 로 복사 (subarray 안전하게 처리)
      const copy = new Uint8Array(thumbnail.bytes);
      await vault.createBinary(thumbPath, copy.buffer);
      result.thumbnailFile = thumbPath;

      // stella.thumbnail 에 상대 경로 (파일명만) 기록 — 뷰에서 시나리오 폴더 기준으로 해석
      if (imported.scenario.data.extensions?.stella) {
        imported.scenario.data.extensions.stella.thumbnail = `thumbnail.${thumbnail.ext}`;
      }

      // CCv3 assets 에도 main 아이콘 참조 추가 (익스포트 호환)
      if (!Array.isArray(imported.scenario.data.assets)) {
        imported.scenario.data.assets = [];
      }
      const hasMainIcon = imported.scenario.data.assets.some(
        (a) => a.type === "icon" && a.name === "main"
      );
      if (!hasMainIcon) {
        imported.scenario.data.assets.push({
          type: "icon",
          uri: `thumbnail.${thumbnail.ext}`,
          name: "main",
          ext: thumbnail.ext,
        });
      }
    } catch (err) {
      result.errors.push({ path: thumbPath, message: errMsg(err) });
    }
  }

  // 2) 파생 로어북을 먼저 디스크에 써서 id 가 stella.defaultLorebookId 로 들어가게 한다.
  //    캐릭터카드에서 임포트한 경우 캐릭터 PNG 도 로어북 폴더에 같이 넣어 썸네일로 쓴다 (L3c).
  if (imported.lorebook) {
    result.lorebook = await writeLorebook(vault, imported.lorebook, thumbnail);
    if (result.lorebook.ok) {
      const stella = imported.scenario.data.extensions?.stella;
      if (stella) stella.defaultLorebookId = imported.lorebook.meta.id;
    }
  }

  // 3) 시나리오 JSON
  const scenarioPath = `${folder}/scenario.json`;
  result.scenarioFile = scenarioPath;
  try {
    await vault.create(scenarioPath, JSON.stringify(imported.scenario, null, 2));
  } catch (err) {
    result.errors.push({ path: scenarioPath, message: errMsg(err) });
  }

  result.ok = result.errors.length === 0;
  return result;
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
