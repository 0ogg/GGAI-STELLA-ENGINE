/**
 * 임시 진단 장치 — 입력 포커스 소실 범인 추적용. (원인 확정 후 통째로 제거한다.)
 *
 * 텍스트 입력 중 포커스가 사라지는 순간에 "무엇이 일어났는지"를 vault 의
 * `GGAI/focus-log.txt` 에 자동 기록한다:
 *  - focusin/focusout (어디서 어디로 갔는지, 요소가 재렌더로 교체됐는지)
 *  - 프로그램적 focus()/blur() 호출과 그 호출 스택 (범인 코드 위치)
 *  - 창(OS) 포커스 상태 변화 (window blur/focus, document.hasFocus)
 *  - IME 조합 시작/끝
 *  - StellaStore 이벤트 발생 (session-changed 등 — 타이밍 상관관계용)
 *
 * 기록만 하고 동작에는 일절 개입하지 않는다.
 */
import type StellaEnginePlugin from "../main";

const LOG_PATH = "GGAI/focus-log.txt";
const INCIDENT_PATH = "GGAI/focus-incidents.txt";
const MAX_LINES = 1200;
const FLUSH_MS = 1500;
const INCIDENT_CONTEXT_LINES = 60;

export function installFocusForensics(plugin: StellaEnginePlugin): void {
  const lines: string[] = [];
  let dirty = false;

  const ts = (): string => {
    const d = new Date();
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0") +
      ":" +
      String(d.getSeconds()).padStart(2, "0") +
      "." +
      String(d.getMilliseconds()).padStart(3, "0")
    );
  };

  const log = (msg: string): void => {
    lines.push(`${ts()} ${msg}`);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    dirty = true;
  };

  const desc = (el: unknown): string => {
    if (!(el instanceof HTMLElement)) return el === null ? "(null)" : String(el);
    const tag = el.tagName.toLowerCase();
    const cls = el.className
      ? "." + String(el.className).trim().split(/\s+/).slice(0, 4).join(".")
      : "";
    const editable = el.hasAttribute("contenteditable") ? "[ce]" : "";
    return `${tag}${cls}${editable}`;
  };

  const stack = (): string => {
    const raw = new Error().stack ?? "";
    return raw
      .split("\n")
      .slice(3, 8)
      .map((l) => l.trim().replace(/^at /, ""))
      .join(" <- ");
  };

  // ─── 사용자 입력 추적 — "클릭해서 나간 것"과 "저절로 빠진 것" 구분용 ──
  let lastPointer = 0;
  let lastPointerDesc = "";
  let lastKey = 0;
  let lastKeyDesc = "";
  const onPointerDown = (e: PointerEvent): void => {
    lastPointer = Date.now();
    lastPointerDesc = desc(e.target);
    log(`POINTERDOWN ${lastPointerDesc}`);
  };
  // 입력 반응 추적 — keydown 후 input/조합이 따라오는지 (입력 마비 감지).
  let lastInputEvt = 0;
  let deadCheckTimer: number | null = null;
  const isOursEl = (el: unknown): el is HTMLElement =>
    el instanceof HTMLElement && String(el.className).includes("ggai-");

  const onKeyDown = (e: KeyboardEvent): void => {
    lastKey = Date.now();
    // 내용 유출 방지 — 특수키만 이름 기록, 글자는 "(글자)".
    lastKeyDesc = e.key.length === 1 ? "(글자)" : e.key;
    const t = e.target;
    // 우리 입력칸(또는 body 로 새는 경우)의 키만 기록 — 마비 상태 판별용.
    if (isOursEl(t) || t === document.body) {
      log(`KEYDOWN ${lastKeyDesc} on ${desc(t)} (activeElement=${desc(document.activeElement)})`);
    }
    // 입력 마비 감지: 우리 입력칸이 포커스인 상태에서 키를 눌렀는데
    // 400ms 안에 input/조합 이벤트가 전혀 없으면 사고로 기록.
    if (isOursEl(document.activeElement) && deadCheckTimer == null) {
      const pressedAt = lastKey;
      deadCheckTimer = window.setTimeout(() => {
        deadCheckTimer = null;
        if (lastInputEvt < pressedAt) {
          log(
            `⚠️ 입력 무반응 감지 — 키는 눌렸는데 input/조합 이벤트 없음. activeElement=${desc(document.activeElement)} hasFocus=${document.hasFocus()}`
          );
          const ae = document.activeElement;
          if (ae instanceof HTMLTextAreaElement) {
            log(
              `  ^ textarea 상태: disabled=${ae.disabled} readOnly=${ae.readOnly} selStart=${ae.selectionStart} selEnd=${ae.selectionEnd} 화면표시=${ae.offsetParent != null}`
            );
          }
          const sel = document.getSelection();
          log(
            `  ^ document.selection: rangeCount=${sel?.rangeCount ?? "?"} anchor=${desc(sel?.anchorNode instanceof HTMLElement ? sel.anchorNode : sel?.anchorNode?.parentElement ?? null)}`
          );
          recordIncident();
        }
      }, 400);
    }
  };
  const onAnyInput = (e: Event): void => {
    lastInputEvt = Date.now();
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("input", onAnyInput, true);
  document.addEventListener("compositionupdate", onAnyInput, true);

  // ─── focusin / focusout ───────────────────────────────────────────
  const onFocusIn = (e: FocusEvent): void => {
    log(`FOCUSIN  ${desc(e.target)} (from ${desc(e.relatedTarget)})`);
  };
  const onFocusOut = (e: FocusEvent): void => {
    const t = e.target;
    const now = Date.now();
    const sincePointer = now - lastPointer;
    const sinceKey = now - lastKey;
    const spontaneous = sincePointer >= 400 && sinceKey >= 400;
    const cause =
      sincePointer < 400
        ? `클릭직후(${sincePointer}ms전 ${lastPointerDesc})`
        : sinceKey < 400
          ? `키직후(${sinceKey}ms전 ${lastKeyDesc})`
          : "⚠️저절로(직전 400ms 내 입력 없음)";
    const hidden =
      t instanceof HTMLElement && t.offsetParent === null ? " [숨김상태]" : "";
    const disabled =
      t instanceof HTMLTextAreaElement && t.disabled ? " [disabled]" : "";
    log(
      `FOCUSOUT ${desc(t)} -> ${desc(e.relatedTarget)} hasFocus=${document.hasFocus()} ${cause}${hidden}${disabled}`
    );
    // 한 틱 뒤: 요소가 DOM 에서 떨어졌는지(=재렌더로 교체됐는지) / 숨김 여부 재확인.
    window.setTimeout(() => {
      if (t instanceof HTMLElement && !t.isConnected) {
        log(`  ^ FOCUSOUT 요소가 DOM 에서 제거됨 (재렌더/교체 의심): ${desc(t)}`);
      } else if (t instanceof HTMLElement && t.offsetParent === null) {
        log(`  ^ FOCUSOUT 요소가 화면에서 숨겨짐 (display:none 조상 의심): ${desc(t)}`);
      }
      log(`  ^ 이후 activeElement=${desc(document.activeElement)} hasFocus=${document.hasFocus()}`);
      // 사고 채증: 우리 입력칸에서 클릭/키 없이 저절로 빠졌고 창 포커스는 살아있는 경우
      // (alt-tab 창 전환 제외) — 직전 맥락을 사고 파일에 즉시 append.
      const ours =
        t instanceof HTMLElement && String(t.className).includes("ggai-");
      if (spontaneous && ours && document.hasFocus()) {
        recordIncident();
      }
    }, 0);
  };

  const recordIncident = (): void => {
    const snapshot = lines.slice(-INCIDENT_CONTEXT_LINES).join("\n");
    const header = `\n===== 사고 ${new Date().toLocaleString()} =====\n`;
    const ad = plugin.app.vault.adapter as unknown as {
      append?: (path: string, data: string) => Promise<void>;
      read: (path: string) => Promise<string>;
      write: (path: string, data: string) => Promise<void>;
      exists: (path: string) => Promise<boolean>;
    };
    void (async () => {
      try {
        if (typeof ad.append === "function") {
          await ad.append(INCIDENT_PATH, header + snapshot + "\n");
        } else {
          const prev = (await ad.exists(INCIDENT_PATH))
            ? await ad.read(INCIDENT_PATH)
            : "";
          await ad.write(INCIDENT_PATH, prev + header + snapshot + "\n");
        }
      } catch {
        // 기록 실패는 무시 (진단 장치가 본 기능을 방해하면 안 됨)
      }
    })();
  };
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);

  // ─── 창(OS) 포커스 ─────────────────────────────────────────────────
  const onWinBlur = (): void =>
    log(`WINDOW BLUR  activeElement=${desc(document.activeElement)}`);
  const onWinFocus = (): void =>
    log(`WINDOW FOCUS activeElement=${desc(document.activeElement)}`);
  window.addEventListener("blur", onWinBlur);
  window.addEventListener("focus", onWinFocus);

  // ─── IME 조합 ─────────────────────────────────────────────────────
  const onCompStart = (e: CompositionEvent): void => {
    lastInputEvt = Date.now();
    log(`COMP-START ${desc(e.target)}`);
  };
  const onCompEnd = (e: CompositionEvent): void => {
    lastInputEvt = Date.now();
    log(`COMP-END   ${desc(e.target)} data="${e.data ?? ""}"`);
  };
  document.addEventListener("compositionstart", onCompStart, true);
  document.addEventListener("compositionend", onCompEnd, true);

  // ─── 프로그램적 focus()/blur() 추적 ────────────────────────────────
  const origFocus = HTMLElement.prototype.focus;
  const origBlur = HTMLElement.prototype.blur;
  HTMLElement.prototype.focus = function (this: HTMLElement, ...args: any[]) {
    if (document.activeElement !== this) {
      log(`CALL focus() on ${desc(this)}\n    stack: ${stack()}`);
    }
    return origFocus.apply(this, args as any);
  };
  HTMLElement.prototype.blur = function (this: HTMLElement) {
    if (document.activeElement === this) {
      log(`CALL blur() on ${desc(this)}\n    stack: ${stack()}`);
    }
    return origBlur.apply(this);
  };

  // ─── store 이벤트 타임라인 ─────────────────────────────────────────
  const store: any = plugin.store;
  const origTrigger = store.trigger.bind(store);
  store.trigger = (name: string, ...data: unknown[]): void => {
    const arg = typeof data[0] === "string" ? ` ${data[0]}` : "";
    log(`STORE ${name}${arg}`);
    origTrigger(name, ...data);
  };

  // 로컬 저장 호출 표시 — "SAVE 없이 온 session-changed" = 외부(동기화) 변경으로 판별.
  const wrapSave = (method: string): (() => void) => {
    const orig = store[method]?.bind(store);
    if (!orig) return () => {};
    store[method] = (...args: unknown[]): unknown => {
      const arg = typeof args[0] === "string" ? ` ${args[0]}` : "";
      log(`SAVE ${method}${arg}`);
      return orig(...args);
    };
    return () => {
      store[method] = orig;
    };
  };
  const unwrapSaves = [
    wrapSave("saveSession"),
    wrapSave("saveScenario"),
    wrapSave("saveUserProfile"),
    wrapSave("saveLorebook"),
    wrapSave("saveSessionTranslations"),
    wrapSave("saveSessionSummaries"),
  ];

  // ─── 주기 flush ────────────────────────────────────────────────────
  const timer = window.setInterval(() => {
    if (!dirty) return;
    dirty = false;
    void plugin.app.vault.adapter
      .write(LOG_PATH, lines.join("\n") + "\n")
      .catch(() => {
        dirty = true; // GGAI 폴더가 아직 없으면 다음 틱에 재시도
      });
  }, FLUSH_MS);

  plugin.register(() => {
    window.clearInterval(timer);
    if (deadCheckTimer != null) window.clearTimeout(deadCheckTimer);
    for (const un of unwrapSaves) un();
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("input", onAnyInput, true);
    document.removeEventListener("compositionupdate", onAnyInput, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("compositionstart", onCompStart, true);
    document.removeEventListener("compositionend", onCompEnd, true);
    window.removeEventListener("blur", onWinBlur);
    window.removeEventListener("focus", onWinFocus);
    HTMLElement.prototype.focus = origFocus;
    HTMLElement.prototype.blur = origBlur;
    store.trigger = origTrigger;
  });

  log("=== focus forensics 시작 ===");
}
