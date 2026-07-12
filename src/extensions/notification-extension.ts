/**
 * 알림 확장 (N0) — 생성-완료 훅으로 "사용자가 지금 보고 있지 않은" 세션의
 * AI 응답 도착을 알린다. 본체 생성 경로에 하드코딩 없이 확장 레지스트리 위에서만 동작.
 *
 *  - 안 읽음 기록: `plugin.markSessionUnread` → 사이드바/대시보드 뱃지가
 *    `session-unread-changed` 이벤트로 갱신된다. 세션을 보면 자동 해제.
 *  - 알림 3겹 (하나가 막혀도 다른 겹이 도달하도록):
 *    1) 인앱 Notice — 항상. 창 포커스가 없으면 지속형(클릭까지 유지)이라
 *       자리를 비웠다 돌아와도 남아 있다. 클릭 = 세션 열기.
 *    2) OS 알림 — 데스크톱에서 창 포커스가 없을 때. 권한이 미정(default)이면
 *       요청부터 한다 (Electron 은 프롬프트 없이 승인됨).
 *    3) 웹훅 푸시 — 설정에 URL 이 있으면 전송 (ntfy 등 → 휴대폰 실제 푸시).
 *       옵시디언 플러그인은 서버가 없어 모바일 백그라운드 푸시는 이 경로가 유일.
 *
 * 사용자가 그 세션을 보고 있는 동안(활성 탭 + 창 포커스)에는 아무것도 하지 않는다.
 */
import { Notice, Platform, requestUrl } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { GenerationCompleteInput } from "../services/extension-registry";
import { isViewingSession } from "../views/session-host";
import { openSessionByPath } from "../views/entity-actions";

const PREVIEW_MAX_CHARS = 80;

/** 알림에 쓸 세션 표시명 — 세션 제목, 없으면 세션 폴더명. */
async function sessionDisplayName(
  plugin: StellaEnginePlugin,
  sessionFile: string
): Promise<string> {
  const session = await plugin.store.getSession(sessionFile);
  const named = session?.meta.name?.trim();
  if (named) return named;
  // .../SESSIONS/<세션 폴더>/session.json → 폴더명
  const parts = sessionFile.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : "세션";
}

/**
 * OS 알림 시도 (데스크톱 Electron 전용). 권한 미정이면 요청까지 해본다.
 * 성공 여부와 무관하게 인앱 Notice 는 별도로 뜬다 — Windows 집중 지원/앱 알림
 * 차단처럼 "던졌는데 표시가 안 되는" 경우를 코드가 알 수 없기 때문.
 */
async function tryOsNotification(
  title: string,
  body: string,
  onClick: () => void
): Promise<void> {
  if (!Platform.isDesktopApp) return;
  if (typeof Notification === "undefined") return;
  try {
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
    if (Notification.permission !== "granted") return;
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      onClick();
    };
  } catch (err) {
    console.warn("[GGAI Stella] OS 알림 실패:", err);
  }
}

/**
 * 웹훅으로 알림 텍스트를 POST 한다. 성공 시 null, 실패 시 표시용 사유 문자열.
 * ntfy(https://ntfy.sh/<주제>) 형식이면 휴대폰 ntfy 앱이 실제 푸시로 받는다.
 * 제목은 헤더 대신 본문 첫 줄에 — ntfy 헤더는 비ASCII(한글)를 못 싣는다.
 */
async function postWebhook(
  url: string,
  title: string,
  body: string
): Promise<string | null> {
  try {
    const res = await requestUrl({
      url,
      method: "POST",
      contentType: "text/plain; charset=utf-8",
      body: body ? `${title}\n${body}` : title,
      throw: false,
    });
    return res.status >= 400 ? `HTTP ${res.status}` : null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** 웹훅 푸시 (설정에 URL 이 있을 때만) — 실패는 콘솔 경고로만. */
function tryWebhookPush(
  plugin: StellaEnginePlugin,
  title: string,
  body: string
): void {
  const url = plugin.data.settings?.notifyWebhookUrl?.trim();
  if (!url) return;
  void postWebhook(url, title, body).then((fail) => {
    if (fail) console.warn(`[GGAI Stella] 웹훅 알림 실패: ${fail}`);
  });
}

// ─── 알림음 ───

let audioCtx: AudioContext | null = null;

/**
 * 짧은 두 음 차임("띵-동")을 합성해 재생 — 오디오 파일 없이 WebAudio 로 만든다.
 * OS 알림 권한과 무관: PC 는 창이 백그라운드여도 소리가 나고, 모바일은 앱이
 * 실행 중인 동안 동작한다 (완전 백그라운드는 생성 자체가 멈추므로 웹훅이 담당).
 */
export function playNotifySound(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx = audioCtx ?? new Ctor();
    const ctx = audioCtx;
    // 브라우저 자동재생 정책으로 잠들어 있으면 깨운다 (사용자 상호작용 이력이 있어 대부분 성공).
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const tone = (freq: number, start: number, dur: number): void => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.18, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.05);
    };
    tone(880, 0, 0.35); // A5
    tone(1174.66, 0.12, 0.45); // D6
  } catch (err) {
    console.warn("[GGAI Stella] 알림음 재생 실패:", err);
  }
}

// ─── 진동 ───

/** 이 환경에서 진동을 낼 수 있는가 (모바일 안드로이드 웹뷰 등). 설정 UI 노출 판단용. */
export function canVibrate(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

/**
 * 짧은 두 번 진동 — Web Vibration API. 안드로이드에서 동작하고, iOS/데스크톱은
 * 지원하지 않아 조용히 무시된다. 소리를 끈 환경(무음 모드)에서도 도착을 알린다.
 */
export function playNotifyVibration(): void {
  if (!canVibrate()) return;
  try {
    navigator.vibrate([120, 80, 120]);
  } catch (err) {
    console.warn("[GGAI Stella] 진동 실패:", err);
  }
}

// ─── 설정 탭 연동 (사전 권한/테스트) ───

export type OsNotificationStatus =
  | "granted"
  | "denied"
  | "default"
  | "unsupported";

/** 데스크톱 OS 알림 권한 현황 — 설정 탭 표시용. */
export function getOsNotificationStatus(): OsNotificationStatus {
  if (!Platform.isDesktopApp || typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission;
}

/**
 * 설정 탭의 [권한 요청 + 테스트] — 권한을 미리 확보하고, 허용 상태면 실제
 * 테스트 토스트를 띄워 OS 단(집중 지원/앱 알림 차단)까지 눈으로 확인하게 한다.
 */
export async function requestAndTestOsNotification(): Promise<OsNotificationStatus> {
  if (getOsNotificationStatus() === "unsupported") return "unsupported";
  try {
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
    if (Notification.permission === "granted") {
      new Notification("GGAI Stella 테스트 알림", {
        body: "이 알림이 보이면 데스크톱 알림이 정상 동작합니다.",
      });
    }
    return Notification.permission;
  } catch (err) {
    console.warn("[GGAI Stella] OS 알림 테스트 실패:", err);
    return getOsNotificationStatus();
  }
}

/** 설정 탭의 웹훅 [테스트 전송]. 성공 시 null, 실패 시 표시용 사유. */
export async function sendTestWebhookPush(
  plugin: StellaEnginePlugin
): Promise<string | null> {
  const url = plugin.data.settings?.notifyWebhookUrl?.trim();
  if (!url) return "웹훅 URL이 비어 있습니다.";
  return postWebhook(
    url,
    "GGAI Stella 테스트 알림",
    "휴대폰에서 이 메시지가 보이면 푸시 설정이 완료된 것입니다."
  );
}

export function registerNotificationExtension(plugin: StellaEnginePlugin): void {
  plugin.extensions.register({
    id: "stella:notification",
    async onGenerationComplete(input: GenerationCompleteInput): Promise<void> {
      const { sessionFile, generatedText } = input;
      if (isViewingSession(plugin.app.workspace, sessionFile)) return;

      const preview = generatedText
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, PREVIEW_MAX_CHARS);
      await plugin.markSessionUnread(sessionFile, preview);

      const name = await sessionDisplayName(plugin, sessionFile);
      const title = `「${name}」 응답 도착`;
      // 클릭 = 그 세션으로 이동. 단 이미 다른 탭에 열려 있으면 보던 탭을
      // 갈아치우지 않고 그 탭을 활성화한다 (대기 중인 탭으로 점프).
      const openSession = (): void => {
        if (!plugin.revealOpenSession(sessionFile)) {
          void openSessionByPath(plugin, sessionFile);
        }
      };

      // 안 읽음 뱃지가 "놓친 응답"을 계속 남겨주므로 토스트는 항상 자동으로
      // 사라진다 (자리 비움일 때도 무한 지속하지 않음 — 돌아왔을 때 화면을 안 막음).
      const away = !document.hasFocus();
      const notice = new Notice(
        preview ? `${title} — ${preview}` : title,
        away ? 12000 : 8000
      );
      notice.noticeEl.addEventListener("click", openSession);

      if (plugin.data.settings?.notifySound !== false) playNotifySound();
      if (plugin.data.settings?.notifyVibrate !== false) playNotifyVibration();
      if (away) void tryOsNotification(title, preview, openSession);
      tryWebhookPush(plugin, title, preview);
    },
  });
}
