#!/usr/bin/env node
/**
 * make-icons.mjs — generate HOPPA's PWA icons as real PNGs.
 *
 * Why hand-roll a PNG encoder instead of shipping binary art? Because this is
 * a learning rig: the icons should be reproducible from source, diffable, and
 * regenerable when the palette changes. No image deps, no checked-in blobs.
 *
 * PNG = signature + IHDR + IDAT(zlib-deflated scanlines) + IEND, each chunk
 * CRC32-tagged. That is the entirety of what we need for 8-bit RGBA.
 *
 *   node tools/make-icons.mjs
 *   → src/public/icons/{icon-192,icon-512,maskable-512}.png
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/* --- PNG plumbing ------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                                   // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* --- a very small software rasteriser ----------------------------------- */

function surface(size, hex) {
  const [r, g, b] = hex2rgb(hex);
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255;
  }
  return buf;
}

function hex2rgb(hex) {
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function blend(buf, size, x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  if (i < 0 || i + 3 >= buf.length) return;
  buf[i] = Math.round(buf[i] * (1 - a) + r * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + g * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + b * a);
}

/** rounded rectangle via signed-distance test — gives us antialiased corners */
function roundRect(buf, size, x0, y0, w, h, radius, hex, alpha = 1) {
  const c = hex2rgb(hex);
  const r = Math.min(radius, w / 2, h / 2);
  for (let y = Math.floor(y0 - 1); y < Math.ceil(y0 + h + 1); y++) {
    for (let x = Math.floor(x0 - 1); x < Math.ceil(x0 + w + 1); x++) {
      const dx = Math.max(x0 + r - x, x - (x0 + w - r), 0);
      const dy = Math.max(y0 + r - y, y - (y0 + h - r), 0);
      const d = Math.hypot(dx, dy) - r;
      const cov = Math.max(0, Math.min(1, 0.5 - d));   // 1px antialias band
      if (cov > 0) blend(buf, size, x, y, c, cov * alpha);
    }
  }
}

function disc(buf, size, cx, cy, radius, hex, alpha = 1) {
  const c = hex2rgb(hex);
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++) {
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius;
      const cov = Math.max(0, Math.min(1, 0.5 - d));
      if (cov > 0) blend(buf, size, x, y, c, cov * alpha);
    }
  }
}

/* --- the artwork -------------------------------------------------------- */

const BG = '#0b1020';
const BG_HI = '#141d38';
const CYAN = '#57e2c8';
const AMBER = '#ffb454';
const INK = '#06202a';

/**
 * @param size    pixel size
 * @param inset   fraction of the canvas reserved as padding. Android maskable
 *                icons are cropped to a circle/squircle, so all art must sit
 *                inside the central 80% — inset 0.20 handles that.
 */
function draw(size, inset) {
  const buf = surface(size, BG);
  const s = size;
  const pad = s * inset;

  // soft top-down lift so the icon isn't a flat slab
  const [r1, g1, b1] = hex2rgb(BG_HI);
  for (let y = 0; y < s; y++) {
    const a = (y / s) * 0.85;
    for (let x = 0; x < s; x++) blend(buf, s, x, y, [r1, g1, b1], a * 0.5);
  }

  const inner = s - pad * 2;
  const unit = inner / 10;            // art is laid out on a 10x10 grid

  // ground band
  const groundY = pad + unit * 7.4;
  roundRect(buf, s, pad, groundY, inner, unit * 0.55, unit * 0.2, CYAN, 0.28);

  // obstacle (what you jump over)
  roundRect(buf, s, pad + unit * 6.1, groundY - unit * 2.5, unit * 1.5, unit * 2.5, unit * 0.28, AMBER);

  // the hopper, mid-air
  const px = pad + unit * 1.6;
  const py = groundY - unit * 3.9;
  const side = unit * 2.9;
  roundRect(buf, s, px, py, side, side, unit * 0.7, CYAN);
  disc(buf, s, px + side * 0.72, py + side * 0.34, Math.max(1, unit * 0.24), INK);

  // a little shadow so the hop reads as vertical motion
  disc(buf, s, px + side * 0.5, groundY + unit * 0.1, side * 0.42, CYAN, 0.14);

  return buf;
}

/* --- emit --------------------------------------------------------------- */

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../src/public/icons');
mkdirSync(outDir, { recursive: true });

const targets = [
  ['icon-192.png', 192, 0.06],
  ['icon-512.png', 512, 0.06],
  ['maskable-512.png', 512, 0.20]    // safe-zone for Android adaptive masks
];

for (const [name, size, inset] of targets) {
  const png = encodePng(size, size, draw(size, inset));
  writeFileSync(resolve(outDir, name), png);
  console.log(`  ${name.padEnd(18)} ${size}x${size}  ${png.length} bytes`);
}
console.log(`\nicons written to ${outDir}`);
