/**
 * SummaryService — 세션 요약의 실행 진입점 (`plugin.summary`).
 *
 * 대원칙: **요약 요청 1번 = 앵커 1개.** 요청 하나가 끝나는 즉시 그 앵커를 저장하고
 * 이벤트를 쏘므로, 요약 관리 창에 카드가 하나씩 실시간으로 쌓인다. 요청을 몰래
 * 여러 번으로 나눠 하나의 앵커로 합치던 릴레이 방식은 폐기됐다.
 *
 * 흐름:
 *  1. 활성 경로의 마지막 요약 앵커 이후 AI 생성 횟수가 주기(threshold)에 도달했는지 판정
 *  2. 밀린 구간을 앵커 경계로 나눈다(planSummaryBoundaries) — 기본은 주기 단위,
 *     구간 본문이 모델 입력 한도를 넘을 것 같으면 요청을 나누는 게 아니라
 *     **앵커를 더 잘게** 나눈다 (요청 1번 = 앵커 1개는 어떤 경우에도 유지).
 *  3. 경계마다 요청 1번 → 앵커 1개 즉시 저장. 중간에 실패/중단해도 완료 앵커는
 *     남아 있고, 다음 실행이 마지막 저장 앵커 다음 경계부터 이어간다.
 *
 * 원문 세션 노드는 절대 수정하지 않는다. 에러는 throw 대신 결과 객체로 반환한다.
 */

import type StellaEnginePlugin from "../main";
import { isCancelledError } from "./ai-service";
import { resolveMediaPrompt } from "../util/default-media-prompts";
import { composeMediaPrompt } from "../util/media-prompt-body";
import { buildSpans, spansToText } from "../util/session-text";
import {
  buildSummaryRequestBody,
  clearSummaryCheckpoint,
  collectAnchorChain,
  countGenerationsSince,
  DEFAULT_SUMMARY_THRESHOLD,
  extractNewPassage,
  parseSummaryResponse,
  planSummaryBoundaries,
  RECENT_EVENTS_FOR_CONTEXT,
  recordSummaryAnchor,
  SUMMARY_IO_INSTRUCTIONS,
} from "../util/summarize-session";

interface GenProfileLite {
  id: string;
  kind: "chat" | "text";
  maxContextTokens?: number;
}

/** 진행 알림 — 완료/전체 요청 수. 요청 1번 = 앵커 1개이므로 카드 수와 일치한다. */
export type SummaryProgress = (done: number, total: number) => void;

/** 프로필에 입력 한도 정보가 없을 때 앵커 하나가 담을 본문 글자 수 상한. */
const SUMMARY_DEFAULT_PASSAGE_CHARS = 24000;
/** 모델 입력 한도(토큰)에서 지침/이전상태/출력용으로 비워두는 여유분. */
const SUMMARY_RESERVE_TOKENS = 2000;
/** 토큰 → 글자 근사 (한/영 혼용에서 한도 초과를 피하려 보수적으로 낮게). */
const APPROX_CHARS_PER_TOKEN = 2;
/** 요청 하나당 재시도 횟수 (호출 오류/응답 형식 위반 시 — 일시적 실패 흡수). */
const SUMMARY_ATTEMPTS = 3;
/** 재시도 사이 대기(ms). */
const SUMMARY_RETRY_DELAY_MS = 800;

export interface SummarizeResult {
  ok: boolean;
  /** 실행 조건(사용 off / 주기 미달 / 새 패시지 없음)으로 조용히 건너뛴 경우 true. */
  skipped: boolean;
  errors: string[];
  /** 사용자가/Core 가 취소해 남은 구간을 진행하지 않고 멈춘 경우 true (오류 아님). */
  cancelled?: boolean;
}

export class SummaryService {
  constructor(private plugin: StellaEnginePlugin) {}

  /** 진행 중인 요약 실행들의 취소 컨트롤러 (자동/수동 동시 실행 대비). */
  private runs = new Set<AbortController>();

  /** 요약 작업이 하나라도 진행 중인지 (정지 버튼 노출 판정용). */
  get running(): boolean {
    return this.runs.size > 0;
  }

  /**
   * 진행 중인 모든 요약 작업을 취소한다 (수동 정지 버튼). in-flight 요청은
   * AbortSignal 로 Core 에서 끊기고, 남은 구간은 진행하지 않는다. 이미 저장된
   * 앵커는 그대로 남아 다음 요약이 그 다음 구간부터 이어간다.
   */
  cancelAll(): void {
    for (const ac of this.runs) ac.abort();
  }

  /**
   * 자동 요약 트리거 — 요약 사용 중이고 마지막 앵커 이후 AI 생성이 주기만큼
   * 쌓였을 때만 summarize() 를 실행한다. 조건 미달이면 조용히 skip.
   */
  async summarizeIfNeeded(
    sessionFile: string,
    leafId?: string
  ): Promise<SummarizeResult> {
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session) return fail("세션을 불러올 수 없습니다.");
    const settings = await this.plugin.resolveActiveSettings(sessionFile);
    if (settings.summarize?.enabled !== true) return skip();

    const target = leafId ?? session.meta.activeLeafId;
    const summaries = await this.plugin.store.getSessionSummaries(sessionFile);
    const chain = collectAnchorChain(session, summaries, target);
    const last = chain.length > 0 ? chain[chain.length - 1] : null;
    const threshold = Math.max(
      1,
      settings.summarize.threshold ?? DEFAULT_SUMMARY_THRESHOLD
    );
    const gens = countGenerationsSince(session, target, last?.nodeId);
    if (gens < threshold) return skip();
    return this.summarize(sessionFile, target);
  }

  /**
   * 밀린 구간을 앵커 경계로 나눠 **경계마다 요청 1번 → 앵커 1개 즉시 저장**한다.
   * 저장할 때마다 store 이벤트가 나가므로 요약 관리 창에 카드가 하나씩 쌓인다.
   * `onProgress(done, total)` 의 단위도 요청(=앵커) 수다.
   *
   * 대상 노드에 이미 앵커가 있으면(요약 관리의 개별 재생성) 그 구간 하나만 다시 만든다.
   */
  async summarize(
    sessionFile: string,
    leafId?: string,
    opts?: { onProgress?: SummaryProgress }
  ): Promise<SummarizeResult> {
    if (!this.plugin.ai.isAvailable()) {
      return fail("GGAI Core 가 설치/활성화되어 있지 않습니다.");
    }
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session) return fail("세션을 불러올 수 없습니다.");
    const target = leafId ?? session.meta.activeLeafId;
    if (!session.nodes[target]) return fail("요약 대상 노드를 찾을 수 없습니다.");

    const settings = await this.plugin.resolveActiveSettings(sessionFile);
    const summarize = settings.summarize ?? {};
    const prompt = resolveMediaPrompt(
      "summary",
      summarize.promptId,
      this.plugin.data.mediaPrompts
    );
    if (!prompt) return fail("요약 프롬프트가 선택되어 있지 않습니다.");
    const profile =
      this.plugin.ai.getProfileById(summarize.modelProfileId) ??
      this.plugin.ai.getDefaultChatProfile();
    if (!profile) return fail("요약에 사용할 모델 프로필이 없습니다.");
    const threshold = Math.max(
      1,
      summarize.threshold ?? DEFAULT_SUMMARY_THRESHOLD
    );

    const summaries = await this.plugin.store.getSessionSummaries(sessionFile);
    const chain = collectAnchorChain(session, summaries, target);
    // 대상 노드에 이미 앵커가 있는 경우(개별 재생성)는 자기 자신이 "직전 앵커"로
    // 잡히면 새 패시지가 0이 되어 항상 skip 된다 — 자기 앵커는 제외하고 계산한다.
    const prior = chain.filter((a) => a.nodeId !== target);
    const last = prior.length > 0 ? prior[prior.length - 1] : null;

    // 재생성이면 그 구간 하나만, 그 외에는 마지막 앵커 이후를 경계로 쪼갠다
    // (주기 단위 + 모델 입력 예산 초과 시 더 잘게).
    const budget = this.passageCharBudget(profile.maxContextTokens);
    const isRegen = !!summaries.anchors[target];
    const boundaries = isRegen
      ? [target]
      : planSummaryBoundaries(session, target, last?.nodeId, threshold, budget);
    if (boundaries.length === 0) return skip();

    // 직전 앵커의 state/최근 events 를 구간을 넘어가며 이어 넘긴다.
    let prevAnchorNodeId = last?.nodeId;
    let runningState = last?.state ?? "";
    const runningRecent = prior
      .slice(-RECENT_EVENTS_FOR_CONTEXT)
      .map((a) => a.events);

    // 이 실행의 취소 컨트롤러 — 정지 버튼(cancelAll)이 abort 하면 in-flight 요청을
    // 끊고 남은 구간을 진행하지 않는다.
    const ac = new AbortController();
    this.runs.add(ac);
    this.plugin.store.trigger("summary-running-changed");
    try {
      let produced = 0;
      const total = boundaries.length;
      for (let b = 0; b < boundaries.length; b++) {
        // 구간 시작 전 취소 확인 — 앞서 저장된 앵커는 그대로 두고 멈춘다.
        if (ac.signal.aborted) {
          return { ok: false, skipped: false, errors: [], cancelled: true };
        }
        const boundary = boundaries[b];
        const textFrom = prevAnchorNodeId
          ? spansToText(buildSpans(session, prevAnchorNodeId))
          : "";
        const textTo = spansToText(buildSpans(session, boundary));
        const passage = extractNewPassage(textFrom, textTo);
        if (passage.trim() === "") {
          opts?.onProgress?.(b + 1, total);
          continue;
        }

        const payload = buildSummaryRequestBody({
          previousState: runningState,
          recentEvents: runningRecent.slice(-RECENT_EVENTS_FOR_CONTEXT),
          passage,
        });
        const seg = await this.requestSummary(
          profile,
          prompt.prompt,
          payload,
          ac.signal
        );
        if (!seg.ok) {
          // 취소 — 남은 구간을 진행하지 않고 멈춘다. 앞서 저장된 앵커는 그대로다.
          if (seg.cancelled) {
            return { ok: false, skipped: false, errors: [], cancelled: true };
          }
          // 실패해도 앞서 저장된 앵커들은 그대로다 — 다음 실행이 여기부터 이어간다.
          return fail(seg.error);
        }

        // 요청 1번 완료 = 앵커 1개 즉시 기록·저장 → 요약 관리에 카드가 바로 뜬다.
        const store = await this.plugin.store.getSessionSummaries(sessionFile);
        clearSummaryCheckpoint(store); // 구버전 릴레이 체크포인트가 남아 있으면 정리
        recordSummaryAnchor(store, {
          nodeId: boundary,
          fromNodeId: prevAnchorNodeId,
          events: seg.events,
          state: seg.state,
          modelProfileId: profile.id,
          promptId: prompt.id,
        });
        await this.plugin.store.saveSessionSummaries(sessionFile, store);

        prevAnchorNodeId = boundary;
        runningState = seg.state;
        runningRecent.push(seg.events);
        produced++;
        opts?.onProgress?.(b + 1, total);
      }

      if (produced === 0) return skip();
      return { ok: true, skipped: false, errors: [] };
    } finally {
      this.runs.delete(ac);
      this.plugin.store.trigger("summary-running-changed");
    }
  }

  /**
   * 요약 요청 딱 1번 (재시도 포함) — 쪼개지 않는다. 성공하면 events/state,
   * 재시도를 소진하면 마지막 오류를 반환한다.
   */
  private async requestSummary(
    profile: GenProfileLite,
    promptText: string,
    payload: string,
    signal?: AbortSignal
  ): Promise<
    | { ok: true; events: string; state: string }
    | { ok: false; error: string; cancelled?: boolean }
  > {
    let lastError = "";
    for (let attempt = 0; attempt < SUMMARY_ATTEMPTS; attempt++) {
      // 재시도 대기 뒤 다시 시도하기 전에도 취소를 확인한다.
      if (signal?.aborted) return { ok: false, error: "", cancelled: true };
      try {
        const responseText = await this.callModel(
          profile,
          promptText,
          payload,
          signal
        );
        const result = parseSummaryResponse(responseText);
        if (result) return { ok: true, events: result.events, state: result.state };
        lastError = "요약 응답이 올바른 JSON 형식이 아닙니다.";
      } catch (err) {
        // 취소는 오류가 아니다 — 재시도하지 않고 즉시 중단한다.
        if (isCancelledError(err)) return { ok: false, error: "", cancelled: true };
        lastError = `요약 호출 실패: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (attempt < SUMMARY_ATTEMPTS - 1) await delay(SUMMARY_RETRY_DELAY_MS);
    }
    return { ok: false, error: lastError };
  }

  /**
   * 앵커 하나가 담을 본문 글자 수 상한 — 모델의 실제 입력 한도 기준.
   * 프로필에 한도 정보가 있으면 지침/이전상태/출력 여유분을 뺀 값, 없으면 기본값.
   * 이 예산은 경계 계산(앵커를 더 잘게)에만 쓰이고 요청을 나누는 데는 쓰지 않는다.
   */
  private passageCharBudget(maxContextTokens?: number): number {
    if (typeof maxContextTokens === "number" && maxContextTokens > 0) {
      const passageTokens = Math.max(
        500,
        maxContextTokens - SUMMARY_RESERVE_TOKENS
      );
      return Math.max(1000, passageTokens * APPROX_CHARS_PER_TOKEN);
    }
    return SUMMARY_DEFAULT_PASSAGE_CHARS;
  }

  private async callModel(
    profile: { id: string; kind: "chat" | "text" },
    instruction: string,
    payload: string,
    signal?: AbortSignal
  ): Promise<string> {
    // 페이로드(JSON)는 지침의 {{main}} 위치에 결합. JSON 입출력 규약은 엔진 고정.
    const combined = composeMediaPrompt(instruction, payload);
    if (profile.kind === "text") {
      const r = await this.plugin.ai.generate({
        profileId: profile.id,
        prompt: `${SUMMARY_IO_INSTRUCTIONS}\n\n${combined}`,
        signal,
      });
      return r.text;
    }
    const r = await this.plugin.ai.chat({
      profileId: profile.id,
      messages: [
        { role: "system", content: SUMMARY_IO_INSTRUCTIONS },
        { role: "user", content: combined },
      ],
      signal,
    });
    return r.text;
  }
}

function fail(message: string): SummarizeResult {
  return { ok: false, skipped: false, errors: [message] };
}

function skip(): SummarizeResult {
  return { ok: true, skipped: true, errors: [] };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
