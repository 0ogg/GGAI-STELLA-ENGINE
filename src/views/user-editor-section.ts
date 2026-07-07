import { EventRef, Notice, debounce } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { StellaUserProfile } from "../types/user";
import type { ScenarioListItem } from "../util/scan-scenarios";
import { EditGuard } from "./edit-guard";
import {
  renderEditableTitle,
  renderEditorCover,
  renderIconActionButton,
} from "./editor-cover";
import { type FieldDef, renderForm } from "./form-renderer";
import { ConfirmModal } from "./modals";

const SAVE_DEBOUNCE_MS = 400;

const USER_FIELDS: FieldDef[] = [
  // 이름은 상단 헤더(클릭 편집)에서 다룬다 — 폼에서는 제외.
  { kind: "text", key: "description", label: "설정", rows: 10 },
];

export interface UserEditorSectionOpts {
  /** 삭제 후 편집 페이지를 벗어날 때(대시보드 뒤로가기 등). */
  onClose: () => void;
}

/**
 * 페르소나 편집기 — 대시보드 내부 페이지로 임베드되는 편집 섹션.
 *
 * 예전 UserEditorView(별도 뷰) 의 편집/자동 저장 로직을 그대로 옮기되, 상단 nav 는
 * 대시보드가 소유하므로 여기서 그리지 않는다. 라우트 이동/뷰 종료 시 dispose() 가
 * 구독 해제 + 미저장 편집 flush 를 책임진다 (BranchSection 과 같은 임베드 패턴).
 */
export class UserEditorSection {
  private root: HTMLElement;
  private userFile: string | null;
  private profile: StellaUserProfile | null = null;
  private scenarios: ScenarioListItem[] = [];
  private dirty = false;
  /** 조합/포커스/자기저장 공용 가드 — 복붙 금지, edit-guard.ts 참조. */
  private guard = new EditGuard();
  private eventRef: EventRef | null = null;

  private visibilityHandler = (): void => {
    if (document.visibilityState === "hidden") void this.flushNow();
    else if (!this.dirty && !this.guard.isEditing()) {
      void this.reloadAndRender();
    }
  };
  private blurHandler = (): void => void this.flushNow();

  constructor(
    container: HTMLElement,
    private plugin: StellaEnginePlugin,
    userFile: string,
    private opts: UserEditorSectionOpts
  ) {
    this.root = container.createDiv({ cls: "ggai-user-editor ggai-editor-embed" });
    this.userFile = userFile;
    // root 는 render() 에서 empty() 될 뿐 교체되지 않아 리스너가 살아남는다.
    this.guard.attach(this.root);
  }

  async load(): Promise<void> {
    this.scenarios = await this.plugin.store.getScenarios().catch(() => []);
    await this.reloadAndRender();
    this.eventRef = this.plugin.store.on("user-profile-changed", (file: string) => {
      if (file !== this.userFile || this.dirty || this.guard.isSavingSelf) return;
      if (this.guard.isEditing()) return;
      void this.reloadAndRender();
    });
    document.addEventListener("visibilitychange", this.visibilityHandler);
    window.addEventListener("blur", this.blurHandler);
  }

  /** 라우트 이동/뷰 종료 시 호출 — 구독 해제 + 미저장 편집 확정. */
  async dispose(): Promise<void> {
    if (this.eventRef) {
      this.plugin.store.offref(this.eventRef);
      this.eventRef = null;
    }
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    window.removeEventListener("blur", this.blurHandler);
    await this.flushNow();
  }

  private async reloadAndRender(): Promise<void> {
    if (!this.userFile) {
      this.profile = null;
      this.render();
      return;
    }
    this.profile = await this.plugin.store.refreshUserProfile(this.userFile);
    this.scenarios = await this.plugin.store.getScenarios().catch(() => []);
    this.dirty = false;
    this.render();
  }

  private render(): void {
    this.root.empty();
    const profile = this.profile;
    if (!profile) {
      this.root.createDiv({
        cls: "ggai-detail-empty",
        text: this.userFile
          ? "페르소나 파일을 찾을 수 없습니다."
          : "페르소나를 선택하세요.",
      });
      return;
    }

    const header = this.root.createDiv({ cls: "ggai-editor-header is-hero" });
    this.renderCover(header);
    renderEditableTitle(header, profile.name || "페르소나", (next) => {
      profile.name = next;
      this.requestSave();
      this.render();
    });

    const actions = header.createDiv({ cls: "ggai-editor-actions" });
    renderIconActionButton(actions, {
      icon: "copy",
      label: "복제",
      onClick: () => void this.handleDuplicate(),
    });
    if (profile.id !== "default") {
      renderIconActionButton(actions, {
        icon: "trash-2",
        label: "삭제",
        danger: true,
        onClick: () => this.handleDelete(),
      });
    }

    renderForm(
      this.root,
      USER_FIELDS,
      profile as unknown as Record<string, any>,
      (key, value) => {
        (profile as any)[key] = value;
        this.requestSave();
      },
      () => void this.flushNow()
    );

    this.renderDedicatedScenarios(profile);
  }

  /**
   * 전용 시나리오 선택 — 체크한 시나리오를 시작/열면 활성 페르소나가 이 페르소나로
   * 자동 전환된다. 시나리오 stella id 로 저장한다.
   */
  private renderDedicatedScenarios(profile: StellaUserProfile): void {
    const wrap = this.root.createDiv({ cls: "ggai-user-scenarios" });
    wrap.createDiv({ cls: "ggai-field-label", text: "전용 시나리오" });
    wrap.createDiv({
      cls: "ggai-field-hint",
      text: "선택한 시나리오를 시작하면 이 페르소나로 자동 시작합니다.",
    });

    if (this.scenarios.length === 0) {
      wrap.createDiv({ cls: "ggai-detail-empty", text: "시나리오가 없습니다." });
      return;
    }

    const selected = new Set(profile.scenarioIds ?? []);
    const list = wrap.createDiv({ cls: "ggai-user-scenario-list" });
    for (const item of this.scenarios) {
      const sid = item.scenario.data?.extensions?.stella?.id;
      if (!sid) continue;
      const name = item.scenario.data.name || item.folderName;
      const row = list.createEl("label", { cls: "ggai-user-scenario-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = selected.has(sid);
      row.createSpan({ text: name });
      cb.addEventListener("change", () => {
        const next = new Set(profile.scenarioIds ?? []);
        if (cb.checked) next.add(sid);
        else next.delete(sid);
        profile.scenarioIds = Array.from(next);
        this.requestSave();
      });
    }
  }

  private renderCover(parent: HTMLElement): void {
    const profile = this.profile;
    if (!profile || !this.userFile) return;
    const folder = this.userFile.slice(0, this.userFile.lastIndexOf("/"));
    const path = profile.thumbnail ? `${folder}/${profile.thumbnail}` : null;
    renderEditorCover(this.plugin.app, parent, {
      imagePath: path,
      altText: profile.name,
      fallbackIcon: "user",
      onPick: async (bytes, ext) => {
        if (!this.userFile) return;
        try {
          await this.plugin.store.setUserThumbnail(this.userFile, bytes, ext);
          await this.reloadAndRender();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`표지 저장 실패: ${msg}`);
        }
      },
    });
  }

  private debouncedSave = debounce(
    () => void this.flushNow(),
    SAVE_DEBOUNCE_MS,
    true
  );

  private async flushNow(): Promise<void> {
    if (!this.dirty || !this.userFile || !this.profile) return;
    const file = this.userFile;
    const profile = this.profile;
    try {
      await this.guard.runSave(() =>
        this.plugin.store.saveUserProfile(file, profile)
      );
      this.dirty = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`페르소나 저장 실패: ${msg}`);
    }
  }

  private requestSave(): void {
    this.dirty = true;
    this.debouncedSave();
  }

  private async handleDuplicate(): Promise<void> {
    if (!this.userFile) return;
    await this.flushNow();
    try {
      const result = await this.plugin.store.copyUserProfile(this.userFile);
      await this.plugin.openStellaEditor("user", result.userFile);
      new Notice(`페르소나 복사: ${result.profile.name}`);
    } catch (err) {
      new Notice(
        `페르소나 복사 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private handleDelete(): void {
    if (!this.userFile || !this.profile) return;
    const userFile = this.userFile;
    const name = this.profile.name;
    new ConfirmModal(
      this.plugin.app,
      "페르소나 삭제",
      `"${name}" 페르소나를 휴지통으로 옮깁니다. 계속할까요?`,
      "삭제",
      (confirmed) => {
        if (!confirmed) return;
        void (async () => {
          try {
            this.dirty = false;
            await this.plugin.store.deleteUserProfile(userFile);
            new Notice(`삭제됨: ${name} · 휴지통에서 복구할 수 있어요`);
            this.opts.onClose();
          } catch (err) {
            new Notice(
              `삭제 실패: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })();
      }
    ).open();
  }
}
