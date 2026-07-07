/**
 * 세션 본문 텍스트의 단일 청크 diff.
 *
 * B2 전략: 사용자의 편집은 한 번에 한 지점에서 일어난다고 가정한다.
 * 공통 prefix/suffix 를 뺀 중간 구간 하나로 표현 — op = replace/delete/append.
 *
 * 두 곳을 동시에 고치면(드문 케이스) 둘을 아우르는 큰 구간이 잡히지만,
 * 실제 사용성은 "동일 위치 계속 편집 → 임시 메모리 / 위치 이동 → 커밋" 흐름에서
 * 자연스럽게 분할된다 (SessionView 의 selectionchange 핸들러 참조).
 */

import type { Patch, Span } from "../types/session";

export interface TextDiff {
  /** old 문자열 기준 치환 구간 시작 (UTF-16 code unit). */
  from: number;
  /** old 문자열 기준 치환 구간 끝 (exclusive). */
  to: number;
  /** 중간 구간을 대체할 새 문자열. 삭제만 하는 경우 "". */
  inserted: string;
}

/** 같으면 null, 다르면 단일 청크 diff. */
export function diffText(oldText: string, newText: string): TextDiff | null {
  if (oldText === newText) return null;

  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (
    prefix < maxPrefix &&
    oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)
  ) {
    prefix++;
  }

  let suffix = 0;
  const maxSuffix = Math.min(
    oldText.length - prefix,
    newText.length - prefix
  );
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }

  return {
    from: prefix,
    to: oldText.length - suffix,
    inserted: newText.slice(prefix, newText.length - suffix),
  };
}

/**
 * diff → Patch.
 * - 끝에 덧붙이기(from == to == oldLen, inserted 있음) → append
 * - 중간 삭제만(inserted == "")                        → delete
 * - 그 외                                              → replace
 * 삽입 스팬은 전부 user-authored. 제거되는 구간의 저자 정보는 유실된다(그 구간을 사용자가 바꿨으므로).
 */
export function diffToUserPatch(diff: TextDiff, oldLen: number): Patch {
  const isAppendAtEnd =
    diff.from === oldLen && diff.to === oldLen && diff.inserted.length > 0;
  if (isAppendAtEnd) {
    return { op: "append", spans: [userSpan(diff.inserted)] };
  }
  if (diff.inserted.length === 0) {
    return { op: "delete", from: diff.from, to: diff.to };
  }
  return {
    op: "replace",
    from: diff.from,
    to: diff.to,
    spans: [userSpan(diff.inserted)],
  };
}

function userSpan(text: string): Span {
  return { author: "user", text };
}
