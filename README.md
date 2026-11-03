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
| 1: Data capture | Floor 3 done (all 119 rooms logged); other floors next |
| 2: Map model / nav graph | Floor 3 graph generated; being checked in the editor |
| 3: Routing | — |
| 4: Localization | — |
| 5: UI | — |
| 6: Testing and evaluation | — |
| 7: Stretch goals | — |

## Phase 2: navigation graph (floor 3)

`src/data/floor3.graph.json` is the floor 3 navigation graph: 755 nodes and 858 edges, in meters in the shared building frame (origin at the Stair 1 inner corner, x right, y up on the plan sheet).

- **Nodes:** `corridor` (points on hallway centerlines), `door`, `room` / `restroom` (destinations, keyed by room number), `space` (unnumbered vestibules and suite hallways), `elevator`, `stairs`.
- **Edges:** `corridor` (along a hallway), `doorway` (hallway to door), `room` (door to room interior). Edges on stairs carry `stairs: true`.
- **Lookups:** `rooms` (room number to node) and `pois` (elevators, stairs, restrooms).
- Anything marked `inferred: true` was guessed by the generator and needs checking. The `todo` list says why.

It was generated from the floor plan's wall and door layers: walkable areas were split into rooms and corridors, door symbols became the connections between them, and corridor centerlines became the hallway edges.

### Editing the graph

```bash
npm run dev
```

Then open http://localhost:5173/graph.html. It draws the graph over the floor plan. The plan is loaded from `private/floorplans/` by the dev server only, so it never gets deployed.

- **Select / move (V):** click a node or edge to see and edit it; drag a node to move it.
- **Connect (C):** click two nodes to join them; keep clicking to chain.
- **Add node (N):** pick a type, then click. A corridor node clicked onto an edge splits that edge.
- **Delete (D)**, the Delete key, Undo (Ctrl+Z), and room search.
- **Save** writes back to `src/data/floor3.graph.json`, one node or edge per line so git diffs stay readable.

The side panel lists problems (anything unreachable) and every guessed item to check.

### Tests

```bash
npm test
```

This checks that the graph has no broken edges, that edge lengths match their endpoints, and that every floor 3 room is reachable.

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