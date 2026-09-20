import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  buildCharacterAssetMacros,
  characterAssetBaseKeyword,
  characterAssetLabel,
  readCharacterAssetZip,
} from "../src/util/character-assets";
import { applyMacros } from "../src/util/macros";

assert.equal(characterAssetLabel("joy.png"), "joy");
assert.equal(characterAssetLabel("joy-2.webp"), "joy");
assert.equal(characterAssetLabel("joy.expressive.jpg"), "joy");
assert.equal(characterAssetLabel("joy_2.png"), "joy_2");
assert.equal(characterAssetBaseKeyword("joy_2.png"), "joy");

const macros = buildCharacterAssetMacros(
  ["joy-2.webp", "joy-1.webp", "sad.png"],
  "Luna3"
);
assert.equal(macros.imgKeywordsAutogen, "joy-1.webp, joy-2.webp, sad.png");
assert.equal(macros.imgKeywordsGrouped, "joy_[1, 2], sad");
assert.equal(macros.charkey, "Luna3");
assert.equal(macros.imgCount, "3");
assert.equal(
  applyMacros("{{charkey}} / {{img_count}} / {{img_keywords_autogen}}", macros),
  "Luna3 / 3 / joy-1.webp, joy-2.webp, sad.png"
);
assert.match(
  applyMacros("{{img_inprompt}}", macros),
  /joy-1\.webp, joy-2\.webp, sad\.png/,
  "img_inprompt 안의 중첩 키워드 매크로도 두 번째 패스에서 풀린다"
);

void testLargeZip().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

async function testLargeZip(): Promise<void> {
  // 큰 deflate 항목도 readable/writable 역압력 교착 없이 풀려야 한다.
  const largeImage = Buffer.alloc(512 * 1024);
  for (let i = 0; i < largeImage.length; i++) largeImage[i] = (i * 31 + (i >> 8)) & 0xff;
  const zip = singleEntryZip("nested/large.png", largeImage);
  const unpacked = await readCharacterAssetZip(
    zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer
  );
  assert.equal(unpacked.length, 1);
  assert.equal(unpacked[0]?.filename, "large.png");
  assert.deepEqual(Buffer.from(unpacked[0]!.data), largeImage);
  console.log("character-assets harness passed");
}

function singleEntryZip(filename: string, data: Buffer): Buffer {
  const name = Buffer.from(filename, "utf8");
  const compressed = deflateRawSync(data);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, eocd]);
}
