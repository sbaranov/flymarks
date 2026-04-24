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
  const scale = 8;
  const hi = size * scale;
  const view = 16;
  const rgba = Buffer.alloc(size * size * 4, 0);
  const hiAlpha = new Uint8Array(hi * hi);
  const ink = [220, 220, 220];

  function toPx(value) {
    return (value / view) * hi;
  }

  function drawLine(x1, y1, x2, y2, stroke) {
    const ax = toPx(x1);
    const ay = toPx(y1);
    const bx = toPx(x2);
    const by = toPx(y2);
    const radius = toPx(stroke) / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;

    for (let py = 0; py < hi; py += 1) {
      for (let px = 0; px < hi; px += 1) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len2));
        const nx = ax + t * dx;
        const ny = ay + t * dy;
        if (Math.hypot(cx - nx, cy - ny) <= radius) {
          hiAlpha[py * hi + px] = 255;
        }
      }
    }
  }

  function downsample() {
    const area = scale * scale;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let alpha = 0;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            alpha += hiAlpha[(y * scale + sy) * hi + x * scale + sx];
          }
        }
        const i = (y * size + x) * 4;
        rgba[i] = ink[0];
        rgba[i + 1] = ink[1];
        rgba[i + 2] = ink[2];
        rgba[i + 3] = Math.round(alpha / area);
      }
    }
  }

  const stroke = 1.2;
  drawLine(1.25, 1.65, 14.75, 1.65, stroke);
  drawLine(1.25, 1.65, 1.25, 14.35, stroke);
  drawLine(14.75, 1.65, 14.75, 14.35, stroke);
  drawLine(1.25, 14.35, 8, 10.45, stroke);
  drawLine(14.75, 14.35, 8, 10.45, stroke);
  downsample();

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
