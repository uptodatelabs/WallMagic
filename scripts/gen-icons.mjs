// WallMagic 앱 아이콘 생성기 (의존성 없음 — node:zlib만 사용)
// 산출물: icons/icon.ico (16/32 BMP 엔트리 + 256 PNG 엔트리), icons/32x32.png,
//         icons/128x128.png, icons/icon.png (256)
// tauri-build는 icons/icon.ico를 Windows Resource(아이콘) 생성에 필수로 요구한다.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// ── CRC32 (PNG 청크용) ──
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

// ── 픽셀: 대각선 그라데이션(인디고 → 틸) + 좌상단 하이라이트 ──
function pixel(x, y, size) {
  const t = Math.min(1, Math.max(0, (x + y) / (2 * (size - 1 || 1))));
  const r = Math.round(0x27 * (1 - t) + 0x18 * t);
  const g = Math.round(0x3b * (1 - t) + 0x9d * t);
  const b = Math.round(0x9e * (1 - t) + 0xc8 * t);
  const hl = x + y < size * 0.45 ? 26 : 0;
  return [Math.min(255, r + hl), Math.min(255, g + hl), Math.min(255, b + hl), 255];
}

// ── PNG 인코더 (RGBA8, 필터 0) ──
function pngRGBA(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowOff = y * (1 + size * 4);
    raw[rowOff] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = rowOff + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO BMP 엔트리 (BITMAPINFOHEADER + BGRA 하향 + AND 마스크) ──
function bmpIcoEntry(size) {
  const andRow = Math.ceil(size / 32) * 4;
  const xorSize = size * size * 4;
  const andSize = andRow * size;
  const buf = Buffer.alloc(40 + xorSize + andSize);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8); // XOR+AND 높이
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(0, 16); // BI_RGB
  buf.writeUInt32LE(xorSize + andSize, 20);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, srcY, size);
      const o = 40 + (y * size + x) * 4;
      buf[o] = b;
      buf[o + 1] = g;
      buf[o + 2] = r;
      buf[o + 3] = a;
    }
  }
  return buf;
}

// ── ICO 조립 (ICONDIR + ICONDIRENTRY*N) ──
function buildIco(entries) {
  const dir = Buffer.alloc(6 + 16 * entries.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const off = 6 + 16 * i;
    dir[off] = e.size >= 256 ? 0 : e.size;
    dir[off + 1] = e.size >= 256 ? 0 : e.size;
    dir[off + 2] = 0;
    dir[off + 3] = 0;
    dir.writeUInt16LE(1, off + 4);
    dir.writeUInt16LE(32, off + 6);
    dir.writeUInt32LE(e.data.length, off + 8);
    dir.writeUInt32LE(offset, off + 12);
    offset += e.data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

const outDir = new URL("../src-tauri/icons/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const png256 = pngRGBA(256);
const png128 = pngRGBA(128);
const png32 = pngRGBA(32);
const ico = buildIco([
  { size: 16, data: bmpIcoEntry(16) },
  { size: 32, data: bmpIcoEntry(32) },
  { size: 256, data: png256 },
]);

writeFileSync(new URL("icon.ico", outDir), ico);
writeFileSync(new URL("icon.png", outDir), png256);
writeFileSync(new URL("128x128.png", outDir), png128);
writeFileSync(new URL("32x32.png", outDir), png32);

console.log(`icons generated: icon.ico=${ico.length}B icon.png=${png256.length}B 128x128.png=${png128.length}B 32x32.png=${png32.length}B`);
