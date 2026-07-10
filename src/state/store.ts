/**
 * StellaStore — 플러그인 데이터의 단일 진실 소스.
 *
 * 모든 view 는 이 store 를 통해 데이터를 읽고 쓴다. **vault 직접 호출 금지.**
 *
 * 사용 패턴:
 *   await store.getScenarios()                       // 조회 (캐시 우선)
 *   await store.toggleScenarioFavorite(file)         // 변경 — store 가 cache+disk+이벤트 처리
 *   this.registerEvent(store.on("scenarios-changed", () => this.rerender()))
 *
 * 외부 변경 (Obsidian 외부 편집기, 동기화 도구 등) 도 vault 이벤트 → cache 무효화 → 이벤트 발화
 * 로 자동 propagate. 자기가 방금 쓴 파일은 grace 기간(500ms) 동안 무시 — cache 가 이미 최신.
 *
 * 이벤트:
 *   "scenarios-changed"                  - 시나리오 목록 또는 내용 변경
 *   "sessions-changed"   (folder)        - 특정 시나리오의 세션 목록 변경
 *   "session-changed"    (sessionFile)   - 특정 세션 내용 변경
 *   "session-translations-changed" (sessionFile) - 특정 세션의 translations.json (문단 번역) 변경
 *   "session-summaries-changed" (sessionFile)    - 특정 세션의 summaries.json (노드 앵커 요약) 변경
 *
 * 주의: 자기 view 가 발화한 이벤트도 본인에게 도달한다. 본인 변경에 반응하기 싫으면
 * `store.saveSession` 직전에 플래그를 세우고 핸들러에서 skip 한다 (SessionView 패턴).
 */

import { Events, EventRef, normalizePath, TFile, TFolder, Vault } from "obsidian";
import { BASE_FOLDER } from "../constants";
import {
  importFile as importVaultFile,
  type ImportResult,
} from "../import";
import { writeLorebook } from "../import/write-lorebook";
import {
  resolveUniquePromptFile,
  writePromptPresetFile,
} from "../import/write-prompt";
import { defaultLorebookMeta, type StellaLorebook } from "../types/lorebook";
import {
  createEmptySessionTranslations,
  normalizeSessionTranslations,
  type SessionTranslations,
  createEmptySessionIllustrations,
  normalizeSessionIllustrations,
  type SessionIllustrations,
} from "../types/media";
import {
  createEmptySessionSummaries,
  normalizeSessionSummaries,
  type SessionSummaries,
} from "../types/summary";
import type { StellaPreset } from "../types/preset";
import type { StellaPromptPreset } from "../types/prompt";
import type { StellaScenario } from "../types/scenario";
import type { StellaSession } from "../types/session";
import {
  createDefaultUserProfile,
  type StellaUserProfile,
} from "../types/user";
import {
  buildReadingMarkdown,
  type ReadingExportMode,
} from "../util/export-session";
import { readLorebook } from "../util/read-lorebook";
import { readPreset } from "../util/read-preset";
import { readPromptPreset } from "../util/read-prompt";
import { scanLorebooks, LorebookListItem } from "../util/scan-lorebooks";
import { scanPresets, PresetListItem } from "../util/scan-presets";
import { scanPrompts, PromptListItem } from "../util/scan-prompts";
import {
  scanScenarios,
  ScenarioListItem,
} from "../util/scan-scenarios";
import { scanSessions, SessionListItem } from "../util/scan-sessions";
import {
  normalizeUserProfile as normalizeScannedUserProfile,
  scanUsers,
  UserListItem,
} from "../util/scan-users";
import {
  createNewScenario as diskCreateScenario,
  saveScenarioJson as diskSaveScenario,
  trashScenario as diskTrashScenario,
} from "../util/scenario-ops";
import {
  createNewSession as diskCreateSession,
  saveSession as diskSaveSession,
  trashSession as diskTrashSession,
} from "../util/session-ops";
import { uuidv4 } from "../util/uuid";

/**
 * 자기 write 이후 vault.modify 무시 기간 — 캐시는 이미 최신이므로.
 * 500ms 는 부족했다: 동기화 폴더/느린 디스크에서 modify 에코가 늦게 도착하면
 * 자기 저장이 "외부 변경"으로 오인돼 편집 중 재렌더 → 입력 포커스 소실 (2026-07-06).
 */
const SELF_WRITE_GRACE_MS = 2000;

export class StellaStore extends Events {
  private scenariosCache: ScenarioListItem[] | null = null;
  private sessionsByFolder = new Map<string, SessionListItem[]>();
  private sessionByFile = new Map<string, StellaSession>();

  /** 세션 번역 (translations.json) 캐시 — key 는 sessionFile 경로. */
  private translationsBySessionFile = new Map<string, SessionTranslations>();

  /** 세션 요약 (summaries.json) 캐시 — key 는 sessionFile 경로. */
  private summariesBySessionFile = new Map<string, SessionSummaries>();

  /** prompt preset 캐시 — list 와 file 단위 둘 다. file 캐시는 list 와 같은 객체 참조 공유. */
  private promptsCache: PromptListItem[] | null = null;
  private promptByFile = new Map<string, StellaPromptPreset>();

  /** preset (북마크) 캐시. */
  private presetsCache: PresetListItem[] | null = null;
  private presetByFile = new Map<string, StellaPreset>();

  /** lorebook 캐시 — list + file 단위. */
  private lorebooksCache: LorebookListItem[] | null = null;
  private lorebookByFile = new Map<string, StellaLorebook>();
  private defaultUserProfile: StellaUserProfile | null = null;
  private usersCache: UserListItem[] | null = null;
  private userByFile = new Map<string, StellaUserProfile>();

  /** path → 마지막 자기 write 시각 (ms). grace 기간 내면 vault.modify skip. */
  private selfWriteTimes = new Map<string, number>();

  constructor(private vault: Vault) {
    super();
  }

  private async writeBinaryFile(path: string, bytes: ArrayBuffer): Promise<void> {
    this.markSelfWrite(path);
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.vault.modifyBinary(file, bytes);
    } else {
      await this.vault.createBinary(path, bytes);
    }
  }

  /**
   * 플러그인 onload 에서 호출. vault 이벤트를 plugin.registerEvent 와 묶어 unload 시 자동 해제.
   */
  bindVaultEvents(register: (ref: EventRef) => void): void {
    register(
      this.vault.on("create", (f) => this.onVaultChange(f.path, "create"))
    );
    register(
      this.vault.on("delete", (f) => this.onVaultChange(f.path, "delete"))
    );
    register(
      this.vault.on("modify", (f) => this.onVaultChange(f.path, "modify"))
    );
    register(
      this.vault.on("rename", (f, oldPath) => {
        this.onVaultChange(oldPath, "delete");
        this.onVaultChange(f.path, "create");
      })
    );
  }

  // ─────────────────────────── scenarios ───────────────────────────

  async getScenarios(): Promise<ScenarioListItem[]> {
    if (this.scenariosCache) return this.scenariosCache;
    this.scenariosCache = await scanScenarios(this.vault);
    return this.scenariosCache;
  }

  async refreshScenarios(): Promise<ScenarioListItem[]> {
    this.scenariosCache = await scanScenarios(this.vault);
    return this.scenariosCache;
  }

  async createScenario(
    name: string
  ): Promise<{ folder: string; scenarioFile: string }> {
    const result = await diskCreateScenario(this.vault, name);
    this.markSelfWrite(result.scenarioFile);
    this.scenariosCache = null;
    this.trigger("scenarios-changed");
    return result;
  }

  async deleteScenario(folder: string): Promise<void> {
    const deletedSessionFiles = (await scanSessions(this.vault, folder)).map(
      (item) => item.sessionFile
    );
    await diskTrashScenario(this.vault, folder);
    this.scenariosCache = null;
    this.sessionsByFolder.delete(folder);
    for (const file of Array.from(this.sessionByFile.keys())) {
      if (file.startsWith(`${folder}/SESSIONS/`)) {
        this.sessionByFile.delete(file);
        if (!deletedSessionFiles.includes(file)) deletedSessionFiles.push(file);
      }
    }
    for (const file of deletedSessionFiles) {
      this.sessionByFile.delete(file);
      this.translationsBySessionFile.delete(file);
      this.summariesBySessionFile.delete(file);
      this.trigger("session-deleted", file);
    }
    this.trigger("sessions-changed", folder);
    this.trigger("scenarios-changed");
  }

  async saveScenario(file: string, scenario: StellaScenario): Promise<void> {
    this.markSelfWrite(file);
    await diskSaveScenario(this.vault, file, scenario);
    if (this.scenariosCache) {
      const item = this.scenariosCache.find((i) => i.scenarioFile === file);
      if (item) item.scenario = scenario;
    }
    this.trigger("scenarios-changed");
  }

  async renameScenario(
    scenarioFile: string,
    name: string
  ): Promise<{
    oldFolder: string;
    newFolder: string;
    oldScenarioFile: string;
    newScenarioFile: string;
    sessionPathMap: Array<{ oldFile: string; newFile: string }>;
  }> {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Scenario name is empty");

    const list = await this.getScenarios();
    const item = list.find((i) => i.scenarioFile === scenarioFile);
    if (!item) throw new Error("Scenario not found");

    const oldFolder = item.folder;
    const oldScenarioFile = item.scenarioFile;
    const folderObj = this.vault.getAbstractFileByPath(oldFolder);
    if (!(folderObj instanceof TFolder)) {
      throw new Error(`Scenario folder not found: ${oldFolder}`);
    }

    const scenario = item.scenario;
    scenario.data.name = cleanName;
    const parent = parentFolderPath(oldFolder);
    const safe = sanitizeFolderName(cleanName) || item.folderName;
    const targetBase = normalizePath(`${parent}/${safe}`);
    const newFolder =
      targetBase === oldFolder ? oldFolder : await uniquePath(this.vault, targetBase);
    const newScenarioFile = `${newFolder}/scenario.json`;

    const oldSessionFiles = collectSessionFiles(
      item.folder,
      await this.getSessions(item.folder),
      Array.from(this.sessionByFile.keys())
    );
    this.markSelfWrite(oldScenarioFile);
    this.markSelfWrite(newScenarioFile);
    await diskSaveScenario(this.vault, oldScenarioFile, scenario);

    if (newFolder !== oldFolder) {
      this.markSelfWrite(oldFolder);
      this.markSelfWrite(newFolder);
      for (const oldFile of oldSessionFiles) {
        const newFile = oldFile.replace(`${oldFolder}/`, `${newFolder}/`);
        this.markSelfWrite(oldFile);
        this.markSelfWrite(newFile);
      }
      await this.vault.rename(folderObj, newFolder);
    }

    const sessionPathMap = oldSessionFiles.map((oldFile) => ({
      oldFile,
      newFile: oldFile.replace(`${oldFolder}/`, `${newFolder}/`),
    }));

    this.scenariosCache = null;
    this.sessionsByFolder.delete(oldFolder);
    this.sessionsByFolder.delete(newFolder);
    for (const { oldFile, newFile } of sessionPathMap) {
      const cached = this.sessionByFile.get(oldFile);
      if (cached) {
        this.sessionByFile.delete(oldFile);
        this.sessionByFile.set(newFile, cached);
      }
    }
    this.trigger("scenarios-changed");
    this.trigger("sessions-changed", oldFolder);
    this.trigger("sessions-changed", newFolder);
    this.trigger("scenario-renamed", oldScenarioFile, newScenarioFile);
    for (const { oldFile, newFile } of sessionPathMap) {
      this.trigger("session-renamed", oldFile, newFile);
    }

    return {
      oldFolder,
      newFolder,
      oldScenarioFile,
      newScenarioFile,
      sessionPathMap,
    };
  }

  async copyScenario(
    scenarioFile: string,
    sessionFiles: string[] = []
  ): Promise<{
    newFolder: string;
    newScenarioFile: string;
    copiedSessions: Array<{ oldFile: string; newFile: string }>;
  }> {
    const list = await this.getScenarios();
    const item = list.find((i) => i.scenarioFile === scenarioFile);
    if (!item) throw new Error("Scenario not found");

    const sourceFolder = item.folder;
    const newName = `${item.scenario.data.name || item.folderName} Copy`;
    const newFolder = await uniquePath(
      this.vault,
      normalizePath(`${BASE_FOLDER}/SCENARIOS/${sanitizeFolderName(newName) || "Scenario Copy"}`)
    );
    await this.vault.createFolder(newFolder);
    await this.vault.createFolder(`${newFolder}/SESSIONS`);

    const cloned: StellaScenario = JSON.parse(JSON.stringify(item.scenario));
    cloned.data.name = newName;
    const extensions = (cloned.data.extensions = cloned.data.extensions ?? {});
    const oldThumb = extensions.stella?.thumbnail ?? null;
    const newScenarioId = uuidv4();
    extensions.stella = {
      ...(extensions.stella ?? {}),
      id: newScenarioId,
      favorite: false,
      lastPlayedAt: 0,
      playCount: 0,
      thumbnail: oldThumb,
    };

    const newScenarioFile = `${newFolder}/scenario.json`;
    this.markSelfWrite(newScenarioFile);
    await this.vault.create(newScenarioFile, JSON.stringify(cloned, null, 2));
    const sourceFolderObj = this.vault.getAbstractFileByPath(sourceFolder);
    if (sourceFolderObj instanceof TFolder) {
      await copyFolderChildren(this.vault, sourceFolderObj, newFolder, [
        "scenario.json",
        "SESSIONS",
      ]);
    } else {
      await copyNamedFileIfExists(this.vault, sourceFolder, newFolder, oldThumb);
    }

    const copiedSessions: Array<{ oldFile: string; newFile: string }> = [];
    for (const oldFile of sessionFiles) {
      const session = await this.getSession(oldFile);
      const oldSessionFolder = sessionFolderOfSessionFilePath(oldFile);
      if (!session || !oldSessionFolder) continue;
      const folderName = oldSessionFolder.split("/").pop() ?? "Session";
      const targetFolder = await uniquePath(
        this.vault,
        normalizePath(`${newFolder}/SESSIONS/${folderName}`)
      );
      await this.vault.createFolder(targetFolder);
      const oldFolderObj = this.vault.getAbstractFileByPath(oldSessionFolder);
      const newSessionFile = `${targetFolder}/session.json`;
      if (oldFolderObj instanceof TFolder) {
        await copyFolderChildren(this.vault, oldFolderObj, targetFolder, ["session.json"]);
      }
      const clonedSession: StellaSession = JSON.parse(JSON.stringify(session));
      clonedSession.meta.id = uuidv4();
      clonedSession.meta.scenarioId = newScenarioId;
      clonedSession.meta.createdAt = Date.now();
      clonedSession.meta.modifiedAt = Date.now();
      clonedSession.meta.lastPlayedAt = 0;
      clonedSession.meta.favorite = false;
      this.markSelfWrite(newSessionFile);
      await this.vault.create(newSessionFile, JSON.stringify(clonedSession, null, 2));
      this.sessionByFile.set(newSessionFile, clonedSession);
      copiedSessions.push({ oldFile, newFile: newSessionFile });
    }

    this.scenariosCache = null;
    this.sessionsByFolder.delete(newFolder);
    this.trigger("scenarios-changed");
    this.trigger("sessions-changed", newFolder);
    return { newFolder, newScenarioFile, copiedSessions };
  }

  async setScenarioThumbnail(
    scenarioFile: string,
    bytes: ArrayBuffer,
    ext: string
  ): Promise<string> {
    const list = await this.getScenarios();
    const item = list.find((i) => i.scenarioFile === scenarioFile);
    if (!item) throw new Error("Scenario not found");
    ensureStellaExt(item.scenario);
    const folder = parentFolderPath(scenarioFile);
    const filename = `thumbnail.${sanitizeImageExt(ext)}`;
    const target = `${folder}/${filename}`;
    await this.writeBinaryFile(target, bytes);
    item.scenario.data.extensions.stella!.thumbnail = filename;
    await this.saveScenario(scenarioFile, item.scenario);
    return target;
  }

  async toggleScenarioFavorite(file: string): Promise<void> {
    const list = await this.getScenarios();
    const item = list.find((i) => i.scenarioFile === file);
    if (!item) return;
    ensureStellaExt(item.scenario);
    const ext = item.scenario.data.extensions.stella!;
    ext.favorite = !ext.favorite;
    await this.saveScenario(file, item.scenario);
  }

  /** 시나리오의 stella.id 를 보장(없으면 생성+저장)하고 반환. 세션 생성 직전 호출. */
  async ensureScenarioId(file: string): Promise<string | null> {
    const list = await this.getScenarios();
    const item = list.find((i) => i.scenarioFile === file);
    if (!item) return null;
    ensureStellaExt(item.scenario);
    const ext = item.scenario.data.extensions.stella!;
    if (!ext.id) {
      ext.id = uuidv4();
      await this.saveScenario(file, item.scenario);
    }
    return ext.id;
  }

  async touchSessionPlayed(sessionFile: string): Promise<void> {
    const now = Date.now();
    const session = await this.getSession(sessionFile);
    if (session) {
      session.meta.lastPlayedAt = now;
      await this.saveSession(sessionFile, session);
    }

    const scenarioFile = scenarioFileOfSessionFile(sessionFile);
    if (!scenarioFile) return;
    const list = await this.getScenarios();
    const item = list.find((i) => i.scenarioFile === scenarioFile);
    if (!item) return;
    ensureStellaExt(item.scenario);
    const ext = item.scenario.data.extensions.stella!;
    ext.lastPlayedAt = now;
    ext.playCount = (ext.playCount ?? 0) + 1;
    await this.saveScenario(scenarioFile, item.scenario);
  }

  // ─────────────────────────── sessions ───────────────────────────

  async getSessions(scenarioFolder: string): Promise<SessionListItem[]> {
    let list = this.sessionsByFolder.get(scenarioFolder);
    if (list) return list;
    list = await scanSessions(this.vault, scenarioFolder);
    // 세션 객체도 file-cache 에 채워두되, 이미 있는 건 덮어쓰지 않는다 (다른 view 가 들고 있는 참조 보호).
    for (const item of list) {
      if (!this.sessionByFile.has(item.sessionFile)) {
        this.sessionByFile.set(item.sessionFile, item.session);
      }
    }
    this.sessionsByFolder.set(scenarioFolder, list);
    return list;
  }

  async refreshSessions(scenarioFolder: string): Promise<SessionListItem[]> {
    const list = await scanSessions(this.vault, scenarioFolder);
    for (const item of list) {
      this.sessionByFile.set(item.sessionFile, item.session);
    }
    this.sessionsByFolder.set(scenarioFolder, list);
    return list;
  }

  async getSession(file: string): Promise<StellaSession | null> {
    const cached = this.sessionByFile.get(file);
    if (cached) return cached;
    const f = this.vault.getAbstractFileByPath(file);
    if (!(f instanceof TFile)) return null;
    try {
      const text = await this.vault.read(f);
      const session = JSON.parse(text) as StellaSession;
      this.sessionByFile.set(file, session);
      return session;
    } catch (err) {
      console.error("[GGAI Stella] session 로드 실패:", err);
      return null;
    }
  }

  async refreshSession(file: string): Promise<StellaSession | null> {
    const f = this.vault.getAbstractFileByPath(file);
    if (!(f instanceof TFile)) return null;
    try {
      const text = await this.vault.read(f);
      const fresh = JSON.parse(text) as StellaSession;
      const existing = this.sessionByFile.get(file);
      if (existing) {
        // 제자리 갱신 — SessionView 등이 들고 있는 참조가 고아가 돼서
        // 다른 뷰의 refresh 후 메타 변경(updateToolbar/auto 실행 등)이
        // 누락되는 버그를 막기 위해 같은 객체에 덮어쓴다.
        for (const key of Object.keys(existing)) {
          delete (existing as unknown as Record<string, unknown>)[key];
        }
        Object.assign(existing, fresh);
        return existing;
      }
      this.sessionByFile.set(file, fresh);
      return fresh;
    } catch (err) {
      console.error("[GGAI Stella] session 로드 실패:", err);
      return null;
    }
  }

  async createSession(
    scenarioFolder: string,
    scenarioId: string,
    name: string,
    seed: import("../util/new-session").SessionSeed = "",
    initial?: import("../types/preset").ActiveSettings,
    mode: import("../types/session").SessionMode = "novel"
  ): Promise<{ folder: string; sessionFile: string; session: StellaSession }> {
    const result = await diskCreateSession(
      this.vault,
      scenarioFolder,
      scenarioId,
      name,
      seed,
      initial,
      mode
    );
    this.markSelfWrite(result.sessionFile);
    this.sessionByFile.set(result.sessionFile, result.session);
    this.sessionsByFolder.delete(scenarioFolder);
    this.trigger("sessions-changed", scenarioFolder);
    this.trigger("session-changed", result.sessionFile);
    return result;
  }

  async deleteSession(folder: string): Promise<void> {
    await diskTrashSession(this.vault, folder);
    const sessionFile = `${folder}/session.json`;
    this.sessionByFile.delete(sessionFile);
    this.translationsBySessionFile.delete(sessionFile);
    this.summariesBySessionFile.delete(sessionFile);
    const scenarioFolder = scenarioFolderOfSessionFolder(folder);
    if (scenarioFolder) {
      this.sessionsByFolder.delete(scenarioFolder);
      this.trigger("sessions-changed", scenarioFolder);
    }
    this.trigger("session-deleted", sessionFile);
  }

  async saveSession(file: string, session: StellaSession): Promise<void> {
    this.markSelfWrite(file);
    this.sessionByFile.set(file, session);
    await diskSaveSession(this.vault, file, session);
    this.scenariosCache = null;
    this.trigger("session-changed", file);
    this.trigger("scenarios-changed");
  }

  async renameSession(
    sessionFile: string,
    name: string
  ): Promise<{
    oldFolder: string;
    newFolder: string;
    oldSessionFile: string;
    newSessionFile: string;
  }> {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Session name is empty");

    const session = await this.getSession(sessionFile);
    if (!session) throw new Error("Session not found");

    const oldFolder = sessionFolderOfSessionFilePath(sessionFile);
    if (!oldFolder) throw new Error("Invalid session path");
    const folderObj = this.vault.getAbstractFileByPath(oldFolder);
    if (!(folderObj instanceof TFolder)) {
      throw new Error(`Session folder not found: ${oldFolder}`);
    }

    const sessionsRoot = parentFolderPath(oldFolder);
    const safe = sanitizeFolderName(cleanName) || oldFolder.split("/").pop() || "Session";
    const targetBase = normalizePath(`${sessionsRoot}/${safe}`);
    const newFolder =
      targetBase === oldFolder ? oldFolder : await uniquePath(this.vault, targetBase);
    const newSessionFile = `${newFolder}/session.json`;

    session.meta.name = cleanName;
    session.meta.modifiedAt = Date.now();
    this.markSelfWrite(sessionFile);
    this.markSelfWrite(newSessionFile);
    await diskSaveSession(this.vault, sessionFile, session);

    if (newFolder !== oldFolder) {
      this.markSelfWrite(oldFolder);
      this.markSelfWrite(newFolder);
      await this.vault.rename(folderObj, newFolder);
    }

    this.sessionByFile.delete(sessionFile);
    this.sessionByFile.set(newSessionFile, session);
    const cachedTranslations = this.translationsBySessionFile.get(sessionFile);
    this.translationsBySessionFile.delete(sessionFile);
    if (cachedTranslations) this.translationsBySessionFile.set(newSessionFile, cachedTranslations);
    const cachedSummaries = this.summariesBySessionFile.get(sessionFile);
    this.summariesBySessionFile.delete(sessionFile);
    if (cachedSummaries) this.summariesBySessionFile.set(newSessionFile, cachedSummaries);
    const scenarioFolder = scenarioFolderOfSessionFile(sessionFile);
    if (scenarioFolder) {
      this.sessionsByFolder.delete(scenarioFolder);
      this.trigger("sessions-changed", scenarioFolder);
    }
    this.trigger("session-renamed", sessionFile, newSessionFile);
    this.trigger("session-changed", newSessionFile);

    return {
      oldFolder,
      newFolder,
      oldSessionFile: sessionFile,
      newSessionFile,
    };
  }

  async copySession(
    sessionFile: string
  ): Promise<{ folder: string; sessionFile: string; session: StellaSession }> {
    const session = await this.getSession(sessionFile);
    if (!session) throw new Error("Session not found");
    const oldFolder = sessionFolderOfSessionFilePath(sessionFile);
    if (!oldFolder) throw new Error("Invalid session path");
    const oldFolderObj = this.vault.getAbstractFileByPath(oldFolder);
    if (!(oldFolderObj instanceof TFolder)) {
      throw new Error(`Session folder not found: ${oldFolder}`);
    }

    const parent = parentFolderPath(oldFolder);
    const copyName = `${session.meta.name || oldFolder.split("/").pop() || "Session"} Copy`;
    const folder = await uniquePath(
      this.vault,
      normalizePath(`${parent}/${sanitizeFolderName(copyName) || "Session Copy"}`)
    );
    await this.vault.createFolder(folder);
    await copyFolderChildren(this.vault, oldFolderObj, folder, ["session.json"]);

    const cloned: StellaSession = JSON.parse(JSON.stringify(session));
    cloned.meta.id = uuidv4();
    cloned.meta.name = copyName;
    cloned.meta.createdAt = Date.now();
    cloned.meta.modifiedAt = Date.now();
    cloned.meta.lastPlayedAt = 0;
    cloned.meta.favorite = false;
    // 복제본은 시리즈에서 분리한다 — 같은 시리즈 id+index 를 그대로 두면 "N화"가
    // 중복돼 화 목록과 다음화 index 계산이 꼬인다. 실험용 독립 사본으로 만든다.
    delete cloned.meta.series;
    const newFile = `${folder}/session.json`;
    this.markSelfWrite(newFile);
    await this.vault.create(newFile, JSON.stringify(cloned, null, 2));
    this.sessionByFile.set(newFile, cloned);
    const scenarioFolder = scenarioFolderOfSessionFile(sessionFile);
    if (scenarioFolder) {
      this.sessionsByFolder.delete(scenarioFolder);
      this.trigger("sessions-changed", scenarioFolder);
    }
    this.trigger("session-changed", newFile);
    return { folder, sessionFile: newFile, session: cloned };
  }

  // ─────────────────────────── session translations (translations.json) ───────────────────────────

  /**
   * 세션 폴더의 translations.json. 파일이 없으면 빈 구조를 반환한다 (디스크에 만들지 않음).
   * 이벤트: "session-translations-changed" (sessionFile).
   */
  async getSessionTranslations(sessionFile: string): Promise<SessionTranslations> {
    const cached = this.translationsBySessionFile.get(sessionFile);
    if (cached) return cached;
    const path = translationsFileOfSessionFile(sessionFile);
    let translations = createEmptySessionTranslations();
    if (path) {
      const f = this.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        try {
          translations = normalizeSessionTranslations(
            JSON.parse(await this.vault.read(f))
          );
        } catch (err) {
          console.warn("[GGAI Stella] translations.json 로드 실패:", err);
        }
      }
    }
    this.translationsBySessionFile.set(sessionFile, translations);
    return translations;
  }

  async saveSessionTranslations(
    sessionFile: string,
    translations: SessionTranslations
  ): Promise<void> {
    const path = translationsFileOfSessionFile(sessionFile);
    if (!path) throw new Error("Invalid session path");
    this.translationsBySessionFile.set(sessionFile, translations);
    this.markSelfWrite(path);
    const body = JSON.stringify(translations, null, 2);
    const f = this.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.vault.modify(f, body);
    else await this.vault.create(path, body);
    this.trigger("session-translations-changed", sessionFile);
  }

  // ─────────────────────────── reading export (.md) ───────────────────────────

  /**
   * 현재 활성 분기를 읽기 모드 마크다운으로 내보낸다(삽화 인라인 포함).
   * mode="translated" 면 번역된 문단은 번역으로, 미번역은 원문으로. 생성한 파일 경로 반환.
   * folder 가 없으면 vault 루트에 만든다.
   */
  async exportSessionReading(
    sessionFile: string,
    mode: ReadingExportMode,
    folder?: string
  ): Promise<string> {
    const session = await this.getSession(sessionFile);
    if (!session) throw new Error("세션을 불러올 수 없습니다.");
    const sessionFolder = sessionFolderOfSessionFilePath(sessionFile);
    if (!sessionFolder) throw new Error("세션 폴더를 찾을 수 없습니다.");

    const [translations, illustrations] = await Promise.all([
      this.getSessionTranslations(sessionFile).catch(() => null),
      this.getSessionIllustrations(sessionFile).catch(() => null),
    ]);
    const title = session.meta.name || "세션";
    // 챗 세션 대화록용 화자 이름 — AI = 시나리오 이름, 유저 = 세션이 기억하는 페르소나.
    let chatNames: { char: string; user: string } | undefined;
    if (session.meta.mode === "chat") {
      const scenarioJson = `${sessionFile.split("/SESSIONS/")[0]}/scenario.json`;
      const scenarios = await this.getScenarios().catch(
        (): ScenarioListItem[] => []
      );
      const char = scenarios.find((i) => i.scenarioFile === scenarioJson)
        ?.scenario.data.name;
      const user = session.meta.personaFile
        ? (await this.getUserProfile(session.meta.personaFile).catch(() => null))
            ?.name
        : undefined;
      chatNames = { char: char || "AI", user: user || "User" };
    }
    const content = buildReadingMarkdown({
      session,
      sessionFolder,
      illustrations,
      translations,
      mode,
      title,
      chatNames,
    });

    let dir = "";
    if (folder && folder.trim()) {
      dir = normalizePath(folder.trim());
      await this.ensureFolderPath(dir);
    }
    const suffix = mode === "translated" ? " (번역)" : "";
    const base = sanitizeFolderName(`${title}${suffix}`) || "세션 내보내기";
    const target = await uniqueMarkdownPath(
      this.vault,
      dir ? `${dir}/${base}` : base
    );
    await this.vault.create(target, content);
    return target;
  }

  /** 중간 경로까지 만들며 폴더를 보장한다. */
  private async ensureFolderPath(folder: string): Promise<void> {
    const norm = normalizePath(folder);
    if (!norm || norm === "/" || (await this.vault.adapter.exists(norm))) return;
    const parent = parentFolderPath(norm);
    if (parent) await this.ensureFolderPath(parent);
    if (!(await this.vault.adapter.exists(norm))) {
      await this.vault.createFolder(norm);
    }
  }

  // ─────────────────────────── session summaries (summaries.json) ───────────────────────────

  /**
   * 세션 폴더의 summaries.json. 없으면 빈 구조 반환 (디스크에 만들지 않음).
   * 이벤트: "session-summaries-changed" (sessionFile).
   */
  async getSessionSummaries(sessionFile: string): Promise<SessionSummaries> {
    const cached = this.summariesBySessionFile.get(sessionFile);
    if (cached) return cached;
    const path = summariesFileOfSessionFile(sessionFile);
    let summaries = createEmptySessionSummaries();
    if (path) {
      const f = this.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        try {
          summaries = normalizeSessionSummaries(
            JSON.parse(await this.vault.read(f))
          );
        } catch (err) {
          console.warn("[GGAI Stella] summaries.json 로드 실패:", err);
        }
      }
    }
    this.summariesBySessionFile.set(sessionFile, summaries);
    return summaries;
  }

  async saveSessionSummaries(
    sessionFile: string,
    summaries: SessionSummaries
  ): Promise<void> {
    const path = summariesFileOfSessionFile(sessionFile);
    if (!path) throw new Error("Invalid session path");
    this.summariesBySessionFile.set(sessionFile, summaries);
    this.markSelfWrite(path);
    const body = JSON.stringify(summaries, null, 2);
    const f = this.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.vault.modify(f, body);
    else await this.vault.create(path, body);
    this.trigger("session-summaries-changed", sessionFile);
  }

  // ─────────────────────────── session illustrations (illustrations.json) ───────────────────────────

  /**
   * 세션 폴더의 illustrations.json. 없으면 빈 구조 반환 (디스크에 만들지 않음).
   * 캐시 없이 매번 읽는다 (삽화는 표시/생성 시점에만 접근). 이벤트: "session-illustrations-changed".
   */
  async getSessionIllustrations(sessionFile: string): Promise<SessionIllustrations> {
    const path = illustrationsFileOfSessionFile(sessionFile);
    if (path) {
      const f = this.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        try {
          return normalizeSessionIllustrations(JSON.parse(await this.vault.read(f)));
        } catch (err) {
          console.warn("[GGAI Stella] illustrations.json 로드 실패:", err);
        }
      }
    }
    return createEmptySessionIllustrations();
  }

  async saveSessionIllustrations(
    sessionFile: string,
    illustrations: SessionIllustrations
  ): Promise<void> {
    const path = illustrationsFileOfSessionFile(sessionFile);
    if (!path) throw new Error("Invalid session path");
    this.markSelfWrite(path);
    const body = JSON.stringify(illustrations, null, 2);
    const f = this.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.vault.modify(f, body);
    else await this.vault.create(path, body);
    this.trigger("session-illustrations-changed", sessionFile);
  }

  /**
   * 세션 폴더 assets/ 아래에 바이너리 파일 저장. 세션 폴더 기준 상대 경로(assets/...)를 반환.
   * 미디어 생성물(삽화 PNG 등) 저장 진입점 — View/서비스는 이 메서드를 경유한다.
   */
  async saveSessionAsset(
    sessionFile: string,
    filename: string,
    data: ArrayBuffer
  ): Promise<string> {
    const folder = sessionFolderOfSessionFilePath(sessionFile);
    if (!folder) throw new Error("Invalid session path");
    const assetsFolder = `${folder}/assets`;
    if (!(await this.vault.adapter.exists(assetsFolder))) {
      await this.vault.createFolder(assetsFolder);
    }
    const path = normalizePath(`${assetsFolder}/${filename}`);
    this.markSelfWrite(path);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.vault.modifyBinary(existing, data);
    else await this.vault.createBinary(path, data);
    return `assets/${filename}`;
  }

  /** 세션 폴더 기준 상대 경로(assets/...)의 에셋 파일을 휴지통으로. 없으면 무시. */
  async deleteSessionAsset(sessionFile: string, relativePath: string): Promise<void> {
    const folder = sessionFolderOfSessionFilePath(sessionFile);
    if (!folder) return;
    const path = normalizePath(`${folder}/${relativePath}`);
    const f = this.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      this.markSelfWrite(path);
      await this.vault.trash(f, false);
    }
  }

  async toggleSessionFavorite(file: string): Promise<void> {
    const session = await this.getSession(file);
    if (!session) return;
    session.meta.favorite = !session.meta.favorite;
    await this.saveSession(file, session);
  }

  async toggleNodeFavorite(file: string, nodeId: string): Promise<void> {
    const session = await this.getSession(file);
    if (!session) return;
    const node = session.nodes[nodeId];
    if (!node) return;
    node.favorite = !node.favorite;
    await this.saveSession(file, session);
  }

  // ─────────────────────────── prompt presets ───────────────────────────

  async getPromptPresets(): Promise<PromptListItem[]> {
    if (this.promptsCache) return this.promptsCache;
    const list = await scanPrompts(this.vault);
    this.promptsCache = list;
    for (const item of list) {
      this.promptByFile.set(item.presetFile, item.preset);
    }
    return list;
  }

  async getPromptPreset(presetFile: string): Promise<StellaPromptPreset | null> {
    const cached = this.promptByFile.get(presetFile);
    if (cached) return cached;
    const preset = await readPromptPreset(this.vault, presetFile);
    if (preset) this.promptByFile.set(presetFile, preset);
    return preset;
  }

  /** id (preset.meta.id) 로 검색. 캐시 우선, 없으면 list 스캔 후 재시도. */
  async getPromptPresetById(id: string): Promise<PromptListItem | null> {
    const list = await this.getPromptPresets();
    return list.find((p) => p.preset.meta.id === id) ?? null;
  }

  async savePromptPreset(
    presetFile: string,
    preset: StellaPromptPreset
  ): Promise<void> {
    this.markSelfWrite(presetFile);
    this.promptByFile.set(presetFile, preset);
    if (this.promptsCache) {
      const item = this.promptsCache.find((p) => p.presetFile === presetFile);
      if (item) item.preset = preset;
    }
    await writePromptPresetFile(this.vault, presetFile, preset);
    this.trigger("prompt-preset-changed", presetFile);
    this.trigger("prompt-presets-changed");
  }

  /** 새 프리셋 생성. 같은 이름이 이미 있으면 -2, -3 접미사. 반환 = 새 presetFile. */
  async createPromptPreset(
    name: string,
    init: StellaPromptPreset
  ): Promise<{ presetFile: string; preset: StellaPromptPreset }> {
    if (!(await this.vault.adapter.exists(`${BASE_FOLDER}/PROMPTS`))) {
      await this.vault.createFolder(`${BASE_FOLDER}/PROMPTS`);
    }
    const target = await resolveUniquePromptFile(this.vault, name);
    this.markSelfWrite(target);
    await writePromptPresetFile(this.vault, target, init);
    this.promptByFile.set(target, init);
    this.promptsCache = null;
    this.trigger("prompt-presets-changed");
    return { presetFile: target, preset: init };
  }

  async deletePromptPreset(presetFile: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(presetFile);
    if (f instanceof TFile) {
      await this.vault.trash(f, true);
    } else if (f instanceof TFolder) {
      // 레거시 폴더 형식 호환.
      await this.vault.trash(f, true);
    } else {
      // 레거시: 파일 경로가 ../<X>/preset.json 일 수 있다 → 부모 폴더 휴지통.
      const parent = this.vault.getAbstractFileByPath(parentFolderPath(presetFile));
      if (parent instanceof TFolder) {
        await this.vault.trash(parent, true);
      }
    }
    this.promptByFile.delete(presetFile);
    this.promptsCache = null;
    this.trigger("prompt-presets-changed");
  }

  async togglePromptFavorite(presetFile: string): Promise<void> {
    const preset = await this.getPromptPreset(presetFile);
    if (!preset) return;
    preset.meta.favorite = !preset.meta.favorite;
    await this.savePromptPreset(presetFile, preset);
  }

  /**
   * 프롬프트 세트를 SillyTavern 호환 JSON 문자열로 만든다 (디스크 파일이 이미 ST raw 형태).
   * stella 전용 메타는 제거해 깨끗한 공유용 프리셋으로 만들고(재임포트 id 충돌 방지),
   * `chat_completion_source` 가 없으면(스텔라에서 새로 만든/구조가 크게 바뀐 세트)
   * ST 가 완성된 프리셋으로 인식하도록 기본값을 채운다.
   * vault 에는 쓰지 않는다 — 실제 파일 저장(OS 다운로드 폴더)은 호출부가 브라우저
   * 다운로드로 처리한다. 반환 = 내보낼 파일 이름(확장자 제외) + JSON 본문.
   */
  async buildPromptPresetExportJson(
    presetFile: string
  ): Promise<{ name: string; json: string }> {
    const f = this.vault.getAbstractFileByPath(presetFile);
    if (!(f instanceof TFile)) throw new Error("프롬프트 파일을 찾을 수 없습니다.");
    const text = await this.vault.read(f);
    let out = text;
    try {
      const raw = JSON.parse(text);
      if (raw && typeof raw === "object") {
        delete (raw as any).stella;
        if (typeof raw.chat_completion_source !== "string") {
          raw.chat_completion_source = "openai";
        }
        out = JSON.stringify(raw, null, 2);
      }
    } catch {
      // 파싱 실패 시 원문 그대로 내보낸다.
    }
    return { name: sanitizeFolderName(f.basename) || "프롬프트", json: out };
  }

  // ─────────────────────────── presets (PRESETS/<이름>.json) ───────────────────────────

  async getPresets(): Promise<PresetListItem[]> {
    if (this.presetsCache) return this.presetsCache;
    const list = await scanPresets(this.vault);
    this.presetsCache = list;
    for (const item of list) this.presetByFile.set(item.presetFile, item.preset);
    return list;
  }

  async getPreset(presetFile: string): Promise<StellaPreset | null> {
    const cached = this.presetByFile.get(presetFile);
    if (cached) return cached;
    const preset = await readPreset(this.vault, presetFile);
    if (preset) this.presetByFile.set(presetFile, preset);
    return preset;
  }

  async getPresetById(id: string): Promise<PresetListItem | null> {
    const list = await this.getPresets();
    return list.find((p) => p.preset.id === id) ?? null;
  }

  async savePreset(presetFile: string, preset: StellaPreset): Promise<void> {
    this.markSelfWrite(presetFile);
    this.presetByFile.set(presetFile, preset);
    if (this.presetsCache) {
      const item = this.presetsCache.find((p) => p.presetFile === presetFile);
      if (item) item.preset = preset;
    }
    const f = this.vault.getAbstractFileByPath(presetFile);
    const body = JSON.stringify(preset, null, 2);
    if (f instanceof TFile) {
      await this.vault.modify(f, body);
    } else {
      await this.vault.create(presetFile, body);
      this.presetsCache = null;
    }
    this.trigger("preset-changed", presetFile);
    this.trigger("presets-changed");
  }

  /** 새 프리셋 생성. 이름 충돌 시 -2, -3 접미사. 반환 = 새 presetFile. */
  async createPreset(
    name: string,
    init: StellaPreset
  ): Promise<{ presetFile: string; preset: StellaPreset }> {
    const safeName = sanitizeFolderName(name) || "프리셋";
    const baseFile = normalizePath(`${BASE_FOLDER}/PRESETS/${safeName}.json`);
    let target = baseFile;
    if (await this.vault.adapter.exists(target)) {
      for (let i = 2; i < 1000; i++) {
        const p = normalizePath(`${BASE_FOLDER}/PRESETS/${safeName}-${i}.json`);
        if (!(await this.vault.adapter.exists(p))) {
          target = p;
          break;
        }
      }
    }
    // PRESETS 폴더 자체 보장
    if (!(await this.vault.adapter.exists(`${BASE_FOLDER}/PRESETS`))) {
      await this.vault.createFolder(`${BASE_FOLDER}/PRESETS`);
    }
    this.markSelfWrite(target);
    await this.vault.create(target, JSON.stringify(init, null, 2));
    this.presetByFile.set(target, init);
    this.presetsCache = null;
    this.trigger("presets-changed");
    return { presetFile: target, preset: init };
  }

  async deletePreset(presetFile: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(presetFile);
    if (f instanceof TFile) await this.vault.trash(f, true);
    this.presetByFile.delete(presetFile);
    this.presetsCache = null;
    this.trigger("presets-changed");
  }

  async togglePresetFavorite(presetFile: string): Promise<void> {
    const preset = await this.getPreset(presetFile);
    if (!preset) return;
    preset.favorite = !preset.favorite;
    await this.savePreset(presetFile, preset);
  }

  // ─────────────────────────── lorebooks ───────────────────────────

  async getLorebooks(): Promise<LorebookListItem[]> {
    if (this.lorebooksCache) return this.lorebooksCache;
    const list = await scanLorebooks(this.vault);
    this.lorebooksCache = list;
    for (const item of list) this.lorebookByFile.set(item.lorebookFile, item.lorebook);
    return list;
  }

  async refreshLorebooks(): Promise<LorebookListItem[]> {
    const list = await scanLorebooks(this.vault);
    this.lorebooksCache = list;
    this.lorebookByFile.clear();
    for (const item of list) this.lorebookByFile.set(item.lorebookFile, item.lorebook);
    return list;
  }

  async getLorebook(lorebookFile: string): Promise<StellaLorebook | null> {
    const cached = this.lorebookByFile.get(lorebookFile);
    if (cached) return cached;
    // 파일 경로로 직접 read — readLorebook 은 폴더를 받으니 부모 폴더 해석 후 호출.
    const folderPath = parentFolderPath(lorebookFile);
    const folder = this.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return null;
    const book = await readLorebook(this.vault, folder);
    if (book) this.lorebookByFile.set(lorebookFile, book);
    return book;
  }

  async refreshLorebook(lorebookFile: string): Promise<StellaLorebook | null> {
    this.lorebookByFile.delete(lorebookFile);
    return this.getLorebook(lorebookFile);
  }

  /** 책 단위 id (StellaLorebookMeta.id) 로 검색. */
  async getLorebookById(id: string): Promise<LorebookListItem | null> {
    const list = await this.getLorebooks();
    return list.find((l) => l.lorebook.meta.id === id) ?? null;
  }

  async saveLorebook(lorebookFile: string, book: StellaLorebook): Promise<void> {
    this.markSelfWrite(lorebookFile);
    this.lorebookByFile.set(lorebookFile, book);
    if (this.lorebooksCache) {
      const item = this.lorebooksCache.find((l) => l.lorebookFile === lorebookFile);
      if (item) item.lorebook = book;
    }
    const f = this.vault.getAbstractFileByPath(lorebookFile);
    const body = JSON.stringify(book, null, 2);
    if (f instanceof TFile) {
      await this.vault.modify(f, body);
    } else {
      await this.vault.create(lorebookFile, body);
      this.lorebooksCache = null;
    }
    this.trigger("lorebook-changed", lorebookFile);
    this.trigger("lorebooks-changed");
  }

  async setLorebookThumbnail(
    lorebookFile: string,
    bytes: ArrayBuffer,
    ext: string
  ): Promise<string> {
    const book = await this.getLorebook(lorebookFile);
    if (!book) throw new Error("Lorebook not found");
    const folder = parentFolderPath(lorebookFile);
    const filename = `thumbnail.${sanitizeImageExt(ext)}`;
    const target = `${folder}/${filename}`;
    await this.writeBinaryFile(target, bytes);
    book.meta.thumbnail = filename;
    await this.saveLorebook(lorebookFile, book);
    return target;
  }

  /**
   * 새 빈 로어북을 만든다. 폴더 충돌 시 -2, -3 접미사.
   * 반환값으로 새 lorebookFile 경로를 주므로 호출부가 바로 편집기를 열 수 있다.
   */
  async createLorebook(
    name: string
  ): Promise<{ lorebookFile: string; folder: string }> {
    const cleanName = (name ?? "").trim() || "새 로어북";
    const book: StellaLorebook = {
      meta: defaultLorebookMeta("sillytavern", cleanName),
      entries: [],
    };
    const result = await writeLorebook(this.vault, book);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    this.markSelfWrite(result.file);
    this.lorebookByFile.set(result.file, book);
    this.lorebooksCache = null;
    this.trigger("lorebooks-changed");
    return { lorebookFile: result.file, folder: result.folder };
  }

  async copyLorebook(
    lorebookFile: string
  ): Promise<{ lorebookFile: string; folder: string }> {
    const book = await this.getLorebook(lorebookFile);
    if (!book) throw new Error("Lorebook not found");
    const sourceFolder = parentFolderPath(lorebookFile);
    const cloned: StellaLorebook = JSON.parse(JSON.stringify(book));
    cloned.meta.id = uuidv4();
    cloned.meta.name = `${book.meta.name || "Lorebook"} Copy`;
    const thumbName = book.meta.thumbnail;
    let thumbnail:
      | { bytes: Uint8Array; ext: "png" | "apng" | "jpg" | "jpeg" | "webp" }
      | undefined;
    if (typeof thumbName === "string" && thumbName) {
      const thumbFile = this.vault.getAbstractFileByPath(`${sourceFolder}/${thumbName}`);
      if (thumbFile instanceof TFile) {
        const ext = sanitizeImageExt(thumbName.split(".").pop() ?? "png") as
          | "png"
          | "apng"
          | "jpg"
          | "jpeg"
          | "webp";
        thumbnail = {
          bytes: new Uint8Array(await this.vault.readBinary(thumbFile)),
          ext,
        };
      }
    }
    if (!thumbnail) cloned.meta.thumbnail = null;
    const result = await writeLorebook(this.vault, cloned, thumbnail);
    if (!result.ok) throw new Error(result.reason);
    this.markSelfWrite(result.file);
    this.lorebookByFile.set(result.file, cloned);
    this.lorebooksCache = null;
    this.trigger("lorebooks-changed");
    return { lorebookFile: result.file, folder: result.folder };
  }

  async deleteLorebook(folder: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(folder);
    if (f instanceof TFolder) await this.vault.trash(f, true);
    // 캐시 정리
    const lorebookFile = `${folder}/lorebook.json`;
    this.lorebookByFile.delete(lorebookFile);
    this.lorebooksCache = null;
    this.trigger("lorebooks-changed");
  }

  async getDefaultUserProfile(): Promise<StellaUserProfile> {
    if (this.defaultUserProfile) return this.defaultUserProfile;
    const path = defaultUserProfilePath();
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      try {
        const raw = JSON.parse(await this.vault.read(file)) as Partial<StellaUserProfile>;
        this.defaultUserProfile = normalizeUserProfile(raw);
        return this.defaultUserProfile;
      } catch (err) {
        console.warn("[GGAI Stella] user profile load failed:", err);
      }
    }
    const profile = createDefaultUserProfile();
    await this.saveDefaultUserProfile(profile);
    return profile;
  }

  async getUsers(): Promise<UserListItem[]> {
    if (this.usersCache) return this.usersCache;
    const users = await scanUsers(this.vault);
    if (users.length === 0) {
      await this.getDefaultUserProfile();
      this.usersCache = await scanUsers(this.vault);
    } else {
      this.usersCache = users;
    }
    this.userByFile.clear();
    for (const item of this.usersCache) this.userByFile.set(item.userFile, item.profile);
    return this.usersCache;
  }

  async refreshUsers(): Promise<UserListItem[]> {
    let users = await scanUsers(this.vault);
    if (users.length === 0) {
      this.defaultUserProfile = null;
      await this.getDefaultUserProfile();
      users = await scanUsers(this.vault);
    }
    this.usersCache = users;
    this.userByFile.clear();
    for (const item of users) this.userByFile.set(item.userFile, item.profile);
    return users;
  }

  async getUserProfile(userFile: string): Promise<StellaUserProfile | null> {
    const cached = this.userByFile.get(userFile);
    if (cached) return cached;
    const file = this.vault.getAbstractFileByPath(userFile);
    if (!(file instanceof TFile)) return null;
    try {
      const profile = normalizeScannedUserProfile(JSON.parse(await this.vault.read(file)));
      this.userByFile.set(userFile, profile);
      return profile;
    } catch (err) {
      console.warn("[GGAI Stella] user profile load failed:", err);
      return null;
    }
  }

  async refreshUserProfile(userFile: string): Promise<StellaUserProfile | null> {
    this.userByFile.delete(userFile);
    return this.getUserProfile(userFile);
  }

  async createUserProfile(name: string): Promise<{ userFile: string; profile: StellaUserProfile }> {
    if (!(await this.vault.adapter.exists(`${BASE_FOLDER}/USERS`))) {
      await this.vault.createFolder(`${BASE_FOLDER}/USERS`);
    }
    const now = Date.now();
    const profile: StellaUserProfile = {
      id: uuidv4(),
      name: name.trim() || "User",
      description: "",
      aliases: [],
      createdAt: now,
      modifiedAt: now,
    };
    const baseName = sanitizeFolderName(profile.name) || "User";
    const userFile = await uniquePath(this.vault, `${BASE_FOLDER}/USERS/${baseName}.json`);
    this.markSelfWrite(userFile);
    await this.vault.create(userFile, JSON.stringify(profile, null, 2));
    this.userByFile.set(userFile, profile);
    this.usersCache = null;
    this.trigger("users-changed");
    this.trigger("user-profile-changed", userFile);
    return { userFile, profile };
  }

  async copyUserProfile(
    userFile: string
  ): Promise<{ userFile: string; profile: StellaUserProfile }> {
    const profile = await this.getUserProfile(userFile);
    if (!profile) throw new Error("User not found");
    if (!(await this.vault.adapter.exists(`${BASE_FOLDER}/USERS`))) {
      await this.vault.createFolder(`${BASE_FOLDER}/USERS`);
    }
    const now = Date.now();
    const cloned: StellaUserProfile = {
      ...JSON.parse(JSON.stringify(profile)),
      id: uuidv4(),
      name: `${profile.name || "User"} Copy`,
      createdAt: now,
      modifiedAt: now,
    };
    const baseName = sanitizeFolderName(cloned.name) || "User Copy";
    const targetFile = await uniquePath(this.vault, `${BASE_FOLDER}/USERS/${baseName}.json`);
    const sourceFolder = parentFolderPath(userFile);
    const targetBase = targetFile.split("/").pop()?.replace(/\.json$/i, "") ?? baseName;
    if (typeof profile.thumbnail === "string" && profile.thumbnail) {
      const sourceThumb = this.vault.getAbstractFileByPath(`${sourceFolder}/${profile.thumbnail}`);
      if (sourceThumb instanceof TFile) {
        const ext = sanitizeImageExt(profile.thumbnail.split(".").pop() ?? "png");
        const thumbName = `${targetBase}.thumbnail.${ext}`;
        const targetThumb = `${BASE_FOLDER}/USERS/${thumbName}`;
        this.markSelfWrite(targetThumb);
        await this.vault.copy(sourceThumb, targetThumb);
        cloned.thumbnail = thumbName;
      }
    }
    this.markSelfWrite(targetFile);
    await this.vault.create(targetFile, JSON.stringify(cloned, null, 2));
    this.userByFile.set(targetFile, cloned);
    this.usersCache = null;
    this.trigger("users-changed");
    this.trigger("user-profile-changed", targetFile);
    return { userFile: targetFile, profile: cloned };
  }

  async saveUserProfile(userFile: string, profile: StellaUserProfile): Promise<void> {
    const next = normalizeScannedUserProfile({ ...profile, modifiedAt: Date.now() });
    this.markSelfWrite(userFile);
    const file = this.vault.getAbstractFileByPath(userFile);
    const body = JSON.stringify(next, null, 2);
    if (file instanceof TFile) await this.vault.modify(file, body);
    else await this.vault.create(userFile, body);
    this.userByFile.set(userFile, next);
    this.usersCache = null;
    if (next.id === "default" || userFile === defaultUserProfilePath()) {
      this.defaultUserProfile = next;
    }
    this.trigger("users-changed");
    this.trigger("user-profile-changed", userFile);
  }

  async setUserThumbnail(
    userFile: string,
    bytes: ArrayBuffer,
    ext: string
  ): Promise<string> {
    const profile = await this.getUserProfile(userFile);
    if (!profile) throw new Error("User not found");
    const folder = parentFolderPath(userFile);
    const base = userFile.split("/").pop()?.replace(/\.json$/i, "") || "user";
    const filename = `${base}.thumbnail.${sanitizeImageExt(ext)}`;
    const target = `${folder}/${filename}`;
    await this.writeBinaryFile(target, bytes);
    profile.thumbnail = filename;
    await this.saveUserProfile(userFile, profile);
    return target;
  }

  async toggleUserFavorite(userFile: string): Promise<void> {
    const profile = await this.getUserProfile(userFile);
    if (!profile) return;
    profile.favorite = !profile.favorite;
    await this.saveUserProfile(userFile, profile);
  }

  async deleteUserProfile(userFile: string): Promise<void> {
    const profile = await this.getUserProfile(userFile);
    if (profile?.id === "default") throw new Error("기본 페르소나는 삭제할 수 없습니다");
    const file = this.vault.getAbstractFileByPath(userFile);
    if (file instanceof TFile) await this.vault.trash(file, true);
    this.userByFile.delete(userFile);
    this.usersCache = null;
    this.trigger("users-changed");
  }

  async saveDefaultUserProfile(profile: StellaUserProfile): Promise<void> {
    const path = defaultUserProfilePath();
    const next = normalizeUserProfile({ ...profile, modifiedAt: Date.now() });
    if (!(await this.vault.adapter.exists(`${BASE_FOLDER}/USERS`))) {
      await this.vault.createFolder(`${BASE_FOLDER}/USERS`);
    }
    this.markSelfWrite(path);
    this.defaultUserProfile = next;
    const file = this.vault.getAbstractFileByPath(path);
    const body = JSON.stringify(next, null, 2);
    if (file instanceof TFile) await this.vault.modify(file, body);
    else await this.vault.create(path, body);
    this.usersCache = null;
    this.userByFile.set(path, next);
    this.trigger("users-changed");
    this.trigger("user-profile-changed", path);
  }

  // ─────────────────────────── cross-domain mutations ───────────────────────────

  /**
   * 사용자 파일 임포트의 유일한 진입점.
   * 실제 포맷 판별/쓰기 파이프라인은 import/ 아래 순수한 하위 함수가 맡고,
   * Store 는 쓰기 이후 캐시 무효화와 이벤트 전파를 책임진다.
   */
  async importFile(bytes: Uint8Array, filename: string): Promise<ImportResult> {
    const result = await importVaultFile(bytes, filename, this.vault);
    this.afterImport(result);
    return result;
  }

  /**
   * 시나리오를 깊은 복사하고 현재 세션 폴더를 새 시나리오 아래로 이동한다.
   * 우측 시나리오 탭의 `복사` 버튼이 호출하는 공식 mutation.
   */
  async copyScenarioForSession(
    sourceScenarioFile: string,
    sessionFile: string
  ): Promise<{
    newFolder: string;
    newScenarioFile: string;
    oldSessionFile: string;
    newSessionFile: string;
  }> {
    const scenarios = await this.getScenarios();
    const item = scenarios.find((s) => s.scenarioFile === sourceScenarioFile);
    if (!item) throw new Error("원본 시나리오를 찾을 수 없습니다.");

    const sourceFolder = sourceScenarioFile.replace(/\/scenario\.json$/, "");
    const sessionFolder = sessionFolderOfSessionFilePath(sessionFile);
    if (!sessionFolder) throw new Error("세션 경로 해석 실패");

    const sessionFolderObj = this.vault.getAbstractFileByPath(sessionFolder);
    if (!(sessionFolderObj instanceof TFolder)) {
      throw new Error(`세션 폴더를 찾을 수 없음: ${sessionFolder}`);
    }

    const session = await this.getSession(sessionFile);
    if (!session) throw new Error("세션을 불러올 수 없습니다.");

    const newFolder = await uniquePath(this.vault, sourceFolder);
    await this.vault.createFolder(newFolder);
    await this.vault.createFolder(`${newFolder}/SESSIONS`);

    const cloned: StellaScenario = JSON.parse(JSON.stringify(item.scenario));
    const extensions = (cloned.data.extensions = cloned.data.extensions ?? {});
    const previousThumb = extensions.stella?.thumbnail ?? null;
    const newScenarioId = uuidv4();
    extensions.stella = {
      id: newScenarioId,
      favorite: false,
      lastPlayedAt: 0,
      playCount: 0,
      thumbnail: previousThumb,
    };

    const newScenarioFile = `${newFolder}/scenario.json`;
    this.markSelfWrite(newScenarioFile);
    await this.vault.create(newScenarioFile, JSON.stringify(cloned, null, 2));

    if (typeof previousThumb === "string" && previousThumb) {
      const src = `${sourceFolder}/${previousThumb}`;
      const srcFile = this.vault.getAbstractFileByPath(src);
      if (srcFile instanceof TFile) {
        const target = `${newFolder}/${previousThumb}`;
        this.markSelfWrite(target);
        await this.vault.copy(srcFile, target);
      }
    }

    const sessionFolderName = sessionFolder.split("/").pop()!;
    const newSessionFolder = `${newFolder}/SESSIONS/${sessionFolderName}`;
    const newSessionFile = `${newSessionFolder}/session.json`;
    await this.vault.rename(sessionFolderObj, newSessionFolder);

    this.sessionByFile.delete(sessionFile);
    const movedTranslations = this.translationsBySessionFile.get(sessionFile);
    this.translationsBySessionFile.delete(sessionFile);
    if (movedTranslations) this.translationsBySessionFile.set(newSessionFile, movedTranslations);
    const movedSummaries = this.summariesBySessionFile.get(sessionFile);
    this.summariesBySessionFile.delete(sessionFile);
    if (movedSummaries) this.summariesBySessionFile.set(newSessionFile, movedSummaries);
    session.meta.scenarioId = newScenarioId;
    await this.saveSession(newSessionFile, session);

    this.scenariosCache = null;
    const oldScenarioFolder = scenarioFolderOfSessionFile(sessionFile);
    if (oldScenarioFolder) {
      this.sessionsByFolder.delete(oldScenarioFolder);
      this.trigger("sessions-changed", oldScenarioFolder);
    }
    this.sessionsByFolder.delete(newFolder);
    this.trigger("scenarios-changed");
    this.trigger("sessions-changed", newFolder);

    return {
      newFolder,
      newScenarioFile,
      oldSessionFile: sessionFile,
      newSessionFile,
    };
  }

  // ─────────────────────────── vault → cache invalidation ───────────────────────────

  private onVaultChange(
    path: string,
    kind: "create" | "delete" | "modify"
  ): void {
    if (this.isRecentSelfWrite(path)) return;

    // scenario.json 변경
    if (path.endsWith("/scenario.json")) {
      this.scenariosCache = null;
      this.trigger("scenarios-changed");
      return;
    }
    // translations.json 변경 (문단 번역)
    if (path.endsWith("/translations.json")) {
      const sessionFile = `${path.slice(0, -"/translations.json".length)}/session.json`;
      this.translationsBySessionFile.delete(sessionFile);
      this.trigger("session-translations-changed", sessionFile);
      return;
    }
    // summaries.json 변경 (노드 앵커 요약)
    if (path.endsWith("/summaries.json")) {
      const sessionFile = `${path.slice(0, -"/summaries.json".length)}/session.json`;
      this.summariesBySessionFile.delete(sessionFile);
      this.trigger("session-summaries-changed", sessionFile);
      return;
    }
    // illustrations.json 변경 (노드 삽화)
    if (path.endsWith("/illustrations.json")) {
      const sessionFile = `${path.slice(0, -"/illustrations.json".length)}/session.json`;
      this.trigger("session-illustrations-changed", sessionFile);
      return;
    }
    // session.json 변경
    if (path.endsWith("/session.json")) {
      this.sessionByFile.delete(path);
      this.scenariosCache = null;
      this.trigger(kind === "delete" ? "session-deleted" : "session-changed", path);
      const scenarioFolder = scenarioFolderOfSessionFile(path);
      if (scenarioFolder) {
        this.sessionsByFolder.delete(scenarioFolder);
        this.trigger("sessions-changed", scenarioFolder);
      }
      this.trigger("scenarios-changed");
      return;
    }
    // PROMPTS/<X>.json (신규) 또는 PROMPTS/<X>/preset.json (레거시)
    if (
      path.startsWith(`${BASE_FOLDER}/PROMPTS/`) &&
      (path.endsWith(".json") || path.endsWith("/preset.json"))
    ) {
      this.promptByFile.delete(path);
      this.promptsCache = null;
      this.trigger("prompt-preset-changed", path);
      this.trigger("prompt-presets-changed");
      return;
    }
    // PRESETS/<이름>.json 변경 (프리셋 북마크)
    if (
      path.startsWith(`${BASE_FOLDER}/PRESETS/`) &&
      path.endsWith(".json")
    ) {
      this.presetByFile.delete(path);
      this.presetsCache = null;
      this.trigger("preset-changed", path);
      this.trigger("presets-changed");
      return;
    }
    // LOREBOOKS/<X>/lorebook.json 변경
    if (
      path.startsWith(`${BASE_FOLDER}/LOREBOOKS/`) &&
      path.endsWith("/lorebook.json")
    ) {
      this.lorebookByFile.delete(path);
      this.lorebooksCache = null;
      this.trigger("lorebook-changed", path);
      this.trigger("lorebooks-changed");
      return;
    }
    // 폴더 create/delete (시나리오 폴더 또는 세션 폴더)
    if (
      path.startsWith(`${BASE_FOLDER}/USERS/`) &&
      path.endsWith(".json")
    ) {
      this.defaultUserProfile = null;
      this.userByFile.delete(path);
      this.usersCache = null;
      this.trigger("users-changed");
      this.trigger("user-profile-changed", path);
      return;
    }
    if (kind === "create" || kind === "delete") {
      const segments = path.split("/");
      if (path.startsWith(`${BASE_FOLDER}/SCENARIOS/`)) {
        // GGAI/SCENARIOS/<scenario>
        if (segments.length === 3) {
          this.scenariosCache = null;
          this.trigger("scenarios-changed");
          return;
        }
        // GGAI/SCENARIOS/<scenario>/SESSIONS/<session>
        if (segments.length === 5 && segments[3] === "SESSIONS") {
          const scenarioFolder = segments.slice(0, 3).join("/");
          this.sessionsByFolder.delete(scenarioFolder);
          this.trigger("sessions-changed", scenarioFolder);
        }
        return;
      }
      // GGAI/PROMPTS/<preset>
      if (
        path.startsWith(`${BASE_FOLDER}/PROMPTS/`) &&
        segments.length === 3
      ) {
        this.promptsCache = null;
        this.trigger("prompt-presets-changed");
      }
      // GGAI/LOREBOOKS/<book> (폴더 자체 추가/삭제)
      if (
        path.startsWith(`${BASE_FOLDER}/LOREBOOKS/`) &&
        segments.length === 3
      ) {
        this.lorebooksCache = null;
        this.trigger("lorebooks-changed");
      }
    }
  }

  private markSelfWrite(path: string): void {
    this.selfWriteTimes.set(path, Date.now());
  }

  private isRecentSelfWrite(path: string): boolean {
    const t = this.selfWriteTimes.get(path);
    if (t == null) return false;
    if (Date.now() - t < SELF_WRITE_GRACE_MS) return true;
    this.selfWriteTimes.delete(path);
    return false;
  }

  private afterImport(result: ImportResult): void {
    if (result.kind === "error") return;
    if (result.kind === "prompt") {
      if (result.write.ok) {
        this.markSelfWrite(result.write.file);
        this.promptByFile.delete(result.write.file);
      }
      this.promptsCache = null;
      this.trigger("prompt-presets-changed");
      return;
    }
    if (result.kind === "lorebook") {
      if (result.write.ok) {
        this.markSelfWrite(result.write.file);
        this.lorebookByFile.delete(result.write.file);
      }
      this.lorebooksCache = null;
      this.trigger("lorebooks-changed");
      return;
    }
    if (result.kind === "scenario") {
      this.markSelfWrite(result.write.scenarioFile);
      this.scenariosCache = null;
      this.trigger("scenarios-changed");
      if (result.write.lorebook?.ok) {
        this.markSelfWrite(result.write.lorebook.file);
        this.lorebookByFile.delete(result.write.lorebook.file);
        this.lorebooksCache = null;
        this.trigger("lorebooks-changed");
      }
    }
  }
}

// ─────────────────────────── helpers ───────────────────────────

function ensureStellaExt(scenario: StellaScenario): void {
  const data: any = scenario.data;
  if (!data.extensions) data.extensions = {};
  if (!data.extensions.stella) {
    data.extensions.stella = {
      id: uuidv4(),
      favorite: false,
      lastPlayedAt: 0,
      playCount: 0,
      thumbnail: null,
    };
  }
}

/** GGAI/SCENARIOS/X/SESSIONS/Y/session.json → GGAI/SCENARIOS/X */
function scenarioFolderOfSessionFile(sessionFile: string): string | null {
  const parts = sessionFile.split("/");
  if (parts.length < 6 || parts[parts.length - 3] !== "SESSIONS") return null;
  return parts.slice(0, parts.length - 3).join("/");
}

function scenarioFileOfSessionFile(sessionFile: string): string | null {
  const folder = scenarioFolderOfSessionFile(sessionFile);
  return folder ? `${folder}/scenario.json` : null;
}

/** GGAI/SCENARIOS/X/SESSIONS/Y → GGAI/SCENARIOS/X */
function scenarioFolderOfSessionFolder(sessionFolder: string): string | null {
  const parts = sessionFolder.split("/");
  if (parts.length < 5 || parts[parts.length - 2] !== "SESSIONS") return null;
  return parts.slice(0, parts.length - 2).join("/");
}

function sessionFolderOfSessionFilePath(sessionFile: string): string | null {
  if (!sessionFile.endsWith("/session.json")) return null;
  return sessionFile.slice(0, -"/session.json".length);
}

/** .../session.json → .../translations.json */
function translationsFileOfSessionFile(sessionFile: string): string | null {
  const folder = sessionFolderOfSessionFilePath(sessionFile);
  return folder ? `${folder}/translations.json` : null;
}

/** .../session.json → .../summaries.json */
function summariesFileOfSessionFile(sessionFile: string): string | null {
  const folder = sessionFolderOfSessionFilePath(sessionFile);
  return folder ? `${folder}/summaries.json` : null;
}

/** .../session.json → .../illustrations.json */
function illustrationsFileOfSessionFile(sessionFile: string): string | null {
  const folder = sessionFolderOfSessionFilePath(sessionFile);
  return folder ? `${folder}/illustrations.json` : null;
}

async function uniquePath(vault: Vault, basePath: string): Promise<string> {
  if (!(await vault.adapter.exists(basePath))) return basePath;
  for (let i = 2; i < 1000; i++) {
    const p = normalizePath(`${basePath}-${i}`);
    if (!(await vault.adapter.exists(p))) return p;
  }
  throw new Error("폴더 경로 충돌 해결 실패");
}

/** 확장자(.md)를 보존하며 충돌 없는 경로를 찾는다 ("base 2.md" 식). */
async function uniqueMarkdownPath(
  vault: Vault,
  baseNoExt: string
): Promise<string> {
  const first = normalizePath(`${baseNoExt}.md`);
  if (!(await vault.adapter.exists(first))) return first;
  for (let i = 2; i < 1000; i++) {
    const p = normalizePath(`${baseNoExt} ${i}.md`);
    if (!(await vault.adapter.exists(p))) return p;
  }
  throw new Error("내보내기 경로 충돌 해결 실패");
}

async function copyNamedFileIfExists(
  vault: Vault,
  sourceFolder: string,
  targetFolder: string,
  filename: string | null | undefined
): Promise<void> {
  if (!filename) return;
  const source = vault.getAbstractFileByPath(`${sourceFolder}/${filename}`);
  if (source instanceof TFile) {
    await vault.copy(source, `${targetFolder}/${filename}`);
  }
}

async function copyFolderChildren(
  vault: Vault,
  sourceFolder: TFolder,
  targetFolder: string,
  skipNames: string[] = []
): Promise<void> {
  for (const child of sourceFolder.children) {
    if (skipNames.includes(child.name)) continue;
    const target = normalizePath(`${targetFolder}/${child.name}`);
    if (child instanceof TFile) {
      await vault.copy(child, await uniquePath(vault, target));
    } else if (child instanceof TFolder) {
      const folder = await uniquePath(vault, target);
      await vault.createFolder(folder);
      await copyFolderChildren(vault, child, folder);
    }
  }
}

function parentFolderPath(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx < 0 ? "" : filePath.slice(0, idx);
}

function sanitizeFolderName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\n\r]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function collectSessionFiles(
  scenarioFolder: string,
  sessions: SessionListItem[],
  cachedFiles: string[]
): string[] {
  const files = sessions.map((item) => item.sessionFile);
  for (const file of cachedFiles) {
    if (file.startsWith(`${scenarioFolder}/SESSIONS/`) && !files.includes(file)) {
      files.push(file);
    }
  }
  return files;
}

function sanitizeImageExt(ext: string): string {
  const clean = ext.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (clean === "jpg" || clean === "jpeg") return "jpg";
  if (clean === "webp") return "webp";
  if (clean === "gif") return "gif";
  if (clean === "avif") return "avif";
  return "png";
}

function defaultUserProfilePath(): string {
  return `${BASE_FOLDER}/USERS/default.json`;
}

function normalizeUserProfile(raw: Partial<StellaUserProfile>): StellaUserProfile {
  const fallback = createDefaultUserProfile();
  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim()
    : fallback.name;
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : fallback.id,
    name,
    description: typeof raw.description === "string" ? raw.description : "",
    thumbnail: typeof raw.thumbnail === "string" && raw.thumbnail ? raw.thumbnail : null,
    aliases: Array.isArray(raw.aliases)
      ? raw.aliases.filter((a): a is string => typeof a === "string")
      : [],
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : fallback.createdAt,
    modifiedAt: typeof raw.modifiedAt === "number" ? raw.modifiedAt : fallback.modifiedAt,
  };
}
