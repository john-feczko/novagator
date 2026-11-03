// Floor map shared by the route page and the locate page: hallways and rooms
// drawn from the graph, the facilities plan underneath when running
// `npm run dev` (it lives in private/ and never ships), and pan / zoom / pinch.
//
// The page supplies the <svg> with these groups, in this order:
//   #plan #base #rt #marks #taps  (+ any of its own, e.g. #me)
import type { GraphNode, NavGraph } from '../graph/types.ts'

export const NS = 'http://www.w3.org/2000/svg'
export const svgEl = (tag: string, attrs: Record<string, string | number>, parent?: Element) => {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  parent?.appendChild(e)
  return e
}
// world (x right, y up) → svg (y down)
export const sx = (n: { x: number }) => n.x
export const sy = (n: { y: number }) => -n.y

export interface FloorMap {
  fitTo(x0: number, y0: number, x1: number, y1: number, pad?: number): void
  fitAll(): void
  /** Fit world points (x right, y up). */
  fitPoints(pts: { x: number; y: number }[], pad?: number): void
  /** Center on a world point without changing zoom (unless `width` is given, in meters). */
  centerOn(p: { x: number; y: number }, width?: number): void
  /** True if the user has panned or zoomed since the last fit/center call. */
  readonly userMoved: boolean
}

export function createFloorMap(svg: SVGSVGElement, g: NavGraph, opts: { floor: string; onTapRoom?: (n: GraphNode) => void; planToggle?: HTMLElement; planCheckbox?: HTMLInputElement }): FloorMap {
  const q = <T extends Element>(s: string) => svg.querySelector<T>(s)!
  const nodes = new Map(g.nodes.map((n) => [n.id, n]))

  // ---------- base map, drawn from the graph itself
  const base = q('#base'), taps = q('#taps')
  const hall = svgEl('path', { class: 'hall', 'stroke-width': 2.4, d: '' }, base)
  let d = ''
  for (const e of g.edges) {
    const a = nodes.get(e.a)!, b = nodes.get(e.b)!
    if (e.kind === 'corridor') d += `M${sx(a)},${sy(a)}L${sx(b)},${sy(b)}`
    else svgEl('line', { class: 'link', x1: sx(a), y1: sy(a), x2: sx(b), y2: sy(b) }, base)
  }
  hall.setAttribute('d', d)
  const POI: Partial<Record<GraphNode['type'], [string, string]>> = { elevator: ['#7c3aed', 'E'], stairs: ['#ea580c', 'S'], restroom: ['#0891b2', 'WC'] }
  for (const n of g.nodes) {
    const poi = POI[n.type]
    if (poi) {
      const grp = svgEl('g', { class: 'poi' }, base)
      svgEl('circle', { cx: sx(n), cy: sy(n), r: 0.85, fill: poi[0] }, grp)
      svgEl('text', { x: sx(n), y: sy(n), style: poi[1].length > 1 ? 'font-size:.6px' : '' }, grp).textContent = poi[1]
    } else if (n.type === 'room') {
      svgEl('circle', { class: 'room', cx: sx(n), cy: sy(n), r: 0.3, 'data-id': n.id }, base)
      svgEl('text', { class: 'rlabel', x: sx(n), y: sy(n) - 0.55 }, base).textContent = n.room ?? ''
    }
    if (n.room && opts.onTapRoom) {
      const t = svgEl('circle', { class: 'tap', cx: sx(n), cy: sy(n), r: 1.3 }, taps)
      t.addEventListener('click', () => opts.onTapRoom!(n))
    }
  }

  // ---------- plan underlay: dev server only
  fetch(`/private/floorplans/Drosdick_${opts.floor}_floor.svg`).then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('svg') ? r.text() : Promise.reject())).then((txt) => {
    const map = new DOMParser().parseFromString(txt, 'image/svg+xml').querySelector('#map')
    if (!map) return
    const plan = q('#plan')
    plan.appendChild(document.importNode(map, true))
    plan.querySelectorAll('path, line, polyline').forEach((e) => e.setAttribute('vector-effect', 'non-scaling-stroke'))
    for (const [id, w] of [['walls', '1.3'], ['doors', '0.6'], ['detail', '0.4'], ['labels', '0.4'], ['misc', '0.4']])
      plan.querySelector(`#${id}`)?.setAttribute('stroke-width', w)
    plan.querySelector('#labels')?.setAttribute('style', 'display:none')
    if (opts.planToggle) opts.planToggle.style.display = 'block'
    svg.classList.add('plan-on')
  }).catch(() => { /* deployed site: no plan, the graph map is enough */ })
  opts.planCheckbox?.addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked
    q<SVGGElement>('#plan').style.display = on ? '' : 'none'
    svg.classList.toggle('plan-on', on)
  })

  // ---------- camera: viewBox pan / zoom / pinch
  let vb = { x: -50, y: -40, w: 108, h: 60 }
  let moved = false
  const setVB = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`)
  function fitTo(x0: number, y0: number, x1: number, y1: number, pad = 3) {
    const r = svg.getBoundingClientRect()
    const w = x1 - x0 + 2 * pad, h = y1 - y0 + 2 * pad
    const s = Math.max(w / Math.max(r.width, 1), h / Math.max(r.height, 1))
    vb = { w: r.width * s, h: r.height * s, x: (x0 + x1) / 2 - (r.width * s) / 2, y: (y0 + y1) / 2 - (r.height * s) / 2 }
    moved = false
    setVB()
  }
  function fitPoints(pts: { x: number; y: number }[], pad = 6) {
    const xs = pts.map(sx), ys = pts.map(sy)
    fitTo(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), pad)
  }
  const fitAll = () => fitPoints(g.nodes, 2)
  function centerOn(p: { x: number; y: number }, width?: number) {
    const r = svg.getBoundingClientRect()
    if (width) vb = { ...vb, w: width, h: (width * Math.max(r.height, 1)) / Math.max(r.width, 1) }
    vb.x = sx(p) - vb.w / 2; vb.y = sy(p) - vb.h / 2
    moved = false
    setVB()
  }
  const toSvg = (cx: number, cy: number) => {
    const r = svg.getBoundingClientRect()
    return { x: vb.x + ((cx - r.left) / r.width) * vb.w, y: vb.y + ((cy - r.top) / r.height) * vb.h }
  }
  function zoomAt(cx: number, cy: number, f: number) {
    const p = toSvg(cx, cy)
    const w = Math.min(Math.max(vb.w * f, 8), 400), k = w / vb.w
    vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w, h: vb.h * k }
    moved = true
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
      moved = true
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

  return { fitTo, fitAll, fitPoints, centerOn, get userMoved() { return moved } }
}
