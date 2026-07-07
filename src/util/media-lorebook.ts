/**
 * 미디어(번역 / 삽화 프롬프트 생성)용 로어북 해석 + 본문 매칭.
 *
 * 메인 컨텍스트 빌더와 같은 매칭 엔진(`matchLorebookEntries`)을 재사용하되,
 * 스캔 대상은 "지금 번역/삽화할 본문"이다 — 그 본문에 등장하는 키의 엔트리만
 * (그리고 constant 엔트리) 골라 content 를 이어붙여 프롬프트에 끼울 텍스트로 만든다.
 */

import type { StellaLorebook } from "../types/lorebook";
import type { StellaStore } from "../state/store";
import { matchLorebookEntries } from "./lorebook-match";

/** id 목록으로 로어북 객체를 로드한다. 사라진 id 는 조용히 스킵. */
export async function loadMediaLorebooks(
  store: StellaStore,
  ids: string[] | undefined
): Promise<StellaLorebook[]> {
  if (!ids || ids.length === 0) return [];
  const out: StellaLorebook[] = [];
  for (const id of ids) {
    const item = await store.getLorebookById(id);
    if (item) out.push(item.lorebook);
  }
  return out;
}

/** 본문(scanText)에 매칭되는 로어북 엔트리 content 를 이어붙인다. 없으면 빈 문자열. */
export function buildLorebookText(
  books: StellaLorebook[],
  scanText: string
): string {
  if (books.length === 0) return "";
  const matched = matchLorebookEntries(books, {
    recentMessages: [scanText],
    activeText: scanText,
  });
  return matched
    .map((m) => m.entry.content.trim())
    .filter((c) => c.length > 0)
    .join("\n");
}
