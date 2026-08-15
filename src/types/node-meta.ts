/**
 * 노드 부가 표시 정보 — 세션 폴더 `node-meta.json`.
 *
 * `session.json` 을 건드리지 않고 노드에 딸린 "표시/전송 규칙"만 따로 담는다
 * (illustrations/notes/variables 와 같은 급의 곁파일 — 파일을 지우면 도입 전과 동일).
 *
 * 담는 것은 둘뿐:
 *  - `hidden` — 화면엔 그대로 남기고 **전송본에서만 뺀다**(ST `/hide` 와 같은 의미).
 *    실리태번은 결과를 항상 대화 로그에 남기고 "눈감기기"로 프롬프트에서만 빼므로,
 *    QR 을 프롬프트 숏컷으로 쓰는 카드들이 이 동작에 기대고 있다.
 *  - `speakerName` — 그룹 멤버가 아닌 **익명 발화자 이름표**(QR `/sendas name=`).
 *    본문에 `이름:` 접두어를 박지 않기 위한 자리다 — 본문 글자를 늘리면 오프셋 기반
 *    편집/번역/삽화 앵커가 전부 흔들린다.
 */

export interface SessionNodeMeta {
  /** 전송본에서 이 노드의 구간을 제외한다 (화면에는 그대로 보인다). */
  hidden?: boolean;
  /** 익명 발화자 이름 — 그룹 멤버로 해석되지 않는 `/sendas name=` 값. */
  speakerName?: string;
}

/** 세션 폴더 `node-meta.json`. */
export interface SessionNodeMetaMap {
  schemaVersion: 1;
  /** 노드 id → 부가 정보. 값이 빈 객체면 항목 자체를 지운다. */
  nodes: Record<string, SessionNodeMeta>;
}

export function createEmptyNodeMetaMap(): SessionNodeMetaMap {
  return { schemaVersion: 1, nodes: {} };
}

export function normalizeNodeMetaMap(raw: unknown): SessionNodeMetaMap {
  const empty = createEmptyNodeMetaMap();
  if (!raw || typeof raw !== "object") return empty;
  const src = (raw as Partial<SessionNodeMetaMap>).nodes;
  if (!src || typeof src !== "object") return empty;
  const nodes: Record<string, SessionNodeMeta> = {};
  for (const [id, value] of Object.entries(src)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Partial<SessionNodeMeta>;
    const entry: SessionNodeMeta = {};
    if (v.hidden === true) entry.hidden = true;
    if (typeof v.speakerName === "string" && v.speakerName.trim()) {
      entry.speakerName = v.speakerName;
    }
    if (Object.keys(entry).length > 0) nodes[id] = entry;
  }
  return { schemaVersion: 1, nodes };
}

export function isNodeHidden(
  map: SessionNodeMetaMap | null | undefined,
  nodeId: string
): boolean {
  return map?.nodes[nodeId]?.hidden === true;
}

export function nodeSpeakerName(
  map: SessionNodeMetaMap | null | undefined,
  nodeId: string
): string | null {
  const name = map?.nodes[nodeId]?.speakerName?.trim();
  return name ? name : null;
}

/** 전송본 조립이 쓰는 제외 집합. 없으면 빈 집합(= 예전 동작). */
export function hiddenNodeIds(
  map: SessionNodeMetaMap | null | undefined
): Set<string> {
  const out = new Set<string>();
  for (const [id, meta] of Object.entries(map?.nodes ?? {})) {
    if (meta.hidden === true) out.add(id);
  }
  return out;
}

/** 한 노드의 값 변경 — 빈 값이 되면 항목을 지운다(파일이 계속 부풀지 않게). */
export function patchNodeMeta(
  map: SessionNodeMetaMap,
  nodeId: string,
  patch: SessionNodeMeta
): SessionNodeMetaMap {
  const next: SessionNodeMeta = { ...(map.nodes[nodeId] ?? {}), ...patch };
  if (patch.hidden === false) delete next.hidden;
  if (patch.speakerName === "") delete next.speakerName;
  const nodes = { ...map.nodes };
  if (Object.keys(next).length === 0) delete nodes[nodeId];
  else nodes[nodeId] = next;
  return { schemaVersion: 1, nodes };
}
