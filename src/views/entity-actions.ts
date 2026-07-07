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
import type { SessionSeed } from "../util/new-session";
import type StellaEnginePlugin from "../main";
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
} from "./modals";

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

/** 기본 이름으로 새 세션을 만들어 바로 돌입. opts 는 임포트 진행분(씨드/메모리/작가노트) 오버라이드. */
export async function createAndOpenSession(
  plugin: StellaEnginePlugin,
  item: ScenarioListItem,
  opts?: { seed?: SessionSeed; memory?: string; authorNote?: string }
): Promise<void> {
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
      plugin.data.current
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
    "세션 이름 변경",
    "세션 이름",
    s.session.meta.name || s.folderName,
    (value) => {
      const name = value?.trim();
      if (!name) return;
      if (name === s.session.meta.name && s.folderName === name) return;
      void (async () => {
        try {
          const result = await plugin.store.renameSession(s.sessionFile, name);
          await onRenamed?.(result.oldSessionFile, result.newSessionFile);
          new Notice(`세션 이름 변경: ${name}`);
        } catch (err) {
          new Notice(
            `세션 이름 변경 실패: ${err instanceof Error ? err.message : String(err)}`
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
  input.accept = ".json,.lorebook,.scenario,.story,.png,.apng,.charx";
  input.style.display = "none";

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
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
