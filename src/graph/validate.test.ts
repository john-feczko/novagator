// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { NavGraph } from './types.ts'
import { components, validate, indexNodes } from './validate.ts'

const g: NavGraph = JSON.parse(readFileSync(new URL('../data/floor3.graph.json', import.meta.url), 'utf8'))

test('floor 3 graph has no errors', () => {
  const errors = validate(g).filter((p) => p.level === 'error')
  assert.deepEqual(errors.map((p) => p.message), [])
})

test('every room on floor 3 is reachable', () => {
  const main = new Set(components(g)[0])
  const unreachable = Object.entries(g.rooms).filter(([, r]) => !main.has(r.node)).map(([n]) => n)
  assert.deepEqual(unreachable, [])
})
