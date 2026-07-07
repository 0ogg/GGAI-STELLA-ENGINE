/**
 * ParagraphRegenService — 문단 재생성 AI 호출 진입점 (`plugin.paragraphRegen`).
 *
 * 흐름 (미디어 확장 스펙 — 문단 재생성):
 *  1. 저장된 재생성 프롬프트 + 현재 편집 영역의 원문(+ 추가 지시)을 조립해
 *     세션의 활성 모델(이어쓰기와 같은 프로필)로 보낸다.
 *  2. 응답(고쳐쓴 본문)을 그대로 돌려준다 — 본문 교체는 사용자가 패널에서
 *     승인했을 때 session-view 가 user-edit 노드로 파생시킨다.
 *
 * 원문 세션 노드는 여기서 절대 수정하지 않는다. 에러는 throw 대신 결과 객체.
 */

import type StellaEnginePlugin from "../main";
import { resolveMediaPrompt } from "../util/default-media-prompts";
import {
  buildParagraphRegenBody,
  PARAGRAPH_REGEN_IO_INSTRUCTIONS,
} from "../util/paragraph-regen";

export interface ParagraphRegenResult {
  ok: boolean;
  /** 고쳐쓴 본문 (ok=false 면 ""). */
  text: string;
  errors: string[];
}

export interface ParagraphRegenOptions {
  /** 재생성 대상 원문 (현재 편집 영역의 값). */
  source: string;
  /** 지침을 직접 지정 — 저장 프롬프트 없이 이 문자열만으로 재생성 (promptId 보다 우선). */
  instruction?: string;
  /** 저장 프롬프트 id — instruction 이 없을 때 사용. */
  promptId?: string;
  /** 일회성 추가 지시 (프롬프트를 골랐을 때). */
  feedback?: string;
}

export class ParagraphRegenService {
  constructor(private plugin: StellaEnginePlugin) {}

  async rewrite(
    sessionFile: string | null,
    opts: ParagraphRegenOptions
  ): Promise<ParagraphRegenResult> {
    if (!this.plugin.ai.isAvailable()) {
      return fail("GGAI Core 가 설치/활성화되어 있지 않습니다.");
    }
    // 직접 입력(instruction)이 있으면 그것을 지침으로, 없으면 저장 프롬프트를 쓴다.
    let instruction: string;
    if (opts.instruction && opts.instruction.trim()) {
      instruction = opts.instruction;
    } else if (opts.promptId) {
      const prompt = resolveMediaPrompt(
        "paragraphRegen",
        opts.promptId,
        this.plugin.data.mediaPrompts
      );
      if (!prompt) return fail("문단 재생성 프롬프트가 없습니다.");
      instruction = prompt.prompt;
    } else {
      return fail("프롬프트를 고르거나 직접 입력을 채워주세요.");
    }

    // 모델은 세션의 활성 모델(이어쓰기와 같은 프로필)을 그대로 쓴다.
    const settings = await this.plugin.resolveActiveSettings(sessionFile);
    const profile =
      this.plugin.ai.getProfileById(settings.modelProfileId) ??
      this.plugin.ai.getDefaultGenerationProfile();
    if (!profile) return fail("문단 재생성에 사용할 모델 프로필이 없습니다.");

    const body = buildParagraphRegenBody(instruction, opts.source, {
      feedback: opts.feedback,
    });
    try {
      let text: string;
      if (profile.kind === "text") {
        const r = await this.plugin.ai.generate({
          profileId: profile.id,
          prompt: `${PARAGRAPH_REGEN_IO_INSTRUCTIONS}\n\n${body}`,
        });
        text = r.text;
      } else {
        const r = await this.plugin.ai.chat({
          profileId: profile.id,
          messages: [
            { role: "system", content: PARAGRAPH_REGEN_IO_INSTRUCTIONS },
            { role: "user", content: body },
          ],
        });
        text = r.text;
      }
      const trimmed = text.trim();
      if (!trimmed) return fail("재생성 응답이 비어 있습니다.");
      return { ok: true, text: trimmed, errors: [] };
    } catch (err) {
      return fail(
        `재생성 호출 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

function fail(message: string): ParagraphRegenResult {
  return { ok: false, text: "", errors: [message] };
}
