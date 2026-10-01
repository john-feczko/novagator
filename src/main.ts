// Novagator — Phase 0 "hello camera" + device capability check
// Replaces src/main.ts in a Vite vanilla-ts project.
import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <video id="cam" autoplay playsinline muted></video>
  <div id="hud">
    <h1>Novagator · Phase 0</h1>
    <button id="start">Start camera + sensors</button>
    <pre id="log">Checking…</pre>
  </div>
`

const video = document.querySelector<HTMLVideoElement>('#cam')!
const btn = document.querySelector<HTMLButtonElement>('#start')!
const logEl = document.querySelector<HTMLPreElement>('#log')!

// Keyed status lines, re-rendered a few times per second
const status: Record<string, string> = {}
const set = (k: string, v: string) => { status[k] = v }
setInterval(() => {
  logEl.textContent = Object.entries(status).map(([k, v]) => `${k}: ${v}`).join('\n')
}, 200)

// ---- Checks that run on page load ----
set('Secure context (HTTPS)', window.isSecureContext ? 'YES' : 'NO — camera/sensors will be blocked')

async function checkWebXR() {
  const xr = (navigator as any).xr
  if (!xr) {
    set('WebXR (navigator.xr)', 'not present')
    set('immersive-ar', 'NOT supported')
    return
  }
  set('WebXR (navigator.xr)', 'present')
  try {
    set('immersive-ar', (await xr.isSessionSupported('immersive-ar')) ? 'SUPPORTED' : 'NOT supported')
    set('immersive-vr', (await xr.isSessionSupported('immersive-vr')) ? 'supported' : 'not supported')
  } catch (e) {
    set('immersive-ar', `error: ${(e as Error).message}`)
  }
}
checkWebXR()

// ---- Checks that need a tap (iOS requires a user gesture) ----
btn.addEventListener('click', async () => {
  btn.disabled = true

  // 1) Motion/orientation permission — request FIRST, while the tap gesture is still fresh
  const DOE = DeviceOrientationEvent as any
  const DME = DeviceMotionEvent as any
  const perms: Promise<string>[] = []
  if (typeof DOE.requestPermission === 'function') perms.push(DOE.requestPermission())
  if (typeof DME.requestPermission === 'function') perms.push(DME.requestPermission())

  try {
    const results = await Promise.all(perms)
    set('Motion permission', results.length ? results.join(', ') : 'not required on this browser')
    if (results.every(r => r === 'granted')) startSensors()
  } catch (e) {
    set('Motion permission', `error: ${(e as Error).message}`)
  }

  // 2) Rear camera
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    })
    video.srcObject = stream
    await video.play()
    const s = stream.getVideoTracks()[0].getSettings()
    set('Camera', `OK — ${s.width}×${s.height} @ ${s.frameRate ?? '?'} fps, facing ${s.facingMode ?? '?'}`)
  } catch (e) {
    set('Camera', `FAILED — ${(e as Error).name}: ${(e as Error).message}`)
  }
})

function startSensors() {
  let orientCount = 0
  let motionCount = 0

  window.addEventListener('deviceorientation', (e: any) => {
    orientCount++
    const heading = e.webkitCompassHeading
    set('Compass heading', heading != null ? `${heading.toFixed(0)}°` : 'unavailable')
    set('Tilt (beta/gamma)', `${e.beta?.toFixed(0)}° / ${e.gamma?.toFixed(0)}°`)
  })

  window.addEventListener('devicemotion', (e) => {
    motionCount++
    const a = e.accelerationIncludingGravity
    if (a && a.x != null && a.y != null && a.z != null) {
      set('Accel |g|', `${Math.hypot(a.x, a.y, a.z).toFixed(2)} m/s²`)
    }
  })

  // Event rates — step detection in Phase 4 wants ~50–60 Hz motion
  setInterval(() => {
    set('Orientation rate', `${orientCount} Hz`)
    set('Motion rate', `${motionCount} Hz`)
    orientCount = 0
    motionCount = 0
  }, 1000)
}