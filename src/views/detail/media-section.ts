import { Setting } from "obsidian";
import type StellaEnginePlugin from "../../main";
import type {
  ActiveSettings,
  IllustrationActiveSettings,
  IllustrationOutputPosition,
  MediaPromptItem,
  TranslationActiveSettings,
  TranslationOutputMode,
} from "../../types/preset";
import { getDefaultPrompts } from "../../util/default-media-prompts";
import { DEFAULT_ILLUSTRATION_AUTO_MIN_PARAGRAPHS } from "../../util/illustration-anchors";
import { resolveIllustrationOutput } from "../../util/illustrations";
import { MediaPromptSectionBase, type PromptBucket } from "./media-prompt-panel";
import {
  renderCollapsibleShell,
  renderNumberRow,
  renderOptionGrid,
} from "./setting-controls";

const DEFAULT_ILLUSTRATION_CONTEXT_CHARS = 4000;

export interface MediaSectionUiState {
  translationCollapsed: boolean;
  illustrationCollapsed: boolean;
}

export class MediaSection extends MediaPromptSectionBase {
  private root: HTMLElement;
  private translationBodyEl!: HTMLElement;
  private illustrationBodyEl!: HTMLElement;
  private translationCollapsed = true;
  private illustrationCollapsed = true;
  private panelSetters: Array<(v: boolean) => void> = [];

  constructor(
    container: HTMLElement,
    plugin: StellaEnginePlugin,
    uiState?: Partial<MediaSectionUiState>
  ) {
    super(plugin);
    this.root = container.createDiv({ cls: "ggai-media-section" });
    if (uiState?.translationCollapsed !== undefined) {
      this.translationCollapsed = uiState.translationCollapsed;
    }
    if (uiState?.illustrationCollapsed !== undefined) {
      this.illustrationCollapsed = uiState.illustrationCollapsed;
    }
    this.renderShell();
  }

  getUiState(): MediaSectionUiState {
    return {
      translationCollapsed: this.translationCollapsed,
      illustrationCollapsed: this.illustrationCollapsed,
    };
  }

  /** 전체 접기/펼치기 — 번역·삽화 두 패널을 함께 접거나 편다. */
  setCollapsed(v: boolean): void {
    for (const set of this.panelSetters) set(v);
  }

  isAllCollapsed(): boolean {
    return this.translationCollapsed && this.illustrationCollapsed;
  }

  setActive(settings: ActiveSettings, sessionFile: string | null): void {
    this.settings = settings;
    this.activeSessionFile = sessionFile;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private renderShell(): void {
    this.translationBodyEl = this.renderPanelShell(
      "번역",
      () => this.translationCollapsed,
      (v) => (this.translationCollapsed = v)
    );
    this.illustrationBodyEl = this.renderPanelShell(
      "삽화 설정",
      () => this.illustrationCollapsed,
      (v) => (this.illustrationCollapsed = v)
    );

    this.render();
  }

  /** 접이식 패널 껍데기 (헤더 + 본문) — 번역/삽화 공용. 본문 엘리먼트를 반환. */
  private renderPanelShell(
    title: string,
    getCollapsed: () => boolean,
    setCollapsed: (v: boolean) => void
  ): HTMLElement {
    const panel = this.root.createDiv({ cls: "ggai-media-panel ggai-collapsible" });
    const { body, setCollapsed: setShell } = renderCollapsibleShell({
      container: panel,
      title,
      bodyCls: "ggai-media-body",
      collapsed: getCollapsed(),
      onToggle: (c) => setCollapsed(c),
    });
    this.panelSetters.push(setShell);
    return body;
  }

  protected render(): void {
    this.translationBodyEl.empty();
    this.illustrationBodyEl.empty();
    this.translationBodyEl.toggleClass("is-collapsed", this.translationCollapsed);
    this.illustrationBodyEl.toggleClass("is-collapsed", this.illustrationCollapsed);
    this.renderTranslation(this.translationBodyEl);
    this.renderIllustration(this.illustrationBodyEl);
  }

  private renderTranslation(parent: HTMLElement): void {
    this.renderEnableToggle(
      parent,
      "번역 사용",
      this.settings.translation?.enabled === true,
      (enabled) => this.patchTranslation({ enabled })
    );

    this.renderEnableToggle(
      parent,
      "오류시 번역 자동 재시도",
      this.settings.translation?.retryOnFormatError === true,
      (retryOnFormatError) => this.patchTranslation({ retryOnFormatError })
    );

    this.renderModelPicker(
      parent,
      "모델",
      this.plugin.ai.listGenerationProfiles(),
      this.settings.translation?.modelProfileId,
      (modelProfileId) => this.patchTranslation({ modelProfileId }),
      "Core 텍스트 모델이 없습니다."
    );

    this.renderPromptPicker(parent, {
      label: "프롬프트",
      bucket: "translation",
      activeId: this.settings.translation?.promptId,
      onSelect: (promptId) => this.patchTranslation({ promptId }),
    });

    this.renderTranslationOutputPicker(parent);

    this.renderLorebookPicker(parent, {
      label: "로어북",
      selectedIds: this.settings.translation?.lorebookIds ?? [],
      onToggle: (lorebookIds) => this.patchTranslation({ lorebookIds }),
    });
  }

  /**
   * 번역 출력 방식 — translations.json 의 문단별 번역을 어디에 표시할지 선택.
   * 원문 치환 / 좌우 2분할.
   */
  private renderTranslationOutputPicker(parent: HTMLElement): void {
    renderOptionGrid<TranslationOutputMode>({
      parent,
      label: "출력 방식",
      options: [
        { id: "replace", label: "원문 치환" },
        { id: "split-h", label: "2분할" },
      ],
      activeId: this.settings.translation?.output ?? "replace",
      onSelect: (id) => void this.patchTranslation({ output: id }),
    });
  }

  /**
   * 삽화 출력 위치 — 출력 뷰(전용 패널) / 인라인(본문 안, 2분할이면 넓은 쪽).
   */
  private renderIllustrationOutputPicker(parent: HTMLElement): void {
    renderOptionGrid<IllustrationOutputPosition>({
      parent,
      label: "출력 위치",
      options: [
        { id: "panel", label: "출력 뷰" },
        { id: "inline", label: "인라인" },
      ],
      activeId: resolveIllustrationOutput(this.settings.illustration?.output),
      onSelect: (id) => {
        void this.patchIllustration({ output: id });
        if (id === "panel") void this.plugin.revealIllustrationOutput();
      },
    });
  }

  private renderIllustration(parent: HTMLElement): void {
    this.renderEnableToggle(
      parent,
      "삽화 사용",
      this.settings.illustration?.enabled === true,
      (enabled) => this.patchIllustration({ enabled })
    );

    this.renderIllustrationOutputPicker(parent);

    this.renderModelPicker(
      parent,
      "모델",
      this.plugin.ai.listImageProfiles(),
      this.settings.illustration?.imageProfileId,
      (imageProfileId) => this.patchIllustration({ imageProfileId }),
      "Core 그림 모델이 없습니다."
    );

    this.renderModelPicker(
      parent,
      "삽화프롬프트 생성 모델",
      this.plugin.ai.listGenerationProfiles(),
      this.settings.illustration?.promptGenModelProfileId,
      (promptGenModelProfileId) => this.patchIllustration({ promptGenModelProfileId }),
      "Core 텍스트 모델이 없습니다."
    );

    this.renderPromptPicker(parent, {
      label: "삽화 프롬프트 생성용 프롬프트",
      bucket: "illustrationPromptGen",
      activeId: this.settings.illustration?.promptGenPromptId,
      onSelect: (promptGenPromptId) => this.patchIllustration({ promptGenPromptId }),
    });

    this.renderLorebookPicker(parent, {
      label: "로어북",
      selectedIds: this.settings.illustration?.lorebookIds ?? [],
      onToggle: (lorebookIds) => this.patchIllustration({ lorebookIds }),
    });

    renderNumberRow({
      parent,
      label: "본문 첨부량",
      value: this.settings.illustration?.contextChars ?? DEFAULT_ILLUSTRATION_CONTEXT_CHARS,
      fallback: 0,
      min: 0,
      step: 500,
      onChange: (contextChars) => void this.patchIllustration({ contextChars }),
    });

    renderNumberRow({
      parent,
      label: "자동 생성 주기(문단, 0=매번)",
      value:
        this.settings.illustration?.autoMinParagraphs ??
        DEFAULT_ILLUSTRATION_AUTO_MIN_PARAGRAPHS,
      fallback: DEFAULT_ILLUSTRATION_AUTO_MIN_PARAGRAPHS,
      min: 0,
      step: 1,
      integer: true,
      onChange: (autoMinParagraphs) =>
        void this.patchIllustration({ autoMinParagraphs }),
    });
  }

  protected clearDeletedPromptSelection(
    bucket: PromptBucket,
    promptId: string
  ): Partial<ActiveSettings> | null {
    if (bucket === "translation" && this.settings.translation?.promptId === promptId) {
      return { translation: { ...this.settings.translation, promptId: undefined } };
    }
    if (
      bucket === "illustrationPromptGen" &&
      this.settings.illustration?.promptGenPromptId === promptId
    ) {
      return { illustration: { ...this.settings.illustration, promptGenPromptId: undefined } };
    }
    return null;
  }

  private async patchTranslation(patch: Partial<TranslationActiveSettings>): Promise<void> {
    let translation = { ...(this.settings.translation ?? {}), ...patch };
    // 번역 사용 시 기본 프롬프트 자동 지정 (사용자가 아직 아무 것도 선택하지 않은 경우)
    if (translation.enabled && !translation.promptId) {
      const def = getDefaultPrompts("translation")[0];
      if (def) translation = { ...translation, promptId: def.id };
    }
    await this.plugin.patchActiveSettings({ translation }, this.activeSessionFile);
    this.settings = await this.plugin.resolveActiveSettings(this.activeSessionFile);
    this.render();
  }

  private async patchIllustration(patch: Partial<IllustrationActiveSettings>): Promise<void> {
    const illustration = { ...(this.settings.illustration ?? {}), ...patch };
    await this.plugin.patchActiveSettings({ illustration }, this.activeSessionFile);
    this.settings = await this.plugin.resolveActiveSettings(this.activeSessionFile);
    this.render();
  }
}
