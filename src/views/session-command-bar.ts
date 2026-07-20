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

import { Notice, Platform, setIcon, type App } from "obsidian";
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

/**
 * 확장 조작 트레이를 버튼 위에 띄운다 — 아이콘 그리드(윈도우 앱 아이콘 형태).
 * 등록된 액션이 없으면 안내만. 바깥 클릭/Esc 로 닫힌다.
 */
export function openExtensionActionsMenu(
  plugin: StellaEnginePlugin,
  sessionFile: string,
  e: MouseEvent
): void {
  // 이미 열린 트레이가 있으면 정리 (연속 클릭 = 토글).
  document.querySelectorAll(".ggai-ext-tray").forEach((el) => el.remove());

  const actions = plugin.extensions.listSessionActions();
  const pop = document.body.createDiv({ cls: "ggai-ext-tray" });

  function close(): void {
    pop.remove();
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
  }
  function onPointerDown(ev: PointerEvent): void {
    if (!pop.contains(ev.target as Node)) close();
  }
  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") close();
  }

  const grid = pop.createDiv({ cls: "ggai-ext-tray-grid" });

  // 내장: 작가노트 빠른 입력 — 세션 진행 중 작은 창으로 작가노트를 바로 고친다.
  const anote = grid.createDiv({
    cls: "ggai-ext-tray-item",
    attr: { title: "작가노트" },
  });
  const anoteIcon = anote.createDiv({ cls: "ggai-ext-tray-icon" });
  setIcon(anoteIcon, "notebook-pen");
  anote.createDiv({ cls: "ggai-ext-tray-label", text: "작가노트" });
  anote.addEventListener("click", () => {
    close();
    openAuthorNoteQuickInput(plugin, sessionFile);
  });

  for (const action of actions) {
    const item = grid.createDiv({
      cls: "ggai-ext-tray-item",
      attr: { title: action.title },
    });
    const icon = item.createDiv({ cls: "ggai-ext-tray-icon" });
    setIcon(icon, action.icon ?? "puzzle");
    item.createDiv({ cls: "ggai-ext-tray-label", text: action.title });
    item.addEventListener("click", async () => {
      close();
      try {
        await action.run({ plugin, sessionFile });
      } catch (err) {
        console.warn(`[GGAI Stella] 확장 조작 실패 (${action.id}):`, err);
        new Notice(`확장 조작 실패: ${action.title}`);
      }
    });
  }

  // 클릭 지점 위쪽에 띄우고(하단 툴바 버튼이므로), 화면 밖으로 안 나가게 클램프.
  const margin = 8;
  const rect = pop.getBoundingClientRect();
  let left = e.clientX - rect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
  let top = e.clientY - rect.height - 10;
  if (top < margin) top = e.clientY + 16; // 위 공간 부족 → 아래로
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  // 여는 클릭이 곧바로 바깥 클릭으로 잡혀 닫히지 않게 다음 틱에 리스너 부착.
  window.setTimeout(() => {
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
  }, 0);
}

/**
 * 작가노트 빠른 입력 팝오버 — 퍼즐 트레이의 "작가노트" 버튼이 연다.
 * 세션 진행 중 디테일 패널을 열지 않고 작가노트를 바로 고칠 수 있는 작은 창.
 *
 * 저장 규약: 인라인 작가노트 필드와 같은 "닫으면 저장"(auto-commit) 방식 —
 * 저장 버튼/바깥 클릭/Esc 모두 현재 내용을 저장하고 닫는다(입력 유실 없음).
 * 변경이 없으면 저장 호출을 건너뛴다.
 *
 * 모바일: 가상 키보드가 하단을 덮으므로 visualViewport 기준으로 항상 화면 상단
 * (키보드 위)에 고정하고, 키보드가 오르내릴 때 위치를 다시 잡는다.
 */
export function openAuthorNoteQuickInput(
  plugin: StellaEnginePlugin,
  sessionFile: string
): void {
  // 이미 열린 창이 있으면 정리 (연속 클릭 = 토글).
  document.querySelectorAll(".ggai-anote-quick").forEach((el) => el.remove());

  const pop = document.body.createDiv({ cls: "ggai-anote-quick" });
  const header = pop.createDiv({ cls: "ggai-anote-quick-header" });
  header.createSpan({ cls: "ggai-anote-quick-title", text: "작가노트" });
  const ta = pop.createEl("textarea", { cls: "ggai-anote-quick-input" });
  ta.rows = 5;
  ta.placeholder = "다음 전개 지시를 적어보세요…";
  const footer = pop.createDiv({ cls: "ggai-anote-quick-footer" });
  const saveBtn = footer.createEl("button", {
    cls: "ggai-btn ggai-btn-primary",
    text: "저장",
  });

  const vv = window.visualViewport;
  let settled = false;
  let loaded = false;
  let baseline = "";

  function cleanup(): void {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    vv?.removeEventListener("resize", place);
    vv?.removeEventListener("scroll", place);
  }

  async function commitAndClose(): Promise<void> {
    if (settled) return;
    settled = true;
    cleanup();
    const next = ta.value;
    pop.remove();
    // 로드 전이거나 변화가 없으면 저장하지 않는다.
    if (!loaded || next === baseline) return;
    try {
      const session = await plugin.store.getSession(sessionFile);
      if (!session) return;
      session.meta.authorNote = next;
      await plugin.store.saveSession(sessionFile, session, {
        kinds: ["settings"],
      });
    } catch (err) {
      console.warn("[GGAI Stella] 작가노트 저장 실패:", err);
      new Notice("작가노트 저장 실패");
    }
  }

  function onPointerDown(ev: PointerEvent): void {
    if (!pop.contains(ev.target as Node)) void commitAndClose();
  }
  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      ev.preventDefault();
      void commitAndClose();
    } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      // Ctrl/Cmd+Enter = 저장하고 닫기 (일반 Enter 는 줄바꿈).
      ev.preventDefault();
      void commitAndClose();
    }
  }

  // 현재 작가노트를 불러온다 (store 캐시 우선). 로드 전에 사용자가 이미
  // 타이핑을 시작했으면 그 값을 덮지 않는다.
  void plugin.store.getSession(sessionFile).then((session) => {
    if (settled) return;
    baseline = session?.meta.authorNote ?? "";
    if (!ta.value) ta.value = baseline;
    loaded = true;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });

  // 위치 — 모바일은 키보드가 덮는 하단을 피해 visualViewport 상단에 고정.
  function place(): void {
    const w = vv?.width ?? window.innerWidth;
    const h = vv?.height ?? window.innerHeight;
    const offTop = vv?.offsetTop ?? 0;
    const offLeft = vv?.offsetLeft ?? 0;
    const margin = 12;
    const width = Math.min(520, w - margin * 2);
    pop.style.width = `${width}px`;
    pop.style.left = `${offLeft + (w - width) / 2}px`;
    // 모바일: 뷰포트 상단(키보드 위). PC: 화면 위쪽 1/5 지점.
    pop.style.top = `${offTop + (Platform.isMobile ? margin : Math.max(margin, h * 0.18))}px`;
    // 키보드까지 감안해 화면을 넘지 않게 최대 높이 제한 (textarea 가 스크롤).
    pop.style.maxHeight = `${Math.max(160, h - margin * 2)}px`;
  }
  place();
  vv?.addEventListener("resize", place);
  vv?.addEventListener("scroll", place);

  saveBtn.addEventListener("click", () => void commitAndClose());

  // 여는 클릭이 곧바로 바깥 클릭으로 잡혀 닫히지 않게 다음 틱에 리스너 부착.
  window.setTimeout(() => {
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
  }, 0);
}
