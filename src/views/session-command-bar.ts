/**
 * 세션창 공용 조작 진입점 두 가지.
 *
 *  1) renderHeaderCommandBar — Commander(cmdr) 플러그인의 "페이지 헤더" 버튼을
 *     PC 세션창 상단 좌측에 그려 준다. 모바일은 뷰 헤더(제목줄)가 항상 보여서
 *     Commander 버튼이 그대로 뜨지만, PC 에서 탭 제목줄을 꺼 두면
 *     (showViewHeader: false) 버튼이 들어갈 자리째 사라진다 — 그 경우를 스텔라가
 *     대신 그려서 모바일에서 추가한 버튼이 PC 에서도 보이게 한다.
 *     제목줄이 켜져 있으면 Commander 가 원래 자리에 그리므로 중복 방지로 건너뛴다.
 *  2) openExtensionActionsMenu — 하단 툴바 확장 버튼(퍼즐)이 여는 조작 액션 트레이.
 *     확장(`plugin.extensions`)이 `sessionActions` 로 등록한 액션 목록을 띄운다.
 *
 * 소설/챗 세션 뷰가 공유한다 — 뷰별로 복붙하지 않는다.
 */

import { Menu, Notice, Platform, setIcon, type App } from "obsidian";
import type StellaEnginePlugin from "../main";

interface CommandLike {
  id: string;
  name: string;
  icon?: string;
}

/** Commander 페이지 헤더 버튼 항목 (cmdr data.json 의 pageHeader 배열 원소). */
interface CmdrPageHeaderEntry {
  id: string;
  icon?: string;
  name?: string;
  mode?: string;
}

/** 옵시디언 내부 설정 읽기 (미설정이면 undefined = 기본값). */
function getVaultConfig(app: App, key: string): unknown {
  return (
    app.vault as unknown as { getConfig?: (key: string) => unknown }
  ).getConfig?.(key);
}

/**
 * Commander 플러그인의 페이지 헤더 버튼 목록을 읽는다. 미설치/미설정이면 [].
 * mode 는 Commander 규칙 그대로: "any"(모든 기기) / "mobile" / "desktop" / 특정 기기 id.
 * 이 바는 "모바일 제목줄에 보이는 버튼의 PC 미러"이므로 any·mobile 만 담는다.
 */
function getCommanderPageHeaderEntries(app: App): CmdrPageHeaderEntry[] {
  const cmdr = (
    app as unknown as {
      plugins?: {
        plugins?: Record<string, { settings?: { pageHeader?: unknown } }>;
      };
    }
  ).plugins?.plugins?.["cmdr"];
  const list = cmdr?.settings?.pageHeader;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is CmdrPageHeaderEntry =>
      !!e &&
      typeof (e as { id?: unknown }).id === "string" &&
      ((e as { mode?: unknown }).mode === "any" ||
        (e as { mode?: unknown }).mode === "mobile")
  );
}

function findCommand(app: App, id: string): CommandLike | null {
  const commands = (
    app as unknown as {
      commands?: { findCommand?: (id: string) => CommandLike | undefined };
    }
  ).commands;
  return commands?.findCommand?.(id) ?? null;
}

function executeCommand(app: App, id: string): void {
  const commands = (
    app as unknown as {
      commands?: { executeCommandById?: (id: string) => boolean };
    }
  ).commands;
  commands?.executeCommandById?.(id);
}

/**
 * PC 세션창 상단 좌측에 Commander 페이지 헤더 버튼 줄을 그린다 (0높이 플로팅
 * 레이어 — 본문을 밀지 않음, 뷰어 옵션 줄과 같은 방식). 그릴 버튼이 없거나
 * 탭 제목줄이 켜져 있으면(Commander 가 원래 자리에 그림) 아무것도 안 그린다.
 */
export function renderHeaderCommandBar(app: App, root: HTMLElement): void {
  if (Platform.isMobile) return; // 모바일은 뷰 헤더에 Commander 가 직접 그림
  if (getVaultConfig(app, "showViewHeader") !== false) return; // 제목줄 켜짐 = 중복 방지
  const entries = getCommanderPageHeaderEntries(app);
  if (!entries.length) return;

  const bar = root.createEl("div", { cls: "ggai-session-command-bar" });
  for (const entry of entries) {
    const cmd = findCommand(app, entry.id);
    if (!cmd) continue; // 제공 플러그인이 꺼져 있는 명령은 건너뜀
    const btn = bar.createEl("button", { cls: "clickable-icon" });
    setIcon(btn, entry.icon ?? cmd.icon ?? "command");
    btn.setAttr("aria-label", entry.name || cmd.name);
    btn.setAttr("data-tooltip-position", "bottom");
    btn.addEventListener("click", () => executeCommand(app, entry.id));
  }
  // 전부 스킵돼 비었으면 레이어 자체를 제거.
  if (!bar.childElementCount) bar.remove();
}

/** 확장 조작 액션 트레이를 버튼 위치에 띄운다. 등록된 액션이 없으면 안내만. */
export function openExtensionActionsMenu(
  plugin: StellaEnginePlugin,
  sessionFile: string,
  e: MouseEvent
): void {
  const actions = plugin.extensions.listSessionActions();
  const menu = new Menu();
  if (!actions.length) {
    menu.addItem((item) =>
      item.setTitle("등록된 확장 기능이 없습니다").setIcon("puzzle").setDisabled(true)
    );
  }
  for (const action of actions) {
    menu.addItem((item) =>
      item
        .setTitle(action.title)
        .setIcon(action.icon ?? "puzzle")
        .onClick(async () => {
          try {
            await action.run({ plugin, sessionFile });
          } catch (err) {
            console.warn(`[GGAI Stella] 확장 조작 실패 (${action.id}):`, err);
            new Notice(`확장 조작 실패: ${action.title}`);
          }
        })
    );
  }
  menu.showAtMouseEvent(e);
}
