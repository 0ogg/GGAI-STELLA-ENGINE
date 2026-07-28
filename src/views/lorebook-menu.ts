import { Menu, Notice } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { LorebookListItem } from "../util/scan-lorebooks";
import {
  promoteLorebookToLibrary,
  toggleLorebookKeep,
} from "../util/lorebook-owners";
import { confirmDeleteLorebook, exportLorebook } from "./entity-actions";
import { LorebookLinksModal } from "./lorebook-links-modal";

/**
 * 로어북 공용 메뉴 — 사이드바/대시보드 어디서 열든 같은 항목을 같은 순서로.
 * 화면마다 메뉴가 달라 기능이 숨는 문제 방지 — 새 항목은 여기에만 추가한다.
 * 자동 생성 북(소속 있음)에만 보관/승격 항목이 붙는다.
 */
export function buildLorebookMenu(
  plugin: StellaEnginePlugin,
  item: LorebookListItem,
  opts?: { onEdit?: () => void }
): Menu {
  const menu = new Menu();
  menu.addItem((mi) =>
    mi
      .setTitle("편집")
      .setIcon("pencil")
      .onClick(() =>
        opts?.onEdit
          ? opts.onEdit()
          : void plugin.openStellaEditor("lorebook", item.lorebookFile)
      )
  );
  menu.addItem((mi) =>
    mi
      .setTitle("사용 중인 곳 보기")
      .setIcon("link")
      .onClick(() => LorebookLinksModal.openForBook(plugin, item))
  );
  menu.addItem((mi) =>
    mi
      .setTitle("내보내기")
      .setIcon("upload")
      .onClick(() => void exportLorebook(plugin, item.lorebookFile))
  );
  if (item.lorebook.meta.owner) {
    menu.addSeparator();
    menu.addItem((mi) =>
      mi
        .setTitle(item.lorebook.meta.keep === true ? "보관 해제" : "보관")
        .setIcon("archive")
        .onClick(() => void handleToggleKeep(plugin, item))
    );
    menu.addItem((mi) =>
      mi
        .setTitle("내 서재로 승격")
        .setIcon("library")
        .onClick(() => void handlePromote(plugin, item))
    );
  }
  menu.addSeparator();
  menu.addItem((mi) =>
    mi
      .setTitle("삭제")
      .setIcon("trash-2")
      .onClick(() => confirmDeleteLorebook(plugin, item))
  );
  return menu;
}

async function handleToggleKeep(
  plugin: StellaEnginePlugin,
  item: LorebookListItem
): Promise<void> {
  try {
    const on = await toggleLorebookKeep(plugin.store, item);
    new Notice(
      on
        ? "보관됨 — 세션을 지워도 이 책은 정리 대상에서 빠집니다."
        : "보관 해제됨"
    );
  } catch (err) {
    new Notice(
      `보관 설정 실패: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handlePromote(
  plugin: StellaEnginePlugin,
  item: LorebookListItem
): Promise<void> {
  try {
    await promoteLorebookToLibrary(plugin.store, item);
    new Notice("내 서재로 옮겼습니다 — 이제 일반 로어북으로 관리됩니다.");
  } catch (err) {
    new Notice(
      `승격 실패: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
