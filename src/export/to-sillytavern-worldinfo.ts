/**
 * 통합 로어북 → SillyTavern 월드인포 JSON (익스포트).
 *
 * `parse-sillytavern.ts` 의 역방향이다. 두 함수의 필드 대응이 어긋나면 왕복이 깨지므로
 * 매핑을 바꿀 때는 반드시 양쪽을 같이 고친다.
 *
 * ST 는 `entries` 를 **숫자 uid 키의 딕셔너리**로 읽는다. 우리 uid 는 UUID 문자열이라
 * 익스포트 시점에 0부터 다시 번호를 매긴다 (책 안에서만 유효한 값이라 안전).
 *
 * 순수 함수 — vault 접근 없음.
 */

import type { StellaLorebook, StellaLorebookEntry } from "../types/lorebook";

/** 통합 position → ST position 번호. */
const POSITION_NUM: Record<StellaLorebookEntry["position"], number> = {
  before_char: 0,
  after_char: 1,
  before_examples: 2,
  after_examples: 3,
  at_depth: 4,
};

/** 통합 role → ST role 번호. */
const ROLE_NUM: Record<StellaLorebookEntry["role"], number> = {
  system: 0,
  user: 1,
  assistant: 2,
};

/** 엔트리 하나를 ST 월드인포 항목으로. `uid` 는 호출부가 매기는 번호. */
export function entryToSillyTavern(
  entry: StellaLorebookEntry,
  uid: number
): Record<string, unknown> {
  return {
    uid,
    key: [...entry.keys],
    keysecondary: [...entry.secondaryKeys],
    comment: entry.name,
    content: entry.content,
    constant: entry.constant,
    vectorized: false,
    selective: entry.selective,
    selectiveLogic: entry.selectiveLogic,
    addMemo: entry.addMemo,
    order: entry.order,
    position: POSITION_NUM[entry.position] ?? 1,
    disable: !entry.enabled,
    excludeRecursion: entry.excludeRecursion,
    preventRecursion: entry.preventRecursion,
    delayUntilRecursion: entry.delayUntilRecursion,
    probability: entry.probability,
    useProbability: true,
    depth: entry.depth,
    group: entry.group,
    groupOverride: false,
    groupWeight: entry.groupWeight,
    scanDepth: entry.scanDepth,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    useGroupScoring: null,
    automationId: "",
    role: ROLE_NUM[entry.role] ?? 0,
    sticky: entry.sticky ?? 0,
    cooldown: entry.cooldown ?? 0,
    delay: entry.delay ?? 0,
    displayIndex: uid,
  };
}

/**
 * 책 하나 → ST 월드인포 파일 내용.
 * ST 는 파일 이름을 책 이름으로 쓰지만, 우리 재임포트가 이름을 잃지 않도록 `name` 도 남긴다
 * (ST 는 모르는 키를 무시한다).
 */
export function lorebookToSillyTavern(book: StellaLorebook): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  book.entries.forEach((entry, i) => {
    entries[String(i)] = entryToSillyTavern(entry, i);
  });
  return { name: book.meta.name, entries };
}
