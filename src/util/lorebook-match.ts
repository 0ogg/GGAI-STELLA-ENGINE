/**
 * 로어북 키워드 매칭.
 *
 * - constant=true 항목은 무조건 포함.
 * - 일반 항목은 최근 N 메시지(scanDepth) + 활성 본문에서 keys 매칭.
 * - selective / probability / recursion 은 이 단계에서 stub — 필드는 보존.
 */

import type { StellaLorebook, StellaLorebookEntry } from "../types/lorebook";

export interface LorebookMatchContext {
  /** 세션 최근 N 메시지 텍스트. 끝이 가장 최신. */
  recentMessages: string[];
  /** 현재 편집 중인 본문 (마지막 메시지와 중복될 수 있지만 포함). */
  activeText?: string;
  /** 엔트리의 scanDepth 가 null 일 때 쓸 기본값. */
  defaultScanDepth?: number;
  /** 현재 턴 번호. delay 계산에 사용한다. */
  turnNumber?: number;
  /** 엔트리별 sticky/cooldown 상태. 호출 후 in-place 로 갱신된다. */
  timingStates?: Map<string, EntryTimingState>;
  /** false 면 키워드 매칭을 끈다 — constant/sticky/강제 활성만 들어간다. 생략 시 true. */
  keywordMatching?: boolean;
  /** AI 선별 등으로 강제 활성화할 엔트리 키(`${lorebookId}:${uid}`). 키워드 없이 활성. */
  forcedEntryKeys?: Set<string>;
}

export interface EntryTimingState {
  lastActivatedAt: number;
  stickyRemaining: number;
  cooldownRemaining: number;
}

export interface MatchedLorebookEntry {
  entry: StellaLorebookEntry;
  bookName: string;
}

type InternalMatch = MatchedLorebookEntry & {
  entryKey: string;
  isSticky: boolean;
};

export function matchLorebookEntries(
  books: StellaLorebook[],
  ctx: LorebookMatchContext
): MatchedLorebookEntry[] {
  const defaultDepth = ctx.defaultScanDepth ?? 4;
  const turnNumber = ctx.turnNumber ?? ctx.recentMessages.length;
  const keywordOn = ctx.keywordMatching !== false;
  const matched: InternalMatch[] = [];
  const matchedIds = new Set<string>();
  let recursiveText = "";

  for (let pass = 0; pass < 3; pass++) {
    const passMatched: InternalMatch[] = [];
    const recursiveParts: string[] = [];

    for (const book of books) {
      const bookDefaultDepth = book.meta.scanDepth ?? defaultDepth;

      for (const entry of book.entries) {
        const entryKey = `${book.meta.id}:${entry.uid}`;
        if (!entry.enabled || matchedIds.has(entryKey)) continue;
        if (pass === 0 && entry.delayUntilRecursion) continue;
        if (pass > 0 && entry.preventRecursion) continue;

        const timing = passesTimingGate(entry, entryKey, turnNumber, ctx.timingStates);
        if (!timing.pass) continue;

        const depth = entry.scanDepth ?? bookDefaultDepth;
        const haystack = buildHaystack(ctx, depth, recursiveText);
        // AI 선별 등으로 강제 활성화된 엔트리 — 확률/키워드 게이트 없이 포함.
        const forced = ctx.forcedEntryKeys?.has(entryKey) === true;
        if (!timing.isSticky && !forced && !passesProbability(entry, haystack)) continue;

        if (
          timing.isSticky ||
          entry.constant ||
          forced ||
          (keywordOn && haystackMatchesEntry(entry, haystack))
        ) {
          matchedIds.add(entryKey);
          passMatched.push({
            entry,
            bookName: book.meta.name,
            entryKey,
            isSticky: timing.isSticky,
          });
          if (book.meta.recursiveScanning && !entry.excludeRecursion && entry.content.trim()) {
            recursiveParts.push(entry.content);
          }
        }
      }
    }

    if (passMatched.length === 0) break;
    matched.push(...passMatched);

    const newlyRecursive = recursiveParts.join("\n");
    if (!newlyRecursive.trim()) break;
    recursiveText = recursiveText ? `${recursiveText}\n${newlyRecursive}` : newlyRecursive;
  }

  const selected = applyGroupSelection(matched);
  updateTimingStates(ctx.timingStates, selected, turnNumber);
  return selected.map(({ entry, bookName }) => ({ entry, bookName }));
}

function applyGroupSelection(
  matched: InternalMatch[]
): InternalMatch[] {
  const groups = new Map<string, InternalMatch[]>();
  const ungrouped: InternalMatch[] = [];

  for (const item of matched) {
    const group = item.entry.group.trim();
    if (!group) {
      ungrouped.push(item);
      continue;
    }
    const members = groups.get(group) ?? [];
    members.push(item);
    groups.set(group, members);
  }

  const selected = [...ungrouped];
  for (const members of groups.values()) {
    members.sort(
      (a, b) =>
        b.entry.groupWeight - a.entry.groupWeight ||
        b.entry.order - a.entry.order
    );
    selected.push(members[0]);
  }
  return selected;
}

function passesTimingGate(
  entry: StellaLorebookEntry,
  entryKey: string,
  turnNumber: number,
  states?: Map<string, EntryTimingState>
): { pass: boolean; isSticky: boolean } {
  if ((entry.delay ?? 0) > 0 && turnNumber < (entry.delay ?? 0)) {
    return { pass: false, isSticky: false };
  }

  const state = states?.get(entryKey);
  if (state && state.stickyRemaining > 0) {
    return { pass: true, isSticky: true };
  }
  if (state && state.cooldownRemaining > 0) {
    return { pass: false, isSticky: false };
  }
  return { pass: true, isSticky: false };
}

function updateTimingStates(
  states: Map<string, EntryTimingState> | undefined,
  activated: InternalMatch[],
  turnNumber: number
): void {
  if (!states) return;

  for (const [key, state] of states) {
    const next: EntryTimingState = {
      lastActivatedAt: state.lastActivatedAt,
      stickyRemaining: Math.max(0, state.stickyRemaining - 1),
      cooldownRemaining: Math.max(0, state.cooldownRemaining - 1),
    };
    if (next.stickyRemaining === 0 && next.cooldownRemaining === 0) {
      states.delete(key);
    } else {
      states.set(key, next);
    }
  }

  for (const item of activated) {
    if (item.isSticky) continue;
    const stickyRemaining = Math.max(0, item.entry.sticky ?? 0);
    const cooldownRemaining = Math.max(0, item.entry.cooldown ?? 0);
    if (stickyRemaining === 0 && cooldownRemaining === 0) continue;
    states.set(item.entryKey, {
      lastActivatedAt: turnNumber,
      stickyRemaining,
      cooldownRemaining,
    });
  }
}

function buildHaystack(
  ctx: LorebookMatchContext,
  depth: number,
  recursiveText: string
): string {
  const scanned = ctx.recentMessages.slice(-depth);
  if (ctx.activeText && scanned[scanned.length - 1] !== ctx.activeText) {
    scanned.push(ctx.activeText);
  }
  if (recursiveText.trim()) scanned.push(recursiveText);
  return scanned.join("\n");
}

function passesProbability(entry: StellaLorebookEntry, haystack: string): boolean {
  if (entry.probability <= 0) return false;
  if (entry.probability >= 100) return true;
  return stablePercent(`${entry.uid}\n${haystack}`) < entry.probability;
}

function stablePercent(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

function haystackMatchesEntry(
  entry: StellaLorebookEntry,
  haystack: string
): boolean {
  if (entry.keys.length === 0) return false;

  const primaryHit = entry.keys.some((k) => testKey(k, haystack, entry));
  if (!primaryHit) return false;

  if (entry.selective && entry.secondaryKeys.length > 0) {
    const secondaryHit = entry.secondaryKeys.some((k) =>
      testKey(k, haystack, entry)
    );
    if (entry.selectiveLogic === 0 /* AND */) return secondaryHit;
    /* NOT */ return !secondaryHit;
  }

  return true;
}

function testKey(
  key: string,
  text: string,
  entry: StellaLorebookEntry
): boolean {
  const caseSensitive = entry.caseSensitive ?? false;
  const wholeWords = entry.matchWholeWords ?? false;

  if (entry.useRegex) {
    try {
      return new RegExp(key, caseSensitive ? "" : "i").test(text);
    } catch {
      return false;
    }
  }

  if (wholeWords) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      return new RegExp(`\\b${escaped}\\b`, caseSensitive ? "" : "i").test(text);
    } catch {
      return false;
    }
  }

  if (caseSensitive) return text.includes(key);
  return text.toLowerCase().includes(key.toLowerCase());
}
