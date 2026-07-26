/**
 * QR `/inject` 주입 보관소 — 세션별 "다음 생성에 얹을 텍스트".
 *
 * 실물 QR(EDEN)은 `/inject ephemeral=true id=instructions position=chat depth=0 …`
 * 로 **바로 다음 생성 한 번**에만 쓸 지시문을 심는다. 그래서 여기 상태는
 * 디스크에 남기지 않는다(메모리 전용):
 *  - 남기면 사용자가 모르는 지시문이 세션 파일에 눌러앉아 이후 모든 생성에
 *    조용히 얹힌다 — 숨은 지시문 금지 원칙에 정면으로 어긋난다.
 *  - 옵시디언을 껐다 켜면 사라지는 게 "다음 생성용"이라는 성격과도 맞는다.
 *
 * 소비 지점은 `planSessionRequest` 한 곳뿐이다(전송본 단일 진실 소스):
 *  - 미리보기(dryRun)는 `listQrInjections` 로 **읽기만** 한다 → 미리보기와
 *    실제 전송본이 byte 동일.
 *  - 실제 전송은 `consumeQrInjections` 로 읽고 ephemeral 항목을 지운다.
 */

import type { LorebookPosition, LorebookRole } from "../types/lorebook";

export interface QrInjection {
  /** ST `id=` — 같은 id 로 다시 심으면 덮어쓴다. */
  id: string;
  text: string;
  position: LorebookPosition;
  depth: number;
  role: LorebookRole;
  /** 다음 생성 한 번 뒤 사라진다 (ST ephemeral). */
  ephemeral: boolean;
}

/** sessionFile → 주입 목록 (메모리 전용). */
const store = new Map<string, QrInjection[]>();

/** 심기 — 같은 id 는 덮어쓴다. text 가 비면 그 id 를 지운다(ST 동작). */
export function setQrInjection(sessionFile: string, inj: QrInjection): void {
  const list = (store.get(sessionFile) ?? []).filter((i) => i.id !== inj.id);
  if (inj.text.trim()) list.push(inj);
  if (list.length > 0) store.set(sessionFile, list);
  else store.delete(sessionFile);
}

/** 읽기만 (미리보기 경로). */
export function listQrInjections(sessionFile: string): QrInjection[] {
  return store.get(sessionFile) ?? [];
}

/** 읽고 ephemeral 은 소비 — 실제 전송 경로에서 한 번만 호출한다. */
export function consumeQrInjections(sessionFile: string): QrInjection[] {
  const list = store.get(sessionFile) ?? [];
  if (list.length === 0) return list;
  const kept = list.filter((i) => !i.ephemeral);
  if (kept.length > 0) store.set(sessionFile, kept);
  else store.delete(sessionFile);
  return list;
}

/** 비우기 — id 를 주면 그것만. (`/flushinject`) */
export function flushQrInjections(sessionFile: string, id?: string): void {
  if (!id) {
    store.delete(sessionFile);
    return;
  }
  const kept = (store.get(sessionFile) ?? []).filter((i) => i.id !== id);
  if (kept.length > 0) store.set(sessionFile, kept);
  else store.delete(sessionFile);
}
