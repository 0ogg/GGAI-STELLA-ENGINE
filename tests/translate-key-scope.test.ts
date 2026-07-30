/**
 * 문단 키 스코프 일치 검사.
 *
 * 문단 키는 `내용 + 앞 문단` 이라, **어느 범위를 토큰화했느냐에 따라 값이 달라진다.**
 * 번역 대상은 평탄화 본문 전체 기준으로 잡히는데 챗 표시/편집은 말풍선 단위로
 * 토큰화하므로, 앞 메시지의 마지막 문단을 씨앗으로 넘기지 않으면 두 경로의 키가
 * 어긋나 **번역이 다 되고도 화면에 안 나온다**(조용한 실패 — 원인 추적이 가장 어렵다).
 *
 * 여기서 그 등가를 못 박는다. 새 표시 경로를 추가할 때 이 검사가 먼저 깨져야 한다.
 */

import assert from "node:assert/strict";
import {
  collectTranslationContext,
  getActiveTranslation,
  hashText,
  lastParagraphSource,
  legacyParagraphKey,
  paragraphKey,
  recordTranslationVariant,
  tokenizeParagraphs,
} from "../src/util/translate-paragraphs";
import { collectChatReflectionOps } from "../src/util/pro-convert";
import { createEmptySessionTranslations } from "../src/types/media";
import type { SessionTranslations } from "../src/types/media";

const SEP = "\n\n";

/** 문단 토큰만 (구분자 제외) — flatMap 이라 타입도 좁혀진다. */
function paragraphsOf(
  text: string,
  prev = ""
): { hash: string; source: string }[] {
  return tokenizeParagraphs(text, prev).flatMap((t) =>
    t.kind === "paragraph" ? [{ hash: t.hash, source: t.source }] : []
  );
}

function keysOf(text: string, prev = ""): string[] {
  return paragraphsOf(text, prev).map((p) => p.hash);
}

// ── 1. 전체 본문 기준 키 == 메시지 단위 기준 키 (씨앗을 넘겼을 때) ──────────
{
  const messages = [
    "남은 거 있어?",
    "No.",
    "너 안 와?",
    "No.",
    "그렇구나.\n알겠어.",
    "No.",
  ];
  // 평탄화 본문 = 메시지를 구분자로 이어붙인 것 (buildSpans/spansToText 와 같은 모양).
  const flat = messages.join(SEP);
  const wholeKeys = keysOf(flat);

  const perMessageKeys: string[] = [];
  let prev = "";
  for (const msg of messages) {
    perMessageKeys.push(...keysOf(msg, prev));
    prev = lastParagraphSource(msg) || prev;
  }

  assert.deepEqual(
    perMessageKeys,
    wholeKeys,
    "말풍선 단위 토큰화 키가 전체 본문 기준 키와 달라졌다 — 앞 문단 씨앗(prevSource) 배선 확인"
  );
}

// ── 2. 같은 대사라도 앞 문단이 다르면 다른 키 (이 변경의 목적) ─────────────
{
  const flat = ["남은 거 있어?", "No.", "너 안 와?", "No."].join(SEP);
  const keys = keysOf(flat);
  assert.equal(keys.length, 4);
  assert.notEqual(
    keys[1],
    keys[3],
    '앞 문단이 다른 "No." 가 같은 키를 받았다 — 번역이 통째로 공유된다'
  );
  // 앞 문단까지 같으면 같은 자리로 본다 (진짜 중복은 공유).
  const twice = ["남은 거 있어?", "No.", "남은 거 있어?", "No."].join(SEP);
  const twiceKeys = keysOf(twice);
  assert.equal(twiceKeys[1], twiceKeys[3]);
}

// ── 3. 옛 키 폴백 — 규칙이 바뀌기 전에 저장된 번역이 그대로 보인다 ──────────
{
  const translations = createEmptySessionTranslations();
  // 옛 스키마: 내용 해시만으로 저장돼 있던 항목을 직접 심는다.
  const legacy = hashText("No.");
  translations.paragraphs[legacy] = {
    source: "No.",
    activeVariantId: "v1",
    variants: {
      v1: {
        id: "v1",
        kind: "ai-translation",
        sourceHash: legacy,
        text: "없습니다",
        createdAt: 1,
        updatedAt: 1,
      },
    },
  };

  const key = paragraphKey("No.", "남은 거 있어?");
  assert.equal(legacyParagraphKey(key), legacy, "옛 키가 새 키에서 복원되지 않는다");
  assert.equal(
    getActiveTranslation(translations, key)?.text,
    "없습니다",
    "옛 스키마로 저장된 번역이 폴백으로 안 읽힌다"
  );

  // 재번역하면 그 자리만 새 키로 갈라지고, 옛 항목은 건드리지 않는다.
  const other = paragraphKey("No.", "너 안 와?");
  recordTranslationVariant(translations, {
    hash: other,
    source: "No.",
    text: "아니야",
    kind: "translation-regen",
  });
  assert.equal(getActiveTranslation(translations, other)?.text, "아니야");
  assert.equal(
    getActiveTranslation(translations, key)?.text,
    "없습니다",
    "새 키에 쓴 번역이 다른 자리까지 덮어썼다"
  );
}

// ── 4. 앞 문맥 블록에는 "번역이 있는" 문단만 담긴다 (병렬 청크 대응) ────────
{
  const flat = ["첫 문단", "둘째 문단", "셋째 문단"].join(SEP);
  const translations: SessionTranslations = createEmptySessionTranslations();
  const tokens = paragraphsOf(flat);
  // 첫 문단만 번역돼 있고 둘째는 아직 번역 중(다른 청크)인 상태.
  recordTranslationVariant(translations, {
    hash: tokens[0].hash,
    source: tokens[0].source,
    text: "FIRST",
  });

  const pairs = collectTranslationContext(
    flat,
    translations,
    [{ hash: tokens[2].hash, source: tokens[2].source }],
    1
  );
  assert.deepEqual(
    pairs.map((p) => p.source),
    ["첫 문단"],
    "번역 없는 앞 문단이 참고 블록에 원문만으로 실렸다"
  );
}

// ── 5. 챗 반영 대기함 조회도 같은 키로 (양방향 번역) ───────────────────────
{
  const messages = [
    { text: "남은 거 있어?", role: "user" as const, nodeId: "n1" },
    { text: SEP + "No.", role: "assistant" as const, nodeId: "n2" },
    { text: SEP + "너 안 와?", role: "user" as const, nodeId: "n3" },
    { text: SEP + "No.", role: "assistant" as const, nodeId: "n4" },
  ];
  const flat = messages.map((m) => m.text).join("");
  const keys = keysOf(flat);
  // 두 번째 "No." 만 수정 대기에 올린다.
  const ops = collectChatReflectionOps(messages as never, {
    [keys[3]]: { ko: "아니야", en: "No.", createdAt: 1, updatedAt: 1 },
  });
  assert.equal(ops.length, 1, "대기 건이 엉뚱한 개수로 잡혔다 (키 스코프 어긋남)");
  assert.equal(
    flat.slice(ops[0].from, ops[0].to),
    "No.",
    "반영 구간 오프셋이 어긋났다"
  );
  // 첫 번째 "No." 자리(offset)와 달라야 한다 — 같으면 같은 키로 합쳐진 것.
  assert.ok(ops[0].from > flat.indexOf("너 안 와?"), "두 번째 대사가 아니라 첫 대사가 잡혔다");
}

console.log("translate key scope harness passed");
