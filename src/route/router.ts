// Phase 3: routing over the navigation graph.
//
// A* search over *directed edges* (state = "arrived at node B from node A") rather
// than plain nodes, so turn costs can be charged for the "fewest turns" option.
// Works on any graph, including several floors merged together later, as long as
// floor changes are edges between stair/elevator nodes (stairs edges carry
// `stairs: true`).
import type { GraphEdge, GraphNode, NavGraph } from '../graph/types.ts'

export type RouteMode = 'shortest' | 'accessible' | 'fewest-turns'

export interface RouteOptions {
  mode?: RouteMode
  /** Extra cost (m) for walking *through* a room to reach somewhere else. Keeps
   *  routes in the hallways unless the destination is an inner office. */
  roomTransitPenalty?: number
  /** Extra cost (m) per turn in "fewest-turns" mode. */
  turnPenalty?: number
}

export interface Route {
  nodes: string[]       // node ids, start to end
  edges: GraphEdge[]    // edges between consecutive nodes
  length: number        // walking distance, meters
  turns: number         // turns sharper than TURN_DEG at hallway nodes
  mode: RouteMode
}

/** A heading change sharper than this (degrees) counts as a turn. */
export const TURN_DEG = 35

const ROOMLIKE = new Set(['room', 'restroom', 'stairs', 'elevator'])

interface Arc { to: string; edge: GraphEdge }

export class Router {
  readonly graph: NavGraph
  readonly nodes: Map<string, GraphNode>
  private adj = new Map<string, Arc[]>()

  constructor(graph: NavGraph) {
    this.graph = graph
    this.nodes = new Map(graph.nodes.map((n) => [n.id, n]))
    for (const n of graph.nodes) this.adj.set(n.id, [])
    for (const e of graph.edges) {
      this.adj.get(e.a)?.push({ to: e.b, edge: e })
      this.adj.get(e.b)?.push({ to: e.a, edge: e })
    }
  }

  neighbors(id: string): Arc[] { return this.adj.get(id) ?? [] }

  /** Signed heading change at `b` going a→b→c, in degrees. Positive = left
   *  (the frame is x right, y up). */
  turnAngle(a: string, b: string, c: string): number {
    const A = this.nodes.get(a)!, B = this.nodes.get(b)!, C = this.nodes.get(c)!
    const h1 = Math.atan2(B.y - A.y, B.x - A.x), h2 = Math.atan2(C.y - B.y, C.x - B.x)
    let d = ((h2 - h1) * 180) / Math.PI
    while (d > 180) d -= 360
    while (d < -180) d += 360
    return d
  }

  /** Route from one node to the nearest of one or more target nodes. */
  route(from: string, to: string | string[], opts: RouteOptions = {}): Route | null {
    const mode = opts.mode ?? 'shortest'
    const roomPenalty = opts.roomTransitPenalty ?? 150
    const turnPenalty = mode === 'fewest-turns' ? (opts.turnPenalty ?? 20) : 0
    const targets = new Set(Array.isArray(to) ? to : [to])
    const start = this.nodes.get(from)
    if (!start) throw new Error(`unknown start node ${from}`)
    for (const t of targets) if (!this.nodes.has(t)) throw new Error(`unknown target node ${t}`)
    if (targets.has(from)) return { nodes: [from], edges: [], length: 0, turns: 0, mode }

    const tgt = [...targets].map((t) => this.nodes.get(t)!)
    const h = (n: GraphNode) => {
      let best = Infinity
      for (const t of tgt) best = Math.min(best, Math.hypot(n.x - t.x, n.y - t.y))
      return best
    }

    // state key: "prev>node"; the start state has prev = ''
    const g = new Map<string, number>()
    const parent = new Map<string, string>()
    const heap = new MinHeap<{ key: string; prev: string; node: string }>()
    const k0 = `>${from}`
    g.set(k0, 0)
    heap.push(h(start), { key: k0, prev: '', node: from })
    const closed = new Set<string>()

    while (heap.size) {
      const { key, prev, node } = heap.pop()!
      if (closed.has(key)) continue
      closed.add(key)
      if (targets.has(node)) return this.build(key, parent, mode)
      const here = this.nodes.get(node)!
      // Don't walk through a room/stair/elevator unless it's where we started.
      const transitCost = node !== from && ROOMLIKE.has(here.type) ? roomPenalty : 0
      for (const { to: nxt, edge } of this.neighbors(node)) {
        if (nxt === prev) continue
        if (mode === 'accessible' && edge.stairs) continue
        let cost = edge.length + transitCost
        if (turnPenalty && prev && here.type === 'corridor' && this.nodes.get(prev)!.type === 'corridor' && this.nodes.get(nxt)!.type === 'corridor' &&
            Math.abs(this.turnAngle(prev, node, nxt)) > TURN_DEG) cost += turnPenalty
        const nk = `${node}>${nxt}`
        const ng = g.get(key)! + cost
        if (ng < (g.get(nk) ?? Infinity)) {
          g.set(nk, ng)
          parent.set(nk, key)
          heap.push(ng + h(this.nodes.get(nxt)!), { key: nk, prev: node, node: nxt })
        }
      }
    }
    return null
  }

  private build(key: string, parent: Map<string, string>, mode: RouteMode): Route {
    const nodes: string[] = []
    let k: string | undefined = key
    while (k !== undefined) { nodes.push(k.split('>')[1]); k = parent.get(k) }
    nodes.reverse()
    const edges: GraphEdge[] = []
    for (let i = 1; i < nodes.length; i++)
      edges.push(this.neighbors(nodes[i - 1]).find((a) => a.to === nodes[i])!.edge)
    return { nodes, edges, length: round2(edges.reduce((s, e) => s + e.length, 0)), turns: this.countTurns(nodes), mode }
  }

  /** Turns sharper than TURN_DEG made at hallway nodes along a path. */
  countTurns(path: string[]): number {
    let t = 0
    for (let i = 1; i < path.length - 1; i++) {
      const [a, b, c] = [path[i - 1], path[i], path[i + 1]].map((id) => this.nodes.get(id)!)
      if (a.type === 'corridor' && b.type === 'corridor' && c.type === 'corridor' &&
          Math.abs(this.turnAngle(a.id, b.id, c.id)) > TURN_DEG) t++
    }
    return t
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100

class MinHeap<T> {
  private a: { k: number; v: T }[] = []
  get size() { return this.a.length }
  push(k: number, v: T) {
    const a = this.a
    a.push({ k, v })
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].k <= a[i].k) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): T | undefined {
    const a = this.a
    if (!a.length) return undefined
    const top = a[0].v
    const last = a.pop()!
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < a.length && a[l].k < a[m].k) m = l
        if (r < a.length && a[r].k < a[m].k) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}
