/**
 * 빠른 답장(Quick Reply, QR) — SillyTavern QR v2 호환 스키마.
 *
 * 필드명은 ST 를 그대로 쓴다 (CLAUDE.md 8 — 같은 개념에 Stella 전용 식별자 금지).
 * 디스크 shape = ST export 그대로 + `stella` 메타. 익스포트는 `stella` 만 떼면 되고
 * 임포트는 `stella` 만 주입하면 되므로 왕복이 무손실이다.
 *
 * 상세: `QR 스펙.md`.
 */

import { uuidv4 } from "../util/uuid";

/**
 * 하위 메뉴 링크 — "QR 안의 QR". 세트를 **이름으로** 참조하는 것까지 ST 규칙 그대로.
 * isChained 면 하위 버튼 명령이 부모 명령 뒤에 이어붙어 실행된다(슬라이스 2).
 */
export interface QuickReplyContextLink {
  set: string;
  isChained: boolean;
}

/** 버튼 하나. */
export interface StellaQuickReply {
  /** 세트 안에서만 고유한 번호 (ST idIndex 카운터). */
  id: number;
  icon: string;
  showLabel: boolean;
  label: string;
  /** 툴팁. */
  title: string;
  /** 실행할 내용 — `/` 로 시작하면 커맨드, 아니면 입력/전송. */
  message: string;
  contextList: QuickReplyContextLink[];
  preventAutoExecute: boolean;
  isHidden: boolean;
  executeOnStartup: boolean;
  executeOnUser: boolean;
  executeOnAi: boolean;
  executeOnChatChange: boolean;
  executeOnGroupMemberDraft: boolean;
  executeOnNewChat: boolean;
  executeBeforeGeneration: boolean;
  automationId: string;
}

/** 세트 = 파일 하나. */
export interface StellaQuickReplySet {
  name: string;
  /** 실행 후 자동 전송 안 함. */
  disableSend: boolean;
  /** 기존 입력창 텍스트 **앞**에 배치. */
  placeBeforeInput: boolean;
  /** 입력창 현재 텍스트와 합침. */
  injectInput: boolean;
  color: string;
  onlyBorderColor: boolean;
  idIndex: number;
  qrList: StellaQuickReply[];
  meta: { id: string; favorite: boolean };
  /** ST 원본에서 우리가 모르는 키 — 라운드트립 보존용. */
  raw?: Record<string, unknown>;
}

/** 자동 실행 시점 플래그 — 편집 UI 와 슬라이스 3 훅이 공유하는 목록. */
export const AUTO_EXECUTE_FLAGS = [
  { key: "executeOnStartup", label: "옵시디언 시작 시" },
  { key: "executeOnNewChat", label: "새 세션을 시작할 때" },
  { key: "executeOnChatChange", label: "세션을 열 때" },
  { key: "executeOnUser", label: "내가 쓴 뒤" },
  { key: "executeOnAi", label: "AI 응답 뒤" },
  { key: "executeBeforeGeneration", label: "생성 직전" },
] as const satisfies ReadonlyArray<{
  key: keyof StellaQuickReply;
  label: string;
}>;

export type AutoExecuteFlagKey = (typeof AUTO_EXECUTE_FLAGS)[number]["key"];

/**
 * 활성 세트들에서 이 시점에 자동 실행할 버튼을 순서대로 골라낸다 (순수 함수).
 *
 * 세트 순서 → 세트 안 버튼 순서. `isHidden` 은 **거르지 않는다** — ST 의 숨김 버튼은
 * "바에 안 보이지만 자동/체인으로는 도는" 것이고, 실측한 EDEN UNIV 의 숨김 버튼 6개가
 * 정확히 그 용도다(바에서만 `isHidden` 을 거른다).
 *
 * `preventAutoExecute` 는 보지 않는다 — ST 기본값이 `true` 라 이걸 게이트로 쓰면
 * 가져온 세트의 자동 실행이 전부 죽는다(그러면 ST 의 자동 실행 기능 자체가 성립하지
 * 않으므로, 이 플래그는 `executeOn*` 의 상위 스위치가 아니다). 필드는 라운드트립용으로만 보존.
 */
export function collectAutoQuickReplies(
  sets: StellaQuickReplySet[],
  trigger: AutoExecuteFlagKey
): { set: StellaQuickReplySet; qr: StellaQuickReply }[] {
  const out: { set: StellaQuickReplySet; qr: StellaQuickReply }[] = [];
  for (const set of sets) {
    for (const qr of set.qrList) {
      if (qr[trigger] === true) out.push({ set, qr });
    }
  }
  return out;
}

/** 우리가 아는 세트 레벨 키 — raw 보존 시 제외 대상. */
const KNOWN_SET_KEYS = new Set([
  "version",
  "name",
  "disableSend",
  "placeBeforeInput",
  "injectInput",
  "color",
  "onlyBorderColor",
  "idIndex",
  "qrList",
  "stella",
  "scope",
  "isDeleted",
]);

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** 버튼 하나 정규화 — 빠진 필드는 ST 기본값으로 채운다. */
export function normalizeQuickReply(
  raw: unknown,
  fallbackId: number
): StellaQuickReply {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const contextList: QuickReplyContextLink[] = Array.isArray(d.contextList)
    ? d.contextList
        .filter((c: any) => c && typeof c === "object" && typeof c.set === "string")
        .map((c: any) => ({ set: c.set as string, isChained: bool(c.isChained) }))
    : [];
  return {
    id: typeof d.id === "number" && Number.isFinite(d.id) ? d.id : fallbackId,
    icon: str(d.icon),
    showLabel: bool(d.showLabel),
    label: str(d.label),
    title: str(d.title),
    message: str(d.message),
    contextList,
    // ST 기본값이 true 인 유일한 플래그.
    preventAutoExecute: bool(d.preventAutoExecute, true),
    isHidden: bool(d.isHidden),
    executeOnStartup: bool(d.executeOnStartup),
    executeOnUser: bool(d.executeOnUser),
    executeOnAi: bool(d.executeOnAi),
    executeOnChatChange: bool(d.executeOnChatChange),
    executeOnGroupMemberDraft: bool(d.executeOnGroupMemberDraft),
    executeOnNewChat: bool(d.executeOnNewChat),
    executeBeforeGeneration: bool(d.executeBeforeGeneration),
    automationId: str(d.automationId),
  };
}

/**
 * 파일/임포트 JSON → 런타임 세트.
 * ST export 와 우리 저장본이 같은 shape 이라 두 경로가 이 함수 하나를 쓴다.
 */
export function normalizeQuickReplySet(
  raw: unknown,
  fallbackName: string
): StellaQuickReplySet {
  let d = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;

  // 버튼 **1개짜리** 파일 — ST 는 버튼 하나만 내보내면 세트 껍데기 없이 버튼
  // 객체를 통째로 저장한다. 세트 1개로 감싸 나머지 경로가 차이를 모르게 한다.
  if (!Array.isArray(d.qrList) && typeof d.message === "string") {
    d = { name: str(d.label) || fallbackName, qrList: [d] };
  }

  const qrList: StellaQuickReply[] = Array.isArray(d.qrList)
    ? d.qrList.map((q: unknown, i: number) => normalizeQuickReply(q, i))
    : [];

  // idIndex 가 실제 최대 id 보다 작으면(손편집·구버전) 새 버튼이 id 를 덮어쓴다.
  const maxId = qrList.reduce((m, q) => Math.max(m, q.id), -1);
  const idIndex =
    typeof d.idIndex === "number" && Number.isFinite(d.idIndex)
      ? Math.max(d.idIndex, maxId + 1)
      : maxId + 1;

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (!KNOWN_SET_KEYS.has(k)) rest[k] = v;
  }

  const stella = (d.stella && typeof d.stella === "object" ? d.stella : {}) as
    Record<string, any>;

  return {
    name: str(d.name) || fallbackName,
    disableSend: bool(d.disableSend),
    placeBeforeInput: bool(d.placeBeforeInput),
    injectInput: bool(d.injectInput),
    color: str(d.color),
    onlyBorderColor: bool(d.onlyBorderColor),
    idIndex,
    qrList,
    meta: {
      id: typeof stella.id === "string" && stella.id ? stella.id : uuidv4(),
      favorite: bool(stella.favorite),
    },
    raw: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

/**
 * 런타임 세트 → 디스크 JSON (ST v2 shape + stella 메타).
 * `forExport` 면 stella 메타를 뺀다 — 그대로 ST 에 넣을 수 있는 파일.
 */
export function serializeQuickReplySet(
  set: StellaQuickReplySet,
  opts?: { forExport?: boolean }
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...(set.raw ?? {}),
    version: 2,
    name: set.name,
    disableSend: set.disableSend,
    placeBeforeInput: set.placeBeforeInput,
    injectInput: set.injectInput,
    color: set.color,
    onlyBorderColor: set.onlyBorderColor,
    idIndex: set.idIndex,
    qrList: set.qrList.map((q) => ({ ...q })),
  };
  if (!opts?.forExport) {
    out.stella = { id: set.meta.id, favorite: set.meta.favorite };
  }
  return out;
}

/**
 * 세트 이름을 고유하게 만든다 — 충돌 시 `-2`, `-3` (파일명 충돌 규칙과 같은 모양).
 *
 * 하위 메뉴(`contextList`)는 세트를 **이름으로** 참조하므로(ST 규칙) 같은 이름이 둘이면
 * ① 하위 메뉴가 먼저 찾힌 엉뚱한 세트를 열고 ② 이름 변경이 그 이름을 쓰던 남의 링크까지
 * 끌고 간다. 만들기/가져오기/이름변경 세 경로가 전부 이 함수를 통과해야 한다.
 * 이미 디스크에 있는 중복은 손대지 않는다(사용자 데이터를 조용히 고쳐 쓰지 않는다).
 */
export function uniqueQuickReplySetName(
  desired: string,
  taken: Iterable<string>
): string {
  const base = (desired ?? "").trim() || "새 세트";
  const used = new Set<string>();
  for (const name of taken) used.add((name ?? "").trim());
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("QR 세트 이름 충돌 해결 실패");
}

/** 새 빈 세트. */
export function createEmptyQuickReplySet(name: string): StellaQuickReplySet {
  return {
    name,
    disableSend: false,
    placeBeforeInput: false,
    injectInput: false,
    color: "",
    onlyBorderColor: false,
    idIndex: 0,
    qrList: [],
    meta: { id: uuidv4(), favorite: false },
  };
}

/** 세트에 새 버튼 추가 — id 는 idIndex 에서 뽑고 카운터를 올린다(ST 규칙). */
export function createQuickReply(set: StellaQuickReplySet): StellaQuickReply {
  const id = set.idIndex;
  set.idIndex = id + 1;
  return normalizeQuickReply({ id, label: "새 버튼" }, id);
}

/** 버튼 동작 요약 — 목록 꼬리표용. */
export function describeQuickReply(qr: StellaQuickReply): string {
  if (qr.contextList.length > 0) {
    return `하위메뉴 → ${qr.contextList.map((c) => c.set).join(", ")}`;
  }
  if (qr.executeBeforeGeneration) return "생성 전";
  if (qr.executeOnAi) return "AI 응답 뒤";
  if (qr.executeOnUser) return "내가 쓴 뒤";
  if (qr.message.trim().startsWith("/")) return "커맨드";
  return "입력/전송";
}
