/**
 * 세션 조작(이어쓰기/재생성/전송)의 실패를 **반드시** 화면에 남긴다.
 *
 * 버튼 핸들러는 `() => void this.handleX()` 형태라, 요청을 보내기 전 단계에서 예외가
 * 나면 그대로 삼켜진다 — 사용자에게는 "눌렀는데 아무 일도 안 일어나고, AI 로그에도
 * 요청 흔적이 없는" 상태로만 보인다. 생성 경로의 진입점은 이 함수를 거쳐 실패를
 * 반드시 노출한다.
 */

import { Notice } from "obsidian";

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function reportSessionFailure(action: string, err: unknown): void {
  console.error(`[GGAI Stella] ${action} 실패:`, err);
  new Notice(`${action}을(를) 시작하지 못했습니다 — ${errorText(err)}`);
}
