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
import { resolveMediaPrompt } from "../util/default-media-prompts";
import {
  buildLorebookCatalog,
  parseLorebookSelectionResponse,
  renderLorebookCatalogText,
} from "../util/lorebook-ai-select";
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
      const responseText =
        profile.kind === "text"
          ? (
              await this.plugin.ai.generate({
                profileId: profile.id,
                prompt,
                label: "로어북 선별",
              })
            ).text
          : (
              await this.plugin.ai.chat({
                profileId: profile.id,
                messages: [{ role: "user", content: prompt }],
                label: "로어북 선별",
              })
            ).text;
      const indices = parseLorebookSelectionResponse(responseText, catalog.length);
      if (!indices) {
        throw new Error("응답이 JSON 번호 배열 형식이 아닙니다.");
      }
      const keys = indices.map((i) => catalog[i - 1].key);
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
}
