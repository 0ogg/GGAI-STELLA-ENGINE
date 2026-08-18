/**
 * 양방향 번역 '반영 대기함' 집계·일괄 취소 검사.
 *
 * 대기함은 **성공했을 때만** 비워진다(재시도 보장). 그래서 끝내 반영될 수 없는 건이
 * 하나 끼면 이어쓰기가 그 반영부터 시도하다 계속 멈췄고, 사용자가 풀 방법이 없었다.
 * `discardPendingReflections` 가 그 탈출구다 — 여기서 두 가지를 못 박는다:
 *   ① 대기 판정은 대기함 + 옛 방식(active=user-edit)을 **한 집합**으로 본다(화면 표시와 동일).
 *   ② 취소해도 **저자가 쓴 문장은 화면에서 사라지지 않는다**(짝으로 전환할 뿐).
 */

import assert from "node:assert/strict";
import {
  discardPendingReflections,
  getActiveTranslation,
  recordTranslationVariant,
  summarizePendingReflections,
  upsertPendingReflection,
} from "../src/util/translate-paragraphs";
import { createEmptySessionTranslations } from "../src/types/media";

// ── 1. 빈 상태 ────────────────────────────────────────────────────────────────
{
  const t = createEmptySessionTranslations();
  assert.deepEqual(summarizePendingReflections(t), {
    paragraphs: 0,
    draftChars: 0,
  });
}

// ── 2. 대기함 + 옛 방식(user-edit)은 한 집합, 중복 계산하지 않는다 ─────────────
{
  const t = createEmptySessionTranslations();
  // (a) 대기함 + user-edit variant 가 함께 있는 문단 = 1건
  recordTranslationVariant(t, {
    hash: "h1",
    source: "The rain kept on.",
    text: "비는 그치지 않았다.",
    kind: "user-edit",
  });
  upsertPendingReflection(t, "h1", "The rain kept on.", "비는 그치지 않았다.");
  // (b) 대기함 도입 전 데이터 — variant 만 user-edit
  recordTranslationVariant(t, {
    hash: "h2",
    source: "He said nothing.",
    text: "그는 아무 말도 하지 않았다.",
    kind: "user-edit",
  });
  // (c) 기계 번역은 대기가 아니다
  recordTranslationVariant(t, {
    hash: "h3",
    source: "Morning came.",
    text: "아침이 왔다.",
    kind: "ai-translation",
  });
  t.proDraft = "다음 장면 초고";

  assert.deepEqual(summarizePendingReflections(t), {
    paragraphs: 2,
    draftChars: "다음 장면 초고".length,
  });
}

// ── 3. 취소 — 대기함/초고는 비우고, 내가 쓴 문장은 화면에 남는다 ───────────────
{
  const t = createEmptySessionTranslations();
  recordTranslationVariant(t, {
    hash: "h1",
    source: "The rain kept on.",
    text: "비는 그치지 않았다.",
    kind: "user-edit",
  });
  upsertPendingReflection(t, "h1", "The rain kept on.", "비는 그치지 않았다.");
  t.proDraft = "초고";

  const summary = discardPendingReflections(t);
  assert.deepEqual(summary, { paragraphs: 1, draftChars: 2 });
  assert.equal(t.pendingReflections, undefined);
  assert.equal(t.proDraft, undefined);

  const active = getActiveTranslation(t, "h1");
  assert.equal(active?.text, "비는 그치지 않았다."); // 사라지지 않는다
  assert.equal(active?.kind, "authored"); // 대기 판정에서만 빠진다
  assert.deepEqual(summarizePendingReflections(t), {
    paragraphs: 0,
    draftChars: 0,
  });
}

// ── 4. 취소는 몇 번을 해도 안전하다(어떤 상태에서도 성공하는 탈출구) ───────────
{
  const t = createEmptySessionTranslations();
  assert.deepEqual(discardPendingReflections(t), {
    paragraphs: 0,
    draftChars: 0,
  });
  assert.deepEqual(discardPendingReflections(t), {
    paragraphs: 0,
    draftChars: 0,
  });
}

console.log("pending-reflections.test.ts OK");
