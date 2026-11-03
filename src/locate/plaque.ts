// Phase 4, tier 2: reading room-number plaques.
//
// Pure image + text code with no browser or Tesseract dependency, so the same
// steps run on the phone (locate page) and in Node (tools/ocr-eval.ts, tests).
//
// Pipeline for one camera frame (the part inside the on-screen outline):
//   1. grayscale
//   2. adaptive threshold (handles the shadows raised 3D letters cast, and
//      light falling off across the plaque)
//   3. connected components → glyph-sized blobs
//   4. group blobs into text lines; the room number is the tallest line of
//      2–6 glyphs (true for every plaque style on floor 3: square name plates,
//      wide landscape signs, and the paper printouts on 312/314)
//   5. Tesseract reads only the top few line crops, one line at a time
//   6. fuzzy-match each reading against the known room list

export interface Gray { w: number; h: number; d: Uint8Array }
export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface TextLine extends Box { glyphs: number; score: number; parts: Box[]; angle: number }

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const d = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8
  return { w, h, d }
}

/** Bradley-style adaptive threshold: a pixel is ink if it's `k` darker than the
 *  mean of its (2r+1)² neighborhood. Returns 1 = ink. */
export function adaptiveThreshold(g: Gray, r = Math.max(8, Math.round(Math.min(g.w, g.h) / 12)), k = 0.16): Uint8Array {
  const { w, h, d } = g
  const W = w + 1
  const I = new Float64Array(W * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += d[y * w + x]
      I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row
    }
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1)
      const sum = I[yb * W + xb] - I[ya * W + xb] - I[yb * W + xa] + I[ya * W + xa]
      const mean = sum / ((yb - ya) * (xb - xa))
      out[y * w + x] = d[y * w + x] < mean * (1 - k) ? 1 : 0
    }
  }
  return out
}

interface Blob extends Box { area: number }

/** 8-connected components of ink pixels. */
export function components(bin: Uint8Array, w: number, h: number): Blob[] {
  const label = new Int32Array(w * h).fill(-1)
  const blobs: Blob[] = []
  const stack: number[] = []
  for (let s = 0; s < bin.length; s++) {
    if (!bin[s] || label[s] >= 0) continue
    const id = blobs.length
    const b: Blob = { x0: w, y0: h, x1: 0, y1: 0, area: 0 }
    label[s] = id; stack.push(s)
    while (stack.length) {
      const p = stack.pop()!
      const x = p % w, y = (p - x) / w
      b.area++
      if (x < b.x0) b.x0 = x
      if (x > b.x1) b.x1 = x
      if (y < b.y0) b.y0 = y
      if (y > b.y1) b.y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const q = yy * w + xx
          if (bin[q] && label[q] < 0) { label[q] = id; stack.push(q) }
        }
      }
    }
    b.x1++; b.y1++
    blobs.push(b)
  }
  return blobs
}

/** Find candidate text lines, best (most room-number-like) first. */
export function findTextLines(g: Gray, opts: { maxLines?: number } = {}): TextLine[] {
  const bin = adaptiveThreshold(g)
  const H = Math.min(g.w, g.h)
  // Glyph-sized blobs: room digits are at least ~3% of the frame tall.
  const glyphs = components(bin, g.w, g.h).filter((b) => {
    const bh = b.y1 - b.y0, bw = b.x1 - b.x0
    if (bh < H * 0.03 || bh > H * 0.5) return false
    if (bw > bh * 1.3 || bw < bh * 0.08) return false     // "1" is thin, nothing is much wider than tall
    const fill = b.area / (bw * bh)
    const bar = bw < bh * 0.3                              // "1" and "I" are solid bars in this typeface
    if (fill < 0.12 || (fill > 0.9 && !bar)) return false // strokes, not solid blocks or speckle
    if (b.x0 <= 0 || b.y0 <= 0 || b.x1 >= g.w || b.y1 >= g.h) return false // cut off by the frame edge
    return true
  }).sort((a, b) => a.x0 - b.x0)

  // Chain glyphs of similar height that sit on roughly the same baseline.
  const used = new Uint8Array(glyphs.length)
  const lines: TextLine[] = []
  for (let i = 0; i < glyphs.length; i++) {
    if (used[i]) continue
    const seed = glyphs[i]
    const h0 = seed.y1 - seed.y0
    const line: Blob[] = [seed]; used[i] = 1
    let last = seed
    for (let j = i + 1; j < glyphs.length; j++) {
      if (used[j]) continue
      const c = glyphs[j], hc = c.y1 - c.y0
      if (hc < h0 * 0.7 || hc > h0 * 1.4) continue
      if (Math.abs(c.y1 - last.y1) > h0 * 0.25) continue    // baseline
      // A bar must match the cap height closely, or it's a plaque edge or door frame.
      const isBar = (b: Blob) => b.x1 - b.x0 < (b.y1 - b.y0) * 0.3
      if ((isBar(c) || isBar(last)) && (Math.abs(hc - (last.y1 - last.y0)) > h0 * 0.15 || Math.abs(c.y0 - last.y0) > h0 * 0.18)) continue
      const gap = c.x0 - last.x1
      if (gap < -h0 * 0.15 || gap > h0 * 0.9) continue
      line.push(c); used[j] = 1; last = c
    }
    if (line.length < 2 || line.length > 6) continue
    const box: Box = {
      x0: Math.min(...line.map((b) => b.x0)), y0: Math.min(...line.map((b) => b.y0)),
      x1: Math.max(...line.map((b) => b.x1)), y1: Math.max(...line.map((b) => b.y1)),
    }
    const lh = box.y1 - box.y0
    // Room numbers are 3–4 glyphs; taller is better.
    const countFit = line.length >= 3 && line.length <= 4 ? 1 : 0.6
    // Baseline slope: least squares through the glyph bottoms.
    const cx = line.map((b) => (b.x0 + b.x1) / 2), by = line.map((b) => b.y1)
    const mx = cx.reduce((a, v) => a + v, 0) / cx.length, my = by.reduce((a, v) => a + v, 0) / by.length
    let sxy = 0, sxx = 0
    cx.forEach((x, k) => { sxy += (x - mx) * (by[k] - my); sxx += (x - mx) ** 2 })
    const angle = sxx > 0 ? Math.max(-0.35, Math.min(0.35, Math.atan(sxy / sxx))) : 0
    lines.push({ ...box, glyphs: line.length, score: lh * countFit, angle, parts: line.map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 })) })
  }
  lines.sort((a, b) => b.score - a.score)
  return lines.slice(0, opts.maxLines ?? 3)
}

/** Crop a box with padding (in units of the box height) and scale so the text
 *  is `targetH` px tall, which is what Tesseract reads best. If the line knows
 *  its glyph boxes, everything else (plaque edges, braille, shadows) is blanked
 *  to white so it can't be read as an extra "1". */
export function cropLine(g: Gray, b: Box & { parts?: Box[]; angle?: number }, targetH = 48, pad = 0.35): Gray {
  const ang = b.angle ?? 0, cos = Math.cos(ang), sin = Math.sin(ang)
  // Straighten: measure the line along its own baseline.
  const ccx = (b.x0 + b.x1) / 2, ccy = (b.y0 + b.y1) / 2
  const bw = (b.x1 - b.x0) * cos + (b.y1 - b.y0) * Math.abs(sin)
  const bh = Math.max(1, (b.y1 - b.y0) * cos - (b.x1 - b.x0) * Math.abs(sin))
  const p = bh * pad
  const s = targetH / bh
  const w = Math.max(1, Math.round((bw + 2 * p) * s)), h = Math.max(1, Math.round((bh + 2 * p) * s))
  const d = new Uint8Array(w * h)
  const keep = new Uint8Array(w * h).fill(1)
  const m = bh * 0.1
  // bilinear resample along the rotated line
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / s - (bh / 2 + p)
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / s - (bw / 2 + p)
      const fx = ccx + u * cos - v * sin, fy = ccy + u * sin + v * cos
      if (b.parts?.length && !b.parts.some((q) => fx >= q.x0 - m && fx <= q.x1 + m && fy >= q.y0 - m && fy <= q.y1 + m)) { keep[y * w + x] = 0; continue }
      const gx = Math.max(0, Math.min(g.w - 1.001, fx - 0.5)), gy = Math.max(0, Math.min(g.h - 1.001, fy - 0.5))
      const xA = Math.floor(gx), yA = Math.floor(gy), tx = gx - xA, ty = gy - yA
      const a = g.d[yA * g.w + xA], bb = g.d[yA * g.w + xA + 1], c = g.d[(yA + 1) * g.w + xA], e = g.d[(yA + 1) * g.w + xA + 1]
      d[y * w + x] = (a * (1 - tx) + bb * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty
    }
  }
  // stretch contrast to the full range
  // Stretch so ink goes black and the plaque goes white (the 2nd and 75th
  // percentiles of the kept pixels; the plaque is most of what's kept).
  const hist = new Uint32Array(256)
  let nk = 0
  for (let i = 0; i < d.length; i++) if (keep[i]) { hist[d[i]]++; nk++ }
  const pct = (q: number) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= q * nk) return v } return 255 }
  const lo = pct(0.02), hi = Math.max(lo + 1, pct(0.75))
  for (let i = 0; i < d.length; i++) d[i] = !keep[i] ? 255 : Math.max(0, Math.min(255, ((d[i] - lo) * 255) / (hi - lo)))
  return { w, h, d }
}

export function grayToRgba(g: Gray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.w * g.h * 4)
  for (let i = 0, j = 0; i < g.d.length; i++, j += 4) { out[j] = out[j + 1] = out[j + 2] = g.d[i]; out[j + 3] = 255 }
  return out
}

// ---------------------------------------------------------------- matching

/** Characters Tesseract mixes up on these plaques. Swapping within a group
 *  costs 0.35 instead of 1. */
const LOOKALIKE = ['0DOQ', '8B', '1IL', '5S', '6GC', '2Z', '4A', 'EF']
const groupOf = new Map<string, number>()
LOOKALIKE.forEach((s, i) => { for (const c of s) groupOf.set(c, i) })
const subCost = (a: string, b: string) => (a === b ? 0 : groupOf.has(a) && groupOf.get(a) === groupOf.get(b) ? 0.35 : 1)

export function ocrDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + subCost(a[i - 1], b[j - 1]))
  return d[a.length][b.length]
}

export const cleanReading = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, '')

export interface RoomMatch { room: string; cost: number; margin: number }

/** Best room for one OCR reading. Only confident matches come back: close to a
 *  known room, and clearly closer than the runner-up. */
export function matchRoom(raw: string, rooms: readonly string[], maxCost = 0.75, minMargin = 0.3): RoomMatch | null {
  const t = cleanReading(raw)
  if (t.length < 2 || t.length > 6) return null
  let best = { room: '', cost: Infinity }, second = Infinity
  for (const r of rooms) {
    const c = ocrDistance(t, r.toUpperCase())
    if (c < best.cost) { second = best.cost; best = { room: r, cost: c } }
    else if (c < second) second = c
  }
  if (best.cost > maxCost) return null
  const margin = second - best.cost
  if (margin < minMargin) return null
  return { ...best, margin }
}

/** Which characters Tesseract may output: digits plus the suffix letters that
 *  actually appear in room numbers. */
export function charWhitelist(rooms: readonly string[]): string {
  const s = new Set('0123456789')
  for (const r of rooms) for (const c of r.toUpperCase()) if (/[A-Z]/.test(c)) s.add(c)
  return [...s].join('')
}

// ---------------------------------------------------------------- voting

/** Agreement across camera frames: report a room once it has won `need` of the
 *  last `window` frames. One misread frame can't move you across the building. */
export class FrameVote {
  private hist: (string | null)[] = []
  private readonly need: number
  private readonly window: number
  constructor(need = 2, window = 3) { this.need = need; this.window = window }
  push(room: string | null): string | null {
    this.hist.push(room)
    if (this.hist.length > this.window) this.hist.shift()
    const counts = new Map<string, number>()
    for (const r of this.hist) if (r) counts.set(r, (counts.get(r) ?? 0) + 1)
    for (const [r, n] of counts) if (n >= this.need) return r
    return null
  }
  reset() { this.hist = [] }
}

// ---------------------------------------------------------------- one frame

/** Runs OCR on one line image and returns the raw text. The page passes a
 *  Tesseract.js worker; tools/ocr-eval.ts passes the Node version. */
export type LineReader = (line: Gray) => Promise<string>

export interface PlaqueRead {
  room: string | null          // agreed room, or null
  votes: Record<string, number>
  readings: string[]           // raw OCR text, for the debug panel
  line: Box | null             // where the number was found (frame pixels)
}

/** Crop sizes tried for each line. Tesseract's answer swings with scale, so
 *  several scales vote. */
export const READ_VARIANTS: { h: number; pad: number }[] = [
  { h: 40, pad: 0.5 }, { h: 48, pad: 0.5 }, { h: 56, pad: 0.5 }, { h: 48, pad: 0.7 },
]

/** Read the room number in one frame. Tries the most number-like lines first
 *  and stops at the first line that yields a room. */
export async function readPlaque(g: Gray, rooms: readonly string[], read: LineReader, opts: { maxLines?: number; variants?: { h: number; pad: number }[] } = {}): Promise<PlaqueRead> {
  const lines = findTextLines(g, { maxLines: opts.maxLines ?? 2 })
  const readings: string[] = []
  for (const L of lines) {
    const votes: Record<string, number> = {}
    for (const v of opts.variants ?? READ_VARIANTS) {
      const txt = cleanReading(await read(cropLine(g, L, v.h, v.pad)))
      readings.push(txt)
      // Tesseract often skips a thin "1" or "I". If the reading is one short and
      // one of the glyphs we found is a bar, try each bar letter in that spot.
      const tries = [txt]
      if (txt.length === L.glyphs - 1)
        L.parts.forEach((q, i) => { if (q.x1 - q.x0 < (q.y1 - q.y0) * 0.3) for (const ch of '1I') tries.push(txt.slice(0, i) + ch + txt.slice(i)) })
      // Prefer rooms with as many characters as glyphs we counted.
      const cands = rooms.filter((r) => Math.abs(r.length - L.glyphs) <= 1)
      const m = tries.map((t) => matchRoom(t, cands)).filter((x) => x).sort((a, b) => a!.cost - b!.cost)[0]
      // A reading with a different number of characters than glyphs found is
      // weak evidence ("370" when we saw four glyphs is probably 370C).
      if (m) votes[m.room] = (votes[m.room] ?? 0) + (m.room.length === L.glyphs ? 1 : 0.25) * (1 - m.cost)
      // Stop early once one room has a clear win and nothing else has a vote.
      const vs = Object.entries(votes)
      if (vs.length === 1 && vs[0][1] >= 1.5) break
    }
    const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1])
    if (ranked.length && ranked[0][1] >= 1.5 && ranked[0][1] > 1.8 * (ranked[1]?.[1] ?? 0))
      return { room: ranked[0][0], votes, readings, line: L }
    if (ranked.length) return { room: null, votes, readings, line: L }
  }
  return { room: null, votes: {}, readings, line: lines[0] ?? null }
}
