/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 连线缩放稳定性回归（浏览器验收）。
//
// 覆盖用户 2026-11-02 反馈的两个问题：
//   1. 快速放大缩小时整页/连线一闪一闪、连线消失再出现；
//   2. 连线流光动画速度（用户裁决：降到原来的 1/3）。
//
// 验收方式（可重复、不依赖肉眼）：
//   - 相机变化只允许改连线层的镜像 transform，不得重写 path 的 d、滤镜或描边宽度；
//   - 任一缩放档位下，连线端点必须仍贴合对应端口的圆心；
//   - 流光动画时长必须是 4.05s（基线 1.35s 的 1/3）；
//   - 连线悬浮/选中/剪刀删除仍然可用（命中层改成页面坐标后必须回归）。
//
// 运行：先启动浏览器验收服务（pnpm dev:browser），再 node scripts/test-browser-edge-zoom-stability.cjs
// 可用 CANVAS_QA_URL 指定地址；证据写入 qa/edge-zoom-flicker-2026-11-02/。
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const OUT = path.resolve('qa/edge-zoom-flicker-2026-11-02')
const ZOOMS = [0.5, 1, 2, 2.8]
const NODE_W = 340
const NODE_H = 260
const NODE_COUNT = 4
const NODE_GAP = 470

async function launchQaBrowser() {
  const channels = process.env.CANVAS_QA_BROWSER_CHANNEL
    ? [process.env.CANVAS_QA_BROWSER_CHANNEL]
    : ['chrome', 'msedge', undefined]
  let lastError
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await launchQaBrowser()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5173', {
      waitUntil: 'domcontentloaded'
    })
    await page.waitForSelector('.tl-canvas', { timeout: 30000 })
    await page.waitForFunction(
      async () => {
        const mod = await import('/src/stores/editor.ts')
        return Boolean(mod.useEditorStore.getState().editor)
      },
      null,
      { timeout: 30000 }
    )
    await page.waitForTimeout(600)

    const fixture = await page.evaluate(
      async ({ nodeW, nodeH, nodeCount, gap }) => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        editor.deleteShapes([...editor.getCurrentPageShapeIds()])
        const nodes = []
        for (let i = 0; i < nodeCount; i += 1) {
          const isText = i % 2 === 0
          const id = `shape:edge-zoom-node-${i}`
          const x = 80 + i * gap
          const y = 120
          editor.createShape({
            id,
            type: 'node-card',
            x,
            y,
            props: {
              w: nodeW,
              h: nodeH,
              nodeType: isText ? 'text' : 'processor',
              title: `缩放回归 ${i}`,
              text: isText ? `回归 ${i}` : ''
            }
          })
          nodes.push({ id, x, y })
        }
        const edgeIds = []
        for (let i = 0; i < nodes.length - 1; i += 1) {
          const from = nodes[i]
          const to = nodes[i + 1]
          const startX = from.x + nodeW
          const startY = from.y + nodeH / 2
          const endX = to.x
          const endY = to.y + nodeH / 2
          const arrowId = `shape:edge-zoom-edge-${i}`
          const fromPort = i % 2 === 0 ? 'out-text' : 'out-value'
          const toPort = i % 2 === 0 ? 'in-value' : 'in-text'
          editor.createShapes([
            {
              id: arrowId,
              type: 'arrow',
              x: startX,
              y: startY,
              props: {
                kind: 'arc',
                color: 'blue',
                fill: 'none',
                dash: 'solid',
                size: 'l',
                font: 'sans',
                arrowheadStart: 'none',
                arrowheadEnd: 'arrow',
                start: { x: 0, y: 0 },
                end: { x: endX - startX, y: endY - startY },
                bend: 0,
                labelPosition: 0.5,
                scale: 1
              },
              meta: { fromPort, toPort }
            }
          ])
          editor.createBindings([
            {
              type: 'arrow',
              fromId: arrowId,
              toId: from.id,
              props: {
                terminal: 'start',
                normalizedAnchor: { x: 0.98, y: 0.5 },
                isExact: false,
                isPrecise: true,
                snap: 'none'
              }
            },
            {
              type: 'arrow',
              fromId: arrowId,
              toId: to.id,
              props: {
                terminal: 'end',
                normalizedAnchor: { x: 0.02, y: 0.5 },
                isExact: false,
                isPrecise: true,
                snap: 'none'
              }
            }
          ])
          edgeIds.push({ arrowId, fromId: from.id, toId: to.id, fromPort, toPort })
        }
        editor.setCamera({ x: 20, y: 10, z: 0.7 }, { immediate: true })
        return { edgeIds }
      },
      { nodeW: NODE_W, nodeH: NODE_H, nodeCount: NODE_COUNT, gap: NODE_GAP }
    )

    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('.data-edge-layer .data-edge-visible').length === expected,
      fixture.edgeIds.length,
      { timeout: 10000 }
    )

    // ── 1. 每个缩放档位：镜像 transform 一致、端点贴合端口、命中宽度换算正确 ──
    const alignment = []
    for (const zoom of ZOOMS) {
      const report = await page.evaluate(
        async ({ zoom, edgeIds, nodeGap, nodeW }) => {
          const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
          // tldraw 相机：屏幕坐标 = (页面坐标 + camera) * zoom，因此把 focus 放到画布中心时
          // camera = 画布中心 / zoom - focus。早前按屏幕像素推算会在高倍率下把视口甩出链路。
          const host = document.querySelector('.canvas-host').getBoundingClientRect()
          const focusX = 80 + nodeGap + nodeW / 2 + nodeGap / 2
          const focusY = 120 + 260 / 2
          editor.setCamera(
            {
              x: host.width / 2 / zoom - focusX,
              y: host.height / 2 / zoom - focusY,
              z: zoom
            },
            { immediate: true }
          )
          const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
          const portCenter = (nodeId, portId) => {
            const dot = document.querySelector(
              `[data-node-id="${nodeId}"] .port-dot[data-port-id="${portId}"]`
            )
            if (!dot) return null
            const rect = dot.getBoundingClientRect()
            // 被 tldraw 视口剔除的节点仍可能保留 0×0 的 DOM，不能当作有效锚点。
            if (rect.width < 2 || rect.height < 2) return null
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          }
          const measure = () => {
            const svg = document.querySelector('.data-edge-layer')
            const ctm = svg.getScreenCTM()
            return edgeIds.map((edge) => {
              const edgePath = document.querySelector(
                `[data-edge-id="${edge.arrowId}"] .data-edge-visible`
              )
              if (!edgePath) return { tailToTargetPort: null, headToSourcePort: null }
              const start = edgePath.getPointAtLength(0)
              const end = edgePath.getPointAtLength(edgePath.getTotalLength())
              const head = new DOMPoint(start.x, start.y).matrixTransform(ctm)
              const tail = new DOMPoint(end.x, end.y).matrixTransform(ctm)
              const targetPort = portCenter(edge.toId, edge.toPort)
              const sourcePort = portCenter(edge.fromId, edge.fromPort)
              return {
                tailToTargetPort: targetPort
                  ? Math.hypot(tail.x - targetPort.x, tail.y - targetPort.y)
                  : null,
                headToSourcePort: sourcePort
                  ? Math.hypot(head.x - sourcePort.x, head.y - sourcePort.y)
                  : null
              }
            })
          }
          // 刚进入视口的节点会先自动校正高度（一次文档变更），连线在其后一帧更新；
          // 这里等到几何稳定再断言，避免把"节点自身在变高"误判成连线漂移。
          let rows = []
          let framesToStable = 0
          for (; framesToStable < 30; framesToStable += 1) {
            await waitFrame()
            rows = measure()
            const measured = rows.filter((row) => row.tailToTargetPort !== null)
            const worst = measured.reduce(
              (max, row) => Math.max(max, row.tailToTargetPort ?? 0, row.headToSourcePort ?? 0),
              0
            )
            if (measured.length >= 1 && worst <= 2.5) break
          }
          const tailErrors = rows
            .map((row) => row.tailToTargetPort)
            .filter((value) => value !== null)
          const headErrors = rows
            .map((row) => row.headToSourcePort)
            .filter((value) => value !== null)
          const hit = document.querySelector('.data-edge-hit')
          const frame = document.querySelector('.data-edge-frame')
          const tlShapes = document.querySelector('.tl-shapes')
          return {
            zoom,
            framesToStable,
            sameTransform: frame.style.transform === tlShapes.style.transform,
            transform: frame.style.transform,
            hitStrokeWidth: hit ? parseFloat(getComputedStyle(hit).strokeWidth) : null,
            measuredEdges: tailErrors.length,
            maxTailToTargetPort: tailErrors.length ? Math.max(...tailErrors) : null,
            maxHeadToSourcePort: headErrors.length ? Math.max(...headErrors) : null,
            rows,
            flowAnimation: getComputedStyle(document.querySelector('.data-edge-flow'))
              .animationDuration
          }
        },
        { zoom, edgeIds: fixture.edgeIds, nodeGap: NODE_GAP, nodeW: NODE_W }
      )
      alignment.push(report)
      if (report.measuredEdges < (zoom <= 1 ? 3 : 1)) {
        console.log('ALIGN_DEBUG ' + JSON.stringify(report))
      }
      assert.ok(
        report.measuredEdges >= (zoom <= 1 ? 3 : 1),
        `zoom ${zoom}: 完整可见的连线数量不足，实际 ${report.measuredEdges}`
      )
      assert.ok(report.sameTransform, `zoom ${zoom}: 连线层 transform 必须镜像 .tl-shapes`)
      assert.ok(
        report.maxTailToTargetPort <= 2.5,
        `zoom ${zoom}: 连线终点必须贴合目标输入端口，实际偏差 ${report.maxTailToTargetPort}px`
      )
      assert.ok(
        report.maxHeadToSourcePort <= 2.5,
        `zoom ${zoom}: 连线起点必须贴合源输出端口，实际偏差 ${report.maxHeadToSourcePort}px`
      )
      assert.ok(
        Math.abs(report.hitStrokeWidth - 14 / zoom) <= 0.6,
        `zoom ${zoom}: 命中描边必须保持屏幕空间 14px，实际 ${report.hitStrokeWidth}`
      )
      assert.equal(report.flowAnimation, '4.05s', `zoom ${zoom}: 流光动画时长必须是 4.05s`)
      await page.screenshot({ path: path.join(OUT, `edge-zoom-${zoom}x.png`) })
    }

    // ── 2. 只动相机：不允许重写 path 几何/滤镜/描边 ──
    const cameraOnly = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const layer = document.querySelector('.data-edge-layer')
      const mutations = { d: 0, filter: 0, strokeWidth: 0, otherAttributes: 0 }
      const flowFilters = new Set()
      const visibleCounts = new Set()
      let documentChanges = 0
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
      const cameraAt = (frame) => {
        const progress = frame / 35
        return {
          x: 20 - 180 * progress,
          y: 10 - 90 * progress,
          z: 0.78 + 0.22 * Math.sin(progress * Math.PI)
        }
      }
      const sweep = async () => {
        for (let frame = 0; frame < 36; frame += 1) {
          await waitFrame()
          editor.setCamera(cameraAt(frame), { immediate: true })
        }
        await waitFrame()
      }
      // 预热一轮：新进入视口的节点会先自动校正高度（一次文档变更），本轮不统计。
      await sweep()
      await waitFrame()
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type !== 'attributes') continue
          if (record.attributeName === 'd') mutations.d += 1
          else if (record.attributeName === 'style') {
            const style = record.target.getAttribute('style') || ''
            if (style.includes('filter')) mutations.filter += 1
            if (style.includes('stroke-width')) mutations.strokeWidth += 1
            else mutations.otherAttributes += 1
          } else mutations.otherAttributes += 1
        }
      })
      observer.observe(layer, { subtree: true, attributes: true })
      const offDocument = editor.store.listen(
        () => {
          documentChanges += 1
        },
        { scope: 'document' }
      )
      for (let frame = 0; frame < 36; frame += 1) {
        await waitFrame()
        editor.setCamera(cameraAt(frame), { immediate: true })
        const flow = document.querySelector('.data-edge-flow')
        if (flow) flowFilters.add(getComputedStyle(flow).filter)
        visibleCounts.add(document.querySelectorAll('.data-edge-visible').length)
      }
      await waitFrame()
      observer.disconnect()
      offDocument()
      return {
        mutations: { ...mutations },
        documentChanges,
        distinctFlowFilters: flowFilters.size,
        visibleCounts: [...visibleCounts]
      }
    })
    assert.equal(cameraOnly.documentChanges, 0, '第二轮扫描不应再出现文档变更（预热不足）')
    assert.equal(cameraOnly.mutations.d, 0, '相机变化不得重写连线 path 的 d')
    assert.equal(cameraOnly.mutations.filter, 0, '相机变化不得重写滤镜')
    assert.equal(cameraOnly.mutations.strokeWidth, 0, '相机变化不得重写描边宽度')
    assert.equal(cameraOnly.distinctFlowFilters, 1, '缩放期间流光滤镜必须保持单一取值')
    assert.equal(cameraOnly.visibleCounts.length, 1, '缩放期间可见连线数量不得跳变')

    // ── 3. 交互回归：悬浮出现剪刀、按下选中、剪刀删除 ──
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.setCamera({ x: -60, y: -40, z: 1 }, { immediate: true })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    const interactionPoint = await page.evaluate(() => {
      const svg = document.querySelector('.data-edge-layer')
      const ctm = svg.getScreenCTM()
      const edgePath = document.querySelector('.data-edge-visible')
      const middle = edgePath.getPointAtLength(edgePath.getTotalLength() / 2)
      const point = new DOMPoint(middle.x, middle.y).matrixTransform(ctm)
      return { x: point.x, y: point.y }
    })
    await page.mouse.move(interactionPoint.x, interactionPoint.y)
    await page.waitForSelector('.data-edge-scissors', { timeout: 5000 })
    // 剪刀按钮始终贴在光标上，真实点击会落到按钮；这里用同坐标的 pointerdown 验证
    // "按下连线即选中"的命中几何，随后再用真实点击验证剪刀删除。
    await page.evaluate(({ x, y }) => {
      window.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 1
        })
      )
    }, interactionPoint)
    await page.waitForTimeout(120)
    const selected = await page.locator('.data-edge.is-selected').count()
    assert.equal(selected, 1, '点击连线必须选中该连线')
    const before = await page.locator('.data-edge-layer .data-edge-visible').count()
    await page.mouse.move(interactionPoint.x + 1, interactionPoint.y + 1)
    await page.waitForSelector('.data-edge-scissors', { timeout: 5000 })
    await page.locator('.data-edge-scissors').click()
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.data-edge-layer .data-edge-visible').length === expected,
      before - 1,
      { timeout: 5000 }
    )
    const after = await page.locator('.data-edge-layer .data-edge-visible').count()
    assert.equal(after, before - 1, '剪刀必须删除一条连线')

    fs.writeFileSync(
      path.join(OUT, 'evidence.json'),
      JSON.stringify(
        { zooms: ZOOMS, alignment, cameraOnly, interactionPoint, before, after },
        null,
        2
      )
    )
    console.log(
      'PASS: 连线随相机同帧变换、端点贴合端口、缩放期间零几何/滤镜重写、流光 4.05s、悬浮/选中/删除可用'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
