/**
 * Generates the PWA PNG icons from the brand mark with zero dependencies.
 *
 * The mark mirrors `public/favicon.svg`: an accent-orange disc (#f97316) on a
 * warm near-black field (ink-950 #0a0a06). The disc radius (0.34·size) keeps
 * it inside a maskable icon's 80% safe zone, so the same art works for
 * `purpose: "any maskable"` and for iOS's own corner rounding.
 *
 * Run with: `node scripts/gen-pwa-icons.mjs`
 */
import zlib from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(__dirname, '..', 'public')

// --- minimal PNG encoder (8-bit RGBA) ----------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// --- render: orange disc on ink field, supersampled edge ----------------------
const BG = [10, 10, 6]
const FG = [249, 115, 22]
const R_RATIO = 0.34
function render(size) {
  const ss = 4
  const rgba = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size / 2
  const r = R_RATIO * size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss
          const py = y + (sy + 0.5) / ss
          if (Math.hypot(px - cx, py - cy) <= r) hit++
        }
      }
      const a = hit / (ss * ss)
      const i = (y * size + x) * 4
      rgba[i] = Math.round(BG[0] * (1 - a) + FG[0] * a)
      rgba[i + 1] = Math.round(BG[1] * (1 - a) + FG[1] * a)
      rgba[i + 2] = Math.round(BG[2] * (1 - a) + FG[2] * a)
      rgba[i + 3] = 255
    }
  }
  return encodePNG(size, size, rgba)
}

mkdirSync(PUBLIC, { recursive: true })
const targets = [
  ['pwa-192.png', 192],
  ['pwa-512.png', 512],
  ['apple-touch-icon.png', 180],
]
for (const [name, size] of targets) {
  writeFileSync(join(PUBLIC, name), render(size))
  console.log(`wrote public/${name} (${size}x${size})`)
}
