/**
 * 경과 시간(ms)을 영어 지시문/매크로용 거친 단위로 표현.
 * 1분 미만이면 빈 문자열 — 호출자가 "언급 안 함" 또는 기본 문구로 처리한다.
 * 선채팅 실시간 지시문(proactive-service)과 {{idle_duration}} 매크로가 공유.
 */
export function formatIdleEn(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
