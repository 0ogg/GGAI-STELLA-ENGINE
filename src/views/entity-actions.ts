/**
 * 시나리오/세션/페르소나/로어북 공용 액션 (사이드바/대시보드 공유).
 *
 * 생성/이름변경/삭제/임포트/세션 돌입처럼 "어느 화면에서든 같은 뜻"인 동작을
 * 한 곳에 둔다. 전부 store/plugin 경유 — view 별 후처리(목록 갱신, 탭 전환)는
 * 호출부 콜백으로 잇는다. 목록 재렌더 자체는 store 이벤트가 이미 전파한다.
 */

import { Notice, TFile } from "obsidian";
import type { ReadingExportMode } from "../util/export-session";
import type { ImportResult } from "../import";
import type { NaiStoryProgress } from "../import/parse-nai-story";
import {
  isSillyTavernChat,
  parseSillyTavernChat,
  type ParsedStChat,
} from "../import/parse-sillytavern-chat";
import { buildChatImportSession } from "../util/build-chat-import";
import type { SessionSeed } from "../util/new-session";
import {
  buildChatEpisodeTailNodes,
  buildEpisodeTailNodes,
  planChatEpisodeTail,
} from "../util/new-session";
import type { SessionMode, StellaSession } from "../types/session";
import type { ActiveSettings } from "../types/preset";
import type StellaEnginePlugin from "../main";
import { createEmptySessionSummaries } from "../types/summary";
import { buildSpans, pathToLeaf, spansToText } from "../util/session-text";
import {
  composeInheritedSummary,
  extractNewPassage,
  recordSummaryAnchor,
} from "../util/summarize-session";
import { uuidv4 } from "../util/uuid";
import type { LorebookListItem } from "../util/scan-lorebooks";
import type { ScenarioListItem } from "../util/scan-scenarios";
import type { SessionListItem } from "../util/scan-sessions";
import type { UserListItem } from "../util/scan-users";
import {
  defaultSessionName,
  firstMessageBranches,
} from "../util/scenario-list-helpers";
import { SESSION_SEED_SPLIT_MIN } from "../util/split-passage";
import {
  ChoiceModal,
  ConfirmModal,
  PromptModal,
  ScenarioSessionCopyModal,
  StChatImportModal,
  type StChatImportChoice,
} from "./modals";
import { GroupMemberModal, type GroupMemberRow } from "./group-member-modal";

// ─── 세션 돌입 ────────────────────────────────────────

export async function openSessionByPath(
  plugin: StellaEnginePlugin,
  sessionFile: string,
  opts?: { focusIllustrationNode?: string }
): Promise<void> {
  try {
    await plugin.store.touchSessionPlayed(sessionFile);
  } catch (err) {
    console.warn("[GGAI Stella] touch session played failed:", err);
  }
  // 세션이 기억하는 페르소나 → 전용 시나리오 페르소나 → 현재 활성 순으로 결정.
  await plugin.activateSessionPersona(sessionFile);
  await plugin.openStellaSession(sessionFile, opts);
}

/**
 * 기본 이름으로 새 세션을 만들어 바로 돌입. opts 는 임포트 진행분(씨드/메모리/작가노트) 오버라이드.
 * mode: 생략 = 소설(기존 동작). "ask" = 소설/채팅 선택 모달 (명시적 "새 세션" UI 전용 —
 * 임포트 후속 자동 생성 경로는 절대 "ask" 를 쓰지 않는다).
 */
export async function createAndOpenSession(
  plugin: StellaEnginePlugin,
  item: ScenarioListItem,
  opts?: {
    seed?: SessionSeed;
    memory?: string;
    authorNote?: string;
    mode?: SessionMode | "ask";
  }
): Promise<void> {
  let mode: SessionMode = opts?.mode === "chat" ? "chat" : "novel";
  if (opts?.mode === "ask") {
    const picked = await new Promise<string | null>((resolve) => {
      new ChoiceModal(
        plugin.app,
        "새 세션",
        "어떤 방식으로 시작할까요?",
        [
          { text: "소설", value: "novel", cta: true },
          { text: "채팅", value: "chat" },
        ],
        resolve
      ).open();
    });
    if (picked == null) return;
    mode = picked === "chat" ? "chat" : "novel";
  }
  const name = defaultSessionName(item);
  try {
    const scenarioId = await plugin.store.ensureScenarioId(item.scenarioFile);
    if (!scenarioId) {
      new Notice("시나리오 ID 를 결정할 수 없습니다.");
      return;
    }
    const result = await plugin.store.createSession(
      item.folder,
      scenarioId,
      name,
      opts?.seed ?? firstMessageBranches(item),
      plugin.data.current,
      mode
    );
    // 새 세션은 시작 시점의 활성 페르소나를 기억한다(없으면 기본 페르소나로 resolve).
    const activePersona = await plugin.resolveActiveUserProfile();
    result.session.meta.personaFile = activePersona.userFile;
    if (opts?.memory) result.session.meta.memory = opts.memory;
    if (opts?.authorNote) result.session.meta.authorNote = opts.authorNote;
    await plugin.store.saveSession(result.sessionFile, result.session);
    await openSessionByPath(plugin, result.sessionFile);
    new Notice(`세션 생성: ${name}`);
  } catch (err) {
    new Notice(
      `세션 생성 실패: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** 세션 이름에서 시리즈 표시명 유도 — 끝의 "N화"를 떼어낸다. 비면 원래 이름. */
function baseSeriesName(name: string): string {
  const base = name.replace(/\s*\d+\s*화\s*$/, "").trim();
  return base || name.trim() || "시리즈";
}

/**
 * 시리즈 계획(읽기 전용) — 다음 화의 시리즈명과 화 번호를 정한다.
 * seriesId 가 null 이면 아직 시리즈가 아니라서 실행 시 이 세션이 1화로 승격된다.
 *
 * 화 번호는 항상 **만드는 화 + 1** — 3화는 2화에서 만들어야 3화다. 1화에서 다음화를
 * 두 번 만들면 3화가 아니라 **다른 루트의 2화**가 된다(alternates 로 알려 경고 표시).
 * 실행(startNextEpisode)과 미리보기(NextEpisodeModal)가 같은 계산을 쓴다.
 */
export function resolveSeriesPlan(
  prev: StellaSession,
  siblings: SessionListItem[]
): {
  seriesId: string | null;
  seriesName: string;
  newIndex: number;
  /** 새 화와 같은 번호를 이미 가진 화들 — 있으면 이번 생성은 루트 분기다. */
  alternates: SessionListItem[];
} {
  if (prev.meta.series) {
    const seriesId = prev.meta.series.id;
    const newIndex = prev.meta.series.index + 1;
    const alternates = siblings.filter((it) => {
      const s = it.session.meta.series;
      return s && s.id === seriesId && s.index === newIndex;
    });
    return {
      seriesId,
      seriesName: prev.meta.series.name,
      newIndex,
      alternates,
    };
  }
  return {
    seriesId: null,
    seriesName: baseSeriesName(prev.meta.name),
    newIndex: 2,
    alternates: [],
  };
}

/** 세션의 최근성 — 루트가 갈릴 때 "가장 최근에 플레이한 쪽"을 고르는 기준. */
function seriesRecency(it: SessionListItem): number {
  const m = it.session.meta;
  return m.lastPlayedAt || m.modifiedAt || m.createdAt || 0;
}

/**
 * 시리즈 루트(경로) 계산 — 현재 화에서 prevId 를 따라 과거로, 자식 화(여럿이면
 * 가장 최근 플레이)를 따라 미래로 걸어, 현재 세션이 속한 한 루트를 화 순서대로
 * 돌려준다. prevId 없는 구버전 데이터는 인접 index 로 잇는다(선형 시리즈 가정).
 */
export function collectSeriesRoute(
  currentFile: string,
  episodes: SessionListItem[]
): SessionListItem[] {
  const cur = episodes.find((e) => e.sessionFile === currentFile);
  if (!cur) {
    return episodes
      .slice()
      .sort(
        (a, b) =>
          (a.session.meta.series?.index ?? 0) -
          (b.session.meta.series?.index ?? 0)
      );
  }
  const byId = new Map(episodes.map((e) => [e.session.meta.id, e]));
  const pickRecent = (cands: SessionListItem[]): SessionListItem | null =>
    cands.length === 0
      ? null
      : cands.reduce((a, b) => (seriesRecency(b) > seriesRecency(a) ? b : a));

  const prevOf = (e: SessionListItem): SessionListItem | null => {
    const s = e.session.meta.series;
    if (!s) return null;
    if (s.prevId) return byId.get(s.prevId) ?? null;
    return pickRecent(
      episodes.filter((x) => x.session.meta.series?.index === s.index - 1)
    );
  };
  const nextOf = (e: SessionListItem): SessionListItem | null => {
    const id = e.session.meta.id;
    const idx = e.session.meta.series?.index ?? 0;
    return pickRecent(
      episodes.filter((x) => {
        const s = x.session.meta.series;
        if (!s) return false;
        if (s.prevId) return s.prevId === id;
        return s.index === idx + 1;
      })
    );
  };

  const visited = new Set<string>([cur.sessionFile]);
  const route: SessionListItem[] = [cur];
  for (let e = prevOf(cur); e && !visited.has(e.sessionFile); e = prevOf(e)) {
    visited.add(e.sessionFile);
    route.unshift(e);
  }
  for (let e = nextOf(cur); e && !visited.has(e.sessionFile); e = nextOf(e)) {
    visited.add(e.sessionFile);
    route.push(e);
  }
  return route;
}

/**
 * 최근 N 노드 경계와 그 이후 본문(tail) — 다음 화 시작 부분에 그대로 심는 구간.
 * 경계가 없으면(count ≥ 경로 길이) 전체 본문이 tail. 실행/미리보기 공용.
 */
export function planEpisodeTail(
  prev: StellaSession,
  count: number
): { boundaryNodeId: string | null; tail: string } {
  const path = pathToLeaf(prev, prev.meta.activeLeafId);
  const boundaryIndex = path.length - 1 - count;
  const boundaryNodeId = boundaryIndex >= 0 ? path[boundaryIndex].id : null;
  const fullText = spansToText(buildSpans(prev, prev.meta.activeLeafId));
  let tail = fullText;
  if (boundaryNodeId) {
    const prefix = spansToText(buildSpans(prev, boundaryNodeId));
    tail = extractNewPassage(prefix, fullText);
  }
  return { boundaryNodeId, tail };
}

// 챗 세션의 다음화 인계 계획(planChatEpisodeTail)은 순수 로직이라
// src/util/new-session.ts 에 있다 — buildChatEpisodeTailNodes 와 한 쌍.

/**
 * 다음화 — 지금 세션이 너무 길어졌을 때, **누적 요약 + 최근 노드 N개 + 모든 설정**을
 * 물려받은 새 세션(다음 화)을 만들어 바로 이어쓰게 한다. 두 세션은 시리즈로 연결된다.
 * 이름은 묻지 않고 바로 "N화"로 붙인다(우측 디테일 시나리오 탭에서 노드 수만 지정).
 *
 * 흐름:
 *  1. 열린 편집을 커밋(flush)하고, 최근 N 노드 직전까지 요약을 정리(catch-up)한다 —
 *     그래야 물려주는 요약이 최근 노드 앞까지 빈틈없이 커버된다.
 *  2. 새 세션 = 빈 root(상속 요약 앵커) + 최근 N 노드 본문(tail) 체인. 설정/메모리/
 *     작가노트/로어북/페르소나까지 전부 복사. 시리즈 index 를 붙여 연결.
 */
export async function startNextEpisode(
  plugin: StellaEnginePlugin,
  sessionFile: string,
  recentCount: number
): Promise<boolean> {
  const count = Math.max(1, Math.floor(recentCount) || 3);
  // 실패 시 어느 단계였는지 알리기 위한 태그 — 사용자 Notice 와 콘솔에 함께 표시.
  let step = "편집 저장";
  try {
    // 열린 세션의 미저장 편집을 먼저 커밋 — 방금 친 문단까지 물려주도록.
    await plugin.flushSessionEdits(sessionFile);
    step = "세션 읽기";
    const prev = await plugin.store.getSession(sessionFile);
    if (!prev) {
      new Notice("세션을 불러올 수 없습니다.");
      return false;
    }

    step = "본문 경계 계산";
    // 챗 세션은 메시지 단위(역할 유지)로, 소설은 평문 tail 로 인계한다.
    const chatPlan =
      prev.meta.mode === "chat" ? planChatEpisodeTail(prev, count) : null;
    const { boundaryNodeId, tail } = chatPlan
      ? { boundaryNodeId: chatPlan.boundaryNodeId, tail: "" }
      : planEpisodeTail(prev, count);

    // 최근 노드 앞까지 요약 정리 (요약 사용 중일 때만) — 빈틈없이 물려주기 위해.
    step = "설정 읽기";
    const settings = await plugin.resolveActiveSettings(sessionFile);
    if (boundaryNodeId && settings.summarize?.enabled === true) {
      new Notice("이전 화 요약 정리 중…");
      try {
        await plugin.summary.summarize(sessionFile, boundaryNodeId);
      } catch (err) {
        console.warn("[GGAI Stella] 다음화 요약 정리 실패:", err);
      }
    }
    step = "요약 상속";
    const summaries = await plugin.store.getSessionSummaries(sessionFile);
    const inherited = boundaryNodeId
      ? composeInheritedSummary(prev, summaries, boundaryNodeId)
      : { events: "", state: "" };

    // 시리즈 결정 — 화 번호는 만드는 화 + 1. 같은 번호가 이미 있으면 루트 분기.
    step = "시리즈 계산";
    const scenarioFolder = sessionFile.split("/SESSIONS/")[0];
    const siblings = await plugin.store
      .getSessions(scenarioFolder)
      .catch((): SessionListItem[] => []);
    const plan = resolveSeriesPlan(prev, siblings);
    const seriesName = plan.seriesName;
    const newIndex = plan.newIndex;
    let seriesId = plan.seriesId;
    if (!seriesId) {
      step = "1화 승격 저장";
      seriesId = uuidv4();
      prev.meta.series = { id: seriesId, name: seriesName, index: 1 };
      await plugin.store.saveSession(sessionFile, prev);
    }

    // 새 세션 — 활성 설정 상속.
    const initial: ActiveSettings = {
      modelProfileId: prev.meta.modelProfileId,
      params: prev.meta.params ? { ...prev.meta.params } : undefined,
      promptSetId: prev.meta.promptSetId,
      translation: prev.meta.translation ? { ...prev.meta.translation } : undefined,
      illustration: prev.meta.illustration
        ? { ...prev.meta.illustration }
        : undefined,
      summarize: prev.meta.summarize ? { ...prev.meta.summarize } : undefined,
      naiFormat: prev.meta.naiFormat,
      continueAnchor: prev.meta.continueAnchor,
    };
    // 루트 분기면 제목에 루트 번호를 붙여 목록에서 구분되게 한다.
    const newName =
      plan.alternates.length > 0
        ? `${seriesName} ${newIndex}화 (루트 ${plan.alternates.length + 1})`
        : `${seriesName} ${newIndex}화`;
    step = "새 세션 생성";
    const result = await plugin.store.createSession(
      scenarioFolder,
      prev.meta.scenarioId,
      newName,
      "",
      initial,
      prev.meta.mode
    );
    const ns = result.session;
    step = "본문 인계";
    const now = Date.now();
    const rootId = ns.meta.rootId;
    const tailBuilt = chatPlan
      ? buildChatEpisodeTailNodes(rootId, chatPlan.messages, now)
      : buildEpisodeTailNodes(rootId, tail, now);
    Object.assign(ns.nodes, tailBuilt.nodes);
    ns.meta.activeLeafId = tailBuilt.leafId;

    // 나머지 물려받기 (전부).
    ns.meta.memory = prev.meta.memory;
    ns.meta.authorNote = prev.meta.authorNote;
    ns.meta.disabledScenarioLorebookIds = prev.meta.disabledScenarioLorebookIds
      ? [...prev.meta.disabledScenarioLorebookIds]
      : undefined;
    ns.meta.extraLorebookIds = prev.meta.extraLorebookIds
      ? [...prev.meta.extraLorebookIds]
      : undefined;
    ns.meta.variables = prev.meta.variables ? { ...prev.meta.variables } : undefined;
    ns.meta.personaFile = prev.meta.personaFile;
    ns.meta.novelChatRoleMode = prev.meta.novelChatRoleMode;
    ns.meta.enabledAgents = prev.meta.enabledAgents
      ? [...prev.meta.enabledAgents]
      : undefined;
    // prevId = 만든 화의 세션 id — 루트 분기 시 어느 루트인지 식별.
    ns.meta.series = {
      id: seriesId,
      name: seriesName,
      index: newIndex,
      prevId: prev.meta.id,
    };
    // 자동 제목 생성이 "n화" 이름을 덮어쓰지 않게.
    ns.meta.autoTitleGenerated = true;
    await plugin.store.saveSession(result.sessionFile, ns);

    // 상속 요약을 새 화 root 앵커로 심는다 (tail 은 root 자식이라 새 화에서 정상 요약됨).
    if (inherited.events.trim() !== "" || inherited.state.trim() !== "") {
      step = "요약 앵커 저장";
      const sum = createEmptySessionSummaries();
      recordSummaryAnchor(sum, {
        nodeId: rootId,
        events: inherited.events,
        state: inherited.state,
        now,
      });
      await plugin.store.saveSessionSummaries(result.sessionFile, sum);
    }

    step = "새 화 열기";
    await openSessionByPath(plugin, result.sessionFile);
    new Notice(`다음화 생성: ${newName}`);
    return true;
  } catch (err) {
    console.error(`[GGAI Stella] 다음화 생성 실패 (${step}):`, err);
    new Notice(
      `다음화 생성 실패 (${step}): ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/**
 * 시나리오 복사 — 포함할 세션을 고르는 모달을 띄운 뒤 새 시나리오(새 고유 id)로 복사한다.
 * 세션을 하나도 안 고르면 시나리오만 복사된다. store 이벤트가 목록을 자동 갱신한다.
 */
export async function copyScenarioWithPrompt(
  plugin: StellaEnginePlugin,
  item: ScenarioListItem
): Promise<void> {
  const sessions = await plugin.store.getSessions(item.folder).catch(() => []);
  new ScenarioSessionCopyModal(
    plugin.app,
    item.scenario.data.name || item.folderName,
    sessions,
    async (selected) => {
      try {
        await plugin.store.copyScenario(item.scenarioFile, selected);
        new Notice(
          selected.length > 0
            ? `시나리오 복사 완료 · 세션 ${selected.length}개 포함`
            : "시나리오 복사 완료"
        );
      } catch (err) {
        new Notice(
          `시나리오 복사 실패: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  ).open();
}

/**
 * 프롬프트 세트를 SillyTavern 호환 JSON 파일로 **기기에 다운로드**한다(vault 안이 아니라
 * OS 다운로드 폴더 — 실리태번 등 외부 앱에 바로 옮길 수 있게). 사이드바/디테일/대시보드 공유.
 */
export async function exportPromptPreset(
  plugin: StellaEnginePlugin,
  presetFile: string
): Promise<void> {
  try {
    const { name, json } = await plugin.store.buildPromptPresetExportJson(
      presetFile
    );
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    new Notice(`다운로드: ${name}.json`);
  } catch (err) {
    new Notice(
      `내보내기 실패: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * 세션의 현재 분기를 읽기 모드 마크다운으로 내보낸다.
 * 원문/번역을 고른 뒤 store 가 파일을 만들고, 만든 문서를 새 탭으로 연다.
 * 저장 위치는 설정의 내보내기 폴더(비면 vault 루트).
 */
export function exportSessionReading(
  plugin: StellaEnginePlugin,
  s: SessionListItem
): void {
  new ChoiceModal(
    plugin.app,
    "읽기 모드로 내보내기",
    "현재 분기의 본문과 삽화를 마크다운 문서로 내보냅니다. 어떤 버전으로 내보낼까요?",
    [
      { text: "원문", value: "source", cta: true },
      { text: "번역", value: "translated" },
    ],
    (value) => {
      if (!value) return;
      void (async () => {
        try {
          const path = await plugin.store.exportSessionReading(
            s.sessionFile,
            value as ReadingExportMode,
            plugin.data.settings?.exportFolder || undefined
          );
          new Notice(`내보내기 완료: ${path}`);
          const file = plugin.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            await plugin.app.workspace.getLeaf(true).openFile(file);
          }
        } catch (err) {
          new Notice(
            `내보내기 실패: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })();
    }
  ).open();
}

/** 세션을 복사한다. onDone 에 새 세션 파일 경로를 넘긴다 (열기 등 후처리용). */
export async function copySession(
  plugin: StellaEnginePlugin,
  s: SessionListItem,
  onDone?: (newSessionFile: string) => void | Promise<void>
): Promise<void> {
  try {
    const result = await plugin.store.copySession(s.sessionFile);
    await onDone?.(result.sessionFile);
    new Notice(`세션 복사: ${result.session.meta.name}`);
  } catch (err) {
    new Notice(
      `세션 복사 실패: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ─── 그룹 초대 (G1) ───────────────────────────────────

/**
 * 사이드바 시나리오 우클릭 메뉴의 "현재 세션에 초대" 항목 정보.
 * 초대 가능하면 { label, run } — 라벨에 대상 세션(시나리오:세션명)을 박아 오초대 방지.
 * 활성 세션이 없거나, 자기 자신이거나, 이미 멤버면 null (항목 미노출).
 */
export async function getInviteToActiveSession(
  plugin: StellaEnginePlugin,
  item: ScenarioListItem
): Promise<{ label: string; run: () => Promise<void> } | null> {
  const sessionFile = plugin.getActiveOrLastSessionFile();
  if (!sessionFile) return null;
  const session = await plugin.store.getSession(sessionFile).catch(() => null);
  if (!session) return null;

  const invitedId = item.scenario.data?.extensions?.stella?.id;
  if (!invitedId || invitedId === session.meta.scenarioId) return null;
  if (session.meta.groupId) {
    const g = await plugin.store.getGroupById(session.meta.groupId);
    if (g?.group.members.some((m) => m.scenarioId === invitedId)) return null;
  }

  const hostName = await resolveScenarioNameById(plugin, session.meta.scenarioId);
  const label = `현재 세션에 초대: ${hostName}:${session.meta.name}`;
  return {
    label,
    run: () => inviteScenarioToSession(plugin, item, sessionFile),
  };
}

/**
 * 시나리오를 세션에 중간 합류시킨다 (초대 = 그룹 자동 생성/확장).
 *  - 세션에 그룹이 없으면: 호스트+초대 멤버로 새 그룹 생성 후 세션에 링크(groupId).
 *  - 이미 그룹 세션이면: 그 그룹에 멤버 추가 (같은 그룹을 쓰는 다른 세션에도 반영).
 * 초대 시점 이후 생성부터 멤버 프로필이 컨텍스트에 합류한다 (util/group-lorebook.ts).
 */
export async function inviteScenarioToSession(
  plugin: StellaEnginePlugin,
  item: ScenarioListItem,
  sessionFile: string
): Promise<void> {
  try {
    const session = await plugin.store.getSession(sessionFile);
    if (!session) throw new Error("세션을 불러올 수 없습니다.");
    const invitedId = item.scenario.data?.extensions?.stella?.id;
    if (!invitedId) throw new Error("이 시나리오에는 고유 ID가 없습니다.");
    if (invitedId === session.meta.scenarioId) {
      new Notice("이 세션의 주인공은 이미 참여 중입니다.");
      return;
    }

    const existing = session.meta.groupId
      ? await plugin.store.getGroupById(session.meta.groupId)
      : null;
    if (existing) {
      if (existing.group.members.some((m) => m.scenarioId === invitedId)) {
        new Notice("이미 이 세션에 참여 중입니다.");
        return;
      }
      existing.group.members.push({ scenarioId: invitedId });
      await plugin.store.saveGroup(existing.groupFile, existing.group);
    } else {
      // 그룹이 없던(또는 삭제된) 세션 — 호스트+초대 멤버로 그룹 자동 생성.
      const created = await plugin.store.createGroup(session.meta.name, [
        session.meta.scenarioId,
        invitedId,
      ]);
      session.meta.groupId = created.group.id;
      await plugin.store.saveSession(sessionFile, session, {
        kinds: ["settings"],
      });
    }
    new Notice(
      `「${item.scenario.data.name}」이(가) 「${session.meta.name}」 세션에 합류했습니다.`
    );
  } catch (err) {
    new Notice(`초대 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 그룹 멤버 관리 팝업 열기 (G1) — 세션 메뉴에서 호출.
 * 그룹 세션의 멤버 목록을 모달로 띄우고, 체크 해제된 멤버를 그룹에서 뺀다.
 * 주인공(세션 scenarioId)은 항상 남는다.
 */
export async function openGroupMemberManager(
  plugin: StellaEnginePlugin,
  sessionFile: string
): Promise<void> {
  const session = await plugin.store.getSession(sessionFile).catch(() => null);
  if (!session?.meta.groupId) {
    new Notice("그룹 세션이 아닙니다.");
    return;
  }
  const groupItem = await plugin.store.getGroupById(session.meta.groupId);
  if (!groupItem) {
    new Notice("그룹 정보를 찾을 수 없습니다.");
    return;
  }
  const scenarios: ScenarioListItem[] = await plugin.store
    .getScenarios()
    .catch(() => []);
  const byId = new Map<string, ScenarioListItem>();
  for (const i of scenarios) {
    const id = i.scenario.data?.extensions?.stella?.id;
    if (id) byId.set(id, i);
  }
  const hostId = session.meta.scenarioId;

  const rows: GroupMemberRow[] = groupItem.group.members.map((m) => {
    const sc = byId.get(m.scenarioId);
    return {
      scenarioId: m.scenarioId,
      name: sc?.scenario.data.name?.trim() || "(사라진 캐릭터)",
      thumbnailPath: sc?.thumbnailPath ?? null,
      isHost: m.scenarioId === hostId,
    };
  });
  // 안전장치 — 멤버 목록에 주인공이 없으면 맨 앞에 넣는다.
  if (!rows.some((r) => r.isHost)) {
    const sc = byId.get(hostId);
    rows.unshift({
      scenarioId: hostId,
      name: sc?.scenario.data.name?.trim() || "주인공",
      thumbnailPath: sc?.thumbnailPath ?? null,
      isHost: true,
    });
  }

  new GroupMemberModal(
    plugin.app,
    session.meta.name,
    rows,
    async (keptIds) => {
      const kept = new Set(keptIds);
      kept.add(hostId); // 주인공은 무조건 유지
      const next = groupItem.group.members.filter((m) => kept.has(m.scenarioId));
      if (!next.some((m) => m.scenarioId === hostId)) {
        next.unshift({ scenarioId: hostId });
      }
      groupItem.group.members = next;
      try {
        await plugin.store.saveGroup(groupItem.groupFile, groupItem.group);
        new Notice("그룹 멤버를 저장했습니다.");
      } catch (err) {
        new Notice(
          `저장 실패: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  ).open();
}

/** 시나리오 stella.id → 표시 이름. 못 찾으면 "시나리오". */
async function resolveScenarioNameById(
  plugin: StellaEnginePlugin,
  scenarioId: string
): Promise<string> {
  const list: ScenarioListItem[] = await plugin.store
    .getScenarios()
    .catch(() => []);
  const found = list.find(
    (i) => i.scenario.data?.extensions?.stella?.id === scenarioId
  );
  return found?.scenario.data.name?.trim() || "시나리오";
}

// ─── 생성 ─────────────────────────────────────────────

export function promptNewScenario(plugin: StellaEnginePlugin): void {
  new PromptModal(plugin.app, "새 시나리오", "시나리오 이름", "새 시나리오", (name) => {
    if (name == null || !name.trim()) return;
    void (async () => {
      try {
        const result = await plugin.store.createScenario(name.trim());
        await plugin.openStellaEditor("scenario", result.scenarioFile);
        new Notice(`시나리오 생성: ${name.trim()}`);
      } catch (err) {
        new Notice(
          `시나리오 생성 실패: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();
  }).open();
}

export function promptNewUser(
  plugin: StellaEnginePlugin,
  onCreated?: () => void | Promise<void>
): void {
  new PromptModal(plugin.app, "새 페르소나", "페르소나 이름", "User", (name) => {
    if (name == null || !name.trim()) return;
    void (async () => {
      try {
        const result = await plugin.store.createUserProfile(name.trim());
        await plugin.openStellaEditor("user", result.userFile);
        new Notice(`페르소나 생성: ${name.trim()}`);
        await onCreated?.();
      } catch (err) {
        new Notice(
          `페르소나 생성 실패: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();
  }).open();
}

export function promptNewLorebook(plugin: StellaEnginePlugin): void {
  new PromptModal(plugin.app, "새 로어북", "로어북 이름", "새 로어북", (name) => {
    if (name == null || !name.trim()) return;
    void (async () => {
      try {
        const result = await plugin.store.createLorebook(name.trim());
        new Notice(`로어북 생성: ${name.trim()}`);
        // 자동으로 편집기 열기 — 빈 책 만든 직후 사용자가 바로 채울 수 있게.
        await plugin.openStellaEditor("lorebook", result.lorebookFile);
      } catch (err) {
        new Notice(
          `로어북 생성 실패: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();
  }).open();
}

// ─── 이름 변경 ────────────────────────────────────────

export function promptRenameScenario(
  plugin: StellaEnginePlugin,
  item: ScenarioListItem
): void {
  new PromptModal(
    plugin.app,
    "시나리오 이름 변경",
    "시나리오 이름",
    item.scenario.data.name || item.folderName,
    (value) => {
      const name = value?.trim();
      if (!name || name === item.scenario.data.name) return;
      void (async () => {
        try {
          await plugin.store.renameScenario(item.scenarioFile, name);
          new Notice(`시나리오 이름 변경: ${name}`);
        } catch (err) {
          new Notice(
            `이름 변경 실패: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })();
    }
  ).open();
}

export function promptRenameSession(
  plugin: StellaEnginePlugin,
  s: SessionListItem,
  onRenamed?: (oldFile: string, newFile: string) => void | Promise<void>
): void {
  new PromptModal(
    plugin.app,
    "세션 제목 변경",
    "세션 제목",
    s.session.meta.name || s.folderName,
    (value) => {
      const name = value?.trim();
      if (!name) return;
      if (name === s.session.meta.name && s.folderName === name) return;
      void (async () => {
        try {
          const result = await plugin.store.renameSession(s.sessionFile, name);
          await onRenamed?.(result.oldSessionFile, result.newSessionFile);
          new Notice(`세션 제목 변경: ${name}`);
        } catch (err) {
          new Notice(
            `세션 제목 변경 실패: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })();
    }
  ).open();
}

// ─── 삭제 (확인 다이얼로그 포함) ──────────────────────

export function confirmDeleteScenario(
  plugin: StellaEnginePlugin,
  item: ScenarioListItem
): void {
  new ConfirmModal(
    plugin.app,
    "시나리오 삭제",
    `"${item.scenario.data.name || item.folderName}" 폴더를 휴지통으로 옮깁니다. 계속할까요?`,
    "삭제",
    (confirmed) => {
      if (!confirmed) return;
      void (async () => {
        try {
          await plugin.store.deleteScenario(item.folder);
          new Notice(`삭제됨: ${item.folder} · 휴지통에서 복구할 수 있어요`);
        } catch (err) {
          new Notice(
            `삭제 실패: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })();
    }
  ).open();
}

export function confirmDeleteSession(
  plugin: StellaEnginePlugin,
  s: SessionListItem
): void {
  new ConfirmModal(
    plugin.app,
    "세션 삭제",
    `"${s.session.meta.name || s.folderName}" 세션을 휴지통으로 옮깁니다. 계속할까요?`,
    "삭제",
    (confirmed) => {
      if (!confirmed) return;
      void (async () => {
        try {
          await plugin.store.deleteSession(s.folder);
          new Notice(`삭제됨: ${s.folder} · 휴지통에서 복구할 수 있어요`);
        } catch (err) {
          new Notice(
            `삭제 실패: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })();
    }
  ).open();
}

export function confirmDeleteUser(
  plugin: StellaEnginePlugin,
  item: UserListItem
): void {
  new ConfirmModal(
    plugin.app,
    "페르소나 삭제",
    `"${item.profile.name}" 페르소나를 휴지통으로 옮깁니다. 계속할까요?`,
    "삭제",
    (confirmed) => {
      if (!confirmed) return;
      void (async () => {
        try {
          await plugin.store.deleteUserProfile(item.userFile);
          new Notice(`삭제됨: ${item.profile.name} · 휴지통에서 복구할 수 있어요`);
        } catch (err) {
          new Notice(
            `삭제 실패: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })();
    }
  ).open();
}

export function confirmDeleteLorebook(
  plugin: StellaEnginePlugin,
  item: LorebookListItem
): void {
  new ConfirmModal(
    plugin.app,
    "로어북 삭제",
    `"${item.lorebook.meta.name || item.folderName}" 폴더를 휴지통으로 옮깁니다. 이 책을 참조하는 시나리오/세션의 연결은 끊깁니다. 계속할까요?`,
    "삭제",
    (confirmed) => {
      if (!confirmed) return;
      void (async () => {
        try {
          await plugin.store.deleteLorebook(item.folder.path);
          new Notice(`삭제됨: ${item.folder.path} · 휴지통에서 복구할 수 있어요`);
        } catch (err) {
          new Notice(
            `삭제 실패: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })();
    }
  ).open();
}

// ─── 임포트 ───────────────────────────────────────────

/** 파일 선택창을 띄워 임포트하고 결과 Notice + 시나리오면 에디터 자동 열기. */
export function runImportPicker(plugin: StellaEnginePlugin): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.jsonl,.lorebook,.scenario,.story,.png,.apng,.charx";
  input.style.display = "none";

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // 실리태번 채팅(.jsonl) — 시나리오/세션 임포트와 경로가 다르다(세션만 생성, 카드 없음).
      if (file.name.toLowerCase().endsWith(".jsonl")) {
        const text = new TextDecoder("utf-8").decode(bytes);
        if (!isSillyTavernChat(text)) {
          new Notice("실리태번 채팅(.jsonl) 형식이 아닙니다.");
          return;
        }
        await openStChatImport(plugin, text);
        return;
      }
      const result = await plugin.store.importFile(bytes, file.name);
      reportImportResult(plugin, file.name, result);
      // 시나리오 임포트는 후속 열기까지 처리 (진행분이 있으면 세션으로 바로 돌입).
      if (result.kind === "scenario" && result.write.ok) {
        await openImportedScenario(plugin, result.write.scenarioFile, result.story);
      }
      // store 가 vault 이벤트 받아 자동 갱신함.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`임포트 실패: ${msg}`);
      console.error("[GGAI Stella] import failed:", err);
    }
  });

  document.body.appendChild(input);
  input.click();
}

/**
 * 임포트된 시나리오의 후속 열기.
 *  - NAI .story 임포트면 출처(ai/user) 보존 씨드 + 메모리/작가노트 내용으로
 *    세션을 바로 만들어 연다 (크기 무관 — 스토리 파일 = 진행 기록이므로).
 *  - 진행분(큰 first_mes)이 있으면 그 진행을 이어받는 세션을 바로 만들어 열어
 *    사용자가 NAI 등에서 하던 이야기를 곧장 이어쓰게 한다.
 *  - 진행분이 없으면(짧은 도입부/캐릭터 카드) 기존대로 시나리오 에디터를 연다.
 */
async function openImportedScenario(
  plugin: StellaEnginePlugin,
  scenarioFile: string,
  story?: NaiStoryProgress
): Promise<void> {
  let item: ScenarioListItem | undefined;
  try {
    const scenarios = await plugin.store.getScenarios();
    item = scenarios.find((s) => s.scenarioFile === scenarioFile);
  } catch {
    item = undefined;
  }

  if (item && story) {
    await createAndOpenSession(plugin, item, {
      seed: story.seed,
      memory: story.memory,
      authorNote: story.authorNote,
    });
    return;
  }

  const firstMes = item?.scenario.data?.first_mes ?? "";
  if (item && firstMes.length > SESSION_SEED_SPLIT_MIN) {
    await createAndOpenSession(plugin, item);
    return;
  }

  await plugin.openStellaEditor("scenario", scenarioFile);
}

// ─── 실리태번 채팅(.jsonl) 임포트 ───────────────────────

/** 채팅을 파싱하고 등록 창(모드/시나리오 선택)을 띄운다. */
async function openStChatImport(
  plugin: StellaEnginePlugin,
  text: string
): Promise<void> {
  const parsed = parseSillyTavernChat(text);
  if (parsed.messages.length === 0) {
    new Notice("가져올 메시지가 없습니다.");
    return;
  }
  const scenarios = await plugin.store.getScenarios();
  new StChatImportModal(plugin.app, parsed, scenarios, (choice) => {
    if (!choice) return;
    void performStChatImport(plugin, parsed, choice);
  }).open();
}

/** 선택된 모드/시나리오로 세션(+번역)을 만들어 연다. */
async function performStChatImport(
  plugin: StellaEnginePlugin,
  parsed: ParsedStChat,
  choice: StChatImportChoice
): Promise<void> {
  try {
    // 1) 붙일 시나리오 결정 (없으면 캐릭터명으로 새로 만든다).
    let scenarioFile = choice.scenarioFile;
    let scenarioFolder: string;
    if (!scenarioFile) {
      const created = await plugin.store.createScenario(
        parsed.characterName || "가져온 채팅"
      );
      scenarioFile = created.scenarioFile;
      scenarioFolder = created.folder;
    } else {
      scenarioFolder = scenarioFile.replace(/\/scenario\.json$/, "");
    }

    const scenarioId = await plugin.store.ensureScenarioId(scenarioFile);
    if (!scenarioId) {
      new Notice("시나리오 ID 를 결정할 수 없습니다.");
      return;
    }

    // 2) 노드 트리 빌드 후 빈 세션에 심는다.
    const now = Date.now();
    const built = buildChatImportSession(parsed, choice.mode, now);
    const scenarios = await plugin.store.getScenarios();
    const item = scenarios.find((s) => s.scenarioFile === scenarioFile);
    const name = item ? defaultSessionName(item) : parsed.characterName || "채팅";

    const result = await plugin.store.createSession(
      scenarioFolder,
      scenarioId,
      name,
      "",
      plugin.data.current,
      choice.mode
    );
    result.session.nodes = built.nodes;
    result.session.meta.rootId = built.rootId;
    result.session.meta.activeLeafId = built.activeLeafId;
    const persona = await plugin.resolveActiveUserProfile();
    result.session.meta.personaFile = persona.userFile;
    await plugin.store.saveSession(result.sessionFile, result.session);

    await openSessionByPath(plugin, result.sessionFile);
    new Notice(
      `채팅 가져오기 완료: 메시지 ${parsed.messages.length}개 (${
        choice.mode === "chat" ? "채팅" : "소설"
      })`
    );
  } catch (err) {
    new Notice(
      `채팅 가져오기 실패: ${err instanceof Error ? err.message : String(err)}`
    );
    console.error("[GGAI Stella] st chat import failed:", err);
  }
}

function reportImportResult(
  plugin: StellaEnginePlugin,
  filename: string,
  result: ImportResult
): void {
  if (result.kind === "error") {
    new Notice(`임포트 실패 (${filename}): ${result.error}`);
    return;
  }
  if (result.kind === "lorebook") {
    const w = result.write;
    if (w.ok) {
      new Notice(`로어북 임포트: ${w.folder}`);
    } else {
      new Notice(`로어북 임포트 중단 (${filename}): ${w.reason}`);
    }
    return;
  }
  if (result.kind === "scenario") {
    const w = result.write;
    const loreTxt = w.lorebook
      ? w.lorebook.ok
        ? " + 로어북"
        : " (로어북 중단)"
      : "";
    new Notice(
      w.ok
        ? `시나리오 임포트: ${w.folder}${loreTxt}`
        : `시나리오 일부 실패: ${w.folder}${loreTxt}`
    );
    return;
  }
  if (result.kind === "prompt") {
    const w = result.write;
    if (w.ok) {
      new Notice(`프롬프트 세트 임포트: ${w.file.split("/").pop()}`);
    } else {
      new Notice(`프롬프트 임포트 중단 (${filename}): ${w.reason}`);
    }
  }
}
