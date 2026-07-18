/**
 * PNG tEXt/iTXt 청크 파서.
 *
 * 캐릭터카드 V3 규격:
 *  - JSON → utf-8 → base64 → `ccv3` 라는 키워드의 tEXt 청크에 저장
 *  - V2 호환: `chara` 키워드도 동일한 base64 JSON
 *
 * 임포트 우선순위: `ccv3` > `chara`.
 * iTXt(비압축)도 함께 읽는다 — AI 생성 이미지 메타(A1111 등)가 유니코드
 * 프롬프트를 iTXt 로 넣는 경우가 있다 (V2-3 이미지 이해 파이프라인).
 */

/** PNG 파일 구조를 순회하며 tEXt/iTXt(비압축) 청크를 모두 반환. */
export function readPngTextChunks(
  bytes: Uint8Array
): Array<{ keyword: string; text: string }> {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8) throw new Error("PNG 파일이 너무 짧습니다.");
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) throw new Error("유효한 PNG 파일이 아닙니다.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Array<{ keyword: string; text: string }> = [];
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;

    if (type === "tEXt") {
      const data = bytes.subarray(dataStart, dataEnd);
      // keyword\0text
      let sep = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) {
          sep = i;
          break;
        }
      }
      if (sep > 0) {
        chunks.push({
          keyword: latin1ToString(data.subarray(0, sep)),
          text: latin1ToString(data.subarray(sep + 1)),
        });
      }
    } else if (type === "iTXt") {
      // keyword\0 압축플래그(1) 압축방식(1) 언어태그\0 번역키워드\0 텍스트(UTF-8)
      const data = bytes.subarray(dataStart, dataEnd);
      const kwEnd = data.indexOf(0);
      if (kwEnd > 0 && kwEnd + 3 < data.length) {
        const compressed = data[kwEnd + 1] !== 0;
        let p = kwEnd + 3; // 압축플래그·방식 스킵
        const langEnd = data.indexOf(0, p);
        if (!compressed && langEnd >= 0) {
          const transEnd = data.indexOf(0, langEnd + 1);
          if (transEnd >= 0) {
            chunks.push({
              keyword: latin1ToString(data.subarray(0, kwEnd)),
              text: new TextDecoder("utf-8").decode(data.subarray(transEnd + 1)),
            });
          }
        }
      }
    }

    if (type === "IEND") break;
    offset = dataEnd + 4; // crc 4바이트 스킵
  }

  return chunks;
}

/**
 * PNG 바이트에서 CCv3 또는 V2 캐릭터카드 JSON 을 추출한다.
 * `ccv3` 청크가 있으면 우선 사용, 없으면 `chara` 폴백.
 */
export function extractCharacterCardJsonFromPng(
  bytes: Uint8Array
): { data: any; chunk: "ccv3" | "chara" } | null {
  const chunks = readPngTextChunks(bytes);
  const ccv3 = chunks.find((c) => c.keyword === "ccv3");
  const chara = chunks.find((c) => c.keyword === "chara");
  const picked = ccv3 ?? chara;
  if (!picked) return null;

  const json = utf8FromBase64(picked.text);
  return {
    data: JSON.parse(json),
    chunk: (ccv3 ? "ccv3" : "chara") as "ccv3" | "chara",
  };
}

// --- helpers ---

/** Latin-1 (PNG tEXt 스펙) → JS string. */
function latin1ToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** base64 문자열 → utf-8 디코드. */
function utf8FromBase64(b64: string): string {
  const raw = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
