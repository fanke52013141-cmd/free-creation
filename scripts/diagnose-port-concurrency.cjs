/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 回归门禁：候选端口不改变已连接锚点；全局工作流状态不阻塞独立节点。
// 启动 vite.browser.config.ts 对应服务后运行；仅使用浏览器 mock，不发起付费调用。
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
;(async () => {
  fs.mkdirSync(path.resolve('qa/port-concurrency'), { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5173')
    await page.waitForSelector('.tl-canvas')
    await page.evaluate(async () => {
      const ed = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      ed.createShapes([
        { id: 'shape:clip', type: 'node-card', x: 200, y: 120, props: { nodeType: 'video-clip', title: '提取音频', h: 260 } },
        { id: 'shape:audio-result', type: 'node-card', x: 690, y: 170, props: { nodeType: 'audio', title: '音频产物' }, meta: { artifactProducerId: 'shape:clip', artifactProducerPortId: 'out-audio' } },
        { id: 'shape:target', type: 'node-card', x: 200, y: 530, props: { nodeType: 'video-clip', title: '点击此蓝色视频输入' } },
        { id: 'shape:video-running', type: 'node-card', x: 1050, y: 100, props: { nodeType: 'video', title: '普通视频生成', exec: 'running' } },
        { id: 'shape:image', type: 'node-card', x: 1050, y: 500, props: { nodeType: 'image-gen', title: '独立生图' } }
      ])
      ed.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      ed.selectNone()
    })
    await page.waitForTimeout(500)
    const read = () => page.evaluate(() => {
      const card = document.querySelector('[data-node-id="shape:clip"]')
      const port = card.querySelector('.port-dot.out[data-port-id="out-audio"]')
      const r = port.getBoundingClientRect()
      const edge = document.querySelector('.artifact-provenance-edge')
      const point = new DOMPoint(...edge.getAttribute('d').match(/^M\s+([\d.-]+)\s+([\d.-]+)/).slice(1).map(Number)).matrixTransform(edge.getScreenCTM())
      return {
        portId: port.dataset.portId,
        portCenter: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        edgeStart: { x: point.x, y: point.y },
        separation: Math.hypot(point.x - r.left - r.width / 2, point.y - r.top - r.height / 2),
        edgePath: edge.getAttribute('d')
      }
    })
    const before = await read()
    const targetPort = page.locator('[data-node-id="shape:target"] .port-dot.in')
    const targetBox = await targetPort.boundingBox()
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(150)
    const during = await read()
    assert.ok(during.separation < 2, '连接候选出现时溯源线必须保持贴合端口')
    await page.screenshot({ path: path.resolve('qa/port-concurrency/port-reflow.png') })
    await page.mouse.up()
    await page.waitForTimeout(100)
    const after = await read()
    const concurrency = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { useEngineStore } = await import('/src/engine/store.ts')
      const { runNodeManually, runNodeTest } = await import('/src/engine/executor.ts')
      const store = useEngineStore.getState()
      useEngineStore.setState({ phase: 'running', currentNodeId: 'shape:video-running' })
      const imageDuringVideo = await runNodeManually(editor, 'demo', [], 'shape:image')
      const clipDuringVideo = await runNodeManually(editor, 'demo', [], 'shape:target')
      const testDuringVideo = await runNodeTest(editor, 'demo', [], 'shape:target', {})
      editor.updateShape({ id: 'shape:video-running', type: 'node-card', props: { nodeType: 'video-depth' } })
      store.endRun()
      return { imageDuringVideo, clipDuringVideo, testDuringVideo }
    })
    assert.notEqual(concurrency.imageDuringVideo.reason, '已有任务正在运行')
    assert.notEqual(concurrency.clipDuringVideo.reason, '已有任务正在运行')
    const evidence = { before, during, after, concurrency }
    fs.writeFileSync(path.resolve('qa/port-concurrency/evidence.json'), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence, null, 2))
  } finally { await browser.close() }
})().catch((error) => { console.error(error); process.exitCode = 1 })
