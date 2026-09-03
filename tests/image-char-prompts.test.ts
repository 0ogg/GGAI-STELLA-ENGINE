/**
 * 삽화 프롬프트 → 메인 + 캐릭터별 프롬프트 분리.
 */

import assert from "node:assert/strict";
import { splitImagePrompt } from "../src/util/image-char-prompts";

// `|` 가 없으면 통째로 메인 프롬프트.
{
  const r = splitImagePrompt("1girl, solo, sfw, a girl reading, library");
  assert.equal(r.prompt, "1girl, solo, sfw, a girl reading, library");
  assert.deepEqual(r.charCaptions, []);
}

// 캐릭터 블록 분리 + 양끝 공백/쉼표 정리.
{
  const r = splitImagePrompt(
    "2girl, sfw, two girls fighting, abandoned factory | girl, original character, pink hair, angry, | girl, original character, purple hair, pointing"
  );
  assert.equal(r.prompt, "2girl, sfw, two girls fighting, abandoned factory");
  assert.deepEqual(r.charCaptions, [
    { char_caption: "girl, original character, pink hair, angry" },
    { char_caption: "girl, original character, purple hair, pointing" },
  ]);
}

// 빈 덩어리(끝에 남은 구분자)는 버린다.
{
  const r = splitImagePrompt("1boy, sfw, walking | boy, black hair |  ");
  assert.equal(r.charCaptions.length, 1);
}

console.log("image-char-prompts: ok");
