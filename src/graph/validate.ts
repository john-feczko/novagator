import type { GraphNode, NavGraph } from './types.ts'

export const dist = (a: GraphNode, b: GraphNode) => Math.hypot(a.x - b.x, a.y - b.y)

export function indexNodes(g: NavGraph): Map<string, GraphNode> {
  return new Map(g.nodes.map((n) => [n.id, n]))
}

export function adjacency(g: NavGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const n of g.nodes) adj.set(n.id, [])
  for (const e of g.edges) {
    adj.get(e.a)?.push(e.b)
    adj.get(e.b)?.push(e.a)
  }
  return adj
}

/** Connected components, largest first. */
export function components(g: NavGraph): string[][] {
  const adj = adjacency(g)
  const seen = new Set<string>()
  const out: string[][] = []
  for (const n of g.nodes) {
    if (seen.has(n.id)) continue
    const comp: string[] = []
    const stack = [n.id]
    seen.add(n.id)
    while (stack.length) {
      const u = stack.pop()!
      comp.push(u)
      for (const v of adj.get(u) ?? []) if (!seen.has(v)) { seen.add(v); stack.push(v) }
    }
    out.push(comp)
  }
  return out.sort((a, b) => b.length - a.length)
}

export interface Problem { level: 'error' | 'warning'; message: string; nodes: string[] }

/** Checks the editor and the tests both run. Errors mean routing will break. */
export function validate(g: NavGraph): Problem[] {
  const P: Problem[] = []
  const N = indexNodes(g)
  const ids = new Set<string>()
  for (const n of g.nodes) {
    if (ids.has(n.id)) P.push({ level: 'error', message: `duplicate node id ${n.id}`, nodes: [n.id] })
    ids.add(n.id)
  }
  const pairs = new Set<string>()
  for (const e of g.edges) {
    const a = N.get(e.a), b = N.get(e.b)
    if (!a || !b) { P.push({ level: 'error', message: `edge ${e.a}–${e.b} points to a missing node`, nodes: [e.a, e.b].filter((x) => N.has(x)) }); continue }
    if (e.a === e.b) P.push({ level: 'error', message: `edge from ${e.a} to itself`, nodes: [e.a] })
    const key = [e.a, e.b].sort().join('|')
    if (pairs.has(key)) P.push({ level: 'warning', message: `duplicate edge ${e.a}–${e.b}`, nodes: [e.a, e.b] })
    pairs.add(key)
    if (Math.abs(e.length - dist(a, b)) > 0.05) P.push({ level: 'error', message: `edge ${e.a}–${e.b} length ${e.length} m doesn't match its endpoints (${dist(a, b).toFixed(2)} m)`, nodes: [e.a, e.b] })
  }
  const comps = components(g)
  const main = new Set(comps[0] ?? [])
  for (const c of comps.slice(1)) {
    const named = c.map((id) => N.get(id)!).filter((n) => n.room || n.type === 'elevator' || n.type === 'stairs')
    if (named.length) P.push({ level: 'error', message: `cut off from the rest of the floor: ${named.map((n) => n.room ?? n.id).join(', ')}`, nodes: c })
    else P.push({ level: 'warning', message: `${c.length} stray node(s) not connected to anything useful`, nodes: c })
  }
  for (const [num, r] of Object.entries(g.rooms)) {
    if (!N.has(r.node)) P.push({ level: 'error', message: `room ${num} points to missing node ${r.node}`, nodes: [] })
    else if (!main.has(r.node)) { /* already reported via components */ }
  }
  const adj = adjacency(g)
  for (const n of g.nodes) {
    if (n.type === 'door' && (adj.get(n.id)?.length ?? 0) < 2)
      P.push({ level: 'warning', message: `door ${n.id} only connects on one side`, nodes: [n.id] })
  }
  return P
}

/** Recompute every edge length from node coordinates (after moving nodes). */
export function refreshLengths(g: NavGraph): void {
  const N = indexNodes(g)
  for (const e of g.edges) {
    const a = N.get(e.a), b = N.get(e.b)
    if (a && b) e.length = Math.round(dist(a, b) * 100) / 100
  }
}
