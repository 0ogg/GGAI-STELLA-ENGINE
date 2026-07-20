import { Menu, Modal, Notice, Setting, setIcon } from "obsidian";
import type StellaEnginePlugin from "../../main";
import type { GenerationProfileLite, ImageProfileLite } from "../../services/ai-service";
import type { MediaPromptItem, MediaPromptLibrary } from "../../types/preset";
import { attachLongPress } from "../../util/long-press";
import { getDefaultPrompts, isBuiltinMediaPrompt } from "../../util/default-media-prompts";
import { TRANSLATION_IO_INSTRUCTIONS } from "../../util/translate-paragraphs";
import { SUMMARY_IO_INSTRUCTIONS } from "../../util/summarize-session";
import { PARAGRAPH_REGEN_IO_INSTRUCTIONS } from "../../util/paragraph-regen";
import { PRO_CONVERT_IO_INSTRUCTIONS } from "../../util/pro-convert";
import {
  PHONE_SNS_IO_INSTRUCTIONS,
  PHONE_TUBE_IO_INSTRUCTIONS,
} from "../../util/phone-prompts";
import { LorebookSelectModal } from "../lorebook-select-modal";
import { createModalShell } from "../modal-shell";
import { uuidv4 } from "../../util/uuid";
import { renderModelPicker } from "./setting-controls";

export type PromptBucket = keyof MediaPromptLibrary;
export type MediaModelProfile = GenerationProfileLite | ImageProfileLite;

/** 본문이 결합되는(=`{{main}}` 매크로가 의미 있는) 프롬프트 버킷. */
export function usesBodyMacro(bucket: PromptBucket): boolean {
  return (
    bucket === "translation" ||
    bucket === "illustrationPromptGen" ||
    bucket === "summary" ||
    bucket === "proConvert"
  );
}

/**
 * 버킷별로 엔진이 항상 붙이는 고정 형식 지시문 (없으면 null).
 * 실제 전송에서는 사용자 지침 **앞**(시스템 지시 자리)에 결합되므로, 편집 모달은
 * 이 문구를 프롬프트 입력란 위쪽에 같은 칸으로(반투명) 보여준다 — 사용자가 어떤
 * 입출력 형식이 강제되는지 보고 그에 맞춰(예: 요약의 events/state) 프롬프트를 구성.
 */
export function getBucketIoInstructions(bucket: PromptBucket): string | null {
  if (bucket === "translation") return TRANSLATION_IO_INSTRUCTIONS;
  if (bucket === "summary") return SUMMARY_IO_INSTRUCTIONS;
  if (bucket === "paragraphRegen") return PARAGRAPH_REGEN_IO_INSTRUCTIONS;
  if (bucket === "phoneSns") return PHONE_SNS_IO_INSTRUCTIONS;
  if (bucket === "phoneTube") return PHONE_TUBE_IO_INSTRUCTIONS;
  if (bucket === "proConvert") return PRO_CONVERT_IO_INSTRUCTIONS;
  return null;
}

function openCoreSettings(plugin: StellaEnginePlugin): void {
  const setting = (plugin.app as any).setting;
  if (!setting?.open) {
    new Notice("설정 화면을 열 수 없습니다.");
    return;
  }
  setting.open();
  try {
    setting.openTabById?.("ggai-core");
  } catch {
    // Older Obsidian versions may not support openTabById.
  }
}

/** 모델 버튼 꾹 누르기 → Core 의 해당 프로필 편집 모달. */
function editModelProfile(plugin: StellaEnginePlugin, profileId: string): void {
  const ok = plugin.ai.editProfile(profileId);
  if (!ok) {
    new Notice(
      "GGAI Core 가 이 기능을 지원하지 않습니다. Core 를 최신 버전으로 업데이트해주세요."
    );
  }
}

/**
 * 번역/삽화/요약/외부 확장 패널 공용 — 모델 선택기.
 * 클릭=선택, 꾹 누르기=Core 프로필 편집, ⚙=Core 설정 열기(공용 킷과 동일 규칙).
 */
export function renderMediaModelPicker(opts: {
  plugin: StellaEnginePlugin;
  parent: HTMLElement;
  label: string;
  profiles: MediaModelProfile[];
  activeId: string | undefined;
  onSelect: (profileId: string) => void | Promise<void>;
  emptyText: string;
}): void {
  const block = opts.parent.createDiv({ cls: "ggai-media-block" });
  block.createDiv({ cls: "ggai-media-label", text: opts.label });
  renderModelPicker({
    parent: block,
    profiles: opts.profiles,
    activeId: opts.activeId,
    emptyText: opts.emptyText,
    onSelect: (p) => void opts.onSelect(p.id),
    onOpenSettings: () => openCoreSettings(opts.plugin),
    onLongPressEdit: (p) => editModelProfile(opts.plugin, p.id),
  });
}

/** 번역/삽화/요약/외부 확장 패널 공용 로어북 선택 — 클릭하면 모달에서 로딩·체크. meta.id 로 저장. */
export function renderMediaLorebookPicker(opts: {
  plugin: StellaEnginePlugin;
  parent: HTMLElement;
  label: string;
  selectedIds: string[];
  onToggle: (ids: string[]) => void | Promise<void>;
}): void {
  const block = opts.parent.createDiv({ cls: "ggai-media-block" });
  block.createDiv({ cls: "ggai-media-label", text: opts.label });
  const btn = block.createEl("button", {
    cls: "ggai-preset-btn ggai-media-lorebook-btn",
    text: "로어북 선택",
  });
  // 저장된 id 중 실제로 존재하는 로어북만 센다 — 삭제된 로어북의 잔여 id 가
  // "1개 선택됨"으로 계속 남아 보이던 문제 방지 (로어북 삭제 시 참조를 지우지 않음).
  const applyCount = (count: number) => {
    btn.setText(count > 0 ? `로어북 ${count}개 선택됨` : "로어북 선택");
    btn.toggleClass("is-active", count > 0);
  };
  applyCount(opts.selectedIds.length);
  void opts.plugin.store.getLorebooks().then((list) => {
    const existing = new Set(list.map((l) => l.lorebook.meta.id));
    applyCount(opts.selectedIds.filter((id) => existing.has(id)).length);
  });
  btn.addEventListener("click", () => {
    void LorebookSelectModal.open(opts.plugin, opts.selectedIds).then((ids) => {
      if (ids) void opts.onToggle(ids);
    });
  });
}

function getMediaUserPrompts(
  plugin: StellaEnginePlugin,
  bucket: PromptBucket
): MediaPromptItem[] {
  return [...(plugin.data.mediaPrompts?.[bucket] ?? [])];
}

function getMediaPrompts(
  plugin: StellaEnginePlugin,
  bucket: PromptBucket
): MediaPromptItem[] {
  // UI 표시용: 기본(내장) + 사용자 추가 목록.
  // 사용자가 기본 프롬프트를 편집하면 같은 builtin id 로 override 가 저장되며,
  // 여기서 기본값 위에 덮어 보여준다. "기본값으로 되돌리기"는 override 만 지운다.
  const defs = getDefaultPrompts(bucket as any);
  const users = getMediaUserPrompts(plugin, bucket);
  const overrides = new Map(
    users.filter((u) => isBuiltinMediaPrompt(u.id)).map((u) => [u.id, u])
  );
  const merged = defs.map((d) => overrides.get(d.id) ?? d);
  const userAdded = users.filter((u) => !isBuiltinMediaPrompt(u.id));
  return [...merged, ...userAdded];
}

/** 기본 프롬프트가 사용자 편집(override)으로 덮여 있는지. */
function isMediaBuiltinOverridden(
  plugin: StellaEnginePlugin,
  bucket: PromptBucket,
  promptId: string
): boolean {
  return getMediaUserPrompts(plugin, bucket).some((p) => p.id === promptId);
}

async function saveMediaPrompts(
  plugin: StellaEnginePlugin,
  bucket: PromptBucket,
  prompts: MediaPromptItem[]
): Promise<void> {
  await plugin.savePluginData({
    mediaPrompts: {
      ...(plugin.data.mediaPrompts ?? {}),
      [bucket]: prompts,
    },
  });
}

export interface MediaPromptPickerOptions {
  plugin: StellaEnginePlugin;
  parent: HTMLElement;
  label: string;
  bucket: PromptBucket;
  activeId: string | undefined;
  /** true 면 목록 맨 앞에 "없음" 버튼을 넣고, 아무 것도 안 골랐을 때 그것을 활성으로 둔다. */
  allowNone?: boolean;
  /** "없음" 버튼 라벨 (allowNone 일 때만). 생략 시 "없음". */
  noneLabel?: string;
  /** 편집/추가 모달의 프롬프트 입력란 아래에 붙일 안내(예: {{MAIN}} 사용법). */
  macroHint?: string;
  /** promptId 가 빈 문자열이면 "없음" 선택 (allowNone 일 때). */
  onSelect: (promptId: string) => void | Promise<void>;
  /** 프롬프트 라이브러리가 바뀌었을 때(추가/편집/기본값 복원) — 호출부가 자기 영역을 다시 그린다. */
  onChanged?: () => void;
  /** 선택 중이던 프롬프트가 삭제됐을 때 — 호출부가 그 선택 참조를 지우고 다시 그린다. */
  onDeleted?: (promptId: string) => void;
}

/**
 * 번역/삽화/요약/외부 확장 패널 공용 — 저장 프롬프트 선택 그리드.
 * 버튼 그리드 + ＋추가 + 꾹누르기/우클릭 메뉴(편집·삭제·기본값 되돌리기) + 내장/수정됨 표시.
 * (확장 탭의 번역/삽화/요약 패널이 공용으로 쓴다.)
 */
export function renderMediaPromptPicker(opts: MediaPromptPickerOptions): void {
  const block = opts.parent.createDiv({ cls: "ggai-media-block" });
  block.createDiv({ cls: "ggai-media-label", text: opts.label });
  const grid = block.createDiv({ cls: "ggai-preset-grid ggai-media-prompt-grid" });
  const prompts = getMediaPrompts(opts.plugin, opts.bucket);

  // allowNone 이면 아무 것도 안 고른 상태(빈 값)를 "없음"으로 그대로 두고,
  // 아니면 activeId 가 없을 때 첫 기본 프롬프트를 기본 선택으로 표시한다.
  const effectiveActive = opts.allowNone
    ? opts.activeId || ""
    : opts.activeId ?? getDefaultPrompts(opts.bucket as any)[0]?.id;

  if (opts.allowNone) {
    const noneBtn = grid.createEl("button", {
      cls: "ggai-preset-btn",
      text: opts.noneLabel ?? "없음",
    });
    if (!effectiveActive) noneBtn.addClass("is-active");
    noneBtn.addEventListener("click", () => void opts.onSelect(""));
  }

  for (const prompt of prompts) {
    const btn = grid.createEl("button", {
      cls: "ggai-preset-btn",
      text: prompt.title || "이름 없음",
    });
    if (prompt.id === effectiveActive) btn.addClass("is-active");
    if (isBuiltinMediaPrompt(prompt.id)) {
      btn.addClass("is-builtin");
      if (isMediaBuiltinOverridden(opts.plugin, opts.bucket, prompt.id)) {
        btn.addClass("is-modified");
      }
    }
    btn.addEventListener("click", () => void opts.onSelect(prompt.id));
    attachLongPress(btn, {
      onLongPress: (x, y) => openMediaPromptMenu(opts, prompt, x, y),
    });
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMediaPromptMenu(opts, prompt, e.clientX, e.clientY);
    });
  }

  const addBtn = grid.createEl("button", {
    cls: "ggai-preset-btn ggai-preset-add",
    attr: { "aria-label": `${opts.label} 추가` },
  });
  setIcon(addBtn, "plus");
  addBtn.addEventListener("click", () => void addMediaPrompt(opts));
}

function openMediaPromptMenu(
  opts: MediaPromptPickerOptions,
  prompt: MediaPromptItem,
  x: number,
  y: number
): void {
  const menu = new Menu();
  menu.addItem((mi) =>
    mi
      .setTitle("편집")
      .setIcon("pencil")
      .onClick(() => void editMediaPrompt(opts, prompt))
  );
  if (isBuiltinMediaPrompt(prompt.id)) {
    // 기본 프롬프트: 삭제 대신 "기본값으로 되돌리기" (편집된 경우에만).
    if (isMediaBuiltinOverridden(opts.plugin, opts.bucket, prompt.id)) {
      menu.addItem((mi) =>
        mi
          .setTitle("기본값으로 되돌리기")
          .setIcon("rotate-ccw")
          .onClick(() => void restoreDefaultMediaPrompt(opts, prompt.id))
      );
    }
  } else {
    menu.addItem((mi) =>
      mi
        .setTitle("삭제")
        .setIcon("trash-2")
        .onClick(() => void deleteMediaPrompt(opts, prompt))
    );
  }
  menu.showAtPosition({ x, y });
}

async function addMediaPrompt(opts: MediaPromptPickerOptions): Promise<void> {
  const result = await PromptEditModal.open(
    opts.plugin,
    "프롬프트 추가",
    { id: uuidv4(), title: "", prompt: "" },
    {
      bodyMacroHint: usesBodyMacro(opts.bucket),
      ioInstructions: getBucketIoInstructions(opts.bucket) ?? undefined,
      macroHint: opts.macroHint,
    }
  );
  if (!result) return;
  // 저장 시에는 사용자 프롬프트만 유지 (기본은 getMediaPrompts 에서 동적으로 병합)
  const nextUsers = [...getMediaUserPrompts(opts.plugin, opts.bucket), result];
  await saveMediaPrompts(opts.plugin, opts.bucket, nextUsers);
  await opts.onSelect(result.id);
  opts.onChanged?.();
}

async function editMediaPrompt(
  opts: MediaPromptPickerOptions,
  prompt: MediaPromptItem
): Promise<void> {
  const result = await PromptEditModal.open(opts.plugin, "프롬프트 편집", prompt, {
    bodyMacroHint: usesBodyMacro(opts.bucket),
    ioInstructions: getBucketIoInstructions(opts.bucket) ?? undefined,
    macroHint: opts.macroHint,
  });
  if (!result) return;
  // builtin id 는 그대로 유지되어 override 로 저장된다 (없으면 추가, 있으면 교체).
  const users = getMediaUserPrompts(opts.plugin, opts.bucket);
  const nextUsers = users.some((p) => p.id === prompt.id)
    ? users.map((p) => (p.id === prompt.id ? result : p))
    : [...users, result];
  await saveMediaPrompts(opts.plugin, opts.bucket, nextUsers);
  opts.onChanged?.();
}

/** 편집된 기본 프롬프트를 원래 기본값으로 되돌린다 (override 제거). */
async function restoreDefaultMediaPrompt(
  opts: MediaPromptPickerOptions,
  promptId: string
): Promise<void> {
  const nextUsers = getMediaUserPrompts(opts.plugin, opts.bucket).filter(
    (p) => p.id !== promptId
  );
  await saveMediaPrompts(opts.plugin, opts.bucket, nextUsers);
  opts.onChanged?.();
}

async function deleteMediaPrompt(
  opts: MediaPromptPickerOptions,
  prompt: MediaPromptItem
): Promise<void> {
  if (isBuiltinMediaPrompt(prompt.id)) {
    new Notice("기본 프롬프트는 삭제할 수 없습니다.");
    return;
  }
  const nextUsers = getMediaUserPrompts(opts.plugin, opts.bucket).filter(
    (p) => p.id !== prompt.id
  );
  await saveMediaPrompts(opts.plugin, opts.bucket, nextUsers);
  opts.onDeleted?.(prompt.id);
}

/** 미디어 프롬프트 추가/편집 모달 — 확장 설정 패널과 문단 재생성 패널이 공용. */
export class PromptEditModal extends Modal {
  private titleValue: string;
  private promptValue: string;
  private settled = false;

  static open(
    plugin: StellaEnginePlugin,
    title: string,
    initial: MediaPromptItem,
    opts?: { bodyMacroHint?: boolean; ioInstructions?: string; macroHint?: string }
  ): Promise<MediaPromptItem | null> {
    return new Promise((resolve) => {
      new PromptEditModal(plugin, title, initial, resolve, opts).open();
    });
  }

  private constructor(
    plugin: StellaEnginePlugin,
    private readonly modalTitle: string,
    private readonly initial: MediaPromptItem,
    private readonly onResult: (value: MediaPromptItem | null) => void,
    private readonly opts?: {
      bodyMacroHint?: boolean;
      ioInstructions?: string;
      macroHint?: string;
    }
  ) {
    super(plugin.app);
    this.titleValue = initial.title;
    this.promptValue = initial.prompt;
  }

  onOpen(): void {
    this.titleEl.setText(this.modalTitle);
    const { toolbar, body, footerMain } = createModalShell(this, "m", {
      toolbar: true,
    });
    body.addClass("ggai-modal-body-col");

    new Setting(toolbar!).setName("제목").addText((text) =>
      text.setValue(this.titleValue).onChange((value) => {
        this.titleValue = value;
      })
    );

    const field = body.createDiv({ cls: "ggai-media-modal-field ggai-modal-grow" });
    field.createDiv({ cls: "ggai-media-label", text: "프롬프트" });
    // 고정 형식 지시가 있는 버킷은 입력란 안에 실제 결합 위치대로(지침이 프롬프트 앞)
    // 반투명·수정 불가 텍스트로 함께 보여준다. 지침과 입력란은 하나의 스크롤 상자로
    // 묶어(compose 가 유일한 스크롤러), 지침 밑에 프롬프트가 이어지는 한 칸처럼 보인다.
    const hasIo = !!this.opts?.ioInstructions;
    const compose = hasIo
      ? field.createDiv({ cls: "ggai-media-prompt-compose" })
      : null;
    if (compose && this.opts?.ioInstructions) {
      compose.createEl("pre", {
        cls: "ggai-media-io-inline",
        text: this.opts.ioInstructions,
      });
    }
    const textarea = (compose ?? field).createEl("textarea", {
      cls: "ggai-form-textarea",
    });
    textarea.value = this.promptValue;
    // 지침과 한 스크롤 상자로 묶인 경우 textarea 자체는 스크롤하지 않고 내용 높이에
    // 맞춰 늘어난다 — 스크롤은 바깥 compose 하나만 생긴다.
    const autosize = () => {
      if (!compose) return;
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight + 2}px`;
    };
    textarea.addEventListener("input", () => {
      this.promptValue = textarea.value;
      autosize();
    });
    // 레이아웃이 잡힌 뒤에야 내용 높이를 잴 수 있다 (setTimeout(0) 이면 아직 폭 반영 전이라
    // scrollHeight 가 작게 잡혀 마지막 줄이 잘려 보일 수 있다).
    if (compose) window.requestAnimationFrame(autosize);

    if (this.opts?.bodyMacroHint) {
      field.createDiv({
        cls: "ggai-media-hint",
        text:
          "본문은 자동으로 맨 앞에 붙습니다. 지침 안에 {{main}} 을 쓰면 그 위치에 본문이, " +
          "{{lorebook}} 을 쓰면 그 위치에 로어북이 들어갑니다 (예: ({{main}}) → 괄호 안에 본문).",
      });
    }
    if (this.opts?.macroHint) {
      field.createDiv({ cls: "ggai-media-hint", text: this.opts.macroHint });
    }

    const cancelBtn = footerMain.createEl("button", { cls: "ggai-btn", text: "취소" });
    cancelBtn.addEventListener("click", () => this.settle(null));
    const saveBtn = footerMain.createEl("button", {
      cls: "ggai-btn ggai-btn-primary",
      text: "저장",
    });
    saveBtn.addEventListener("click", () => {
      const title = this.titleValue.trim();
      const prompt = this.promptValue.trim();
      if (!title || !prompt) {
        new Notice("제목과 프롬프트를 모두 입력해주세요.");
        return;
      }
      this.settle({ ...this.initial, title, prompt });
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.onResult(null);
  }

  private settle(value: MediaPromptItem | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onResult(value);
    this.close();
  }
}
