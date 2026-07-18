/**
 * 로어북 AI 선별 — 순수 로직 (로어북 확장).
 *
 * 생성 직전, 저렴한 모델에게 "엔트리 번호 목록 + 최근 이야기"를 주고 지금 컨텍스트에
 * 넣어야 할 엔트리 번호만 JSON 배열로 받는다. 여기는 목록 생성/응답 파싱만 담당한다 —
 * 지시문 자체는 편집 가능한 미디어 프롬프트(mediaPrompts.lorebookSelect, `{{lorebook}}` =
 * 엔트리 목록 / `{{main}}` = 최근 본문)이고, 모델 호출과 캐시는 LorebookPlusService 가 한다.
 */

import type { StellaLorebook } from "../types/lorebook";
import { composeMediaPrompt } from "./media-prompt-body";

/** 선별 모델에 첨부할 최근 본문 길이(자) 기본값 — 설정("본문 첨부량")으로 변경 가능. */
export const DEFAULT_LOREBOOK_SELECT_CONTEXT_CHARS = 4000;

export interface LorebookCatalogItem {
  /** 매칭 엔진의 강제 활성 키 — `${lorebookId}:${uid}`. */
  key: string;
  /** 모델에게 보여줄 한 줄 설명 (이름/키워드/내용 앞부분). */
  label: string;
}

/** 엔트리 내용 앞부분 — 공백을 접어 한 줄 발췌로. */
function excerpt(content: string, max = 80): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/**
 * 선별 후보 목록 — 활성화된 비상시(non-constant) 엔트리만.
 * constant 엔트리는 어차피 항상 들어가므로 목록에서 제외해 토큰을 아낀다.
 */
export function buildLorebookCatalog(
  books: StellaLorebook[]
): LorebookCatalogItem[] {
  const items: LorebookCatalogItem[] = [];
  for (const book of books) {
    for (const entry of book.entries) {
      if (!entry.enabled || entry.constant) continue;
      const name = entry.name.trim() || "(untitled)";
      const keys = entry.keys.filter((k) => k.trim()).slice(0, 4).join(", ");
      const hint = excerpt(entry.content);
      const parts = [name];
      if (keys) parts.push(`(${keys})`);
      if (hint) parts.push(`— ${hint}`);
      items.push({ key: `${book.meta.id}:${entry.uid}`, label: parts.join(" ") });
    }
  }
  return items;
}

/** 엔트리 번호 목록 텍스트 — 프롬프트의 `{{lorebook}}` 자리에 들어간다. */
export function renderLorebookCatalogText(catalog: LorebookCatalogItem[]): string {
  return catalog.map((item, i) => `${i + 1}. ${item.label}`).join("\n");
}

/**
 * 확장 작업용 선별 프롬프트 결합 — `{{lorebook}}`/`{{main}}` 에 더해 `{{task}}` 자리에
 * "이 로어북이 함께 쓰일 작업 프롬프트 전문"(그 확장의 편집 가능한 프롬프트)을 치환한다.
 * task 본문 안의 {{main}}/{{lorebook}} 매크로가 다시 치환되지 않게 task 를 마지막에
 * 넣는다. 지침에 `{{task}}` 가 없으면 composeMediaPrompt 관례대로 맨 앞에 붙인다.
 */
export function composeLorebookSelectTaskPrompt(
  instruction: string,
  body: string,
  catalogText: string,
  taskText: string
): string {
  const hasTask = /\{\{\s*task\s*\}\}/i.test(instruction);
  const text = composeMediaPrompt(instruction, body, catalogText);
  if (hasTask) return text.replace(/\{\{\s*task\s*\}\}/gi, () => taskText);
  return taskText ? `${taskText}\n\n${text}` : text;
}

/**
 * 응답에서 번호 배열을 파싱 — 마지막 `[...]` 를 JSON 으로 읽고 유효 범위(1..max)의
 * 정수만 남긴다(중복 제거). 텍스트 모델이 오프너("Selection:")를 이어 써서 여는
 * 대괄호 없이 `2, 7, 13]` 처럼 답한 경우도 앞머리 숫자 나열로 받아준다.
 * 형식이 깨졌으면 null.
 */
export function parseLorebookSelectionResponse(
  text: string,
  catalogLength: number
): number[] | null {
  const clamp = (nums: number[]): number[] => {
    const out: number[] = [];
    for (const v of nums) {
      if (!Number.isInteger(v)) continue;
      if (v < 1 || v > catalogLength || out.includes(v)) continue;
      out.push(v);
    }
    return out;
  };

  const matches = text.match(/\[[\d,\s]*\]/g);
  if (matches && matches.length > 0) {
    try {
      const parsed = JSON.parse(matches[matches.length - 1]);
      if (Array.isArray(parsed)) {
        return clamp(parsed.filter((v): v is number => typeof v === "number"));
      }
    } catch {
      // 아래 오프너 완성형 폴백으로.
    }
  }

  // 오프너 완성형 — 응답 앞머리가 숫자 나열(닫는 대괄호 유무 무관)이면 그걸 쓴다.
  const bare = text.trim().match(/^(\d+(?:\s*,\s*\d+)*)\s*\]?/);
  if (bare) return clamp(bare[1].split(",").map((s) => parseInt(s.trim(), 10)));
  return null;
}
