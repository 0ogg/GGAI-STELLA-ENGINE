/**
 * 스트리밍 tail 렌더 계획 — "이번 조각에서 화면의 무엇을 다시 그려야 하는가".
 *
 * 생성 중에는 조각이 초당 수십 개씩 도착한다. 도착할 때마다 지금까지의 생성분을
 * 통째로 다시 그리면 비용이 생성 길이의 제곱으로 늘고, 지우는 순간 높이가 0으로
 * 무너져 스크롤이 튄다. 그래서 **줄바꿈이 지나간 줄은 굳혀 두고, 아직 쓰고 있는
 * 마지막 한 줄만** 다시 그린다 — 매 조각의 비용이 한 줄로 고정된다.
 *
 * 되받아쓰기 앵커 판정은 표시량을 되돌릴 수 있다(생성 초반). 그때만 굳힌 것을
 * 버리고 처음부터 다시 그린다.
 */
export interface StreamTailPlan {
  /** 굳혀 둔 것을 버리고 처음부터 다시 그려야 하는가 (앞부분이 달라졌다). */
  reset: boolean;
  /** 이번에 새로 굳힐 구간 [commitFrom, commitTo) — 같으면 굳힐 것 없음. */
  commitFrom: number;
  commitTo: number;
  /** 다시 그릴 "쓰고 있는 줄"의 시작 offset (= commitTo). */
  openFrom: number;
}

/**
 * @param prevText  직전에 그린 tail 전문
 * @param committed 이미 굳혀 그린 앞부분 길이 (항상 "\n" 직후 경계)
 * @param tailText  이번에 그려야 할 tail 전문
 */
export function planStreamTail(
  prevText: string,
  committed: number,
  tailText: string
): StreamTailPlan {
  // 앞부분이 그대로 살아 있으면 = 뒤에 붙기만 했으면 굳힌 것을 재사용한다.
  const reset = !tailText.startsWith(prevText);
  const commitFrom = reset ? 0 : Math.min(committed, tailText.length);
  // 마지막 "\n" 까지가 완성된 줄. 그 뒤는 아직 쓰고 있는 줄이다.
  const boundary = tailText.lastIndexOf("\n") + 1;
  const commitTo = Math.max(commitFrom, boundary);
  return { reset, commitFrom, commitTo, openFrom: commitTo };
}
