/**
 * 삽화 프롬프트 생성 지침(`default-media-prompts.ts` illustrationPromptGen)이 돌려주는
 * 한 줄을 NovelAI 요청 모양으로 나눈다.
 *
 *   <메인(장면·배경)> | <캐릭터1> | <캐릭터2> ...
 *
 * `|` 앞이 메인 프롬프트, 뒤의 각 덩어리가 캐릭터별 프롬프트(NAI v4 char_captions).
 * `|` 가 없으면 통째로 메인 프롬프트 — 예전 프롬프트/직접 입력도 그대로 동작한다.
 */
export interface SplitImagePrompt {
  prompt: string;
  charCaptions: Array<{ char_caption: string }>;
}

export function splitImagePrompt(text: string): SplitImagePrompt {
  const parts = text.split("|").map((p) => trimSeparators(p));
  const prompt = parts.shift() ?? "";
  return {
    prompt,
    charCaptions: parts
      .filter((p) => p.length > 0)
      .map((p) => ({ char_caption: p })),
  };
}

/** 조각 양끝의 공백과 남은 구분 쉼표 제거. */
function trimSeparators(part: string): string {
  return part.trim().replace(/^,+\s*/, "").replace(/\s*,+$/, "").trim();
}
