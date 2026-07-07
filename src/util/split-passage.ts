/**
 * 긴 본문을 문단 경계에서 조각으로 나누는 순수 로직.
 *
 * 두 곳에서 재사용한다:
 *  - 세션 첫 본문(임포트한 진행분 등)을 여러 노드로 심을 때 (new-session.ts)
 *  - 밀린 구간을 한 번에 못 보내 나눠 요약할 때 (summary-service.ts)
 *
 * **불변식**: 반환한 조각들을 순서대로 이으면 입력과 바이트 단위로 동일하다.
 * (세션 노드 체인의 본문 재구성이 원문과 같아야 하므로 반드시 지켜야 한다.)
 */

/** 세션 첫 본문을 노드 체인으로 쪼갤 최소 길이 — 이보다 짧으면 노드 1개 유지. */
export const SESSION_SEED_SPLIT_MIN = 2000;
/** 노드 체인 한 조각의 목표 글자 수. */
export const SESSION_SEED_CHUNK_CHARS = 1600;

/**
 * text 를 목표 글자 수(maxChars) 근처의 조각들로 나눈다. 문단(연속 줄바꿈) 경계를
 * 우선 끊고, 한 문단이 그 자체로 maxChars 를 크게 넘으면 그 문단만 하드 분할한다.
 * 입력이 짧으면 (maxChars 이하) 원본 하나만 담아 반환한다.
 */
export function splitTextByBudget(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  if (text.length <= limit) return text ? [text] : [];

  // 문단 + 구분자(연속 줄바꿈)를 별도 토큰으로 — 이어붙이면 원문과 동일.
  const tokens = text.split(/(\n+)/).filter((t) => t !== "");
  const chunks: string[] = [];
  let cur = "";

  const flush = () => {
    if (cur !== "") {
      chunks.push(cur);
      cur = "";
    }
  };

  for (const token of tokens) {
    // 하나의 문단이 한도의 1.5배를 넘으면 그 문단만 하드 분할.
    if (token.length > Math.floor(limit * 1.5)) {
      flush();
      for (const piece of hardSplit(token, limit)) chunks.push(piece);
      continue;
    }
    if (cur !== "" && cur.length + token.length > limit) {
      flush();
    }
    cur += token;
  }
  flush();
  return mergeWhitespaceOnly(chunks);
}

/**
 * 내용 없이 줄바꿈뿐인 조각을 앞 조각에 흡수한다 (빈 노드로 보이는 것 방지).
 * 이어붙이면 여전히 원문과 동일.
 */
function mergeWhitespaceOnly(chunks: string[]): string[] {
  const out: string[] = [];
  for (const chunk of chunks) {
    if (chunk.trim() === "" && out.length > 0) {
      out[out.length - 1] += chunk;
    } else {
      out.push(chunk);
    }
  }
  return out;
}

/** 문단 경계가 없는 초장문을 글자 수로 하드 분할. */
function hardSplit(text: string, limit: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    out.push(text.slice(i, i + limit));
  }
  return out;
}
