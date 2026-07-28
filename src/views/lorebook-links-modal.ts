import { Modal, Notice, setIcon } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { LorebookListItem } from "../util/scan-lorebooks";
import {
  collectLorebookLinks,
  collectSessionLorebooks,
  LOREBOOK_LINK_LABELS,
  type LorebookLink,
} from "../util/lorebook-owners";
import { createModalShell } from "./modal-shell";
import { openSessionByPath } from "./entity-actions";

/**
 * 로어북 ↔ 세션/시나리오 연결 보기 (양방향).
 *
 *  - `openForBook`: 이 책을 쓰는 시나리오/세션 목록. 줄을 누르면 그리로 이동.
 *  - `openForSession`: 이 세션에 연결된 책 목록. 줄을 누르면 **그 책의 편집 페이지로 직행**
 *    (로어북 탭에서 찾아 들어가는 수고를 없애는 것이 이 화면의 요점).
 *
 * 세션 단위 연결까지 세려면 세션 파일을 훑어야 해서, 목록은 열 때 한 번 집계한다.
 */
export class LorebookLinksModal extends Modal {
  private constructor(
    private readonly plugin: StellaEnginePlugin,
    private readonly title: string,
    private readonly fill: (
      body: HTMLElement,
      close: () => void
    ) => Promise<void>
  ) {
    super(plugin.app);
  }

  /** 이 로어북을 사용 중인 시나리오/세션 보기. */
  static openForBook(plugin: StellaEnginePlugin, item: LorebookListItem): void {
    const name = item.lorebook.meta.name || item.folderName;
    new LorebookLinksModal(
      plugin,
      `"${name}" 사용 중인 곳`,
      async (body, close) => {
        const links = await collectLorebookLinks(
          plugin.store,
          item.lorebook.meta.id
        );
        if (links.length === 0) {
          body.createDiv({
            cls: "ggai-detail-empty",
            text: "이 로어북을 사용하는 시나리오나 세션이 없습니다.",
          });
          return;
        }
        for (const link of links) renderLinkRow(plugin, body, link, close);
      }
    ).open();
  }

  /** 이 세션에 연결된 로어북 보기 — 줄 클릭 = 그 책 편집 페이지로. */
  static openForSession(
    plugin: StellaEnginePlugin,
    sessionFile: string,
    sessionName: string
  ): void {
    new LorebookLinksModal(
      plugin,
      `"${sessionName}" 연결된 로어북`,
      async (body, close) => {
        const rows = await collectSessionLorebooks(plugin.store, sessionFile);
        if (rows.length === 0) {
          body.createDiv({
            cls: "ggai-detail-empty",
            text: "이 세션에 연결된 로어북이 없습니다.",
          });
          return;
        }
        for (const row of rows) {
          const name = row.item.lorebook.meta.name || row.item.folderName;
          const meta = [
            row.label,
            `${row.item.lorebook.entries.length} 항목`,
            row.disabled ? "이 세션에서 꺼짐" : "",
          ]
            .filter((s) => s)
            .join(" · ");
          renderRow(body, {
            icon: "book-open",
            goIcon: "pencil",
            name,
            meta,
            faint: row.disabled,
            onOpen: () => {
              close();
              void plugin.openStellaEditor("lorebook", row.item.lorebookFile);
            },
          });
        }
      }
    ).open();
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(this.title);
    const { body, footerMain } = createModalShell(this, "l");
    const closeBtn = footerMain.createEl("button", {
      cls: "ggai-btn",
      text: "닫기",
    });
    closeBtn.addEventListener("click", () => this.close());

    const loading = body.createDiv({
      cls: "ggai-detail-empty",
      text: "불러오는 중…",
    });
    try {
      await this.fill(body.createDiv({ cls: "ggai-lore-link-list" }), () =>
        this.close()
      );
      loading.remove();
    } catch (err) {
      body.empty();
      body.createDiv({
        cls: "ggai-detail-empty",
        text: `불러오기 실패: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

interface RowSpec {
  icon: string;
  goIcon: string;
  name: string;
  meta: string;
  faint?: boolean;
  onOpen: () => void;
}

function renderRow(parent: HTMLElement, spec: RowSpec): void {
  const el = parent.createDiv({ cls: "ggai-lore-link-row" });
  if (spec.faint) el.addClass("is-faint");
  const icon = el.createSpan({ cls: "ggai-lore-link-icon" });
  setIcon(icon, spec.icon);
  const text = el.createDiv({ cls: "ggai-lore-link-text" });
  text.createDiv({ cls: "ggai-lore-link-name", text: spec.name });
  text.createDiv({ cls: "ggai-lore-link-meta", text: spec.meta });
  const go = el.createSpan({ cls: "ggai-lore-link-go" });
  setIcon(go, spec.goIcon);
  el.setAttr("role", "button");
  el.setAttr("tabindex", "0");
  el.addEventListener("click", spec.onOpen);
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    spec.onOpen();
  });
}

/** 시나리오/세션 한 줄 — 클릭하면 그 세션을 열거나 시나리오 편집기로 간다. */
function renderLinkRow(
  plugin: StellaEnginePlugin,
  parent: HTMLElement,
  link: LorebookLink,
  close: () => void
): void {
  const label = LOREBOOK_LINK_LABELS[link.kind];
  renderRow(parent, {
    icon: link.sessionFile ? "play" : "scroll-text",
    goIcon: "chevron-right",
    name: link.sessionFile
      ? `${link.scenarioName} · ${link.sessionName}`
      : link.scenarioName,
    meta: link.sessionFile ? `세션 · ${label}` : `시나리오 · ${label}`,
    onOpen: () => {
      close();
      if (link.sessionFile) {
        void openSessionByPath(plugin, link.sessionFile).catch((err) => {
          new Notice(
            `세션 열기 실패: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      } else {
        void plugin.openStellaEditor("scenario", link.scenarioFile);
      }
    },
  });
}
