/**
 * 세션 요약 스키마 — 세션 폴더 `summaries.json`.
 *
 * 요약은 **노드 앵커 기준**으로 누적한다. 앵커 하나는 "직전 앵커 이후 ~ 이 노드까지"의
 * 새 본문(패시지)만 다루며, 두 가지를 저장한다:
 *  - events: 그 패시지의 사건 요약 — 한 번 쓰면 불변, 시간순 누적.
 *  - state:  그 노드 시점의 현재 상황 스냅샷 — 트리거마다 새로 갱신해 기록.
 *
 * 상황 스냅샷까지 노드마다 남기므로, 분기를 갈아타도 "그 경로의 마지막 앵커"가
 * 즉시 유효하다. {{summary}} 는 루트→활성 리프 경로 위 앵커들의 events 나열 +
 * 경로상 마지막 앵커의 state 로 렌더 시점에 합성한다 (별도 무효화 로직 불필요 —
 * 재생성으로 앵커 노드가 경로에서 빠지면 그 요약도 자동으로 빠진다).
 *
 * `session.json` 원문 노드는 불변.
 */

export interface SummaryAnchor {
  /** 앵커 노드 id — 이 요약이 커버하는 구간의 끝. summaries.json anchors 의 키와 동일. */
  nodeId: string;
  /** 직전 앵커 노드 id — 커버 시작(그 앵커 직후부터). 첫 요약이면 없음(본문 처음부터). */
  fromNodeId?: string;
  /** 이 패시지의 사건 요약 (누적분). */
  events: string;
  /** 이 노드 시점의 현재 상황 스냅샷. */
  state: string;
  modelProfileId?: string;
  promptId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 요약 압축(컴팩트) — 누적 사건 요약이 사용자가 정한 토큰 상한을 넘으면, 경로 위
 * "오래된 상위 절반" 앵커들의 events 를 한 덩어리로 압축해 이 레코드에 담는다.
 *
 * 압축은 앵커를 지우지 않고 **덮어쓴다**: {{summary}} 합성 시, 경로에 `throughNodeId`
 * 가 있으면 그 노드까지의 개별 앵커 events 대신 이 압축본을 앞세우고, 그 이후 앵커만
 * 개별로 이어붙인다. 분기가 throughNodeId 이전에서 갈라지면 이 압축은 그 경로에
 * 적용되지 않아(경로에 throughNodeId 가 없음) 개별 앵커가 그대로 쓰인다 — 분기 안전.
 */
export interface SummaryCompaction {
  /** 압축이 커버하는 마지막(가장 최근) 노드 id — 경로에 이 노드가 있으면 적용. anchors 키와 별개, compactions 의 키와 동일. */
  throughNodeId: string;
  /** 압축된 사건 요약 (여러 앵커 events + 이전 압축을 한 덩어리로). */
  events: string;
  /** throughNodeId 시점의 현재 상황 스냅샷 (그 이후 앵커가 없을 때 쓰는 fallback state). */
  state: string;
  /** 압축 시점 근사 토큰 수 (재압축 판정/로그용, 선택). */
  tokens?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * @deprecated 구버전 릴레이 요약의 중간 진행 체크포인트 — 릴레이 방식 폐기로 더 이상
 * 쓰지 않는다 (이제 요청 1번 = 앵커 1개라 앵커 저장 자체가 진행 기록). 옛 파일의
 * pending 필드를 읽고 지우기 위한 호환용으로만 남긴다.
 */
export interface SummaryCheckpoint {
  /** 릴레이 대상 리프 노드 id. */
  nodeId: string;
  /** 직전 앵커 노드 id (없으면 본문 처음부터). */
  fromNodeId?: string;
  /** 패시지 해시 — 본문/앵커가 바뀌면 이어받지 않고 새로 시작하기 위한 검증용. */
  passageHash: string;
  /** 이 패시지를 나눈 총 조각 수. */
  totalPieces: number;
  /** 지금까지 성공적으로 요약한 조각 수. */
  donePieces: number;
  /** 완료 조각들의 사건 요약 (조각 순서대로). */
  collectedEvents: string[];
  /** 마지막으로 완료한 조각 시점의 현재 상황 스냅샷. */
  runningState: string;
  modelProfileId?: string;
  promptId?: string;
  updatedAt: number;
}

/** 세션 폴더 `summaries.json`. */
export interface SessionSummaries {
  schemaVersion: 1;
  /** key = 앵커 노드 id. */
  anchors: Record<string, SummaryAnchor>;
  /** key = throughNodeId. 오래된 앵커들을 접은 압축본 (누적 요약 토큰 상한 초과 시). */
  compactions?: Record<string, SummaryCompaction>;
  /** 릴레이 요약이 중간에 끊긴 경우의 이어하기 체크포인트 (완료 시 삭제). */
  pending?: SummaryCheckpoint;
}

export function createEmptySessionSummaries(): SessionSummaries {
  return { schemaVersion: 1, anchors: {} };
}

export function normalizeSessionSummaries(raw: unknown): SessionSummaries {
  const empty = createEmptySessionSummaries();
  if (!raw || typeof raw !== "object") return empty;
  const obj = raw as Partial<SessionSummaries>;
  const out: SessionSummaries = {
    schemaVersion: 1,
    anchors: obj.anchors && typeof obj.anchors === "object" ? obj.anchors : {},
  };
  if (obj.compactions && typeof obj.compactions === "object") {
    out.compactions = obj.compactions;
  }
  if (obj.pending && typeof obj.pending === "object") out.pending = obj.pending;
  return out;
}
