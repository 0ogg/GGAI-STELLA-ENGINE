import type { AIService, GenerationProfileLite } from "../services/ai-service";
import type { PromptPresetParams } from "../types/prompt";
import { paramsToOverride as buildParamsOverride } from "./generation-params";

/** 세션 이름이 새 세션 기본 이름 패턴("... YYMMDD")인지 — 자동 제목 생성 트리거 조건. */
export function isDefaultDatedSessionName(name: string): boolean {
  return /\s\d{6}$/.test(name.trim());
}

/** AI 응답에서 세션 제목으로 쓸 한 줄만 추출·정제. */
export function cleanGeneratedTitle(raw: string | undefined): string | null {
  const firstLine = (raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  const cleaned = firstLine
    .replace(/^["'“”‘’「『《<\[\(\s]+/, "")
    .replace(/["'“”‘’」』》>\]\)\s.。!！?？:：]+$/, "")
    .replace(/[\\/:*?"<>|\n\r]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned || null;
}

/** 주어진 story 발췌를 바탕으로 AI 에 세션 제목 한 줄을 요청. */
export async function requestSessionTitle(
  ai: AIService,
  input: {
    story: string;
    profile: GenerationProfileLite;
    scenarioName: string;
    params?: PromptPresetParams;
  }
): Promise<string | null> {
  const instruction =
    "Create one concise Korean session title based on the provided story excerpt. " +
    "Avoid spoilers beyond the provided text, and output only the title. " +
    "No quotes or decorative punctuation. Keep it under 24 Korean characters if possible.";
  // 추론 모델은 사고(thinking) 토큰이 출력 예산을 함께 소모한다. 제목 자체는 짧지만
  // 예전의 32 토큰 캡은 사고할 여지를 남기지 않아 추론 모델이 제목을 비운 채 돌려주고,
  // 그러면 기본 날짜 이름으로 되돌아갔다. 사고할 여유를 넉넉히 주고 사고량은 낮게 요청한다.
  const paramsOverride =
    input.profile.kind === "text"
      ? {
          ...buildParamsOverride(input.params, input.profile.kind),
          max_tokens: 64,
          temperature: 0.4,
        }
      : {
          ...buildParamsOverride(input.params, input.profile.kind),
          maxTokens: 4096,
          reasoningEffort: "low" as const,
          temperature: 0.4,
        };

  const raw =
    input.profile.kind === "text"
      ? (
          await ai.generate({
            profileId: input.profile.id,
            prompt: `${instruction}\n\nCharacter: ${input.scenarioName}\n\nStory:\n${input.story}\n\nTitle:`,
            paramsOverride,
            label: "제목 생성",
          })
        ).text
      : (
          await ai.chat({
            profileId: input.profile.id,
            messages: [
              { role: "system", content: instruction },
              {
                role: "user",
                content: `Character: ${input.scenarioName}\n\nStory:\n${input.story}`,
              },
            ],
            paramsOverride,
            label: "제목 생성",
          })
        ).text;

  return cleanGeneratedTitle(raw);
}
