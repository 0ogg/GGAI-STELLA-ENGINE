/**
 * TranslationService — 세션 문단 번역의 실행 진입점 (`plugin.translation`).
 *
 * 흐름 (미디어 확장 스펙 — 문단 기준):
 *  1. 활성 경로의 최종 본문을 문단으로 나누고 번역 대상 선택
 *     - 기본: active 번역이 없는 문단 전부 (일괄/자동 번역)
 *     - hashes 지정: 해당 문단만 (문단 개별 재생성 / 자동 번역의 새 구간)
 *  2. 대상을 청크(문단 수/글자 수 기준)로 끊어 **순차** AI 호출 — 청크마다 즉시
 *     translations.json 에 저장하므로 중간 실패에도 이미 받은 번역은 보존된다.
 *  3. 응답의 문단별 번역을 variant 로 쌓고 active 선택 (Store 경유)
 *
 * 원문 세션 노드는 절대 수정하지 않는다. 에러는 throw 대신 결과 객체로 반환한다.
 */

import type StellaEnginePlugin from "../main";
import { isCancelledError } from "./ai-service";
import { buildSpans, spansToText } from "../util/session-text";
import { resolveMediaPrompt } from "../util/default-media-prompts";
import { composeMediaPrompt } from "../util/media-prompt-body";
import { buildLorebookText, loadMediaLorebooks } from "../util/media-lorebook";
import {
  buildTranslationRequest,
  chunkParagraphs,
  collectParagraphs,
  collectUntranslatedParagraphs,
  parseTranslationResponse,
  pushTranslationUndoEntry,
  recordTranslationVariant,
  TRANSLATION_IO_INSTRUCTIONS,
} from "../util/translate-paragraphs";
import type { MediaPromptItem } from "../types/preset";
import type { TranslationUndoItem } from "../types/media";

/** 청크당 최대 문단 수 / 원문 글자 수 — 먼저 차는 기준으로 끊는다. */
const CHUNK_PARAGRAPHS = 8;
const CHUNK_CHARS = 3000;

/** 자동 재시도가 켜져 있어도, 같은 실행에서 누적 오류가 이 횟수에 도달하면 멈춘다. */
const MAX_SESSION_ERRORS = 10;

export interface TranslateResult {
  ok: boolean;
  /** active 번역이 갱신된 문단 해시 목록 (부분 성공 포함). */
  updatedHashes: string[];
  errors: string[];
  /** 사용자가/Core 가 취소해 남은 청크를 발사하지 않고 멈춘 경우 true (오류 아님). */
  cancelled?: boolean;
}

export interface TranslateOptions {
  /** 지정 시 해당 문단만 (이미 번역돼 있어도 새 variant 로 쌓임). */
  hashes?: string[];
  /** 청크 완료마다 호출 — (번역 완료 문단 수, 전체 대상 수). */
  onProgress?: (done: number, total: number) => void;
}

/** 미리보기 한 문단의 번역 결과 — 아직 translations.json 에 반영되지 않았다. */
export interface TranslationPreviewItem {
  hash: string;
  source: string;
  translation: string;
}

export interface TranslatePreviewResult {
  ok: boolean;
  /** hash 순서 = AI 가 돌려준 순서 (target + 문맥용 context 포함, 원본 로직과 동일). */
  items: TranslationPreviewItem[];
  errors: string[];
  modelProfileId: string;
  promptId: string;
}

export class TranslationService {
  constructor(private plugin: StellaEnginePlugin) {}

  /** translateParagraphs / previewTranslateRange 공용 — 세션/설정/프롬프트/프로필/로어북 해석. */
  private async resolveTranslationSetup(sessionFile: string): Promise<
    | {
        ok: true;
        text: string;
        prompt: MediaPromptItem;
        profile: { id: string; kind: "chat" | "text" };
        books: Awaited<ReturnType<typeof loadMediaLorebooks>>;
        retry: boolean;
      }
    | { ok: false; error: string }
  > {
    if (!this.plugin.ai.isAvailable()) {
      return { ok: false, error: "GGAI Core 가 설치/활성화되어 있지 않습니다." };
    }
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session) return { ok: false, error: "세션을 불러올 수 없습니다." };

    const settings = await this.plugin.resolveActiveSettings(sessionFile);
    const translation = settings.translation ?? {};
    const prompt = resolveMediaPrompt(
      "translation",
      translation.promptId,
      this.plugin.data.mediaPrompts
    );
    if (!prompt) return { ok: false, error: "번역 프롬프트가 선택되어 있지 않습니다." };
    const profile =
      this.plugin.ai.getProfileById(translation.modelProfileId) ??
      this.plugin.ai.getDefaultChatProfile();
    if (!profile) return { ok: false, error: "번역에 사용할 모델 프로필이 없습니다." };

    const text = spansToText(buildSpans(session));
    const books = await loadMediaLorebooks(this.plugin.store, translation.lorebookIds);
    return {
      ok: true,
      text,
      prompt,
      profile,
      books,
      retry: translation.retryOnFormatError === true,
    };
  }

  /**
   * 임의 텍스트 한 덩어리를 현재 번역 설정(모델/프롬프트/로어북)으로 번역한다.
   * 요약 관리 창의 "번역해서 보기" 전용 — translations.json 에 반영하지 않는다.
   */
  async translateText(
    sessionFile: string,
    text: string
  ): Promise<{ ok: boolean; text: string; error?: string }> {
    if (text.trim() === "") return { ok: true, text: "" };
    const setup = await this.resolveTranslationSetup(sessionFile);
    if (!setup.ok) return { ok: false, text: "", error: setup.error };
    const { prompt, profile, books } = setup;
    const segments = [{ id: "1", role: "translate" as const, source: text }];
    const lorebookText = buildLorebookText(books, text);
    try {
      const responseText = await this.callModel(
        profile,
        prompt.prompt,
        segments,
        lorebookText
      );
      const parsed = parseTranslationResponse(responseText);
      const item = parsed?.find((r) => r.id === "1") ?? parsed?.[0];
      if (!item) {
        return { ok: false, text: "", error: "번역 응답이 올바른 형식이 아닙니다." };
      }
      return { ok: true, text: item.translation };
    } catch (err) {
      return {
        ok: false,
        text: "",
        error: `번역 호출 실패: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 청크 하나를 번역 — 호출/형식 오류는 retry 옵션에 따라 재시도(누적 10회 한도).
   * translateParagraphs / previewTranslateRange 공용.
   */
  private async translateChunk(
    profile: { id: string; kind: "chat" | "text" },
    promptText: string,
    text: string,
    chunk: ReturnType<typeof chunkParagraphs>[number],
    books: Awaited<ReturnType<typeof loadMediaLorebooks>>,
    retry: boolean,
    errorCount: { n: number }
  ): Promise<{
    results: ReturnType<typeof parseTranslationResponse>;
    sourceById: Map<string, string>;
    reason: string;
    /** 취소로 멈춘 경우 — 재시도하지 않고 남은 청크도 발사하지 않는다. */
    cancelled: boolean;
  }> {
    const segments = buildTranslationRequest(text, chunk);
    const sourceById = new Map(segments.map((s) => [s.id, s.source]));
    const lorebookText = buildLorebookText(
      books,
      segments.map((s) => s.source).join("\n")
    );
    let results: ReturnType<typeof parseTranslationResponse> = null;
    let lastError = "";
    let stoppedByLimit = false;
    let cancelled = false;
    while (true) {
      try {
        const responseText = await this.callModel(
          profile,
          promptText,
          segments,
          lorebookText
        );
        const parsed = parseTranslationResponse(responseText);
        if (parsed && parsed.length > 0) {
          results = parsed;
          break;
        }
        lastError = "번역 응답이 올바른 JSON 배열이 아닙니다.";
      } catch (err) {
        // 취소는 오류가 아니다 — 재시도 없이 즉시 중단(밀린 청크도 발사 안 함).
        if (isCancelledError(err)) {
          cancelled = true;
          break;
        }
        lastError = `번역 호출 실패: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      errorCount.n++;
      if (!retry || errorCount.n >= MAX_SESSION_ERRORS) {
        stoppedByLimit = errorCount.n >= MAX_SESSION_ERRORS;
        break;
      }
    }
    const reason =
      cancelled || results
        ? ""
        : stoppedByLimit
          ? `오류가 ${MAX_SESSION_ERRORS}회 이상 발생해 번역을 중단했습니다.`
          : lastError || "번역 응답이 올바른 JSON 배열이 아닙니다.";
    return { results, sourceById, reason, cancelled };
  }

  /**
   * 지정 문단(hashes)만 번역 — **store 에 반영하지 않는다.** 재생성 패널의
   * "확인 후 적용" 흐름 전용: 결과를 사용자가 검토한 뒤 commitPreview 로 실제 반영한다.
   */
  async previewTranslateRange(
    sessionFile: string,
    hashes: string[]
  ): Promise<TranslatePreviewResult> {
    const setup = await this.resolveTranslationSetup(sessionFile);
    if (!setup.ok) {
      return { ok: false, items: [], errors: [setup.error], modelProfileId: "", promptId: "" };
    }
    const { text, prompt, profile, books, retry } = setup;
    const targets = collectParagraphs(text).filter((p) => hashes.includes(p.hash));
    if (targets.length === 0) {
      return {
        ok: false,
        items: [],
        errors: ["재번역할 문단을 본문에서 찾을 수 없습니다."],
        modelProfileId: profile.id,
        promptId: prompt.id,
      };
    }

    const chunks = chunkParagraphs(targets, CHUNK_PARAGRAPHS, CHUNK_CHARS);
    const items: TranslationPreviewItem[] = [];
    const errors: string[] = [];
    const errorCount = { n: 0 };

    for (const chunk of chunks) {
      const { results, sourceById, reason, cancelled } = await this.translateChunk(
        profile,
        prompt.prompt,
        text,
        chunk,
        books,
        retry,
        errorCount
      );
      if (cancelled) break; // 취소 — 조용히 멈춤(오류로 처리하지 않음)
      if (!results || results.length === 0) {
        errors.push(reason);
        break;
      }
      for (const item of results) {
        const source = sourceById.get(item.id);
        if (source === undefined) {
          errors.push(`입력에 없는 문단 응답: ${item.id}`);
          continue;
        }
        if (!item.translation.trim()) continue;
        items.push({ hash: item.id, source, translation: item.translation });
      }
    }

    if (items.length === 0) {
      if (errors.length === 0) errors.push("응답에 유효한 번역이 없습니다.");
      return { ok: false, items, errors, modelProfileId: profile.id, promptId: prompt.id };
    }
    return { ok: errors.length === 0, items, errors, modelProfileId: profile.id, promptId: prompt.id };
  }

  /** previewTranslateRange 결과를 그대로 translations.json 에 반영 (variant 쌓기 + 되돌리기 스택). */
  async commitPreview(
    sessionFile: string,
    items: TranslationPreviewItem[],
    meta: { modelProfileId: string; promptId: string }
  ): Promise<{ updatedHashes: string[] }> {
    const translations = await this.plugin.store.getSessionTranslations(sessionFile);
    const undoItems: TranslationUndoItem[] = [];
    const updatedHashes: string[] = [];
    for (const item of items) {
      const prevActive = translations.paragraphs[item.hash]?.activeVariantId ?? "";
      const variant = recordTranslationVariant(translations, {
        source: item.source,
        text: item.translation,
        modelProfileId: meta.modelProfileId,
        promptId: meta.promptId,
      });
      undoItems.push({
        hash: item.hash,
        createdVariantIds: [variant.id],
        prevActiveVariantId: prevActive,
      });
      updatedHashes.push(item.hash);
    }
    if (undoItems.length > 0) {
      pushTranslationUndoEntry(translations, undoItems);
      await this.plugin.store.saveSessionTranslations(sessionFile, translations);
    }
    return { updatedHashes };
  }

  async translateParagraphs(
    sessionFile: string,
    opts?: TranslateOptions
  ): Promise<TranslateResult> {
    const setup = await this.resolveTranslationSetup(sessionFile);
    if (!setup.ok) return fail(setup.error);
    const { text, prompt, profile, books, retry } = setup;

    const translations = await this.plugin.store.getSessionTranslations(
      sessionFile
    );
    const targets = opts?.hashes
      ? collectParagraphs(text).filter((p) => opts.hashes!.includes(p.hash))
      : collectUntranslatedParagraphs(text, translations);
    if (targets.length === 0) {
      return fail(
        opts?.hashes
          ? "재번역할 문단을 본문에서 찾을 수 없습니다."
          : "번역할 문단이 없습니다 — 모두 번역되어 있습니다."
      );
    }

    const chunks = chunkParagraphs(targets, CHUNK_PARAGRAPHS, CHUNK_CHARS);
    // 오류 시 자동 재시도 옵션 + 이번 실행의 누적 오류 수 (10회 도달 시 중단).
    const updatedHashes: string[] = [];
    const errors: string[] = [];
    // 이번 실행이 문단별로 만든 variant 를 모아 한 되돌리기 항목으로 쌓는다.
    const undoMap = new Map<
      string,
      { createdVariantIds: string[]; prevActiveVariantId: string }
    >();
    let done = 0;
    let cancelledRun = false;
    const errorCount = { n: 0 };

    for (const chunk of chunks) {
      const { results, sourceById, reason, cancelled } = await this.translateChunk(
        profile,
        prompt.prompt,
        text,
        chunk,
        books,
        retry,
        errorCount
      );

      // 취소 — 남은 청크를 발사하지 않고 멈춘다. 여기까지 저장된 청크는 보존.
      if (cancelled) {
        cancelledRun = true;
        break;
      }
      if (!results || results.length === 0) {
        errors.push(partialMessage(done, targets.length, reason));
        break;
      }

      let chunkUpdated = 0;
      for (const item of results) {
        const source = sourceById.get(item.id);
        if (source === undefined) {
          errors.push(`입력에 없는 문단 응답: ${item.id}`);
          continue;
        }
        if (!item.translation.trim()) continue;
        // 되돌리기용: 이 문단을 이번 실행에서 처음 건드릴 때의 이전 active 를 기록.
        const prevActive =
          translations.paragraphs[item.id]?.activeVariantId ?? "";
        const variant = recordTranslationVariant(translations, {
          source,
          text: item.translation,
          modelProfileId: profile.id,
          promptId: prompt.id,
        });
        const undo = undoMap.get(item.id);
        if (undo) {
          undo.createdVariantIds.push(variant.id);
        } else {
          undoMap.set(item.id, {
            createdVariantIds: [variant.id],
            prevActiveVariantId: prevActive,
          });
        }
        updatedHashes.push(item.id);
        chunkUpdated++;
      }

      // 청크마다 즉시 저장 — 이후 청크가 실패해도 여기까지는 보존.
      if (chunkUpdated > 0) {
        await this.plugin.store.saveSessionTranslations(sessionFile, translations);
      }
      done += chunk.length;
      opts?.onProgress?.(Math.min(done, targets.length), targets.length);
    }

    if (updatedHashes.length === 0) {
      // 취소로 한 문단도 못 받았으면 오류 메시지 없이 취소로만 반환.
      if (!cancelledRun && errors.length === 0)
        errors.push("응답에 유효한 번역이 없습니다.");
      return { ok: false, updatedHashes, errors, cancelled: cancelledRun };
    }
    // 실제로 번역이 반영됐으면 이번 실행을 되돌리기 스택에 한 항목으로 쌓고 저장.
    if (undoMap.size > 0) {
      const items: TranslationUndoItem[] = Array.from(
        undoMap,
        ([hash, v]) => ({ hash, ...v })
      );
      pushTranslationUndoEntry(translations, items);
      await this.plugin.store.saveSessionTranslations(sessionFile, translations);
    }
    return {
      ok: errors.length === 0,
      updatedHashes,
      errors,
      cancelled: cancelledRun,
    };
  }

  private async callModel(
    profile: { id: string; kind: "chat" | "text" },
    instruction: string,
    segments: ReturnType<typeof buildTranslationRequest>,
    lorebookText: string
  ): Promise<string> {
    const payload = JSON.stringify(segments);
    // 본문(JSON 페이로드)은 지침의 {{main}}, 로어북은 {{lorebook}} 위치에 결합.
    // JSON 입출력 규약(TRANSLATION_IO_INSTRUCTIONS)은 엔진 고정 프로토콜.
    const combined = composeMediaPrompt(instruction, payload, lorebookText);
    if (profile.kind === "text") {
      const r = await this.plugin.ai.generate({
        profileId: profile.id,
        prompt: `${TRANSLATION_IO_INSTRUCTIONS}\n\n${combined}`,
      });
      return r.text;
    }
    const r = await this.plugin.ai.chat({
      profileId: profile.id,
      messages: [
        { role: "system", content: TRANSLATION_IO_INSTRUCTIONS },
        { role: "user", content: combined },
      ],
    });
    return r.text;
  }
}

function partialMessage(done: number, total: number, reason: string): string {
  return done > 0
    ? `문단 ${done}/${total}개 번역 저장 후 중단 — ${reason}`
    : reason;
}

function fail(message: string): TranslateResult {
  return { ok: false, updatedHashes: [], errors: [message] };
}
