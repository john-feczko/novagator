// Novagator graph editor (Phase 2). Dev tool: run `npm run dev`, open /graph.html.
// Shows the navigation graph over the private floor plan and lets you fix it,
// then saves back to src/data/floor3.graph.json.
import './editor.css'
import type { EdgeKind, GraphEdge, GraphNode, NavGraph, NodeType } from '../graph/types.ts'
import { dist, refreshLengths, validate, type Problem } from '../graph/validate.ts'
import floor3 from '../data/floor3.graph.json'

const FLOOR = '3'
const SVGNS = 'http://www.w3.org/2000/svg'
const COLORS: Record<NodeType, string> = {
  corridor: '#8a8a85', door: '#2a8a3b', room: '#2456c4', restroom: '#0f8a8a',
  space: '#7a46b8', elevator: '#e07b00', stairs: '#e07b00',
}
const EDGE_STYLE: Record<EdgeKind, string> = { corridor: '#555', doorway: '#2a8a3b', room: '#2456c4' }

let g: NavGraph = structuredClone(floor3) as NavGraph
let N = new Map<string, GraphNode>()
const reindex = () => { N = new Map(g.nodes.map((n) => [n.id, n])) }
reindex()

type Mode = 'select' | 'connect' | 'add' | 'delete'
let mode: Mode = 'select'
let sel: { kind: 'node'; id: string } | { kind: 'edge'; i: number } | null = null
let connectFrom: string | null = null
let dirty = false
const undo: string[] = []
const snapshot = () => { undo.push(JSON.stringify(g)); if (undo.length > 60) undo.shift() }

// ---------- layout
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
<header>
  <h1>Novagator · Floor ${FLOOR} graph</h1>
  <div class="group" id="modes">
    <button data-mode="select" title="V">Select / move</button>
    <button data-mode="connect" title="C">Connect</button>
    <button data-mode="add" title="N">Add node</button>
    <button data-mode="delete" title="D">Delete</button>
  </div>
  <select id="addtype" title="Type for new nodes">
    <option value="corridor">corridor</option><option value="door">door</option><option value="space">space</option>
    <option value="room">room</option><option value="restroom">restroom</option><option value="elevator">elevator</option><option value="stairs">stairs</option>
  </select>
  <input type="search" id="find" placeholder="Room # (Enter)">
  <label class="tog"><input type="checkbox" id="showplan" checked> plan</label>
  <label class="tog"><input type="checkbox" id="showlabels" checked> labels</label>
  <label class="tog"><input type="checkbox" id="showcorr" checked> corridor dots</label>
  <button id="undo" title="Ctrl+Z">Undo</button>
  <button id="save" class="primary">Save</button>
  <span id="status"></span>
</header>
<div id="stage"><svg id="svg"><g id="cam"><g id="plan"></g><g id="graph" transform="scale(1,-1)"><g id="edges"></g><g id="nodes"></g><g id="hl"></g></g></g></svg></div>
<aside>
  <h2>Selected</h2><div id="info" class="help">Click a node or an edge.</div>
  <h2>Problems</h2><ul class="list" id="problems"></ul>
  <h2>To check (<span id="ncheck">0</span>)</h2>
  <p class="help">Red rings and red dashed lines were guessed. Fix them if needed, then untick "needs check".</p>
  <ul class="list" id="checks"></ul>
  <h2>Notes from the generator</h2><ul class="list help" id="todo"></ul>
  <h2>Keys</h2>
  <p class="help">Drag empty space to pan, wheel to zoom. V/C/N/D switch modes. Delete removes the selection. In "Add node", clicking on an edge splits it. Esc cancels.</p>
  <div class="legend">${(Object.keys(COLORS) as NodeType[]).map((t) => `<span><i style="background:${COLORS[t]}"></i>${t}</span>`).join('')}</div>
</aside>`
const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!
const svg = $<SVGSVGElement>('#svg'), cam = $<SVGGElement>('#cam'), plan = $<SVGGElement>('#plan')
const gEdges = $<SVGGElement>('#edges'), gNodes = $<SVGGElement>('#nodes'), gHl = $<SVGGElement>('#hl')
const stage = $<HTMLDivElement>('#stage')
const status = (s: string) => { $('#status').textContent = s }

// ---------- camera (world: meters, y up)
let k = 10, tx = 0, ty = 0
const applyCam = () => { cam.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`); sizeNodes() }
const toWorld = (cx: number, cy: number) => {
  const r = svg.getBoundingClientRect()
  return { x: (cx - r.left - tx) / k, y: -(cy - r.top - ty) / k }
}
function fit(x0: number, y0: number, x1: number, y1: number) {
  const r = svg.getBoundingClientRect()
  k = Math.min(r.width / (x1 - x0), r.height / (y1 - y0)) * 0.92
  tx = r.width / 2 - k * (x0 + x1) / 2
  ty = r.height / 2 + k * (y0 + y1) / 2
  applyCam()
}
const zoomTo = (x: number, y: number, kk = 40) => {
  const r = svg.getBoundingClientRect(); k = kk; tx = r.width / 2 - k * x; ty = r.height / 2 + k * y; applyCam()
}

// ---------- plan underlay (dev server only; never deployed)
fetch(`/private/floorplans/Drosdick_${FLOOR}_floor.svg`).then((r) => (r.ok ? r.text() : Promise.reject(r.status))).then((txt) => {
  const doc = new DOMParser().parseFromString(txt, 'image/svg+xml')
  const map = doc.querySelector('#map')
  if (!map) throw new Error('no #map group')
  plan.appendChild(document.importNode(map, true))
  plan.querySelectorAll<SVGElement>('path, line, polyline').forEach((el) => el.setAttribute('vector-effect', 'non-scaling-stroke'))
  for (const [id, w] of [['walls', '1.6'], ['doors', '0.8'], ['detail', '0.5'], ['labels', '0.5'], ['misc', '0.5']])
    plan.querySelector(`#${id}`)?.setAttribute('stroke-width', w)
  plan.querySelector('#labels')?.setAttribute('stroke', '#9db3e6')
}).catch((e) => status(`Floor plan not loaded (${e}). Run "npm run dev" and keep the SVG in private/floorplans.`))

// ---------- rendering
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const e = document.createElementNS(SVGNS, tag)
  for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, String(v))
  return e
}
function nodeRadius(n: GraphNode) {
  const px = n.type === 'corridor' ? 2.5 : n.type === 'room' || n.type === 'restroom' ? 5 : 4
  return px / k
}
function sizeNodes() {
  gNodes.querySelectorAll<SVGCircleElement>('circle').forEach((c) => {
    const n = N.get(c.dataset.id!)
    if (n) c.setAttribute('r', String(nodeRadius(n) * (c.classList.contains('ring') ? 1.9 : 1)))
  })
  drawHighlight()
}
let rafPending = false
function render() {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => { rafPending = false; renderNow() })
}
function renderNow() {
  const showCorr = $<HTMLInputElement>('#showcorr').checked
  gEdges.replaceChildren(); gNodes.replaceChildren()
  g.edges.forEach((e, i) => {
    const a = N.get(e.a), b = N.get(e.b)
    if (!a || !b) return
    gEdges.append(el('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'data-i': i, 'vector-effect': 'non-scaling-stroke',
      stroke: e.inferred ? '#d32f2f' : EDGE_STYLE[e.kind], 'stroke-width': e.kind === 'corridor' ? 2.2 : 1.4,
      'stroke-dasharray': e.inferred ? '5 3' : e.kind === 'room' ? '2 2' : '', 'stroke-linecap': 'round',
    }))
  })
  for (const n of g.nodes) {
    if (n.inferred) {
      const ring = el('circle', { cx: n.x, cy: n.y, r: 0, fill: 'none', stroke: '#d32f2f', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke', 'data-id': n.id })
      ring.classList.add('ring'); gNodes.append(ring)
    }
    if (n.type === 'corridor' && !showCorr && !n.inferred) continue
    gNodes.append(el('circle', { cx: n.x, cy: n.y, r: 0, fill: COLORS[n.type], stroke: '#fff', 'stroke-width': 0.8, 'vector-effect': 'non-scaling-stroke', 'data-id': n.id }))
  }
  sizeNodes(); renderSide()
}
function drawHighlight() {
  gHl.replaceChildren()
  const mark = (n: GraphNode, color: string) =>
    gHl.append(el('circle', { cx: n.x, cy: n.y, r: 9 / k, fill: 'none', stroke: color, 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke' }))
  if (sel?.kind === 'node') { const n = N.get(sel.id); if (n) mark(n, '#ffb300') }
  if (sel?.kind === 'edge') {
    const e = g.edges[sel.i], a = e && N.get(e.a), b = e && N.get(e.b)
    if (a && b) gHl.append(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: '#ffb300', 'stroke-width': 6, opacity: 0.8, 'vector-effect': 'non-scaling-stroke' }))
  }
  if (connectFrom) { const n = N.get(connectFrom); if (n) mark(n, '#00b0ff') }
}

// ---------- side panel
function esc(s: string) { return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`) }
function renderSide() {
  const info = $('#info')
  if (sel?.kind === 'node' && N.get(sel.id)) {
    const n = N.get(sel.id)!
    const deg = g.edges.filter((e) => e.a === n.id || e.b === n.id).length
    info.innerHTML = `<div class="kv">
      <span>id</span><b>${esc(n.id)}</b>
      <span>type</span><select id="f-type">${Object.keys(COLORS).map((t) => `<option ${t === n.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <span>room</span><input type="text" id="f-room" value="${esc(n.room ?? '')}">
      <span>name</span><input type="text" id="f-name" value="${esc(n.name ?? '')}">
      ${n.type === 'door' ? `<span>leads to</span><input type="text" id="f-rooms" value="${esc((n.rooms ?? []).join(', '))}">` : ''}
      <span>x, y</span><span>${n.x.toFixed(2)}, ${n.y.toFixed(2)} m · ${deg} edge(s)</span>
      <span></span><label><input type="checkbox" id="f-inf" ${n.inferred ? 'checked' : ''}> needs check</label></div>`
    const upd = (f: () => void) => () => { snapshot(); f(); dirty = true; render() }
    $<HTMLSelectElement>('#f-type').onchange = upd(() => { n.type = $<HTMLSelectElement>('#f-type').value as NodeType })
    $<HTMLInputElement>('#f-room').onchange = upd(() => { n.room = $<HTMLInputElement>('#f-room').value.trim() || undefined })
    $<HTMLInputElement>('#f-name').onchange = upd(() => { n.name = $<HTMLInputElement>('#f-name').value.trim() || undefined })
    document.querySelector<HTMLInputElement>('#f-rooms')?.addEventListener('change', upd(() => {
      n.rooms = $<HTMLInputElement>('#f-rooms').value.split(',').map((s) => s.trim()).filter(Boolean)
    }))
    $<HTMLInputElement>('#f-inf').onchange = upd(() => { if ($<HTMLInputElement>('#f-inf').checked) n.inferred = true; else delete n.inferred })
  } else if (sel?.kind === 'edge' && g.edges[sel.i]) {
    const e = g.edges[sel.i]
    info.innerHTML = `<div class="kv">
      <span>from</span><b>${esc(e.a)}</b><span>to</span><b>${esc(e.b)}</b>
      <span>length</span><span>${e.length.toFixed(2)} m</span>
      <span>kind</span><select id="f-kind">${(['corridor', 'doorway', 'room'] as EdgeKind[]).map((t) => `<option ${t === e.kind ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <span></span><label><input type="checkbox" id="f-stairs" ${e.stairs ? 'checked' : ''}> stairs (not accessible)</label>
      <span></span><label><input type="checkbox" id="f-inf" ${e.inferred ? 'checked' : ''}> needs check</label></div>`
    const upd = (f: () => void) => () => { snapshot(); f(); dirty = true; render() }
    $<HTMLSelectElement>('#f-kind').onchange = upd(() => { e.kind = $<HTMLSelectElement>('#f-kind').value as EdgeKind })
    $<HTMLInputElement>('#f-stairs').onchange = upd(() => { if ($<HTMLInputElement>('#f-stairs').checked) e.stairs = true; else delete e.stairs })
    $<HTMLInputElement>('#f-inf').onchange = upd(() => { if ($<HTMLInputElement>('#f-inf').checked) e.inferred = true; else delete e.inferred })
  } else info.innerHTML = '<span class="help">Click a node or an edge.</span>'

  // problems
  refreshLengths(g)
  const probs = validate(g)
  const pl = $('#problems')
  pl.replaceChildren()
  if (!probs.length) pl.innerHTML = `<li class="help">${g.nodes.length ? 'None. Every room is reachable.' : 'Graph is empty. Use Add node to start.'}</li>`
  probs.slice(0, 40).forEach((p: Problem) => {
    const li = document.createElement('li'); li.className = p.level === 'error' ? 'err' : 'warn'; li.textContent = p.message
    li.onclick = () => { const n = N.get(p.nodes[0]); if (n) { sel = { kind: 'node', id: n.id }; zoomTo(n.x, n.y); renderSide() } }
    pl.append(li)
  })
  // things to check
  const cl = $('#checks'); cl.replaceChildren()
  const items: { label: string; go: () => void }[] = []
  for (const n of g.nodes) if (n.inferred) items.push({
    label: `${n.type} ${n.room ?? (n.rooms?.length ? '→ ' + n.rooms.join(', ') : n.name ?? n.id)}`,
    go: () => { sel = { kind: 'node', id: n.id }; zoomTo(n.x, n.y) },
  })
  g.edges.forEach((e, i) => {
    if (!e.inferred) return
    const a = N.get(e.a), b = N.get(e.b)
    if (!a || !b) return
    const tag = [a, b].map((n) => n.room ?? n.name ?? n.type).join(' – ')
    items.push({ label: `link ${tag}`, go: () => { sel = { kind: 'edge', i }; zoomTo((a.x + b.x) / 2, (a.y + b.y) / 2) } })
  })
  $('#ncheck').textContent = String(items.length)
  for (const it of items) { const li = document.createElement('li'); li.textContent = it.label; li.onclick = () => { it.go(); renderSide() }; cl.append(li) }
  const tl = $('#todo'); tl.replaceChildren()
  for (const t of g.todo) { const li = document.createElement('li'); li.textContent = t; tl.append(li) }
  status(dirty ? 'Unsaved changes' : `${g.nodes.length} nodes · ${g.edges.length} edges`)
}

// ---------- picking
function pickNode(cx: number, cy: number): GraphNode | null {
  const p = toWorld(cx, cy); let best: GraphNode | null = null, bd = 9 / k
  for (const n of g.nodes) {
    if (n.type === 'corridor' && !$<HTMLInputElement>('#showcorr').checked && !n.inferred) continue
    const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < bd) { bd = d; best = n }
  }
  return best
}
function pickEdge(cx: number, cy: number, tolPx = 6): { i: number; t: number; x: number; y: number } | null {
  const p = toWorld(cx, cy); let best = null as null | { i: number; t: number; x: number; y: number; d: number }
  g.edges.forEach((e, i) => {
    const a = N.get(e.a), b = N.get(e.b); if (!a || !b) return
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-9
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2))
    const x = a.x + t * dx, y = a.y + t * dy, d = Math.hypot(p.x - x, p.y - y)
    if (d < tolPx / k && (!best || d < best.d)) best = { i, t, x, y, d }
  })
  return best
}

// ---------- editing operations
const PREFIX: Record<NodeType, string> = { corridor: 'C', door: 'D', room: 'R', restroom: 'R', space: 'P', elevator: 'E', stairs: 'S' }
function newId(type: NodeType) {
  const p = `${FLOOR}-${PREFIX[type]}`
  let max = 0
  for (const n of g.nodes) if (n.id.startsWith(p)) { const m = /^\D*(\d+)$/.exec(n.id.slice(p.length)); if (m) max = Math.max(max, +m[1]) }
  let id = `${p}${String(max + 1).padStart(3, '0')}`
  while (N.has(id)) id += 'x'
  return id
}
function edgeKindFor(a: GraphNode, b: GraphNode): EdgeKind {
  const inside = (n: GraphNode) => n.type === 'room' || n.type === 'restroom' || n.type === 'space'
  if (a.type === 'corridor' && b.type === 'corridor') return 'corridor'
  if (inside(a) || inside(b)) return 'room'
  return 'doorway'
}
function addEdge(a: string, b: string, kind?: EdgeKind) {
  if (a === b || g.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))) return
  const A = N.get(a)!, B = N.get(b)!
  const e: GraphEdge = { a, b, length: Math.round(dist(A, B) * 100) / 100, kind: kind ?? edgeKindFor(A, B) }
  if (A.type === 'stairs' || B.type === 'stairs') e.stairs = true
  g.edges.push(e)
}
function addNode(x: number, y: number, type: NodeType): GraphNode {
  const n: GraphNode = { id: newId(type), floor: FLOOR, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, type }
  g.nodes.push(n); N.set(n.id, n); return n
}
function deleteNode(id: string) {
  g.nodes = g.nodes.filter((n) => n.id !== id)
  g.edges = g.edges.filter((e) => e.a !== id && e.b !== id)
  reindex()
}
function splitEdge(i: number, x: number, y: number): GraphNode {
  const e = g.edges[i], n = addNode(x, y, 'corridor')
  g.edges.splice(i, 1)
  addEdge(e.a, n.id, e.kind); addEdge(n.id, e.b, e.kind)
  return n
}

// ---------- pointer handling
let drag: { type: 'pan'; sx: number; sy: number; tx: number; ty: number } | { type: 'node'; id: string; moved: boolean } | null = null
svg.addEventListener('pointerdown', (ev) => {
  svg.setPointerCapture(ev.pointerId)
  const n = pickNode(ev.clientX, ev.clientY)
  if (mode === 'select') {
    if (n) { sel = { kind: 'node', id: n.id }; drag = { type: 'node', id: n.id, moved: false }; renderSide(); drawHighlight(); return }
    const e = pickEdge(ev.clientX, ev.clientY)
    if (e) { sel = { kind: 'edge', i: e.i }; renderSide(); drawHighlight(); return }
    sel = null; renderSide(); drawHighlight()
  } else if (mode === 'connect') {
    if (n) {
      if (!connectFrom) connectFrom = n.id
      else { snapshot(); addEdge(connectFrom, n.id); dirty = true; connectFrom = n.id; render() }
      drawHighlight(); return
    }
  } else if (mode === 'add') {
    const p = toWorld(ev.clientX, ev.clientY)
    const type = $<HTMLSelectElement>('#addtype').value as NodeType
    snapshot()
    const e = type === 'corridor' ? pickEdge(ev.clientX, ev.clientY) : null
    const nn = e ? splitEdge(e.i, e.x, e.y) : addNode(p.x, p.y, type)
    sel = { kind: 'node', id: nn.id }; dirty = true; render(); return
  } else if (mode === 'delete') {
    if (n) { snapshot(); deleteNode(n.id); sel = null; dirty = true; render(); return }
    const e = pickEdge(ev.clientX, ev.clientY)
    if (e) { snapshot(); g.edges.splice(e.i, 1); sel = null; dirty = true; render(); return }
  }
  drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, tx, ty }; stage.classList.add('panning')
})
svg.addEventListener('pointermove', (ev) => {
  if (!drag) return
  if (drag.type === 'pan') { tx = drag.tx + ev.clientX - drag.sx; ty = drag.ty + ev.clientY - drag.sy; applyCam(); return }
  const n = N.get(drag.id); if (!n) return
  if (!drag.moved) { snapshot(); drag.moved = true }
  const p = toWorld(ev.clientX, ev.clientY); n.x = Math.round(p.x * 100) / 100; n.y = Math.round(p.y * 100) / 100
  dirty = true; render()
})
svg.addEventListener('pointerup', () => { drag = null; stage.classList.remove('panning') })
svg.addEventListener('wheel', (ev) => {
  ev.preventDefault()
  const r = svg.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top
  const f = Math.exp(-ev.deltaY * 0.0015), nk = Math.max(2, Math.min(400, k * f))
  tx = mx - (mx - tx) * (nk / k); ty = my - (my - ty) * (nk / k); k = nk; applyCam()
}, { passive: false })

// ---------- toolbar
function setMode(m: Mode) {
  mode = m; connectFrom = null
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)))
  drawHighlight()
}
document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)))
setMode('select')
$<HTMLInputElement>('#showplan').onchange = (e) => { plan.style.display = (e.target as HTMLInputElement).checked ? '' : 'none' }
$<HTMLInputElement>('#showlabels').onchange = (e) => {
  const l = plan.querySelector<SVGGElement>('#labels'); if (l) l.style.display = (e.target as HTMLInputElement).checked ? '' : 'none'
}
$<HTMLInputElement>('#showcorr').onchange = () => render()
$<HTMLInputElement>('#find').onkeydown = (ev) => {
  if (ev.key !== 'Enter') return
  const q = (ev.target as HTMLInputElement).value.trim().toUpperCase()
  const n = g.nodes.find((n) => n.room?.toUpperCase() === q) ?? N.get(q)
  if (n) { sel = { kind: 'node', id: n.id }; zoomTo(n.x, n.y); renderSide() } else status(`No room ${q} on floor ${FLOOR}`)
}
function doUndo() { const s = undo.pop(); if (!s) return; g = JSON.parse(s); reindex(); sel = null; dirty = true; render() }
$<HTMLButtonElement>('#undo').onclick = doUndo
window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).closest('input, select')) return
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); doUndo(); return }
  const m: Record<string, Mode> = { v: 'select', c: 'connect', n: 'add', d: 'delete' }
  if (m[ev.key.toLowerCase()]) setMode(m[ev.key.toLowerCase()])
  if (ev.key === 'Escape') { connectFrom = null; sel = null; renderSide(); drawHighlight() }
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel) {
    snapshot()
    if (sel.kind === 'node') deleteNode(sel.id); else g.edges.splice(sel.i, 1)
    sel = null; dirty = true; render()
  }
})
window.addEventListener('beforeunload', (ev) => { if (dirty) ev.preventDefault() })

// ---------- save (same layout as the generator: one node/edge per line, for readable git diffs)
function serialize(): string {
  refreshLengths(g)
  g.rooms = {}
  for (const n of g.nodes) if ((n.type === 'room' || n.type === 'restroom') && n.room) g.rooms[n.room] = { node: n.id, name: n.name ?? '', floor: n.floor }
  g.pois = g.nodes.filter((n) => ['elevator', 'stairs', 'restroom'].includes(n.type)).map((n) => ({ node: n.id, type: n.type, name: n.name ?? '' }))
  const { nodes, edges, ...head } = g
  const top = JSON.stringify(head, null, 1).slice(0, -2)
  return `${top},\n "nodes": [\n${nodes.map((n) => '  ' + JSON.stringify(n)).join(',\n')}\n ],\n "edges": [\n${edges.map((e) => '  ' + JSON.stringify(e)).join(',\n')}\n ]\n}\n`
}
$<HTMLButtonElement>('#save').onclick = async () => {
  const text = serialize()
  try {
    const r = await fetch('/__novagator/save-graph', { method: 'POST', body: JSON.stringify({ floor: FLOOR, text }) })
    if (!r.ok) throw new Error(await r.text())
    dirty = false; status(`Saved to src/data/floor${FLOOR}.graph.json`)
  } catch {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    a.download = `floor${FLOOR}.graph.json`; a.click()
    dirty = false; status('Dev server not reachable, so the file was downloaded instead. Put it in src/data/.')
  }
}

// ---------- go
renderNow()
// Fit to the floor plan extent (from floorplan_frame.json), or to the graph if it reaches further.
const xs = [-48.7, 56.5, ...g.nodes.map((n) => n.x)], ys = [-18.8, 39.9, ...g.nodes.map((n) => n.y)]
requestAnimationFrame(() => fit(Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1))
new ResizeObserver(() => applyCam()).observe(stage)
