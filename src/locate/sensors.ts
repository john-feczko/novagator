// Phone sensors for tracking: compass heading and accelerometer.
// iPhone Safari only hands these out after the user taps something and agrees,
// so call requestSensors() from a button's click handler.

type PermissionFn = () => Promise<'granted' | 'denied'>
const needsPermission = (C: unknown): C is { requestPermission: PermissionFn } =>
  typeof C === 'function' && typeof (C as { requestPermission?: unknown }).requestPermission === 'function'

export type SensorState = 'granted' | 'denied' | 'unsupported'

/** Ask for motion + orientation access. Must run inside a tap handler on iOS. */
export async function requestSensors(): Promise<SensorState> {
  if (typeof DeviceMotionEvent === 'undefined' && typeof DeviceOrientationEvent === 'undefined') return 'unsupported'
  try {
    const asks: Promise<'granted' | 'denied'>[] = []
    if (needsPermission(DeviceOrientationEvent)) asks.push(DeviceOrientationEvent.requestPermission())
    if (needsPermission(DeviceMotionEvent)) asks.push(DeviceMotionEvent.requestPermission())
    const res = await Promise.all(asks)
    return res.every((r) => r === 'granted') ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}

/** Compass heading in degrees clockwise from magnetic north, for the way the
 *  back camera points. iOS gives this directly (webkitCompassHeading);
 *  Android gives an absolute alpha. Returns a stop function. */
export function watchHeading(cb: (deg: number, accuracy: number | null) => void): () => void {
  const onIOS = (e: DeviceOrientationEvent) => {
    const w = e as DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number }
    if (typeof w.webkitCompassHeading === 'number' && !Number.isNaN(w.webkitCompassHeading))
      cb(w.webkitCompassHeading, typeof w.webkitCompassAccuracy === 'number' ? w.webkitCompassAccuracy : null)
  }
  const onAbs = (e: DeviceOrientationEvent) => {
    if (e.absolute && typeof e.alpha === 'number') cb((360 - e.alpha) % 360, null)
  }
  window.addEventListener('deviceorientation', onIOS)
  window.addEventListener('deviceorientationabsolute' as 'deviceorientation', onAbs)
  return () => {
    window.removeEventListener('deviceorientation', onIOS)
    window.removeEventListener('deviceorientationabsolute' as 'deviceorientation', onAbs)
  }
}

/** Acceleration including gravity, m/s². Returns a stop function. */
export function watchMotion(cb: (tMs: number, ax: number, ay: number, az: number) => void): () => void {
  const on = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity
    if (a && a.x !== null && a.y !== null && a.z !== null) cb(e.timeStamp, a.x, a.y, a.z)
  }
  window.addEventListener('devicemotion', on)
  return () => window.removeEventListener('devicemotion', on)
}
