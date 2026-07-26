/**
 * PNG 캐릭터카드 쓰기 — 썸네일 이미지 안에 카드 JSON 을 심는다.
 *
 * 읽기(`import/png-chunk.ts`)의 역방향. 규격도 같다:
 *   JSON → utf-8 → base64 → tEXt 청크 (`ccv3` = CCv3, `chara` = V2 호환)
 *
 * 원본 이미지에 이미 카드가 심겨 있으면(임포트한 카드의 썸네일) 그 청크는 버리고
 * 새 것으로 갈아끼운다 — 옛 카드 데이터가 남아 먼저 읽히는 사고 방지.
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 카드 JSON 두 벌을 PNG 에 심어 새 바이트를 만든다. */
export function embedCharacterCardInPng(
  bytes: Uint8Array,
  cards: { ccv3: string; chara: string }
): Uint8Array {
  assertPng(bytes);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keep: Uint8Array[] = [bytes.subarray(0, 8)];
  let iend: Uint8Array | null = null;
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const end = offset + 12 + length;
    if (end > bytes.length) break;
    const chunk = bytes.subarray(offset, end);

    if (type === "IEND") {
      iend = chunk;
      break;
    }
    if (!(type === "tEXt" && isCardKeyword(bytes.subarray(offset + 8, offset + 8 + length)))) {
      keep.push(chunk);
    }
    offset = end;
  }
  if (!iend) throw new Error("PNG 에 IEND 청크가 없습니다 (손상된 이미지).");

  keep.push(textChunk("ccv3", base64Utf8(cards.ccv3)));
  keep.push(textChunk("chara", base64Utf8(cards.chara)));
  keep.push(iend);
  return concat(keep);
}

/**
 * JPEG/WebP 썸네일을 PNG 바이트로 바꾼다 (카드 데이터는 PNG 청크에만 넣을 수 있다).
 * 이미 PNG/APNG 면 그대로 돌려준다.
 */
export async function toPngBytes(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  if (ext === "png" || ext === "apng") return bytes;

  const mime = ext === "webp" ? "image/webp" : "image/jpeg";
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("캔버스를 만들 수 없습니다.");
    ctx.drawImage(img, 0, 0);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!png) throw new Error("PNG 변환에 실패했습니다.");
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- helpers ---

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("썸네일 이미지를 읽지 못했습니다."));
    img.src = url;
  });
}

function assertPng(bytes: Uint8Array): void {
  if (bytes.length < 8) throw new Error("PNG 파일이 너무 짧습니다.");
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error("유효한 PNG 파일이 아닙니다.");
  }
}

/** tEXt 청크 본문(keyword\0text)의 keyword 가 카드 키워드인가. */
function isCardKeyword(data: Uint8Array): boolean {
  let kw = "";
  for (let i = 0; i < data.length && data[i] !== 0; i++) {
    kw += String.fromCharCode(data[i]);
  }
  return kw === "ccv3" || kw === "chara";
}

/** tEXt 청크 한 개 (length + type + keyword\0text + crc). */
function textChunk(keyword: string, text: string): Uint8Array {
  const body = new Uint8Array(keyword.length + 1 + text.length);
  for (let i = 0; i < keyword.length; i++) body[i] = keyword.charCodeAt(i) & 0xff;
  body[keyword.length] = 0;
  for (let i = 0; i < text.length; i++) {
    body[keyword.length + 1 + i] = text.charCodeAt(i) & 0xff;
  }

  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out[4] = 0x74; // t
  out[5] = 0x45; // E
  out[6] = 0x58; // X
  out[7] = 0x74; // t
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** UTF-8 문자열 → base64 (tEXt 는 latin-1 이라 base64 로 감싼다). */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
