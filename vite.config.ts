import { defineConfig, type Plugin } from 'vite'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))

// Dev-only helpers for the graph editor (graph.html). Nothing here is part of
// the deployed site, so the facilities floor plans in private/ stay off Vercel.
function graphEditorDevServer(): Plugin {
  return {
    name: 'novagator-graph-editor',
    apply: 'serve',
    configureServer(server) {
      // Serve the private floor plan SVGs to the editor while running `npm run dev`.
      server.middlewares.use('/private/floorplans/', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        if (!/^[\w.-]+\.svg$/.test(name)) return next()
        const file = resolve(ROOT, 'private/floorplans', name)
        if (!existsSync(file)) { res.statusCode = 404; return res.end('not found') }
        res.setHeader('Content-Type', 'image/svg+xml')
        res.end(readFileSync(file))
      })
      // Save the edited graph straight back into src/data/.
      server.middlewares.use('/__novagator/save-graph', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end() }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const { floor, text } = JSON.parse(body)
            if (!/^[A-Z0-9]{1,2}$/.test(floor)) throw new Error('bad floor')
            JSON.parse(text) // must be valid JSON
            writeFileSync(resolve(ROOT, `src/data/floor${floor}.graph.json`), text)
            res.end('saved')
          } catch (e) {
            res.statusCode = 400
            res.end(String(e))
          }
        })
      })
    },
  }
}

// Tesseract.js (plaque reading) runs from our own site, not a CDN: the worker,
// the WebAssembly core (three builds; each phone downloads the one it
// supports) and the English model. Served from node_modules while developing
// and copied into the build for Vercel.
const TESSERACT_FILES: Record<string, string> = {
  'tesseract/worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  'tesseract/core/tesseract-core-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  'tesseract/core/tesseract-core-simd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract/lang/eng.traineddata.gz': 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
}
function tesseractAssets(): Plugin {
  return {
    name: 'novagator-tesseract-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        const src = TESSERACT_FILES[path]
        if (!src) return next()
        res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        res.end(readFileSync(resolve(ROOT, src)))
      })
    },
    generateBundle() {
      for (const [fileName, src] of Object.entries(TESSERACT_FILES))
        this.emitFile({ type: 'asset', fileName, source: readFileSync(resolve(ROOT, src)) })
    },
  }
}

export default defineConfig({
  plugins: [graphEditorDevServer(), tesseractAssets()],
  build: {
    // Pages that ship to Vercel. graph.html (the editor) stays dev-only.
    rollupOptions: {
      input: {
        main: resolve(ROOT, 'index.html'),
        route: resolve(ROOT, 'route.html'),
        locate: resolve(ROOT, 'locate.html'),
      },
    },
  },
})
