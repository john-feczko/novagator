// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { NavGraph } from '../graph/types.ts'
import { Router, type Route } from './router.ts'
import { directions } from './directions.ts'
import { findPlace, parseQuery } from './places.ts'

const g: NavGraph = JSON.parse(readFileSync(new URL('../data/floor3.graph.json', import.meta.url), 'utf8'))
const R = new Router(g)
const rooms = Object.entries(g.rooms)
const node = (room: string) => g.rooms[room].node

function assertValidPath(r: Route, from: string, to: string[]) {
  assert.equal(r.nodes[0], from)
  assert.ok(to.includes(r.nodes[r.nodes.length - 1]))
  assert.equal(r.edges.length, r.nodes.length - 1)
  r.edges.forEach((e, i) => {
    const pair = new Set([r.nodes[i], r.nodes[i + 1]])
    assert.ok(pair.has(e.a) && pair.has(e.b), `edge ${i} doesn't join consecutive nodes`)
  })
  assert.ok(Math.abs(r.length - r.edges.reduce((s, e) => s + e.length, 0)) < 0.05)
}

test('every room can reach every other room, and directions read cleanly', () => {
  let n = 0
  for (const [a] of rooms) for (const [b] of rooms) {
    if (a === b) continue
    const r = R.route(node(a), node(b))
    assert.ok(r, `no route ${a} -> ${b}`)
    assertValidPath(r, node(a), [node(b)])
    const d = directions(R, r, a, b)
    assert.equal(d.steps[d.steps.length - 1].icon, 'arrive')
    for (const s of d.steps) assert.doesNotMatch(s.text, /undefined|NaN|null|\s{2}|^\s|\s\.$|^[a-z]/, `${a} -> ${b}: "${s.text}"`)
    n++
  }
  assert.ok(n > 10000)
})

test('shortest is symmetric (A->B same length as B->A)', () => {
  for (let i = 0; i < rooms.length; i += 7) for (let j = 3; j < rooms.length; j += 11) {
    const [a] = rooms[i], [b] = rooms[j]
    if (a === b) continue
    assert.ok(Math.abs(R.route(node(a), node(b))!.length - R.route(node(b), node(a))!.length) < 0.01, `${a} <-> ${b}`)
  }
})

test('routes stay in the hallways: no cutting through other rooms', () => {
  // Only allowed when the destination (or start) is an inner office of a suite.
  const roomOnly = (id: string) => R.neighbors(id).every((a) => R.nodes.get(a.to)!.type !== 'corridor')
  for (const [a] of rooms) for (const [b] of rooms) {
    if (a === b) continue
    const r = R.route(node(a), node(b))!
    const inner = r.nodes.slice(1, -1).filter((id) => R.nodes.get(id)!.type === 'room')
    for (const id of inner) {
      // the transit room must be next to the start or end of the trip (suite entry)
      const pos = r.nodes.indexOf(id)
      const nearEnds = r.nodes.slice(0, pos).every((x) => R.nodes.get(x)!.type !== 'corridor') ||
                       r.nodes.slice(pos).every((x) => R.nodes.get(x)!.type !== 'corridor')
      assert.ok(nearEnds, `${a} -> ${b} cuts through ${R.nodes.get(id)!.room}`)
    }
    void roomOnly
  }
})

test('fewest-turns never has more turns, shortest is never longer', () => {
  for (let i = 0; i < rooms.length; i += 3) for (let j = 1; j < rooms.length; j += 5) {
    if (i === j) continue
    const a = node(rooms[i][0]), b = node(rooms[j][0])
    const s = R.route(a, b, { mode: 'shortest' })!, f = R.route(a, b, { mode: 'fewest-turns' })!
    assert.ok(f.turns <= s.turns, `${rooms[i][0]} -> ${rooms[j][0]}`)
    assert.ok(s.length <= f.length + 0.01)
  }
})

test('accessible routes never use stairs edges', () => {
  const stairs = g.pois.filter((p) => p.type === 'stairs').map((p) => p.node)
  const elev = g.pois.filter((p) => p.type === 'elevator').map((p) => p.node)
  for (const [a] of rooms) {
    const r = R.route(node(a), elev, { mode: 'accessible' })!
    assert.ok(r.edges.every((e) => !e.stairs))
    assert.ok(!r.nodes.some((id) => stairs.includes(id)))
  }
  // and reaching a stair node itself is impossible in accessible mode
  assert.equal(R.route(node('301'), stairs, { mode: 'accessible' }), null)
})

test('"nearest" picks the closest of several targets', () => {
  const restrooms = g.pois.filter((p) => p.type === 'restroom').map((p) => p.node)
  for (const [a] of rooms.slice(0, 40)) {
    const best = R.route(node(a), restrooms)!
    for (const t of restrooms) assert.ok(best.length <= R.route(node(a), t)!.length + 0.01)
  }
})

test('place lookup', () => {
  const ok = (q: string) => { const p = findPlace(g, q); assert.ok(p.ok, q); return p.place }
  assert.deepEqual(ok('318').nodes, [node('318')])
  assert.deepEqual(ok('Room 318').nodes, [node('318')])
  assert.deepEqual(ok('rm 3-18').nodes, [node('318')])
  assert.deepEqual(ok('309a').nodes, [node('309A')])
  assert.deepEqual(ok('staff lounge').nodes, [node('316')])
  assert.equal(ok('restroom').nodes.length, 4)
  assert.equal(ok("men's room").nodes.length, 2)
  assert.equal(ok('bathroom').nodes.length, 4)
  assert.equal(ok('elevator').nodes.length, 3)
  assert.equal(ok('stair 4').nodes.length, 1)
  assert.equal(findPlace(g, 'stair 9').ok, false)
  assert.equal(findPlace(g, '999').ok, false)
  assert.deepEqual(parseQuery('from 301 to 318'), { from: '301', to: '318' })
  assert.deepEqual(parseQuery('301 to the nearest restroom'), { from: '301', to: 'the nearest restroom' })
  assert.deepEqual(parseQuery('309A -> elevator'), { from: '309A', to: 'elevator' })
  assert.equal(parseQuery('318'), null)
})

test('known route: 309A to 356 (west wing to east end)', () => {
  const r = R.route(node('309A'), node('356'))!
  const d = directions(R, r, 'Room 309A', 'Room 356')
  assert.match(d.steps[0].text, /^Leave Room 309A through 309/)
  assert.match(d.steps[d.steps.length - 1].text, /Room 356 is the third door on your left/)
  assert.ok(r.length > 90 && r.length < 120, `length ${r.length}`)
})
