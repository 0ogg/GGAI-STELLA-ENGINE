// NAI .story `content.document` 해독기 (순수 함수, 의존성 없음)
//
// NovelAI 의 .story 익스포트는 겉은 JSON 이지만 본문(content.document)은
// base64 로 감싼 MessagePack — msgpackr 라이브러리의 record 확장 변형이다.
//   - record 정의: fixext1(0x72, id) + 키 배열 + 값들 (이후 같은 모양은 0x40~0x7f 1바이트 참조)
//   - 정수 64~127 은 uint8(0xcc) 로 인코딩되므로 record 참조와 충돌하지 않음
//   - NAI 커스텀 클래스 태그: fixext1(type, 0x00) 가 "다음 값"을 감싸는 접두 마커
//     (관측된 type: 20=문서 루트, 30=히스토리, 31=히스토리 노드, 40/41=diff 계열)
//   - 날짜: 표준 msgpack timestamp(ext -1)
//
// 문서 구조: { sections: Map<id, Section>, order: id[], history, dirtySections, step }
// Section = { type, text, meta: Map, source? }
//   meta key 1 = 글자 범위별 출처(origin) 표시: { position, length, data }
//   관측된 data 값: 1 = 유저 입력, 2 = AI 생성 (히스토리 diff 내부에는 0/9/-9/10 등
//   편집 과도 상태 값이 있으나 살아있는 본문 section 에는 1/2 만 나타남)
// 히스토리(undo 트리)는 임포트 대상이 아니므로 순회만 하고 결과에서 제외한다.

export interface NaiOriginRange {
  position: number;
  length: number;
  data: number;
}

export interface NaiStorySection {
  id: number;
  type: number;
  text: string;
  origins: NaiOriginRange[];
}

export interface NaiStoryDocumentResult {
  ok: boolean;
  sections: NaiStorySection[];
  errors: string[];
}

const RECORD_EXT = 0x72;
const TIMESTAMP_EXT = -1;

interface Reader {
  buf: Uint8Array;
  view: DataView;
  pos: number;
  structures: Map<number, string[]>;
}

function u8(r: Reader): number {
  return r.buf[r.pos++];
}

function readBytes(r: Reader, n: number): Uint8Array {
  const out = r.buf.subarray(r.pos, r.pos + n);
  r.pos += n;
  return out;
}

function readStr(r: Reader, n: number): string {
  const bytes = readBytes(r, n);
  // TextDecoder 는 Obsidian(브라우저)과 Node 양쪽에 존재
  return new TextDecoder("utf-8").decode(bytes);
}

function safeNum(v: bigint, r: Reader): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new Error(`정수 범위 초과 (offset ${r.pos})`);
  }
  return Number(v);
}

function readTimestamp(r: Reader, size: number): string {
  let sec: number;
  let nsec = 0;
  if (size === 4) {
    sec = r.view.getUint32(r.pos);
    r.pos += 4;
  } else if (size === 8) {
    const data = r.view.getBigUint64(r.pos);
    r.pos += 8;
    nsec = Number(data >> BigInt(34));
    sec = Number(data & BigInt("0x3ffffffff"));
  } else if (size === 12) {
    nsec = r.view.getUint32(r.pos);
    sec = safeNum(r.view.getBigInt64(r.pos + 4), r);
    r.pos += 12;
  } else {
    throw new Error(`timestamp 크기 ${size} 미지원 (offset ${r.pos})`);
  }
  return new Date(sec * 1000 + Math.floor(nsec / 1e6)).toISOString();
}

function readRecordBody(r: Reader, keys: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const key of keys) obj[key] = decodeValue(r);
  return obj;
}

function readExt(r: Reader, size: number): unknown {
  const type = r.view.getInt8(r.pos);
  r.pos += 1;
  if (type === TIMESTAMP_EXT) return readTimestamp(r, size);
  if (type === RECORD_EXT) {
    if (size !== 1) throw new Error(`record 정의 크기 ${size} 미지원 (offset ${r.pos})`);
    const id = u8(r);
    const keys = decodeValue(r);
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) {
      throw new Error(`record 키 배열이 아님 (offset ${r.pos})`);
    }
    r.structures.set(id, keys as string[]);
    return readRecordBody(r, keys as string[]);
  }
  // msgpackr 의 undefined 표현: fixext1(0, 0x00) — 단독 값
  if (type === 0 && size === 1) {
    r.pos += 1;
    return null;
  }
  // NAI 커스텀 클래스 태그: fixext1(type, 0x00) 뒤의 값이 실제 내용
  if (size === 1 && r.buf[r.pos] === 0) {
    r.pos += 1;
    return decodeValue(r);
  }
  throw new Error(`알 수 없는 확장 type ${type} size ${size} (offset ${r.pos})`);
}

function decodeValue(r: Reader): unknown {
  if (r.pos >= r.buf.length) throw new Error("버퍼 끝을 넘음");
  const b = u8(r);
  // positive fixint 0x00-0x3f (0x40-0x7f 는 record 참조로 예약됨)
  if (b <= 0x3f) return b;
  // record 참조
  if (b >= 0x40 && b <= 0x7f) {
    const keys = r.structures.get(b);
    if (!keys) throw new Error(`정의되지 않은 record ${b} (offset ${r.pos - 1})`);
    return readRecordBody(r, keys);
  }
  if (b >= 0xe0) return b - 0x100; // negative fixint
  if (b >= 0x80 && b <= 0x8f) return readMap(r, b & 0x0f);
  if (b >= 0x90 && b <= 0x9f) return readArr(r, b & 0x0f);
  if (b >= 0xa0 && b <= 0xbf) return readStr(r, b & 0x1f);
  switch (b) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xc4: return readBytes(r, u8(r)).slice();
    case 0xc5: return readBytes(r, readU16(r)).slice();
    case 0xc6: return readBytes(r, readU32(r)).slice();
    case 0xc7: return readExt(r, u8(r));
    case 0xc8: return readExt(r, readU16(r));
    case 0xc9: return readExt(r, readU32(r));
    case 0xca: { const v = r.view.getFloat32(r.pos); r.pos += 4; return v; }
    case 0xcb: { const v = r.view.getFloat64(r.pos); r.pos += 8; return v; }
    case 0xcc: return u8(r);
    case 0xcd: return readU16(r);
    case 0xce: return readU32(r);
    case 0xcf: { const v = r.view.getBigUint64(r.pos); r.pos += 8; return safeNum(v, r); }
    case 0xd0: { const v = r.view.getInt8(r.pos); r.pos += 1; return v; }
    case 0xd1: { const v = r.view.getInt16(r.pos); r.pos += 2; return v; }
    case 0xd2: { const v = r.view.getInt32(r.pos); r.pos += 4; return v; }
    case 0xd3: { const v = r.view.getBigInt64(r.pos); r.pos += 8; return safeNum(v, r); }
    case 0xd4: return readExt(r, 1);
    case 0xd5: return readExt(r, 2);
    case 0xd6: return readExt(r, 4);
    case 0xd7: return readExt(r, 8);
    case 0xd8: return readExt(r, 16);
    case 0xd9: return readStr(r, u8(r));
    case 0xda: return readStr(r, readU16(r));
    case 0xdb: return readStr(r, readU32(r));
    case 0xdc: return readArr(r, readU16(r));
    case 0xdd: return readArr(r, readU32(r));
    case 0xde: return readMap(r, readU16(r));
    case 0xdf: return readMap(r, readU32(r));
    default:
      throw new Error(`알 수 없는 바이트 0x${b.toString(16)} (offset ${r.pos - 1})`);
  }
}

function readU16(r: Reader): number {
  const v = r.view.getUint16(r.pos);
  r.pos += 2;
  return v;
}

function readU32(r: Reader): number {
  const v = r.view.getUint32(r.pos);
  r.pos += 4;
  return v;
}

function readArr(r: Reader, n: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(decodeValue(r));
  return out;
}

function readMap(r: Reader, n: number): Map<unknown, unknown> {
  const out = new Map<unknown, unknown>();
  for (let i = 0; i < n; i++) {
    const key = decodeValue(r);
    out.set(key, decodeValue(r));
  }
  return out;
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extractOrigins(meta: unknown, errors: string[], sectionId: number): NaiOriginRange[] {
  if (!(meta instanceof Map)) return [];
  const ranges = meta.get(1);
  if (!Array.isArray(ranges)) return [];
  const out: NaiOriginRange[] = [];
  for (const range of ranges) {
    const rec = range as Record<string, unknown>;
    if (
      rec &&
      typeof rec === "object" &&
      typeof rec.position === "number" &&
      typeof rec.length === "number" &&
      typeof rec.data === "number"
    ) {
      out.push({ position: rec.position, length: rec.length, data: rec.data });
    } else {
      errors.push(`section ${sectionId}: 출처 범위 형식이 예상과 다름`);
    }
  }
  out.sort((a, b) => a.position - b.position);
  return out;
}

/** base64 로 감싼 NAI document 를 해독해 본문 section 들을 순서대로 반환한다. */
export function decodeNaiStoryDocument(base64: string): NaiStoryDocumentResult {
  const errors: string[] = [];
  let root: unknown;
  try {
    const buf = base64ToBytes(base64);
    const r: Reader = {
      buf,
      view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
      pos: 0,
      structures: new Map(),
    };
    root = decodeValue(r);
    if (r.pos !== buf.length) {
      errors.push(`문서 끝에 해석되지 않은 ${buf.length - r.pos} 바이트가 남음`);
    }
  } catch (e) {
    return { ok: false, sections: [], errors: [`document 해독 실패: ${e instanceof Error ? e.message : String(e)}`] };
  }

  const doc = root as Record<string, unknown>;
  const sectionMap = doc && typeof doc === "object" ? doc.sections : null;
  const order = doc && typeof doc === "object" ? doc.order : null;
  if (!(sectionMap instanceof Map) || !Array.isArray(order)) {
    return { ok: false, sections: [], errors: ["document 에 sections/order 가 없음"] };
  }

  const sections: NaiStorySection[] = [];
  for (const id of order) {
    const raw = sectionMap.get(id) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || typeof raw.text !== "string") {
      errors.push(`section ${String(id)} 을 order 에서 참조하지만 내용이 없음`);
      continue;
    }
    sections.push({
      id: typeof id === "number" ? id : Number(id),
      type: typeof raw.type === "number" ? raw.type : 0,
      text: raw.text,
      origins: extractOrigins(raw.meta, errors, typeof id === "number" ? id : -1),
    });
  }

  return { ok: sections.length > 0, sections, errors };
}
