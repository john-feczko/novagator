# Novagator

Indoor navigation web app for a large Villanova class building. Scan a room-number plaque to find where you are, pick a destination, and follow on-screen directions to get there.

**Live:** https://novagator.vercel.app

## Stack

- TypeScript + Vite (vanilla, no framework)
- Hosted on Vercel; every push to `main` redeploys
- Target device: iPhone 16 Pro (Safari)

## Run locally

```bash
npm install
npm run dev
```

The camera and motion sensors only work over HTTPS. To test them on a phone, use the Vercel deployment, not the local dev server.

## Roadmap status

| Phase | Status |
|---|---|
| 0: Decisions and setup | ✅ Done (floor plans requested from facilities) |
| 1: Data capture | Next |
| 2: Map model / nav graph | — |
| 3: Routing | — |
| 4: Localization | — |
| 5: UI | — |
| 6: Testing and evaluation | — |
| 7: Stretch goals | — |

## Phase 0 results (2026-09-30)

Tested on an iPhone 16 Pro in Safari, using the capability test page (`src/main.ts`).

| Check | Result | Implication |
|---|---|---|
| Secure context (HTTPS) | Yes | Camera and sensor access allowed |
| WebXR (`navigator.xr`) | Not present | No WebXR at all in iOS Safari |
| `immersive-ar` session | Not supported | Can't anchor graphics to the floor from the web |
| Motion + orientation permission | Granted (tap-to-allow flow works) | Sensors available after a user gesture |
| Accelerometer | 9.71 m/s² at rest (≈1 g), 60 Hz | Suitable for step detection |
| Compass (`webkitCompassHeading`) | Live, 60 Hz | Heading available for the direction arrow; expect drift near metal |
| Rear camera | 1080×1920 @ 30 fps | Enough resolution for plaque OCR |
| Native ARKit (Apple Measure app) | A bit finicky, but seems to work | Determines whether native AR footprints are viable later |

### Architecture decision

- **MVP (web):** live camera view with a direction arrow, minimap, and turn-by-turn steps. Location comes from room-plaque OCR (Tesseract.js) plus step counting snapped to the navigation graph.
- **Stretch (native):** true floor-anchored AR footprints using ARKit, built through a cloud macOS build service, since development is on Windows.