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

export default defineConfig({
  plugins: [graphEditorDevServer()],
  build: {
    // Pages that ship to Vercel. graph.html (the editor) stays dev-only.
    rollupOptions: {
      input: {
        main: resolve(ROOT, 'index.html'),
        route: resolve(ROOT, 'route.html'),
      },
    },
  },
})
