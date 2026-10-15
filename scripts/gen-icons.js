import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function crc32(buf) {
  let table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const body = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crcBuf]);
}

function createPng(size) {
  const width = size;
  const height = size;
  const scanlineLength = width * 4 + 1;
  const rawData = Buffer.alloc(scanlineLength * height);

  const radius = size * 0.22;
  const cx = size / 2;
  const cy = size / 2;
  const half = size / 2;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineLength;
    rawData[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;

      const dx = Math.abs(x - (half - 0.5));
      const dy = Math.abs(y - (half - 0.5));
      const r = half - radius;
      
      let inBounds = false;
      if (dx <= r || dy <= r) {
        inBounds = (dx <= half && dy <= half);
      } else {
        const cdx = dx - r;
        const cdy = dy - r;
        inBounds = (cdx * cdx + cdy * cdy <= radius * radius);
      }

      if (inBounds) {
        let rVal = 17, gVal = 18, bVal = 21, aVal = 255;
        const dCenter = Math.abs(x - cx) + Math.abs(y - cy);
        if (dCenter <= size * 0.28) {
          rVal = 16;
          gVal = 185;
          bVal = 129;
          aVal = 255;
        } else if (dCenter <= size * 0.32) {
          rVal = 5;
          gVal = 150;
          bVal = 105;
          aVal = 240;
        }

        rawData[pxOffset] = rVal;
        rawData[pxOffset + 1] = gVal;
        rawData[pxOffset + 2] = bVal;
        rawData[pxOffset + 3] = aVal;
      } else {
        rawData[pxOffset] = 0;
        rawData[pxOffset + 1] = 0;
        rawData[pxOffset + 2] = 0;
        rawData[pxOffset + 3] = 0;
      }
    }
  }

  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idatData = zlib.deflateSync(rawData);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

const extDir = path.join(__dirname, '..', 'extension');
if (!fs.existsSync(extDir)) {
  fs.mkdirSync(extDir, { recursive: true });
}

[16, 48, 128].forEach(sz => {
  const buf = createPng(sz);
  fs.writeFileSync(path.join(extDir, `icon${sz}.png`), buf);
  console.log(`Generated extension/icon${sz}.png (${sz}x${sz})`);
});
