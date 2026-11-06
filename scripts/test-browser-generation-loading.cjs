/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { launchQaBrowser } = require('./qa-browser.cjs')
const { qaOutputPath } = require('./qa-output.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

;(async () => {
  const output = qaOutputPath(`qa/generation-loading-${Date.now()}`)
  fs.mkdirSync(output, { recursive: true })
  const browser = await launchQaBrowser()
  const page = await browser.newPage({ viewport: { width: 1500, height: 1160 } })
  const errors = []
  let phase='boot'
  page.on('pageerror', error => errors.push({phase,message:error.message,stack:error.stack}))
  try {
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5196')
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/stores/app.ts')
      if (useAppStore.getState().currentProject) return
      const projects = await window.api.listProjects()
      if (!projects.ok) throw new Error(projects.error.message)
      useAppStore.getState().openProject(projects.data.find(project => project.id === 'demo'))
    })
    await page.waitForSelector('.tl-canvas')
    await page.waitForFunction(async () => Boolean((await import('/src/stores/editor.ts')).useEditorStore.getState().editor))
    phase = 'generation-loading'
    await page.evaluate(async () => {
      const { useEditorStore } = await import('/src/stores/editor.ts')
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      const editor = useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      const spec = getNodeType('image-gen')
      editor.createShape({
        id: 'shape:qa-generation', type: 'node-card', x: 400, y: 200,
        props: { nodeType: 'image-gen', title: spec.label, ...spec.defaultSize, exec: 'running' },
        meta: { nodeRun: { runId: 'qa-generation', startedAt: Date.now(), status: 'running', inputs: {} } }
      })
    })
    const loadingCard = page.locator('.node-execution-overlay .generation-loading-card')
    await loadingCard.waitFor({ state: 'visible' })
    const field = loadingCard.locator('.generation-loading-field')
    const starCanvas = field.locator('canvas.generation-star-canvas')
    await starCanvas.waitFor({ state: 'visible' })
    // 星辰场：Canvas 2D 星尘，星星不再由进度逐颗激活，加载开始后 ≤600ms 全部出现。
    const canvasSize = await starCanvas.evaluate(canvas => ({
      width: canvas.width,
      height: canvas.height,
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight
    }))
    assert.ok(
      canvasSize.width > 0 && canvasSize.height > 0,
      'star canvas has backing store ' + JSON.stringify(canvasSize)
    )
    assert.ok(
      canvasSize.cssWidth > 0 && canvasSize.cssHeight > 0,
      'star canvas is laid out ' + JSON.stringify(canvasSize)
    )
    await page.waitForFunction(() => {
      const node = document.querySelector('.node-execution-overlay .generation-loading-field')
      return node?.getAttribute('data-reveal') === 'done'
    }, null, { timeout: 5000 })
    const revealed = await field.evaluate(node => ({
      total: Number(node.getAttribute('data-stars')),
      visible: Number(node.getAttribute('data-star-visible')),
      motion: node.getAttribute('data-motion'),
      elapsedMs: Number(node.getAttribute('data-reveal-at')) - Number(node.getAttribute('data-mounted-at'))
    }))
    assert.ok(revealed.total > 0, 'star dust count > 0, got ' + revealed.total)
    assert.equal(revealed.visible, revealed.total, 'all stars visible once revealed')
    assert.ok(
      revealed.elapsedMs <= 600,
      'all stars visible within 600ms, got ' + revealed.elapsedMs + 'ms'
    )
    assert.equal(revealed.motion, 'on')
    console.log(
      'Star dust: ' + revealed.total + ' stars, all visible in ' + revealed.elapsedMs + 'ms'
    )
    const litPixels = async () => starCanvas.evaluate(canvas => {
      const context = canvas.getContext('2d')
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      let lit = 0
      for (let index = 3; index < data.length; index += 4) if (data[index] > 10) lit += 1
      return lit
    })
    assert.ok(await litPixels() > 100, 'star dust is painted, not an empty field')
    const driftSpeed = () => starCanvas.evaluate(async canvas => {
      const context = canvas.getContext('2d')
      const drawImage = context.drawImage
      const points = []
      const frames = []
      context.drawImage = function (sprite, x, y, width, height) {
        points.push([x + width / 2, y + height / 2])
        drawImage.call(this, sprite, x, y, width, height)
      }
      try {
        await new Promise(resolve => {
          const start = performance.now()
          const sample = now => {
            if (points.length) frames.push({ now, points: points.splice(0) })
            if (now - start < 420) requestAnimationFrame(sample)
            else resolve()
          }
          requestAnimationFrame(sample)
        })
      } finally {
        context.drawImage = drawImage
      }
      const first = frames[0]
      const last = frames.at(-1)
      if (!first || first === last || first.points.length !== last.points.length) return 0
      const distance = first.points.reduce((total, [x, y], index) => {
        const [nextX, nextY] = last.points[index]
        return total + Math.hypot(x - nextX, y - nextY)
      }, 0)
      return (distance * 1000) / ((last.now - first.now) * first.points.length)
    })
    const earlySpeed = await driftSpeed()
    await page.evaluate(async () => {
      const { useEditorStore } = await import('/src/stores/editor.ts')
      const editor = useEditorStore.getState().editor
      const shape = editor.getShape('shape:qa-generation')
      editor.updateShape({
        id: shape.id,
        type: shape.type,
        meta: { nodeRun: { ...shape.meta.nodeRun, startedAt: Date.now() - 3600000 } }
      })
    })
    await loadingCard.locator('[role="progressbar"][aria-valuenow="99"]').waitFor()
    await page.waitForTimeout(850)
    const lateSpeed = await driftSpeed()
    assert.ok(earlySpeed > 2, 'stars move as soon as generation starts: ' + earlySpeed)
    assert.ok(lateSpeed > earlySpeed * 1.8, 'stars accelerate from ' + earlySpeed + ' to ' + lateSpeed)
    const dots = loadingCard.locator('.generation-loading-dots > span')
    const dotOrder = await dots.evaluateAll(elements => {
      const animations = elements.map(element => element.getAnimations()[0])
      animations.forEach(animation => animation.pause())
      const brightest = [144, 324, 504].map(time => {
        animations.forEach(animation => { animation.currentTime = time })
        const opacity = elements.map(element => Number(getComputedStyle(element).opacity))
        return opacity.indexOf(Math.max(...opacity))
      })
      animations.forEach(animation => animation.play())
      return brightest
    })
    assert.deepEqual(dotOrder, [0, 1, 2], 'the dots brighten from left to right')
    await page.screenshot({ path: path.join(output, 'image-generation-running.png') })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForFunction(() => {
      const node = document.querySelector('.node-execution-overlay .generation-loading-field')
      return node?.getAttribute('data-motion') === 'off'
    }, null, { timeout: 5000 })
    assert.ok(await litPixels() > 100, 'reduced motion still paints static stars')
    assert.deepEqual(
      await dots.evaluateAll(elements => elements.map(element => [element.getAnimations().length, getComputedStyle(element).opacity])),
      [[0, '1'], [0, '1'], [0, '1']],
      'reduced motion keeps all three dots static'
    )
    const staticFrame = await starCanvas.evaluate(async canvas => {
      const before = canvas.toDataURL()
      await new Promise(resolve => setTimeout(resolve, 320))
      return before === canvas.toDataURL()
    })
    assert.equal(staticFrame, true, 'reduced motion draws one static frame (no rAF animation)')
    await page.screenshot({ path: path.join(output, 'image-generation-reduced-motion.png') })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(async () => {
      const { useEditorStore } = await import('/src/stores/editor.ts')
      useEditorStore.getState().editor.updateShape({
        id: 'shape:qa-generation', type: 'node-card', props: { exec: 'idle' }
      })
    })
    await loadingCard.waitFor({ state: 'detached' })
    const executableTypes = await page.evaluate(async () => {
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      const { PALETTE_NODE_GROUPS } = await import('/src/canvas/palette-categories.ts')
      return Object.values(PALETTE_NODE_GROUPS).flat().filter(type => getNodeType(type)?.executor)
    })
    assert.ok(executableTypes.length > 1)
    for (const type of executableTypes) {
      phase = 'loading:' + type
      await page.evaluate(async type => {
        const { useEditorStore } = await import('/src/stores/editor.ts')
        const { getNodeType } = await import('/src/nodes/registry.tsx')
        const editor = useEditorStore.getState().editor
        const spec = getNodeType(type)
        editor.updateShape({
          id: 'shape:qa-generation', type: 'node-card',
          props: { nodeType: type, title: spec.label, ...spec.defaultSize, config: spec.initialConfig || '', exec: 'running' }
        })
      }, type)
      await loadingCard.waitFor({ state: 'visible' })
      await page.waitForFunction(() => {
        const node = document.querySelector('.node-execution-overlay .generation-loading-field')
        const canvas = node?.querySelector('canvas.generation-star-canvas')
        return Boolean(
          canvas && canvas.width > 0 && canvas.height > 0 && Number(node.getAttribute('data-stars')) > 0
        )
      }, null, { timeout: 5000 })
      await page.evaluate(async () => {
        const { useEditorStore } = await import('/src/stores/editor.ts')
        useEditorStore.getState().editor.updateShape({
          id: 'shape:qa-generation', type: 'node-card', props: { exec: 'idle' }
        })
      })
      await loadingCard.waitFor({ state: 'detached' })
    }

    console.log('Loading state verified for ' + executableTypes.length + ' executable node types')
    phase = 'image-timing-through-executor'
    const timing = await page.evaluate(async () => {
      const { useEditorStore } = await import('/src/stores/editor.ts')
      const { useAppStore } = await import('/src/stores/app.ts')
      const { runNodeManually } = await import('/src/engine/executor.ts')
      const editor = useEditorStore.getState().editor
      const projectId = useAppStore.getState().currentProject.id
      const saved = await window.api.gateway.saveProvider({
        name: 'Timing QA', specId: 'relay', baseURL: 'https://example.com/v1',
        apiKey: 'browser-fixture', models: [{ id: 'qa-image', modality: 'image' }]
      })
      if (!saved.ok) throw new Error(saved.error.message)
      const providers = await window.api.gateway.listProviders()
      if (!providers.ok) throw new Error(providers.error.message)
      const providerKey = saved.data.id
      const modelKey = providerKey + '::qa-image'
      const id = 'shape:qa-generation'
      editor.updateShape({
        id, type: 'node-card',
        props: { nodeType: 'image-gen', exec: 'idle', text: 'QA image', config: JSON.stringify({ providerKey, modelKey, count: 1 }) },
        meta: { nodeRun: null }
      })
      const result = await runNodeManually(editor, projectId, providers.data, id)
      return { result, providerKey, modelKey }
    })
    assert.equal(timing.result.status, 'done', JSON.stringify(timing.result))
    await page.waitForFunction(async ({ providerKey, modelKey }) => {
      const timings = await window.api.workspace.getImageGenerationTimings()
      return timings.ok && timings.data.some(sample =>
        sample.providerKey === providerKey && sample.modelKey === modelKey && sample.durationMs > 0)
    }, timing)
    assert.deepEqual(errors.filter(error => error.phase !== 'boot' || !['The source image cannot be decoded.', 'Failed to fetch'].includes(error.message)), [])
    console.log('Generation loading passed: ' + output)
  } finally {
    await browser.close()
  }
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
