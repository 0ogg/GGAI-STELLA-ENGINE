/**
 * 로어북 소속/역방향 연결 스캔 (로어북 관리 개선안).
 *
 * - `collectLorebookLinks`: 책 하나가 어느 시나리오/세션에 어떤 역할로 연결돼
 *   있는지 역방향 목록 (사용처 보기 모달·삭제 확인이 쓴다).
 * - `buildLorebookGroups`: 목록 표시용 3구역(내 서재 / 자동 생성 / 고아) 분류.
 *   소속 미기록 레거시 북은 세션/시나리오 역참조로 소급 판정해 1회 write-back.
 *
 * 저장 위치·파일 형식은 불변 — 소속 메타(meta.owner/keep) + 표시 계층에서만 해결.
 * 모든 쓰기는 store 경유.
 */

import type { StellaStore } from "../state/store";
import type { LorebookOwner } from "../types/lorebook";
import type { LorebookListItem } from "./scan-lorebooks";

export type LorebookLinkKind =
  | "scenario-default"
  | "scenario-extra"
  | "scenario-translation"
  | "scenario-illustration"
  | "glossary"
  | "session-extra"
  | "session-auto";

export const LOREBOOK_LINK_LABELS: Record<LorebookLinkKind, string> = {
  "scenario-default": "기본 로어북",
  "scenario-extra": "추가 로어북",
  "scenario-translation": "번역 로어북",
  "scenario-illustration": "삽화 로어북",
  glossary: "번역 용어집",
  "session-extra": "세션 추가",
  "session-auto": "세션 기억",
};

export interface LorebookLink {
  kind: LorebookLinkKind;
  scenarioId?: string;
  scenarioFile: string;
  scenarioName: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
}

/** 시나리오/세션 전체를 한 번 훑은 결과 — 역방향 연결 + 존재 확인용 인덱스. */
interface WorldIndex {
  links: Map<string, LorebookLink[]>;
  scenarioIds: Set<string>;
  sessionIds: Set<string>;
  scenarioNameById: Map<string, string>;
  sessionNameById: Map<string, string>;
}

async function scanWorld(store: StellaStore): Promise<WorldIndex> {
  const links = new Map<string, LorebookLink[]>();
  const scenarioIds = new Set<string>();
  const sessionIds = new Set<string>();
  const scenarioNameById = new Map<string, string>();
  const sessionNameById = new Map<string, string>();

  const push = (bookId: string | undefined, link: LorebookLink): void => {
    if (!bookId) return;
    const list = links.get(bookId);
    if (list) list.push(link);
    else links.set(bookId, [link]);
  };

  const scenarios = await store.getScenarios().catch(() => []);
  for (const item of scenarios) {
    const stella = item.scenario.data?.extensions?.stella;
    const scenarioName =
      item.scenario.data?.name?.trim() || item.folderName;
    const scenarioId = stella?.id;
    if (scenarioId) {
      scenarioIds.add(scenarioId);
      scenarioNameById.set(scenarioId, scenarioName);
    }
    const base = { scenarioId, scenarioFile: item.scenarioFile, scenarioName };
    const glossaryId = stella?.translationGlossaryLorebookId;
    push(stella?.defaultLorebookId, { kind: "scenario-default", ...base });
    for (const id of stella?.extraLorebookIds ?? []) {
      push(id, { kind: "scenario-extra", ...base });
    }
    for (const id of stella?.translationLorebookIds ?? []) {
      // 용어집은 생성 시 번역 로어북에도 합류한다 — 역할은 "번역 용어집" 하나로만 표시.
      if (id === glossaryId) continue;
      push(id, { kind: "scenario-translation", ...base });
    }
    push(glossaryId, { kind: "glossary", ...base });
    for (const id of stella?.illustrationLorebookIds ?? []) {
      push(id, { kind: "scenario-illustration", ...base });
    }

    const sessions = await store.getSessions(item.folder).catch(() => []);
    for (const s of sessions) {
      const meta = s.session.meta;
      sessionIds.add(meta.id);
      sessionNameById.set(meta.id, meta.name || s.folderName);
      const sBase = {
        ...base,
        sessionId: meta.id,
        sessionFile: s.sessionFile,
        sessionName: meta.name || s.folderName,
      };
      push(meta.autoLorebookId, { kind: "session-auto", ...sBase });
      for (const id of meta.extraLorebookIds ?? []) {
        // 세션 기억 북은 extraLorebookIds 에도 함께 등록된다 — 중복 표시 방지.
        if (id === meta.autoLorebookId) continue;
        push(id, { kind: "session-extra", ...sBase });
      }
    }
  }

  return { links, scenarioIds, sessionIds, scenarioNameById, sessionNameById };
}

/** 책 하나의 역방향 연결 목록. 시나리오 → 세션 순으로 정렬해 돌려준다. */
export async function collectLorebookLinks(
  store: StellaStore,
  bookId: string
): Promise<LorebookLink[]> {
  const world = await scanWorld(store);
  const list = world.links.get(bookId) ?? [];
  const rank = (l: LorebookLink): number => (l.sessionFile ? 1 : 0);
  return list.slice().sort((a, b) => rank(a) - rank(b));
}

/** 연결 요약 문구 — 삭제 확인 등. 예: "시나리오 2곳 · 세션 1곳". 없으면 "". */
export function describeLinkCounts(links: LorebookLink[]): string {
  const scenarios = new Set<string>();
  const sessions = new Set<string>();
  for (const l of links) {
    if (l.sessionFile) sessions.add(l.sessionFile);
    else scenarios.add(l.scenarioFile);
  }
  const parts: string[] = [];
  if (scenarios.size > 0) parts.push(`시나리오 ${scenarios.size}곳`);
  if (sessions.size > 0) parts.push(`세션 ${sessions.size}곳`);
  return parts.join(" · ");
}

export interface SessionLorebookRow {
  item: LorebookListItem;
  /** 이 세션에 어떤 역할로 붙어 있는가. */
  kind: LorebookLinkKind;
  label: string;
  /** 시나리오에서 온 책을 이 세션에서 꺼 둔 상태인가. */
  disabled: boolean;
}

/**
 * 한 세션에 연결된 로어북 전부 — 시나리오 기본/추가(끈 것 포함), 세션 추가,
 * 세션 기억, 시나리오 공유 번역/삽화/용어집. 표시 순서는 이 순서 그대로.
 */
export async function collectSessionLorebooks(
  store: StellaStore,
  sessionFile: string
): Promise<SessionLorebookRow[]> {
  const session = await store.getSession(sessionFile).catch(() => null);
  if (!session) return [];
  const scenarios = await store.getScenarios().catch(() => []);
  const stella = scenarios.find(
    (i) => i.scenario.data?.extensions?.stella?.id === session.meta.scenarioId
  )?.scenario.data?.extensions?.stella;

  const disabled = new Set(session.meta.disabledScenarioLorebookIds ?? []);
  const rows: SessionLorebookRow[] = [];
  const seen = new Set<string>();
  const add = async (
    id: string | undefined,
    kind: LorebookLinkKind
  ): Promise<void> => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const item = await store.getLorebookById(id);
    if (!item) return;
    rows.push({
      item,
      kind,
      label: LOREBOOK_LINK_LABELS[kind],
      disabled: disabled.has(id),
    });
  };

  await add(stella?.defaultLorebookId, "scenario-default");
  for (const id of stella?.extraLorebookIds ?? []) {
    await add(id, "scenario-extra");
  }
  await add(session.meta.autoLorebookId, "session-auto");
  for (const id of session.meta.extraLorebookIds ?? []) {
    await add(id, "session-extra");
  }
  await add(stella?.translationGlossaryLorebookId, "glossary");
  for (const id of stella?.translationLorebookIds ?? []) {
    await add(id, "scenario-translation");
  }
  for (const id of stella?.illustrationLorebookIds ?? []) {
    await add(id, "scenario-illustration");
  }
  return rows;
}

export interface OwnedLoreEntry {
  item: LorebookListItem;
  owner: LorebookOwner;
  /** 종류 배지 — "세션 기억" | "번역 용어집". */
  badge: string;
  /** 부가 정보 — 세션 기억이면 세션명, 소속 대상이 사라졌으면 "(삭제됨)" 표기. */
  detail: string;
  /** 소속 세션/시나리오가 사라졌는가 (보관이면 orphan 구역엔 안 가지만 값은 참). */
  orphaned: boolean;
}

export interface LorebookAutoGroup {
  scenarioId?: string;
  scenarioName: string;
  entries: OwnedLoreEntry[];
}

export interface LorebookGroups {
  /** 소속 없는 책 = 사용자 소유. */
  library: LorebookListItem[];
  /** 자동 생성 북 — 시나리오별 묶음 (보관된 고아 포함). */
  auto: LorebookAutoGroup[];
  /** 소속 대상이 사라진 자동 북 (보관 제외) — 일괄 정리 대상. */
  orphans: OwnedLoreEntry[];
}

/** 소급 판정 write-back 은 store 당 1회만 (재렌더마다 다시 쓰지 않게). */
const reconciled = new WeakSet<StellaStore>();

/**
 * 로어북 목록을 내 서재 / 자동 생성(시나리오별) / 고아로 분류한다.
 * 소속 미기록 북이 세션 기억/용어집으로 역참조되고 있으면 이때 소속을 굳힌다(1회).
 */
export async function buildLorebookGroups(
  store: StellaStore,
  lorebooks: LorebookListItem[]
): Promise<LorebookGroups> {
  const world = await scanWorld(store);

  // 소급 판정 — 역참조가 살아있는 미기록 북에 소속 기록.
  if (!reconciled.has(store)) {
    reconciled.add(store);
    for (const item of lorebooks) {
      if (item.lorebook.meta.owner) continue;
      const link = (world.links.get(item.lorebook.meta.id) ?? []).find(
        (l) => l.kind === "session-auto" || l.kind === "glossary"
      );
      if (!link) continue;
      item.lorebook.meta.owner =
        link.kind === "session-auto"
          ? {
              kind: "session-auto",
              scenarioId: link.scenarioId,
              sessionId: link.sessionId,
            }
          : { kind: "glossary", scenarioId: link.scenarioId };
      try {
        await store.saveLorebook(item.lorebookFile, item.lorebook);
      } catch (err) {
        console.warn("[GGAI Stella] 로어북 소속 기록 실패:", item.lorebookFile, err);
      }
    }
  }

  const library: LorebookListItem[] = [];
  const orphans: OwnedLoreEntry[] = [];
  const autoByKey = new Map<string, LorebookAutoGroup>();

  for (const item of lorebooks) {
    const owner = item.lorebook.meta.owner;
    if (!owner) {
      library.push(item);
      continue;
    }
    const alive =
      owner.kind === "session-auto"
        ? !!owner.sessionId && world.sessionIds.has(owner.sessionId)
        : !!owner.scenarioId && world.scenarioIds.has(owner.scenarioId);
    const badge = LOREBOOK_LINK_LABELS[owner.kind];
    const sessionName = owner.sessionId
      ? world.sessionNameById.get(owner.sessionId)
      : undefined;
    const detail =
      owner.kind === "session-auto"
        ? sessionName ?? "(삭제된 세션)"
        : alive
          ? ""
          : "(삭제된 시나리오)";
    const entry: OwnedLoreEntry = {
      item,
      owner,
      badge,
      detail,
      orphaned: !alive,
    };
    if (!alive && item.lorebook.meta.keep !== true) {
      orphans.push(entry);
      continue;
    }
    const key = owner.scenarioId ?? "";
    let group = autoByKey.get(key);
    if (!group) {
      group = {
        scenarioId: owner.scenarioId,
        scenarioName:
          (owner.scenarioId && world.scenarioNameById.get(owner.scenarioId)) ||
          "(삭제된 시나리오)",
        entries: [],
      };
      autoByKey.set(key, group);
    }
    group.entries.push(entry);
  }

  const auto = [...autoByKey.values()].sort((a, b) =>
    a.scenarioName.localeCompare(b.scenarioName, "ko")
  );
  return { library, auto, orphans };
}

/** 재렌더 여부 판단용 서명 — 분류 결과가 같으면 다시 그리지 않는다. */
export function lorebookGroupsSignature(groups: LorebookGroups): string {
  const lib = groups.library.map((l) => l.lorebook.meta.id).join(",");
  const auto = groups.auto
    .map(
      (g) =>
        `${g.scenarioId ?? ""}:${g.entries
          .map((e) => `${e.item.lorebook.meta.id}${e.orphaned ? "!" : ""}${e.detail}`)
          .join("|")}`
    )
    .join(";");
  const orphan = groups.orphans.map((e) => e.item.lorebook.meta.id).join(",");
  return `${lib}#${auto}#${orphan}`;
}

/** 내 서재로 승격 — 소속 해제. 이후 수명 연동/고아 정리와 완전히 무관해진다. */
export async function promoteLorebookToLibrary(
  store: StellaStore,
  item: LorebookListItem
): Promise<void> {
  delete item.lorebook.meta.owner;
  delete item.lorebook.meta.keep;
  await store.saveLorebook(item.lorebookFile, item.lorebook);
}

/** 보관 토글 — 켜면 세션 삭제 연동·고아 정리에서 항상 제외. */
export async function toggleLorebookKeep(
  store: StellaStore,
  item: LorebookListItem
): Promise<boolean> {
  const next = item.lorebook.meta.keep !== true;
  if (next) item.lorebook.meta.keep = true;
  else delete item.lorebook.meta.keep;
  await store.saveLorebook(item.lorebookFile, item.lorebook);
  return next;
}
