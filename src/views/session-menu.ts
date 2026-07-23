import { Menu, Notice } from "obsidian";
import type StellaEnginePlugin from "../main";
import { generateSessionTitleNow } from "../services/session-title-service";
import type { SessionListItem } from "../util/scan-sessions";
import {
  confirmDeleteSession,
  copySession,
  exportSessionReading,
  openGroupMemberManager,
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
  // 선채팅(P1) — 챗 세션 전용. 세션창의 종 버튼과 같은 설정을 대시보드/사이드바에서도.
  if (s.session.meta.mode === "chat") {
    const pa = s.session.meta.proactive;
    menu.addItem((mi) =>
      mi
        .setTitle(pa?.enabled === true ? "선채팅 끄기" : "선채팅 켜기")
        .setIcon("bell")
        .onClick(() => void toggleProactiveSetting(plugin, s, "enabled"))
    );
    menu.addItem((mi) =>
      mi
        .setTitle(
          pa?.realtime === true ? "실시간 채팅 끄기" : "실시간 채팅 켜기"
        )
        .setIcon("clock")
        .onClick(() => void toggleProactiveSetting(plugin, s, "realtime"))
    );
  }
  // 스텔라튜브 방송 (v2) — 이 세션의 장면을 생중계 + 실시간 채팅.
  {
    const live = plugin.phone.isSessionLive(s.sessionFile);
    menu.addItem((mi) =>
      mi
        .setTitle(
          live ? "방송 종료 (스텔라튜브)" : "이 장면 방송하기 (스텔라튜브)"
        )
        .setIcon("radio-tower")
        .onClick(() => void toggleStream(plugin, s))
    );
  }
  // 그룹 채팅 관리 (G1/G3) — 멤버 + 대화 설정. 그룹 세션에만.
  if (s.session.meta.groupId) {
    menu.addItem((mi) =>
      mi
        .setTitle("그룹 채팅 관리")
        .setIcon("users")
        .onClick(() => void openGroupMemberManager(plugin, s.sessionFile))
    );
  }
  menu.addSeparator();
  menu.addItem((mi) =>
    mi
      .setTitle("삭제")
      .setIcon("trash-2")
      .onClick(() => confirmDeleteSession(plugin, s))
  );
  return menu;
}

/** 선채팅 세션 설정 토글 — store 경유 저장, 열린 세션창은 session-changed 로 동기화. */
export async function toggleProactiveSetting(
  plugin: StellaEnginePlugin,
  s: SessionListItem,
  key: "enabled" | "realtime"
): Promise<void> {
  try {
    const session = await plugin.store.getSession(s.sessionFile);
    if (!session) throw new Error("세션을 불러올 수 없습니다.");
    const next = session.meta.proactive?.[key] !== true;
    session.meta.proactive = { ...(session.meta.proactive ?? {}), [key]: next };
    await plugin.store.saveSession(s.sessionFile, session);
    new Notice(
      key === "enabled"
        ? next
          ? "선채팅 켜짐 — 이 세션의 캐릭터가 먼저 말을 걸 수 있습니다."
          : "선채팅 꺼짐"
        : next
          ? "실시간 채팅 켜짐 — 선채팅이 현재 시간과 지난 시간을 인지합니다."
          : "실시간 채팅 꺼짐"
    );
  } catch (err) {
    new Notice(
      `선채팅 설정 저장 실패: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** 스텔라튜브 방송 토글 (v2) — 시작/종료 모두 여기서. */
async function toggleStream(
  plugin: StellaEnginePlugin,
  s: SessionListItem
): Promise<void> {
  const result = await plugin.phone.toggleStream(s.sessionFile);
  if (!result.ok) {
    new Notice(`방송 실패: ${result.error}`);
    return;
  }
  new Notice(
    result.live
      ? "🔴 스텔라튜브 방송 시작 — 이 세션의 장면이 생중계됩니다."
      : "방송 종료 — 스텔라튜브에 다시보기가 남았습니다."
  );
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
