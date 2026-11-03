// Tesseract.js in the browser, self-hosted: the worker, the WebAssembly core
// and the English model are served from /tesseract/ (copied out of
// node_modules by vite.config.ts), so scanning works without a CDN and, after
// the first load, without signal. The model is cached in the phone's storage.
import { createWorker, OEM, type Worker } from 'tesseract.js'
import { charWhitelist, readPlaque, type Gray, type PlaqueRead } from './plaque.ts'

export interface PlaqueReader {
  read(frame: Gray): Promise<PlaqueRead>
  terminate(): Promise<void>
}

export async function createPlaqueReader(rooms: readonly string[], onProgress?: (p: number, status: string) => void): Promise<PlaqueReader> {
  const base = new URL(`${import.meta.env.BASE_URL}tesseract/`, location.href).href
  const worker: Worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}core/`,
    langPath: `${base}lang`,
    gzip: true,
    logger: (m) => onProgress?.(m.progress ?? 0, m.status ?? ''),
  })
  await worker.setParameters({
    tessedit_pageseg_mode: '7' as never,   // one line of text
    tessedit_char_whitelist: charWhitelist(rooms),
    user_defined_dpi: '300',
  })
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const readLine = async (line: Gray) => {
    canvas.width = line.w; canvas.height = line.h
    const img = ctx.createImageData(line.w, line.h)
    for (let i = 0, j = 0; i < line.d.length; i++, j += 4) { img.data[j] = img.data[j + 1] = img.data[j + 2] = line.d[i]; img.data[j + 3] = 255 }
    ctx.putImageData(img, 0, 0)
    const r = await worker.recognize(canvas)
    return r.data.text
  }
  return {
    read: (frame) => readPlaque(frame, rooms, readLine),
    terminate: async () => { await worker.terminate() },
  }
}
