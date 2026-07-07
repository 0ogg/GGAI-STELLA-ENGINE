import type { ImportedScenario } from "../types/scenario";
import { parseCharacterCard } from "./parse-charactercard";
import type { ScenarioThumbnailInput } from "./write-scenario";

export interface ParsedCharx {
  imported: ImportedScenario;
  thumbnail?: ScenarioThumbnailInput;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export async function parseCharx(bytes: Uint8Array): Promise<ParsedCharx> {
  const entries = readZipEntries(bytes);
  const cardEntry =
    entries.find((entry) => entry.name === "card.json") ??
    entries.find((entry) => entry.name.endsWith("/card.json"));
  if (!cardEntry) throw new Error("CHARX 안에서 card.json 을 찾지 못했습니다.");

  const cardBytes = await readZipEntryBytes(bytes, cardEntry);
  const data = JSON.parse(new TextDecoder("utf-8").decode(cardBytes));
  const imported = parseCharacterCard(data);

  const imageEntry = entries.find((entry) => {
    const lower = entry.name.toLowerCase();
    return (
      lower.startsWith("assets/") &&
      /\.(png|apng|jpe?g|webp)$/.test(lower)
    );
  });
  const thumbnail = imageEntry ? await thumbnailFromEntry(bytes, imageEntry) : undefined;
  return { imported, thumbnail };
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new Error("ZIP 중앙 디렉터리를 찾지 못했습니다.");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("ZIP 중앙 디렉터리 엔트리 형식이 올바르지 않습니다.");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLen);
    const name = new TextDecoder("utf-8").decode(nameBytes).replace(/\\/g, "/");
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 0xffff - 22);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function readZipEntryBytes(
  zipBytes: Uint8Array,
  entry: ZipEntry
): Promise<Uint8Array> {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) {
    throw new Error(`ZIP 로컬 헤더가 올바르지 않습니다: ${entry.name}`);
  }
  const nameLen = view.getUint16(offset + 26, true);
  const extraLen = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLen + extraLen;
  const compressed = zipBytes.slice(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRaw(compressed, entry.uncompressedSize);
  throw new Error(`지원하지 않는 ZIP 압축 방식(${entry.method}): ${entry.name}`);
}

async function inflateRaw(
  bytes: Uint8Array,
  expectedSize: number
): Promise<Uint8Array> {
  const DecompressionStreamCtor = (globalThis as any).DecompressionStream;
  if (!DecompressionStreamCtor) {
    throw new Error("이 환경은 ZIP deflate 해제를 지원하지 않습니다.");
  }
  const stream = new DecompressionStreamCtor("deflate-raw");
  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  const out = new Uint8Array(buffer);
  if (expectedSize > 0 && out.length !== expectedSize) {
    console.warn("[GGAI Stella] CHARX inflate size mismatch", {
      expectedSize,
      actualSize: out.length,
    });
  }
  return out;
}

async function thumbnailFromEntry(
  zipBytes: Uint8Array,
  entry: ZipEntry
): Promise<ScenarioThumbnailInput | undefined> {
  const lower = entry.name.toLowerCase();
  const extMatch = lower.match(/\.([^.]+)$/);
  const ext = extMatch?.[1];
  if (!ext || !["png", "apng", "jpg", "jpeg", "webp"].includes(ext)) return undefined;
  const bytes = await readZipEntryBytes(zipBytes, entry);
  return { bytes, ext: ext as ScenarioThumbnailInput["ext"] };
}
