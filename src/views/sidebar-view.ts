import {
  ItemView,
  Menu,
  Notice,
  TFile,
  WorkspaceLeaf,
  debounce,
  setIcon,
} from "obsidian";
import { VIEW_TYPE_SIDEBAR } from "../constants";
import { getSessionHostLeaves } from "./session-host";
import type StellaEnginePlugin from "../main";
import { StellaStore, type SessionChangeDetail } from "../state/store";
import type { LorebookListItem } from "../util/scan-lorebooks";
import type { ScenarioListItem } from "../util/scan-scenarios";
import type { SessionListItem } from "../util/scan-sessions";
import type { UserListItem } from "../util/scan-users";
import { formatRelativeTime } from "../util/relative-time";
import { renderThumb } from "../util/render-thumb";
import { PressMenuController } from "../util/press-menu";
import {
  compareBy,
  getFavorite,
  sessionMetaLabel,
  sessionRecentTime,
  type SortKey,
} from "../util/scenario-list-helpers";
import {
  confirmDeleteLorebook,
  confirmDeleteScenario,
  confirmDeleteUser,
  createAndOpenSession,
  getInviteToActiveSession,
  openSessionByPath,
  promptNewLorebook,
  promptNewScenario,
  promptNewUser,
  promptRenameSession,
  runImportPicker,
} from "./entity-actions";
import { buildSessionMenu } from "./session-menu";

type SidebarTab = "scenario" | "user" | "lorebook";
type SidebarCardLayout = "compact" | "cover";

/** 로어북/페르소나 탭 정렬 — 이름순 / 수정순(최신). */
type SimpleSortKey = "alpha" | "modified";

/**
 * SidebarView — 좌측 사이드바.
 *
 * 데이터는 모두 `this.store` 를 통한다. 변경 이벤트:
 *   - "scenarios-changed"            → 시나리오 카드 목록 갱신
 *   - "sessions-changed" (folder)    → 그 시나리오의 세션 목록 갱신 (확장 중일 때만)
 *
 * 로컬 UI 상태는 view 안에 보관:
 *   - searchQuery, sortKey, expanded(folder set)
 */
export class SidebarView extends ItemView {
  private items: ScenarioListItem[] = [];
  private lorebooks: LorebookListItem[] = [];
  private users: UserListItem[] = [];
  private searchQuery = "";
  private sortKey: SortKey = "recent";
  private simpleSortKey: SimpleSortKey = "alpha";
  private sortEl: HTMLSelectElement | null = null;
  private expanded = new Set<string>();
  private sessionsByFolder = new Map<string, SessionListItem[]>();
  private activeTab: SidebarTab = "scenario";
  private cardLayout: SidebarCardLayout = "compact";
  private pressMenu = new PressMenuController();
  private refreshingFromDisk = false;
  private lastDiskRefreshAt = 0;

  private tabHeaderEls: Record<SidebarTab, HTMLElement> = {
    scenario: null as unknown as HTMLElement,
    user: null as unknown as HTMLElement,
    lorebook: null as unknown as HTMLElement,
  };
  private tabContentEl: HTMLElement | null = null;

  private plugin: StellaEnginePlugin;
  private store: StellaStore;

  private visibilityHandler = () => {
    if (document.visibilityState === "visible") {
      void this.refreshCurrentTabFromDisk();
    }
  };

  constructor(leaf: WorkspaceLeaf, plugin: StellaEnginePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
  }

  getViewType(): string {
    return VIEW_TYPE_SIDEBAR;
  }
  getDisplayText(): string {
    return "GGAI Stella";
  }
  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    this.activeTab = this.plugin.data.lastSidebarTab ?? "scenario";
    this.cardLayout = this.plugin.data.sidebarCardLayout ?? "compact";
    await this.refreshItems();
    await this.refreshUsers();
    await this.refreshLorebooks();
    this.render();

    // store 이벤트 구독 — 자체 변경/외부 변경 모두 여기로 흘러들어온다.
    const debouncedRefresh = debounce(
      () => void this.refreshAndRerenderList(),
      120,
      false
    );
    this.registerEvent(this.store.on("scenarios-changed", debouncedRefresh));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) return;
        if (this.activeTab === "scenario") this.renderListContents();
      })
    );
    this.registerEvent(
      this.store.on("sessions-changed", (folder: string) => {
        if (this.expanded.has(folder)) {
          void this.reloadSessions(folder);
        }
      })
    );
    this.registerEvent(
      this.store.on(
        "session-changed",
        (file: string, detail?: SessionChangeDetail) => {
          // 활성 설정만 바뀐 저장은 세션 줄 표시(이름/즐겨찾기/시각)와 무관.
          if (detail?.kinds?.every((k) => k === "settings")) return;
          // 세션 메타(name/favorite) 가 바뀔 수 있으므로 해당 시나리오의 목록 행만 갱신.
          for (const folder of this.expanded) {
            const list = this.sessionsByFolder.get(folder);
            if (list && list.some((s) => s.sessionFile === file)) {
              void this.reloadSessions(folder);
              return;
            }
          }
        }
      )
    );
    this.registerEvent(
      this.store.on("session-unread-changed", (file: string) => {
        // 안 읽음 뱃지 갱신 — 그 세션이 속한 시나리오가 펼쳐져 있을 때만.
        const folder = file.split("/SESSIONS/")[0];
        if (this.expanded.has(folder)) void this.reloadSessions(folder);
      })
    );
    // 로어북 변경 (L3a) — 활성 탭이 lorebook 일 때만 그 안만 갱신.
    this.registerEvent(
      this.store.on("session-renamed", (oldFile: string, newFile: string) => {
        this.retargetSessionViews(oldFile, newFile);
      })
    );
    const debouncedLoreRefresh = debounce(
      () => void this.refreshAndRerenderLorebooks(),
      120,
      false
    );
    this.registerEvent(this.store.on("lorebooks-changed", debouncedLoreRefresh));
    this.registerEvent(
      this.store.on("users-changed", () => void this.refreshAndRerenderUsers())
    );
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.registerDomEvent(window, "focus", () => void this.refreshCurrentTabFromDisk());
  }

  async onClose(): Promise<void> {
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    // registerEvent 가 정리.
  }

  // --- data ---

  private async refreshItems(): Promise<void> {
    this.items = await this.store.refreshScenarios();
  }

  private async refreshLorebooks(): Promise<void> {
    this.lorebooks = await this.store.refreshLorebooks().catch(() => []);
  }

  private async refreshUsers(): Promise<void> {
    this.users = await this.store.refreshUsers().catch(() => []);
  }

  /** 시나리오 + 확장된 세션 폴더 모두 새로고침 후 리스트만 다시 그린다. */
  private async refreshAndRerenderList(): Promise<void> {
    await this.refreshItems();
    for (const folder of this.expanded) {
      this.sessionsByFolder.set(folder, await this.store.refreshSessions(folder));
    }
    this.renderListContents();
  }

  private async refreshAndRerenderLorebooks(): Promise<void> {
    await this.refreshLorebooks();
    if (this.activeTab === "lorebook") this.renderListContents();
  }

  private async refreshAndRerenderUsers(): Promise<void> {
    await this.refreshUsers();
    if (this.activeTab === "user") this.renderListContents();
  }

  private async reloadSessions(folder: string): Promise<void> {
    this.sessionsByFolder.set(folder, await this.store.refreshSessions(folder));
    this.renderListContents();
  }

  private async refreshCurrentTabFromDisk(): Promise<void> {
    if (this.refreshingFromDisk) return;
    this.refreshingFromDisk = true;
    try {
      if (this.activeTab === "scenario") await this.refreshAndRerenderList();
      else if (this.activeTab === "lorebook") await this.refreshAndRerenderLorebooks();
      else await this.refreshAndRerenderUsers();
    } finally {
      this.lastDiskRefreshAt = Date.now();
      this.refreshingFromDisk = false;
    }
  }

  private requestFreshRender(): void {
    if (this.refreshingFromDisk) return;
    if (Date.now() - this.lastDiskRefreshAt < 1000) return;
    void this.refreshCurrentTabFromDisk();
  }

  // --- render ---

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ggai-stella-sidebar");

    this.renderActionBar(root);
    this.renderPanelOpenButton(root);
    root.createEl("div", { cls: "ggai-sidebar-divider" });
    this.renderSearch(root);
    this.renderTabs(root);
    this.renderListHeader(root);
    this.renderList(root);
    // 마지막 활성 탭이 lorebook 이면 헤더 라벨/정렬 가시성 보정.
    this.renderListHeaderText();
    this.renderUserTabChrome();
  }

  private renderTabs(root: HTMLElement): void {
    const tabs = root.createEl("div", { cls: "ggai-sidebar-tabs" });
    tabs.setAttr("role", "tablist");
    this.tabHeaderEls.scenario = tabs.createEl("div", {
      cls: "ggai-sidebar-tab",
      text: "시나리오",
    });
    this.tabHeaderEls.user = tabs.createEl("div", {
      cls: "ggai-sidebar-tab",
      text: "페르소나",
    });
    this.tabHeaderEls.lorebook = tabs.createEl("div", {
      cls: "ggai-sidebar-tab",
      text: "로어북",
    });
    for (const tab of ["scenario", "user", "lorebook"] as SidebarTab[]) {
      const el = this.tabHeaderEls[tab];
      el.toggleClass("is-active", this.activeTab === tab);
      el.setAttr("role", "tab");
      el.setAttr("tabindex", "0");
      el.setAttr("aria-selected", String(this.activeTab === tab));
      el.addEventListener("click", () => void this.setTab(tab));
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        void this.setTab(tab);
      });
    }
  }

  private async setTab(next: SidebarTab): Promise<void> {
    if (this.activeTab === next) return;
    this.activeTab = next;
    for (const tab of ["scenario", "user", "lorebook"] as SidebarTab[]) {
      this.tabHeaderEls[tab].toggleClass("is-active", this.activeTab === tab);
      this.tabHeaderEls[tab].setAttr("aria-selected", String(this.activeTab === tab));
    }
    this.renderListHeaderText();
    this.renderUserTabChrome();
    this.renderListContents();
    await this.plugin.savePluginData({ lastSidebarTab: next });
  }

  /** 탭에 따라 헤더 라벨만 갱신 (시나리오/로어북). 정렬 드롭다운은 시나리오 탭에서만 의미. */
  private renderListHeaderText(): void {
    const titleEl = this.contentEl.querySelector(".ggai-list-title");
    if (titleEl) titleEl.textContent = this.activeTab === "scenario" ? "시나리오" : "로어북";
    const sort = this.contentEl.querySelector(".ggai-sort");
    if (sort instanceof HTMLElement) {
      sort.style.display = "";
    }
    this.populateSortOptions();
  }

  private renderUserTabChrome(): void {
    const titleEl = this.contentEl.querySelector(".ggai-list-title");
    if (titleEl && this.activeTab === "user") titleEl.textContent = "페르소나";
    const search = this.contentEl.querySelector(".ggai-search");
    if (search instanceof HTMLElement) {
      search.style.display = "";
    }
    const actionBar = this.contentEl.querySelector(".ggai-action-bar");
    if (actionBar instanceof HTMLElement) {
      actionBar.style.display = "";
    }
  }

  private renderActionBar(root: HTMLElement): void {
    const bar = root.createEl("div", { cls: "ggai-action-bar" });

    const importBtn = bar.createEl("button", { cls: "ggai-btn" });
    setIcon(importBtn, "download");
    importBtn.createSpan({ text: "임포트" });
    importBtn.addEventListener("click", () => this.triggerImport());

    const addBtn = bar.createEl("button", { cls: "ggai-btn" });
    setIcon(addBtn, "plus");
    addBtn.createSpan({ text: "추가" });
    addBtn.addEventListener("click", (e) => this.showAddMenu(e));
  }

  private showAddMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("시나리오")
        .setIcon("sparkles")
        .onClick(() => this.triggerAddScenario())
    );
    menu.addItem((item) =>
      item
        .setTitle("페르소나")
        .setIcon("user")
        .onClick(() => this.triggerAddUser())
    );
    menu.addItem((item) =>
      item
        .setTitle("로어북")
        .setIcon("book-open")
        .onClick(() => this.triggerAddLorebook())
    );
    menu.showAtMouseEvent(e);
  }

  private renderPanelOpenButton(root: HTMLElement): void {
    const btn = root.createEl("button", {
      cls: "ggai-btn ggai-panel-open",
    });
    setIcon(btn, "external-link");
    btn.createSpan({ text: "패널 열기" });
    btn.setAttr("aria-label", "패널 열기");
    btn.setAttr("title", "패널 열기");
    btn.addEventListener(
      "click",
      (event) => {
        event.stopImmediatePropagation();
        void this.plugin.openStellaPanel();
      },
      { capture: true }
    );
  }

  private renderSearch(root: HTMLElement): void {
    const input = root.createEl("input", {
      cls: "ggai-search",
      type: "search",
    });
    input.placeholder = "시나리오/세션 검색";
    input.value = this.searchQuery;
    input.addEventListener("input", () => {
      this.searchQuery = input.value;
      this.renderListContents();
    });
  }

  private renderListHeader(root: HTMLElement): void {
    const header = root.createEl("div", { cls: "ggai-list-header" });
    header.createEl("span", { cls: "ggai-list-title", text: "시나리오" });

    const controls = header.createEl("div", { cls: "ggai-list-controls" });
    const layout = controls.createEl("select", { cls: "ggai-layout-select" });
    const layoutOptions: Array<{ value: SidebarCardLayout; label: string }> = [
      { value: "compact", label: "Compact" },
      { value: "cover", label: "Cover" },
    ];
    for (const opt of layoutOptions) {
      const el = layout.createEl("option", { text: opt.label, value: opt.value });
      if (opt.value === this.cardLayout) el.selected = true;
    }
    layout.addEventListener("change", () => {
      this.cardLayout = layout.value as SidebarCardLayout;
      void this.plugin.savePluginData({ sidebarCardLayout: this.cardLayout });
      this.renderListContents();
    });

    const sort = controls.createEl("select", { cls: "ggai-sort" });
    this.sortEl = sort;
    sort.addEventListener("change", () => {
      if (this.activeTab === "scenario") this.sortKey = sort.value as SortKey;
      else this.simpleSortKey = sort.value as SimpleSortKey;
      this.renderListContents();
    });
    this.populateSortOptions();
  }

  /** 활성 탭에 맞는 정렬 옵션을 채운다. 즐겨찾기는 별도 옵션이 아니라 항상 최상단에 고정된다. */
  private populateSortOptions(): void {
    const sort = this.sortEl;
    if (!sort) return;
    sort.empty();
    if (this.activeTab === "scenario") {
      const options: Array<{ value: SortKey; label: string }> = [
        { value: "recent", label: "최근 플레이순" },
        { value: "alpha", label: "알파벳순" },
        { value: "most-played", label: "최다 플레이순" },
      ];
      for (const opt of options) {
        const el = sort.createEl("option", { text: opt.label, value: opt.value });
        if (opt.value === this.sortKey) el.selected = true;
      }
    } else {
      const options: Array<{ value: SimpleSortKey; label: string }> = [
        { value: "alpha", label: "이름순" },
        { value: "modified", label: "수정순" },
      ];
      for (const opt of options) {
        const el = sort.createEl("option", { text: opt.label, value: opt.value });
        if (opt.value === this.simpleSortKey) el.selected = true;
      }
    }
  }

  private renderList(root: HTMLElement): void {
    root.createEl("div", { cls: "ggai-scenario-list" });
    this.renderListContents();
  }

  private renderListContents(): void {
    this.requestFreshRender();
    const list = this.contentEl.querySelector(".ggai-scenario-list");
    if (!(list instanceof HTMLElement)) return;
    list.empty();

    if (this.activeTab === "scenario") {
      const visible = this.sortedFilteredItems();
      if (visible.length === 0) {
        list.createEl("div", {
          cls: "ggai-sidebar-empty",
          text:
            this.items.length === 0
              ? "아직 항목이 없습니다. [임포트] 또는 [추가] 로 시작하세요."
              : "검색 결과가 없습니다.",
        });
        return;
      }
      for (const item of visible) this.renderCard(list, item);
      return;
    }

    // lorebook 탭
    const visible = this.filteredLorebooks();
    if (this.activeTab === "user") {
      const visible = this.filteredUsers();
      if (visible.length === 0) {
        list.createEl("div", {
          cls: "ggai-sidebar-empty",
          text: "페르소나가 없습니다. [추가]에서 페르소나를 만들어주세요.",
        });
        return;
      }
      for (const user of visible) this.renderUserCard(list, user);
      return;
    }

    if (visible.length === 0) {
      list.createEl("div", {
        cls: "ggai-sidebar-empty",
        text:
          this.lorebooks.length === 0
            ? "임포트된 로어북이 없습니다. [임포트] 로 시작하세요."
            : "검색 결과가 없습니다.",
      });
      return;
    }
    for (const item of visible) this.renderLorebookCard(list, item);
  }

  private filteredLorebooks(): LorebookListItem[] {
    const q = this.searchQuery.trim().toLowerCase();
    const filtered = q
      ? this.lorebooks.filter((l) => {
          const n = (l.lorebook.meta.name ?? "").toLowerCase();
          const f = l.folderName.toLowerCase();
          if (n.includes(q) || f.includes(q)) return true;
          // 항목 내용/키워드/이름까지 검색
          return l.lorebook.entries.some((e) => {
            if (e.content.toLowerCase().includes(q)) return true;
            if ((e.name ?? "").toLowerCase().includes(q)) return true;
            return e.keys.some((k) => k.toLowerCase().includes(q));
          });
        })
      : this.lorebooks.slice();
    return filtered.sort((a, b) =>
      this.compareSimple(
        (a.lorebook.meta.name || a.folderName).toLowerCase(),
        (b.lorebook.meta.name || b.folderName).toLowerCase(),
        this.fileMtime(a.lorebookFile),
        this.fileMtime(b.lorebookFile)
      )
    );
  }

  private filteredUsers(): UserListItem[] {
    const q = this.searchQuery.trim().toLowerCase();
    const filtered = q
      ? this.users.filter((u) => {
          const n = u.profile.name.toLowerCase();
          const d = u.profile.description.toLowerCase();
          return n.includes(q) || d.includes(q);
        })
      : this.users.slice();
    return filtered.sort((a, b) => {
      // 기본 페르소나는 항상 최상단, 그다음 즐겨찾기.
      if (a.profile.id === "default") return -1;
      if (b.profile.id === "default") return 1;
      const fa = a.profile.favorite ? 1 : 0;
      const fb = b.profile.favorite ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return this.compareSimple(
        a.profile.name.toLowerCase(),
        b.profile.name.toLowerCase(),
        a.file.stat.mtime,
        b.file.stat.mtime
      );
    });
  }

  /** 로어북/페르소나 정렬 공통 비교자. 동률은 이름순 tiebreak. */
  private compareSimple(
    aName: string,
    bName: string,
    aMtime: number,
    bMtime: number
  ): number {
    switch (this.simpleSortKey) {
      case "alpha":
        return aName.localeCompare(bName);
      case "modified":
        return bMtime - aMtime || aName.localeCompare(bName);
    }
  }

  private fileMtime(path: string): number {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f.stat.mtime : 0;
  }

  private activeUserProfileFile(): string {
    return this.plugin.data.activeUserProfileFile ?? "GGAI/USERS/default.json";
  }

  private activeScenarioFile(): string | null {
    const sessionFile = this.plugin.getActiveOrLastSessionFile();
    if (!sessionFile) return null;
    return scenarioFileOfSessionFile(sessionFile);
  }

  private renderUserCard(parent: HTMLElement, item: UserListItem): void {
    const card = parent.createEl("div", { cls: "ggai-scenario-card" });
    card.addClass(this.cardLayout === "cover" ? "is-layout-cover" : "is-layout-compact");
    if (item.userFile === this.activeUserProfileFile()) card.addClass("is-active");

    const name = item.profile.name || "User";
    const meta = item.profile.id === "default" ? "기본 페르소나" : "";
    const isFav = item.profile.favorite === true;

    if (this.cardLayout === "cover") {
      const cover = card.createEl("div", { cls: "ggai-list-cover" });
      this.renderThumb(cover, item.thumbnailPath, name, "user");
      const overlay = cover.createEl("div", { cls: "ggai-cover-overlay" });
      overlay.createEl("span", { cls: "ggai-cover-overlay-name", text: name });
      const starBtn = overlay.createEl("button", { cls: "ggai-star" });
      setIcon(starBtn, "star");
      starBtn.toggleClass("is-favorited", isFav);
      starBtn.setAttr("aria-label", "페르소나 즐겨찾기");
      starBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.toggleUserFavorite(item);
      });
    } else {
      const body = card.createEl("div", { cls: "ggai-card-body" });
      const cover = body.createEl("div", { cls: "ggai-list-cover" });
      this.renderThumb(cover, item.thumbnailPath, name, "user");

      const nameBox = body.createEl("div", { cls: "ggai-name-box" });
      nameBox.createEl("div", { cls: "ggai-name", text: name });
      if (meta) nameBox.createEl("div", { cls: "ggai-card-meta", text: meta });

      const starBtn = body.createEl("button", { cls: "ggai-star" });
      setIcon(starBtn, "star");
      starBtn.toggleClass("is-favorited", isFav);
      starBtn.setAttr("aria-label", "페르소나 즐겨찾기");
      starBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.toggleUserFavorite(item);
      });
    }

    card.addEventListener("click", (e) => {
      if (this.consumeSuppressedClick(e)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("button,input,textarea,select")) return;
      void this.activateUser(item);
    });
    this.attachContextMenu(card, (e) => this.showUserMenu(e, item), (x, y) =>
      this.showUserMenuAt(x, y, item)
    );
  }

  private renderLorebookCard(parent: HTMLElement, item: LorebookListItem): void {
    const card = parent.createEl("div", { cls: "ggai-scenario-card" });
    card.addClass(this.cardLayout === "cover" ? "is-layout-cover" : "is-layout-compact");

    const name = item.lorebook.meta.name || item.folderName;
    const meta = `${item.lorebook.entries.length} 항목`;
    const thumbName = item.lorebook.meta.thumbnail;
    const thumbPath =
      thumbName &&
      this.app.vault.getAbstractFileByPath(`${item.folder.path}/${thumbName}`) instanceof TFile
        ? `${item.folder.path}/${thumbName}`
        : null;

    if (this.cardLayout === "cover") {
      const cover = card.createEl("div", { cls: "ggai-list-cover" });
      this.renderThumb(cover, thumbPath, name, "book-open");
      const overlay = cover.createEl("div", { cls: "ggai-cover-overlay" });
      overlay.createEl("span", { cls: "ggai-cover-overlay-name", text: name });
    } else {
      const body = card.createEl("div", { cls: "ggai-card-body" });
      const cover = body.createEl("div", { cls: "ggai-list-cover" });
      this.renderThumb(cover, thumbPath, name, "book-open");

      const nameBox = body.createEl("div", { cls: "ggai-name-box" });
      nameBox.createEl("div", { cls: "ggai-name", text: name });
      nameBox.createEl("div", { cls: "ggai-card-meta", text: meta });
    }

    card.addEventListener("click", (e) => {
      if (this.consumeSuppressedClick(e)) return;
      void this.openLorebookEditor(item);
    });
    this.attachContextMenu(card, (e) => this.showLorebookMenu(e, item), (x, y) =>
      this.showLorebookMenuAt(x, y, item)
    );
  }

  private async openLorebookEditor(item: LorebookListItem): Promise<void> {
    await this.plugin.openStellaEditor("lorebook", item.lorebookFile);
  }

  private confirmDeleteLorebook(item: LorebookListItem): void {
    confirmDeleteLorebook(this.plugin, item);
  }

  private renderCard(parent: HTMLElement, item: ScenarioListItem): void {
    const card = parent.createEl("div", { cls: "ggai-scenario-card" });
    card.addClass(this.cardLayout === "cover" ? "is-layout-cover" : "is-layout-compact");
    if (item.scenarioFile === this.activeScenarioFile()) card.addClass("is-active");
    const isExpanded = this.expanded.has(item.folder);
    if (isExpanded) card.addClass("is-expanded");

    const name = item.scenario.data.name || item.folderName;
    const meta = sessionMetaLabel(item.sessionCount, item.lastSessionAt);

    if (this.cardLayout === "cover") {
      const cover = card.createEl("div", { cls: "ggai-list-cover" });
      this.renderThumb(cover, item.thumbnailPath, name, "scroll-text");
      const overlay = cover.createEl("div", { cls: "ggai-cover-overlay" });
      overlay.createEl("span", { cls: "ggai-cover-overlay-name", text: name });
      const starBtn = overlay.createEl("button", { cls: "ggai-star" });
      setIcon(starBtn, "star");
      starBtn.toggleClass("is-favorited", getFavorite(item));
      starBtn.setAttr("aria-label", "시나리오 즐겨찾기");
      starBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.toggleScenarioFavorite(item);
      });
      this.attachContextMenu(cover, (e) => this.showScenarioMenu(e, item), (x, y) =>
        this.showScenarioMenuAt(x, y, item)
      );
    } else {
      const body = card.createEl("div", { cls: "ggai-card-body" });
      const cover = body.createEl("div", { cls: "ggai-list-cover" });
      this.renderThumb(cover, item.thumbnailPath, name, "scroll-text");

      const nameBox = body.createEl("div", { cls: "ggai-name-box" });
      nameBox.createEl("div", { cls: "ggai-name", text: name });
      if (meta) {
        nameBox.createEl("div", { cls: "ggai-card-meta", text: meta });
      }

      const starBtn = body.createEl("button", { cls: "ggai-star" });
      setIcon(starBtn, "star");
      starBtn.toggleClass("is-favorited", getFavorite(item));
      starBtn.setAttr("aria-label", "시나리오 즐겨찾기");
      starBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.toggleScenarioFavorite(item);
      });
      this.attachContextMenu(body, (e) => this.showScenarioMenu(e, item), (x, y) =>
        this.showScenarioMenuAt(x, y, item)
      );
    }

    card.addEventListener("click", (e) => {
      if (this.consumeSuppressedClick(e)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("button,input,textarea,select,.ggai-session-list")) return;
      void this.handleScenarioSelect(item);
    });

    if (isExpanded) this.renderSessionList(card, item);
  }

  /** 카드 썸네일 — 이미지가 있으면 이미지, 없으면 아이콘 플레이스홀더. */
  private renderThumb(
    container: HTMLElement,
    thumbnailPath: string | null,
    alt: string,
    fallbackIcon: string
  ): void {
    renderThumb(this.app, container, thumbnailPath, alt, fallbackIcon);
  }

  private renderSessionList(card: HTMLElement, item: ScenarioListItem): void {
    const container = card.createEl("div", { cls: "ggai-session-list" });

    const head = container.createEl("div", { cls: "ggai-session-list-head" });
    const sessions = this.sessionsByFolder.get(item.folder) ?? [];
    head.createEl("span", {
      cls: "ggai-session-list-title",
      text: `세션 ${sessions.length}`,
    });
    const addBtn = head.createEl("button", { cls: "ggai-session-add-btn" });
    setIcon(addBtn, "plus");
    addBtn.createSpan({ text: "새 세션" });
    addBtn.setAttr("aria-label", "새 세션");
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.triggerAddSession(item);
    });

    if (sessions.length === 0) {
      container.createEl("div", {
        cls: "ggai-session-empty",
        text: "아직 세션이 없습니다.",
      });
      return;
    }

    const activeFile = this.plugin.getActiveOrLastSessionFile();
    const sorted = sessions
      .slice()
      .sort(
        (a, b) =>
          (b.session.meta.modifiedAt ?? 0) - (a.session.meta.modifiedAt ?? 0)
      );

    for (const s of sorted) {
      const row = container.createEl("div", { cls: "ggai-session-row" });
      row.toggleClass("is-active", s.sessionFile === activeFile);

      // 세션 단위 즐겨찾기 — 노드 즐겨찾기와 별개로 저장된다.
      const fav = s.session.meta.favorite === true;
      const favBtn = row.createEl("button", { cls: "ggai-session-fav" });
      setIcon(favBtn, "star");
      favBtn.toggleClass("is-favorited", fav);
      favBtn.setAttr("aria-label", "세션 즐겨찾기");
      favBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.toggleSessionFavorite(s);
      });

      row.createEl("span", {
        cls: "ggai-session-name",
        text: s.session.meta.name || s.folderName,
      });
      const unread = this.plugin.getSessionUnread(s.sessionFile);
      if (unread) {
        row.createEl("span", {
          cls: "ggai-unread-badge",
          text: String(unread.count),
        });
      }
      const timeLabel = formatRelativeTime(
        s.session.meta.lastPlayedAt || s.session.meta.modifiedAt || s.session.meta.createdAt
      );
      if (timeLabel) {
        row.createEl("span", { cls: "ggai-session-time", text: timeLabel });
      }

      // ⋮ 메뉴 — 우클릭/롱프레스와 같은 메뉴를 항상 보이는 버튼으로.
      const moreBtn = row.createEl("button", { cls: "ggai-session-more" });
      setIcon(moreBtn, "more-vertical");
      moreBtn.setAttr("aria-label", "세션 메뉴");
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.sessionMenu(s).showAtMouseEvent(e);
      });

      row.addEventListener("click", (e) => {
        if (this.consumeSuppressedClick(e)) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest("button")) return;
        void this.openSession(s);
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showSessionMenu(e, s);
      });
      this.attachLongPressMenu(row, (x, y) => this.showSessionMenuAt(x, y, s));
    }
  }

  // --- actions (공용 로직은 entity-actions 경유) ---

  private triggerImport(): void {
    runImportPicker(this.plugin);
  }

  private triggerAddScenario(): void {
    promptNewScenario(this.plugin);
  }

  private triggerAddUser(): void {
    promptNewUser(this.plugin, async () => {
      await this.refreshAndRerenderUsers();
      await this.setTab("user");
    });
  }

  private triggerAddLorebook(): void {
    promptNewLorebook(this.plugin);
  }

  private async toggleScenarioFavorite(item: ScenarioListItem): Promise<void> {
    try {
      await this.store.toggleScenarioFavorite(item.scenarioFile);
    } catch (err) {
      new Notice(
        `즐겨찾기 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private showScenarioMenu(e: MouseEvent, item: ScenarioListItem): void {
    void this.makeScenarioMenu(item).then((menu) => menu.showAtMouseEvent(e));
  }

  private async makeScenarioMenu(item: ScenarioListItem): Promise<Menu> {
    const menu = new Menu()
      .addItem((menuItem) =>
        menuItem
          .setTitle(getFavorite(item) ? "즐겨찾기 해제" : "즐겨찾기")
          .onClick(() => void this.toggleScenarioFavorite(item))
      )
      .addItem((menuItem) =>
        menuItem.setTitle("편집").onClick(() => void this.openScenarioEditor(item))
      );
    // 그룹 초대 (G1) — 활성 세션이 있고 이 시나리오가 아직 멤버가 아닐 때만.
    const invite = await getInviteToActiveSession(this.plugin, item);
    if (invite) {
      menu.addItem((menuItem) =>
        menuItem
          .setTitle(invite.label)
          .setIcon("user-plus")
          .onClick(() => void invite.run())
      );
    }
    return menu.addSeparator().addItem((menuItem) =>
      menuItem.setTitle("삭제").onClick(() => this.confirmDelete(item))
    );
  }

  private async toggleSessionFavorite(s: SessionListItem): Promise<void> {
    try {
      await this.store.toggleSessionFavorite(s.sessionFile);
    } catch (err) {
      new Notice(
        `세션 즐겨찾기 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** 세션 공용 메뉴 — 항목 구성은 session-menu.ts 한 곳에서만 관리한다. */
  private sessionMenu(s: SessionListItem): Menu {
    return buildSessionMenu(this.plugin, s, {
      onRename: () => this.renameSession(s),
      onCopy: () => void this.copySession(s),
    });
  }

  private showSessionMenu(e: MouseEvent, s: SessionListItem): void {
    this.sessionMenu(s).showAtMouseEvent(e);
  }

  private renameSession(s: SessionListItem): void {
    promptRenameSession(this.plugin, s, async (oldFile, newFile) => {
      this.retargetSessionViews(oldFile, newFile);
      await this.refreshAndRerenderList();
    });
  }

  private showScenarioMenuAt(x: number, y: number, item: ScenarioListItem): void {
    void this.makeScenarioMenu(item).then((menu) => menu.showAtPosition({ x, y }));
  }

  private showSessionMenuAt(x: number, y: number, s: SessionListItem): void {
    this.sessionMenu(s).showAtPosition({ x, y });
  }

  private showLorebookMenu(e: MouseEvent, item: LorebookListItem): void {
    this.makeLorebookMenu(item).showAtMouseEvent(e);
  }

  private showLorebookMenuAt(x: number, y: number, item: LorebookListItem): void {
    this.makeLorebookMenu(item).showAtPosition({ x, y });
  }

  private makeLorebookMenu(item: LorebookListItem): Menu {
    return new Menu()
      .addItem((menuItem) =>
        menuItem.setTitle("편집").onClick(() => void this.openLorebookEditor(item))
      )
      .addSeparator()
      .addItem((menuItem) =>
        menuItem.setTitle("삭제").onClick(() => this.confirmDeleteLorebook(item))
      );
  }

  private showUserMenu(e: MouseEvent, item: UserListItem): void {
    this.makeUserMenu(item).showAtMouseEvent(e);
  }

  private showUserMenuAt(x: number, y: number, item: UserListItem): void {
    this.makeUserMenu(item).showAtPosition({ x, y });
  }

  private makeUserMenu(item: UserListItem): Menu {
    const menu = new Menu()
      .addItem((menuItem) =>
        menuItem
          .setTitle(item.profile.favorite ? "즐겨찾기 해제" : "즐겨찾기")
          .onClick(() => void this.toggleUserFavorite(item))
      )
      .addItem((menuItem) =>
        menuItem.setTitle("편집").onClick(() => void this.openUserEditorByPath(item.userFile))
      );
    if (item.profile.id !== "default") {
      menu
        .addSeparator()
        .addItem((menuItem) =>
          menuItem.setTitle("삭제").onClick(() => this.confirmDeleteUser(item))
        );
    }
    return menu;
  }

  private async toggleUserFavorite(item: UserListItem): Promise<void> {
    try {
      await this.store.toggleUserFavorite(item.userFile);
    } catch (err) {
      new Notice(
        `즐겨찾기 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private confirmDeleteUser(item: UserListItem): void {
    confirmDeleteUser(this.plugin, item);
  }

  private async copySession(s: SessionListItem): Promise<void> {
    try {
      const result = await this.store.copySession(s.sessionFile);
      await this.refreshAndRerenderList();
      await this.openSessionByPath(result.sessionFile);
      new Notice(`세션 복사: ${result.session.meta.name}`);
    } catch (err) {
      new Notice(`세션 복사 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async activateUser(item: UserListItem): Promise<void> {
    await this.plugin.selectActivePersona(item.userFile);
    this.renderListContents();
  }

  private attachContextMenu(
    el: HTMLElement,
    showMouse: (event: MouseEvent) => void,
    showPosition: (x: number, y: number) => void
  ): void {
    this.pressMenu.attachContextMenu(el, showMouse, showPosition);
  }

  private attachLongPressMenu(
    el: HTMLElement,
    showPosition: (x: number, y: number) => void
  ): void {
    this.pressMenu.attachLongPressMenu(el, showPosition);
  }

  private consumeSuppressedClick(e: MouseEvent): boolean {
    return this.pressMenu.consumeSuppressedClick(e);
  }

  private retargetSessionViews(oldFile: string, newFile: string): void {
    if (this.plugin.data.lastActiveSessionFile === oldFile) {
      void this.plugin.savePluginData({ lastActiveSessionFile: newFile });
    }
    for (const leaf of getSessionHostLeaves(this.app.workspace)) {
      const view = leaf.view as unknown as {
        getSessionFile?: () => string | null;
      };
      if (view.getSessionFile?.() !== oldFile) continue;
      const state =
        typeof leaf.view.getState === "function"
          ? (leaf.view.getState() as Record<string, unknown>)
          : {};
      void leaf.setViewState({
        type: leaf.view.getViewType(),
        state: { ...state, sessionFile: newFile },
      });
    }
  }

  private async openScenarioJson(item: ScenarioListItem): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(item.scenarioFile);
    if (file instanceof TFile) {
      await this.plugin.openStellaFile(file);
    } else {
      new Notice(`파일을 찾을 수 없습니다: ${item.scenarioFile}`);
    }
  }

  private async openScenarioEditor(item: ScenarioListItem): Promise<void> {
    await this.openScenarioEditorByPath(item.scenarioFile);
  }

  private async openScenarioEditorByPath(scenarioFile: string): Promise<void> {
    await this.plugin.openStellaEditor("scenario", scenarioFile);
  }

  private async openUserEditorByPath(userFile: string): Promise<void> {
    await this.plugin.openStellaEditor("user", userFile);
  }

  private confirmDelete(item: ScenarioListItem): void {
    confirmDeleteScenario(this.plugin, item);
  }

  private async handleScenarioSelect(item: ScenarioListItem): Promise<void> {
    if (this.expanded.has(item.folder)) {
      this.expanded.delete(item.folder);
      this.sessionsByFolder.delete(item.folder);
      this.renderListContents();
      return;
    }

    let sessions: SessionListItem[] = [];
    this.sessionsByFolder.clear();
    this.expanded.clear();
    this.expanded.add(item.folder);
    try {
      sessions = await this.store.getSessions(item.folder);
      this.sessionsByFolder.set(item.folder, sessions);
    } catch (err) {
      console.warn("[GGAI Stella] 세션 스캔 실패:", err);
      this.sessionsByFolder.set(item.folder, []);
    }
    this.renderListContents();
    const recent = this.getMostRecentSession(sessions);
    if (recent) {
      await this.openSession(recent);
      return;
    }
    this.triggerAddSession(item);
  }

  private getMostRecentSession(sessions: SessionListItem[]): SessionListItem | null {
    return (
      sessions
        .slice()
        .sort((a, b) => sessionRecentTime(b) - sessionRecentTime(a))[0] ?? null
    );
  }

  private triggerAddSession(item: ScenarioListItem): void {
    void createAndOpenSession(this.plugin, item, { mode: "ask" });
  }

  private async openSession(s: SessionListItem): Promise<void> {
    await this.openSessionByPath(s.sessionFile);
  }

  private async openSessionByPath(sessionFile: string): Promise<void> {
    await openSessionByPath(this.plugin, sessionFile);
  }

  // --- sort/filter ---

  private sortedFilteredItems(): ScenarioListItem[] {
    const q = this.searchQuery.trim().toLowerCase();
    const filtered = q
      ? this.items.filter((i) => {
          const n = (i.scenario.data.name ?? "").toLowerCase();
          const f = i.folderName.toLowerCase();
          const d = (i.scenario.data.description ?? "").toLowerCase();
          return n.includes(q) || f.includes(q) || d.includes(q);
        })
      : this.items.slice();

    filtered.sort(compareBy(this.sortKey));
    return filtered;
  }
}

function scenarioFileOfSessionFile(sessionFile: string): string | null {
  const parts = sessionFile.split("/");
  if (parts.length < 6 || parts[parts.length - 3] !== "SESSIONS") return null;
  return parts.slice(0, -3).join("/") + "/scenario.json";
}

// pure helpers 는 src/util/scenario-list-helpers.ts 로 이동 (대시보드와 공유).
