/**
 * LorebookGenService — 로어북 자동 생성의 실행 진입점 (`plugin.lorebookGen`).
 *
 * 켜져 있으면 세션 전용 로어북(세션명 + 시나리오 표지)을 만들고, 마지막 스캔 앵커
 * 이후 AI 생성이 주기만큼 쌓일 때마다 새로 쌓인 본문만 모델에게 보내 아직 로어북에
 * 없는 새 인물/사건/고유명사를 항목으로 받아 쌓는다 (자동 요약과 같은 앵커 방식).
 *
 * 세션 전용 로어북은 meta.extraLorebookIds 에도 등록되므로 키워드 매칭과 로어북
 * 확장의 AI 선별이 별도 배선 없이 그대로 집어간다. 원문 세션 노드는 수정하지 않고,
 * 실패는 앵커를 남기지 않아 다음 생성 때 같은 구간을 다시 시도한다.
 */

import { Notice } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { StellaLorebook } from "../types/lorebook";
import type { StellaScenario } from "../types/scenario";
import type { StellaSession } from "../types/session";
import { defaultLorebookEntry } from "../types/lorebook";
import type { LorebookThumbnailInput } from "../import/write-lorebook";
import { resolveMediaPrompt } from "../util/default-media-prompts";
import { composeMediaPrompt } from "../util/media-prompt-body";
import {
  DEFAULT_LOREBOOK_GEN_INTERVAL,
  DEFAULT_LOREBOOK_GEN_MAX_CHARS,
  dedupeGeneratedEntries,
  parseLorebookGenResponse,
  renderExistingEntriesText,
} from "../util/lorebook-auto-gen";
import { resolveActiveLorebooks } from "../util/resolve-active-lorebooks";
import { buildSpans, pathToLeaf, spansToText } from "../util/session-text";
import {
  countGenerationsSince,
  extractNewPassage,
  lastConfirmedGenerationNode,
} from "../util/summarize-session";
import { uuidv4 } from "../util/uuid";

export interface LorebookGenResult {
  ok: boolean;
  /** 실행 조건(사용 off / 주기 미달 / 새 본문 없음)으로 조용히 건너뛴 경우 true. */
  skipped: boolean;
  /** 이번 실행으로 추가된 항목 수. */
  added: number;
  errors: string[];
}

export class LorebookGenService {
  constructor(private plugin: StellaEnginePlugin) {}

  /** 세션별 실행 중 가드 — 자동/수동 동시 실행 방지. */
  private busy = new Set<string>();

  /**
   * 세션 전용 로어북을 보장한다 — 있으면 그대로, 없으면 세션명으로 만들고
   * 시나리오 표지를 입힌 뒤 meta.autoLorebookId + extraLorebookIds 에 등록.
   * 켜는 순간(패널 토글)과 첫 스캔에서 호출된다.
   */
  async ensureSessionLorebook(
    sessionFile: string
  ): Promise<{ lorebookFile: string; book: StellaLorebook } | null> {
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session) return null;

    if (session.meta.autoLorebookId) {
      const item = await this.plugin.store.getLorebookById(
        session.meta.autoLorebookId
      );
      if (item) return { lorebookFile: item.lorebookFile, book: item.lorebook };
      // 책이 삭제됐으면 아래에서 새로 만든다.
    }

    const thumbnail = await this.readScenarioThumbnail(session);
    const created = await this.plugin.store.createLorebook(
      session.meta.name || "세션 로어북",
      thumbnail
    );
    const book = await this.plugin.store.getLorebook(created.lorebookFile);
    if (!book) return null;

    session.meta.autoLorebookId = book.meta.id;
    const extra = session.meta.extraLorebookIds ?? [];
    if (!extra.includes(book.meta.id)) {
      session.meta.extraLorebookIds = [...extra, book.meta.id];
    }
    await this.plugin.store.saveSession(sessionFile, session, {
      kinds: ["settings"],
    });
    return { lorebookFile: created.lorebookFile, book };
  }

  /**
   * 자동 트리거 — 로어북 자동 생성이 켜져 있고 마지막 스캔 앵커 이후 AI 생성이
   * 주기만큼 쌓였을 때만 scan() 을 실행한다. 조건 미달이면 조용히 skip.
   * 방금 생성된 마지막 턴은 재생성으로 버려질 수 있으니 직전 확정 턴까지만 스캔한다.
   */
  async generateIfNeeded(
    sessionFile: string,
    leafId?: string
  ): Promise<LorebookGenResult> {
    const settings = await this.plugin.resolveActiveSettings(sessionFile);
    const lp = settings.lorebookPlus ?? {};
    if (lp.autoGen !== true) return skip();
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session) return fail("세션을 불러올 수 없습니다.");

    const leaf = leafId ?? session.meta.activeLeafId;
    const target = lastConfirmedGenerationNode(session, leaf);
    if (!target) return skip();

    const lastAnchor = this.lastAnchorOnPath(session, target);
    const interval = Math.max(
      1,
      lp.autoGenInterval ?? DEFAULT_LOREBOOK_GEN_INTERVAL
    );
    const gens = countGenerationsSince(session, target, lastAnchor);
    if (gens < interval) return skip();
    return this.scan(sessionFile, target);
  }

  /**
   * 마지막 스캔 앵커 이후의 새 본문을 한 번에 스캔해 새 항목을 세션 전용 로어북에
   * 추가한다. targetId 생략 시 활성 리프까지 전부(수동 "지금 스캔" 경로).
   * 성공하면 target 을 앵커로 기록한다 — 실패는 앵커를 남기지 않는다.
   */
  async scan(
    sessionFile: string,
    targetId?: string
  ): Promise<LorebookGenResult> {
    if (this.busy.has(sessionFile)) return skip();
    if (!this.plugin.ai.isAvailable()) {
      return fail("GGAI Core 가 설치/활성화되어 있지 않습니다.");
    }
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session) return fail("세션을 불러올 수 없습니다.");
    const target = targetId ?? session.meta.activeLeafId;
    if (!session.nodes[target]) return fail("스캔 대상 노드를 찾을 수 없습니다.");

    const settings = await this.plugin.resolveActiveSettings(sessionFile);
    const lp = settings.lorebookPlus ?? {};
    const promptItem = resolveMediaPrompt(
      "lorebookGen",
      lp.autoGenPromptId,
      this.plugin.data.mediaPrompts
    );
    if (!promptItem) return fail("로어북 생성 프롬프트가 선택되어 있지 않습니다.");
    const profile =
      this.plugin.ai.getProfileById(lp.autoGenModelProfileId) ??
      this.plugin.ai.getDefaultGenerationProfile();
    if (!profile) return fail("로어북 생성에 사용할 모델 프로필이 없습니다.");

    this.busy.add(sessionFile);
    try {
      const ensured = await this.ensureSessionLorebook(sessionFile);
      if (!ensured) return fail("세션 전용 로어북을 만들 수 없습니다.");

      // 새 본문 = 마지막 앵커 시점 본문과 지금 본문의 차이 (자동 요약과 같은 방식).
      const lastAnchor = this.lastAnchorOnPath(session, target);
      const textFrom = lastAnchor
        ? spansToText(buildSpans(session, lastAnchor))
        : "";
      const textTo = spansToText(buildSpans(session, target));
      let passage = extractNewPassage(textFrom, textTo);
      if (passage.trim() === "") return skip();
      const maxChars = Math.max(
        500,
        lp.autoGenMaxChars ?? DEFAULT_LOREBOOK_GEN_MAX_CHARS
      );
      if (passage.length > maxChars) passage = passage.slice(-maxChars);

      // 중복 방지 목록 = 활성 로어북 전부 (세션 전용 로어북 포함).
      const scenario = await this.scenarioOf(session);
      const activeBooks = await resolveActiveLorebooks(
        this.plugin.store,
        scenario,
        session
      );

      const prompt = composeMediaPrompt(
        promptItem.prompt,
        passage,
        renderExistingEntriesText(activeBooks)
      );
      const responseText =
        profile.kind === "text"
          ? (
              await this.plugin.ai.generate({
                profileId: profile.id,
                prompt,
                label: "로어북 자동 생성",
              })
            ).text
          : (
              await this.plugin.ai.chat({
                profileId: profile.id,
                messages: [{ role: "user", content: prompt }],
                label: "로어북 자동 생성",
              })
            ).text;

      const proposals = parseLorebookGenResponse(responseText);
      if (!proposals) {
        return fail("응답이 JSON 항목 배열 형식이 아닙니다.");
      }
      const fresh = dedupeGeneratedEntries(proposals, activeBooks);

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
        new Notice(`로어북에 새 항목 ${fresh.length}개를 추가했습니다.`);
      }

      // 성공 = 결과가 비어도 앵커 기록 — 같은 구간을 매번 다시 스캔하지 않는다.
      this.recordAnchor(session, target);
      await this.plugin.store.saveSession(sessionFile, session, {
        kinds: ["settings"],
      });
      return { ok: true, skipped: false, added: fresh.length, errors: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[GGAI Stella] 로어북 자동 생성 실패:", err);
      return fail(`로어북 생성 호출 실패: ${msg}`);
    } finally {
      this.busy.delete(sessionFile);
    }
  }

  /** target 까지의 활성 경로에서 가장 마지막 스캔 앵커 노드 id. 없으면 undefined. */
  private lastAnchorOnPath(
    session: StellaSession,
    target: string
  ): string | undefined {
    const anchors = new Set(session.meta.lorebookGenAnchors ?? []);
    if (anchors.size === 0) return undefined;
    const path = pathToLeaf(session, target);
    for (let i = path.length - 1; i >= 0; i--) {
      if (anchors.has(path[i].id)) return path[i].id;
    }
    return undefined;
  }

  /** 앵커 추가 — 삭제된 노드를 가리키는 옛 앵커는 함께 정리한다. */
  private recordAnchor(session: StellaSession, nodeId: string): void {
    const kept = (session.meta.lorebookGenAnchors ?? []).filter(
      (id) => !!session.nodes[id]
    );
    if (!kept.includes(nodeId)) kept.push(nodeId);
    session.meta.lorebookGenAnchors = kept;
  }

  private async scenarioOf(
    session: StellaSession
  ): Promise<StellaScenario | null> {
    const scenarios = await this.plugin.store.getScenarios();
    const item = scenarios.find(
      (i) => i.scenario.data?.extensions?.stella?.id === session.meta.scenarioId
    );
    return item?.scenario ?? null;
  }

  /** 시나리오 표지 바이트 — 세션 전용 로어북에 입힐 썸네일. 없으면 undefined. */
  private async readScenarioThumbnail(
    session: StellaSession
  ): Promise<LorebookThumbnailInput | undefined> {
    try {
      const scenarios = await this.plugin.store.getScenarios();
      const item = scenarios.find(
        (i) =>
          i.scenario.data?.extensions?.stella?.id === session.meta.scenarioId
      );
      const thumbName = item?.scenario.data?.extensions?.stella?.thumbnail;
      if (!item || typeof thumbName !== "string" || !thumbName) return undefined;
      const bytes = await this.plugin.store.readAssetBytes(
        item.folder,
        thumbName
      );
      if (!bytes) return undefined;
      const rawExt = (thumbName.split(".").pop() ?? "png").toLowerCase();
      const ext = (
        ["png", "apng", "jpg", "jpeg", "webp"].includes(rawExt) ? rawExt : "png"
      ) as LorebookThumbnailInput["ext"];
      return { bytes, ext };
    } catch (err) {
      console.warn("[GGAI Stella] 시나리오 표지 복사 실패 (로어북 표지 생략):", err);
      return undefined;
    }
  }
}

function fail(message: string): LorebookGenResult {
  return { ok: false, skipped: false, added: 0, errors: [message] };
}

function skip(): LorebookGenResult {
  return { ok: true, skipped: true, added: 0, errors: [] };
}
