import type { PromptPresetParams } from "../types/prompt";
import { MODEL_KIND_DEFAULTS } from "./model-kind-policy";

/**
 * Convert Stella generation params to Core paramsOverride.
 *
 * Important: `maxContext` is Stella's input packing budget, not a provider
 * request key. The value that must reach Core is the output cap, possibly
 * adjusted after context packing so input + requested output stays inside the
 * selected context budget.
 */
export function paramsToOverride(
  params: PromptPresetParams | undefined,
  kind: "chat" | "text",
  outputTokensOverride?: number | undefined
): Record<string, unknown> | undefined {
  if (!params && outputTokensOverride == null) return undefined;
  const out: Record<string, unknown> = {};
  if (params?.temperature !== undefined) out.temperature = params.temperature;
  if (MODEL_KIND_DEFAULTS[kind].paramStyle === "snake") {
    // Core's text route passes provider-native fields through. NovelAI/OpenAI
    // text completion both expect snake_case `max_tokens`.
    if (params?.topP !== undefined && params.topP > 0 && params.topP < 1)
      out.top_p = params.topP;
    if (params?.topK !== undefined && params.topK > 0) out.top_k = params.topK;
    if (params?.minP !== undefined && params.minP > 0) out.min_p = params.minP;
    const maxTokens = outputTokensOverride ?? params?.maxOutputTokens;
    if (maxTokens !== undefined && maxTokens > 0) out.max_tokens = maxTokens;
  } else {
    // Core's chat route uses camelCase profile params and maps them per provider.
    if (params?.topP !== undefined && params.topP > 0 && params.topP < 1)
      out.topP = params.topP;
    if (params?.topK !== undefined && params.topK > 0) out.topK = params.topK;
    if (params?.minP !== undefined && params.minP > 0) out.minP = params.minP;
    const maxTokens = outputTokensOverride ?? params?.maxOutputTokens;
    if (maxTokens !== undefined && maxTokens > 0) out.maxTokens = maxTokens;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
