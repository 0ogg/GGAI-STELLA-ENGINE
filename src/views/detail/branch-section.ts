import { Notice, setIcon } from "obsidian";
import type StellaEnginePlugin from "../../main";
import type { SessionNode, StellaSession } from "../../types/session";
import {
  applyPatch,
  buildSpans,
  nodeOwnText,
  pathToLeaf,
  spansToText,
} from "../../util/session-text";
import {
  getChildren,
  getDeepestLatestDescendant,
  getFavoritedNodes,
} from "../../util/session-tree";
import {
  getActiveTranslation,
  tokenizeParagraphs,
} from "../../util/translate-paragraphs";
import type { SessionTranslations } from "../../types/media";

type BranchMode = "active" | "map" | "favorites";
type MapSortMode = "active" | "created";

const LABEL_MAX = 10; // ?몃뱶 移대뱶 ?쇰꺼 理쒕? 湲몄씠 (?ъ슜???붿껌: ??吏㏐쾶)

/**
 * BranchSection ???곗륫 ?ъ씠?쒕컮 [遺꾧린] ??
 *
 * ??紐⑤뱶:
 *  - "active": ?쒖꽦 寃쎈줈留??몃줈 ?쇱옄 + ?몃뱶 ?대┃ ???뷀뀒??移대뱶 ?몃씪??
 *  - "tree":   ?꾩껜 ?몃━瑜??ㅼ뿬?곌린 媛怨꾨룄濡? 源딆씠 = padding-left, ASCII ?몃━ ?쇱씤.
 *
 * ?꾧뎄諛? [?쒖꽦 寃쎈줈 | ?꾩껜 ?몃━] ?좉?, 寃??input, [??泥섏쓬] [???꾩옱] [???? ?ㅻ퉬.
 *
 * ?뷀뀒??移대뱶 (??紐⑤뱶 怨듯넻): 蹂몃Ц 誘몃━蹂닿린 + [?????몃뱶濡??대룞] + ??+ ?먯떇 紐⑸줉 ???먰봽.
 */
export class BranchSection {
  private root: HTMLElement;

  private activeSessionFile: string | null;
  private session: StellaSession | null = null;

  private mode: BranchMode = "active";
  private expandedNodeId: string | null = null;
  private searchQuery = "";
  private mapZoom = 0.72;
  private mapSortMode: MapSortMode = "active";
  private showTranslation = false;
  private translations: SessionTranslations | null = null;
  /** 맵 모드 최초 렌더에서 현재(마지막 플레이) 노드를 화면 중앙으로 스크롤. */
  private autoCenterCurrent = false;
  private pendingAutoCenter = false;

  private toolbarEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;

  constructor(
    container: HTMLElement,
    private plugin: StellaEnginePlugin,
    activeSessionFile: string | null,
    opts?: { initialMode?: BranchMode; autoCenterCurrent?: boolean }
  ) {
    this.root = container.createDiv({ cls: "ggai-branch-pane" });
    this.activeSessionFile = activeSessionFile;
    if (opts?.initialMode) this.mode = opts.initialMode;
    this.autoCenterCurrent = opts?.autoCenterCurrent === true;
    this.pendingAutoCenter = this.autoCenterCurrent;
    // 번역 표시는 전역 영속값에서 시작한다(다시 열어도 유지).
    this.showTranslation = plugin.data.branchShowTranslation === true;
  }

  async load(): Promise<void> {
    await this.loadSession();
    this.render();
  }

  setActiveSessionFile(file: string | null): void {
    this.activeSessionFile = file;
    this.expandedNodeId = null;
    void (async () => {
      await this.loadSession();
      this.render();
    })();
  }

  /** session-changed ?대깽?????몃━留??щ젋??(寃??input 蹂댁〈). */
  async refresh(): Promise<void> {
    if (!this.activeSessionFile) return;
    this.session = await this.plugin.store.getSession(this.activeSessionFile);
    this.translations = await this.plugin.store.getSessionTranslations(
      this.activeSessionFile
    );
    this.renderBody();
  }

  /** session-translations-changed 이벤트 — 번역만 다시 읽고 토글 상태/본문을 갱신. */
  async onTranslationsChanged(): Promise<void> {
    if (!this.activeSessionFile) return;
    this.translations = await this.plugin.store.getSessionTranslations(
      this.activeSessionFile
    );
    this.render();
  }

  private async loadSession(): Promise<void> {
    this.session = this.activeSessionFile
      ? await this.plugin.store.getSession(this.activeSessionFile)
      : null;
    this.translations = this.activeSessionFile
      ? await this.plugin.store.getSessionTranslations(this.activeSessionFile)
      : null;
  }

  // ??? render ?????????????????????????????????????????????

  private render(): void {
    this.root.empty();
    this.toolbarEl = null;
    this.bodyEl = null;
    this.searchInputEl = null;

    if (!this.activeSessionFile) {
      this.root.createDiv({
        cls: "ggai-detail-empty",
        text: "\uC5F4\uB9B0 \uC138\uC158\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.",
      });
      return;
    }
    if (!this.session) {
      this.root.createDiv({
        cls: "ggai-detail-empty",
        text: "\uC138\uC158\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
      });
      return;
    }

    this.renderToolbar();
    this.bodyEl = this.root.createDiv({ cls: "ggai-branch-body" });
    this.renderBody();
  }

  private renderToolbar(): void {
    const bar = this.root.createDiv({ cls: "ggai-branch-toolbar" });
    this.toolbarEl = bar;

    // 紐⑤뱶 ?좉?
    const modeWrap = bar.createDiv({ cls: "ggai-branch-mode-toggle" });
    const activeBtn = modeWrap.createEl("button", {
      cls: "ggai-branch-mode-btn",
      text: "\uD65C\uC131 \uACBD\uB85C",
    });
    const mapBtn = modeWrap.createEl("button", {
      cls: "ggai-branch-mode-btn",
      text: "\uC804\uCCB4",
    });
    const favBtn = modeWrap.createEl("button", {
      cls: "ggai-branch-mode-btn",
      text: "\uC990\uACA8\uCC3E\uAE30",
    });
    if (this.mode === "active") activeBtn.addClass("is-on");
    else if (this.mode === "map") mapBtn.addClass("is-on");
    else favBtn.addClass("is-on");
    activeBtn.addEventListener("click", () => this.switchMode("active"));
    mapBtn.addEventListener("click", () => this.switchMode("map"));
    favBtn.addEventListener("click", () => this.switchMode("favorites"));

    // ?ㅻ퉬 踰꾪듉
    if (this.mode !== "favorites") {
    const nav = bar.createDiv({ cls: "ggai-branch-nav" });
    const curBtn = nav.createEl("button", { cls: "ggai-btn ggai-btn-small", title: "\uD604\uC7AC \uB178\uB4DC\uB85C" });
    setIcon(curBtn, "target");
    curBtn.createSpan({ text: " \uD604\uC7AC \uB178\uB4DC" });
    curBtn.addEventListener("click", () => this.scrollToCurrent());

    // \uBC88\uC5ED \uD45C\uC2DC \uD1A0\uAE00 \u2014 \uC138\uC158\uC5D0 \uBC88\uC5ED \uBB38\uB2E8\uC774 \uC788\uC744 \uB54C\uB9CC \uD65C\uC131. \uCF1C\uBA74 \uD55C\uAE00 \uBC88\uC5ED\uC73C\uB85C \uD45C\uC2DC.
    const hasTranslations =
      !!this.translations &&
      Object.keys(this.translations.paragraphs).length > 0;
    const transBtn = nav.createEl("button", {
      cls: "ggai-btn ggai-btn-small",
      title: hasTranslations ? "\uBC88\uC5ED \uD45C\uC2DC \uCF1C\uAE30/\uB044\uAE30" : "\uBC88\uC5ED\uB41C \uBB38\uB2E8\uC774 \uC5C6\uC2B5\uB2C8\uB2E4",
    });
    setIcon(transBtn, "languages");
    transBtn.createSpan({ text: " \uBC88\uC5ED" });
    transBtn.toggleClass("is-on", this.showTranslation && hasTranslations);
    transBtn.disabled = !hasTranslations;
    transBtn.addEventListener("click", () => {
      this.showTranslation = !this.showTranslation;
      void this.plugin.savePluginData({
        branchShowTranslation: this.showTranslation,
      });
      this.render();
    });
    }

    // 寃??(?꾩껜 ?몃━ / 利먭꺼李얘린 紐⑤뱶)
    if (this.mode === "favorites") {
      const search = bar.createEl("input", {
        cls: "ggai-branch-search",
        type: "search",
      });
      search.placeholder = "\uB178\uB4DC \uAC80\uC0C9...";
      search.value = this.searchQuery;
      search.addEventListener("input", () => {
        this.searchQuery = search.value;
        this.renderBody();
      });
      this.searchInputEl = search;
    }
  }

  private switchMode(next: BranchMode): void {
    if (this.mode === next) return;
    this.mode = next;
    this.expandedNodeId = null;
    this.searchQuery = "";
    this.render();
  }

  private setMapSort(next: MapSortMode): void {
    if (this.mapSortMode === next) return;
    this.mapSortMode = next;
    this.renderBody();
  }

  /** 노드의 표시용 본문 — 번역 토글이 켜져 있으면 문단별 active 번역으로 치환. */
  private nodeDisplaySource(node: SessionNode): string {
    const raw = nodeOwnText(node);
    if (!this.showTranslation || !this.translations) return raw;
    return translateText(raw, this.translations);
  }

  private renderBody(): void {
    const body = this.bodyEl;
    const session = this.session;
    if (!body || !session) return;
    body.empty();

    const total = Object.keys(session.nodes).length;
    const favCount = getFavoritedNodes(session).length;
    // \uC9C0\uB3C4 \uBAA8\uB4DC\uB294 \uC138\uB85C \uC808\uC57D\uC744 \uC704\uD574 \uCE74\uC6B4\uD2B8 \uC904\uC744 \uC0DD\uB7B5\uD558\uACE0 \uCEE8\uD2B8\uB864 \uC904\uC5D0 \uD569\uCE5C\uB2E4.
    if (this.mode === "active") {
      body.createDiv({
        cls: "ggai-branch-count",
        text: "\uD65C\uC131 \uACBD\uB85C " + pathToLeaf(session, session.meta.activeLeafId).length + " / \uC804\uCCB4 " + total + "\uAC1C",
      });
    } else if (this.mode === "favorites") {
      body.createDiv({
        cls: "ggai-branch-count",
        text: "\uC990\uACA8\uCC3E\uAE30 " + favCount + "\uAC1C",
      });
    }

    if (this.mode === "active") this.renderActivePath(body, session);
    else if (this.mode === "map") this.renderTreeMap(body, session);
    else this.renderFavorites(body, session);

    // 지도 모드는 자기 뷰포트 안에서 직접 처리(renderTreeMap 내부) — 그 외 모드는
    // 여기서 몸통 스크롤을 현재 노드로 맞춘다. 레이아웃이 잡힌 뒤로 한 틱 미룬다.
    if (this.pendingAutoCenter && this.mode !== "map") {
      this.pendingAutoCenter = false;
      window.requestAnimationFrame(() => this.focusCurrentNode(false));
    }
  }

  // ??? 紐⑤뱶 3: 利먭꺼李얘린 ?됰㈃ 由ъ뒪???????????????????????

  private renderFavorites(parent: HTMLElement, session: StellaSession): void {
    const favorites = getFavoritedNodes(session);
    if (favorites.length === 0) {
      parent.createDiv({
        cls: "ggai-detail-empty",
        text: "\uC990\uACA8\uCC3E\uAE30\uD55C \uB178\uB4DC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.",
      });
      return;
    }
    const matchIds = this.computeSearchMatches(session);
    const filtered = matchIds
      ? favorites.filter((n) => matchIds.has(n.id))
      : favorites;
    if (filtered.length === 0) {
      parent.createDiv({
        cls: "ggai-detail-empty",
        text: "\uAC80\uC0C9 \uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.",
      });
      return;
    }
    const col = parent.createDiv({ cls: "ggai-bt-slots" });
    const path = pathToLeaf(session, session.meta.activeLeafId);
    for (const node of filtered) {
      const row = col.createDiv({ cls: "ggai-bt-slot-row" });
      this.renderFavoriteSlot(row, node, path);
      if (node.id === this.expandedNodeId) {
        const idx = path.findIndex((p) => p.id === node.id);
        this.renderDetailCard(row, node, idx, path);
      }
    }
  }

  /**
   * 즐겨찾기(세이브 포인트) 슬롯 — 활성 경로 칩과 다른, 묵직한 1줄 1개 카드.
   * 종류/깊이/시각/현재경로 여부 + 본문 미리보기 여러 줄 + [불러오기] 버튼.
   */
  private renderFavoriteSlot(
    parent: HTMLElement,
    node: SessionNode,
    path: SessionNode[]
  ): void {
    const session = this.session!;
    const isCurrent = node.id === session.meta.activeLeafId;
    const onActive = path.some((p) => p.id === node.id);
    const slot = parent.createDiv({ cls: "ggai-bt-slot" });
    slot.addClass(`is-${nodeAuthor(node)}`);
    if (onActive) slot.addClass("on-active");
    if (isCurrent) slot.addClass("is-current");
    if (node.id === this.expandedNodeId) slot.addClass("is-opened");

    const head = slot.createDiv({ cls: "ggai-bt-slot-head" });
    const star = head.createSpan({ cls: "ggai-bt-slot-star" });
    setIcon(star, "bookmark");
    head.createSpan({ cls: "ggai-bt-slot-kind", text: nodeKindLabel(node) });
    const depth = Math.max(0, pathToLeaf(session, node.id).length - 1);
    head.createSpan({ cls: "ggai-bt-slot-depth", text: `${depth}번째 노드` });
    head.createSpan({ cls: "ggai-bt-slot-spacer" });
    if (onActive) {
      head.createSpan({ cls: "ggai-bt-slot-badge", text: "현재 경로" });
    }
    head.createSpan({
      cls: "ggai-bt-slot-time",
      text: formatRelativeTime(node.createdAt),
    });

    slot.createDiv({
      cls: "ggai-bt-slot-preview",
      text: slotPreviewText(this.nodeDisplaySource(node)),
    });

    const foot = slot.createDiv({ cls: "ggai-bt-slot-foot" });
    const load = foot.createEl("button", {
      cls: "ggai-btn ggai-btn-primary ggai-bt-slot-load",
    });
    setIcon(load, isCurrent ? "check" : "download");
    load.createSpan({ text: isCurrent ? "현재 위치" : "이 세이브 불러오기" });
    load.disabled = isCurrent;
    load.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleJumpTo(node.id);
    });
    const detailBtn = foot.createEl("button", {
      cls: "ggai-btn ggai-btn-small",
    });
    detailBtn.createSpan({
      text: node.id === this.expandedNodeId ? "접기" : "자세히",
    });
    detailBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.expandedNodeId = this.expandedNodeId === node.id ? null : node.id;
      this.renderBody();
    });
  }

  // ??? 紐⑤뱶 1: ?쒖꽦 寃쎈줈 ?????????????????????????????????

  private renderActivePath(parent: HTMLElement, session: StellaSession): void {
    const path = pathToLeaf(session, session.meta.activeLeafId);
    if (path.length === 0) {
      parent.createDiv({ cls: "ggai-detail-empty", text: "\uD65C\uC131 \uACBD\uB85C\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." });
      return;
    }
    const col = parent.createDiv({ cls: "ggai-bt-col" });
    path.forEach((node, idx) => {
      const row = col.createDiv({ cls: "ggai-bt-row on-active" });
      this.renderNodeCard(row, node, true);
      if (node.id === this.expandedNodeId) {
        this.renderDetailCard(row, node, idx, path);
      }
    });
  }

  // ??? 紐⑤뱶 2: ?꾩껜 ?몃━ (?ㅼ뿬?곌린 媛怨꾨룄) ???????????????

  private renderTreeMap(parent: HTMLElement, session: StellaSession): void {
    const rootId = session.meta.rootId;
    if (!rootId || !session.nodes[rootId]) {
      parent.createDiv({ cls: "ggai-detail-empty", text: "\uB8E8\uD2B8 \uB178\uB4DC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." });
      return;
    }

    const activePath = pathToLeaf(session, session.meta.activeLeafId);
    const activeIds = new Set(activePath.map((n) => n.id));
    // 현재 노드 라인을 맵 맨 앞(왼쪽) 열로 고정: 부모 → 활성 경로 자식 매핑.
    const activeChildOf = new Map<string, string>();
    for (let i = 0; i < activePath.length - 1; i++) {
      activeChildOf.set(activePath[i].id, activePath[i + 1].id);
    }
    const layout = buildTreeMapLayout(
      session,
      rootId,
      this.mapSortMode === "active" ? activeChildOf : undefined
    );
    if (layout.items.length === 0) {
      parent.createDiv({ cls: "ggai-detail-empty", text: "\uD45C\uC2DC\uD560 \uB178\uB4DC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." });
      return;
    }

    // \uC815\uB82C \uD1A0\uAE00 + \uCE74\uC6B4\uD2B8 (\uCE74\uC6B4\uD2B8 \uC904\uC744 \uB530\uB85C \uB450\uC9C0 \uC54A\uACE0 \uC5EC\uAE30 \uD569\uCCD0 \uC138\uB85C \uC808\uC57D)
    const sortRow = parent.createDiv({ cls: "ggai-bt-map-sortrow" });
    const sortWrap = sortRow.createDiv({ cls: "ggai-branch-mode-toggle ggai-bt-map-sort" });
    const activeSortBtn = sortWrap.createEl("button", {
      cls: "ggai-branch-mode-btn",
      text: "\uD604\uC7AC \uB77C\uC778",
    });
    const createdSortBtn = sortWrap.createEl("button", {
      cls: "ggai-branch-mode-btn",
      text: "\uC0DD\uC131\uC21C",
    });
    activeSortBtn.toggleClass("is-on", this.mapSortMode === "active");
    createdSortBtn.toggleClass("is-on", this.mapSortMode === "created");
    activeSortBtn.addEventListener("click", () => this.setMapSort("active"));
    createdSortBtn.addEventListener("click", () => this.setMapSort("created"));
    sortRow.createSpan({
      cls: "ggai-bt-map-count",
      text: Object.keys(session.nodes).length + "\uAC1C",
    });

    const controls = parent.createDiv({ cls: "ggai-bt-map-controls" });
    const zoomOut = controls.createEl("button", {
      cls: "ggai-btn ggai-btn-small",
      text: "-",
    });
    const range = controls.createEl("input", {
      cls: "ggai-bt-map-zoom",
      type: "range",
    });
    range.min = "35";
    range.max = "130";
    range.step = "5";
    range.value = String(Math.round(this.mapZoom * 100));
    const zoomIn = controls.createEl("button", {
      cls: "ggai-btn ggai-btn-small",
      text: "+",
    });
    const centerBtn = controls.createEl("button", {
      cls: "ggai-btn ggai-btn-small",
      title: "\uD604\uC7AC \uB178\uB4DC \uC911\uC559\uC73C\uB85C",
    });
    setIcon(centerBtn, "target");
    const zoomLabel = controls.createSpan({
      cls: "ggai-bt-map-zoom-label",
      text: `${Math.round(this.mapZoom * 100)}%`,
    });

    const legend = parent.createDiv({ cls: "ggai-bt-map-legend" });
    legend.createSpan({ cls: "ggai-bt-map-legend-item ggai-bt-map-legend-ai", text: "AI" });
    legend.createSpan({ cls: "ggai-bt-map-legend-item ggai-bt-map-legend-user", text: "\uC218\uC815" });
    legend.createSpan({ cls: "ggai-bt-map-legend-item ggai-bt-map-legend-regen", text: "\uC7AC\uC0DD\uC131" });
    legend.createSpan({ cls: "ggai-bt-map-legend-item ggai-bt-map-legend-active", text: "\uD604\uC7AC \uACBD\uB85C" });

    const viewport = parent.createDiv({ cls: "ggai-bt-map-viewport" });
    const inner = viewport.createDiv({ cls: "ggai-bt-map-inner" });
    inner.style.width = `${layout.width}px`;
    inner.style.height = `${layout.height}px`;

    const applyZoom = () => {
      inner.style.transform = `scale(${this.mapZoom})`;
      zoomLabel.textContent = `${Math.round(this.mapZoom * 100)}%`;
      range.value = String(Math.round(this.mapZoom * 100));
    };

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("ggai-bt-map-svg");
    svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    svg.setAttribute("width", String(layout.width));
    svg.setAttribute("height", String(layout.height));
    inner.appendChild(svg);

    const byId = new Map(layout.items.map((item) => [item.node.id, item]));
    for (const item of layout.items) {
      for (const childId of item.childIds) {
        const child = byId.get(childId);
        if (!child) continue;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const x1 = item.x + MAP_NODE_W / 2;
        const y1 = item.y + MAP_NODE_H;
        const x2 = child.x + MAP_NODE_W / 2;
        const y2 = child.y;
        const mid = y1 + Math.max(28, (y2 - y1) / 2);
        line.setAttribute("d", `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`);
        line.classList.add("ggai-bt-map-line");
        if (activeIds.has(item.node.id) && activeIds.has(childId)) {
          line.classList.add("is-active");
        }
        svg.appendChild(line);
      }
    }

    for (const item of layout.items) {
      const node = item.node;
      const card = inner.createDiv({ cls: "ggai-bt-map-node" });
      card.style.left = `${item.x}px`;
      card.style.top = `${item.y}px`;
      card.style.width = `${MAP_NODE_W}px`;
      card.style.minHeight = `${MAP_NODE_H}px`;
      if (activeIds.has(node.id)) card.addClass("is-active");
      if (node.id === session.meta.activeLeafId) {
        card.addClass("is-current");
        card.dataset.anchor = "current";
      }
      if (node.id === this.expandedNodeId) card.addClass("is-opened");
      card.addClass(`is-${nodeAuthor(node)}`);
      if (node.kind === "ai-regen") card.addClass("is-regen");

      const ownText = this.nodeDisplaySource(node);
      const top = card.createDiv({ cls: "ggai-bt-map-node-top" });
      top.createSpan({ cls: "ggai-bt-map-kind", text: nodeKindShort(node) });
      top.createSpan({ cls: "ggai-bt-map-label", text: labelFromText(node, ownText, 8) });
      if (node.favorite) {
        const star = top.createSpan({ cls: "ggai-bt-map-star" });
        setIcon(star, "star");
      }

      const preview = previewFromText(ownText, 26);
      if (preview) {
        card.createDiv({ cls: "ggai-bt-map-preview", text: preview });
      }

      card.addEventListener("click", () => {
        this.expandedNodeId = this.expandedNodeId === node.id ? null : node.id;
        this.renderBody();
      });
    }

    applyZoom();

    const setZoom = (next: number) => {
      this.mapZoom = Math.max(0.35, Math.min(1.3, next));
      applyZoom();
    };
    zoomOut.addEventListener("click", () => setZoom(this.mapZoom - 0.1));
    zoomIn.addEventListener("click", () => setZoom(this.mapZoom + 0.1));
    range.addEventListener("input", () => setZoom(Number(range.value) / 100));
    centerBtn.addEventListener("click", () => {
      const cur = viewport.querySelector('[data-anchor="current"]');
      if (cur instanceof HTMLElement) {
        cur.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      }
    });

    // 최초 진입 시 현재(마지막 플레이) 노드를 화면 중앙으로 — 레이아웃이 잡힌 뒤.
    if (this.pendingAutoCenter) {
      this.pendingAutoCenter = false;
      window.requestAnimationFrame(() => {
        const cur = viewport.querySelector('[data-anchor="current"]');
        if (cur instanceof HTMLElement) {
          cur.scrollIntoView({ block: "center", inline: "center" });
        }
      });
    }

    if (this.expandedNodeId && session.nodes[this.expandedNodeId]) {
      const path = pathToLeaf(session, session.meta.activeLeafId);
      const idx = path.findIndex((n) => n.id === this.expandedNodeId);
      this.renderDetailCard(parent, session.nodes[this.expandedNodeId], idx, path);
    }
  }

  private renderNodeCard(parent: HTMLElement, node: SessionNode, onActive: boolean): void {
    const session = this.session!;
    const isCurrent = node.id === session.meta.activeLeafId;
    const isMatch = false;
    const card = this.makeNodeCardEl(node, session, onActive, isCurrent, isMatch);
    parent.appendChild(card);
  }

  private makeNodeCardEl(
    node: SessionNode,
    session: StellaSession,
    onActive: boolean,
    isCurrent: boolean,
    isMatch: boolean
  ): HTMLElement {
    const card = document.createElement("div");
    card.classList.add("ggai-bt-node");
    if (onActive) card.classList.add("on-active");
    if (isCurrent) card.classList.add("is-current");
    if (node.id === this.expandedNodeId) card.classList.add("is-opened");
    if (isMatch) card.classList.add("is-match");
    if (isCurrent) card.dataset.anchor = "current";

    const author = nodeAuthor(node);
    const authorEl = document.createElement("span");
    authorEl.className = `ggai-bt-author ggai-bt-author-${author}`;
    authorEl.textContent = author;
    card.appendChild(authorEl);

    const labelEl = document.createElement("span");
    labelEl.className = "ggai-bt-label";
    labelEl.textContent = labelFromText(node, this.nodeDisplaySource(node), LABEL_MAX);
    card.appendChild(labelEl);

    if (node.favorite) {
      const star = document.createElement("span");
      star.className = "ggai-bt-star";
      star.textContent = "*";
      card.appendChild(star);
    }
    if (isCurrent) {
      const cur = document.createElement("span");
      cur.className = "ggai-bt-current-mark";
      cur.textContent = "current";
      card.appendChild(cur);
    }

    const childCount = getChildren(session, node.id).length;
    if (childCount > 0) {
      const badge = document.createElement("span");
      badge.className = "ggai-bt-branch-badge";
      badge.textContent = "+" + childCount;
      card.appendChild(badge);
    }

    card.addEventListener("click", () => {
      this.expandedNodeId = this.expandedNodeId === node.id ? null : node.id;
      this.renderBody();
    });

    return card;
  }

  private renderDetailCard(
    parent: HTMLElement,
    node: SessionNode,
    idxInPath: number,
    path: SessionNode[]
  ): void {
    const session = this.session!;
    const detail = parent.createDiv({ cls: "ggai-bt-detail" });

    const head = detail.createDiv({ cls: "ggai-bt-detail-header" });
    const own = nodeOwnText(node);
    const removed = removedCharCount(node);
    const sizeLabel =
      own.length === 0 && removed > 0
        ? `${removed}\uC790 \uC0AD\uC81C`
        : own.length + "\uC790";
    head.createSpan({
      cls: "ggai-bt-detail-meta",
      text: nodeKindLabel(node) + " - " + formatRelativeTime(node.createdAt) + " - " + sizeLabel,
    });
    const closeEl = head.createEl("button", {
      cls: "ggai-bt-detail-close ggai-icon-btn",
    });
    setIcon(closeEl, "x");
    closeEl.setAttr("aria-label", "상세 닫기");
    closeEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.expandedNodeId = null;
      this.renderBody();
    });

    const body = detail.createDiv({ cls: "ggai-bt-detail-body" });
    if (own.length === 0 && removed > 0) {
      // \uC0AD\uC81C \uB178\uB4DC \u2014 \uBD80\uBAA8 \uBCF8\uBB38\uC5D0\uC11C \uC2E4\uC81C\uB85C \uC9C0\uC6CC\uC9C4 \uB0B4\uC6A9\uC744 \uBCF4\uC5EC\uC900\uB2E4.
      body.textContent = "[\uC0AD\uC81C\uB41C \uB0B4\uC6A9]\n" + deletedTextOf(session, node);
    } else {
      body.textContent = nodeDetailText(this.nodeDisplaySource(node), "(\uBE44\uC5B4 \uC788\uB294 \uB178\uB4DC)");
    }

    const actions = detail.createDiv({ cls: "ggai-bt-detail-actions" });
    const isCurrent = node.id === session.meta.activeLeafId;
    const jumpBtn = actions.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: isCurrent ? "\uD604\uC7AC \uB178\uB4DC" : "\uC774 \uB178\uB4DC\uB85C \uC774\uB3D9",
    });
    jumpBtn.disabled = isCurrent;
    jumpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleJumpTo(node.id);
    });

    // 분기는 그대로 두고 열린 세션창을 이 노드 위치로 스크롤만 보낸다.
    const scrollBtn = actions.createEl("button", {
      cls: "ggai-btn ggai-icon-btn",
    });
    setIcon(scrollBtn, "locate-fixed");
    scrollBtn.title = "이 위치로 스크롤 (분기 유지)";
    scrollBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.handleScrollToNode(node.id);
    });

    // 이 노드에 삽화 생성.
    const illusBtn = actions.createEl("button", {
      cls: "ggai-btn ggai-icon-btn",
    });
    setIcon(illusBtn, "image");
    illusBtn.title = "이 노드에 삽화 생성";
    illusBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleGenerateIllustration(node.id);
    });

    const favBtn = actions.createEl("button", {
      cls: "ggai-btn ggai-icon-btn ggai-bt-detail-fav",
    });
    setIcon(favBtn, "star");
    favBtn.toggleClass("is-favorited", node.favorite === true);
    favBtn.title = "\uC990\uACA8\uCC3E\uAE30";
    favBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleToggleNodeFavorite(node.id);
    });

    // ?먯떇 紐⑸줉
    const destructiveActions = detail.createDiv({ cls: "ggai-bt-danger-actions" });
    const descendantCount = countDescendants(session, node.id);
    const deleteChildrenBtn = destructiveActions.createEl("button", {
      cls: "ggai-btn ggai-btn-small ggai-btn-danger",
      text: "\uD558\uC704 \uB77C\uC778 \uC0AD\uC81C",
    });
    deleteChildrenBtn.disabled = descendantCount === 0;
    deleteChildrenBtn.title =
      descendantCount === 0
        ? "\uC0AD\uC81C\uD560 \uD558\uC704 \uB178\uB4DC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4."
        : String(descendantCount) + "\uAC1C\uC758 \uD558\uC704 \uB178\uB4DC\uAC00 \uC0AD\uC81C\uB429\uB2C8\uB2E4.";
    deleteChildrenBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleDeleteDescendants(node.id);
    });

    const keepLineBtn = destructiveActions.createEl("button", {
      cls: "ggai-btn ggai-btn-small ggai-btn-danger",
      text: "\uC774 \uB77C\uC778\uB9CC \uB0A8\uAE30\uAE30",
    });
    keepLineBtn.title = "\uB8E8\uD2B8\uBD80\uD130 \uC774 \uB178\uB4DC\uAE4C\uC9C0\uC758 \uACBD\uB85C\uB9CC \uB0A8\uAE41\uB2C8\uB2E4.";
    keepLineBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleKeepOnlyLine(node.id);
    });

    const children = getChildren(session, node.id);
    const activeChildId = idxInPath >= 0 ? path[idxInPath + 1]?.id ?? null : null;
    if (children.length > 0) {
      const childWrap = detail.createDiv({ cls: "ggai-bt-children" });
      childWrap.createDiv({
        cls: "ggai-bt-children-title",
        text: "\uD558\uC704 \uB178\uB4DC (" + children.length + ")",
      });
      for (const child of children) this.renderChildRow(childWrap, child, activeChildId);
    }
  }

  private renderChildRow(
    parent: HTMLElement,
    child: SessionNode,
    activeChildId: string | null
  ): void {
    const session = this.session!;
    const isActive = child.id === activeChildId;
    const row = parent.createDiv({ cls: "ggai-bt-child-row" });
    if (isActive) row.addClass("is-active");

    row.createSpan({
      cls: "ggai-bt-child-dot" + (isActive ? " is-active" : ""),
    });
    const text = labelFromText(child, this.nodeDisplaySource(child), LABEL_MAX) || "(\uBE44\uC5B4 \uC788\uC74C)";
    const textEl = row.createSpan({ cls: "ggai-bt-child-text" });
    textEl.textContent = text + (child.favorite ? " *" : "");

    const grandCount = getChildren(session, child.id).length;
    const metaText = isActive ? "\uD65C\uC131" : grandCount > 0 ? "+" + grandCount : "";
    if (metaText) row.createSpan({ cls: "ggai-bt-child-meta", text: metaText });

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleJumpToChild(child.id);
    });
  }

  // ??? ?≪뀡 ??????????????????????????????????????????????

  private async handleJumpTo(nodeId: string): Promise<void> {
    const file = this.activeSessionFile;
    const session = this.session;
    if (!file || !session) return;
    if (session.meta.activeLeafId === nodeId) return;
    if (!session.nodes[nodeId]) return;
    try {
      session.meta.activeLeafId = nodeId;
      await this.plugin.store.saveSession(file, session);
    } catch (err) {
      new Notice("\uC774\uB3D9 \uC2E4\uD328: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  private async handleJumpToChild(childId: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const deepest = getDeepestLatestDescendant(session, childId);
    await this.handleJumpTo(deepest ? deepest.id : childId);
  }

  /** 분기는 유지한 채 열린 세션창을 이 노드 위치로 스크롤만 보낸다. */
  private handleScrollToNode(nodeId: string): void {
    const file = this.activeSessionFile;
    if (!file) return;
    const ok = this.plugin.scrollOpenSessionToNode(file, nodeId);
    if (!ok) {
      new Notice(
        "이 노드가 활성 경로에 없거나 세션창이 열려 있지 않습니다. '이 노드로 이동'으로 먼저 전환하세요."
      );
    }
  }

  /** 이 노드에 삽화를 생성한다 (세션창의 자동/툴바 생성과 같은 실행기). */
  private async handleGenerateIllustration(nodeId: string): Promise<void> {
    const file = this.activeSessionFile;
    if (!file) return;
    if (!this.plugin.ai.isAvailable()) {
      new Notice("GGAI Core 가 설치/활성화되어 있지 않습니다.");
      return;
    }
    new Notice("삽화 생성 중…");
    const result = await this.plugin.illustration.generateForNode(file, nodeId);
    if (!result.ok) {
      new Notice("삽화 생성 실패: " + (result.errors[0] ?? "알 수 없는 오류"));
    } else {
      new Notice("삽화를 생성했습니다.");
    }
  }

  private async handleToggleNodeFavorite(nodeId: string): Promise<void> {
    const file = this.activeSessionFile;
    if (!file) return;
    try {
      await this.plugin.store.toggleNodeFavorite(file, nodeId);
    } catch (err) {
      new Notice("\uC990\uACA8\uCC3E\uAE30 \uBCC0\uACBD \uC2E4\uD328: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ??? ?ㅻ퉬/寃??????????????????????????????????????????

  private async handleDeleteDescendants(nodeId: string): Promise<void> {
    const file = this.activeSessionFile;
    const session = this.session;
    if (!file || !session || !session.nodes[nodeId]) return;

    const deleteIds = collectDescendantIds(session, nodeId);
    if (deleteIds.length === 0) {
      new Notice("\uC0AD\uC81C\uD560 \uD558\uC704 \uB178\uB4DC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
      return;
    }

    const confirmed = window.confirm(
      "\uC120\uD0DD\uD55C \uB178\uB4DC \uC544\uB798\uC758 \uD558\uC704 \uB178\uB4DC " + deleteIds.length + "\uAC1C\uB97C \uC0AD\uC81C\uD560\uAE4C\uC694?"
    );
    if (!confirmed) return;

    try {
      for (const id of deleteIds) delete session.nodes[id];
      session.meta.activeLeafId = nodeId;
      this.expandedNodeId = nodeId;
      await this.plugin.store.saveSession(file, session);
      new Notice("\uD558\uC704 \uB178\uB4DC " + deleteIds.length + "\uAC1C\uB97C \uC0AD\uC81C\uD588\uC2B5\uB2C8\uB2E4.");
    } catch (err) {
      new Notice("\uD558\uC704 \uB77C\uC778 \uC0AD\uC81C \uC2E4\uD328: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  private async handleKeepOnlyLine(nodeId: string): Promise<void> {
    const file = this.activeSessionFile;
    const session = this.session;
    if (!file || !session || !session.nodes[nodeId]) return;

    const keepIds = new Set(pathToLeaf(session, nodeId).map((node) => node.id));
    if (!keepIds.has(session.meta.rootId)) {
      new Notice("\uC120\uD0DD\uD55C \uB178\uB4DC\uC758 \uB8E8\uD2B8 \uACBD\uB85C\uB97C \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      return;
    }

    const deleteIds = Object.keys(session.nodes).filter((id) => !keepIds.has(id));
    if (deleteIds.length === 0) {
      new Notice("\uC774\uBBF8 \uC774 \uB77C\uC778\uB9CC \uB0A8\uC544 \uC788\uC2B5\uB2C8\uB2E4.");
      return;
    }

    const confirmed = window.confirm(
      "\uB8E8\uD2B8\uBD80\uD130 \uC120\uD0DD\uD55C \uB178\uB4DC\uAE4C\uC9C0\uC758 \uACBD\uB85C\uB9CC \uB0A8\uAE30\uACE0 \uB098\uBA38\uC9C0 " + deleteIds.length + "\uAC1C \uB178\uB4DC\uB97C \uC0AD\uC81C\uD560\uAE4C\uC694?"
    );
    if (!confirmed) return;

    try {
      for (const id of deleteIds) delete session.nodes[id];
      session.meta.activeLeafId = nodeId;
      this.expandedNodeId = nodeId;
      await this.plugin.store.saveSession(file, session);
      new Notice("\uC774 \uB77C\uC778\uB9CC \uB0A8\uAE30\uACE0 " + deleteIds.length + "\uAC1C \uB178\uB4DC\uB97C \uC0AD\uC81C\uD588\uC2B5\uB2C8\uB2E4.");
    } catch (err) {
      new Notice("\uC774 \uB77C\uC778\uB9CC \uB0A8\uAE30\uAE30 \uC2E4\uD328: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  private scrollToCurrent(): void {
    this.focusCurrentNode(true);
  }

  /** 현재(활성 리프) 노드로 스크롤 — 최초 진입 시엔 instant, 버튼 클릭 시엔 smooth. */
  private focusCurrentNode(smooth: boolean): void {
    const body = this.bodyEl;
    if (!body) return;
    const cur = body.querySelector('[data-anchor="current"]');
    if (cur instanceof HTMLElement) {
      cur.scrollIntoView(
        smooth
          ? { behavior: "smooth", block: "center", inline: "center" }
          : { block: "center", inline: "center" }
      );
    }
  }

  private computeSearchMatches(session: StellaSession): Set<string> | null {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return null;
    const matches = new Set<string>();
    for (const node of Object.values(session.nodes)) {
      const text = (node.label ?? "") + " " + nodeOwnText(node);
      if (text.toLowerCase().includes(q)) matches.add(node.id);
    }
    return matches;
  }

  /** matchIds 媛 ?덈뒗 寃쎌슦, 洹??몃뱶???먯넀 以묒뿉 留ㅼ튂媛 ?덉쑝硫?true (?꾪꽣留곸슜 ?먯넀 蹂댁〈). */
}

// ??? helpers ??????????????????????????????????????????????

const MAP_NODE_W = 86;
const MAP_NODE_H = 40;
const MAP_X_GAP = 118;
const MAP_Y_GAP = 86;
const MAP_PAD = 18;
const MAP_COLUMN_W = Math.max(MAP_X_GAP, MAP_NODE_W + 24);

interface TreeMapItem {
  node: SessionNode;
  x: number;
  y: number;
  childIds: string[];
}

function buildTreeMapLayout(
  session: StellaSession,
  rootId: string,
  activeChildOf?: Map<string, string>
): { items: TreeMapItem[]; width: number; height: number } {
  const items: TreeMapItem[] = [];
  const rows: string[][] = [];
  const seen = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    const node = session.nodes[id];
    if (!node || seen.has(id)) continue;
    seen.add(id);

    if (!rows[depth]) rows[depth] = [];
    rows[depth].push(id);

    const children = orderActiveFirst(getChildren(session, id), activeChildOf?.get(id));
    for (const child of children) {
      queue.push({ id: child.id, depth: depth + 1 });
    }
  }

  let maxRowCount = 0;
  for (let depth = 0; depth < rows.length; depth++) {
    const row = rows[depth] ?? [];
    maxRowCount = Math.max(maxRowCount, row.length);

    for (let column = 0; column < row.length; column++) {
      const nodeId = row[column];
      const node = session.nodes[nodeId];
      if (!node) continue;
      const children = getChildren(session, nodeId);
      items.push({
        node,
        x: column * MAP_COLUMN_W + MAP_PAD,
        y: depth * MAP_Y_GAP + MAP_PAD,
        childIds: children.map((child) => child.id),
      });
    }
  }

  return {
    items,
    width: Math.max(
      320,
      (Math.max(1, maxRowCount) - 1) * MAP_COLUMN_W + MAP_NODE_W + MAP_PAD * 2
    ),
    height: Math.max(240, rows.length * MAP_Y_GAP + MAP_NODE_H + MAP_PAD),
  };
}

/** 활성 경로 자식을 맨 앞으로 — BFS 열 배치에서 현재 라인이 왼쪽 열에 고정된다. */
function orderActiveFirst(
  children: SessionNode[],
  activeChildId: string | undefined
): SessionNode[] {
  if (!activeChildId) return children;
  const idx = children.findIndex((c) => c.id === activeChildId);
  if (idx <= 0) return children;
  const copy = children.slice();
  const [active] = copy.splice(idx, 1);
  copy.unshift(active);
  return copy;
}

function collectDescendantIds(session: StellaSession, nodeId: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const stack = getChildren(session, nodeId).map((node) => node.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    for (const child of getChildren(session, id)) stack.push(child.id);
  }
  return ids;
}

function countDescendants(session: StellaSession, nodeId: string): number {
  return collectDescendantIds(session, nodeId).length;
}

function nodeAuthor(node: SessionNode): "root" | "ai" | "user" {
  if (node.kind === "root") return "root";
  if (node.kind === "ai-continue" || node.kind === "ai-regen") return "ai";
  return "user";
}

function nodeKindShort(node: SessionNode): string {
  if (node.kind === "root") return "R";
  if (node.kind === "ai-continue") return "A";
  if (node.kind === "ai-regen") return "G";
  return "U";
}

function nodeKindLabel(node: SessionNode): string {
  if (node.kind === "root") return "\uB8E8\uD2B8";
  if (node.kind === "ai-continue") return "AI \uC774\uC5B4\uC4F0\uAE30";
  if (node.kind === "ai-regen") return "AI \uC7AC\uC0DD\uC131";
  if (node.kind === "user-write") return "\uC0AC\uC6A9\uC790 \uC791\uC131";
  return "\uC0AC\uC6A9\uC790 \uC218\uC815";
}

function nodeLabelOf(node: SessionNode, max: number): string {
  return labelFromText(node, nodeOwnText(node), max);
}

/** nodeLabelOf \uC640 \uB3D9\uC77C\uD558\uB418 \uBCF8\uBB38 \uD14D\uC2A4\uD2B8\uB97C \uC678\uBD80\uC5D0\uC11C \uC8FC\uC785 (\uBC88\uC5ED\uBCF8 \uD45C\uC2DC\uC6A9). */
function labelFromText(node: SessionNode, ownText: string, max: number): string {
  if (node.label) return node.label;
  if (node.kind === "root") return "\uB8E8\uD2B8";
  const own = previewFromText(ownText, max);
  return own || emptyNodeLabel(node);
}

/** \uC138\uC774\uBE0C \uC2AC\uB86F \uBBF8\uB9AC\uBCF4\uAE30 \u2014 \uC5EC\uB7EC \uC904 \uD074\uB7A8\uD504\uC6A9 \uAE34 \uBBF8\uB9AC\uBCF4\uAE30(\uACF5\uBC31 \uC815\uADDC\uD654, ~200\uC790). */
function slotPreviewText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "(\uBE44\uC5B4 \uC788\uB294 \uB178\uB4DC)";
  return t.length > 200 ? t.slice(0, 200) + "\u2026" : t;
}

/** \uBCF8\uBB38 \uD14D\uC2A4\uD2B8 \u2192 \uD55C \uC904 \uBBF8\uB9AC\uBCF4\uAE30 (truncate). */
function previewFromText(text: string, max: number): string {
  const own = nodeDisplayText(text, "");
  return own.length > max ? own.slice(0, max) + "..." : own;
}

/** \uBB38\uB2E8\uBCC4 active \uBC88\uC5ED\uC73C\uB85C \uBCF8\uBB38\uC744 \uC7AC\uAD6C\uC131 (\uAD6C\uBD84\uC790/\uBBF8\uBC88\uC5ED \uBB38\uB2E8\uC740 \uC6D0\uBB38 \uC720\uC9C0). */
function translateText(text: string, translations: SessionTranslations): string {
  if (!text) return text;
  return tokenizeParagraphs(text)
    .map((t) =>
      t.kind === "separator"
        ? t.text
        : getActiveTranslation(translations, t.hash)?.text ?? t.source
    )
    .join("");
}

/** \uBCF8\uBB38\uC774 \uBE44\uB294 \uB178\uB4DC\uC758 \uC0AC\uC720 \uD45C\uC2DC \u2014 \uC0AD\uC81C\uC640 \uB2E8\uC21C \uBE48 \uB178\uB4DC\uB97C \uAD6C\uBD84\uD55C\uB2E4. */
function emptyNodeLabel(node: SessionNode): string {
  const removed = removedCharCount(node);
  if (removed > 0) return `(${removed}\uC790 \uC0AD\uC81C)`;
  return "(\uBE44\uC5B4 \uC788\uC74C)";
}

/** \uC774 \uB178\uB4DC\uC758 \uD328\uCE58\uAC00 \uBD80\uBAA8 \uBCF8\uBB38\uC5D0\uC11C \uC9C0\uC6B4 \uAE00\uC790 \uC218 (delete + replace \uC758 \uB300\uCCB4 \uAD6C\uAC04). */
function removedCharCount(node: SessionNode): number {
  let n = 0;
  for (const p of node.patches) {
    if (p.op === "delete" || p.op === "replace") n += p.to - p.from;
  }
  return n;
}

/** delete/replace \uD328\uCE58\uAC00 \uC2E4\uC81C\uB85C \uC9C0\uC6B4 \uD14D\uC2A4\uD2B8 \u2014 \uBD80\uBAA8 \uBCF8\uBB38\uC744 \uC7AC\uAD6C\uC131\uD574 \uC798\uB77C\uB0B8\uB2E4. */
function deletedTextOf(session: StellaSession, node: SessionNode): string {
  if (node.parent == null) return "";
  let spans = buildSpans(session, node.parent);
  const parts: string[] = [];
  for (const patch of node.patches) {
    if (patch.op === "delete" || patch.op === "replace") {
      const text = spansToText(spans);
      const removed = text.slice(patch.from, patch.to);
      if (removed) parts.push(removed);
    }
    spans = applyPatch(spans, patch);
  }
  return parts.join("");
}

function nodeDisplayText(text: string, emptyLabel: string): string {
  if (text.length === 0) return emptyLabel;
  // 보이는 글자 없이 공백/줄바꿈만 삽입된 노드는 사유를 명시.
  if (!text.trim()) {
    const newlines = (text.match(/\r\n|\r|\n/g) ?? []).length;
    if (newlines > 0) return `(줄바꿈 ${newlines}개)`;
    return "(공백만 있음)";
  }
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // 맨 앞 줄바꿈은 마커(\n)로 그리지 않고 버린다 — AI 노드가 보통 "\n\n"으로
    // 시작해 미리보기 맨 앞에 불필요한 "\n" 이 붙어 보이던 문제.
    .replace(/^\n+/, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n/g, " \\n ")
    .trim();
}

function nodeDetailText(text: string, emptyLabel: string): string {
  const trimmed = text.trim();
  return trimmed || nodeDisplayText(text, emptyLabel);
}

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "\uBC29\uAE08";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "\uBD84 \uC804";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "\uC2DC\uAC04 \uC804";
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + "\uC77C \uC804";
  return new Date(epochMs).toISOString().slice(0, 10);
}
