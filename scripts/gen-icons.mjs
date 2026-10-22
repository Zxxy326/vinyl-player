/* 生成应用图标：一张红色黑胶唱片，输出 PNG 多尺寸 + Windows ICO
   纯 Node 手写 PNG（zlib 已内置），不依赖任何图形库 */
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src-tauri', 'icons');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf){
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data){
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba){
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++){
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function lerp(a, b, t){ return a + (b - a) * t; }
function mix(c1, c2, t){ return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }

function render(size, scale = 1){
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const R = size * 0.475 * scale;
  const labelR = R * 0.368;
  const holeR = R * 0.059;

  for (let y = 0; y < size; y++){
    for (let x = 0; x < size; x++){
      const i = (y * size + x) * 4;
      const dx = x - cx + 0.5, dy = y - cy + 0.5;
      const d = Math.sqrt(dx * dx + dy * dy);

      if (d > R){
        // 边缘 1px 抗锯齿
        const a = Math.max(0, Math.min(1, (R - d) * 1.5));
        if (a <= 0) continue;
        buf[i + 3] = Math.round(a * 255);
        buf[i] = 20; buf[i + 1] = 8; buf[i + 2] = 9;
        continue;
      }

      let col;
      if (d < holeR){
        col = [10, 8, 8];
      } else if (d < labelR){
        const t = (d - holeR) / (labelR - holeR);
        col = mix([227, 60, 70], [165, 21, 30], Math.pow(t, 0.8));
      } else {
        // 唱片本体 + 同心纹路
        const t = (d - labelR) / (R - labelR);
        const ring = Math.sin(d * 0.55) * 0.5 + 0.5;
        const base = mix([26, 26, 26], [6, 6, 6], Math.pow(t, 0.55));
        const g = ring * 10 + 6;
        col = [base[0] + g, base[1] + g, base[2] + g];
        // 左上高光
        const hx = (x - cx * 0.72) / size, hy = (y - cy * 0.7) / size;
        const hl = Math.max(0, 1 - Math.sqrt(hx * hx + hy * hy) * 6.2);
        if (t > 0.12) col = col.map(v => v + hl * 26);
      }

      buf[i] = Math.min(255, Math.round(col[0]));
      buf[i + 1] = Math.min(255, Math.round(col[1]));
      buf[i + 2] = Math.min(255, Math.round(col[2]));
      buf[i + 3] = 255;
    }
  }
  return buf;
}

function ico(entries){
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(entries.length * 16);
  let offset = 6 + entries.length * 16;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([head, dir, ...entries.map(e => e.png)]);
}

await mkdir(OUT, { recursive: true });

const sizes = [32, 48, 64, 128, 256, 512];
const pngs = [];
for (const s of sizes){
  const png = encodePng(s, s, render(s));
  pngs.push({ size: s, png });
  if (s <= 256) await writeFile(path.join(OUT, `${s}x${s}.png`), png);
}
await writeFile(path.join(OUT, '128x128@2x.png'), pngs.find(p => p.size === 512).png);

const iconEntries = pngs.filter(p => p.size <= 256);
await writeFile(path.join(OUT, 'icon.ico'), ico(iconEntries));
await writeFile(path.join(OUT, 'icon.png'), pngs.find(p => p.size === 256).png);

console.log('✓ icons:', sizes.join(', ') + ' + icon.ico');

/* ---- Android ---- */
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const DENSITIES = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4],
];

// legacy 图标：48dp
for (const [name, mult] of DENSITIES){
  const dir = path.join(RES, `mipmap-${name}`);
  await mkdir(dir, { recursive: true });
  const s = Math.round(48 * mult);
  await writeFile(path.join(dir, 'ic_launcher.png'), encodePng(s, s, render(s)));
  await writeFile(path.join(dir, 'ic_launcher_round.png'), encodePng(s, s, render(s)));
}

// adaptive icon 前景：108dp 画布，内容缩到 72/108
for (const [name, mult] of DENSITIES){
  const dir = path.join(RES, `drawable-${name}`);
  await mkdir(dir, { recursive: true });
  const s = Math.round(108 * mult);
  await writeFile(
    path.join(dir, 'ic_launcher_foreground.png'),
    encodePng(s, s, render(s, 72 / 108))
  );
}

const anydpi = path.join(RES, 'mipmap-anydpi-v26');
await mkdir(anydpi, { recursive: true });
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;
await writeFile(path.join(anydpi, 'ic_launcher.xml'), adaptive);
await writeFile(path.join(anydpi, 'ic_launcher_round.xml'), adaptive);

const colorsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#141011</color>
</resources>
`;
await writeFile(path.join(RES, 'values', 'ic_launcher_background.xml'), colorsXml);

console.log('✓ android icons: mipmap-* (legacy) + drawable-* (adaptive foreground)');
