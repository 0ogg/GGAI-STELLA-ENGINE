/**
 * IllustrationService — 노드 삽화 생성 실행 진입점 (`plugin.illustration`).
 *
 * 흐름 (미디어 확장 스펙 — 노드 기준):
 *  1. 대상 노드(기본: activeLeaf)까지의 본문 끝 일부(첨부량)를 컨텍스트로 모은다.
 *  2. 삽화 프롬프트 생성 모델(LLM)에 컨텍스트를 넣어 영어 이미지 프롬프트 1개를 받는다.
 *  3. 생성된 장면 프롬프트만 Core image() 로 넘긴다 — 품질태그(메인 프롬프트)와 UC 는
 *     삽화 이미지 프로필(Core)에 등록된 값을 쓰고, Core 가 프로필 메인 프롬프트 뒤에
 *     이 장면 프롬프트를 이어붙여 생성한다 (NovelAI 이미지 프로필).
 *  4. PNG 를 세션 assets/ 에 저장하고 노드 variant 로 기록 (Store 경유).
 *
 * 원문 세션 노드는 절대 수정하지 않는다. 에러는 throw 대신 결과 객체로 반환한다.
 */

import type StellaEnginePlugin from "../main";
import { resolveMediaPrompt } from "../util/default-media-prompts";
import { composeMediaPrompt } from "../util/media-prompt-body";
import { buildLorebookText, loadMediaLorebooks } from "../util/media-lorebook";
import { recordIllustrationVariant } from "../util/illustrations";
import { buildSpans, spansToText } from "../util/session-text";

const DEFAULT_CONTEXT_CHARS = 4000;

export interface IllustrateResult {
  ok: boolean;
  nodeId?: string;
  variantId?: string;
  errors: string[];
}

export class IllustrationService {
  constructor(private plugin: StellaEnginePlugin) {}

  /** 대상 노드(기본 activeLeaf)의 삽화 생성. */
  async generateForNode(
    sessionFile: string,
    nodeId?: string,
    opts?: { signal?: AbortSignal }
  ): Promise<IllustrateResult> {
    if (!this.plugin.ai.isAvailable()) {
      return fail("GGAI Core 가 설치/활성화되어 있지 않습니다.");
    }
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session) return fail("세션을 불러올 수 없습니다.");
    const targetNode = nodeId ?? session.meta.activeLeafId;
    if (!session.nodes[targetNode]) return fail("대상 노드를 찾을 수 없습니다.");

    const settings = await this.plugin.resolveActiveSettings(sessionFile);
    const ill = settings.illustration ?? {};

    const imageProfileId =
      ill.imageProfileId ?? this.plugin.ai.listImageProfiles()[0]?.id;
    if (!imageProfileId) {
      return fail("삽화 이미지 모델(NovelAI 이미지 프로필)이 없습니다.");
    }

    const genProfile =
      this.plugin.ai.getProfileById(ill.promptGenModelProfileId) ??
      this.plugin.ai.getDefaultChatProfile();
    if (!genProfile) {
      return fail("삽화 프롬프트 생성 모델이 선택되어 있지 않습니다.");
    }

    const genPrompt = resolveMediaPrompt(
      "illustrationPromptGen",
      ill.promptGenPromptId,
      this.plugin.data.mediaPrompts
    );

    const contextChars = Math.max(0, ill.contextChars ?? DEFAULT_CONTEXT_CHARS);
    const fullText = spansToText(buildSpans(session, targetNode));
    const context =
      contextChars > 0 ? fullText.slice(-contextChars) : fullText;
    if (!context.trim()) return fail("삽화를 만들 본문이 없습니다.");

    // 본문(발췌)에 매칭되는 삽화용 로어북.
    const books = await loadMediaLorebooks(this.plugin.store, ill.lorebookIds);
    const lorebookText = buildLorebookText(books, context);

    // 1) 이미지 프롬프트 생성 (LLM)
    let imagePrompt: string;
    try {
      imagePrompt = await this.generateImagePrompt(
        genProfile,
        genPrompt?.prompt ?? "",
        context,
        lorebookText,
        opts?.signal
      );
    } catch (err) {
      return fail("삽화 프롬프트 생성 실패: " + msgOf(err));
    }
    if (!imagePrompt.trim()) return fail("생성된 삽화 프롬프트가 비어 있습니다.");

    // 품질 태그(메인 프롬프트)와 UC 는 삽화 이미지 프로필(Core)에 등록된 값을 쓴다.
    // Stella 는 장면 프롬프트만 넘기고, Core 가 프로필 메인 프롬프트 뒤에 이어붙인다.
    return this.renderToVariant(sessionFile, targetNode, {
      prompt: imagePrompt.trim(),
      imageProfileId,
      kind: "ai-illustration",
      signal: opts?.signal,
    });
  }

  /**
   * 사용자가 재생성 UI 에서 다듬은 프롬프트/UC 로 이미지를 다시 만든다 (LLM 생성 단계 skip).
   * 결과는 같은 노드의 새 variant 로 등록된다.
   */
  async regenWithPrompt(
    sessionFile: string,
    nodeId: string,
    input: { prompt: string; negativePrompt?: string },
    opts?: { signal?: AbortSignal }
  ): Promise<IllustrateResult> {
    if (!this.plugin.ai.isAvailable()) {
      return fail("GGAI Core 가 설치/활성화되어 있지 않습니다.");
    }
    if (!input.prompt.trim()) return fail("프롬프트가 비어 있습니다.");
    const illustrations =
      await this.plugin.store.getSessionIllustrations(sessionFile);
    const entry = illustrations.nodes[nodeId];
    const active = entry?.variants[entry.activeVariantId];
    const settings = await this.plugin.resolveActiveSettings(sessionFile);
    const imageProfileId =
      active?.imageProfileId ??
      settings.illustration?.imageProfileId ??
      this.plugin.ai.listImageProfiles()[0]?.id;
    if (!imageProfileId) return fail("삽화 이미지 모델이 없습니다.");
    return this.renderToVariant(sessionFile, nodeId, {
      prompt: input.prompt,
      // 비우면 프로필에 등록된 UC 를 그대로 쓴다.
      negativePrompt: input.negativePrompt?.trim() || undefined,
      imageProfileId,
      promptId: active?.promptId,
      kind: "illustration-regen",
      signal: opts?.signal,
    });
  }

  /** image() 호출 → assets PNG 저장 → variant 기록 (Store 경유). */
  private async renderToVariant(
    sessionFile: string,
    nodeId: string,
    input: {
      prompt: string;
      negativePrompt?: string;
      imageProfileId: string;
      promptId?: string;
      kind: "ai-illustration" | "illustration-regen";
      signal?: AbortSignal;
    }
  ): Promise<IllustrateResult> {
    let result;
    try {
      result = await this.plugin.ai.image({
        profileId: input.imageProfileId,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        signal: input.signal,
      });
    } catch (err) {
      return fail("이미지 생성 실패: " + msgOf(err));
    }
    const img = result.images[0];
    if (!img) return fail("이미지 응답이 비어 있습니다.");

    try {
      const bytes = base64ToArrayBuffer(img.data);
      const filename = `illust-${nodeId.slice(0, 8)}-${Date.now()}.png`;
      const path = await this.plugin.store.saveSessionAsset(
        sessionFile,
        filename,
        bytes
      );
      const illustrations =
        await this.plugin.store.getSessionIllustrations(sessionFile);
      const variantId = recordIllustrationVariant(illustrations, {
        nodeId,
        path,
        imageProfileId: input.imageProfileId,
        promptId: input.promptId,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        kind: input.kind,
      });
      await this.plugin.store.saveSessionIllustrations(sessionFile, illustrations);
      return { ok: true, nodeId, variantId, errors: [] };
    } catch (err) {
      return fail("삽화 저장 실패: " + msgOf(err));
    }
  }

  private async generateImagePrompt(
    profile: { id: string; kind: "chat" | "text" },
    instruction: string,
    context: string,
    lorebookText: string,
    signal?: AbortSignal
  ): Promise<string> {
    // 본문(컨텍스트)은 지침의 {{main}}, 로어북은 {{lorebook}} 위치에 결합.
    const combined = composeMediaPrompt(instruction, context, lorebookText);
    if (profile.kind === "text") {
      const r = await this.plugin.ai.generate({
        profileId: profile.id,
        prompt: combined,
        signal,
      });
      return r.text;
    }
    const r = await this.plugin.ai.chat({
      profileId: profile.id,
      messages: [{ role: "user", content: combined }],
      signal,
    });
    return r.text;
  }
}

function base64ToArrayBuffer(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(message: string): IllustrateResult {
  return { ok: false, errors: [message] };
}
