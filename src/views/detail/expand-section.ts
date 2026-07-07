import type StellaEnginePlugin from "../../main";
import type { SettingsPanel } from "../../services/settings-panel-registry";
import type { ActiveSettings } from "../../types/preset";
import { renderCollapsibleShell } from "./setting-controls";

export interface ExpandSectionUiState {
  panelCollapsed: Record<string, boolean>;
}

/**
 * ExpandSection — 우측 사이드바 [분기] 옆 [확장] 탭.
 *
 * 요약 설정 같은 개별 UI 를 직접 그리지 않는다 — `plugin.settingsPanels` 에 등록된
 * 패널들을 순서대로 접이식 패널로 그리는 **호스트**다. 새 확장 설정을 추가하려면
 * 여기를 고치지 말고 `SettingsPanel` 을 하나 만들어 `plugin.registerSettingsPanel()`
 * 로 등록한다 (내장 패널 예시: `panels/summary-panel.ts`). 외부 플러그인도 같은 방식으로
 * 자기 패널을 꽂을 수 있다 — `확장 패널 스펙.md` 참고.
 */
export class ExpandSection {
  private root: HTMLElement;
  private settings: ActiveSettings = {};
  private panelBodies = new Map<string, HTMLElement>();
  private panelSetters = new Map<string, (v: boolean) => void>();
  private collapsedState: Record<string, boolean>;

  constructor(
    container: HTMLElement,
    private plugin: StellaEnginePlugin,
    private activeSessionFile: string | null,
    uiState?: Partial<ExpandSectionUiState>
  ) {
    this.root = container.createDiv({ cls: "ggai-expand-pane" });
    this.collapsedState = { ...(uiState?.panelCollapsed ?? {}) };
  }

  getUiState(): ExpandSectionUiState {
    return { panelCollapsed: { ...this.collapsedState } };
  }

  /** 전체 접기/펼치기 — 등록된 모든 확장 패널을 함께 접거나 편다. */
  setCollapsed(v: boolean): void {
    for (const set of this.panelSetters.values()) set(v);
  }

  isAllCollapsed(): boolean {
    const panels = this.plugin.settingsPanels.list();
    if (panels.length === 0) return false;
    return panels.every((p) => this.collapsedState[p.id] === true);
  }

  async load(): Promise<void> {
    await this.reloadSettings();
    this.render();
  }

  setActiveSessionFile(file: string | null): void {
    this.activeSessionFile = file;
    void (async () => {
      await this.reloadSettings();
      this.render();
    })();
  }

  /** session-changed 등 외부 갱신 이벤트 — 활성 설정 다시 읽고 전체 패널 재렌더. */
  async refresh(): Promise<void> {
    await this.reloadSettings();
    this.render();
  }

  /** Core 프로필 목록 변경 — 모든 패널 본문만 다시 그린다 (접힘/세션 상태는 유지). */
  refreshModels(): void {
    this.renderAllPanelBodies();
  }

  /** 패널 등록/해제(`settings-panels-changed`) — 패널 목록 자체를 다시 구성. */
  rebuildPanels(): void {
    this.render();
  }

  /** 특정 패널만 활성 설정을 다시 읽고 다시 그린다 (예: 그 패널이 구독하는 세션 데이터 변경). */
  refreshPanel(id: string): void {
    void this.reloadSettings().then(() => this.renderPanelById(id));
  }

  private async reloadSettings(): Promise<void> {
    this.settings = await this.plugin.resolveActiveSettings(this.activeSessionFile);
  }

  private render(): void {
    this.root.empty();
    this.panelBodies.clear();
    this.panelSetters.clear();
    if (!this.activeSessionFile) {
      this.root.createDiv({ cls: "ggai-detail-empty", text: "열린 세션이 없습니다." });
      return;
    }
    for (const panel of this.plugin.settingsPanels.list()) {
      this.renderPanelShell(panel);
    }
  }

  private renderPanelShell(panel: SettingsPanel): void {
    const panelEl = this.root.createDiv({ cls: "ggai-media-panel ggai-collapsible" });
    const { body, setCollapsed } = renderCollapsibleShell({
      container: panelEl,
      title: panel.title,
      bodyCls: "ggai-media-body",
      collapsed: this.collapsedState[panel.id] ?? false,
      onToggle: (c) => (this.collapsedState[panel.id] = c),
    });
    this.panelBodies.set(panel.id, body);
    this.panelSetters.set(panel.id, setCollapsed);
    this.renderPanelBody(panel, body);
  }

  private renderPanelBody(panel: SettingsPanel, body: HTMLElement): void {
    body.empty();
    panel.render(body, {
      plugin: this.plugin,
      activeSessionFile: this.activeSessionFile,
      settings: this.settings,
      patchSettings: async (patch) => {
        await this.plugin.patchActiveSettings(patch, this.activeSessionFile);
        await this.reloadSettings();
        this.renderPanelById(panel.id);
        return this.settings;
      },
      getPanelData: <T>() => {
        const bucketKey = this.activeSessionFile ?? "_global";
        return this.plugin.data.extensionPanelData?.[panel.id]?.[bucketKey] as
          | T
          | undefined;
      },
      setPanelData: async (patch) => {
        const bucketKey = this.activeSessionFile ?? "_global";
        const root = { ...(this.plugin.data.extensionPanelData ?? {}) };
        const forPanel = { ...(root[panel.id] ?? {}) };
        forPanel[bucketKey] = { ...(forPanel[bucketKey] as any), ...patch };
        root[panel.id] = forPanel;
        await this.plugin.savePluginData({ extensionPanelData: root });
        this.renderPanelById(panel.id);
      },
      rerender: () => this.renderPanelById(panel.id),
    });
  }

  private renderPanelById(id: string): void {
    const panel = this.plugin.settingsPanels.list().find((p) => p.id === id);
    const body = this.panelBodies.get(id);
    if (!panel || !body) return;
    this.renderPanelBody(panel, body);
  }

  private renderAllPanelBodies(): void {
    for (const panel of this.plugin.settingsPanels.list()) {
      const body = this.panelBodies.get(panel.id);
      if (body) this.renderPanelBody(panel, body);
    }
  }
}
