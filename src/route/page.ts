// Phase 3 route page: type "from 301 to 318", see the route on the map and the
// turn-by-turn steps. Tap rooms on the map to pick start, then destination.
// Deployed publicly; the facilities floor plan is only drawn when running
// `npm run dev` (it lives in private/ and never ships).
import './page.css'
import type { GraphNode, NavGraph } from '../graph/types.ts'
import floor3 from '../data/floor3.graph.json'
import { Router, type Route, type RouteMode } from './router.ts'
import { directions, formatDistance, type Step, type StepIcon, type Units } from './directions.ts'
import { findPlace, parseQuery, type Place } from './places.ts'

const g = floor3 as NavGraph
const R = new Router(g)
const NS = 'http://www.w3.org/2000/svg'

let mode: RouteMode = 'shortest'
let units: Units = 'ft'
let current: { route: Route; from: Place; to: Place; steps: Step[] } | null = null
let pickFrom: string | null = null // room picked by tapping, waiting for a destination

// ---------- layout
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header>
  <h1><b>Novagator</b> · Floor 3 routing</h1>
  <form id="f" autocomplete="off">
    <input id="q" type="text" inputmode="text" enterkeyhint="go" placeholder="from 301 to 318" aria-label="Route">
    <button id="go">Go</button>
  </form>
  <div class="opts">
    <div class="seg" id="modes">
      <button type="button" data-v="shortest">Shortest</button>
      <button type="button" data-v="accessible">Accessible</button>
      <button type="button" data-v="fewest-turns">Fewest turns</button>
    </div>
    <div class="seg" id="units"><button type="button" data-v="ft">ft</button><button type="button" data-v="m">m</button></div>
    <span class="hint">Tip: tap a room for the start, another for the destination. Try "316 to restroom".</span>
  </div>
</header>
<main>
  <div id="stage">
    <svg id="map"><g id="plan"></g><g id="base"></g><g id="rt"></g><g id="marks"></g><g id="taps"></g></svg>
    <label id="plantog"><input type="checkbox" id="showplan" checked> floor plan</label>
    <button id="fit" type="button">Fit</button>
  </div>
  <aside>
    <div id="summary"></div>
    <div id="endpoints"></div>
    <div id="msg">Type a route above, like <b>from 301 to 318</b>, or tap two rooms on the map.</div>
    <ol id="steps"></ol>
  </aside>
</main>`
const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!
const svg = $<SVGSVGElement>('#map'), q = $<HTMLInputElement>('#q')
const el = (tag: string, attrs: Record<string, string | number>, parent?: Element) => {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  parent?.appendChild(e)
  return e
}
// world (x right, y up) → svg (y down)
const sx = (n: { x: number }) => n.x, sy = (n: { y: number }) => -n.y

// ---------- base map, drawn from the graph itself
function drawBase() {
  const base = $('#base'), taps = $('#taps')
  const hall = el('path', { class: 'hall', 'stroke-width': 2.4, d: '' }, base)
  let d = ''
  for (const e of g.edges) {
    const a = R.nodes.get(e.a)!, b = R.nodes.get(e.b)!
    if (e.kind === 'corridor') d += `M${sx(a)},${sy(a)}L${sx(b)},${sy(b)}`
    else el('line', { class: 'link', x1: sx(a), y1: sy(a), x2: sx(b), y2: sy(b) }, base)
  }
  hall.setAttribute('d', d)
  const POI: Partial<Record<GraphNode['type'], [string, string]>> = { elevator: ['#7c3aed', 'E'], stairs: ['#ea580c', 'S'], restroom: ['#0891b2', 'WC'] }
  for (const n of g.nodes) {
    const poi = POI[n.type]
    if (poi) {
      const grp = el('g', { class: 'poi' }, base)
      el('circle', { cx: sx(n), cy: sy(n), r: 0.85, fill: poi[0] }, grp)
      el('text', { x: sx(n), y: sy(n), style: poi[1].length > 1 ? 'font-size:.6px' : '' }, grp).textContent = poi[1]
    } else if (n.type === 'room') {
      el('circle', { class: 'room', cx: sx(n), cy: sy(n), r: 0.3, 'data-id': n.id }, base)
      el('text', { class: 'rlabel', x: sx(n), y: sy(n) - 0.55 }, base).textContent = n.room ?? ''
    }
    if (n.room) {
      const t = el('circle', { class: 'tap', cx: sx(n), cy: sy(n), r: 1.3 }, taps)
      t.addEventListener('click', () => tapRoom(n))
    }
  }
}

// ---------- plan underlay: dev server only
fetch('/private/floorplans/Drosdick_3_floor.svg').then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('svg') ? r.text() : Promise.reject())).then((txt) => {
  const map = new DOMParser().parseFromString(txt, 'image/svg+xml').querySelector('#map')
  if (!map) return
  const plan = $('#plan')
  plan.appendChild(document.importNode(map, true))
  plan.querySelectorAll('path, line, polyline').forEach((e) => e.setAttribute('vector-effect', 'non-scaling-stroke'))
  for (const [id, w] of [['walls', '1.3'], ['doors', '0.6'], ['detail', '0.4'], ['labels', '0.4'], ['misc', '0.4']])
    plan.querySelector(`#${id}`)?.setAttribute('stroke-width', w)
  plan.querySelector('#labels')?.setAttribute('style', 'display:none')
  $<HTMLElement>('#plantog').style.display = 'block'
  svg.classList.add('plan-on')
}).catch(() => { /* deployed site: no plan, the graph map is enough */ })
$<HTMLInputElement>('#showplan').onchange = (e) => {
  const on = (e.target as HTMLInputElement).checked
  $<SVGGElement>('#plan').style.display = on ? '' : 'none'
  svg.classList.toggle('plan-on', on)
}

// ---------- camera: viewBox pan / zoom / pinch
let vb = { x: -50, y: -40, w: 108, h: 60 }
const setVB = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`)
function fitTo(x0: number, y0: number, x1: number, y1: number, pad = 3) {
  const r = svg.getBoundingClientRect()
  const w = x1 - x0 + 2 * pad, h = y1 - y0 + 2 * pad
  const s = Math.max(w / Math.max(r.width, 1), h / Math.max(r.height, 1))
  vb = { w: r.width * s, h: r.height * s, x: (x0 + x1) / 2 - (r.width * s) / 2, y: (y0 + y1) / 2 - (r.height * s) / 2 }
  setVB()
}
function fitAll() {
  const xs = g.nodes.map(sx), ys = g.nodes.map(sy)
  fitTo(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 2)
}
function fitRoute() {
  if (!current) return fitAll()
  const pts = current.route.nodes.map((id) => R.nodes.get(id)!)
  const xs = pts.map(sx), ys = pts.map(sy)
  fitTo(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 6)
}
const toSvg = (cx: number, cy: number) => {
  const r = svg.getBoundingClientRect()
  return { x: vb.x + ((cx - r.left) / r.width) * vb.w, y: vb.y + ((cy - r.top) / r.height) * vb.h }
}
function zoomAt(cx: number, cy: number, f: number) {
  const p = toSvg(cx, cy)
  const w = Math.min(Math.max(vb.w * f, 8), 400), k = w / vb.w
  vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w, h: vb.h * k }
  setVB()
}
svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * 0.0015)) }, { passive: false })
const ptrs = new Map<number, { x: number; y: number }>()
let pinch = 0
svg.addEventListener('pointerdown', (e) => {
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y) }
})
svg.addEventListener('pointermove', (e) => {
  const prev = ptrs.get(e.pointerId)
  if (!prev) return
  const cur = { x: e.clientX, y: e.clientY }
  if (ptrs.size === 1) {
    if (!svg.hasPointerCapture(e.pointerId) && Math.hypot(cur.x - prev.x, cur.y - prev.y) < 4) return // still a tap
    svg.setPointerCapture(e.pointerId)
    const r = svg.getBoundingClientRect()
    vb.x -= ((cur.x - prev.x) / r.width) * vb.w
    vb.y -= ((cur.y - prev.y) / r.height) * vb.h
    setVB()
    ptrs.set(e.pointerId, cur)
  } else if (ptrs.size === 2) {
    ptrs.set(e.pointerId, cur)
    const [a, b] = [...ptrs.values()]
    const dd = Math.hypot(a.x - b.x, a.y - b.y)
    if (pinch) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch / dd)
    pinch = dd
  }
})
const up = (e: PointerEvent) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = 0 }
svg.addEventListener('pointerup', up)
svg.addEventListener('pointercancel', up)
$('#fit').addEventListener('click', fitRoute)

// ---------- routing
const ICON: Record<StepIcon, string> = {
  start: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
  straight: '<path d="M12 20V5M6 11l6-6 6 6" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  left: '<path d="M17 20v-7a3 3 0 0 0-3-3H6M10 5l-5 5 5 5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  right: '<path d="M7 20v-7a3 3 0 0 1 3-3h8M14 5l5 5-5 5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  'slight-left': '<path d="M15 20v-6L8 7M8 13V7h6" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  'slight-right': '<path d="M9 20v-6l7-7M16 13V7h-6" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  door: '<path d="M6 20V4h9v16M4 20h16M12 12h.01" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
  arrive: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" fill="currentColor"/><circle cx="12" cy="10" r="2.2" fill="#dc2626"/>',
}

function showError(text: string, suggestions: string[] = [], field?: 'from' | 'to', other?: string) {
  current = null
  $('#rt').innerHTML = ''; $('#marks').innerHTML = ''
  $('#summary').textContent = ''; $('#endpoints').textContent = ''; $('#steps').innerHTML = ''
  const m = $<HTMLDivElement>('#msg')
  m.className = 'err'
  m.textContent = text
  if (suggestions.length) {
    const box = document.createElement('div'); box.className = 'sugg'
    for (const s of suggestions) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = s
      const val = s.split(' ')[0]
      b.onclick = () => { if (field && other !== undefined) run(field === 'from' ? `${val} to ${other}` : `${other} to ${val}`) }
      box.appendChild(b)
    }
    m.appendChild(box)
  }
}

function run(text: string, fit = true) {
  q.value = text
  const pq = parseQuery(text)
  if (!pq) return showError('Write it as "from 301 to 318" (or tap two rooms on the map).')
  const A = findPlace(g, pq.from)
  if (!A.ok) return showError(`Start: ${A.error}`, A.suggestions, 'from', pq.to)
  const B = findPlace(g, pq.to)
  if (!B.ok) return showError(`Destination: ${B.error}`, B.suggestions, 'to', pq.from)
  if (A.place.nodes.length > 1) return showError(`Start at a specific place, not "${pq.from}".`)
  const route = R.route(A.place.nodes[0], B.place.nodes, { mode })
  if (!route) return showError(mode === 'accessible' ? `No step-free route to ${B.place.label}.` : `No route found to ${B.place.label}.`)
  const dest = R.nodes.get(route.nodes[route.nodes.length - 1])!
  // "the nearest restroom" → name the one we picked
  const toLabel = B.place.nodes.length === 1 ? B.place.label
    : dest.type === 'restroom' ? `the ${(dest.name ?? '').toLowerCase()}'s restroom (${dest.room})`.replace('the \'s ', 'the ')
    : dest.type === 'elevator' || dest.type === 'stairs' ? (dest.name ?? B.place.label)
    : `${B.place.label.replace(/^the nearest /, 'the ')} (${dest.room})`
  const D = directions(R, route, A.place.label, toLabel, units)
  current = { route, from: A.place, to: B.place, steps: D.steps }
  const url = new URL(location.href); url.searchParams.set('q', text); url.searchParams.set('mode', mode)
  history.replaceState(null, '', url)

  $('#msg').className = ''; $('#msg').textContent = ''
  $('#summary').textContent = D.summary
  $('#endpoints').textContent = `${A.place.label} → ${toLabel} · ${route.turns} turn${route.turns === 1 ? '' : 's'}`
  const ol = $('#steps'); ol.innerHTML = ''
  D.steps.forEach((s) => {
    const li = document.createElement('li'); li.className = s.icon
    li.innerHTML = `<div class="ic"><svg viewBox="0 0 24 24">${ICON[s.icon]}</svg></div><div><div class="t"></div><div class="d"></div></div>`
    li.querySelector('.t')!.textContent = s.text
    li.querySelector('.d')!.textContent = s.icon === 'start' ? '' : `${formatDistance(s.along, units)} from start`
    li.onclick = () => { ol.querySelectorAll('li').forEach((x) => x.classList.remove('on')); li.classList.add('on'); highlight(s.at) }
    ol.appendChild(li)
  })
  drawRoute(route)
  if (fit) fitRoute()
}

function drawRoute(r: Route) {
  const rt = $('#rt'), marks = $('#marks')
  rt.innerHTML = ''; marks.innerHTML = ''
  const pts = r.nodes.map((id) => R.nodes.get(id)!)
  const d = pts.map((n, i) => `${i ? 'L' : 'M'}${sx(n)},${sy(n)}`).join('')
  el('path', { class: 'route-casing', d }, rt)
  el('path', { class: 'route', d }, rt)
  const a = pts[0], b = pts[pts.length - 1]
  el('circle', { cx: sx(a), cy: sy(a), r: 0.9, fill: '#16a34a', stroke: '#fff', 'stroke-width': 0.3 }, marks)
  const pin = el('g', { transform: `translate(${sx(b)} ${sy(b)})` }, marks)
  el('path', { transform: 'scale(.7)', d: 'M0 0c-.9-1.3-2-2.4-2-3.6a2 2 0 0 1 4 0c0 1.2-1.1 2.3-2 3.6z', fill: '#dc2626', stroke: '#fff', 'stroke-width': 0.25 }, pin)
  el('circle', { cx: 0, cy: -2.52, r: 0.5, fill: '#fff' }, pin)
}

function highlight(id: string) {
  $('#marks').querySelector('.hl')?.remove()
  const n = R.nodes.get(id)!
  el('circle', { class: 'hl', cx: sx(n), cy: sy(n), r: 0.8 }, $('#marks'))
}

function tapRoom(n: GraphNode) {
  const key = n.room ?? n.name ?? n.id
  if (!pickFrom) {
    pickFrom = key
    q.value = `from ${key} to `
    $('#msg').className = ''
    $('#msg').textContent = `Start: ${key}. Now tap the destination (or type it).`
    $('#rt').innerHTML = ''; $('#marks').innerHTML = ''; $('#steps').innerHTML = ''; $('#summary').textContent = ''; $('#endpoints').textContent = ''
    highlight(n.id)
  } else {
    const from = pickFrom
    pickFrom = null
    run(`from ${from} to ${key}`)
  }
}

// ---------- controls
function syncSeg(id: string, v: string) {
  document.querySelectorAll<HTMLButtonElement>(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v))
}
$('#modes').addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).dataset.v as RouteMode | undefined
  if (!v) return
  mode = v; syncSeg('modes', mode)
  if (current || q.value) run(q.value, false)
})
$('#units').addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).dataset.v as Units | undefined
  if (!v) return
  units = v; syncSeg('units', units)
  try { localStorage.setItem('novagator.units', units) } catch { /* private mode */ }
  if (current) run(q.value, false)
})
$<HTMLFormElement>('#f').addEventListener('submit', (e) => { e.preventDefault(); pickFrom = null; q.blur(); run(q.value) })

// ---------- go
try { const u = localStorage.getItem('novagator.units'); if (u === 'm' || u === 'ft') units = u } catch { /* ignore */ }
const params = new URLSearchParams(location.search)
const m0 = params.get('mode'); if (m0 === 'shortest' || m0 === 'accessible' || m0 === 'fewest-turns') mode = m0
syncSeg('modes', mode); syncSeg('units', units)
drawBase()
requestAnimationFrame(() => {
  fitAll()
  const q0 = params.get('q')
  if (q0) run(q0)
})
new ResizeObserver(() => { if (current) fitRoute(); else fitAll() }).observe($('#stage'))
