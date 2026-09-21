// scripts/generate-icons.ts
//
// Generates the PWA icon set from the design language, with no image dependencies.
//
// Why a script instead of four committed PNGs: the icons are derived from two tokens (the primary
// blue and white), so re-runs are reproducible and re-branding is a one-line change rather than a
// trip through a design tool. Run with `npm run icons`.
//
// Encoding note: a PNG is a signature plus length/type/data/CRC32 chunks. We render supersampled at
// 4x and box-filter down, which is what keeps the ring and the clock hands smooth at 192px.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- design tokens (mirrors src/app/globals.css) -------------------------------
const BG: RGB = [0x3e, 0x6b, 0x8c]; // --color-primary-500
const FG: RGB = [0xff, 0xff, 0xff];

type RGB = [number, number, number];

// ---- PNG encoding --------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** RGBA8, no interlacing. */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter byte (0 = none).
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- drawing -------------------------------------------------------------------

const SS = 4; // supersampling factor

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * A clock face: ring, centre dot, and two hands. Deliberately simple — it has to read instantly at
 * 192px and survive being cropped to a circle by a launcher, so all artwork stays inside the inner
 * 80% (the maskable safe zone).
 */
function renderIcon(size: number): Buffer {
  const S = size * SS;
  const cx = S / 2;
  const cy = S / 2;
  const ringRadius = S * 0.34;
  const ringWidth = S * 0.055;
  const dotRadius = S * 0.035;
  const handWidth = S * 0.055;

  // Clock hands at 10:10 — the conventional "open for business" pose, and visibly asymmetric.
  const minuteAngle = -Math.PI / 2 - Math.PI * 0.28; // ~10 past
  const hourAngle = -Math.PI / 2 + Math.PI * 0.16;
  const minuteTip = [cx + Math.cos(minuteAngle) * ringRadius * 0.92, cy + Math.sin(minuteAngle) * ringRadius * 0.92];
  const hourTip = [cx + Math.cos(hourAngle) * ringRadius * 0.62, cy + Math.sin(hourAngle) * ringRadius * 0.62];

  const hi = new Uint8Array(S * S * 4);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d = Math.hypot(px - cx, py - cy);

      const onRing = Math.abs(d - ringRadius) <= ringWidth / 2;
      const onDot = d <= dotRadius;
      const onMinute = distanceToSegment(px, py, cx, cy, minuteTip[0]!, minuteTip[1]!) <= handWidth / 2;
      const onHour = distanceToSegment(px, py, cx, cy, hourTip[0]!, hourTip[1]!) <= handWidth / 2;

      const [r, g, b] = onRing || onDot || onMinute || onHour ? FG : BG;
      const offset = (y * S + x) * 4;
      hi[offset] = r;
      hi[offset + 1] = g;
      hi[offset + 2] = b;
      hi[offset + 3] = 255; // fully opaque: required for a maskable icon
    }
  }

  // Box-filter the supersampled buffer down to the target size.
  const out = new Uint8Array(size * size * 4);
  const samples = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const offset = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          r += hi[offset]!;
          g += hi[offset + 1]!;
          b += hi[offset + 2]!;
        }
      }
      const outOffset = (y * size + x) * 4;
      out[outOffset] = Math.round(r / samples);
      out[outOffset + 1] = Math.round(g / samples);
      out[outOffset + 2] = Math.round(b / samples);
      out[outOffset + 3] = 255;
    }
  }

  return encodePng(size, size, out);
}

// ---- output --------------------------------------------------------------------

const targets: { file: string; size: number; purpose: string }[] = [
  { file: "icon-192.png", size: 192, purpose: "any" },
  { file: "icon-512.png", size: 512, purpose: "any" },
  { file: "maskable-512.png", size: 512, purpose: "maskable" },
  { file: "apple-touch-icon.png", size: 180, purpose: "iOS home screen" },
];

const outDir = join(process.cwd(), "public", "icons");
mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  const png = renderIcon(target.size);
  writeFileSync(join(outDir, target.file), png);
  console.log(`  ${target.file.padEnd(24)} ${target.size}x${target.size}  ${target.purpose}  ${png.length} bytes`);
}

console.log(`\nWrote ${targets.length} icons to public/icons`);
