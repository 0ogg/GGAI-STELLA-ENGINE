/**
 * 세션 ↔ 페르소나 기록 (순수 함수).
 *
 * `meta.personaFile` 은 "지금 이 세션의 페르소나" 하나뿐이라 도중에 바꾸면 옛 기록이
 * 사라진다. 스텔라 폰 연락처처럼 "한 번이라도 같이 했는가"를 묻는 쪽을 위해
 * `meta.personaIds` 에 함께한 페르소나를 **추가만** 하며 쌓는다.
 */
import type { SessionMeta } from "../types/session";

/**
 * 이 세션의 페르소나 이력에 id 를 더한다. 이미 있으면 아무것도 하지 않는다.
 * @returns 실제로 추가했으면 true (저장 필요 여부 판단용).
 */
export function rememberSessionPersona(meta: SessionMeta, personaId: string): boolean {
  if (!personaId) return false;
  const list = meta.personaIds ?? [];
  if (list.includes(personaId)) return false;
  meta.personaIds = [...list, personaId];
  return true;
}
