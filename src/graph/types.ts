// Navigation graph data model (Phase 2).
// Coordinates are meters in the shared building frame: x right, y up on the
// plan sheet, origin at the Stair 1 inner corner (same on every floor).

export type NodeType =
  | 'corridor'   // point on a hallway centerline (junctions, bends, door attach points)
  | 'door'       // a doorway between two spaces
  | 'room'       // destination: a numbered room (node sits at the room label)
  | 'restroom'
  | 'space'      // unnumbered space between doors (vestibule, suite hallway)
  | 'elevator'
  | 'stairs'

export interface GraphNode {
  id: string
  floor: string
  x: number
  y: number
  type: NodeType
  room?: string        // room number, for room/restroom nodes
  name?: string        // name on the plan
  rooms?: string[]     // for doors: the rooms this door leads into
  serves?: string | null // for elevators/stairs: floors served, e.g. "B-3"
  inferred?: boolean   // guessed by the generator; check on site / in the editor
}

export type EdgeKind =
  | 'corridor' // along a hallway
  | 'doorway'  // corridor centerline <-> door (or elevator/stair entrance)
  | 'room'     // door <-> room/space interior

export interface GraphEdge {
  a: string
  b: string
  length: number // meters
  kind: EdgeKind
  inferred?: boolean
  stairs?: boolean
}

export interface NavGraph {
  version: number
  building: string
  generated: string
  units: 'meters'
  frame: string
  floors: string[]
  todo: string[]
  rooms: Record<string, { node: string; name: string; floor: string }>
  pois: { node: string; type: NodeType; name: string }[]
  nodes: GraphNode[]
  edges: GraphEdge[]
}
