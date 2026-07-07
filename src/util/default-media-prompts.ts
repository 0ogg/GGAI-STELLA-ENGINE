import type { MediaPromptItem } from "../types/preset";

export type MediaPromptBucket =
  | "translation"
  | "illustrationPromptGen"
  | "paragraphRegen"
  | "summary";

/**
 * 삭제 불가능한 기본(내장) 미디어 프롬프트.
 * 우측 사이드바의 번역/삽화/삽화프롬프트생성 에서 항상 제공되며,
 * 사용자가 추가한 프롬프트와 함께 목록에 표시되지만 삭제/편집할 수 없다.
 *
 * 여기 한 곳의 오브젝트로 모든 기본 프롬프트를 일괄 관리한다.
 */
export const DEFAULT_MEDIA_PROMPTS: Record<MediaPromptBucket, MediaPromptItem[]> = {
  translation: [
    {
      id: "builtin:translation:1",
      title: "Default",
      prompt:
        "{{main}}\n\n" +
        "번역 상세\n" +
        "{{lorebook}}\n\n" +
        "You are a professional literary translator specializing in Korean.\n" +
        "Translate each provided story paragraph into natural, high-quality Korean.\n" +
        "Preserve the original tone, narrative voice, character speech style, emotion, and pacing.\n" +
        "Maintain consistent terminology and character names throughout the session.\n" +
        "Do not add, omit, or reinterpret content. Output must be faithful to the source.\n" +
        "번역: ```json\n",
    },
  ],

  paragraphRegen: [
    {
      id: "builtin:paragraphRegen:1",
      title: "한영 번역",
      prompt:
        "You are a professional literary translator and bilingual prose editor working on an English-language novel.\n" +
        "The passage is written mostly in English, but the author has inserted Korean text — notes, phrases, or whole sentences — marking what they want written or changed at those points.\n" +
        "Rewrite the ENTIRE passage as polished, natural English narrative prose:\n" +
        "- Render every Korean insertion into English and weave it seamlessly into the surrounding sentences.\n" +
        "- Match the tone, register, tense, and narrative voice of the surrounding English. It must read as native English fiction, never as a literal or word-for-word translation.\n" +
        "- Preserve the original meaning, plot progression, and nuance. Do not add new events, drop details, or reinterpret intent.\n" +
        "Output the finished English passage only.\n\n" +
        "Generation:",
    },
    {
      id: "builtin:paragraphRegen:2",
      title: "다시 쓰기",
      prompt:
        "You are a skilled novelist and prose editor.\n" +
        "Rewrite the given passage to improve its flow, imagery, and character voice.\n" +
        "Keep every story fact, event, and the meaning of dialogue unchanged.\n" +
        "Write in the same language, tense, and narrative point of view as the original.\n" +
        "Do not introduce new plot events.\n\n" +
        "Generation:",
    },
  ],

  summary: [
    {
      id: "builtin:summary:1",
      title: "Default",
      prompt:
        "You are the story memory keeper for an ongoing fiction/roleplay session.\n" +
        "From the new passage, produce two things:\n" +
        "1. events — a compact chronological digest of what happened in this passage: " +
        "key events, decisions, reveals, and emotional turning points (who felt what, and why it matters). " +
        "Preserve promises, foreshadowing, and unresolved hooks that could inspire future development. " +
        "Write 3-8 short lines.\n" +
        "2. state — an updated snapshot of the current situation, merging the previous state with this passage: " +
        "time/place, characters present and their condition, relationship dynamics, active goals, " +
        "tensions, and open threads.\n" +
        "Write both in the same language as the passage. Be specific with character names. " +
        "Never invent facts that are not in the passage or the previous summary.\n\n" +
        "Generation:",
    },
  ],

  illustrationPromptGen: [
    {
      id: "builtin:illustrationPromptGen:1",
      title: "Default",
      prompt: `Work Information
{{lorebook}}

Main Text
{{main}}

You are a professional prompt engineer for image generation AI.
Your job: read a Korean novel excerpt, identify ONLY the final scene, and output ONE illustration prompt.

=========================================
WHAT TO DO — STEP BY STEP
=========================================

STEP 1. Find the LAST scene in the text.
   - Ignore all earlier text EXCEPT for character/appearance/setting context.
   - The illustration must depict only the final situation.

STEP 2. Count the characters who appear in that final scene and are visible.
   - Output count tags FIRST: "1girl, solo" / "1boy, 1girl" / "2boy, 1girl" etc.
   - Do NOT count off-screen or mentioned-only characters.

STEP 3. Decide sfw or nsfw.
   - Rule: nsfw ONLY when genitals or nipples are visible/exposed.
   - If nsfw → always pair with "uncensored".
   - Otherwise → "sfw".

STEP 4. Build the MAIN PROMPT (natural language + tags).
   Must include, in this order:
     (a) character count tag
     (b) sfw/nsfw tag
     (c) scene action — describe the central action in concrete visual sentences.
         NO metaphors, NO similes, NO emotional adjectives.
         Example BAD:  "her eyes were like stars"
         Example GOOD: "girl with blue eyes looking at the boy"
     (d) location/background — use context details; be specific.
     (e) pose/act meme tags if a known one fits
         (e.g. "full nelson", "princess carry", "doggy style",
          "pointing spider-man (meme)", "ice bucket challenge")

STEP 5. For EACH visible character, build ONE character block.
   Format:
     gender, name_tag, current_appearance, precise_action

     gender      → "girl" | "boy" | "other"
                   (other = creature/animal/mascot/robot with no clear gender)
     name_tag    → ORIGINAL character : "english name (english series)"
                                      : do NOT add looks not in the text
                   OC                  : "original character"
                                      : MUST describe hair color, eye color,
                                        hairstyle, etc. in detail from text
                   EXTRA (no looks)    : invent non-conflicting looks,
                                        or copy text if described
     appearance  → face expression, clothes, pose, exposed body parts,
                   wounds, torn clothing — all from the text
     action      → more precise than the main prompt; specific to this character

STEP 6. Join everything with " | ".
   Final shape (single line):
     <main prompt> | <character 1> | <character 2> | ...

STEP 7. STOP after the last character block.
   - Write each character exactly ONCE.
   - Do not add notes, explanations, or the word "example".

=========================================
LANGUAGE RULES (STRICT)
=========================================

- Write ONLY in lowercase english.
- Use "," to separate tags and phrases. Do NOT use "." as separator.
- Replace literary/emotional/figurative text with plain visual words.
- COLOR TRAP — never write color words that could repaint the whole body.
    BAD:  "red face"          → model paints entire face red
    GOOD: "blush"
    BAD:  "red skin"          → model paints a red-skinned person
    GOOD: "pale skin" / "tan"
  Use color words ONLY for clothes, hair, eyes, objects.

=========================================
NEVER DO THESE
=========================================

- Do NOT invent facts not in the text.
- Do NOT output the examples below — they are references only.
- Do NOT describe a character more than once.
- Do NOT include characters from earlier scenes unless they are
  in the final scene.
- Do NOT use metaphors or similes.
- Do NOT add appearance details that the text does not state
  for original-series characters.

=========================================
EXAMPLE 1 (reference only — do NOT output)
=========================================
INPUT (final scene): Two girls in an abandoned factory.
One scolds the other and points at her.

OUTPUT:
2girl, sfw, inside an abandoned factory, dim industrial lights casting shadows, foggy atmosphere, two girls engaged in a comedic fight, one girl being pointed at while the other scolds her, pointing spider-man (meme) | girl, haruno sakura (naruto), angry expression, green eyes, medium-length pink hair, red dress torn around the chest, white gloves, standing with hands on hips, being pointed at by the other girl | girl, original character, long flowing purple hair in a side braid, green eyes, sleeveless golden turtleneck shirt, ripped jeans, pointing aggressively at the other girl while scolding her

=========================================
EXAMPLE 2 (reference only — do NOT output)
=========================================
INPUT (final scene): A boy carries a girl in his arms through rain;
her nipple is exposed.

OUTPUT:
1boy, 1girl, nsfw, uncensored, heavy rain at night, wet city street with neon reflections, boy carrying a girl in his arms, princess carry, soaked clothes clinging to skin, puddles on the ground | boy, original character, short black hair, dark brown eyes, white shirt soaked translucent, black trousers, carrying the girl with both arms, serious expression, looking down at her | girl, original character, long silver hair clinging to skin, blue eyes, torn white dress, left nipple exposed, wet skin, limp in his arms, eyes half closed, blushing

=========================================
NOW DO IT
=========================================
Read the text provided by the user.
Output ONLY the final prompt string in the exact format above.
Nothing else.

Response:`,
    },
  ],
};

/** 버킷별 기본 프롬프트 배열 반환 (복사본). */
export function getDefaultPrompts(bucket: MediaPromptBucket): MediaPromptItem[] {
  const list = DEFAULT_MEDIA_PROMPTS[bucket];
  return list ? [...list] : [];
}

/** 주어진 id 가 내장(삭제불가) 기본 프롬프트인지 판별. */
export function isBuiltinMediaPrompt(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith("builtin:");
}

/**
 * 선택된 promptId 로 실제 사용할 프롬프트를 해석.
 * - 사용자 라이브러리를 먼저 본다: 기본 프롬프트를 편집하면 같은 builtin id 로
 *   override 가 저장되므로, 이 override 가 정적 기본값보다 우선해야 한다.
 * - 없으면 정적 기본 프롬프트.
 * - 선택이 없거나 못 찾으면 해당 버킷의 첫 기본 프롬프트(override 반영)로 폴백.
 * - 그래도 없으면 undefined
 */
export function resolveMediaPrompt(
  bucket: MediaPromptBucket,
  promptId: string | undefined,
  userLibrary?: Partial<Record<MediaPromptBucket, MediaPromptItem[]>>
): MediaPromptItem | undefined {
  const userList = userLibrary?.[bucket] ?? [];
  if (promptId) {
    const user = userList.find((p) => p.id === promptId);
    if (user) return { ...user };
    const def = getDefaultPrompts(bucket).find((p) => p.id === promptId);
    if (def) return { ...def };
  }
  const first = getDefaultPrompts(bucket)[0];
  if (!first) return undefined;
  const override = userList.find((p) => p.id === first.id);
  return { ...(override ?? first) };
}
