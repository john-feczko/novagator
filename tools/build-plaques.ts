// Build src/data/floor<N>.plaques.json from the Phase 1 plaque manifest.
//   npm run build-plaques            (floor 3)
//
// For each plaque logged with a facing direction (N/E/S/W, plan frame), find
// the door it hangs beside: the door of that room (or of the suite it opens
// off) that lies most in the facing direction from the room's center. The
// plaque's position is that door; where you stand to read it is 1 m out from
// the wall.
//
// Only room numbers, doors and directions go in the output, no names, so it is
// safe to commit. Plaques the script isn't sure about are marked "check".
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { NavGraph } from '../src/graph/types.ts'
import type { PlaqueInfo, PlaqueFile } from '../src/locate/plaques.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const floor = process.argv.find((a) => /^\d$|^[BG]$/.test(a)) ?? '3'
const g: NavGraph = JSON.parse(readFileSync(`${ROOT}src/data/floor${floor}.graph.json`, 'utf8'))
const csv = readFileSync(`${ROOT}private/plaques/floor${floor}/manifest.csv`, 'utf8')

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') q = false; else cell += c; continue }
    if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((x) => x.trim()))
}

const [head, ...rows] = parseCsv(csv)
const col = (name: RegExp) => head.findIndex((h) => name.test(h))
const cRoom = col(/^room$/i), cFace = col(/^faces/i), cPhoto = col(/^photo$/i)

const N = new Map(g.nodes.map((n) => [n.id, n]))
const adj = new Map<string, string[]>()
for (const e of g.edges) {
  adj.set(e.a, [...(adj.get(e.a) ?? []), e.b])
  adj.set(e.b, [...(adj.get(e.b) ?? []), e.a])
}
const DIR: Record<string, [number, number]> = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] }

const plaques: PlaqueInfo[] = []
const skipped: Record<string, string[]> = {}
for (const r of rows) {
  const room = r[cRoom]?.trim().toUpperCase(), face = r[cFace]?.trim().toUpperCase()
  if (!room) continue
  if (!DIR[face]) { (skipped[face || 'blank'] ??= []).push(room); continue }
  const info = g.rooms[room]
  if (!info) { (skipped['not in graph'] ??= []).push(room); continue }
  const R = N.get(info.node)!
  // Doors of the room, plus doors of a suite space the room opens straight onto.
  const doors = new Set<string>()
  for (const a of adj.get(R.id) ?? []) {
    const n = N.get(a)!
    if (n.type === 'door') doors.add(a)
    if (n.type === 'space') for (const b of adj.get(a) ?? []) if (N.get(b)!.type === 'door') doors.add(b)
  }
  const [fx, fy] = DIR[face]
  const scored = [...doors].map((id) => {
    const d = N.get(id)!, vx = d.x - R.x, vy = d.y - R.y, L = Math.hypot(vx, vy) || 1
    return { id, dot: (vx * fx + vy * fy) / L, d }
  }).sort((a, b) => b.dot - a.dot)
  const best = scored[0]
  if (!best) { (skipped['no door in graph'] ??= []).push(room); continue }
  const why: string[] = []
  if (best.dot < 0.4) why.push(`no door of ${room} lies to the ${face}; using the closest match`)
  if (scored[1] && best.dot - scored[1].dot < 0.25) why.push(`${room} has two doors that both fit; check which one the plaque is beside`)
  plaques.push({
    room, faces: face as PlaqueInfo['faces'], door: best.id,
    x: +best.d.x.toFixed(2), y: +best.d.y.toFixed(2),
    stand: { x: +(best.d.x + fx).toFixed(2), y: +(best.d.y + fy).toFixed(2) },
    photo: !!r[cPhoto]?.trim(),
    ...(why.length ? { check: why.join('; ') } : {}),
  })
}
plaques.sort((a, b) => a.room.localeCompare(b.room, 'en', { numeric: true }))
const out: PlaqueFile = {
  floor, generated: new Date().toISOString().slice(0, 10),
  note: 'Built by tools/build-plaques.ts from private/plaques manifest. faces = the way the plaque faces (plan frame: N = up the sheet). x/y = the door it hangs beside; stand = 1 m out from the wall.',
  plaques,
}
const path = `${ROOT}src/data/floor${floor}.plaques.json`
writeFileSync(path, JSON.stringify({ ...out, plaques: undefined }, null, 1).replace(/\n}$/, ',\n "plaques": [\n' + plaques.map((p) => '  ' + JSON.stringify(p)).join(',\n') + '\n ]\n}\n'))
console.log(`Wrote ${plaques.length} plaques to src/data/floor${floor}.plaques.json`)
const flagged = plaques.filter((p) => p.check)
if (flagged.length) console.log(`\nTo check (${flagged.length}):\n` + flagged.map((p) => `  ${p.room.padEnd(5)} ${p.check}`).join('\n'))
for (const [k, v] of Object.entries(skipped)) console.log(`\nSkipped, ${k} (${v.length}): ${v.join(' ')}`)
