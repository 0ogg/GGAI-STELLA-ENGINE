/**
 * 이미지 이해 파이프라인 (폰 v2 §5) — AI 생성 이미지의 PNG 메타데이터에서
 * "모델에게 줄 텍스트 정보(내용 프롬프트)"를 뽑는다. 출처 C: 업로드된 이미지가
 * NovelAI / A1111(WebUI) / ComfyUI 산출물이면 생성 프롬프트를 캡션으로 재활용해
 * "그림이 아니라 사진"으로 취급할 수 있게 한다.
 *
 * 순수 함수 — 첨부(업로드) 시점에 1회 실행하고 결과를 갤러리/첨부 캡션에 저장한다
 * (생성 때마다 반복하지 않는다). 실패/비대상은 null.
 */

import { readPngTextChunks } from "../import/png-chunk";

export interface GeneratedImageMeta {
  /** 파싱한 내용 프롬프트 (메인 + 캐릭터 프롬프트 전체) — 캡션으로 쓴다. */
  description: string;
  tool: "novelai" | "a1111" | "comfyui";
}

/**
 * PNG 바이트에서 AI 생성 메타를 추출한다. PNG 가 아니거나 아는 메타가 없으면 null.
 * 우선순위: NovelAI(Comment JSON) > A1111(parameters) > ComfyUI(prompt 워크플로).
 */
export function parseGeneratedImageMeta(
  bytes: Uint8Array
): GeneratedImageMeta | null {
  let chunks: Array<{ keyword: string; text: string }>;
  try {
    chunks = readPngTextChunks(bytes);
  } catch {
    return null; // PNG 아님
  }
  const byKeyword = (kw: string) =>
    chunks.find((c) => c.keyword.toLowerCase() === kw.toLowerCase())?.text;

  // NovelAI — tEXt "Comment" = JSON ({prompt, uc, v4_prompt...}).
  const comment = byKeyword("Comment");
  if (comment) {
    const desc = parseNovelAiComment(comment);
    if (desc) return { description: desc, tool: "novelai" };
  }

  // A1111 WebUI — "parameters" = 프롬프트\nNegative prompt: ...\nSteps: ...
  const params = byKeyword("parameters");
  if (params) {
    const desc = parseA1111Parameters(params);
    if (desc) return { description: desc, tool: "a1111" };
  }

  // ComfyUI — "prompt" = 노드 그래프 JSON. CLIPTextEncode 계열의 text 입력을 모은다.
  const workflow = byKeyword("prompt");
  if (workflow) {
    const desc = parseComfyWorkflow(workflow);
    if (desc) return { description: desc, tool: "comfyui" };
  }
  return null;
}

/** NAI Comment JSON — 메인 프롬프트 + (v4) 캐릭터 프롬프트 전체를 이어붙인다. */
function parseNovelAiComment(raw: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof d.prompt === "string" && d.prompt.trim()) {
    // v4 는 prompt 자체가 JSON 문자열인 경우가 있다 — 그때는 v4_prompt 쪽을 쓴다.
    if (!d.prompt.trim().startsWith("{")) parts.push(d.prompt.trim());
  }
  const v4 = d.v4_prompt;
  if (v4 && typeof v4 === "object") {
    const caption = (v4 as { caption?: unknown }).caption;
    if (caption && typeof caption === "object") {
      const c = caption as {
        base_caption?: unknown;
        char_captions?: unknown;
      };
      if (typeof c.base_caption === "string" && c.base_caption.trim()) {
        if (!parts.includes(c.base_caption.trim())) {
          parts.push(c.base_caption.trim());
        }
      }
      for (const cc of Array.isArray(c.char_captions) ? c.char_captions : []) {
        const t = (cc as { char_caption?: unknown })?.char_caption;
        if (typeof t === "string" && t.trim()) parts.push(t.trim());
      }
    }
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}

/** A1111 parameters — "Negative prompt:" / "Steps:" 앞까지가 내용 프롬프트. */
function parseA1111Parameters(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const negIdx = text.search(/\nNegative prompt:/i);
  const stepsIdx = text.search(/\nSteps:\s*\d/i);
  const cut = [negIdx, stepsIdx].filter((i) => i >= 0);
  const head = (cut.length > 0 ? text.slice(0, Math.min(...cut)) : text).trim();
  return head || null;
}

/** ComfyUI 워크플로 JSON — CLIPTextEncode 계열 노드의 문자열 text 입력 수집. */
function parseComfyWorkflow(raw: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const texts: string[] = [];
  for (const node of Object.values(data as Record<string, unknown>)) {
    if (!node || typeof node !== "object") continue;
    const n = node as { class_type?: unknown; inputs?: unknown };
    if (
      typeof n.class_type !== "string" ||
      !n.class_type.includes("CLIPTextEncode")
    ) {
      continue;
    }
    const t = (n.inputs as { text?: unknown } | undefined)?.text;
    if (typeof t === "string" && t.trim() && !texts.includes(t.trim())) {
      texts.push(t.trim());
    }
  }
  const joined = texts.join("\n").trim();
  return joined || null;
}
