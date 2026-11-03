// Measure plaque reading on the photos in private/plaques/floor<N>/.
//   npm run ocr-eval            (floor 3, all variants)
//   npm run ocr-eval -- --quick (originals only)
// Each photo is tested as taken and with distortions that mimic real use:
// dim light, a tilted phone, motion blur, a smaller/farther plaque, and the
// plaque off-center. A room only counts as read if it's the right room; a wrong
// room is worse than no answer, so those are listed separately.
import { createWorker, OEM } from 'tesseract.js'
import sharp from 'sharp'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readPlaque, charWhitelist, type Gray } from '../src/locate/plaque.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const floor = process.argv.find((a) => /^\d$|^[BG]$/.test(a)) ?? '3'
const quick = process.argv.includes('--quick')
const dir = `${ROOT}private/plaques/floor${floor}/`
if (!existsSync(dir)) { console.error(`No photos in ${dir}`); process.exit(1) }
const g = JSON.parse(readFileSync(`${ROOT}src/data/floor${floor}.graph.json`, 'utf8'))
const rooms = Object.keys(g.rooms)
const files = readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort()

const worker = await createWorker('eng', OEM.LSTM_ONLY, { langPath: `${ROOT}node_modules/@tesseract.js-data/eng/4.0.0_best_int`, gzip: true, cachePath: `${ROOT}node_modules/.cache/tesseract` })
await worker.setParameters({ tessedit_pageseg_mode: '7' as never, tessedit_char_whitelist: charWhitelist(rooms), user_defined_dpi: '300' })
const read = async (line: Gray) => {
  const png = await sharp(Buffer.from(line.d), { raw: { width: line.w, height: line.h, channels: 1 } }).png().toBuffer()
  return (await worker.recognize(png)).data.text
}

// What the outline crop looks like on the phone: roughly 720 px wide.
type Variant = [string, (s: sharp.Sharp, m: { width: number; height: number }) => sharp.Sharp]
const VARIANTS: Variant[] = [
  ['as taken', (s) => s],
  ['dim', (s) => s.linear(0.35, 0).gamma(1.6)],
  ['tilt 10°', (s) => s.rotate(10, { background: '#888' })],
  ['tilt -10°', (s) => s.rotate(-10, { background: '#888' })],
  ['blur', (s) => s.blur(2.2)],
  ['farther', (s, m) => s.resize({ width: Math.round(m.width * 0.6) }).extend({ top: Math.round(m.height * 0.2), bottom: Math.round(m.height * 0.2), left: Math.round(m.width * 0.2), right: Math.round(m.width * 0.2), background: '#d8d4cf' })],
  ['off-center', (s, m) => s.extract({ left: Math.round(m.width * 0.12), top: Math.round(m.height * 0.1), width: Math.round(m.width * 0.85), height: Math.round(m.height * 0.85) })],
]
const use = quick ? VARIANTS.slice(0, 1) : VARIANTS

const tally = new Map<string, { ok: number; wrong: number; none: number }>()
const misses: string[] = []
const t0 = Date.now()
let n = 0
for (const f of files) {
  const want = f.replace(/^\d-/, '').replace(/(_\d+)?\.jpe?g$/i, '').toUpperCase()
  const meta = await sharp(dir + f).metadata()
  for (const [name, fn] of use) {
    const buf = await fn(sharp(dir + f).rotate(), { width: meta.width!, height: meta.height! }).toBuffer()
    const { data, info } = await sharp(buf).resize({ width: 720 }).grayscale().raw().toBuffer({ resolveWithObject: true })
    const r = await readPlaque({ w: info.width, h: info.height, d: new Uint8Array(data) }, rooms, read)
    const t = tally.get(name) ?? { ok: 0, wrong: 0, none: 0 }
    if (r.room === want) t.ok++
    else if (r.room) { t.wrong++; misses.push(`WRONG  ${want.padEnd(5)} ${name.padEnd(11)} read as ${r.room}  ${JSON.stringify(r.readings)}`) }
    else { t.none++; misses.push(`none   ${want.padEnd(5)} ${name.padEnd(11)} ${JSON.stringify(r.readings)}`) }
    tally.set(name, t)
    n++
  }
}
await worker.terminate()

console.log(misses.join('\n'))
console.log(`\nFloor ${floor}: ${files.length} photos, ${Math.round((Date.now() - t0) / n)} ms per frame on this computer\n`)
console.log('condition     correct   wrong room   no answer')
let O = 0, W = 0, N = 0
for (const [name, t] of tally) {
  const tot = t.ok + t.wrong + t.none
  O += t.ok; W += t.wrong; N += t.none
  console.log(`${name.padEnd(12)} ${(100 * t.ok / tot).toFixed(1).padStart(6)}%   ${String(t.wrong).padStart(6)}      ${String(t.none).padStart(6)}`)
}
const T = O + W + N
console.log(`${'all'.padEnd(12)} ${(100 * O / T).toFixed(1).padStart(6)}%   ${String(W).padStart(6)}      ${String(N).padStart(6)}`)
