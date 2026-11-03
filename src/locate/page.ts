// Phase 4 locate page: find out where you are on floor 3, then keep tracking
// you as you walk.
//   Tier 1  "I'm at room ___"            always works
//   Tier 2  scan a room-number plaque     the main fix; also calibrates the compass
//   Tier 3  step counting + compass       between scans, kept on the hallways
// Optionally pick a destination to see the route and next instruction update
// as you go. Add ?sim to the URL to walk with the keyboard / on-screen pad
// (for testing on a computer).
import '../route/page.css'
import './page.css'
import type { NavGraph } from '../graph/types.ts'
import floor3 from '../data/floor3.graph.json'
import plaqueData from '../data/floor3.plaques.json'
import { Router, type Route } from '../route/router.ts'
import { directions, formatDistance, type Units } from '../route/directions.ts'
import { findPlace, type Place } from '../route/places.ts'
import { createFloorMap, svgEl, sx, sy } from '../ui/floormap.ts'
import { FrameVote, rgbaToGray, type Box, type Gray } from './plaque.ts'
import { createPlaqueReader, type PlaqueReader } from './ocr-browser.ts'
import { placeForRoom, type PlaqueFile } from './plaques.ts'
import { Compass, StepDetector, Tracker, wrap360 } from './tracker.ts'
import { requestSensors, watchHeading, watchMotion, type SensorState } from './sensors.ts'

const g = floor3 as NavGraph
const P = (plaqueData as PlaqueFile).plaques
const R = new Router(g)
const rooms = Object.keys(g.rooms)
const sim = new URLSearchParams(location.search).has('sim')

// ---------- saved settings
const store = {
  get(k: string) { try { return localStorage.getItem(`novagator.${k}`) } catch { return null } },
  set(k: string, v: string) { try { localStorage.setItem(`novagator.${k}`, v) } catch { /* private mode */ } },
  del(k: string) { try { localStorage.removeItem(`novagator.${k}`) } catch { /* ignore */ } },
}
const DEFAULT_STRIDE = 0.72
let stride = Number(store.get('stride')) || DEFAULT_STRIDE
let units: Units = store.get('units') === 'm' ? 'm' : 'ft'
const savedOffset = store.get('compassOffset')

// ---------- state
const tracker = new Tracker(g)
const compass = new Compass(savedOffset === null ? null : Number(savedOffset))
const steps = new StepDetector()
let sensors: SensorState | 'off' = 'off'
let lastFix: { room: string; method: 'scan' | 'manual'; door: string | null; steps: number; at: number } | null = null
let dest: Place | null = null
let route: Route | null = null
let simBearing = 0
const log: string[] = []

// ---------- layout
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header>
  <h1><b>Novagator</b> · Where am I? <span class="fl">Floor 3</span> <a href="./route.html">Routes</a></h1>
</header>
<main>
  <div id="stage">
    <svg id="map"><g id="plan"></g><g id="base"></g><g id="rt"></g><g id="marks"></g><g id="taps"></g><g id="me"></g></svg>
    <label id="plantog"><input type="checkbox" id="showplan" checked> floor plan</label>
    <button id="recenter" type="button">Center</button>
    <div id="pad" hidden>
      <button type="button" data-k="l" aria-label="Turn left">⟲</button>
      <button type="button" data-k="f" aria-label="Step forward">↑</button>
      <button type="button" data-k="r" aria-label="Turn right">⟳</button>
    </div>
  </div>
  <aside>
    <div id="banner" hidden></div>
    <div id="where">
      <div id="whereBig">Where are you?</div>
      <div id="whereSub">Scan the room-number plaque next to any door to start.</div>
    </div>
    <div class="actions">
      <button id="scanBtn" class="primary" type="button">Scan a plaque</button>
      <button id="manualBtn" type="button">I'm at room…</button>
    </div>
    <form id="manualForm" class="inline" hidden autocomplete="off">
      <input id="manualIn" type="text" inputmode="text" enterkeyhint="done" placeholder="Room number, e.g. 318" aria-label="Room you're at">
      <button>Set</button>
    </form>
    <div id="manualMsg" class="msg"></div>
    <form id="destForm" class="inline" autocomplete="off">
      <input id="destIn" type="text" enterkeyhint="go" placeholder="Where to? e.g. 356, restroom" aria-label="Destination">
      <button>Go</button>
    </form>
    <div id="destMsg" class="msg"></div>
    <div id="next" hidden><div id="nextText"></div><div id="nextSub"></div></div>
    <details id="sens">
      <summary>Sensors &amp; calibration</summary>
      <div class="kv">
        <span>Motion tracking</span><b id="kvSensors">off</b>
        <span>Steps since scan</span><b id="kvSteps">–</b>
        <span>Compass</span><b id="kvRaw">–</b>
        <span>Facing (plan)</span><b id="kvPlan">–</b>
        <span>Compass offset</span><b id="kvOffset">–</b>
        <span>Step length</span><b><input id="strideIn" type="number" step="0.01" min="0.4" max="1.1"> m</b>
      </div>
      <div class="actions small">
        <button id="sensorBtn" type="button">Turn on motion tracking</button>
        <button id="resetBtn" type="button">Reset calibration</button>
        <button id="unitBtn" type="button">Units: ft</button>
      </div>
      <ol id="log"></ol>
    </details>
  </aside>
</main>
<div id="scan" hidden>
  <video id="video" playsinline muted autoplay></video>
  <div id="box"><canvas id="hits"></canvas></div>
  <div class="scanTop">Fit the room-number plaque inside the box</div>
  <div class="scanBottom">
    <div id="scanRead">Starting camera…</div>
    <div class="row">
      <button id="scanPhoto" type="button">Use a photo</button>
      <button id="scanCancel" type="button">Cancel</button>
    </div>
  </div>
  <input id="photoIn" type="file" accept="image/*" hidden>
</div>`
const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!
const svg = $<SVGSVGElement>('#map')
const fm = createFloorMap(svg, g, { floor: '3', planToggle: $<HTMLElement>('#plantog'), planCheckbox: $<HTMLInputElement>('#showplan') })

function note(msg: string) {
  log.unshift(`${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}  ${msg}`)
  log.length = Math.min(log.length, 12)
  $('#log').innerHTML = log.map((l) => `<li>${l.replace(/</g, '&lt;')}</li>`).join('')
}

// ---------- fixing your position (tiers 1 and 2)
function setFix(room: string, method: 'scan' | 'manual') {
  const place = placeForRoom(g, P, room)
  if (!place) return false
  let calibrated = false
  if (method === 'scan' && place.bearing !== null) {
    const off = compass.calibrate(place.bearing)
    if (off !== null) { store.set('compassOffset', off.toFixed(1)); calibrated = true }
  }
  // Learn your step length from walking between two scanned plaques.
  if (method === 'scan' && lastFix?.method === 'scan' && lastFix.door && place.plaque && lastFix.room !== room) {
    const n = steps.steps - lastFix.steps
    const r = R.route(lastFix.door, place.plaque.door)
    if (r && n >= 12) {
      const est = r.length / n
      if (est > 0.45 && est < 0.95 && Math.abs(est / stride - 1) < 0.35) {
        stride = +(0.6 * stride + 0.4 * est).toFixed(3)
        store.set('stride', String(stride))
        note(`Step length → ${stride.toFixed(2)} m (${n} steps over ${r.length.toFixed(1)} m)`)
      }
    }
  }
  // Simulation: after reading a plaque, turn to face along the hallway.
  if (sim) simBearing = place.bearing === null ? simBearing : wrap360(place.bearing + 90)
  tracker.fix(place.x, place.y, compass.bearing ?? place.bearing)
  lastFix = { room, method, door: place.plaque?.door ?? null, steps: steps.steps, at: Date.now() }
  note(`${method === 'scan' ? 'Scanned' : 'Set'} ${room}${calibrated ? ` · compass offset ${compass.offset!.toFixed(0)}°` : ''}`)
  navigator.vibrate?.(60)
  fm.centerOn(tracker.pose!, 40)
  update()
  return true
}

// ---------- tracking (tier 3)
function onStep() {
  if (!tracker.pose) return
  const b = sim ? simBearing : compass.bearing
  if (b === null) { update(); return }
  tracker.step(b, stride)
  update()
}

async function startSensors(): Promise<SensorState> {
  if (sensors === 'granted') return sensors
  sensors = await requestSensors()
  if (sensors === 'granted') {
    watchHeading((deg) => { compass.push(deg); scheduleHeadingDraw() })
    watchMotion((t, x, y, z) => { if (steps.push(t, x, y, z)) onStep() })
    note('Motion tracking on')
  } else note(sensors === 'denied' ? 'Motion access was refused. Reload to ask again.' : 'This device has no motion sensors.')
  renderSensors()
  return sensors
}

let headingQueued = false
function scheduleHeadingDraw() {
  if (headingQueued) return
  headingQueued = true
  requestAnimationFrame(() => { headingQueued = false; drawMe(); renderSensors() })
}

// ---------- drawing
const nearestRoomLabel = () => {
  const p = tracker.pose
  if (!p) return null
  let best: { room: string; d: number } | null = null
  for (const pl of P) {
    const d = Math.hypot(pl.stand.x - p.x, pl.stand.y - p.y)
    if (!best || d < best.d) best = { room: pl.room, d }
  }
  return best && best.d < 8 ? best.room : null
}

function drawMe() {
  const me = $('#me'); me.innerHTML = ''
  const p = tracker.pose
  if (!p) return
  const acc = Math.min(8, 1 + tracker.sinceFix * 0.08)
  svgEl('circle', { class: 'acc', cx: sx(p), cy: sy(p), r: acc }, me)
  const b = sim ? simBearing : compass.bearing
  if (b !== null) {
    const w = svgEl('g', { transform: `translate(${sx(p)} ${sy(p)}) rotate(${b})` }, me)
    svgEl('path', { class: 'cone', d: 'M0 0 L-2.2 -4.2 A4.7 4.7 0 0 1 2.2 -4.2 Z' }, w)
  }
  svgEl('circle', { class: 'dot', cx: sx(p), cy: sy(p), r: 0.75 }, me)
}

function drawRoute() {
  const rt = $('#rt'), marks = $('#marks')
  rt.innerHTML = ''; marks.innerHTML = ''
  if (!route) return
  const pts = [tracker.pose!, ...route.nodes.slice(1).map((id) => R.nodes.get(id)!)]
  const d = pts.map((n, i) => `${i ? 'L' : 'M'}${sx(n)},${sy(n)}`).join('')
  svgEl('path', { class: 'route-casing', d }, rt)
  svgEl('path', { class: 'route', d }, rt)
  const b = R.nodes.get(route.nodes[route.nodes.length - 1])!
  const pin = svgEl('g', { transform: `translate(${sx(b)} ${sy(b)})` }, marks)
  svgEl('path', { transform: 'scale(.7)', d: 'M0 0c-.9-1.3-2-2.4-2-3.6a2 2 0 0 1 4 0c0 1.2-1.1 2.3-2 3.6z', fill: '#dc2626', stroke: '#fff', 'stroke-width': 0.25 }, pin)
  svgEl('circle', { cx: 0, cy: -2.52, r: 0.5, fill: '#fff' }, pin)
}

function update() {
  const p = tracker.pose
  const big = $('#whereBig'), sub = $('#whereSub'), banner = $<HTMLDivElement>('#banner')
  if (!p || !lastFix) {
    big.textContent = 'Where are you?'
    sub.textContent = 'Scan the room-number plaque next to any door to start.'
  } else {
    const near = nearestRoomLabel()
    big.textContent = near ? `Near Room ${near}` : 'In the hallway'
    const ago = tracker.sinceFix < 1 ? 'just now' : `${formatDistance(tracker.sinceFix, units)} ago`
    const how = lastFix.method === 'scan' ? 'Scanned' : 'Set at'
    const tracking = sensors === 'granted' || sim
      ? (compass.bearing === null && !sim ? ' · scan a plaque to calibrate the compass' : '')
      : ' · motion tracking is off'
    sub.textContent = `${how} ${lastFix.room} ${ago}${tracking}`
  }
  const stale = !!p && tracker.sinceFix > 30
  banner.hidden = !stale
  if (stale) banner.textContent = 'Scan the next plaque you pass to stay accurate.'

  // route from here
  route = null
  const next = $<HTMLDivElement>('#next')
  if (dest && p) {
    const start = tracker.nearestNode()!
    route = R.route(start, dest.nodes)
    tracker.setRoute(route?.nodes ?? null)
    if (route) {
      const end = R.nodes.get(route.nodes[route.nodes.length - 1])!
      const left = Math.hypot(end.x - p.x, end.y - p.y) < 3 ? 0 : route.length
      next.hidden = false
      if (left === 0) {
        $('#nextText').textContent = `You've arrived at ${dest.label}.`
        $('#nextSub').textContent = ''
      } else {
        const D = directions(R, route, 'here', dest.label, units)
        const step = D.steps.find((s) => s.icon !== 'start') ?? D.steps[0]
        $('#nextText').textContent = step.text
        $('#nextSub').textContent = `${D.summary} to ${dest.label}`
      }
    } else { next.hidden = true; $('#destMsg').textContent = `No route to ${dest.label} from here.` }
  } else {
    tracker.setRoute(null)
    next.hidden = true
  }
  drawRoute()
  drawMe()
  renderSensors()
  if (p && !fm.userMoved) fm.centerOn(p)
}

function renderSensors() {
  $('#kvSensors').textContent = sim ? 'simulated (keyboard)' : sensors === 'granted' ? 'on' : sensors
  $('#kvSteps').textContent = lastFix ? String(steps.steps - lastFix.steps) : '–'
  const raw = compass.raw
  $('#kvRaw').textContent = raw === null ? '–' : `${raw.toFixed(0)}°`
  const pb = sim ? simBearing : compass.bearing
  $('#kvPlan').textContent = pb === null ? 'not calibrated' : `${pb.toFixed(0)}° ${'N NE E SE S SW W NW'.split(' ')[Math.round(pb / 45) % 8]}`
  $('#kvOffset').textContent = compass.offset === null ? 'not set' : `${compass.offset.toFixed(0)}°`
  const si = $<HTMLInputElement>('#strideIn')
  if (document.activeElement !== si) si.value = stride.toFixed(2)
  $<HTMLButtonElement>('#sensorBtn').hidden = sensors === 'granted' || sim
  $('#unitBtn').textContent = `Units: ${units}`
}

// ---------- scanning (tier 2)
let reader: PlaqueReader | null = null
let readerLoading: Promise<PlaqueReader> | null = null
let stream: MediaStream | null = null
let scanning = false
const vote = new FrameVote(2, 3)
const video = $<HTMLVideoElement>('#video')
const frameCanvas = document.createElement('canvas')
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true })!
const FRAME_W = 720

function getReader(): Promise<PlaqueReader> {
  if (reader) return Promise.resolve(reader)
  readerLoading ??= createPlaqueReader(rooms, (p, status) => {
    if (scanning && /load|init/i.test(status)) $('#scanRead').textContent = `Loading the text reader… ${Math.round(p * 100)}%`
  }).then((r) => (reader = r))
  return readerLoading
}

async function openScan() {
  // Sensor permission has to be asked inside this tap on iPhone, and the
  // compass needs to be running when the plaque is read.
  if (!sim) void startSensors()
  $<HTMLDivElement>('#scan').hidden = false
  scanning = true
  vote.reset()
  $('#scanRead').textContent = 'Starting camera…'
  const readerP = getReader()
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
    video.srcObject = stream
    await video.play()
  } catch {
    $('#scanRead').textContent = 'Camera unavailable. Use a photo instead, or Cancel and type the room.'
    return
  }
  await readerP
  if (scanning) loop()
}

function closeScan() {
  scanning = false
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  video.srcObject = null
  $<HTMLDivElement>('#scan').hidden = true
  clearHits()
}

/** The on-screen box, in video pixels. The video fills the screen
 *  (object-fit: cover), so undo that scaling. */
function boxInVideo(): { x: number; y: number; w: number; h: number } | null {
  const vw = video.videoWidth, vh = video.videoHeight
  if (!vw || !vh) return null
  const vr = video.getBoundingClientRect(), br = $('#box').getBoundingClientRect()
  const s = Math.max(vr.width / vw, vr.height / vh)
  const ox = (vr.width - vw * s) / 2, oy = (vr.height - vh * s) / 2
  return { x: (br.left - vr.left - ox) / s, y: (br.top - vr.top - oy) / s, w: br.width / s, h: br.height / s }
}

function grabGray(src: CanvasImageSource, sx0: number, sy0: number, sw: number, sh: number): Gray {
  const w = FRAME_W, h = Math.round((FRAME_W * sh) / sw)
  frameCanvas.width = w; frameCanvas.height = h
  frameCtx.drawImage(src, sx0, sy0, sw, sh, 0, 0, w, h)
  return rgbaToGray(frameCtx.getImageData(0, 0, w, h).data, w, h)
}

function drawHit(line: Box | null, frame: Gray, ok: boolean) {
  const c = $<HTMLCanvasElement>('#hits'), br = $('#box').getBoundingClientRect()
  c.width = br.width; c.height = br.height
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, c.width, c.height)
  if (!line) return
  const k = br.width / frame.w
  ctx.strokeStyle = ok ? '#22c55e' : '#facc15'
  ctx.lineWidth = 3
  ctx.strokeRect((line.x0 - 6) * k, (line.y0 - 6) * k, (line.x1 - line.x0 + 12) * k, (line.y1 - line.y0 + 12) * k)
}
const clearHits = () => { const c = $<HTMLCanvasElement>('#hits'); c.getContext('2d')?.clearRect(0, 0, c.width, c.height) }

// Always hand control back to the browser between frames. A frame with no
// number in it is read without any real waiting, and without this pause the
// loop would spin forever: taps, the camera preview and Cancel all freeze.
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
const FRAME_GAP_MS = 120

async function loop() {
  while (scanning && reader) {
    await pause(FRAME_GAP_MS)
    if (!scanning) break
    const b = boxInVideo()
    if (!b) continue
    const frame = grabGray(video, b.x, b.y, b.w, b.h)
    const res = await reader.read(frame)
    if (!scanning) break
    const agreed = vote.push(res.room)
    drawHit(res.line, frame, !!res.room)
    $('#scanRead').textContent = res.room ? `Reading ${res.room}…` : res.line ? 'Hold steady…' : 'Looking for a room number…'
    if (agreed) { closeScan(); setFix(agreed, 'scan'); return }
  }
}

async function readPhoto(file: File) {
  $('#scanRead').textContent = 'Reading the photo…'
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const r = await getReader()
  const frame = grabGray(img, 0, 0, img.width, img.height)
  const res = await r.read(frame)
  if (res.room) { closeScan(); setFix(res.room, 'scan'); note('(from a photo: compass calibrated to the moment you picked it)') }
  else $('#scanRead').textContent = `Couldn't read a room number in that photo${res.readings.length ? ` (saw "${res.readings.slice(0, 2).join('", "')}")` : ''}. Try again, or Cancel and type the room.`
}

// ---------- controls
$('#scanBtn').addEventListener('click', openScan)
$('#scanCancel').addEventListener('click', closeScan)
$('#scanPhoto').addEventListener('click', () => $<HTMLInputElement>('#photoIn').click())
$<HTMLInputElement>('#photoIn').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) void readPhoto(f)
  ;(e.target as HTMLInputElement).value = ''
})
$('#manualBtn').addEventListener('click', () => {
  if (!sim) void startSensors()
  const f = $<HTMLFormElement>('#manualForm')
  f.hidden = !f.hidden
  if (!f.hidden) $<HTMLInputElement>('#manualIn').focus()
})
$<HTMLFormElement>('#manualForm').addEventListener('submit', (e) => {
  e.preventDefault()
  const txt = $<HTMLInputElement>('#manualIn').value
  const hit = findPlace(g, txt)
  const msg = $('#manualMsg')
  if (!hit.ok || hit.place.nodes.length !== 1 || !/^\d/.test(hit.place.short)) {
    msg.textContent = hit.ok ? 'Enter one room number.' : `${hit.error}${hit.suggestions.length ? ` Did you mean ${hit.suggestions.slice(0, 3).join(', ')}?` : ''}`
    return
  }
  msg.textContent = ''
  setFix(hit.place.short, 'manual')
  $<HTMLFormElement>('#manualForm').hidden = true
  $<HTMLInputElement>('#manualIn').blur()
})
$<HTMLFormElement>('#destForm').addEventListener('submit', (e) => {
  e.preventDefault()
  const txt = $<HTMLInputElement>('#destIn').value.trim()
  const msg = $('#destMsg')
  if (!txt) { dest = null; msg.textContent = ''; update(); return }
  const hit = findPlace(g, txt)
  if (!hit.ok) { msg.textContent = `${hit.error}${hit.suggestions.length ? ` Did you mean ${hit.suggestions.slice(0, 3).join(', ')}?` : ''}`; return }
  dest = hit.place
  msg.textContent = tracker.pose ? '' : 'Now scan a plaque so I know where you are.'
  $<HTMLInputElement>('#destIn').blur()
  update()
  if (tracker.pose && route) fm.fitPoints([tracker.pose, ...route.nodes.map((id) => R.nodes.get(id)!)], 5)
})
$('#sensorBtn').addEventListener('click', () => void startSensors())
$('#resetBtn').addEventListener('click', () => {
  stride = DEFAULT_STRIDE; compass.offset = null
  store.del('stride'); store.del('compassOffset')
  note('Calibration reset')
  update()
})
$('#unitBtn').addEventListener('click', () => { units = units === 'ft' ? 'm' : 'ft'; store.set('units', units); update() })
$<HTMLInputElement>('#strideIn').addEventListener('change', (e) => {
  const v = Number((e.target as HTMLInputElement).value)
  if (v >= 0.4 && v <= 1.1) { stride = v; store.set('stride', String(v)); note(`Step length set to ${v.toFixed(2)} m`) }
  renderSensors()
})
$('#recenter').addEventListener('click', () => { if (tracker.pose) fm.centerOn(tracker.pose, 40); else fm.fitAll() })

// ---------- simulation (?sim): arrows / pad walk the dot around
if (sim) {
  $<HTMLDivElement>('#pad').hidden = false
  const act = (k: string) => {
    if (k === 'l') simBearing = wrap360(simBearing - 15)
    else if (k === 'r') simBearing = wrap360(simBearing + 15)
    else if (k === 'f') { steps.steps++; onStep() }
    if (k !== 'f') update()
  }
  $('#pad').addEventListener('click', (e) => { const k = (e.target as HTMLElement).dataset.k; if (k) act(k) })
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const k = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'f' }[e.key]
    if (k) { e.preventDefault(); act(k) }
  })
  note('Simulation: ← → turn 15°, ↑ takes a step')
}

// ---------- go
requestAnimationFrame(() => { fm.fitAll(); update() })
new ResizeObserver(() => { if (tracker.pose) fm.centerOn(tracker.pose); else fm.fitAll() }).observe($('#stage'))
