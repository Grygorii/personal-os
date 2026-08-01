// Draws the Kept icon as a real PNG, with no image library.
//
// It has to be a PNG: iOS ignores SVG for Add to Home Screen, so a site whose only icon is
// an SVG gets a generic auto-generated thumbnail on the home screen — right at the moment
// someone has just decided to trust you enough to install.
//
//   node scripts/make-icons.mjs
//
// Same shapes as the inline SVG in webserver.js, kept in one place here.
import { deflateSync } from 'zlib';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const INK = [0x14, 0x13, 0x0f];
const GOLD = [0xd9, 0xae, 0x4a];
const SPINE = [0xb8, 0x91, 0x2f];

// --- geometry, in the original 512-unit space ---
const BOOK = { x: 150, y: 120, w: 212, h: 272, r: 18 };
const SPINE_W = 46;
const CHECK = [[232, 268], [262, 298], [324, 226]];
const CHECK_W = 26;

const insideRoundRect = (x, y, { x: rx, y: ry, w, h, r }) => {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

// Distance to a segment — round caps and joins fall out of this for free.
function distToSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function sample(x, y) {
  for (let i = 0; i < CHECK.length - 1; i++) {
    if (distToSeg(x, y, CHECK[i], CHECK[i + 1]) <= CHECK_W / 2) return INK;
  }
  if (insideRoundRect(x, y, BOOK)) {
    return x <= BOOK.x + SPINE_W ? SPINE : GOLD;
  }
  return INK;
}

// 3x3 supersampling, so the curves don't come out jagged.
function render(size) {
  const s = size / 512, SS = 3;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((pxi + (sx + 0.5) / SS) / s, (py + (sy + 0.5) / SS) / s);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS, o = (py * size + pxi) * 4;
      px[o] = Math.round(r / n); px[o + 1] = Math.round(g / n); px[o + 2] = Math.round(b / n);
      px[o + 3] = 255; // fully opaque: iOS composites onto white and hates transparency here
    }
  }
  return px;
}

// --- minimal PNG writer ---
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) {
  const out = fileURLToPath(new URL(`../webapp/icon-${size}.png`, import.meta.url));
  const buf = png(size, render(size));
  writeFileSync(out, buf);
  console.log(`  icon-${size}.png  ${(buf.length / 1024).toFixed(1)} KB`);
}

// The link-preview card. Without one, a shared link renders as a grey box on LinkedIn,
// WhatsApp and X — which is most of the first impression, on the surface where a stranger
// decides whether to click. 1200x630 is the ratio that gets the LARGE card rather than a
// thumbnail; the words come from og:title and og:description, which every scraper renders
// underneath, so this only has to carry the mark.
function renderOg() {
  const W = 1200, H = 630, SS = 3;
  const px = Buffer.alloc(W * H * 4);
  const mark = 300, mx = (W - mark) / 2, my = (H - mark) / 2;
  const s = mark / 512;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
          let c;
          if (fy < 10) c = GOLD;                                   // the rule along the top
          else if (fx >= mx && fx < mx + mark && fy >= my && fy < my + mark)
            c = sample((fx - mx) / s, (fy - my) / s);
          else c = INK;
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS, o = (y * W + x) * 4;
      px[o] = Math.round(r / n); px[o + 1] = Math.round(g / n); px[o + 2] = Math.round(b / n);
      px[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
{
  const buf = renderOg();
  writeFileSync(fileURLToPath(new URL('../webapp/og.png', import.meta.url)), buf);
  console.log(`  og.png        ${(buf.length / 1024).toFixed(1)} KB  (1200x630)`);
}
