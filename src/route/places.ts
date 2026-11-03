// Turn what someone types ("318", "room 309a", "men's room", "elevator",
// "staff lounge") into graph nodes. Generic words like "restroom" return every
// match, and the router then picks the nearest one.
import type { NavGraph } from '../graph/types.ts'

export interface Place {
  nodes: string[]   // candidate nodes (nearest one wins when routing)
  label: string     // how to say it in directions, e.g. "Room 318"
  short: string     // e.g. "318"
}

export type Lookup = { ok: true; place: Place } | { ok: false; error: string; suggestions: string[] }

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim()

export function roomLabel(num: string, name?: string): string {
  return /^\d/.test(num) ? `Room ${num}${name ? ` (${name})` : ''}` : name ? `${name} (${num})` : num
}

export function findPlace(g: NavGraph, text: string): Lookup {
  const q = norm(text).replace(/^(the|a|an)\s+/, '').replace(/^(nearest|closest)\s+/, '')
  if (!q) return { ok: false, error: 'Enter a room number or place.', suggestions: [] }
  const byNode = new Map(g.nodes.map((n) => [n.id, n]))
  const rooms = Object.entries(g.rooms)

  // 1. Room number, with optional "room"/"rm" and floor-style dashes: "318", "rm 3-18", "309A"
  const num = q.replace(/^(room|rm\.?|#)\s*/, '').replace(/[-\s]/g, '').toUpperCase()
  const exact = rooms.find(([k]) => k.toUpperCase() === num)
  if (exact) {
    const [k, r] = exact
    return { ok: true, place: { nodes: [r.node], label: /^\d/.test(k) ? roomLabel(k) : roomLabel(k, r.name), short: k } }
  }

  // 2. Points of interest: stairs, elevators, restrooms
  const pois = g.pois.map((p) => ({ ...p, n: byNode.get(p.node)! }))
  const stairNum = q.match(/^(?:stair|stairs|stairwell|staircase)\s*#?\s*(\d+)$/)
  if (stairNum) {
    const hit = pois.find((p) => p.type === 'stairs' && norm(p.name) === `stair ${stairNum[1]}`)
    if (hit) return { ok: true, place: { nodes: [hit.node], label: hit.name, short: hit.name } }
    const have = pois.filter((p) => p.type === 'stairs').map((p) => p.name)
    return { ok: false, error: `There's no Stair ${stairNum[1]} on this floor.`, suggestions: have }
  }
  if (/^(stair|stairs|stairwell|staircase)$/.test(q)) return many(pois.filter((p) => p.type === 'stairs').map((p) => p.node), 'the nearest stairs', 'stairs')
  if (/^(elevator|elevators|lift)$/.test(q)) return many(pois.filter((p) => p.type === 'elevator').map((p) => p.node), 'the nearest elevator', 'elevator')
  const elevNamed = pois.find((p) => p.type === 'elevator' && (norm(p.name) === q || norm(p.n.room ?? '') === q))
  if (elevNamed) return { ok: true, place: { nodes: [elevNamed.node], label: elevNamed.name, short: elevNamed.name } }
  const restrooms = pois.filter((p) => p.type === 'restroom')
  if (/^(mens|men|male)( room| restroom| bathroom| toilet)?$/.test(q))
    return many(restrooms.filter((p) => /^men/i.test(p.name)).map((p) => p.node), "the nearest men's restroom", "men's restroom")
  if (/^(womens|women|ladies|female)( room| restroom| bathroom| toilet)?$/.test(q))
    return many(restrooms.filter((p) => /^women/i.test(p.name)).map((p) => p.node), "the nearest women's restroom", "women's restroom")
  if (/^(rest ?room|restrooms|bathroom|bathrooms|toilet|toilets|wc|washroom)$/.test(q))
    return many(restrooms.map((p) => p.node), 'the nearest restroom', 'restroom')

  // 3. Room names: "staff lounge", "rfid lab"
  const named = rooms.filter(([, r]) => norm(r.name).includes(q))
  if (named.length === 1) {
    const [k, r] = named[0]
    return { ok: true, place: { nodes: [r.node], label: roomLabel(k, r.name), short: k } }
  }
  if (named.length > 1) {
    const sameName = named.every(([, r]) => norm(r.name) === norm(named[0][1].name))
    if (sameName && named.length <= 6)
      return many(named.map(([, r]) => r.node), `the nearest ${named[0][1].name}`, named[0][1].name)
    return { ok: false, error: `"${text.trim()}" matches ${named.length} rooms.`, suggestions: named.slice(0, 8).map(([k, r]) => `${k} ${r.name}`) }
  }

  // 4. Close misses on room numbers: "3018" → 318, "319" → nearby numbers
  const near = /\d/.test(num)
    ? rooms.map(([k]) => ({ k, e: editDistance(k.toUpperCase(), num) })).filter((x) => x.e <= 2).sort((a, b) => a.e - b.e).slice(0, 6).map((x) => x.k)
    : []
  return { ok: false, error: `No room "${text.trim()}" on floor ${g.floors.join(', ')}.`, suggestions: near }
}

function many(nodes: string[], label: string, short: string): Lookup {
  if (!nodes.length) return { ok: false, error: `No ${short} on this floor.`, suggestions: [] }
  return { ok: true, place: { nodes, label, short } }
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

/** "from 301 to 318", "301 to 318", "301 -> 318", "301 > restroom". */
export function parseQuery(text: string): { from: string; to: string } | null {
  const t = text.trim().replace(/^(directions|route|take me|go|get me)\s+/i, '')
  const m = t.match(/^(?:from\s+)?(.+?)\s*(?:\s+to\s+|->|→|>)\s*(.+)$/i)
  return m ? { from: m[1].trim(), to: m[2].trim() } : null
}
