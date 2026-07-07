import { Vault } from "obsidian";
import { detectFormat, ImportFormat } from "./detect";
import { parseSillyTavernWorldInfo } from "./parse-sillytavern";
import { parseNovelAILorebook } from "./parse-novelai";
import { parseNovelAIScenario } from "./parse-novelai-scenario";
import { parseNovelAIStory, NaiStoryProgress } from "./parse-nai-story";
import { parseCharacterCard } from "./parse-charactercard";
import { parseCharx } from "./parse-charx";
import { extractCharacterCardJsonFromPng } from "./png-chunk";
import { writeLorebook, WriteLorebookResult } from "./write-lorebook";
import { writePromptPresetFromImport, WritePromptResult } from "./write-prompt";
import { uuidv4 } from "../util/uuid";
import { writeScenario, WriteScenarioResult } from "./write-scenario";

/**
 * 임포트 디스패처 결과.
 * 에이전트 tool 로 노출하기 좋도록 JSON-직렬화 가능한 형태로만 반환.
 *
 * SillyTavern 프리셋(.json) 임포트는 **프롬프트 세트만** 추출한다.
 * 모델/파라미터는 가져오지 않는다 (이 플러그인의 프리셋 구조와 다르므로).
 * 사용자는 우측 사이드바에서 `+` 로 직접 프리셋(북마크) 을 만든다.
 */
export type ImportResult =
  | { kind: "lorebook"; format: ImportFormat; write: WriteLorebookResult }
  | {
      kind: "scenario";
      format: ImportFormat;
      write: WriteScenarioResult;
      /** NAI .story 임포트에만 존재 — 출처(ai/user) 보존 진행분 + 메모리/작가노트 내용. */
      story?: NaiStoryProgress;
    }
  | { kind: "prompt"; format: ImportFormat; write: WritePromptResult }
  | { kind: "error"; format: ImportFormat | "unknown"; error: string };

/**
 * 단일 파일을 읽어 포맷을 판별하고 vault 에 기록한다.
 *
 * 지원 입력:
 *  - `.json` / `.lorebook` : SillyTavern 월드인포, NovelAI 로어북, CCv3/V2/V1 캐릭터카드 JSON
 *  - `.png` / `.apng`       : CCv3(ccv3 청크) 또는 V2(chara 청크) 캐릭터카드 이미지
 *
 * 에러는 throw 하지 않고 결과 객체로 반환한다 (부분 성공 허용).
 */
export async function importFile(
  bytes: Uint8Array,
  filename: string,
  vault: Vault
): Promise<ImportResult> {
  const lower = filename.toLowerCase();

  // 1) 이미지 캐릭터카드 (PNG/APNG) — 원본 이미지도 썸네일로 보존한다
  if (lower.endsWith(".png") || lower.endsWith(".apng")) {
    try {
      const extracted = extractCharacterCardJsonFromPng(bytes);
      if (!extracted) {
        return {
          kind: "error",
          format: "unknown",
          error: "PNG 에 ccv3/chara 청크가 없습니다.",
        };
      }
      const imported = parseCharacterCard(extracted.data);
      const format: ImportFormat =
        extracted.chunk === "ccv3" ? "charactercard-v3" : "charactercard-v2";
      const ext = lower.endsWith(".apng") ? "apng" : "png";
      return {
        kind: "scenario",
        format,
        write: await writeScenario(vault, imported, { bytes, ext }),
      };
    } catch (err) {
      return { kind: "error", format: "unknown", error: errMsg(err) };
    }
  }

  // 2) CHARX: ZIP 컨테이너 (card.json + assets/)
  if (lower.endsWith(".charx")) {
    try {
      const parsed = await parseCharx(bytes);
      return {
        kind: "scenario",
        format: "charx",
        write: await writeScenario(vault, parsed.imported, parsed.thumbnail),
      };
    } catch (err) {
      return { kind: "error", format: "charx", error: errMsg(err) };
    }
  }

  // 3) JSON 계열 (.json / .lorebook / 기타)
  let data: any;
  try {
    data = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (err) {
    return {
      kind: "error",
      format: "unknown",
      error: `JSON 파싱 실패: ${errMsg(err)}`,
    };
  }

  const format = detectFormat(data);
  const fallbackName = filename.replace(/\.[^.]+$/, "");

  switch (format) {
    case "sillytavern-worldinfo": {
      const book = parseSillyTavernWorldInfo(data, fallbackName);
      return { kind: "lorebook", format, write: await writeLorebook(vault, book) };
    }
    case "sillytavern-prompt-preset": {
      // 호환성 보존: raw JSON 그대로 vault 에 쓴다 (stella 메타만 주입).
      // 사용 시점에는 prompts + prompt_order 만 읽는다.
      return {
        kind: "prompt",
        format,
        write: await writePromptPresetFromImport(vault, fallbackName, data, {
          id: uuidv4(),
          favorite: false,
        }),
      };
    }
    case "novelai-lorebook": {
      const book = parseNovelAILorebook(data, fallbackName);
      return { kind: "lorebook", format, write: await writeLorebook(vault, book) };
    }
    case "novelai-scenario": {
      const imported = parseNovelAIScenario(data);
      return {
        kind: "scenario",
        format,
        write: await writeScenario(vault, imported),
      };
    }
    case "novelai-story": {
      try {
        const parsed = parseNovelAIStory(data);
        return {
          kind: "scenario",
          format,
          write: await writeScenario(vault, parsed.imported),
          story: parsed.progress,
        };
      } catch (err) {
        return { kind: "error", format, error: errMsg(err) };
      }
    }
    case "charactercard-v3":
    case "charactercard-v2":
    case "charactercard-v1": {
      const imported = parseCharacterCard(data);
      return {
        kind: "scenario",
        format,
        write: await writeScenario(vault, imported),
      };
    }
    default:
      return {
        kind: "error",
        format: "unknown",
        error: "알 수 없는 JSON 포맷입니다 (시그니처 불일치).",
      };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 편의 재노출
export { detectFormat } from "./detect";
export type { ImportFormat } from "./detect";
