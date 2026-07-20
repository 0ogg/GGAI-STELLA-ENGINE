/**
 * LorebookPlusService — 로어북 확장의 AI 매칭 실행부.
 *
 * 생성 직전 planSessionRequest 가 호출한다: 선별 모델(저렴/빠른 프로필)에게 엔트리
 * 목록 + 최근 이야기를 주고, 지금 넣어야 할 엔트리 키 목록을 받아 돌려준다.
 * 결과는 세션별 메모리 캐시에 남아 미리보기(dry-run)와 "재생성 땐 재사용" 옵션이
 * 새 AI 호출 없이 같은 결과를 쓴다.
 *
 * 실패 시(호출 오류/형식 깨짐) 생성을 막지 않는다 — 직전 선별 결과(없으면 빈 목록)로
 * 조용히 진행하고 경고 로그만 남긴다.
 */

import type StellaEnginePlugin from "../main";
import type { StellaLorebook } from "../types/lorebook";
import type { LorebookPlusActiveSettings } from "../types/preset";
import {
  LOREBOOK_SELECT_TASK_DEFAULT_PROMPT_ID,
  resolveMediaPrompt,
} from "../util/default-media-prompts";
import {
  buildLorebookCatalog,
  composeLorebookSelectTaskPrompt,
  DEFAULT_LOREBOOK_SELECT_CONTEXT_CHARS,
  parseLorebookSelectionResponse,
  renderLorebookCatalogText,
  type LorebookCatalogItem,
} from "../util/lorebook-ai-select";
import { buildLorebookText } from "../util/media-lorebook";
import { composeMediaPrompt } from "../util/media-prompt-body";

export interface LorebookPlusSelectInput {
  sessionFile: string;
  /** 컨텍스트를 만드는 리프 — "재생성 땐 재사용" 판정 키. */
  leafId: string;
  books: StellaLorebook[];
  /** 최근 이야기 텍스트 (호출자가 적당히 자른 꼬리). */
  recentText: string;
  settings: LorebookPlusActiveSettings;
}

export class LorebookPlusService {
  /** 세션별 마지막 선별 결과 — 미리보기/재생성 재사용용 (재시작 시 초기화). */
  private cache = new Map<string, { leafId: string; keys: string[] }>();

  constructor(private plugin: StellaEnginePlugin) {}

  /** 마지막 선별 결과 키 목록 — 미리보기(dry-run) 전용. 없으면 null. */
  getCachedKeys(sessionFile: string): string[] | null {
    return this.cache.get(sessionFile)?.keys ?? null;
  }

  /** 지금 컨텍스트에 넣을 엔트리 키 목록을 선별한다 (실패 시 직전/빈 결과). */
  async selectEntries(input: LorebookPlusSelectInput): Promise<string[]> {
    const cached = this.cache.get(input.sessionFile);
    if (
      input.settings.reuseOnRegen === true &&
      cached &&
      cached.leafId === input.leafId
    ) {
      return cached.keys;
    }

    const catalog = buildLorebookCatalog(input.books);
    if (catalog.length === 0) {
      this.cache.set(input.sessionFile, { leafId: input.leafId, keys: [] });
      return [];
    }

    const profile =
      this.plugin.ai.getProfileById(input.settings.modelProfileId) ??
      this.plugin.ai.getDefaultGenerationProfile();
    if (!profile) return cached?.keys ?? [];

    // 지시문 = 편집 가능한 미디어 프롬프트 (숨은 추가 지시문 없음 — 편집 화면에
    // 보이는 전문이 그대로 전송된다). {{lorebook}} = 엔트리 목록, {{main}} = 최근 본문.
    const promptItem = resolveMediaPrompt(
      "lorebookSelect",
      input.settings.promptId,
      this.plugin.data.mediaPrompts
    );
    if (!promptItem) return cached?.keys ?? [];

    try {
      const prompt = composeMediaPrompt(
        promptItem.prompt,
        input.recentText,
        renderLorebookCatalogText(catalog)
      );
      const keys = await this.callSelectModel(profile, prompt, catalog);
      this.cache.set(input.sessionFile, { leafId: input.leafId, keys });
      return keys;
    } catch (err) {
      console.warn(
        "[GGAI Stella] 로어북 AI 선별 실패 — 직전/빈 결과로 진행:",
        err
      );
      return cached?.keys ?? [];
    }
  }

  /**
   * 로어북을 쓰는 확장(번역/삽화 등)의 단일 허브 — 본문(scanText)에 대한 키워드
   * 매칭 텍스트를 만들되, "다른 확장에도 적용"이 켜져 있으면 AI 선별 결과를
   * 합집합으로 강제 포함한다. 선별 모델에게는 로어북 목록 + 본문에 더해 "이
   * 로어북이 함께 쓰일 작업 프롬프트 전문"(taskPrompt, `{{task}}`)을 보여준다.
   *
   * 새 확장이 로어북 텍스트가 필요하면 buildLorebookText 직접 호출 대신 반드시
   * 이 허브를 지나가야 한다 — 앞으로의 로어북 강화 옵션이 자동 적용된다.
   * 실패 시 확장 실행을 막지 않는다 — 키워드 매칭 결과로 조용히 진행.
   */
  async buildTaskLorebookText(input: {
    /** 세션 파일 경로. 세션 무관 실행(스텔라 폰 등)은 "" — 전역 설정 사용. */
    sessionFile: string;
    books: StellaLorebook[];
    /** 매칭/선별 대상 본문 (번역 원문, 삽화 장면 발췌 등). */
    scanText: string;
    /** 결과가 함께 쓰일 확장의 프롬프트 전문 — 선별 모델의 {{task}} 자리. */
    taskPrompt: string;
    /** AI 호출 라벨용 작업 이름 (예: "번역"). */
    taskLabel: string;
    /**
     * 세션 무관 호출(폰 번역 등)이 자체 토글로 AI 선별을 직접 제어할 때.
     * 이게 있으면 활성 설정 대신 이 값을 쓰고, 세션 전용 개념인 applyToExtensions
     * 없이 aiMatching 만으로 켠다 — 이 override 자체가 그 컨텍스트의 opt-in.
     */
    lorebookPlusOverride?: LorebookPlusActiveSettings;
  }): Promise<string> {
    if (input.books.length === 0) return "";

    const override = input.lorebookPlusOverride;
    const lp =
      override ??
      (await this.plugin.resolveActiveSettings(input.sessionFile || null))
        .lorebookPlus ??
      {};
    const aiSelectOn = override
      ? lp.aiMatching === true
      : lp.aiMatching === true && lp.applyToExtensions === true;
    let forcedEntryKeys: Set<string> | undefined;
    if (aiSelectOn) {
      const catalog = buildLorebookCatalog(input.books);
      if (catalog.length > 0) {
        try {
          const profile =
            this.plugin.ai.getProfileById(lp.modelProfileId) ??
            this.plugin.ai.getDefaultGenerationProfile();
          const promptItem = resolveMediaPrompt(
            "lorebookSelect",
            lp.taskPromptId ?? LOREBOOK_SELECT_TASK_DEFAULT_PROMPT_ID,
            this.plugin.data.mediaPrompts
          );
          if (profile && promptItem) {
            const contextChars =
              lp.contextChars ?? DEFAULT_LOREBOOK_SELECT_CONTEXT_CHARS;
            const prompt = composeLorebookSelectTaskPrompt(
              promptItem.prompt,
              input.scanText.slice(-contextChars),
              renderLorebookCatalogText(catalog),
              input.taskPrompt
            );
            forcedEntryKeys = new Set(
              await this.callSelectModel(profile, prompt, catalog, input.taskLabel)
            );
          }
        } catch (err) {
          console.warn(
            "[GGAI Stella] 확장 로어북 AI 선별 실패 — 키워드 매칭으로 진행:",
            err
          );
        }
      }
    }

    return buildLorebookText(input.books, input.scanText, forcedEntryKeys);
  }

  /** 선별 모델 호출 + 응답 파싱 — 형식이 깨지면 throw. */
  private async callSelectModel(
    profile: { id: string; kind: "chat" | "text" },
    prompt: string,
    catalog: LorebookCatalogItem[],
    taskLabel?: string
  ): Promise<string[]> {
    const label = taskLabel ? `로어북 선별 (${taskLabel})` : "로어북 선별";
    const responseText =
      profile.kind === "text"
        ? (
            await this.plugin.ai.generate({
              profileId: profile.id,
              prompt,
              label,
            })
          ).text
        : (
            await this.plugin.ai.chat({
              profileId: profile.id,
              messages: [{ role: "user", content: prompt }],
              label,
            })
          ).text;
    const indices = parseLorebookSelectionResponse(responseText, catalog.length);
    if (!indices) {
      throw new Error("응답이 JSON 번호 배열 형식이 아닙니다.");
    }
    return indices.map((i) => catalog[i - 1].key);
  }
}
