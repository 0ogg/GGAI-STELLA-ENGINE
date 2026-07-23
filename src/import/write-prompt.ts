/**
 * 프롬프트 세트를 `GGAI/PROMPTS/[이름].json` 단일 JSON 파일로 저장한다.
 *
 * 저장 정책 (사용자 결정):
 *   - 임포트는 **원본 JSON 그대로** 디스크에 둔다 (호환성 보존). stella 메타(id/favorite)
 *     만 추가 박은 다음 그대로 vault 에 기록.
 *   - 사용자가 사이드바에서 편집한 경우, 디스크에 이미 있는 raw 의 `prompts[]` 와
 *     `prompt_order[character_id=100000].order[]` 만 우리 데이터로 덮어쓰고,
 *     나머지 ST 메타(temperature 등) 는 **그대로 보존**.
 *   - 새로 만드는 세트는 ST 호환 형태 (`{prompts, prompt_order, stella}`) 로 저장.
 *
 * 폴더 사용 안 함. 프롬프트는 애셋이 없으므로.
 */

import { Vault, normalizePath, TFile } from "obsidian";
import { BASE_FOLDER } from "../constants";
import {
  StellaPromptItem,
  StellaPromptPreset,
  StellaPromptTextItem,
} from "../types/prompt";

export type WritePromptResult =
  | {
      ok: true;
      file: string;
    }
  | {
      ok: false;
      reason: string;
    };

/**
 * 임포트 경로 — ST raw 를 그대로 저장 (stella 메타만 주입).
 *
 * @param vault
 * @param name  파일 이름 (확장자 제외). 충돌 시 -2, -3 접미사.
 * @param raw   ST 프리셋 원본 JSON 객체.
 * @param stella  주입할 stella 메타. 없으면 새로 생성.
 */
export async function writePromptPresetFromImport(
  vault: Vault,
  name: string,
  raw: any,
  stella: { id: string; favorite: boolean }
): Promise<WritePromptResult> {
  const safeName = sanitizeName(name) || "프리셋";
  const targetPath = await uniqueFilePath(vault, safeName);
  if (!(await ensurePromptsFolder(vault))) {
    return { ok: false, reason: "GGAI/PROMPTS 폴더 생성 실패" };
  }
  const out = { ...(raw && typeof raw === "object" ? raw : {}) };
  out.stella = { id: stella.id, favorite: stella.favorite };
  try {
    await vault.create(targetPath, JSON.stringify(out, null, 2));
  } catch (err) {
    return { ok: false, reason: `파일 생성 실패: ${errMsg(err)}` };
  }
  return { ok: true, file: targetPath };
}

/**
 * 신규/편집 경로 — 우리 데이터 모델 (StellaPromptPreset) 을 ST 호환 형태로 직렬화.
 * 디스크에 이미 raw 가 있으면 prompts/prompt_order/stella 만 갱신하고 다른 ST 필드는 보존.
 */
export async function writePromptPresetFile(
  vault: Vault,
  filePath: string,
  preset: StellaPromptPreset
): Promise<void> {
  let raw: any = {};
  const f = vault.getAbstractFileByPath(filePath);
  if (f instanceof TFile) {
    try {
      const text = await vault.read(f);
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") raw = parsed;
    } catch {
      // 파싱 실패하면 새로 만든다.
    }
  }

  raw.prompts = preset.prompts.map(serializeItem);
  if (!Array.isArray(raw.prompt_order)) raw.prompt_order = [];
  // 현재 ST 는 100001(global) 블록을 읽는다. 100000 은 구버전 블록.
  // 파일에 있는 두 블록 모두 갱신해 서로 어긋난 순서가 남지 않게 한다.
  const blocks = raw.prompt_order.filter(
    (b: any) =>
      b &&
      typeof b === "object" &&
      (b.character_id === 100000 || b.character_id === 100001)
  );
  if (blocks.length === 0) {
    const block = { character_id: 100001, order: [] };
    raw.prompt_order.unshift(block);
    blocks.push(block);
  }
  const order = preset.prompts.map((p) => ({
    identifier: p.identifier,
    enabled: p.enabled,
  }));
  for (const block of blocks) block.order = order.map((o) => ({ ...o }));
  raw.stella = { id: preset.meta.id, favorite: preset.meta.favorite };

  const body = JSON.stringify(raw, null, 2);
  if (f instanceof TFile) {
    await vault.modify(f, body);
  } else {
    if (!(await ensurePromptsFolder(vault))) {
      throw new Error("GGAI/PROMPTS 폴더 생성 실패");
    }
    await vault.create(filePath, body);
  }
}

/** 파일 경로 보장: 충돌 시 -2, -3 접미사. */
export async function resolveUniquePromptFile(
  vault: Vault,
  name: string
): Promise<string> {
  const safeName = sanitizeName(name) || "프리셋";
  return uniqueFilePath(vault, safeName);
}

// ─── helpers ─────────────────────────────────────────────────────

function serializeItem(item: StellaPromptItem): any {
  if (item.kind === "marker") {
    const obj: any = {
      identifier: item.identifier,
      name: item.name,
      system_prompt: true,
      marker: true,
    };
    // Stella 전용 본문 가공 템플릿 — ST 는 무시, 라운드트립 보존.
    if (item.wrap !== undefined) obj.stella_wrap = item.wrap;
    // Stella 전용 소설모드 히스토리 롤 — ST 는 무시, 라운드트립 보존.
    if (item.historyRole !== undefined) obj.stella_history_role = item.historyRole;
    return obj;
  }
  const text = item as StellaPromptTextItem;
  const obj: any = {
    identifier: text.identifier,
    name: text.name,
    role: text.role,
    content: text.content,
    system_prompt: true,
  };
  if (text.injectionPosition !== undefined) {
    obj.injection_position = text.injectionPosition;
  }
  if (text.injectionDepth !== undefined) {
    obj.injection_depth = text.injectionDepth;
  }
  if (text.injectionOrder !== undefined) {
    obj.injection_order = text.injectionOrder;
  }
  if (text.injectionTrigger && text.injectionTrigger.length > 0) {
    obj.injection_trigger = text.injectionTrigger;
  }
  if (text.forbidOverrides) obj.forbid_overrides = true;
  return obj;
}

async function ensurePromptsFolder(vault: Vault): Promise<boolean> {
  const path = `${BASE_FOLDER}/PROMPTS`;
  if (await vault.adapter.exists(path)) return true;
  try {
    await vault.createFolder(path);
    return true;
  } catch {
    return false;
  }
}

async function uniqueFilePath(vault: Vault, baseName: string): Promise<string> {
  const root = `${BASE_FOLDER}/PROMPTS`;
  const first = normalizePath(`${root}/${baseName}.json`);
  if (!(await vault.adapter.exists(first))) return first;
  for (let i = 2; i < 1000; i++) {
    const p = normalizePath(`${root}/${baseName}-${i}.json`);
    if (!(await vault.adapter.exists(p))) return p;
  }
  throw new Error("프롬프트 파일 경로 충돌 해결 실패");
}

function sanitizeName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\n\r]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
