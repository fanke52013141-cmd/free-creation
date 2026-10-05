/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Browser mock: real canvas/execution pipeline, deterministic executor, no paid requests.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5198')
    await page.waitForSelector('.tl-canvas')
    const results = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { tryConnect } = await import('/src/canvas/graph.ts')
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      const { runNodeManually } = await import('/src/engine/executor.ts')
      const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect width="180" height="320" fill="orange"/><rect width="180" height="20" fill="red"/><rect y="300" width="180" height="20" fill="blue"/></svg>')
      editor.createShapes([
        { id: 'shape:crop-source', type: 'node-card', x: -500, y: 50, props: { nodeType: 'image', mediaId: 'portrait', mediaPath: image, mediaMime: 'image/svg+xml' } },
        { id: 'shape:crop-qa', type: 'node-card', x: 50, y: 50, props: { nodeType: 'image-crop', title: '完整竖图裁剪' } },
        { id: 'shape:gen-qa', type: 'node-card', x: 450, y: 50, props: { nodeType: 'image-gen', title: '默认生图', text: '画一只猫' } },
        { id: 'shape:edit-qa', type: 'node-card', x: 850, y: 50, props: { nodeType: 'image-edit', title: 'P 图' } },
        { id: 'shape:ai-qa', type: 'node-card', x: 50, y: 500, props: { nodeType: 'ai-process', title: 'AI 处理' } }
      ])
      const connectionError = tryConnect(editor, { shapeId: 'shape:crop-source', portId: 'out-image', portType: 'image' }, 'shape:crop-qa', undefined, 'in-image')
      tryConnect(editor, { shapeId: 'shape:crop-source', portId: 'out-image', portType: 'image' }, 'shape:edit-qa', undefined, 'in-image')
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      const spec = getNodeType('ai-process'), original = spec.executor
      const artifacts = []
      try {
        for (const kind of ['text', 'markdown', 'json']) {
          editor.updateShape({ id: 'shape:ai-qa', type: 'node-card', props: { config: JSON.stringify({ mode: kind }) } })
          spec.executor = async (ctx) => {
            ctx.updateResult(JSON.stringify(kind === 'json' ? { kind, data: { story: '完整 JSON 内容', scenes: [1, 2] }, schema: { id: 'json.any', version: 1 } } : { kind, text: '完整生成内容\n第二段结尾' }))
            return { status: 'done', artifactOutputPorts: [`out-${kind}`] }
          }
          artifacts.push(await runNodeManually(editor, 'demo', [], 'shape:ai-qa'))
        }
        const before = editor.getCurrentPageShapes().filter((s) => s.meta.artifactProducerId === 'shape:ai-qa').length
        spec.executor = async () => ({ status: 'failed', reason: '验收失败场景' })
        await runNodeManually(editor, 'demo', [], 'shape:ai-qa')
        const after = editor.getCurrentPageShapes().filter((s) => s.meta.artifactProducerId === 'shape:ai-qa').length
        const documents = editor.getCurrentPageShapes().filter((s) => s.meta.artifactProducerId === 'shape:ai-qa').map((s) => ({ type: s.props.nodeType, text: s.props.text, run: s.meta.artifactRunId }))
        return { connectionError, before, after, artifacts, documents }
      } finally { spec.executor = original }
    })
    assert.equal(results.connectionError, null)
    assert.equal(results.before, 3)
    assert.equal(results.after, 3)
    assert.deepEqual(results.documents.map((s) => s.type), ['text', 'text', 'json'])
    assert.equal(results.documents[0].text, '完整生成内容\n第二段结尾')
    assert.equal(JSON.parse(results.documents[2].text).story, '完整 JSON 内容')
    assert.equal(new Set(results.documents.map((s) => s.run)).size, 3)
    await page.waitForFunction(() => document.querySelector('[data-node-id="shape:crop-qa"] .crop-inline-canvas img')?.naturalHeight === 320)
    await page.waitForTimeout(500)
    await page.evaluate(async () => (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().open('contract', 'shape:edit-qa', 'settings'))
    await page.waitForSelector('.image-edit-model-row')
    const layout = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const canvas = document.querySelector('[data-node-id="shape:crop-qa"] .crop-inline-canvas').getBoundingClientRect()
      const image = document.querySelector('[data-node-id="shape:crop-qa"] .crop-inline-canvas img').getBoundingClientRect()
      const rect = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })
      const row = document.querySelector('.image-edit-model-row')
      return { canvas: rect(canvas), image: rect(image), height: editor.getShape('shape:gen-qa').props.h, choices: [...row.querySelectorAll('.gen-select')].map((el) => ({ text: el.textContent, width: el.offsetWidth })) }
    })
    assert.ok(layout.image.x >= layout.canvas.x - 1)
    assert.ok(layout.image.y >= layout.canvas.y - 1)
    assert.ok(layout.image.x + layout.image.w <= layout.canvas.x + layout.canvas.w + 1)
    assert.ok(layout.image.y + layout.image.h <= layout.canvas.y + layout.canvas.h + 1)
    assert.ok(Math.abs(layout.image.w / layout.image.h - 180 / 320) < 0.01)
    const cropConfig = () => page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:crop-qa').props.config)
    const untouched = await cropConfig()
    await page.mouse.move(layout.canvas.x + 4, layout.canvas.y + 15)
    await page.mouse.down()
    await page.mouse.move(layout.canvas.x + 25, layout.canvas.y + 30)
    await page.mouse.up()
    assert.equal(await cropConfig(), untouched, '留白拖动不得修改原图选区')
    await page.mouse.move(layout.image.x + layout.image.w * 0.1, layout.image.y + layout.image.h * 0.1)
    await page.mouse.down()
    await page.mouse.move(layout.image.x + layout.image.w * 0.2, layout.image.y + layout.image.h * 0.2, { steps: 5 })
    await page.mouse.up()
    const cropped = JSON.parse(await cropConfig())
    assert.ok(Math.abs(cropped.rect.x - 0.2) < 0.015)
    assert.ok(Math.abs(cropped.rect.y - 0.2) < 0.015)
    assert.equal(layout.height, 260)
    assert.equal(layout.choices[1].text, '比例')
    assert.ok(layout.choices[0].width > layout.choices[1].width)
    assert.ok(layout.choices[2].width <= 70)
    await page.evaluate(async () => (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().close())
    const prompt = page.locator('[data-node-id="shape:gen-qa"] .gen-prompt')
    await prompt.fill(Array.from({ length: 20 }, (_, i) => `第 ${i} 行画面说明`).join('\n'))
    await page.waitForTimeout(400)
    const expanded = await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:gen-qa').props.h)
    assert.ok(expanded > layout.height)
    await prompt.fill('画一只猫')
    await page.waitForTimeout(400)
    const collapsed = await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape('shape:gen-qa').props.h)
    assert.equal(collapsed, 260)
    fs.mkdirSync('qa/document-crop-sizing', { recursive: true })
    await page.screenshot({ path: 'qa/document-crop-sizing/cards.png' })
    fs.writeFileSync('qa/document-crop-sizing/evidence.json', JSON.stringify({ results, layout, expanded }, null, 2))
    console.log('document, full portrait crop, image height and P-edit controls passed')
  } finally { await browser.close() }
})().catch((error) => { console.error(error); process.exitCode = 1 })
