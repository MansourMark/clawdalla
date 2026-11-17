// Draws the Clawdalla icon as PNG files (no image libraries needed).
import { deflateSync, crc32 } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  const ss = 3
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = pixel(((x + (sx + 0.5) / ss) / size) * 512, ((y + (sy + 0.5) / ss) / size) * 512)
        r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]
      }
      const o = y * (size * 4 + 1) + 1 + x * 4
      if (a > 0) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a) }
      raw[o + 3] = Math.round((a / (ss * ss)) * 255)
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const head = Buffer.alloc(13); head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

const BG = [0x11, 0x14, 0x18], TEAL = [0x2d, 0xd4, 0xbf], WHITE = [0xf6, 0xf7, 0xf8]
const cx = 344 - Math.sqrt(112 * 112 - 80 * 80), cy = 256, R = 112, W = 22, gap = Math.acos((344 - cx) / R)
function icon(pad) {
  return (x, y) => {
    // rounded square, optionally inset (macOS icons have a margin)
    const s = 512 - pad * 2, rad = 112 * (s / 512)
    const px = Math.abs(x - 256) - (s / 2 - rad), py = Math.abs(y - 256) - (s / 2 - rad)
    const outside = px > 0 && py > 0 ? Math.hypot(px, py) > rad : px > rad || py > rad
    if (outside) return [0, 0, 0, 0]
    const k = s / 512, ux = (x - 256) / k + 256, uy = (y - 256) / k + 256
    if (Math.hypot(ux - 356, uy - 256) <= 26) return [...WHITE, 1]
    const d = Math.hypot(ux - cx, uy - cy), ang = Math.abs(Math.atan2(uy - cy, ux - cx))
    const onArc = ang >= gap ? Math.abs(d - R) <= W : Math.min(Math.hypot(ux - 344, uy - 176), Math.hypot(ux - 344, uy - 336)) <= W
    return onArc ? [...TEAL, 1] : [...BG, 1]
  }
}
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png(1024, icon(52)))
writeFileSync('web/public/icon-512.png', png(512, icon(0)))
writeFileSync('web/public/icon-192.png', png(192, icon(0)))
writeFileSync('web/public/icon-180.png', png(180, icon(0)))
writeFileSync('build/tray.png', png(32, icon(0)))
console.log('icons written')
