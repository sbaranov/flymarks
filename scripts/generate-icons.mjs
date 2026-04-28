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
  const hiRgba = Buffer.alloc(hi * hi * 4, 0);
  const blue = [26, 115, 232, 255];
  const lightBlue = [138, 180, 248, 255];

  function toPx(value) {
    return (value / view) * hi;
  }

  function pointInPolygon(px, py, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const xi = toPx(points[i][0]);
      const yi = toPx(points[i][1]);
      const xj = toPx(points[j][0]);
      const yj = toPx(points[j][1]);
      const crosses = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function paint(x, y, color) {
    const i = (y * hi + x) * 4;
    hiRgba[i] = color[0];
    hiRgba[i + 1] = color[1];
    hiRgba[i + 2] = color[2];
    hiRgba[i + 3] = color[3];
  }

  function fillPolygon(points, color) {
    for (let y = 0; y < hi; y += 1) {
      for (let x = 0; x < hi; x += 1) {
        if (pointInPolygon(x + 0.5, y + 0.5, points)) paint(x, y, color);
      }
    }
  }

  function downsample() {
    const area = scale * scale;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const hiIndex = ((y * scale + sy) * hi + x * scale + sx) * 4;
            const alpha = hiRgba[hiIndex + 3];
            r += hiRgba[hiIndex] * alpha;
            g += hiRgba[hiIndex + 1] * alpha;
            b += hiRgba[hiIndex + 2] * alpha;
            a += alpha;
          }
        }
        const i = (y * size + x) * 4;
        rgba[i] = a ? Math.round(r / a) : 0;
        rgba[i + 1] = a ? Math.round(g / a) : 0;
        rgba[i + 2] = a ? Math.round(b / a) : 0;
        rgba[i + 3] = Math.round(a / area);
      }
    }
  }

  fillPolygon([
    [1.85, 0.65],
    [14.15, 0.65],
    [14.15, 15.55],
    [8, 11.45],
    [1.85, 15.55],
  ], blue);
  fillPolygon([
    [10.45, 0.65],
    [14.15, 0.65],
    [14.15, 15.55],
    [10.45, 13.08],
  ], lightBlue);
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
