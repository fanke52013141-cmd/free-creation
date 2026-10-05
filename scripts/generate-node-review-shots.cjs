/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Reproducible UI survey: one screenshot each for empty state, representative populated state,
// and both ends of the IO side panel for every creatable node. Browser mock only.
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const out = path.join(root, 'artifacts/node-review-2026-10-06')
const url = process.env.CANVAS_QA_URL || 'http://127.0.0.1:5191'
const fixtureDir = process.env.REVIEW_FIXTURE_DIR
const mediaFixtures = fixtureDir ? {
  image: { file: 'rgb-640x480.png', mime: 'image/png' },
  'video-asset': { file: 'clip-4s.mp4', mime: 'video/mp4' },
  audio: { file: 'tone-4s.wav', mime: 'audio/wav' },
  file: { file: 'notes.txt', mime: 'text/plain' }
} : {}
const examples = {
  text: { text: '镜头：雨夜街道的霓虹倒映在积水中。' },
  website: { config: JSON.stringify({ name: '参考网址', url: 'https://example.com' }) },
  image: { title: '已导入图片样例.png' },
  'image-gen': { text: '电影感夜景，雨后的街道与暖色窗光。', config: JSON.stringify({ prompt: '电影感夜景' }) },
  'image-edit': { text: '把画面调整为胶片摄影风格。' },
  'image-crop': { config: JSON.stringify({ aspect: '16:9' }) },
  'image-split': { config: JSON.stringify({ rows: 2, columns: 2, overlap: 0 }) },
  'video-asset': { title: '已导入视频样例.mp4' },
  video: { text: '镜头从街道缓慢推进到亮灯的窗户。' },
  audio: { title: '已导入音频样例.wav' },
  chat: { text: JSON.stringify({ messages: [{ role: 'user', content: '请概括这个镜头。' }, { role: 'assistant', content: '雨夜街道中，镜头缓慢靠近亮灯的窗户。' }] }) },
  'ai-process': { text: '请把输入整理成简洁的分镜描述。', meta: { nodeResult: JSON.stringify({ kind: 'text', text: '雨夜街道中，镜头缓慢靠近亮灯的窗户。' }) } },
  json: { text: JSON.stringify({ title: '雨夜街道', duration: 5 }, null, 2) },
  storyboard: { text: JSON.stringify({ titles: { scene: '画面', duration: '时长' }, shots: [{ id: 'shot-1', scene: '雨夜街道，镜头缓慢推进。', duration: '5s' }] }) },
  processor: { config: JSON.stringify({ valueType: 'string', fallback: '雨夜街道', operation: 'template', path: '', template: '镜头：{{value}}' }), meta: { nodeResult: JSON.stringify({ kind: 'text', text: '镜头：雨夜街道' }) } },
  structured: { text: JSON.stringify({ scene: '{{text}}', duration: 5 }) },
  iterate: { config: JSON.stringify({ limit: 0, runMode: 'all', onFailure: 'skip', maxRetries: 0 }), meta: { nodeResult: JSON.stringify({ kind: 'iterate-result', items: [{ item: { id: 'shot-1' }, status: 'done', outputs: {}, source: { index: 0 } }] }) } },
  code: { text: 'async function main(input) { return { summary: input.text }; }', config: JSON.stringify({ source: 'async function main(input) { return { summary: input.text }; }', outputs: [{ id: 'summary', label: '摘要', type: 'text' }] }) }
}
async function main() {
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1680, height: 1100 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  try {
    await page.goto(url)
    await page.waitForSelector('.tl-canvas')
    const nodes = await page.evaluate(async () => {
      const { allNodeTypes } = await import('/src/nodes/registry.tsx')
      return allNodeTypes().map(spec => ({ type: spec.type, label: spec.label, category: spec.category, inputs: spec.ports.in.map(port => ({ id: port.id, name: port.name, type: port.type, required: port.required, cardinality: port.cardinality })), outputs: spec.ports.out.map(port => ({ id: port.id, name: port.name, type: port.type, required: port.required, cardinality: port.cardinality })) }))
    })
    const manifest = []
    for (const node of nodes) {
      const type = node.type
      const base = `${type}`
      await page.evaluate(async ({ type, state }) => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        ;(await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().close()
        editor.deleteShapes([...editor.getCurrentPageShapeIds()])
        const { getNodeType } = await import('/src/nodes/registry.tsx')
        const spec = getNodeType(type)
        editor.createShape({ id: `shape:review-${type}`, type: 'node-card', x: 440, y: 210, props: { nodeType: type, title: spec.label, ...state }, meta: {} })
        editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
        editor.selectNone()
      }, { type, state: {} })
      await page.waitForTimeout(180)
      const card = page.locator(`.node-card-wrap[data-node-id="shape:review-${type}"]`)
      await card.waitFor()
      await card.screenshot({ path: path.join(out, `${base}-01-initial.png`), animations: 'disabled' })
      let contentState = examples[type] || {}
      const mediaFixture = mediaFixtures[type]
      if (mediaFixture) {
        const fixturePath = path.join(fixtureDir, mediaFixture.file)
        const b64 = fs.readFileSync(fixturePath).toString('base64')
        contentState = await page.evaluate(async ({ file, mime, b64 }) => {
          const { useAppStore } = await import('/src/stores/app.ts')
          const projectId = useAppStore.getState().currentProject.id
          const response = await window.api.importMediaBuffer({ projectId, name: file, mime, data: Uint8Array.from(atob(b64), char => char.charCodeAt(0)) })
          if (!response.ok) throw new Error(response.error.message)
          const asset = response.data
          return { title: asset.name, mediaId: asset.id, mediaPath: asset.path, mediaMime: asset.mime, text: asset.textContent || '' }
        }, { ...mediaFixture, b64 })
      }
      await page.evaluate(async ({ type, state }) => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        // Only explicit output-layout fixtures have a simulated result; never label empty/model cards as executed.
        const meta = { ...(state.meta || {}) }
        if (meta.nodeResult) meta.nodeRun = { runId: `review-fixture-${type}`, status: 'success', startedAt: 1, durationMs: 0, inputs: {} }
        delete state.meta
        editor.updateShape({ id: `shape:review-${type}`, type: 'node-card', props: state, meta })
      }, { type, state: structuredClone(contentState) })
      await page.waitForTimeout(350)
      let mediaDecoded = null
      if (mediaFixture && /^(audio|video)\//.test(mediaFixture.mime)) {
        mediaDecoded = await card.locator('audio, video').first().evaluate(async element => {
          element.preload = 'auto'
          element.load()
          await new Promise(resolve => {
            if (element.readyState >= 2) return resolve()
            element.addEventListener('loadeddata', resolve, { once: true })
            setTimeout(resolve, 3000)
          })
          if (element.tagName === 'VIDEO' && element.readyState >= 2) {
            element.currentTime = 0.1
            await new Promise(resolve => {
              element.addEventListener('seeked', resolve, { once: true })
              setTimeout(resolve, 1000)
            })
          }
          return element.readyState >= 2 && Number.isFinite(element.duration) && element.duration > 0
        })
      }
      await card.screenshot({ path: path.join(out, `${base}-02-content-state.png`), animations: 'disabled' })
      const shapeId = `shape:review-${type}`
      await page.evaluate(async ({ shapeId }) => (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().open('contract', shapeId, 'overview'), { shapeId })
      const panel = page.locator('.node-contract-panel')
      await panel.waitFor()
      await page.getByRole('tab', { name: '输入输出', exact: true }).click()
      await page.waitForTimeout(220)
      const scroll = panel.locator('.contract-scroll')
      await scroll.evaluate(element => { element.scrollTop = 0 })
      await page.waitForTimeout(100)
      await panel.screenshot({ path: path.join(out, `${base}-03-io-input.png`), animations: 'disabled' })
      await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
      await page.waitForTimeout(150)
      await panel.screenshot({ path: path.join(out, `${base}-04-io-output.png`), animations: 'disabled' })
      manifest.push({ ...node, screenshots: { initial: `${base}-01-initial.png`, contentState: `${base}-02-content-state.png`, ioInput: `${base}-03-io-input.png`, ioOutput: `${base}-04-io-output.png` }, contentStateIsFixture: true, mediaFixtureImported: Boolean(mediaFixture), mediaDecoded, simulatedOutputLayout: Boolean(contentState.meta?.nodeResult), representativeContentProvided: Boolean(Object.keys(contentState).length) })
      process.stdout.write(`${manifest.length}/${nodes.length} ${type}\n`)
    }
    const unrelatedChromiumErrors = errors.filter(message => !/The source image cannot be decoded|Failed to fetch/.test(message))
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: url, total: nodes.length, note: '02-content-state uses local review fixtures to inspect populated UI; see the separate runtime matrix for actual executions.', knownBrowserMockNoise: { messages: ['The source image cannot be decoded.', 'Failed to fetch'], count: errors.length }, unexpectedBrowserErrors: unrelatedChromiumErrors, nodes: manifest }, null, 2))
    if (nodes.length !== 28) throw new Error(`expected 28 creatable nodes, got ${nodes.length}`)
    if (unrelatedChromiumErrors.length) throw new Error(`unexpected browser errors: ${unrelatedChromiumErrors.join('; ')}`)
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
