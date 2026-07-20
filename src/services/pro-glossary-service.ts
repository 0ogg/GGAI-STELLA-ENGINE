/**
 * ProGlossaryService — 집필 프로 번역 용어집 자동 수집 (P6, 집필 프로 스펙.md §8).
 *
 * 원천 데이터 = 저자가 승인한 문단 짝(authored: 내 한국어 ↔ 영어판). 미스캔 짝이
 * 주기만큼 쌓이면 모델에게 보내 "영↔한 표기 대응, 말투 특징" 항목을 JSON 으로 받아
 * **시나리오 전용 용어집 로어북**에 중복 없이 쌓는다 (로어북 자동 생성과 같은 골격 —
 * 목록/파싱/중복 제거는 util/lorebook-auto-gen 재사용).
 *
 * 용어집 로어북은 생성 시 시나리오의 translationLorebookIds 에도 등록되므로, 번역과
 * 집필 변환(둘 다 번역 로어북 공유)에 별도 배선 없이 자동 합류한다 (스펙 §8).
 * 실패는 scanAt 을 남기지 않아 다음 기회에 같은 짝을 다시 시도한다.
 */

import { Notice } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { StellaLorebook } from "../types/lorebook";
import { defaultLorebookEntry } from "../types/lorebook";
import { resolveMediaPrompt } from "../util/default-media-prompts";
import { composeMediaPrompt } from "../util/media-prompt-body";
import {
  dedupeGeneratedEntries,
  parseLorebookGenResponse,
  renderExistingEntriesText,
} from "../util/lorebook-auto-gen";
import {
  getScenarioMediaLorebookIds,
  loadMediaLorebooks,
  mergeLorebookIds,
} from "../util/media-lorebook";
import { collectUnscannedAuthoredPairs } from "../util/pro-convert";
import { uuidv4 } from "../util/uuid";

/** 스캔 주기 기본값 — 미스캔 authored 짝 수. */
export const DEFAULT_GLOSSARY_INTERVAL = 8;
/** 한 스캔에 싣는 짝 상한 — 초과분은 remaining 으로 남아 다음 스캔이 이어받는다. */
const GLOSSARY_MAX_PAIRS = 40;

export interface GlossaryScanResult {
  ok: boolean;
  /** 실행 조건(꺼짐/주기 미달/새 짝 없음)으로 조용히 건너뛴 경우 true. */
  skipped: boolean;
  added: number;
  errors: string[];
}

export class ProGlossaryService {
  constructor(private plugin: StellaEnginePlugin) {}

  /** 세션별 실행 중 가드 — 자동/수동 동시 실행 방지. */
  private busy = new Set<string>();

  /**
   * 자동 트리거 — 집필 변환 성공 직후 호출된다. 켜져 있고 미스캔 짝이 주기 이상일
   * 때만 실행 (상한에 걸려 남은 분이 있으면 주기 미달이어도 이어서 처리).
   */
  async scanIfNeeded(sessionFile: string): Promise<GlossaryScanResult> {
    const settings = await this.plugin.resolveActiveSettings(sessionFile);
    const pro = settings.pro ?? {};
    if (pro.glossaryEnabled === false) return skip();
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session?.meta.proWriting) return skip();
    const translations =
      await this.plugin.store.getSessionTranslations(sessionFile);
    const scan = collectUnscannedAuthoredPairs(
      translations,
      session.meta.glossaryScanAt ?? 0,
      GLOSSARY_MAX_PAIRS
    );
    const interval = Math.max(1, pro.glossaryInterval ?? DEFAULT_GLOSSARY_INTERVAL);
    if (scan.pairs.length < interval && scan.remaining === 0) return skip();
    return this.scan(sessionFile);
  }

  /**
   * 미스캔 짝을 모델에게 보내 새 용어 항목을 용어집 로어북에 추가한다.
   * 수동 [지금 스캔] 은 주기 무시로 이 함수를 직접 부른다.
   */
  async scan(sessionFile: string): Promise<GlossaryScanResult> {
    if (this.busy.has(sessionFile)) return skip();
    if (!this.plugin.ai.isAvailable()) {
      return fail("GGAI Core 가 설치/활성화되어 있지 않습니다.");
    }
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session) return fail("세션을 불러올 수 없습니다.");

    const settings = await this.plugin.resolveActiveSettings(sessionFile);
    const pro = settings.pro ?? {};
    const promptItem = resolveMediaPrompt(
      "translationGlossary",
      pro.glossaryPromptId,
      this.plugin.data.mediaPrompts
    );
    if (!promptItem) return fail("용어집 프롬프트가 선택되어 있지 않습니다.");
    const profile =
      this.plugin.ai.getProfileById(pro.glossaryModelProfileId) ??
      this.plugin.ai.getDefaultGenerationProfile();
    if (!profile) return fail("용어집 수집에 사용할 모델 프로필이 없습니다.");

    const translations =
      await this.plugin.store.getSessionTranslations(sessionFile);
    const scan = collectUnscannedAuthoredPairs(
      translations,
      session.meta.glossaryScanAt ?? 0,
      GLOSSARY_MAX_PAIRS
    );
    if (scan.pairs.length === 0) return skip();

    this.busy.add(sessionFile);
    try {
      const ensured = await this.ensureGlossaryBook(sessionFile, session.meta.scenarioId);
      if (!ensured) return fail("용어집 로어북을 만들 수 없습니다.");

      // 중복 방지 목록 = 번역 로어북 전부 (활성 설정 + 시나리오 공유, 용어집 포함).
      const scenarioIds = await getScenarioMediaLorebookIds(
        this.plugin.store,
        sessionFile,
        "translation"
      );
      const books = await loadMediaLorebooks(
        this.plugin.store,
        mergeLorebookIds(settings.translation?.lorebookIds, scenarioIds)
      );
      if (!books.some((b) => b.meta.id === ensured.book.meta.id)) {
        books.push(ensured.book);
      }

      const prompt = composeMediaPrompt(
        promptItem.prompt,
        JSON.stringify(scan.pairs),
        renderExistingEntriesText(books)
      );
      const responseText =
        profile.kind === "text"
          ? (
              await this.plugin.ai.generate({
                profileId: profile.id,
                prompt,
                label: "번역 용어집",
              })
            ).text
          : (
              await this.plugin.ai.chat({
                profileId: profile.id,
                messages: [{ role: "user", content: prompt }],
                label: "번역 용어집",
              })
            ).text;

      const proposals = parseLorebookGenResponse(responseText);
      if (!proposals) return fail("응답이 JSON 항목 배열 형식이 아닙니다.");
      const fresh = dedupeGeneratedEntries(proposals, books);

      if (fresh.length > 0) {
        // 저장 중 편집 대비 최신 책으로 다시 읽고 뒤에 붙인다.
        const book =
          (await this.plugin.store.getLorebook(ensured.lorebookFile)) ??
          ensured.book;
        for (const p of fresh) {
          book.entries.push({
            ...defaultLorebookEntry("sillytavern"),
            uid: uuidv4(),
            name: p.title,
            keys: p.keys,
            content: p.content,
          });
        }
        await this.plugin.store.saveLorebook(ensured.lorebookFile, book);
        new Notice(`번역 용어집에 새 항목 ${fresh.length}개를 추가했습니다.`);
      }

      // 성공 = 결과가 비어도 scanAt 전진 — 같은 짝을 매번 다시 보내지 않는다.
      session.meta.glossaryScanAt = scan.lastAt;
      await this.plugin.store.saveSession(sessionFile, session, {
        kinds: ["settings"],
      });
      return { ok: true, skipped: false, added: fresh.length, errors: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[GGAI Stella] 번역 용어집 수집 실패:", err);
      return fail(`용어집 수집 호출 실패: ${msg}`);
    } finally {
      this.busy.delete(sessionFile);
    }
  }

  /**
   * 시나리오 전용 용어집 로어북 보장 — 있으면 그대로, 없으면
   * "<시나리오명> 번역 용어집"을 만들고 시나리오 메타에 등록한다
   * (translationGlossaryLorebookId + translationLorebookIds 합류).
   */
  private async ensureGlossaryBook(
    sessionFile: string,
    scenarioId: string
  ): Promise<{ lorebookFile: string; book: StellaLorebook } | null> {
    const scenarios = await this.plugin.store.getScenarios();
    const item = scenarios.find(
      (i) => i.scenario.data?.extensions?.stella?.id === scenarioId
    );
    const stella = item?.scenario.data?.extensions?.stella;
    if (!item || !stella) return null;

    if (stella.translationGlossaryLorebookId) {
      const found = await this.plugin.store.getLorebookById(
        stella.translationGlossaryLorebookId
      );
      if (found) {
        return { lorebookFile: found.lorebookFile, book: found.lorebook };
      }
      // 책이 삭제됐으면 아래에서 새로 만든다.
    }

    const name = `${item.scenario.data.name?.trim() || "시나리오"} 번역 용어집`;
    const created = await this.plugin.store.createLorebook(name);
    const book = await this.plugin.store.getLorebook(created.lorebookFile);
    if (!book) return null;

    stella.translationGlossaryLorebookId = book.meta.id;
    const shared = stella.translationLorebookIds ?? [];
    if (!shared.includes(book.meta.id)) {
      stella.translationLorebookIds = [...shared, book.meta.id];
    }
    await this.plugin.store.saveScenario(item.scenarioFile, item.scenario);
    return { lorebookFile: created.lorebookFile, book };
  }
}

function fail(message: string): GlossaryScanResult {
  return { ok: false, skipped: false, added: 0, errors: [message] };
}

function skip(): GlossaryScanResult {
  return { ok: true, skipped: true, added: 0, errors: [] };
}
