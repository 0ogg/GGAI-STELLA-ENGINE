import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_ILLUSTRATION_OUTPUT } from "../constants";
import type StellaEnginePlugin from "../main";
import type { SessionChangeDetail } from "../state/store";
import type {
  IllustrationVariant,
  SessionIllustrations,
} from "../types/media";
import type { StellaSession } from "../types/session";
import {
  getActiveIllustration,
  listIllustrationVariants,
  setActiveIllustrationVariant,
  toggleIllustrationFavorite,
} from "../util/illustrations";
import { pathToLeaf } from "../util/session-text";
import { IllustrationCarousel } from "./illustration-carousel";
import { IllustrationRegenModal } from "./illustration-regen-modal";
import { isSessionHostView } from "./session-host";

/**
 * IllustrationOutputView — 삽화 출력 전용 뷰.
 *
 * 우측 사이드바에 자체 아이콘으로 뜨는 독립 leaf 라, 드래그로 좌측 사이드바·작업영역
 * 으로 옮기거나 팝아웃(듀얼모니터 전체화면)할 수 있다. 오직 활성 세션의 최신 삽화만
 * 보여준다 — 활성 경로에서 리프에 가장 가까운(최근) 삽화 노드의 variant 캐러셀 +
 * 클릭 시 전체화면 라이트박스, 캐러셀 재생성 버튼.
 *
 * 데이터는 store 에서만 읽고, 삽화가 바뀌면(생성/선택/삭제) store 이벤트로 갱신된다.
 */
export class IllustrationOutputView extends ItemView {
  private sessionFile: string | null = null;
  private session: StellaSession | null = null;
  private illustrations: SessionIllustrations | null = null;
  private carousel: IllustrationCarousel | null = null;
  private bodyEl!: HTMLElement;
  private regenerating = false;
  private reloadSeq = 0;
  /** 자기 variant 선택 저장 이벤트 무시 (슬라이드 애니메이션 보존). */
  private suppressOwnEvent = false;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: StellaEnginePlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_ILLUSTRATION_OUTPUT;
  }

  getDisplayText(): string {
    return "Stella 삽화";
  }

  getIcon(): string {
    return "image";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("ggai-illus-output");
    this.bodyEl = root.createDiv({ cls: "ggai-illus-output-body" });

    this.sessionFile = this.plugin.getActiveOrLastSessionFile();

    // 활성 세션 추적 — 세션 뷰 leaf 가 active 되면 그 세션, 아니면 마지막 세션 유지.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const next = isSessionHostView(leaf?.view)
          ? leaf.view.getSessionFile()
          : this.plugin.getActiveOrLastSessionFile();
        void this.setSession(next);
      })
    );
    this.registerEvent(
      this.plugin.store.on("active-session-changed", (file: string) => {
        void this.setSession(file);
      })
    );
    this.registerEvent(
      this.plugin.store.on(
        "session-changed",
        (file: string, detail?: SessionChangeDetail) => {
          if (file !== this.sessionFile) return;
          // 활성 설정만 바뀐 저장은 삽화 표시와 무관 — 이미지 재로드 안 함.
          if (detail?.kinds?.every((k) => k === "settings")) return;
          void this.reload();
        }
      )
    );
    this.registerEvent(
      this.plugin.store.on("session-illustrations-changed", (file: string) => {
        if (file === this.sessionFile && !this.suppressOwnEvent) void this.reload();
      })
    );
    this.registerEvent(
      this.plugin.store.on("session-deleted", (file: string) => {
        if (file === this.sessionFile) void this.setSession(null);
      })
    );

    await this.reload();
  }

  async onClose(): Promise<void> {
    this.carousel = null;
  }

  private async setSession(next: string | null): Promise<void> {
    if (next === this.sessionFile) return;
    this.sessionFile = next;
    await this.reload();
  }

  private async reload(): Promise<void> {
    const seq = ++this.reloadSeq;
    if (!this.sessionFile) {
      this.session = null;
      this.illustrations = null;
      this.render();
      return;
    }
    const session = await this.plugin.store.getSession(this.sessionFile);
    const illustrations = await this.plugin.store.getSessionIllustrations(
      this.sessionFile
    );
    if (seq !== this.reloadSeq) return;
    this.session = session;
    this.illustrations = illustrations;
    this.render();
  }

  /** 활성 경로에서 가장 최근(리프에 가까운) 삽화가 있는 노드 id. */
  private latestNodeId(): string | null {
    if (!this.session || !this.illustrations) return null;
    const path = pathToLeaf(this.session, this.session.meta.activeLeafId);
    for (let i = path.length - 1; i >= 0; i--) {
      if (getActiveIllustration(this.illustrations, path[i].id)) return path[i].id;
    }
    return null;
  }

  private render(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    this.carousel = null;
    const nodeId = this.latestNodeId();
    if (!nodeId || !this.sessionFile) {
      this.bodyEl.createDiv({
        cls: "ggai-illus-output-empty",
        text: this.sessionFile
          ? "이 세션에 삽화가 없습니다."
          : "세션을 열면 삽화가 여기 표시됩니다.",
      });
      return;
    }
    const carouselEl = this.bodyEl.createDiv();
    this.carousel = new IllustrationCarousel(carouselEl, {
      resolveSrc: (v) => this.resolveSrc(v),
      getVariants: () =>
        this.illustrations
          ? listIllustrationVariants(this.illustrations, nodeId)
          : [],
      getActiveId: () =>
        this.illustrations
          ? getActiveIllustration(this.illustrations, nodeId)?.id ?? null
          : null,
      onSelect: (variantId) => void this.selectVariant(nodeId, variantId),
      onRegen: () => this.openRegen(nodeId),
      isBusy: () => this.regenerating,
      isFavorite: (v) => !!v.favorite,
      onToggleFavorite: (variantId) => this.toggleFavorite(nodeId, variantId),
    });
  }

  /** 삽화 variant 즐겨찾기 토글 — 동기 반영 + 자기 이벤트 무시 저장. */
  private toggleFavorite(nodeId: string, variantId: string): boolean {
    if (!this.sessionFile || !this.illustrations) return false;
    const next = toggleIllustrationFavorite(this.illustrations, nodeId, variantId);
    this.suppressOwnEvent = true;
    void this.plugin.store
      .saveSessionIllustrations(this.sessionFile, this.illustrations)
      .finally(() => {
        this.suppressOwnEvent = false;
      });
    return next;
  }

  private resolveSrc(v: IllustrationVariant): string | null {
    if (!this.sessionFile) return null;
    const folder = this.sessionFile.slice(0, -"/session.json".length);
    const file = this.app.vault.getAbstractFileByPath(`${folder}/${v.path}`);
    return file instanceof TFile ? this.app.vault.getResourcePath(file) : null;
  }

  private async selectVariant(
    nodeId: string,
    variantId: string
  ): Promise<void> {
    if (!this.sessionFile || !this.illustrations) return;
    // 캐러셀이 이미 로컬 슬라이드했으므로 in-place 갱신 + 자기 이벤트 suppress.
    if (!setActiveIllustrationVariant(this.illustrations, nodeId, variantId)) return;
    this.suppressOwnEvent = true;
    try {
      await this.plugin.store.saveSessionIllustrations(
        this.sessionFile,
        this.illustrations
      );
    } finally {
      this.suppressOwnEvent = false;
    }
  }

  private openRegen(nodeId: string): void {
    const active = this.illustrations
      ? getActiveIllustration(this.illustrations, nodeId)
      : null;
    new IllustrationRegenModal(this.app, {
      prompt: active?.prompt ?? "",
      negativePrompt: active?.negativePrompt ?? "",
      onSubmit: (prompt, negativePrompt) =>
        void this.runRegen(nodeId, prompt, negativePrompt),
    }).open();
  }

  private async runRegen(
    nodeId: string,
    prompt: string,
    negativePrompt: string
  ): Promise<void> {
    if (!this.sessionFile || this.regenerating) return;
    if (!this.plugin.ai.isAvailable()) {
      new Notice("GGAI Core 가 설치/활성화되어 있지 않습니다.");
      return;
    }
    this.regenerating = true;
    this.render();
    try {
      const result = await this.plugin.illustration.regenWithPrompt(
        this.sessionFile,
        nodeId,
        { prompt, negativePrompt }
      );
      if (!result.ok) {
        new Notice("삽화 생성 실패: " + (result.errors[0] ?? "알 수 없는 오류"));
      }
      await this.reload();
    } finally {
      this.regenerating = false;
      this.render();
    }
  }
}
