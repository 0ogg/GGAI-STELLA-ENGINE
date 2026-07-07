/** epoch ms → "방금" / "N분 전" / "어제" / "N일 전" 같은 짧은 상대 시간 문자열. */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  if (!ts) return "";
  const diffMs = now - ts;
  if (diffMs < 0) return "방금";
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  if (day === 1) return "어제";
  if (day < 30) return `${day}일 전`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}개월 전`;
  const year = Math.floor(month / 12);
  return `${year}년 전`;
}
