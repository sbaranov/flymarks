import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, crc]);
}

function makePng(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const dark = [95, 99, 104, 255];
  const light = [95, 99, 104, 80];

  function px(x, y, color) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = color[0];
    rgba[i + 1] = color[1];
    rgba[i + 2] = color[2];
    rgba[i + 3] = color[3];
  }

  const s = size;
  const stroke = Math.max(1, Math.round(size / 16));
  const left = Math.round(s * 0.16);
  const right = Math.round(s * 0.84);
  const top = Math.round(s * 0.22);
  const mid = Math.round(s * 0.38);
  const bottom = Math.round(s * 0.78);

  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const border = x <= left + stroke || x >= right - stroke || y <= mid + stroke || y >= bottom - stroke;
      if (border) px(x, y, dark);
      else if (y <= mid + stroke * 2) px(x, y, light);
    }
  }

  for (let x = left + stroke; x < left + Math.round(s * 0.36); x++) {
    for (let y = top - stroke; y <= mid; y++) {
      if (y <= top + stroke || x <= left + stroke * 2) px(x, y, dark);
      else px(x, y, light);
    }
  }

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    rgba.copy(row, 1, y * size * 4, (y + 1) * size * 4);
    rows.push(row);
  }

  const idat = zlib.deflateSync(Buffer.concat(rows));
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.resolve(process.cwd(), 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), makePng(size));
}
console.log('Generated icons:', outDir);
