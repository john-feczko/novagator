// Where each room-number plaque is, and which way it faces. Built from the
// Phase 1 field log by tools/build-plaques.ts.
import type { NavGraph } from '../graph/types.ts'

export type Facing = 'N' | 'E' | 'S' | 'W'

export interface PlaqueInfo {
  room: string
  faces: Facing            // the way the plaque faces, plan frame (N = up the sheet)
  door: string             // graph node of the door it hangs beside
  x: number; y: number     // that door, meters
  stand: { x: number; y: number } // where you stand to read it
  photo: boolean           // in the OCR test set
  check?: string           // the builder wasn't sure; look at it on site
}

export interface PlaqueFile { floor: string; generated: string; note: string; plaques: PlaqueInfo[] }

/** Bearing you face when reading a plaque: straight at the wall, opposite the
 *  way the plaque faces. Degrees clockwise from plan north. */
export const readingBearing = (f: Facing): number => ({ S: 0, W: 90, N: 180, E: 270 })[f]

/** Where someone is when they say "I'm at room X" or scan its plaque. Uses the
 *  plaque if we have one, otherwise the room's door that opens onto a hallway. */
export function placeForRoom(g: NavGraph, plaques: PlaqueInfo[], room: string): { x: number; y: number; bearing: number | null; plaque: PlaqueInfo | null } | null {
  const key = room.toUpperCase()
  const p = plaques.find((q) => q.room.toUpperCase() === key)
  if (p) return { ...p.stand, bearing: readingBearing(p.faces), plaque: p }
  const info = g.rooms[key] ?? g.rooms[room]
  if (!info) return null
  const nodes = new Map(g.nodes.map((n) => [n.id, n]))
  // A door of the room that connects to a corridor.
  for (const e of g.edges) {
    const other = e.a === info.node ? e.b : e.b === info.node ? e.a : null
    if (!other || nodes.get(other)?.type !== 'door') continue
    const toHall = g.edges.find((f) => f.kind === 'doorway' && (f.a === other || f.b === other))
    if (toHall) { const d = nodes.get(other)!; return { x: d.x, y: d.y, bearing: null, plaque: null } }
  }
  const r = nodes.get(info.node)!
  return { x: r.x, y: r.y, bearing: null, plaque: null }
}
