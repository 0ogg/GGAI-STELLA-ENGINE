import { Menu, Notice } from "obsidian";
import type StellaEnginePlugin from "../main";
import { generateSessionTitleNow } from "../services/session-title-service";
import type { SessionListItem } from "../util/scan-sessions";
import {
  confirmDeleteSession,
  copySession,
  exportSessionReading,
  openSessionByPath,
  promptRenameSession,
} from "./entity-actions";
import { NextEpisodeModal } from "./next-episode-modal";

export interface SessionMenuOptions {
  /** 노드·가지치기 화면을 가진 호스트(대시보드)만 넘긴다. 없으면 항목 미표시. */
  onBranch?: () => void;
  /** 이름 변경 후처리(뷰 retarget 등)가 필요한 호스트용 오버라이드. */
  onRename?: () => void;
  /** 복제 후처리가 필요한 호스트용 오버라이드. */
  onCopy?: () => void;
}

/**
 * 세션 공용 메뉴 — 사이드바/대시보드 세션 탭/시나리오 상세 어디서 열든
 * (우클릭·롱프레스·⋮ 버튼) 같은 항목을 같은 순서로 보여준다.
 * 화면마다 메뉴 구성이 달라 기능이 숨는 문제 방지 — 새 항목은 여기에만 추가한다.
 */
export function buildSessionMenu(
  plugin: StellaEnginePlugin,
  s: SessionListItem,
  opts?: SessionMenuOptions
): Menu {
  const menu = new Menu();
  menu.addItem((mi) =>
    mi
      .setTitle("이어하기")
      .setIcon("play")
      .onClick(() => void openSessionByPath(plugin, s.sessionFile))
  );
  if (opts?.onBranch) {
    menu.addItem((mi) =>
      mi
        .setTitle("노드 · 가지치기")
        .setIcon("git-branch")
        .onClick(() => opts.onBranch!())
    );
  }
  menu.addItem((mi) =>
    mi
      .setTitle("다음화 만들기")
      .setIcon("book-plus")
      .onClick(() =>
        new NextEpisodeModal(plugin.app, plugin, s.sessionFile).open()
      )
  );
  menu.addItem((mi) =>
    mi
      .setTitle("읽기 모드로 내보내기")
      .setIcon("file-down")
      .onClick(() => exportSessionReading(plugin, s))
  );
  menu.addItem((mi) =>
    mi
      .setTitle("제목 생성")
      .setIcon("sparkles")
      .onClick(() => void generateTitle(plugin, s))
  );
  menu.addItem((mi) =>
    mi
      .setTitle("제목 변경")
      .setIcon("text-cursor-input")
      .onClick(() =>
        opts?.onRename ? opts.onRename() : promptRenameSession(plugin, s)
      )
  );
  menu.addItem((mi) =>
    mi
      .setTitle("복제")
      .setIcon("copy")
      .onClick(() =>
        opts?.onCopy
          ? opts.onCopy()
          : void copySession(plugin, s, (newFile) =>
              openSessionByPath(plugin, newFile)
            )
      )
  );
  menu.addItem((mi) =>
    mi
      .setTitle(s.session.meta.favorite ? "즐겨찾기 해제" : "즐겨찾기")
      .setIcon("star")
      .onClick(() => void toggleFavorite(plugin, s))
  );
  menu.addSeparator();
  menu.addItem((mi) =>
    mi
      .setTitle("삭제")
      .setIcon("trash-2")
      .onClick(() => confirmDeleteSession(plugin, s))
  );
  return menu;
}

async function toggleFavorite(
  plugin: StellaEnginePlugin,
  s: SessionListItem
): Promise<void> {
  try {
    await plugin.store.toggleSessionFavorite(s.sessionFile);
  } catch (err) {
    new Notice(
      `세션 즐겨찾기 저장 실패: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function generateTitle(
  plugin: StellaEnginePlugin,
  s: SessionListItem
): Promise<void> {
  new Notice("제목 생성 중…");
  const result = await generateSessionTitleNow(plugin, s.sessionFile);
  if (!result.ok) {
    new Notice(`제목 생성 실패: ${result.error}`);
    return;
  }
  new Notice(`제목 생성: ${result.title}`);
}
