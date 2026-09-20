/** SillyTavern character-assets 확장과 공유하는 파일/매크로 규약. */

export const CHARACTER_ASSET_EXTENSIONS = new Set([
  "png",
  "webp",
  "gif",
  "jpg",
  "jpeg",
]);

export interface CharacterAssetFile {
  filename: string;
  data: ArrayBuffer;
}

export interface CharacterAssetMacros {
  imgInprompt: string;
  imgKeywords: string;
  imgKeywordsAutogen: string;
  imgKeywordsGrouped: string;
  charkey: string;
  imgCount: string;
}

/** 원본 확장의 기본 이미지 태그 지시문. */
export const DEFAULT_CHARACTER_ASSET_PROMPT = `### Character Asset Direction
Insert internal image tags only when an available asset clearly matches the current scene or emotion.
- Format: {{img::filename.ext}}
- Use only exact filenames from this list: {{img_keywords_autogen}}
- Place tags between complete paragraphs, never inside a sentence.
- Insert at most 2 image tags per response.
- If no image fits, do not insert a tag.`;

export function isCharacterAssetFilename(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return CHARACTER_ASSET_EXTENSIONS.has(ext);
}

/** ST `/api/sprites/get`의 label 규칙. */
export function characterAssetLabel(filename: string): string {
  const name = filename.replace(/\.[^.]+$/, "").toLowerCase();
  return name.match(/^(.+?)(?:[-\\.].*?)?$/)?.[1] ?? name;
}

/** 원본 확장의 숫자 변형 묶음 규칙 (`joy-1`, `joy_2`, `joy.3`). */
export function characterAssetBaseKeyword(filename: string): string {
  const name = filename.replace(/\.[^.]+$/, "");
  return name.match(/^(.+?)(?:[_.\-]\d+)$/)?.[1] ?? name;
}

export function buildCharacterAssetMacros(
  filenames: readonly string[],
  charkey: string
): CharacterAssetMacros {
  const sorted = [...new Set(filenames)].sort((a, b) => a.localeCompare(b));
  const labels = [...new Set(sorted.map(characterAssetLabel))];
  const grouped = new Map<string, string[]>();

  for (const filename of sorted) {
    const name = filename.replace(/\.[^.]+$/, "");
    const base = characterAssetBaseKeyword(filename);
    const suffix = base === name ? "" : name.slice(base.length).replace(/^[_.\-]/, "");
    const list = grouped.get(base) ?? [];
    if (suffix && !list.includes(suffix)) list.push(suffix);
    grouped.set(base, list);
  }

  const groupedText = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([base, suffixes]) => {
      if (suffixes.length === 0) return base;
      suffixes.sort((a, b) => {
        const na = Number.parseInt(a, 10);
        const nb = Number.parseInt(b, 10);
        return Number.isNaN(na) || Number.isNaN(nb) ? a.localeCompare(b) : na - nb;
      });
      return `${base}_[${suffixes.join(", ")}]`;
    })
    .join(", ");

  return {
    imgInprompt: DEFAULT_CHARACTER_ASSET_PROMPT,
    imgKeywords: labels.join(", "),
    imgKeywordsAutogen: sorted.join(", "),
    imgKeywordsGrouped: groupedText,
    charkey,
    imgCount: String(sorted.length),
  };
}

/** 이미지 파일과 ST sprite ZIP을 같은 목록으로 펼친다. ZIP 내부 경로는 ST처럼 버린다. */
export async function readCharacterAssetUploads(
  files: readonly File[]
): Promise<CharacterAssetFile[]> {
  const out: CharacterAssetFile[] = [];
  for (const file of files) {
    if (file.name.toLowerCase().endsWith(".zip")) {
      out.push(...(await readCharacterAssetZip(await file.arrayBuffer())));
    } else if (isCharacterAssetFilename(file.name)) {
      out.push({ filename: basename(file.name), data: await file.arrayBuffer() });
    }
  }
  return out;
}

export async function readCharacterAssetZip(
  buffer: ArrayBuffer
): Promise<CharacterAssetFile[]> {
  const bytes = new Uint8Array(buffer);
  const entries = readZipEntries(bytes);
  const out: CharacterAssetFile[] = [];
  for (const entry of entries) {
    const normalized = entry.name.replace(/\\/g, "/");
    if (normalized.startsWith("__MACOSX") || !isCharacterAssetFilename(normalized)) continue;
    const filename = basename(normalized);
    if (!filename) continue;
    const data = await readZipEntry(bytes, entry);
    out.push({ filename, data: exactArrayBuffer(data) });
  }
  return out;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 0xffff - 22);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP 중앙 디렉터리를 찾지 못했습니다.");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("ZIP 중앙 디렉터리 형식이 올바르지 않습니다.");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder("utf-8").decode(
      bytes.slice(offset + 46, offset + 46 + nameLength)
    );
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) {
    throw new Error(`ZIP 항목 형식이 올바르지 않습니다: ${entry.name}`);
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = bytes.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method !== 8) {
    throw new Error(`지원하지 않는 ZIP 압축 방식(${entry.method}): ${entry.name}`);
  }
  const DecompressionStreamCtor = (globalThis as any).DecompressionStream;
  if (!DecompressionStreamCtor) throw new Error("이 환경은 ZIP 압축 해제를 지원하지 않습니다.");
  const stream = new DecompressionStreamCtor("deflate-raw");
  // readable을 소비하기 전에 writer.write/close를 await하면 큰 항목에서
  // Web Streams 역압력으로 양쪽이 서로 기다릴 수 있다. 입력을 pipeTo로
  // 흘리는 동안 출력을 즉시 소비한다.
  const output = new Response(stream.readable).arrayBuffer();
  const input = new Blob([exactArrayBuffer(compressed)]).stream();
  await input.pipeTo(stream.writable);
  return new Uint8Array(await output);
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? "";
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}
