/**
 * 세션 본문(원문 패널)의 렌더 계획 — displaySpans + 숨김 구간을 "런(run)" 목록으로
 * 편다. 런 하나 = DOM 한 덩어리(문단 조각 span 또는 문단 사이 줄바꿈 span).
 *
 * 이 계획을 들고 있으면 다시 그릴 때 **바뀐 지점부터 끝까지만** 다시 만들 수 있다
 * (이어쓰기/재생성 = 끝만 바뀜 → 앞부분 DOM 을 건드리지 않는다). 본문 전체를
 * empty() 후 재생성하면 긴 세션에서 그리는 동안 높이가 무너져 스크롤이 맨 위로
 * 튀고 화면이 멎었다 — 회귀금지.md "세션창/스크롤" 참조.
 *
 * 순수 함수라 하네스에서 검사한다(tests/session-view-logic.test.ts).
 */

export type BodyRunKind = "text" | "gap";

export type BodyRun = {
  kind: BodyRunKind;
  /** 이 런이 담는 표시 텍스트. gap 은 항상 "\n". */
  text: string;
  /** 이 런의 span 클래스(작성자 + 숨김 표시). */
  cls: string;
  /** 문단 첫 조각인가 (들여쓰기 클래스가 붙는다). gap 은 무의미. */
  indent: boolean;
};

export type BodySpan = { author: string; text: string };
export type HiddenRange = { from: number; to: number };

/**
 * renderBodySpans 의 DOM 생성 규칙을 그대로 따른다 — 여기서 만든 런 순서대로
 * span 을 만들면 기존 전체 렌더와 **완전히 같은 DOM** 이 나온다.
 */
export function buildBodyRuns(
  spans: BodySpan[],
  hiddenRanges: HiddenRange[]
): BodyRun[] {
  const runs: BodyRun[] = [];
  const isHidden = (at: number) =>
    hiddenRanges.some((r) => at >= r.from && at < r.to);

  let indentNext = true;
  let offset = 0;
  for (const s of spans) {
    if (s.text.length === 0) continue;
    const base = s.author === "ai" ? "ggai-span-ai" : "ggai-span-user";

    let buf = "";
    let bufHidden = false;
    const flush = () => {
      if (buf.length === 0) return;
      runs.push({
        kind: "text",
        text: buf,
        cls: bufHidden ? `${base} ggai-span-nosend` : base,
        indent: indentNext,
      });
      indentNext = false;
      buf = "";
    };
    for (const ch of s.text) {
      const hidden = hiddenRanges.length > 0 && isHidden(offset);
      if (ch === "\n") {
        flush();
        runs.push({
          kind: "gap",
          text: "\n",
          cls: `ggai-para-gap ${base}${hidden ? " ggai-span-nosend" : ""}`,
          indent: false,
        });
        indentNext = true;
      } else {
        if (buf.length > 0 && hidden !== bufHidden) flush();
        bufHidden = hidden;
        buf += ch;
      }
      offset += ch.length;
    }
    flush();
  }
  return runs;
}

export function sameRun(a: BodyRun, b: BodyRun): boolean {
  return (
    a.kind === b.kind &&
    a.text === b.text &&
    a.cls === b.cls &&
    a.indent === b.indent
  );
}

/** 앞에서부터 완전히 같은 런의 개수 (여기부터 다시 그리면 된다). */
export function commonRunPrefix(prev: BodyRun[], next: BodyRun[]): number {
  const max = Math.min(prev.length, next.length);
  let i = 0;
  while (i < max && sameRun(prev[i], next[i])) i++;
  // 뒤가 더 짧아졌으면(글이 줄었으면) 그 자리부터 지워야 하므로 그대로 반환.
  return i;
}

/**
 * 뒤에서부터 완전히 같은 런의 개수 (앞의 공통 부분 `head` 와 겹치지 않게 자른다).
 * 가운데만 바뀐 경우(문단 재생성/국소 수정) 뒤쪽 DOM 까지 살리기 위한 짝.
 */
export function commonRunSuffix(
  prev: BodyRun[],
  next: BodyRun[],
  head: number
): number {
  const max = Math.min(prev.length, next.length) - head;
  let i = 0;
  while (
    i < max &&
    sameRun(prev[prev.length - 1 - i], next[next.length - 1 - i])
  ) {
    i++;
  }
  return i;
}

/** 런 [0, count) 이 차지하는 표시 텍스트 길이 = 다시 그리기 시작할 offset. */
export function runsTextLength(runs: BodyRun[], count: number): number {
  let n = 0;
  for (let i = 0; i < count && i < runs.length; i++) n += runs[i].text.length;
  return n;
}

/** 뒤에서 count 개 런이 차지하는 표시 텍스트 길이. */
export function runsTailTextLength(runs: BodyRun[], count: number): number {
  let n = 0;
  for (let i = 0; i < count && i < runs.length; i++) {
    n += runs[runs.length - 1 - i].text.length;
  }
  return n;
}

/** 각 런이 시작하는 표시 offset (누적합). */
export function runStartOffsets(runs: BodyRun[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const run of runs) {
    out.push(acc);
    acc += run.text.length;
  }
  return out;
}
