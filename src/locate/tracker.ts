// Phase 4, tier 3: dead reckoning between plaque scans, kept on the graph.
//
// Pure logic (no browser APIs), so it is unit-tested with simulated walks:
//   StepDetector  accelerometer samples → steps
//   Compass       raw compass readings → smoothed plan bearing, with the
//                 compass-to-plan offset learned at each plaque scan
//   Tracker       position on the graph's edges; each step moves along the
//                 edge most in line with the heading (map matching)
//
// Bearings are degrees clockwise from plan north (up the floor-plan sheet),
// so 0 = +y, 90 = +x.
import type { GraphEdge, GraphNode, NavGraph } from '../graph/types.ts'

const D2R = Math.PI / 180
export const wrap360 = (a: number) => ((a % 360) + 360) % 360
export const angDiff = (a: number, b: number) => { const d = wrap360(a - b); return d > 180 ? d - 360 : d } // a - b in (-180, 180]
const bearingOf = (dx: number, dy: number) => wrap360(Math.atan2(dx, dy) / D2R)

// ---------------------------------------------------------------- steps

/** Counts steps from acceleration magnitude (gravity included). A step is a
 *  peak that rises `threshold` above the running mean, at least `minGapMs`
 *  after the last one. Works with the phone held in front of you. */
export class StepDetector {
  steps = 0
  private mean = 9.81
  private fast = 9.81
  private armed = true
  private lastStep = -Infinity
  private readonly threshold: number
  private readonly minGapMs: number
  constructor(threshold = 1.1, minGapMs = 300) { this.threshold = threshold; this.minGapMs = minGapMs }
  /** Feed one sample; returns true when it completes a step. */
  push(tMs: number, ax: number, ay: number, az: number): boolean {
    const m = Math.hypot(ax, ay, az)
    this.fast += 0.35 * (m - this.fast)      // light smoothing (~ 10 Hz)
    this.mean += 0.02 * (m - this.mean)      // slow baseline (~ 1 s)
    const lift = this.fast - this.mean
    if (this.armed && lift > this.threshold && tMs - this.lastStep > this.minGapMs) {
      this.armed = false
      this.lastStep = tMs
      this.steps++
      return true
    }
    if (!this.armed && lift < this.threshold * 0.3) this.armed = true
    return false
  }
}

// ---------------------------------------------------------------- heading

/** Smooths compass readings and turns them into plan bearings. `offset` is
 *  compass − plan; it's learned every time you scan a plaque (you're facing
 *  the wall, and we know which way that wall faces), which also soaks up the
 *  local magnetic error from the building's steel near that spot. */
export class Compass {
  offset: number | null
  private sx = 0
  private sy = 0
  private has = false
  constructor(offset: number | null = null) { this.offset = offset }
  push(compassDeg: number, alpha = 0.25) {
    const x = Math.sin(compassDeg * D2R), y = Math.cos(compassDeg * D2R)
    if (!this.has) { this.sx = x; this.sy = y; this.has = true }
    else { this.sx += alpha * (x - this.sx); this.sy += alpha * (y - this.sy) }
  }
  get raw(): number | null { return this.has ? bearingOf(this.sx, this.sy) : null }
  /** Current bearing in the plan frame, or null until calibrated. */
  get bearing(): number | null { const r = this.raw; return r === null || this.offset === null ? null : wrap360(r - this.offset) }
  /** You're looking along plan bearing `planBearing` right now. */
  calibrate(planBearing: number): number | null {
    const r = this.raw
    if (r === null) return null
    this.offset = wrap360(r - planBearing)
    return this.offset
  }
}

// ---------------------------------------------------------------- graph walking

export interface Pose {
  a: string; b: string          // on edge a→b (a is behind you if you walk toward b)
  t: number                     // meters from a
  x: number; y: number
  bearing: number | null
}

export interface TrackerOptions {
  /** Which edges you can walk along. Default: everything except the last hop
   *  into a dead-end room (you'd stop there, not walk through it). */
  walkable?: (e: GraphEdge, nodes: Map<string, GraphNode>, degree: Map<string, number>) => boolean
  /** Edges on the current route get a bonus at junctions. */
  routeEdges?: Set<string>
}

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

export class Tracker {
  readonly nodes: Map<string, GraphNode>
  private adj = new Map<string, { to: string; e: GraphEdge }[]>()
  pose: Pose | null = null
  /** Meters walked since the last fix. */
  sinceFix = 0
  stepsSinceFix = 0
  routeEdges: Set<string> = new Set()

  constructor(g: NavGraph, opts: TrackerOptions = {}) {
    this.nodes = new Map(g.nodes.map((n) => [n.id, n]))
    const degree = new Map<string, number>()
    for (const e of g.edges) { degree.set(e.a, (degree.get(e.a) ?? 0) + 1); degree.set(e.b, (degree.get(e.b) ?? 0) + 1) }
    const DEST = new Set(['room', 'restroom', 'stairs', 'elevator'])
    const walkable = opts.walkable ?? ((e: GraphEdge) => !(DEST.has(this.nodes.get(e.a)!.type) && degree.get(e.a)! <= 1) && !(DEST.has(this.nodes.get(e.b)!.type) && degree.get(e.b)! <= 1))
    for (const e of g.edges) {
      if (!walkable(e, this.nodes, degree)) continue
      if (!this.adj.has(e.a)) this.adj.set(e.a, [])
      if (!this.adj.has(e.b)) this.adj.set(e.b, [])
      this.adj.get(e.a)!.push({ to: e.b, e })
      this.adj.get(e.b)!.push({ to: e.a, e })
    }
    if (opts.routeEdges) this.routeEdges = opts.routeEdges
  }

  setRoute(nodeIds: string[] | null) {
    this.routeEdges = new Set()
    if (nodeIds) for (let i = 1; i < nodeIds.length; i++) this.routeEdges.add(key(nodeIds[i - 1], nodeIds[i]))
  }

  private len(a: string, b: string) { const A = this.nodes.get(a)!, B = this.nodes.get(b)!; return Math.hypot(B.x - A.x, B.y - A.y) }
  private edgeBearing(a: string, b: string) { const A = this.nodes.get(a)!, B = this.nodes.get(b)!; return bearingOf(B.x - A.x, B.y - A.y) }
  private place(a: string, b: string, t: number, bearing: number | null): Pose {
    const A = this.nodes.get(a)!, B = this.nodes.get(b)!, L = this.len(a, b) || 1
    const f = Math.max(0, Math.min(1, t / L))
    return { a, b, t: f * L, x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f, bearing }
  }

  /** Snap a point to the nearest walkable edge and start there. Hallways win
   *  over door stubs and room interiors unless those are much closer. */
  fix(x: number, y: number, bearing: number | null = null): Pose {
    let best: { a: string; b: string; t: number; d: number } | null = null
    for (const [a, list] of this.adj) for (const { to: b, e } of list) {
      if (a > b) continue
      const A = this.nodes.get(a)!, B = this.nodes.get(b)!
      const vx = B.x - A.x, vy = B.y - A.y, L2 = vx * vx + vy * vy || 1
      const f = Math.max(0, Math.min(1, ((x - A.x) * vx + (y - A.y) * vy) / L2))
      const d = Math.hypot(A.x + vx * f - x, A.y + vy * f - y) + (e.kind === 'corridor' ? 0 : 1.5)
      if (!best || d < best.d - 1e-9) best = { a, b, t: f * Math.sqrt(L2), d }
    }
    if (!best) throw new Error('graph has no walkable edges')
    this.pose = this.place(best.a, best.b, best.t, bearing)
    this.sinceFix = 0
    this.stepsSinceFix = 0
    return this.pose
  }

  /** Best edge to continue on from `node`, walking on `bearing`, not counting
   *  the edge back to `from`. Returns null if nothing is within ~60°. */
  private choose(node: string, from: string | null, bearing: number): string | null {
    let best: string | null = null, bestScore = -Infinity
    for (const { to, e } of this.adj.get(node) ?? []) {
      if (to === from) continue
      const c = Math.cos(angDiff(this.edgeBearing(node, to), bearing) * D2R)
      const onRoute = this.routeEdges.has(key(node, to))
      // Into a doorway only if you're clearly facing it (or it's your route):
      // walking past a door shouldn't put you inside the room.
      if (c < (e.kind === 'corridor' || onRoute ? 0.5 : 0.9)) continue
      let score = c
      if (e.kind === 'corridor') score += 0.3
      if (onRoute) score += 0.4                            // on-route branches win close calls
      if (score > bestScore) { bestScore = score; best = to }
    }
    return best
  }

  /** One step of `stride` meters on plan bearing `bearing`. */
  step(bearing: number, stride: number): Pose | null {
    if (!this.pose) return null
    let { a, b, t } = this.pose
    let left = stride
    this.stepsSinceFix++
    for (let hop = 0; hop < 6 && left > 1e-6; hop++) {
      const L = this.len(a, b)
      const c = Math.cos(angDiff(this.edgeBearing(a, b), bearing) * D2R)
      if (Math.abs(c) < 0.5) {
        // Walking across this edge: you've turned. Find the nearest junction
        // (behind or ahead, up to TURN_SEARCH m along the hallways) with a
        // branch in your new direction, and continue from there. This also
        // corrects distance drift: your position resets at every turn.
        const turn = this.findTurn(a, b, t, bearing)
        if (!turn) break                                  // nowhere to turn: hold still
        a = turn.node; b = turn.next; t = 0
        left = Math.max(0, left - 0.3)
        continue
      }
      if (c < 0) { [a, b] = [b, a]; t = L - t }           // you're walking toward a
      const k = Math.abs(c) + (1 - Math.abs(c)) * 0.5        // most of a slightly-off step still counts
      if (t + left * k <= L) { t += left * k; left = 0; break }
      // Reached node b: carry on along the branch most in line with the heading.
      left -= (L - t) / k
      const next = this.choose(b, a, bearing)
      if (!next) { t = L; break }                       // dead end or a turn not yet made
      a = b; b = next; t = 0
    }
    this.sinceFix += stride
    this.pose = this.place(a, b, t, bearing)
    return this.pose
  }

  /** Nearest node (by walking distance from the point `t` along a→b) that has
   *  a branch on `bearing`. On-route branches count as closer. */
  private findTurn(a: string, b: string, t: number, bearing: number): { node: string; next: string } | null {
    const TURN_SEARCH = 6
    const dist = new Map<string, number>([[a, t], [b, this.len(a, b) - t]])
    const queue = [a, b]
    let best: { node: string; next: string; cost: number } | null = null
    while (queue.length) {
      queue.sort((x, y) => dist.get(x)! - dist.get(y)!)
      const n = queue.shift()!
      const dn = dist.get(n)!
      if (best && dn >= best.cost) break
      const next = this.choose(n, null, bearing)
      if (next && !((n === a && next === b) || (n === b && next === a))) {
        const c = Math.cos(angDiff(this.edgeBearing(n, next), bearing) * D2R)
        if (c >= 0.7) {
          const cost = dn - (this.routeEdges.has(key(n, next)) ? 3 : 0)
          if (!best || cost < best.cost) best = { node: n, next, cost }
        }
      }
      for (const { to, e } of this.adj.get(n) ?? []) {
        if (e.kind !== 'corridor' && !this.routeEdges.has(key(n, to))) continue // search along hallways
        const d = dn + this.len(n, to)
        if (d <= TURN_SEARCH && d < (dist.get(to) ?? Infinity)) { dist.set(to, d); queue.push(to) }
      }
    }
    return best
  }

  /** The graph node you're closest to (for routing from here). */
  nearestNode(): string | null {
    if (!this.pose) return null
    const { a, b, t } = this.pose
    return t <= this.len(a, b) / 2 ? a : b
  }
}
