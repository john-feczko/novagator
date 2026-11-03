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
| 2: Map model / nav graph | ✅ Floor 3 graph done and checked in the editor; other floors next |
| 3: Routing | ✅ Floor 3: routing, directions, tests, route page. Directions still to be walked on site |
| 4: Localization | ✅ Floor 3: plaque reading (98.5% on the photo set, no wrong rooms), manual entry, step + compass tracking, locate page. To be walked on site |
| 5: UI | — |
| 6: Testing and evaluation | — |
| 7: Stretch goals | — |

## Phase 4: localization (floor 3)

Try it: open https://novagator.vercel.app/locate.html on the iPhone (camera and motion sensors need HTTPS). On a computer, `npm run dev` and open http://localhost:5173/locate.html?sim. In sim mode, ← → turn and ↑ takes a step, and "Use a photo" scans a plaque photo instead of using the camera.

How it finds you, from most to least reliable:
1. **Scan a plaque.** Fit the plaque in the on-screen box, and it reads continuously until 2 of 3 frames agree. Scanning also calibrates the compass: you're facing the wall, and the plaque database knows which way that wall faces.
2. **"I'm at room ___".** Always available as a fallback.
3. **Tracking between scans.** Steps come from the accelerometer and direction from the compass, and the dot is kept on the hallways. At every turn it snaps to the nearest junction with a branch in your new direction, which also cancels distance drift. After 30 m without a scan it asks you to scan the next plaque you pass.
4. **Step length calibrates itself.** Each time you walk between two scanned plaques, the hallway distance divided by the steps counted adjusts it.

Pick a destination and the route and next instruction update as you walk.

Plaque reading (`src/locate/plaque.ts`) works the same way on every plaque style on floor 3: square name plates, wide signs, and the paper printouts on 312/314.
1. Adaptive threshold, which copes with shadows from raised letters.
2. Find the tallest line of 2–6 glyph-sized blobs; that's the room number.
3. Blank everything except those glyphs, which stops plaque edges being read as a "1".
4. Straighten the line, then read it with Tesseract at 4 crop sizes.
5. Vote, then fuzzy-match against the room list using a look-alike table (8/B, 0/D, 5/S, 1/I…). If a glyph is missing or two rooms are equally close, it gives no answer rather than a guess.

Tesseract runs from this site, not a CDN. It's about 7 MB on the first scan and cached on the phone after that.

Data: `src/data/floor3.plaques.json` lists 85 plaques: which door each one hangs beside and which way it faces. It's built from `private/plaques/floor3/manifest.csv` by `npm run build-plaques`. Plaques the builder wasn't sure about have a `check` note (8 of them: two-door rooms and suite offices).

Measuring:
- `npm run ocr-eval` reads every photo in `private/plaques/floor3/`, as taken and distorted (dim, tilted ±10°, blurred, farther away, off-center). Latest run, 581 frames: 98.5% correct, **0 wrong rooms**, 9 with no answer (the app just reads the next frame).
- `npm test` adds `src/locate/locate.test.ts`: room matching, frame voting, plaque data, step counting on a simulated walk, compass calibration, and 300 simulated 5–40 m walks with ±12° compass noise:

| Case | Within 3 m | Median error |
|---|---|---|
| Navigating, step length calibrated | 95% | 0.0 m |
| Navigating, step length ±10% | 88% | 0.1 m |
| No route, step length ±10% | 86% | 0.2 m |

Code in `src/locate/`: `plaque.ts` (image + matching), `ocr-browser.ts` (Tesseract worker), `plaques.ts` (plaque positions), `tracker.ts` (steps, compass, map matching), `sensors.ts` (iPhone permission + events), `page.ts` (the locate page). The map drawing shared with the route page moved to `src/ui/floormap.ts`.

## Phase 3: routing (floor 3)

Try it: `npm run dev`, then open http://localhost:5173/route.html (or https://novagator.vercel.app/route.html). Type `from 301 to 318`, or tap a room for the start and another for the destination. Running locally draws the floor plan underneath; the deployed page draws the map from the graph only, so the plans stay private. The URL keeps the query (`?q=...&mode=...`), so a route can be shared as a link.

What you can type:
- Room numbers: `318`, `Room 318`, `rm 3-18`, `309a`
- Room names: `staff lounge`, `rfid lab`
- Nearest of a kind: `restroom`, `men's room`, `women's restroom`, `elevator`, `stairs`, `stair 4`
- Typos get suggestions (`3119` → 311, 319, …)

Code in `src/route/`:
- `router.ts`: A* over directed edges, so turns can be priced. Options:
  - **Shortest:** least walking.
  - **Accessible:** never uses an edge marked `stairs`. On one floor this only matters for routes *to* a stair; it does the real work once floors are joined through elevators.
  - **Fewest turns:** each turn over 35° costs an extra 20 m.
  - Walking *through* a room costs an extra 150 m, so routes stay in the hallways and only pass through a room to reach an inner office (309A through 309, 318 through 317).
  - Asking for a type (e.g. restroom) routes to whichever is nearest by walking distance.
- `directions.ts`: turn-by-turn text from the path geometry: leaving the room, turns at junctions (with landmarks such as "by the elevators" or "by Stair 4"), side hallways passed, and arrival ("Room 356 is the third door on your left"). Each step also carries an icon type and its distance from the start, ready for the Phase 5 navigation screen.
- `places.ts`: turns typed text into graph nodes, and parses "from X to Y".
- `page.ts`: the route page.

To join floors later, add edges between matching stair and elevator nodes on each floor (stair edges with `stairs: true`). The router needs no changes.

`npm test` now also runs `src/route/route.test.ts`, which checks:
- Every room reaches every other room (about 16,600 pairs), and every set of directions reads cleanly.
- Routes are symmetric.
- No route cuts through a classroom.
- Fewest-turns never has more turns than shortest, and shortest is never longer than fewest-turns.
- Accessible routes never use stairs.
- "Nearest" really is nearest.
- Place lookup works, and one known route gives the expected directions.

**Still to do on site:** walk a handful of routes and check the directions match what you see, especially the door counts ("third door on your left") and "side hallways" passed. Door counts come from the doors on the plan, so unmarked closets or double doors can throw them off.

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