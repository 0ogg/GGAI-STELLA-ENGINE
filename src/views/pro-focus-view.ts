/**
 * 집필 프로(PRO) — 집중 설정 뷰 (집필 프로 스펙.md §5).
 *
 * 문제: 우측 디테일 뷰는 설정이 많아 작업 중 원하는 항목을 찾기 불편하다.
 * 해법: **핀 카탈로그** — 공용 컨트롤 킷으로 그릴 수 있는 설정 컨트롤들을 "핀 가능한
 * 항목"으로 카탈로그화하고, 이 뷰는 저자가 고른 항목만 고른 순서로 세로 나열한다.
 *
 * 원칙 (스펙 §5):
 *  - 기존 디테일 섹션을 뜯지 않는다 — 컨트롤 킷 함수만 재호출, 렌더러 복제 금지.
 *  - 핀 목록/순서 = `PluginData.proFocusPins` (전역). 편집은 이 뷰 안에서.
 *  - 대상 세션 = 디테일 뷰와 같은 활성 세션 추적(`getActiveOrLastSessionFile` +
 *    `active-session-changed`). 세션이 없으면 전역 설정(PluginData.current)에 쓴다.
 *  - 편집 보호는 공용 EditGuard (메모리/작가노트 textarea — 회귀금지.md).
 */

import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type StellaEnginePlugin from "../main";
import { VIEW_TYPE_PRO_FOCUS } from "../constants";
import type { SessionChangeDetail } from "../state/store";
import type { StellaSession } from "../types/session";
import type {
  ActiveSettings,
  IllustrationActiveSettings,
  ProActiveSettings,
  SummaryActiveSettings,
  TranslationActiveSettings,
} from "../types/preset";
import { EditGuard } from "./edit-guard";
import {
  renderEnableToggle,
  renderNumberRow,
  renderOptionGrid,
} from "./detail/setting-controls";
import {
  renderMediaModelPicker,
  renderMediaPromptPicker,
} from "./detail/media-prompt-panel";
import { DEFAULT_SUMMARY_THRESHOLD } from "../util/summarize-session";
import { PRO_STYLE_TAIL_CHARS_DEFAULT } from "../services/pro-service";
import { PRO_STYLE_PAIRS_DEFAULT } from "../util/pro-convert";
import { uuidv4 } from "../util/uuid";

/** 핀 미설정 시 기본 구성 — 집필 중 가장 자주 만지는 항목들. */
const DEFAULT_PINS = ["model", "promptSet", "translation", "pro", "memory"];

/** 메모리/작가노트 저장 디바운스. */
const META_SAVE_MS = 800;

interface FocusCtx {
  plugin: StellaEnginePlugin;
  /** 활성 세션 파일 — 없으면 null (설정은 전역에 저장됨). */
  sessionFile: string | null;
  session: StellaSession | null;
  settings: ActiveSettings;
  view: ProFocusView;
}

interface FocusItem {
  id: string;
  /** 핀 편집 목록에 표시할 이름. */
  title: string;
  render(body: HTMLElement, ctx: FocusCtx): void | Promise<void>;
}

// ─── 핀 카탈로그 — 전부 공용 킷 함수 재호출로만 구성한다 ───

const CATALOG: FocusItem[] = [
  {
    id: "model",
    title: "생성 모델",
    render(body, ctx) {
      renderMediaModelPicker({
        plugin: ctx.plugin,
        parent: body,
        label: "생성 모델",
        profiles: ctx.plugin.ai.listGenerationProfiles(),
        activeId: ctx.settings.modelProfileId,
        onSelect: (modelProfileId) =>
          void ctx.view.patchFocusSettings({ modelProfileId }),
        emptyText: "Core 생성 모델이 없습니다.",
      });
    },
  },
  {
    id: "promptSet",
    title: "프롬프트 세트",
    async render(body, ctx) {
      const list = await ctx.plugin.store.getPromptPresets();
      renderOptionGrid({
        parent: body,
        label: "프롬프트 세트",
        options: list.map((i) => ({
          id: i.preset.meta.id,
          label: i.folderName,
        })),
        activeId: ctx.settings.promptSetId ?? "",
        onSelect: (promptSetId) =>
          void ctx.view.patchFocusSettings({ promptSetId }),
      });
    },
  },
  {
    id: "translation",
    title: "번역",
    render(body, ctx) {
      const t = ctx.settings.translation ?? {};
      const patch = (p: Partial<TranslationActiveSettings>) =>
        void ctx.view.patchFocusSettings({ translation: { ...t, ...p } });
      renderEnableToggle({
        parent: body,
        label: "번역 사용",
        checked: t.enabled === true,
        onChange: (enabled) => patch({ enabled }),
      });
      renderEnableToggle({
        parent: body,
        label: "자동 번역",
        checked: t.auto === true,
        onChange: (auto) => patch({ auto }),
      });
      renderMediaModelPicker({
        plugin: ctx.plugin,
        parent: body,
        label: "번역 모델",
        profiles: ctx.plugin.ai.listGenerationProfiles(),
        activeId: t.modelProfileId,
        onSelect: (modelProfileId) => patch({ modelProfileId }),
        emptyText: "Core 텍스트 모델이 없습니다.",
      });
      renderMediaPromptPicker({
        plugin: ctx.plugin,
        parent: body,
        label: "번역 프롬프트",
        bucket: "translation",
        activeId: t.promptId,
        onSelect: (promptId) => patch({ promptId }),
        onChanged: () => ctx.view.rerenderNow(),
        onDeleted: (promptId) => {
          if (t.promptId === promptId) patch({ promptId: undefined });
          else ctx.view.rerenderNow();
        },
      });
    },
  },
  {
    id: "illustration",
    title: "삽화",
    render(body, ctx) {
      const il = ctx.settings.illustration ?? {};
      const patch = (p: Partial<IllustrationActiveSettings>) =>
        void ctx.view.patchFocusSettings({ illustration: { ...il, ...p } });
      renderEnableToggle({
        parent: body,
        label: "삽화 사용",
        checked: il.enabled === true,
        onChange: (enabled) => patch({ enabled }),
      });
      renderEnableToggle({
        parent: body,
        label: "자동 생성",
        checked: il.auto === true,
        onChange: (auto) => patch({ auto }),
      });
      renderMediaModelPicker({
        plugin: ctx.plugin,
        parent: body,
        label: "이미지 모델",
        profiles: ctx.plugin.ai.listImageProfiles(),
        activeId: il.imageProfileId,
        onSelect: (imageProfileId) => patch({ imageProfileId }),
        emptyText: "Core 이미지 모델이 없습니다.",
      });
      renderMediaPromptPicker({
        plugin: ctx.plugin,
        parent: body,
        label: "삽화 프롬프트 생성",
        bucket: "illustrationPromptGen",
        activeId: il.promptGenPromptId,
        onSelect: (promptGenPromptId) => patch({ promptGenPromptId }),
        onChanged: () => ctx.view.rerenderNow(),
        onDeleted: (promptId) => {
          if (il.promptGenPromptId === promptId)
            patch({ promptGenPromptId: undefined });
          else ctx.view.rerenderNow();
        },
      });
    },
  },
  {
    id: "summary",
    title: "요약",
    render(body, ctx) {
      const s = ctx.settings.summarize ?? {};
      const patch = (p: Partial<SummaryActiveSettings>) =>
        void ctx.view.patchFocusSettings({ summarize: { ...s, ...p } });
      renderEnableToggle({
        parent: body,
        label: "요약 사용",
        checked: s.enabled === true,
        onChange: (enabled) => patch({ enabled }),
      });
      renderMediaModelPicker({
        plugin: ctx.plugin,
        parent: body,
        label: "요약 모델",
        profiles: ctx.plugin.ai.listGenerationProfiles(),
        activeId: s.modelProfileId,
        onSelect: (modelProfileId) => patch({ modelProfileId }),
        emptyText: "Core 텍스트 모델이 없습니다.",
      });
      renderNumberRow({
        parent: body,
        label: "요약 주기(생성 횟수)",
        value: s.threshold ?? DEFAULT_SUMMARY_THRESHOLD,
        fallback: DEFAULT_SUMMARY_THRESHOLD,
        min: 1,
        step: 1,
        integer: true,
        onChange: (threshold) => patch({ threshold }),
      });
    },
  },
  {
    id: "pro",
    title: "집필 변환",
    render(body, ctx) {
      const p0 = ctx.settings.pro ?? {};
      const patch = (p: Partial<ProActiveSettings>) =>
        void ctx.view.patchFocusSettings({ pro: { ...p0, ...p } });
      renderMediaModelPicker({
        plugin: ctx.plugin,
        parent: body,
        label: "집필 변환 모델",
        profiles: ctx.plugin.ai.listGenerationProfiles(),
        activeId: p0.modelProfileId,
        onSelect: (modelProfileId) => patch({ modelProfileId }),
        emptyText: "Core 텍스트 모델이 없습니다.",
      });
      renderMediaPromptPicker({
        plugin: ctx.plugin,
        parent: body,
        label: "집필 변환 프롬프트",
        bucket: "proConvert",
        activeId: p0.promptId,
        onSelect: (promptId) => patch({ promptId }),
        onChanged: () => ctx.view.rerenderNow(),
        onDeleted: (promptId) => {
          if (p0.promptId === promptId) patch({ promptId: undefined });
          else ctx.view.rerenderNow();
        },
      });
      renderNumberRow({
        parent: body,
        label: "문체 참조 첨부량(글자)",
        value: p0.styleTailChars ?? PRO_STYLE_TAIL_CHARS_DEFAULT,
        fallback: PRO_STYLE_TAIL_CHARS_DEFAULT,
        min: 0,
        step: 500,
        integer: true,
        onChange: (styleTailChars) => patch({ styleTailChars }),
      });
      renderNumberRow({
        parent: body,
        label: "문체 예시 쌍 수(0=끄기)",
        value: p0.stylePairs ?? PRO_STYLE_PAIRS_DEFAULT,
        fallback: PRO_STYLE_PAIRS_DEFAULT,
        min: 0,
        step: 1,
        integer: true,
        onChange: (stylePairs) => patch({ stylePairs }),
      });
    },
  },
  {
    id: "memory",
    title: "메모리",
    render(body, ctx) {
      ctx.view.renderMetaTextArea(body, "메모리", "memory");
    },
  },
  {
    id: "authorNote",
    title: "작가노트",
    render(body, ctx) {
      ctx.view.renderMetaTextArea(body, "작가노트", "authorNote");
    },
  },
];

export class ProFocusView extends ItemView {
  private plugin: StellaEnginePlugin;
  private guard = new EditGuard();
  private readonly storeOrigin = `pro-focus:${uuidv4()}`;
  private renderSeq = 0;
  private editPins = false;
  private sessionFile: string | null = null;
  private session: StellaSession | null = null;
  private settings: ActiveSettings = {};
  private pendingMeta: { memory?: string; authorNote?: string } = {};
  private metaSaveTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: StellaEnginePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PRO_FOCUS;
  }
  getDisplayText(): string {
    return "집중 설정";
  }
  getIcon(): string {
    return "list-checks";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("ggai-pro-focus");
    this.guard.attach(this.contentEl);
    this.registerEvent(
      this.plugin.store.on("active-session-changed", () => this.requestRender())
    );
    this.registerEvent(
      this.plugin.store.on(
        "session-changed",
        (file: string, detail?: SessionChangeDetail) => {
          if (detail?.origin === this.storeOrigin) return; // 자기 저장 에코
          if (file !== this.sessionFile) return;
          this.requestRender();
        }
      )
    );
    this.registerEvent(
      this.plugin.ai.on("profiles-changed", () => this.requestRender())
    );
    void this.render();
  }

  async onClose(): Promise<void> {
    this.flushMetaNow();
  }

  /** 외부발 재렌더 — 편집 중(EditGuard)에는 미룬다(다음 이벤트/직접 조작 때 반영). */
  private requestRender(): void {
    if (this.guard.isSavingSelf || this.guard.isEditing()) return;
    void this.render();
  }

  /** 뷰 내부 조작(프롬프트 편집 모달 등)발 재렌더 — 가드 없이 즉시. */
  rerenderNow(): void {
    void this.render();
  }

  /** 활성 설정 부분 갱신 + 즉시 재렌더 (자기 origin 이라 이벤트로는 안 돌아온다). */
  async patchFocusSettings(patch: Partial<ActiveSettings>): Promise<void> {
    await this.plugin.patchActiveSettings(patch, this.sessionFile, {
      origin: this.storeOrigin,
    });
    void this.render();
  }

  private getPins(): string[] {
    return this.plugin.data.proFocusPins ?? [...DEFAULT_PINS];
  }

  private async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const file = this.plugin.getActiveOrLastSessionFile();
    const session = file ? await this.plugin.store.getSession(file) : null;
    const settings = await this.plugin.resolveActiveSettings(
      session ? file : null
    );
    if (seq !== this.renderSeq) return;
    this.sessionFile = session && file ? file : null;
    this.session = session;
    this.settings = settings;

    const root = this.contentEl;
    root.empty();
    if (!this.plugin.pro.isActive()) {
      root.createDiv({
        cls: "ggai-focus-placeholder",
        text: "집필 프로가 비활성 상태입니다.",
      });
      return;
    }

    // 헤더 — 대상(세션 이름 또는 전역) + 핀 편집 토글.
    const header = root.createDiv({ cls: "ggai-focus-header" });
    header.createSpan({
      cls: "ggai-focus-target",
      text: session ? session.meta.name : "전역 설정 (활성 세션 없음)",
    });
    const editBtn = header.createEl("button", {
      cls: "ggai-focus-edit-btn",
      attr: { "aria-label": this.editPins ? "핀 편집 완료" : "핀 편집" },
    });
    setIcon(editBtn, this.editPins ? "check" : "sliders-horizontal");
    editBtn.addEventListener("click", () => {
      this.editPins = !this.editPins;
      void this.render();
    });

    if (this.editPins) {
      this.renderPinEditor(root);
      return;
    }

    const pins = this.getPins();
    if (pins.length === 0) {
      root.createDiv({
        cls: "ggai-focus-placeholder",
        text: "고정된 항목이 없습니다 — 우상단 버튼으로 항목을 골라주세요.",
      });
      return;
    }
    const ctx: FocusCtx = {
      plugin: this.plugin,
      sessionFile: this.sessionFile,
      session: this.session,
      settings: this.settings,
      view: this,
    };
    for (const id of pins) {
      const item = CATALOG.find((i) => i.id === id);
      if (!item) continue;
      const sec = root.createDiv({ cls: "ggai-focus-item" });
      await item.render(sec, ctx);
      if (seq !== this.renderSeq) return; // 렌더 경합 — 새 렌더가 시작됨
    }
  }

  /** 핀 편집 — 카탈로그 전체 목록: 체크 = 포함, ▲▼ = 순서 (핀된 것만). */
  private renderPinEditor(root: HTMLElement): void {
    const pins = [...this.getPins()];
    const list = root.createDiv({ cls: "ggai-focus-pin-list" });
    const save = () => {
      void this.plugin.savePluginData({ proFocusPins: pins });
      this.renderPinEditorRows(list, pins, save);
    };
    this.renderPinEditorRows(list, pins, save);
  }

  private renderPinEditorRows(
    list: HTMLElement,
    pins: string[],
    save: () => void
  ): void {
    list.empty();
    const ordered = [
      ...pins
        .map((id) => CATALOG.find((i) => i.id === id))
        .filter((i): i is FocusItem => !!i),
      ...CATALOG.filter((i) => !pins.includes(i.id)),
    ];
    for (const item of ordered) {
      const row = list.createDiv({ cls: "ggai-focus-pin-row" });
      const check = row.createEl("input", {
        cls: "ggai-form-checkbox",
        type: "checkbox",
      });
      check.checked = pins.includes(item.id);
      check.addEventListener("change", () => {
        if (check.checked) pins.push(item.id);
        else pins.splice(pins.indexOf(item.id), 1);
        save();
      });
      row.createSpan({ cls: "ggai-focus-pin-title", text: item.title });
      const idx = pins.indexOf(item.id);
      if (idx >= 0) {
        const up = row.createEl("button", { cls: "ggai-focus-pin-move" });
        setIcon(up, "chevron-up");
        up.disabled = idx === 0;
        up.addEventListener("click", () => {
          [pins[idx - 1], pins[idx]] = [pins[idx], pins[idx - 1]];
          save();
        });
        const down = row.createEl("button", { cls: "ggai-focus-pin-move" });
        setIcon(down, "chevron-down");
        down.disabled = idx === pins.length - 1;
        down.addEventListener("click", () => {
          [pins[idx + 1], pins[idx]] = [pins[idx], pins[idx + 1]];
          save();
        });
      }
    }
  }

  // ─── 메모리/작가노트 — 세션 메타 textarea (EditGuard 필수) ───

  renderMetaTextArea(
    body: HTMLElement,
    label: string,
    key: "memory" | "authorNote"
  ): void {
    const block = body.createDiv({ cls: "ggai-media-block" });
    block.createDiv({ cls: "ggai-media-label", text: label });
    if (!this.session || !this.sessionFile) {
      block.createDiv({
        cls: "ggai-focus-placeholder",
        text: "활성 세션이 없습니다.",
      });
      return;
    }
    const ta = block.createEl("textarea", { cls: "ggai-focus-textarea" });
    ta.value = this.pendingMeta[key] ?? this.session.meta[key] ?? "";
    ta.addEventListener("input", () => {
      this.queueMeta({ [key]: ta.value });
    });
    ta.addEventListener("blur", () => this.flushMetaNow());
  }

  private queueMeta(patch: { memory?: string; authorNote?: string }): void {
    Object.assign(this.pendingMeta, patch);
    if (this.metaSaveTimer != null) window.clearTimeout(this.metaSaveTimer);
    this.metaSaveTimer = window.setTimeout(() => {
      this.metaSaveTimer = null;
      this.flushMetaNow();
    }, META_SAVE_MS);
  }

  private flushMetaNow(): void {
    if (this.metaSaveTimer != null) {
      window.clearTimeout(this.metaSaveTimer);
      this.metaSaveTimer = null;
    }
    const patch = this.pendingMeta;
    if (patch.memory === undefined && patch.authorNote === undefined) return;
    this.pendingMeta = {};
    const file = this.sessionFile;
    if (!file) return;
    void this.guard
      .runSave(async () => {
        const session = await this.plugin.store.getSession(file);
        if (!session) return;
        if (patch.memory !== undefined) session.meta.memory = patch.memory;
        if (patch.authorNote !== undefined)
          session.meta.authorNote = patch.authorNote;
        await this.plugin.store.saveSession(file, session, {
          kinds: ["settings"],
          origin: this.storeOrigin,
        });
      })
      .catch((err) => {
        new Notice(
          `저장 실패: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }
}
