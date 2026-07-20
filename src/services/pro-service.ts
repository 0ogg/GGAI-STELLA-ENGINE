/**
 * 집필 프로(PRO) 게이트 + 이중 원고 파이프라인 실행기 (`plugin.pro`).
 *
 * 휴면 원칙 (집필 프로 스펙.md §1): 외부(개인 플러그인)가 `activate()` 를 호출하기
 * 전까지 PRO 는 어떤 표면도 드러내지 않는다 — 설정 패널 미등록, 라우팅은 소설 뷰,
 * 확장 목록/명령에도 없음. 뷰 타입 자체는 상시 등록돼 있지만(레이아웃 복원 대비)
 * 라우팅이 이쪽을 고르는 건 활성 상태일 때뿐이다.
 *
 * 파이프라인 (스펙 §3): `convertAndSplice` — 저자의 한국어(새 초고/문단 수정)를
 * 영어판 문체를 이어받은 영어 문단으로 변환해 임의 구간에 접합하고, 한국어를 문단
 * 짝(`authored` variant)으로 보존한다. 원고를 부분 반영으로 어긋나게 하지 않는다 —
 * 변환 실패 시 아무것도 저장하지 않는다.
 *
 * 개인 플러그인과의 접점은 3종으로 고정: activate() / 조회 API / store 이벤트.
 */

import { Notice } from "obsidian";
import type StellaEnginePlugin from "../main";
import { VIEW_TYPE_PRO_FOCUS } from "../constants";
import { ProGlossaryService } from "./pro-glossary-service";
import type { Patch, SessionNode, TurnKind } from "../types/session";
import { createProSettingsPanel } from "../views/detail/panels/pro-panel";
import { isCancelledError } from "./ai-service";
import { buildReadingMarkdown } from "../util/export-session";
import { buildSpans, spansToText } from "../util/session-text";
import { resolveMediaPrompt } from "../util/default-media-prompts";
import { composeMediaPrompt } from "../util/media-prompt-body";
import {
  getScenarioMediaLorebookIds,
  loadMediaLorebooks,
  mergeLorebookIds,
} from "../util/media-lorebook";
import {
  parseTranslationResponse,
  recordTranslationVariant,
} from "../util/translate-paragraphs";
import {
  assembleProConversion,
  buildProSpliceRequest,
  collectStylePairs,
  formatStylePairs,
  PRO_CONVERT_IO_INSTRUCTIONS,
  PRO_STYLE_PAIRS_DEFAULT,
  sliceStyleTail,
  type ProConvertAssembly,
  type ProSpliceRequest,
} from "../util/pro-convert";
import { uuidv4 } from "../util/uuid";

/** 문체 참조 첨부 기본값 (글자 수) — 설정 UI 로 조절. */
export const PRO_STYLE_TAIL_CHARS_DEFAULT = 3000;

/** 변환 형식 오류 시 총 시도 횟수 (첫 호출 포함). */
const CONVERT_MAX_ATTEMPTS = 2;

export interface ProConvertResult {
  ok: boolean;
  errors: string[];
  /** 사용자가/Core 가 취소한 경우 true (오류 아님 — 입력을 보존하고 조용히 멈춤). */
  cancelled?: boolean;
}

/**
 * 접합 연산 하나 — 영어판 [from, to) 구간을 한국어 `ko` 의 변환 결과로 바꾼다.
 * from === to === 본문 길이 = 끝에 덧붙임(새로 쓰기). expect 는 안전 검증용 —
 * 그 구간의 현재 영어 원문과 다르면(그 사이 본문이 바뀜) 전체 반영을 취소한다.
 */
export interface ProSpliceOp {
  from: number;
  to: number;
  ko: string;
  expect?: string;
}

/** getManuscript 의 meta — 개인 플러그인이 경로 규칙/표시에 쓰는 세션 신원. */
export interface ProManuscriptMeta {
  sessionId: string;
  sessionName: string;
  sessionFile: string;
  scenarioId: string;
  /** 시나리오 폴더명 (경로에서 추출 — 표시/폴더명 씨앗). */
  scenarioName: string;
  /** 시리즈(다음화) 연결 — 없으면 단독 세션. */
  series?: { id: string; name: string; index: number };
  proWriting: boolean;
  modifiedAt: number;
}

export interface ProManuscript {
  /** frontmatter(세션 id/이름/시나리오/시리즈) + 한국어판 활성 경로 전문. */
  markdown: string;
  meta: ProManuscriptMeta;
}

export class ProService {
  private active = false;
  private disposeSurfaces: (() => void) | null = null;
  /** 번역 용어집 자동 수집 (P6) — 집필 변환 성공 훅 + 패널 [지금 스캔]이 쓴다. */
  readonly glossary: ProGlossaryService;

  constructor(private plugin: StellaEnginePlugin) {
    this.glossary = new ProGlossaryService(plugin);
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * PRO 표면(설정 패널 + 라우팅)을 켠다. 개인 플러그인의 onload 에서 호출.
   * 반환된 핸들을 호출하면 전부 내려간다(개인 플러그인 onunload).
   * 이미 활성 상태면 아무것도 더 등록하지 않고 no-op 핸들을 돌려준다.
   */
  activate(): () => void {
    if (this.active) return () => {};
    this.active = true;
    const unregisterPanel = this.plugin.registerSettingsPanel(
      createProSettingsPanel()
    );
    this.disposeSurfaces = () => {
      unregisterPanel();
    };
    return () => this.deactivate();
  }

  private deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.disposeSurfaces?.();
    this.disposeSurfaces = null;
  }

  /** 집중 설정 뷰를 우측 사이드바에 연다 (있으면 reveal — revealDetail 패턴). */
  async openFocusView(): Promise<void> {
    if (!this.active) return;
    const workspace = this.plugin.app.workspace;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_PRO_FOCUS);
    if (existing[0]) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_PRO_FOCUS, active: true });
    workspace.revealLeaf(leaf);
  }

  /**
   * 세션의 집필 프로 표시를 켜고/끈다 (meta.proWriting). 저장은 store 경유,
   * 뷰 갈아끼우기는 하지 않는다 — 호출자가 필요하면 세션을 다시 연다.
   * 켤 때는 한국어판이 기본 화면이 되도록 표시 모드를 번역 보기로 전환한다.
   */
  async setSessionPro(sessionFile: string, on: boolean): Promise<boolean> {
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session) {
      new Notice("세션을 불러올 수 없습니다.");
      return false;
    }
    if (session.meta.mode === "chat") {
      new Notice("집필 프로는 소설 세션 전용입니다.");
      return false;
    }
    if (on) session.meta.proWriting = true;
    else delete session.meta.proWriting;
    if (on) {
      const translations =
        await this.plugin.store.getSessionTranslations(sessionFile);
      if (translations.displayMode !== "translation") {
        translations.displayMode = "translation";
        await this.plugin.store.saveSessionTranslations(sessionFile, translations);
      }
    }
    await this.plugin.store.saveSession(sessionFile, session, {
      kinds: ["settings"],
    });
    return true;
  }

  /**
   * 마크다운 미러 조회 API (스펙 §4, P3) — 개인 플러그인과의 접점 3종 중 "조회".
   *
   * markdown = 한국어판 활성 경로 전문: 번역 보기와 같은 규칙(번역된 문단은 번역,
   * 미번역 문단은 원문 — `buildReadingMarkdown` 재사용)에 frontmatter(세션 id/이름/
   * 시나리오/시리즈)를 얹는다. 삽화는 넣지 않는다 — 미러/메모보드가 쓰는 건 본문.
   * 변경 신호는 기존 store 이벤트(`session-changed`/`session-translations-changed`)
   * 그대로 — 새 이벤트를 만들지 않는다.
   *
   * 세션이 없으면 null. 챗 세션도 대화록 마크다운으로 동작한다(제한하지 않음).
   */
  async getManuscript(sessionFile: string): Promise<ProManuscript | null> {
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session) return null;
    const translations =
      await this.plugin.store.getSessionTranslations(sessionFile);
    const sessionFolder = sessionFile.replace(/\/session\.json$/, "");

    const body = buildReadingMarkdown({
      session,
      sessionFolder,
      illustrations: null,
      translations,
      mode: "translated",
      title: "",
    });

    const meta: ProManuscriptMeta = {
      sessionId: session.meta.id,
      sessionName: session.meta.name,
      sessionFile,
      scenarioId: session.meta.scenarioId,
      scenarioName:
        sessionFile.match(/(?:^|\/)SCENARIOS\/([^/]+)\//)?.[1] ?? "",
      series: session.meta.series
        ? {
            id: session.meta.series.id,
            name: session.meta.series.name,
            index: session.meta.series.index,
          }
        : undefined,
      proWriting: session.meta.proWriting === true,
      modifiedAt: session.meta.modifiedAt,
    };

    const fm: string[] = ["---"];
    const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    fm.push(`stella-session: ${q(meta.sessionId)}`);
    fm.push(`name: ${q(meta.sessionName)}`);
    fm.push(`scenarioId: ${q(meta.scenarioId)}`);
    if (meta.scenarioName) fm.push(`scenarioName: ${q(meta.scenarioName)}`);
    if (meta.series) {
      fm.push(`seriesId: ${q(meta.series.id)}`);
      fm.push(`seriesName: ${q(meta.series.name)}`);
      fm.push(`episode: ${meta.series.index}`);
    }
    fm.push(`sourcePath: ${q(sessionFile)}`);
    fm.push("---");

    return { markdown: `${fm.join("\n")}\n\n${body}`, meta };
  }

  /**
   * 저자의 한국어를 영어판에 접합한다 — 스펙 §3.1 의 핵심 프리미티브 "변환-접합-페어링".
   * 전송(끝에 덧붙임)/문단 수정/통째 붙여넣기가 전부 이 한 함수를 지난다.
   *
   *  1. 영어판 꼬리(문체 참조) + 각 op 의 한국어 문단들로 집필 변환 호출 (문단 1:1)
   *  2. 성공 시에만: 한국어 → `authored` 번역 variant (문단 짝) 저장 후
   *     op 별 영어를 한 노드의 patch 들로 접합 (교체 = replace / 끝 = append)
   * 실패/취소 시 세션·번역 모두 건드리지 않는다 — 호출자가 초고를 보존한다.
   * opts.origin: 발신 뷰 토큰 — 뷰가 자기 화면을 직접 갱신하므로 자기 에코 skip 용.
   */
  async convertAndSplice(
    sessionFile: string,
    ops: ProSpliceOp[],
    opts?: { origin?: string }
  ): Promise<ProConvertResult> {
    if (ops.length === 0) return fail("반영할 내용이 없습니다.");
    if (!this.plugin.ai.isAvailable()) {
      return fail("GGAI Core 가 설치/활성화되어 있지 않습니다.");
    }
    const session = await this.plugin.store.getSession(sessionFile);
    if (!session) return fail("세션을 불러올 수 없습니다.");
    if (session.meta.mode === "chat") {
      return fail("집필 프로는 소설 세션 전용입니다.");
    }

    // 구간 검증 — 범위/겹침/원문 일치(expect). 하나라도 어긋나면 전체 취소.
    const baseline = spansToText(buildSpans(session));
    const sorted = [...ops].sort((a, b) => a.from - b.from);
    let prevEnd = -1;
    for (const op of sorted) {
      if (op.from < 0 || op.to < op.from || op.to > baseline.length) {
        return fail("반영 구간이 본문 범위를 벗어났습니다.");
      }
      if (op.from < prevEnd) return fail("반영 구간이 서로 겹칩니다.");
      prevEnd = op.to;
      if (op.expect !== undefined && baseline.slice(op.from, op.to) !== op.expect) {
        return fail("그 사이 본문이 바뀌어 반영을 취소했습니다. 잠시 후 다시 반영됩니다.");
      }
      if (op.ko.trim() === "") return fail("빈 초고는 반영할 수 없습니다.");
    }

    const settings = await this.plugin.resolveActiveSettings(sessionFile);
    const proSettings = settings.pro ?? {};
    const prompt = resolveMediaPrompt(
      "proConvert",
      proSettings.promptId,
      this.plugin.data.mediaPrompts
    );
    if (!prompt) return fail("집필 변환 프롬프트가 선택되어 있지 않습니다.");
    const profile =
      this.plugin.ai.getProfileById(proSettings.modelProfileId) ??
      this.plugin.ai.getDefaultGenerationProfile();
    if (!profile) return fail("집필 변환에 사용할 모델 프로필이 없습니다.");

    const styleTail = sliceStyleTail(
      baseline,
      proSettings.styleTailChars ?? PRO_STYLE_TAIL_CHARS_DEFAULT
    );
    const request = buildProSpliceRequest(
      sorted.map((o) => o.ko),
      styleTail
    );
    if (request.perOp.some((p) => p.writeIds.length === 0)) {
      return fail("변환할 문단이 없습니다.");
    }

    // 문체 예시 — 최근 authored 문단 쌍 (양방향 자기강화, 스펙 §3.4). 페어링 저장에도
    // 같은 translations 객체를 쓴다 (store 캐시 공유).
    const translations =
      await this.plugin.store.getSessionTranslations(sessionFile);
    const pairsText = formatStylePairs(
      collectStylePairs(
        baseline,
        translations,
        proSettings.stylePairs ?? PRO_STYLE_PAIRS_DEFAULT
      ),
      "koToEn"
    );

    // 로어북(용어집)은 번역 설정과 공유한다 — 고유명사 표기의 단일 소스 (스펙 §8).
    const scanText = sorted.map((o) => o.ko).join("\n");
    const scenarioIds = await getScenarioMediaLorebookIds(
      this.plugin.store,
      sessionFile,
      "translation"
    );
    const books = await loadMediaLorebooks(
      this.plugin.store,
      mergeLorebookIds(settings.translation?.lorebookIds, scenarioIds)
    );
    const lorebookText = await this.plugin.lorebookPlus.buildTaskLorebookText({
      sessionFile,
      books,
      scanText,
      taskPrompt: prompt.prompt,
      taskLabel: "집필 변환",
    });

    let assemblies: ProConvertAssembly[] | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < CONVERT_MAX_ATTEMPTS; attempt++) {
      try {
        const responseText = await this.callModel(
          profile,
          prompt.prompt,
          request,
          lorebookText,
          pairsText
        );
        const parsed = parseTranslationResponse(responseText);
        if (!parsed || parsed.length === 0) {
          lastError = "변환 응답이 올바른 JSON 배열이 아닙니다.";
          continue;
        }
        const byId = new Map(parsed.map((r) => [r.id, r.translation]));
        const candidates = request.perOp.map((p) =>
          assembleProConversion(p, byId)
        );
        const bad = candidates.find((c) => !c.ok);
        if (!bad) {
          assemblies = candidates;
          break;
        }
        lastError = bad.errors[0] ?? "변환 응답이 불완전합니다.";
      } catch (err) {
        if (isCancelledError(err)) return { ok: false, errors: [], cancelled: true };
        lastError = `변환 호출 실패: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
    if (!assemblies) return fail(lastError || "변환에 실패했습니다.");

    // 짝 먼저 저장 — 세션 저장 직후 뷰가 번역 보기를 재구성할 때 authored 짝이
    // 이미 있어야 저자의 한국어가 곧바로 보인다 (영어가 스치듯 보이는 것 방지).
    const seen = new Set<string>();
    for (const assembly of assemblies) {
      for (const pair of assembly.pairs) {
        if (seen.has(pair.en)) continue;
        seen.add(pair.en);
        recordTranslationVariant(translations, {
          source: pair.en,
          text: pair.ko,
          kind: "authored",
        });
      }
    }
    await this.plugin.store.saveSessionTranslations(sessionFile, translations, {
      origin: opts?.origin,
    });

    // patch 는 뒤(from 큰 쪽)부터 — 앞선 patch 가 뒤 구간의 offset 을 바꾸지 않게.
    const patches: Patch[] = [];
    let hasReplace = false;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const op = sorted[i];
      const en = assemblies[i].englishText;
      if (op.from === baseline.length && op.to === baseline.length) {
        const prefix =
          baseline.length === 0 || baseline.endsWith("\n") ? "" : "\n";
        patches.push({
          op: "append",
          spans: [{ author: "user", text: prefix + en }],
        });
      } else {
        hasReplace = true;
        patches.push({
          op: "replace",
          from: op.from,
          to: op.to,
          spans: [{ author: "user", text: en }],
        });
      }
    }
    const kind: TurnKind = hasReplace ? "user-edit" : "user-write";
    const node: SessionNode = {
      id: uuidv4(),
      parent: session.meta.activeLeafId,
      kind,
      patches,
      createdAt: Date.now(),
    };
    session.nodes[node.id] = node;
    session.meta.activeLeafId = node.id;
    await this.plugin.store.saveSession(sessionFile, session, {
      origin: opts?.origin,
    });
    // 용어집 자동 수집 — 방금 늘어난 짝을 보고 주기가 찼으면 백그라운드로 스캔.
    void this.glossary.scanIfNeeded(sessionFile);
    return { ok: true, errors: [] };
  }

  private async callModel(
    profile: { id: string; kind: "chat" | "text" },
    instruction: string,
    request: ProSpliceRequest,
    lorebookText: string,
    pairsText: string
  ): Promise<string> {
    const payload = JSON.stringify(request.segments);
    // 본문(JSON 페이로드)은 지침의 {{main}}, 로어북은 {{lorebook}}, 문체 예시 쌍은
    // {{pairs}} 위치에 결합. JSON 입출력 규약(PRO_CONVERT_IO_INSTRUCTIONS)은 엔진 고정 프로토콜.
    const combined = composeMediaPrompt(instruction, payload, lorebookText, pairsText);
    if (profile.kind === "text") {
      const r = await this.plugin.ai.generate({
        profileId: profile.id,
        prompt: `${PRO_CONVERT_IO_INSTRUCTIONS}\n\n${combined}`,
        label: "집필 변환",
      });
      return r.text;
    }
    const r = await this.plugin.ai.chat({
      profileId: profile.id,
      messages: [
        { role: "system", content: PRO_CONVERT_IO_INSTRUCTIONS },
        { role: "user", content: combined },
      ],
      label: "집필 변환",
    });
    return r.text;
  }
}

function fail(message: string): ProConvertResult {
  return { ok: false, errors: [message] };
}
