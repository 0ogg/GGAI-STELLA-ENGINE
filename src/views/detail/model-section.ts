import { Notice } from "obsidian";
import type {
  AIService,
  GenerationProfileLite,
} from "../../services/ai-service";
import type StellaEnginePlugin from "../../main";
import { renderCollapsibleShell, renderModelPicker } from "./setting-controls";

/**
 * ModelSection — 활성 모델 프로필 버튼.
 *
 *  - 클릭 → `plugin.patchActiveSettings({ modelProfileId }, sessionFile)`.
 *  - 꾹 누르기 → Core 의 해당 프로필 편집.
 *  - ⚙ 클릭 → `app.setting.open()` (가능하면 ggai-core 탭).
 *  - 활성 세션 있으면 그 세션 메타에, 없으면 PluginData.current 에 저장 — 항상 동작.
 *
 * 접이식 껍데기·모델 버튼줄·롱프레스 편집은 공용 킷(`setting-controls`)을 쓴다.
 *
 * 호스트(detail-view) 가 호출:
 *  - `setActive(modelProfileId, sessionFile)` — 활성값 갱신.
 *  - `refresh()` — Core profiles-changed 시.
 */
export class ModelSection {
  private root: HTMLElement;
  private bodyEl!: HTMLElement;
  private collapsed = false;
  private setCollapsedFn: ((v: boolean) => void) | null = null;

  private ai: AIService;

  private activeModelProfileId: string | undefined;
  private activeSessionFile: string | null = null;

  constructor(
    container: HTMLElement,
    private plugin: StellaEnginePlugin,
    private onActiveChanged?: () => void,
    collapsed = false
  ) {
    this.root = container.createDiv({ cls: "ggai-model-section ggai-collapsible" });
    this.ai = plugin.ai;
    this.collapsed = collapsed;
    this.renderShell();
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  setCollapsed(v: boolean): void {
    this.setCollapsedFn?.(v);
  }

  setActive(
    modelProfileId: string | undefined,
    sessionFile: string | null
  ): void {
    this.activeModelProfileId = modelProfileId;
    this.activeSessionFile = sessionFile;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  // ─── render ──────────────────────────────────────────────────────────

  private renderShell(): void {
    const { body, setCollapsed } = renderCollapsibleShell({
      container: this.root,
      title: "모델",
      bodyCls: "ggai-model-body",
      collapsed: this.collapsed,
      onToggle: (c) => (this.collapsed = c),
    });
    this.bodyEl = body;
    this.setCollapsedFn = setCollapsed;
    this.render();
  }

  private render(): void {
    this.bodyEl.empty();
    const available = this.ai.isAvailable();
    renderModelPicker({
      parent: this.bodyEl,
      profiles: available ? this.ai.listGenerationProfiles() : [],
      activeId: this.activeModelProfileId,
      emptyText: available
        ? "Core 에 등록된 텍스트 생성 프로필이 없습니다."
        : "GGAI Core 가 설치되지 않았습니다.",
      onSelect: (p) => void this.handleSelect(p as GenerationProfileLite),
      onOpenSettings: () => this.openCoreSettings(),
      onLongPressEdit: (p) => this.handleLongPressEdit(p as GenerationProfileLite),
    });
  }

  private async handleSelect(profile: GenerationProfileLite): Promise<void> {
    if (this.activeModelProfileId === profile.id) return;
    try {
      await this.plugin.patchActiveSettings(
        { modelProfileId: profile.id },
        this.activeSessionFile
      );
    } catch (err) {
      console.error("[GGAI Stella] modelProfileId 저장 실패:", err);
      new Notice(
        `모델 변경 저장 실패: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    this.activeModelProfileId = profile.id;
    // 사용자가 모델을 직접 지정 — 프리셋 선택이 풀리고, 순환이 켜져 있어도 다음
    // 1회 생성은 이 선택 그대로 간다.
    await this.plugin.noteManualSettingChange();
    // 텍스트 모델이면 "NAI 형식으로 보내기"를 자동으로 켜고, 채팅이면 끈다.
    await this.plugin.setNaiFormatForModel(profile.kind, this.activeSessionFile);
    this.render();
    // 모델이 바뀌면 allowedParams 게이트도 바뀔 수 있어 ParamsSection 도 재렌더해야 함.
    // (프롬프트 세트 전환도 onActiveChanged → refreshActiveSettings 로 UI 반영됨.)
    this.onActiveChanged?.();
  }

  private openCoreSettings(): void {
    const setting = (this.plugin.app as any).setting;
    if (!setting?.open) {
      new Notice("설정 창을 열 수 없습니다.");
      return;
    }
    setting.open();
    try {
      setting.openTabById?.("ggai-core");
    } catch {
      // openTabById 가 없거나 탭 id 가 다르면 그냥 일반 설정창에 머무름.
    }
  }

  private handleLongPressEdit(profile: GenerationProfileLite): void {
    const ok = this.ai.editProfile(profile.id);
    if (!ok) {
      new Notice(
        "GGAI Core 가 이 기능을 지원하지 않습니다. Core 를 최신 버전으로 업데이트해주세요."
      );
    }
  }
}
