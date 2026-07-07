export interface SummaryInput {
  /** 요약할 본문 텍스트. */
  text: string;
  /** AI 호출 함수. */
  generate: (prompt: string) => Promise<string>;
  /** 기존 누적 요약. */
  previousSummary?: string;
  /** 목표 요약 길이. */
  maxTokens?: number;
}

export async function generateSummary(input: SummaryInput): Promise<string> {
  const prompt = buildSummaryPrompt(input);
  return (await input.generate(prompt)).trim();
}

export function buildSummaryPrompt(input: Omit<SummaryInput, "generate">): string {
  const target = input.maxTokens && input.maxTokens > 0
    ? `\n- Aim to stay within about ${input.maxTokens} tokens.`
    : "";
  const previous = input.previousSummary?.trim()
    ? `\n\nPrevious summary:\n${input.previousSummary.trim()}`
    : "";

  return [
    "You are a fiction continuity summarizer.",
    "Summarize the story text concisely while preserving:",
    "- characters, places, important events, and emotional turns",
    "- current plot lines and unresolved conflicts",
    "- relevant style or mood changes",
    target,
    previous,
    "\nStory text to summarize:\n",
    input.text,
  ].join("\n");
}
