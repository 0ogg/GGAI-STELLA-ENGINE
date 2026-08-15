/**
 * 반복 표현 감지 — 순수 로직. (`반복 표현 감지 스펙.md`)
 *
 * 세션이 길어지면 같은 표현이 계속 나와 문장이 얇아진다. 최근 AI 본문에서
 * 되풀이된 말토막을 세어 "이번엔 다르게 써 달라"는 짧은 목록을 만든다.
 *
 * **AI 를 부르지 않는다.** 순수 집계라 생성 시간이 늘지 않는다 — 이게 존재 이유다.
 *
 * **언어 중립.** 언어별 사전·형태소 분석기를 두지 않는다. 자르는 단위는 글자
 * 구성으로 정하고(띄어쓰기 있음 = 단어 / 없음 = 글자), 기능어("the", 조사 덩어리)는
 * 그 세션 본문에서 자주 나온 토큰을 흔한 것으로 보고 스스로 걸러낸다.
 * 어형 변화(삼켰다/삼키며, smiled/smiling)는 완전 일치라 못 묶는다 — 실물에서
 * 얼마나 놓치는지 본 뒤 결정할 일이고, 미리 만들지 않는다(스펙 §3.5).
 */

import type { StellaSession } from "../types/session";
import { applyPatch, buildSpans, pathToLeaf, spansLength } from "./session-text";

/** 집계 단위 — `auto` 면 본문 글자 구성으로 정한다. */
export type RepetitionUnit = "auto" | "word" | "char";

export interface RepetitionSettings {
  /**
   * 이 확장을 지금 쓸지. **기본 꺼짐** — 확장 탭의 켜기/끄기(`isExtensionEnabled`)는
   * "아예 안 쓸 것을 목록에서 치우는" 스위치라, "쓰긴 하는데 잠시 꺼 둔다"는 여기서 한다.
   */
  enabled: boolean;
  /** 활성 경로 끝에서 몇 개 노드까지 볼지. */
  windowNodes: number;
  unit: RepetitionUnit;
  /** 몇 번 이상 나와야 후보인지. */
  minCount: number;
  /** 목록에 넣을 최대 개수. */
  maxItems: number;
  /** 흔한 토큰으로 볼 상위 비율(%). 0 이면 거르지 않는다. */
  commonRatio: number;
  /** 지시문 템플릿. `{{list}}` 자리에 목록이 들어간다. */
  template: string;
  /** 사용자가 추가한 제외 단어. */
  excludes: string[];
}

/** 목록이 들어갈 자리표시자. */
export const REPETITION_LIST_MACRO = "{{list}}";

/**
 * 기본 지시문 — 원고 언어를 모르므로 영어로 둔다(모델 지시가 목적이고,
 * 사용자가 설정에서 자기 원고 언어로 바꿔 쓸 수 있다).
 */
export const REPETITION_DEFAULT_TEMPLATE = [
  "The following wordings already appear repeatedly in the recent text.",
  "Do not reuse them in this response — express those ideas with different wording.",
  "",
  REPETITION_LIST_MACRO,
].join("\n");

export const REPETITION_DEFAULTS: RepetitionSettings = {
  enabled: false,
  windowNodes: 20,
  unit: "auto",
  minCount: 3,
  maxItems: 12,
  commonRatio: 15,
  template: REPETITION_DEFAULT_TEMPLATE,
  excludes: [],
};

/** 저장된 설정을 관용적으로 읽는다(없는 값·깨진 값은 기본값). */
export function normalizeRepetitionSettings(raw: unknown): RepetitionSettings {
  const src = (raw ?? {}) as Partial<RepetitionSettings>;
  const num = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    enabled: src.enabled === true,
    windowNodes: num(src.windowNodes, REPETITION_DEFAULTS.windowNodes, 1, 500),
    unit:
      src.unit === "word" || src.unit === "char" || src.unit === "auto"
        ? src.unit
        : REPETITION_DEFAULTS.unit,
    minCount: num(src.minCount, REPETITION_DEFAULTS.minCount, 2, 50),
    maxItems: num(src.maxItems, REPETITION_DEFAULTS.maxItems, 1, 100),
    commonRatio: num(src.commonRatio, REPETITION_DEFAULTS.commonRatio, 0, 90),
    template:
      typeof src.template === "string" ? src.template : REPETITION_DEFAULTS.template,
    excludes: Array.isArray(src.excludes)
      ? src.excludes.filter((s): s is string => typeof s === "string" && !!s.trim())
      : [],
  };
}

// ─────────────────────────── 본문 수집 ───────────────────────────

/**
 * 활성 경로 끝 `windowNodes` 개 노드가 더한 본문 중 **AI 가 쓴 부분만** 모은다.
 *
 * 스팬의 author 를 그대로 쓰므로, 사용자가 손본 자리는 자동으로 빠진다
 * (사용자 문체 교정은 월권 — 스펙 §2). 조각 사이는 줄바꿈으로 잇는다:
 * 사용자 편집으로 끊긴 두 AI 조각이 붙어 없던 반복이 생기지 않게.
 */
export function collectRecentAiText(
  session: StellaSession,
  leafId: string,
  windowNodes: number
): string {
  const path = pathToLeaf(session, leafId);
  if (path.length === 0) return "";

  const spans = buildSpans(session, leafId);
  const total = spansLength(spans);
  const start = Math.max(0, path.length - Math.max(1, windowNodes));

  // 윈도우 앞 노드 시점의 본문 길이 = 이번 윈도우가 손대기 전 분량.
  // 그 뒤가 최근 진행분이다. (윈도우가 삭제만 했으면 빈 결과 — 정상)
  let from = 0;
  if (start > 0) {
    from = Math.min(spansLength(buildSpans(session, path[start - 1].id)), total);
  }
  const windowSpans =
    from > 0 ? applyPatch(spans, { op: "delete", from: 0, to: from }) : spans;

  return windowSpans
    .filter((s) => s.author === "ai")
    .map((s) => s.text)
    .join("\n");
}

// ─────────────────────────── 집계 ───────────────────────────

/** 띄어쓰기 없이 이어 쓰는 문자 — 표의문자/가나/태국 문자. 한글은 여기 없다(띄어쓰기 언어). */
const DENSE_SCRIPT =
  /[㐀-䶿一-鿿豈-﫿぀-ヿㇰ-ㇿ฀-๿]/;

/** 글자/숫자가 아닌 것 = 구분자. 언어 무관하게 같은 규칙. */
const NON_WORD = /[^\p{L}\p{N}'’]+/gu;

/**
 * 본문을 보고 자르는 단위를 정한다. 언어명을 맞힐 필요는 없다 — 필요한 건
 * "띄어쓰기로 자를 수 있는가" 하나뿐이다.
 */
export function detectRepetitionUnit(text: string): "word" | "char" {
  let dense = 0;
  let letters = 0;
  let spaces = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) spaces++;
    else {
      letters++;
      if (DENSE_SCRIPT.test(ch)) dense++;
    }
  }
  if (letters === 0) return "word";
  if (dense / letters >= 0.3) return "char";
  if (spaces / letters < 0.02) return "char";
  return "word";
}

export interface RepetitionItem {
  /** 정규화된 표현(소문자·구두점 제거). */
  text: string;
  count: number;
}

/**
 * 한 줄을 비교용으로 다듬는다: NFC → 소문자 → 구두점 제거 → 공백 압축.
 * 아포스트로피는 낱말 안(don't, l'homme)에서만 남긴다 — 지우면 목록에
 * "didn t" 같은 조각이 뜬다.
 */
function normalizeLine(line: string): string {
  return line
    .normalize("NFC")
    .toLowerCase()
    .replace(NON_WORD, " ")
    .replace(/(^|\s)['’]+/g, "$1")
    .replace(/['’]+(?=\s|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 단어 모드는 어절 경계, 글자 모드는 부분 문자열로 포함 여부를 본다. */
function contains(haystack: string, needle: string, unit: "word" | "char"): boolean {
  if (unit === "char") return haystack.includes(needle);
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * 제외 단어 판정 — 이름은 뒤에 뭐가 붙어도 이름이다(라온은/라온이, Ellen's).
 * 그래서 어절 **앞부분**만 맞으면 제외한다(포함 관계 정리와 달리 느슨하게).
 */
function matchesExclude(key: string, exclude: string, unit: "word" | "char"): boolean {
  if (unit === "char") return key.includes(exclude);
  if (exclude.includes(" ")) return ` ${key} `.includes(` ${exclude}`);
  return key.split(" ").some((t) => t.startsWith(exclude));
}

/**
 * 반복 후보를 찾는다.
 *
 *  1) 줄 단위로 정규화 — n-gram 이 줄(문단/조각) 경계를 넘지 않는다.
 *  2) 단어 2~4연속 / 글자 2~6연속 빈도 집계.
 *  3) 전부 흔한 토큰뿐인 덩어리 제외(사전 없이 세션 본문에서 학습).
 *  4) 제외 단어(캐릭터 이름 등) 포함 제외.
 *  5) 같은 횟수로 이어지는 조각을 한 문장으로 잇고(§ mergeChains),
 *     횟수가 같은 포함 관계는 긴 쪽만 남김.
 */
export function findRepetitions(
  text: string,
  settings: RepetitionSettings
): RepetitionItem[] {
  const unit = settings.unit === "auto" ? detectRepetitionUnit(text) : settings.unit;
  const maxN = unit === "word" ? 4 : 6;

  const counts = new Map<string, number>();
  const unigrams = new Map<string, number>();
  // 토큰별 "다음에 오는 것"의 가짓수 — 기능어 판별에 쓴다(아래 common 참조).
  const successors = new Map<string, Set<string>>();

  for (const rawLine of text.split(/\n+/)) {
    const line = normalizeLine(rawLine);
    if (!line) continue;
    // 단어 모드는 줄 전체가 한 덩어리, 글자 모드는 공백으로 끊어 그 안에서만 이어 센다.
    const segments: string[][] =
      unit === "word"
        ? [line.split(" ")]
        : line.split(" ").map((word) => [...word]);
    for (const tokens of segments) {
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        unigrams.set(t, (unigrams.get(t) ?? 0) + 1);
        const next = tokens[i + 1];
        if (next == null) continue;
        const set = successors.get(t);
        if (set) set.add(next);
        else successors.set(t, new Set([next]));
      }
      for (let n = 2; n <= maxN; n++) {
        for (let i = 0; i + n <= tokens.length; i++) {
          const key = tokens.slice(i, i + n).join(unit === "word" ? " " : "");
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }

  // 흔한 토큰 — 이 세션 본문이 곧 불용어 사전이다. 빈도 상위 N% 이면서
  // **뒤에 오는 말이 여러 가지**인 것만 기능어로 본다. 빈도만 보면 정작 찾으려는
  // 반복 표현(늘 같은 짝으로 붙어 다닌다)이 흔한 말로 오인돼 통째로 사라진다.
  const ranked = [...unigrams.entries()].sort((a, b) => b[1] - a[1]);
  const cut = Math.floor((ranked.length * settings.commonRatio) / 100);
  const common = new Set(
    ranked
      .slice(0, cut)
      .filter(([t]) => (successors.get(t)?.size ?? 0) >= 2)
      .map(([t]) => t)
  );

  const excludes = settings.excludes
    .map((e) => normalizeLine(e))
    .filter((e) => e.length > 0);

  const candidates: RepetitionItem[] = [];
  for (const [key, count] of counts) {
    if (count < settings.minCount) continue;
    const tokens = unit === "word" ? key.split(" ") : [...key];
    if (common.size > 0 && tokens.every((t) => common.has(t))) continue;
    if (excludes.some((e) => matchesExclude(key, e, unit))) continue;
    candidates.push({ text: key, count });
  }

  const merged = mergeChains(candidates, unit, maxN);

  // 포함 관계 정리 — "아득한 눈빛" 과 "아득한 눈빛으로" 가 같은 횟수면 긴 쪽만.
  merged.sort((a, b) => b.text.length - a.text.length);
  const kept: RepetitionItem[] = [];
  for (const c of merged) {
    // 가장 짧은 조각(2토큰)은 더 긴 항목 안에 들어 있으면 횟수와 무관하게 버린다 —
    // 긴 쪽이 이미 같은 말을 하고 있어 목록 한 줄만 축낸다.
    const shortest = (unit === "word" ? c.text.split(" ") : [...c.text]).length === 2;
    if (
      kept.some(
        (k) =>
          (shortest || k.count === c.count) && contains(k.text, c.text, unit)
      )
    ) {
      continue;
    }
    kept.push(c);
  }

  kept.sort(
    (a, b) =>
      b.count - a.count ||
      b.text.length - a.text.length ||
      (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)
  );
  return kept.slice(0, settings.maxItems);
}

/**
 * 겹치는 조각 잇기 — 한 문장이 통째로 반복되면 창을 밀며 센 조각이 잔뜩 나온다
 * ("let out a breath" / "out a breath she" / "a breath she didn't" …). 그대로 두면
 * 목록 한 자리를 같은 문장이 여덟 번 차지한다.
 *
 * 그래서 **가장 긴 n-gram 끼리** 앞뒤가 한 토큰 차이로 맞물리고 **횟수까지 같으면**
 * 한 줄로 잇는다(같은 자리에서 같이 나왔다는 뜻). 횟수가 달라지는 지점에서 끊기므로
 * 서로 다른 문장이 억지로 붙지 않는다.
 */
function mergeChains(
  candidates: RepetitionItem[],
  unit: "word" | "char",
  maxN: number
): RepetitionItem[] {
  const sep = unit === "word" ? " " : "";
  const split = (t: string): string[] => (unit === "word" ? t.split(" ") : [...t]);

  const longest = candidates.filter((c) => split(c.text).length === maxN);
  if (longest.length === 0) return candidates;

  // 앞 토큰들(= 맞물릴 자리) → 그 자리에서 시작하는 조각들.
  const byHead = new Map<string, RepetitionItem[]>();
  for (const c of longest) {
    const head = split(c.text).slice(0, maxN - 1).join(sep);
    const list = byHead.get(head);
    if (list) list.push(c);
    else byHead.set(head, [c]);
  }
  const hasPredecessor = (c: RepetitionItem): boolean => {
    const head = split(c.text).slice(0, maxN - 1).join(sep);
    return longest.some(
      (o) =>
        o !== c &&
        o.count === c.count &&
        split(o.text).slice(1).join(sep) === head
    );
  };

  const used = new Set<RepetitionItem>();
  const chains: RepetitionItem[] = [];
  // 앞이 없는 조각(문장 머리)부터 이어 붙인다. 순환뿐이면 남은 것에서 시작한다.
  const starts = longest.filter((c) => !hasPredecessor(c)).concat(longest);
  for (const start of starts) {
    if (used.has(start)) continue;
    used.add(start);
    const tokens = split(start.text);
    for (;;) {
      const tail = tokens.slice(-(maxN - 1)).join(sep);
      const next = (byHead.get(tail) ?? []).find(
        (o) => !used.has(o) && o.count === start.count
      );
      if (!next) break;
      used.add(next);
      tokens.push(split(next.text)[maxN - 1]);
    }
    chains.push({ text: tokens.join(sep), count: start.count });
  }

  return candidates.filter((c) => split(c.text).length < maxN).concat(chains);
}

// ─────────────────────────── 지시문 조립 ───────────────────────────

/** 목록 본문 — 횟수 표기는 언어 중립(`×3`). */
export function formatRepetitionList(items: RepetitionItem[]): string {
  return items.map((i) => `- "${i.text}" ×${i.count}`).join("\n");
}

/** 템플릿에 목록을 끼운다. 목록이 없으면 빈 문자열(= 기여 없음). */
export function composeRepetitionNote(template: string, list: string): string {
  if (!list.trim()) return "";
  const body = template.trim() || REPETITION_DEFAULT_TEMPLATE;
  if (body.includes(REPETITION_LIST_MACRO)) {
    return body.split(REPETITION_LIST_MACRO).join(list).trim();
  }
  return `${body}\n\n${list}`;
}
