/**
 * 스텔라 폰 "봤는지" 판정 (v2 §8.2).
 *
 * 문자 상대(캐릭터)나 세션 속 캐릭터가 SNS 이슈를 아는지의 결정적 판정.
 * 세션 주입 경로(phone 슬롯)와 1:1 문자 답장의 공유 다이제스트가 같은 규칙을
 * 쓰도록 순수 함수로 분리한다 — 미리보기·생성 byte 동일 대전제 유지를 위해
 * Math.random 이 아니라 결정적 해시(FNV-1a)를 쓴다.
 *
 * 규칙: 그 글/방송에 직접 참여(작성·답글)했으면 100% 안다. 아니면 이슈 등급이
 * 클수록 높은 확률로 "지나가다 봤다" — p = {1:5%, 2:20%, 3:50%, 4:70%, 5:90%}.
 * v1 의 일률 30% 규칙을 등급 기반으로 승격한 것.
 */
import type { SnsAuthor, SnsPost } from "../types/phone";

/** 이슈 등급별 "봤을" 확률 (v2 §8.2). */
export const SNS_SAW_P: Record<number, number> = {
  1: 0.05,
  2: 0.2,
  3: 0.5,
  4: 0.7,
  5: 0.9,
};

/** 문자열 → 0~1 결정적 해시 비율 (FNV-1a). */
export function hashRatio(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

/** 그 작성자가 이 시나리오(세계)의 캐릭터인가. */
function authorIsScenario(a: SnsAuthor, scenarioId: string): boolean {
  return (
    (a.kind === "character" || a.kind === "scenario") && a.id === scenarioId
  );
}

/** 이 시나리오의 인물이 그 글에 직접 참여(작성·답글)했는가. */
export function snsPostInvolvesScenario(
  post: SnsPost,
  scenarioId: string
): boolean {
  return (
    authorIsScenario(post.author, scenarioId) ||
    post.replies.some((r) => authorIsScenario(r.author, scenarioId))
  );
}

/**
 * 이 시나리오의 캐릭터가 그 SNS 글을 봤는가 (결정적).
 * 직접 참여 = 100%, 아니면 등급 확률 × 결정적 해시(post.id + scenarioId).
 */
export function sawSnsPost(post: SnsPost, scenarioId: string): boolean {
  if (snsPostInvolvesScenario(post, scenarioId)) return true;
  const scale = Math.min(5, Math.max(1, Math.round(post.issueScale ?? 2)));
  return hashRatio(`${post.id}:${scenarioId}`) < (SNS_SAW_P[scale] ?? 0.2);
}
