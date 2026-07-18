/**
 * 연락처 관리 모달 (폰 v2 §3.1) — 후보 시나리오 전체를 "표지 + 이름" 목록으로
 * 보여주고, 체크 = 등록 / 체크 해제 = 연락처 삭제(스레드 삭제 동반, 확인 1회).
 * 저장은 기존 registerContact/unregisterContact 재사용.
 */
import { Modal, Notice } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { PhoneContact } from "../util/phone-contacts";
import { renderThumb } from "../util/render-thumb";
import { ConfirmModal } from "./modals";

export class PhoneContactModal extends Modal {
  constructor(
    private plugin: StellaEnginePlugin,
    private personaId: string,
    private personaFile: string,
    private onChanged: () => void
  ) {
    super(plugin.app);
    (this as unknown as { shouldRestoreSelection?: boolean }).shouldRestoreSelection =
      false;
  }

  onOpen(): void {
    this.contentEl.addClass("ggai-phone-contact-modal");
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "연락처" });
    contentEl.createDiv({
      cls: "ggai-phone-contact-modal-sub",
      text: "세션을 함께 한 캐릭터입니다. 체크한 캐릭터만 문자를 주고받습니다.",
    });

    const [registered, candidates] = await Promise.all([
      this.plugin.phone.listContacts(this.personaFile, this.personaId),
      this.plugin.phone.listContactCandidates(this.personaFile, this.personaId),
    ]);
    const registeredIds = new Set(registered.map((c) => c.scenarioId));
    const all: PhoneContact[] = [...registered, ...candidates];
    if (all.length === 0) {
      contentEl.createDiv({
        cls: "ggai-phone-contact-modal-empty",
        text: "아직 후보가 없습니다 — 이 페르소나로 세션을 먼저 플레이해 보세요.",
      });
      return;
    }

    const list = contentEl.createDiv({ cls: "ggai-phone-contact-modal-list" });
    for (const c of all) {
      const row = list.createDiv({ cls: "ggai-phone-contact-modal-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = registeredIds.has(c.scenarioId);
      const thumb = row.createDiv({ cls: "ggai-phone-contact-modal-thumb" });
      renderThumb(this.app, thumb, c.thumbnailPath, c.name, "user");
      row.createDiv({ cls: "ggai-phone-contact-modal-name", text: c.name });
      row.addEventListener("click", (e) => {
        if (e.target !== cb) cb.click();
      });
      cb.addEventListener("change", () => {
        if (cb.checked) {
          void this.plugin.phone
            .registerContact(this.personaId, c.scenarioId)
            .then(() => this.onChanged())
            .catch((err) => {
              cb.checked = false;
              new Notice(
                `스텔라 폰: ${err instanceof Error ? err.message : String(err)}`
              );
            });
          return;
        }
        // 해제 = 대화 삭제 동반 — 확인 1회.
        new ConfirmModal(
          this.app,
          "연락처 해제",
          `${c.name}을(를) 연락처에서 지우고 대화도 삭제합니다.`,
          "해제",
          (confirmed) => {
            if (!confirmed) {
              cb.checked = true;
              return;
            }
            void this.plugin.phone
              .unregisterContact(this.personaId, c.scenarioId)
              .then(() => this.onChanged())
              .catch((err) => {
                cb.checked = true;
                new Notice(
                  `스텔라 폰: ${err instanceof Error ? err.message : String(err)}`
                );
              });
          }
        ).open();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
