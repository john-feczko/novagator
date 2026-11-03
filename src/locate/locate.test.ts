// Run with: npm test   (photo-based OCR accuracy: npm run ocr-eval)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { NavGraph } from '../graph/types.ts'
import { Router } from '../route/router.ts'
import { matchRoom, FrameVote, charWhitelist, ocrDistance } from './plaque.ts'
import { StepDetector, Compass, Tracker, angDiff, wrap360 } from './tracker.ts'
import { placeForRoom, readingBearing, type PlaqueFile } from './plaques.ts'

const g: NavGraph = JSON.parse(readFileSync(new URL('../data/floor3.graph.json', import.meta.url), 'utf8'))
const P: PlaqueFile = JSON.parse(readFileSync(new URL('../data/floor3.plaques.json', import.meta.url), 'utf8'))
const rooms = Object.keys(g.rooms)

// Small seeded RNG so the simulated walks are the same every run.
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())

// ---------------------------------------------------------------- OCR matching

test('room matching: exact, lookalikes, and refusing to guess', () => {
  assert.equal(matchRoom('318', rooms)?.room, '318')
  assert.equal(matchRoom('3I8', rooms)?.room, '318')       // I for 1
  assert.equal(matchRoom('358 C', rooms)?.room, '358C')
  assert.equal(matchRoom('3S8C', rooms)?.room, '358C')     // S for 5
  assert.equal(matchRoom('364O', rooms)?.room, '364D')     // O for D
  assert.equal(matchRoom('31', rooms), null)               // too short to tell
  assert.equal(matchRoom('HELEN', rooms), null)
  assert.equal(matchRoom('999', rooms), null)
  // Equally close to two rooms → no answer rather than a coin flip.
  assert.equal(matchRoom('35', ['351', '352']), null)
  assert.ok(ocrDistance('8', 'B') < ocrDistance('8', 'X'))
  assert.match(charWhitelist(rooms), /^[0-9A-Z]+$/)
})

test('frame voting needs 2 of the last 3 frames to agree', () => {
  const v = new FrameVote()
  assert.equal(v.push('318'), null)
  assert.equal(v.push('319'), null)
  assert.equal(v.push(null), null)
  assert.equal(v.push('318'), null)   // 319, null, 318
  assert.equal(v.push('318'), '318')
})

// ---------------------------------------------------------------- plaques

test('every plaque is at a door of its room (or its suite) on this floor', () => {
  const nodes = new Map(g.nodes.map((n) => [n.id, n]))
  assert.ok(P.plaques.length >= 80)
  for (const p of P.plaques) {
    assert.ok(g.rooms[p.room], `${p.room} not in graph`)
    assert.equal(nodes.get(p.door)?.type, 'door', p.room)
    assert.ok(Math.hypot(p.stand.x - p.x, p.stand.y - p.y) > 0.9, p.room)
  }
  assert.equal(readingBearing('S'), 0)
  assert.equal(readingBearing('W'), 90)
  assert.ok(placeForRoom(g, P.plaques, '318')?.plaque)
  assert.ok(placeForRoom(g, P.plaques, '301'))          // no plaque: falls back to its door
  assert.equal(placeForRoom(g, P.plaques, '999'), null)
})

// ---------------------------------------------------------------- steps + compass

test('step detector counts a simulated walk and ignores standing still', () => {
  const r = rng(7)
  const walk = new StepDetector()
  for (let t = 0; t < 20000; t += 1000 / 60) {
    const s = 2.6 * Math.sin(2 * Math.PI * 1.8 * (t / 1000)) // 1.8 steps/s
    walk.push(t, 0.3 * gauss(r), 9.81 + s + 0.4 * gauss(r), 0.3 * gauss(r))
  }
  assert.ok(Math.abs(walk.steps - 36) <= 2, `counted ${walk.steps}, expected ~36`)
  const still = new StepDetector()
  for (let t = 0; t < 20000; t += 1000 / 60) still.push(t, 0.15 * gauss(r), 9.81 + 0.25 * gauss(r), 0.15 * gauss(r))
  assert.equal(still.steps, 0)
})

test('compass learns its offset from a plaque scan', () => {
  const c = new Compass()
  for (let i = 0; i < 20; i++) c.push(37)
  assert.equal(c.bearing, null)              // not calibrated yet
  c.calibrate(0)                             // facing plan north while reading a plaque
  assert.ok(Math.abs(c.bearing!) < 0.5 || Math.abs(c.bearing! - 360) < 0.5)
  for (let i = 0; i < 40; i++) c.push(127)   // turn right 90°
  assert.ok(Math.abs(angDiff(c.bearing!, 90)) < 1)
  for (let i = 0; i < 40; i++) c.push(wrap360(37 - 90 + 360)) // wraps through 0 cleanly
  assert.ok(Math.abs(angDiff(c.bearing!, 270)) < 1)
})

// ---------------------------------------------------------------- simulated walks

const R = new Router(g)
function simulateWalk(fromRoom: string, toRoom: string, r: () => number, withRoute: boolean, strideErr: number, headingNoise = 12) {
  const A = P.plaques.find((p) => p.room === fromRoom)!, B = P.plaques.find((p) => p.room === toRoom)!
  const route = R.route(A.door, B.door)
  if (!route) return null
  const tr = new Tracker(g)
  if (withRoute) tr.setRoute(route.nodes)
  const start = tr.fix(A.stand.x, A.stand.y, readingBearing(A.faces))
  // True path: from where you stand, along the route, to the door you're heading for.
  const pts = [{ x: start.x, y: start.y }, ...route.nodes.slice(1, -1).map((id) => R.nodes.get(id)!), { x: B.x, y: B.y }]
  const stride = 0.72, guessStride = stride * (1 + strideErr * gauss(r))
  let walked = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const L = Math.hypot(b.x - a.x, b.y - a.y)
    if (L < 1e-6) continue
    const brg = wrap360(Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI)
    for (let d = 0; d < L; d += stride) { tr.step(wrap360(brg + headingNoise * gauss(r)), guessStride); walked += stride }
  }
  const end = tr.pose!
  return { err: Math.hypot(end.x - B.x, end.y - B.y), walked, route }
}

// Heading noise ±12° (1σ) on every step. Stride error is how far off the
// step length is: ~10% before calibration, ~3% after a couple of plaque-to-
// plaque walks have tuned it.
const CASES = [
  { withRoute: true, strideErr: 0.03, need: 0.93, label: 'navigating, stride calibrated' },
  { withRoute: true, strideErr: 0.1, need: 0.85, label: 'navigating, stride ±10%' },
  { withRoute: false, strideErr: 0.1, need: 0.83, label: 'no route, stride ±10%' },
]
for (const { withRoute, strideErr, need, label } of CASES)
test(`tracking ends within 3 m on simulated 5–40 m walks (${label})`, () => {
  const r = rng(42)
  const ps = P.plaques.filter((p) => !p.check)
  const errs: number[] = []
  let tries = 0
  while (errs.length < 300 && tries++ < 5000) {
    const a = ps[Math.floor(r() * ps.length)], b = ps[Math.floor(r() * ps.length)]
    if (a === b) continue
    const res = simulateWalk(a.room, b.room, r, withRoute, strideErr)
    // Re-scan prompts come every ~30 m, so judge walks up to 40 m.
    if (!res || res.route.length > 40 || res.route.length < 5) continue
    errs.push(res.err)
  }
  errs.sort((x, y) => x - y)
  const p50 = errs[Math.floor(errs.length * 0.5)], p90 = errs[Math.floor(errs.length * 0.9)]
  const within3 = errs.filter((e) => e <= 3).length / errs.length
  console.log(`# ${label.padEnd(30)}: median error ${p50.toFixed(1)} m, 90th percentile ${p90.toFixed(1)} m, ${(within3 * 100).toFixed(0)}% within 3 m`)
  assert.ok(within3 >= need, `${(within3 * 100).toFixed(0)}% of walks ended within 3 m`)
})
