/**
 * 로어북 자동 생성 — 순수 로직 (로어북 확장).
 *
 * 주기마다 새로 쌓인 본문을 모델에게 주고, 아직 로어북에 없는 새 인물/사건/고유명사를
 * `[{"title","keys","content"}]` JSON 배열로 받아 세션 전용 로어북에 항목으로 쌓는다.
 * 여기는 기존 항목 목록 생성/응답 파싱만 담당한다 — 지시문은 편집 가능한 미디어
 * 프롬프트(mediaPrompts.lorebookGen, `{{lorebook}}` = 기존 항목 목록 / `{{main}}` =
 * 새 본문)이고, 모델 호출과 저장은 LorebookGenService 가 한다.
 */

import type { StellaLorebook } from "../types/lorebook";

/** 자동 생성 주기 기본값 — 마지막 스캔 앵커 이후 AI 생성 횟수. */
export const DEFAULT_LOREBOOK_GEN_INTERVAL = 10;
/** 한 번에 스캔할 새 본문 상한(자) 기본값 — 설정("스캔 본문 상한")으로 변경 가능. */
export const DEFAULT_LOREBOOK_GEN_MAX_CHARS = 30000;

/** 모델이 제안한 새 항목 하나 (파싱 결과). */
export interface GeneratedLorebookEntry {
  title: string;
  keys: string[];
  content: string;
}

/**
 * 기존 항목 목록 텍스트 — 프롬프트의 `{{lorebook}}` 자리에 들어간다.
 * 활성 로어북 전체의 제목+키워드를 보여줘 이미 있는 항목의 중복 생성을 막는다.
 */
export function renderExistingEntriesText(books: StellaLorebook[]): string {
  const lines: string[] = [];
  for (const book of books) {
    for (const entry of book.entries) {
      const name = entry.name.trim() || "(untitled)";
      const keys = entry.keys.filter((k) => k.trim()).join(", ");
      lines.push(keys ? `- ${name} (${keys})` : `- ${name}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(none yet)";
}

/**
 * 응답에서 새 항목 배열을 파싱 — 마지막 `[...]` 블록을 JSON 으로 읽는다.
 * title/keys/content 가 온전한 오브젝트만 남긴다(키워드는 문자열 배열로 정규화,
 * 빈 키워드는 title 로 보충). 배열이 없거나 형식이 깨졌으면 null, 빈 배열([]
 * = "새 항목 없음")은 그대로 [] 를 반환한다.
 */
export function parseLorebookGenResponse(
  text: string
): GeneratedLorebookEntry[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: GeneratedLorebookEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (!title || !content) continue;
    const rawKeys = Array.isArray(o.keys) ? o.keys : [];
    const keys = rawKeys
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.trim())
      .filter((k) => k !== "");
    out.push({ title, keys: keys.length > 0 ? keys : [title], content });
  }
  return out;
}

/**
 * 기존 항목과의 중복 제거 — 제목이 같거나(대소문자 무시) 키워드 전부가 이미 한
 * 항목에 있는 제안은 버린다. 모델의 "이미 있는 건 빼라" 지시를 어긴 경우의 방어막.
 */
export function dedupeGeneratedEntries(
  proposals: GeneratedLorebookEntry[],
  books: StellaLorebook[]
): GeneratedLorebookEntry[] {
  const existingNames = new Set<string>();
  const existingKeySets: Set<string>[] = [];
  for (const book of books) {
    for (const entry of book.entries) {
      const name = entry.name.trim().toLowerCase();
      if (name) existingNames.add(name);
      const set = new Set(
        entry.keys.map((k) => k.trim().toLowerCase()).filter((k) => k !== "")
      );
      if (set.size > 0) existingKeySets.push(set);
    }
  }
  const seenTitles = new Set<string>();
  return proposals.filter((p) => {
    const title = p.title.toLowerCase();
    if (existingNames.has(title) || seenTitles.has(title)) return false;
    const keys = p.keys.map((k) => k.toLowerCase());
    const covered = existingKeySets.some((set) =>
      keys.every((k) => set.has(k))
    );
    if (covered) return false;
    seenTitles.add(title);
    return true;
  });
}
