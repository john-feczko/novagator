// Phase 3: turn-by-turn directions from a route's geometry.
//
// Instructions are made at decision points only: leaving the start room,
// turns at hallway nodes, passing through doors mid-route, and arrival.
// Arrival counts doors on the destination's side of the final hallway, e.g.
// "Room 318 is the 3rd door on your right."
import type { GraphNode } from '../graph/types.ts'
import { TURN_DEG, type Route, type Router } from './router.ts'

export type Units = 'ft' | 'm'
export type StepIcon = 'start' | 'left' | 'right' | 'slight-left' | 'slight-right' | 'straight' | 'door' | 'arrive'

export interface Step {
  text: string
  icon: StepIcon
  at: string        // node id where this instruction happens
  distance: number  // meters walked during this step (before the maneuver)
  along: number     // meters from the start of the route to `at`
}

export interface Directions {
  steps: Step[]
  summary: string   // "320 ft · about 2 min"
}

const WALK_SPEED = 1.3 // m/s, typical indoor walking pace

export function formatDistance(m: number, units: Units = 'ft'): string {
  if (units === 'm') return m < 10 ? `${Math.max(1, Math.round(m))} m` : `${Math.round(m / 5) * 5} m`
  const ft = m / 0.3048
  return ft < 30 ? `${Math.max(5, Math.round(ft / 5) * 5)} ft` : `${Math.round(ft / 10) * 10} ft`
}

const ORD = ['first', 'second', 'third', 'fourth', 'fifth']

export function directions(router: Router, route: Route, fromLabel: string, toLabel: string, units: Units = 'ft'): Directions {
  const R = router
  const P = route.nodes.map((id) => R.nodes.get(id)!)
  const fmt = (m: number) => formatDistance(m, units)
  const mins = Math.max(1, Math.round(route.length / WALK_SPEED / 60))
  const summary = `${fmt(route.length)} · about ${mins} min`
  const steps: Step[] = []
  const To = cap(toLabel)

  // cumulative distance to each path index
  const cum = [0]
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + d(P[i - 1], P[i]))

  if (P.length === 1) return { steps: [{ text: `You're already at ${toLabel}.`, icon: 'arrive', at: P[0].id, distance: 0, along: 0 }], summary }

  const isC = (i: number) => P[i]?.type === 'corridor'
  const firstC = P.findIndex((n) => n.type === 'corridor')
  const lastC = P.length - 1 - [...P].reverse().findIndex((n) => n.type === 'corridor')

  // ---- No hallway at all: adjoining rooms / suites
  if (firstC < 0) {
    const via = P.slice(1, -1).filter((n) => n.type === 'room').map((n) => n.room)
    steps.push({ text: `Leave ${fromLabel}${via.length ? ` through ${via.join(', then ')}` : ''}.`, icon: 'start', at: P[0].id, distance: 0, along: 0 })
    steps.push({ text: `${To} is through the door${P.filter((n) => n.type === 'door').length > 1 ? 's' : ''} ahead.`, icon: 'arrive', at: P[P.length - 1].id, distance: route.length, along: route.length })
    return { steps, summary }
  }

  // ---- 1. Leaving the start
  const inner = P.slice(1, firstC).filter((n) => n.type === 'room').map((n) => n.room)
  const startIsRoom = ['room', 'restroom', 'space'].includes(P[0].type)
  let leave = startIsRoom ? `Leave ${fromLabel}${inner.length ? ` through ${inner.join(', then ')}` : ''}` : `Start at ${fromLabel}`
  let leg = firstC // index where the current hallway leg starts

  if (firstC === lastC) {
    // The destination's door is on the same bit of hallway as the start's.
    const tail = arrivalTail(P, lastC)
    const side = firstC > 0 && lastC + 1 < P.length ? sideOf(R.turnAngle(P[firstC - 1].id, P[firstC].id, P[lastC + 1].id)) : 'ahead'
    const where = side === 'ahead' ? 'straight across the hall' : `just to your ${side}`
    steps.push({ text: `${leave}.`, icon: 'start', at: P[0].id, distance: 0, along: 0 })
    steps.push({ text: `${To} is ${where}.${tail}`, icon: 'arrive', at: P[P.length - 1].id, distance: route.length, along: route.length })
    return { steps, summary }
  }

  const exitTurn = turnPhrase(R.turnAngle(P[firstC - 1]?.id ?? P[firstC].id, P[firstC].id, P[firstC + 1].id), firstC === 0)
  steps.push({ text: `${leave}${exitTurn.text ? ` and ${exitTurn.text}` : ''}.`, icon: 'start', at: P[0].id, distance: 0, along: 0 })

  // ---- 2. Along the hallways
  let passed = 0 // side hallways passed in the current leg
  for (let i = firstC + 1; i < lastC; i++) {
    const n = P[i]
    if (n.type !== 'corridor') {
      // Mid-route door/space/room (lobby doors, a short-cut vestibule)
      if (isC(i - 1)) {
        const walked = cum[i] - cum[leg]
        const thing = n.type === 'door' || P[i + 1]?.type === 'door' ? 'go through the doors ahead' : 'continue through the open area ahead'
        steps.push({ text: `${walk(walked, fmt, passed)}${thing}.`, icon: 'door', at: n.id, distance: walked, along: cum[i] })
        leg = i; passed = 0
      }
      continue
    }
    if (!isC(i + 1) || P[i + 1] === undefined) continue
    if (!isC(i - 1)) {
      // back in a hallway after going through doors: which way now?
      const t = turnPhrase(R.turnAngle(P[i - 1].id, n.id, P[i + 1].id), false)
      if (t.text) steps.push({ text: `After the doors, ${t.text}.`, icon: t.icon, at: n.id, distance: cum[i] - cum[leg], along: cum[i] })
      leg = i; passed = 0
      continue
    }
    const ang = R.turnAngle(P[i - 1].id, n.id, P[i + 1].id)
    const exits = corridorNeighbors(R, n.id).length
    if (Math.abs(ang) <= TURN_DEG) {
      if (exits >= 3) passed++
      continue
    }
    const t = turnPhrase(ang, false)
    const walked = cum[i] - cum[leg]
    const where = landmark(R, n) ?? (exits <= 2 ? 'where the hallway bends' : hasStraight(R, P[i - 1].id, n.id) ? 'at the junction' : 'at the end of the hall')
    const prev = steps[steps.length - 1]
    if (walked < 3 && prev) {
      // back-to-back maneuvers read better as one instruction
      prev.text = `${prev.text.replace(/\.$/, '')}, then immediately ${t.text} ${where}.`
      prev.icon = prev.icon === 'start' ? 'start' : t.icon
    } else steps.push({ text: `${walk(walked, fmt, passed)}${t.text} ${where}.`, icon: t.icon, at: n.id, distance: walked, along: cum[i] })
    leg = i; passed = 0
  }

  // ---- 3. Arrival
  const walked = cum[lastC] - cum[leg]
  const target = P[lastC + 1]
  const dir = P[lastC - 1]
  const side = sideOf(R.turnAngle(dir.id, P[lastC].id, target.id))
  // Inner offices: point at the suite's outer room first ("Room 317 ... 318 is inside")
  const entry = P.slice(lastC + 1, -1).find((n) => n.type === 'room')
  const Goal = entry ? `Room ${entry.room}` : To
  const is = /stairs$/i.test(Goal) ? 'are' : 'is'
  let where: string
  if (side === 'ahead') where = `${Goal} ${is} straight ahead.`
  else if (target.type !== 'door') where = `${Goal} ${is} on your ${side}.`
  else {
    const n = doorOrdinal(R, P, leg, lastC, target, side)
    where = n >= 1 && n <= ORD.length && walked > 3 ? `${Goal} ${is} the ${ORD[n - 1]} door on your ${side}.` : `${Goal} ${is} on your ${side}.`
  }
  const lead = walked < 2 ? '' : `Walk ${fmt(walked)}${passed ? `, past ${passed === 1 ? 'a side hallway' : `${passed} side hallways`},` : ''} and `
  const text = lead ? `${lead}${lowerFirst(where)}` : cap(where)
  steps.push({ text: text + arrivalTail(P, lastC), icon: 'arrive', at: P[P.length - 1].id, distance: route.length - cum[leg], along: route.length })
  return { steps, summary }
}

// ---------- helpers

const d = (a: GraphNode, b: GraphNode) => Math.hypot(a.x - b.x, a.y - b.y)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const lowerFirst = (s: string) => (/^The /.test(s) ? 't' + s.slice(1) : s)

function walk(m: number, fmt: (m: number) => string, passed: number): string {
  if (m < 3) return ''
  const past = passed ? `, past ${passed === 1 ? 'a side hallway' : `${passed} side hallways`},` : ''
  return `Walk ${fmt(m)}${past} and `
}

function sideOf(ang: number): 'left' | 'right' | 'ahead' {
  return Math.abs(ang) < 30 ? 'ahead' : ang > 0 ? 'left' : 'right'
}

function turnPhrase(ang: number, noIncoming: boolean): { text: string; icon: StepIcon } {
  if (noIncoming) return { text: '', icon: 'straight' }
  const a = Math.abs(ang), L = ang > 0
  if (a <= TURN_DEG) return { text: 'go straight', icon: 'straight' }
  if (a < 60) return { text: `bear ${L ? 'left' : 'right'}`, icon: L ? 'slight-left' : 'slight-right' }
  if (a > 150) return { text: `turn around`, icon: L ? 'left' : 'right' }
  return { text: `turn ${L ? 'left' : 'right'}`, icon: L ? 'left' : 'right' }
}

function corridorNeighbors(R: Router, id: string): string[] {
  return R.neighbors(id).filter((a) => R.nodes.get(a.to)!.type === 'corridor').map((a) => a.to)
}

function hasStraight(R: Router, prev: string, id: string): boolean {
  return corridorNeighbors(R, id).some((c) => c !== prev && Math.abs(R.turnAngle(prev, id, c)) <= TURN_DEG)
}

/** "by the elevators", "by Stair 4", "by the restrooms": anything findable at a turn. */
function landmark(R: Router, n: GraphNode): string | null {
  const near: GraphNode[] = []
  for (const a of R.neighbors(n.id)) {
    const m = R.nodes.get(a.to)!
    near.push(m)
    if (m.type === 'door') for (const b of R.neighbors(m.id)) near.push(R.nodes.get(b.to)!)
  }
  const elev = near.filter((m) => m.type === 'elevator')
  if (elev.length) return `by the elevator${elev.length > 1 ? 's' : ''}`
  const stair = near.find((m) => m.type === 'stairs')
  if (stair) return `by ${stair.name ?? 'the stairs'}`
  if (near.some((m) => m.type === 'restroom')) return 'by the restrooms'
  return null
}

/** Which door, counting from the start of the final hallway leg, on the same side. */
function doorOrdinal(R: Router, P: GraphNode[], leg: number, lastC: number, target: GraphNode, side: 'left' | 'right'): number {
  const doors: { along: number; id: string }[] = []
  let s = 0
  for (let j = leg + 1; j <= lastC; j++) {
    const a = P[j - 1], b = P[j]
    const L = d(a, b) || 1
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L
    s += L
    for (const arc of R.neighbors(b.id)) {
      const m = R.nodes.get(arc.to)!
      if (m.type !== 'door' && m.id !== target.id) continue
      const dx = m.x - b.x, dy = m.y - b.y
      const cross = ux * dy - uy * dx // > 0 = left
      if (Math.abs(cross) < 0.3) continue
      if ((cross > 0 ? 'left' : 'right') !== side) continue
      doors.push({ along: s + ux * dx + uy * dy, id: m.id })
    }
  }
  const mine = doors.find((x) => x.id === target.id)
  if (!mine) return -1
  return new Set(doors.filter((x) => x.along <= mine.along + 0.05).map((x) => x.id)).size
}

/** Extra words when the destination is behind more than one door (suites, vestibules). */
function arrivalTail(P: GraphNode[], lastC: number): string {
  const after = P.slice(lastC + 1, -1) // between hallway and destination
  const rooms = after.filter((n) => n.type === 'room').map((n) => n.room)
  const goal = P[P.length - 1]
  const name = goal.room && /^\d/.test(goal.room) ? `Room ${goal.room}` : (goal.name ?? 'your destination')
  if (rooms.length) return ` ${name} is inside${rooms.length > 1 ? `, through ${rooms.slice(1).join(', then ')}` : ''}.`
  if (after.filter((n) => n.type === 'door').length > 1 || after.some((n) => n.type === 'space')) return " It's through the inner door."
  return ''
}
