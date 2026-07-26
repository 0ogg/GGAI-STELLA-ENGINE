/**
 * 빠른 답장(QR) 자동 실행 확장 (QR 스펙.md 슬라이스 3) — `executeOn*` 훅.
 *
 * 버튼 편집기의 "자동 실행 시점" 체크박스가 실제로 도는 자리다. 판단(어느 버튼이
 * 대상인가)과 실행(체인/커맨드/입력·전송)은 **전부 QR 바가 소유**하고, 여기서는
 * "언제" 만 잇는다 — 자동 실행 전용 실행 경로를 만들면 "눌렀을 땐 되는데 자동으로는
 * 안 되는" 버튼이 생긴다.
 *
 * 이음새 선택:
 *  - `내가 쓴 뒤`  → 확장 `onUserText`        (소설/챗 양쪽이 이미 부르는 훅)
 *  - `AI 응답 뒤`  → 확장 `onGenerationComplete`
 * 나머지 시점(시작/새 세션/세션 열기/생성 직전)은 훅이 없어 각 발생 지점에서
 * `runAutoQuickRepliesFor` 를 직접 부른다.
 *
 * 자동 실행은 **열려 있는 세션창이 있을 때만** 돈다(session-host 규약) — 버튼이
 * 넣는 텍스트가 그 뷰의 입력/본문 경로를 타기 때문이다.
 */
import type StellaEnginePlugin from "../main";
import { runAutoQuickRepliesFor } from "../views/session-host";

export function registerQuickReplyExtension(
  plugin: StellaEnginePlugin
): () => void {
  return plugin.extensions.register({
    id: "stella:quick-reply",
    onUserText: async (input) => {
      await runAutoQuickRepliesFor(
        plugin.app.workspace,
        input.sessionFile,
        "executeOnUser"
      );
    },
    onGenerationComplete: async (input) => {
      await runAutoQuickRepliesFor(
        plugin.app.workspace,
        input.sessionFile,
        "executeOnAi"
      );
    },
  });
}
