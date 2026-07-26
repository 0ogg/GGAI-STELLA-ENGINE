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

/**
 * 출력 길이 상한만 뗀 paramsOverride — 샘플링(temperature/topP/…)은 그대로 둔다.
 *
 * 본문 이어쓰기의 출력 제한은 "한 번에 이만큼만 써라"는 **본문 분량 설정**이다.
 * 부산물 생성(QR `/gen` 등)은 용도가 달라 그 상한을 물려받으면 안 된다 — 긴 결과가
 * 중간에 잘린다. 키를 빼면 Core 가 그 프로필에 설정된 출력 길이로 떨어진다.
 * (문단 재생성은 애초에 paramsOverride 를 안 보내 같은 상태다.)
 */
export function withoutOutputCap(
  override: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!override) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(override)) {
    if (k === "maxTokens" || k === "max_tokens") continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
