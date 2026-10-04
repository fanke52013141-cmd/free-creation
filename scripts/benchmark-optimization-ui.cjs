/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium, _electron: electron } = require('playwright')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
;(async () => {
  const native = process.argv.includes('--electron')
  let browser, app
  if (!native) browser = await chromium.launch({ channel: 'chrome', headless: true })
  const env = {
    ...process.env,
    CANVAS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-perf-native-')),
    ELECTRON_RENDERER_URL: 'http://127.0.0.1:5191',
    NODE_ENV: 'development'
  }
  delete env.ELECTRON_RUN_AS_NODE
  const results = []
  try {
    for (const scale of [1, 1.25, 1.5])
      for (const count of [50, 200, 1000]) {
        let page,
          projectId = 'demo'
        if (native) {
          app = await electron.launch({ args: ['.'], env, timeout: 60000 })
          page = await app.firstWindow()
          await page.waitForFunction(() => !!window.api)
          await app.evaluate(({ BrowserWindow }, scale) => {
            const window = BrowserWindow.getAllWindows()[0]
            window.setSize(1280, 720)
            window.webContents.setZoomFactor(scale)
          }, scale)
          const project = await page.evaluate(
            async () => (await window.api.createProject({ name: '原生性能样本' })).data
          )
          projectId = project.id
          await page.evaluate(
            async (project) =>
              (await import('/src/stores/app.ts')).useAppStore.getState().openProject(project),
            project
          )
        } else {
          page = await browser.newPage({
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: scale
          })
          await page.goto('http://127.0.0.1:5191')
        }
        await page.waitForSelector('.palette-category-item')
        const metrics = await page.evaluate(
          async ({ count, projectId }) => {
            const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
            const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
            editor.deleteShapes([...editor.getCurrentPageShapeIds()])
            const start = performance.now()
            editor.createShapes(
              Array.from({ length: count }, (_, i) => ({
                id: `shape:perf-${i}`,
                type: 'node-card',
                x: 80 + (i % 10) * 420,
                y: 100 + Math.floor(i / 10) * 340,
                props: { nodeType: 'text', title: `文本${i}`, text: '输入响应测试' }
              }))
            )
            await frame()
            await frame()
            const interactiveMs = performance.now() - start
            const samples = []
            for (let i = 0; i < 20; i++) {
              const start = performance.now()
              editor.updateShape({
                id: 'shape:perf-0',
                type: 'node-card',
                props: { text: `输入${i}` }
              })
              await frame()
              samples.push(performance.now() - start)
            }
            samples.sort((a, b) => a - b)
            const drag = []
            for (let i = 0; i < 20; i++) {
              const start = performance.now()
              editor.updateShape({ id: 'shape:perf-0', type: 'node-card', x: 80 + i * 2 })
              await frame()
              drag.push(performance.now() - start)
            }
            drag.sort((a, b) => a - b)
            const saveStart = performance.now()
            const snapshot = editor.store.getStoreSnapshot()
            await window.api.saveProject({ id: projectId, tldrawSnapshot: snapshot })
            const saveMs = performance.now() - saveStart
            return {
              interactiveMs,
              inputFrameP50: samples[10],
              inputFrameP95: samples[18],
              moveFrameP50: drag[10],
              moveFrameP95: drag[18],
              demoSaveMs: saveMs,
              snapshotBytes: new Blob([JSON.stringify(snapshot)]).size,
              sampledHeapBytes: performance.memory?.usedJSHeapSize ?? null
            }
          },
          { count, projectId }
        )
        if (native)
          metrics.processMemory = await app.evaluate(({ app }) =>
            app.getAppMetrics().map((process) => ({ type: process.type, memory: process.memory }))
          )
        process.stdout.write(`measured ${count} @ ${scale}\n`)
        results.push({ count, scale, viewport: { width: 1280, height: 720 }, ...metrics })
        if (native) {
          await app.close()
          app = null
        } else await page.close()
      }
    const target = path.resolve(process.argv[2] ?? 'qa/optimization-T16/baseline.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(
      target,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          runtime: native ? 'Electron native IPC + development renderer' : 'Chrome browser demo',
          hardware: { cpu: os.cpus()[0].model, ramBytes: os.totalmem() },
          limitation: native
            ? 'API-driven input/movement; native disk save; Electron webContents zoom, not Windows desktop scaling. sampled heap is not process peak RSS.'
            : 'API-driven input and movement frame latency; demo save is sessionStorage, not Electron disk. deviceScaleFactor is raster density, not Windows desktop scaling. sampled heap is not process peak RSS.',
          results
        },
        null,
        2
      )
    )
  } finally {
    if (app) await app.close()
    if (browser) await browser.close()
  }
})().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
