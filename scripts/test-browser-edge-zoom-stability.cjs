/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 连线缩放稳定性回归（浏览器验收）。
//
// 覆盖用户 2026-11-02 反馈的两个问题：
//   1. 快速放大缩小时整页/连线一闪一闪、连线消失再出现；
//   2. 连线流光动画速度（用户裁决：降到原来的 1/3）。
//
// 验收方式（可重复、不依赖肉眼）：
//   - 相机变化只允许改连线层的镜像 transform，不得重写 path 的 d、滤镜或描边宽度；
//   - 每个缩放档位、每一条连线都要验证端点仍贴合对应端口（逐条聚焦，避免高倍率下
//     被视口剔除的端口让断言静默跳过）；
//   - 页面坐标 mask 仍必须逐条挖空节点卡片（这是本次改动的核心语义）；
//   - 流光动画时长必须是 4.05s（基线 1.35s 的 1/3）；
//   - 连线悬浮/选中/剪刀删除在低/中/高倍率都可用（命中层改成页面坐标后必须回归）；
//   - 追溯线（artifact:）自 2026-11-06 起可悬浮、可用剪刀隐藏（写 meta.artifactLinkHidden），
//     命中路径只服务悬浮且保持 pointer-events:none，点击仍不可选中。
//
// 运行：先启动浏览器验收服务（pnpm dev:browser），再 node scripts/test-browser-edge-zoom-stability.cjs
// 可用 CANVAS_QA_URL 指定地址；证据写入 qa/edge-zoom-flicker-2026-11-02/。
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const OUT = path.resolve('qa/edge-zoom-flicker-2026-11-02')
const ZOOMS = [0.5, 1, 2, 2.8]
// 交互回归的倍率下限取 0.7：端口有 27 屏幕像素的优先命中圈，0.5 倍率下相邻端口之间的
// 连线中段也会落进端口圈（属于既有产品行为），不适合用来验证连线自身的命中。
const INTERACTION_ZOOMS = [0.7, 1, 2.8]
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

    // ── 1. 每个缩放档位、每条连线：镜像 transform、端点贴合、命中宽度、流光时长 ──
    const alignment = []
    for (const zoom of ZOOMS) {
      const report = await page.evaluate(
        async ({ zoom, edgeIds, nodeGap, nodeW }) => {
          const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
          const host = document.querySelector('.canvas-host').getBoundingClientRect()
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
          const measureEdge = (edge) => {
            const svg = document.querySelector('.data-edge-layer')
            const ctm = svg.getScreenCTM()
            const edgePath = document.querySelector(
              `[data-edge-id="${edge.arrowId}"] .data-edge-visible`
            )
            if (!edgePath) return { pathFound: false, tailError: null, headError: null }
            const start = edgePath.getPointAtLength(0)
            const end = edgePath.getPointAtLength(edgePath.getTotalLength())
            const head = new DOMPoint(start.x, start.y).matrixTransform(ctm)
            const tail = new DOMPoint(end.x, end.y).matrixTransform(ctm)
            const targetPort = portCenter(edge.toId, edge.toPort)
            const sourcePort = portCenter(edge.fromId, edge.fromPort)
            return {
              pathFound: true,
              tailError: targetPort
                ? Math.hypot(tail.x - targetPort.x, tail.y - targetPort.y)
                : null,
              headError: sourcePort
                ? Math.hypot(head.x - sourcePort.x, head.y - sourcePort.y)
                : null
            }
          }
          // 逐条把镜头对准该连线的两端口中间：高倍率下也保证两端的端口都在视口内可量测。
          const perEdge = []
          for (const [index, edge] of edgeIds.entries()) {
            const sourceRight = 80 + index * nodeGap + nodeW
            const targetLeft = 80 + (index + 1) * nodeGap
            const focusX = (sourceRight + targetLeft) / 2
            const focusY = 120 + 260 / 2
            // tldraw 相机：screen = (page + camera) * zoom → camera = 画布中心 / zoom - focus。
            editor.setCamera(
              {
                x: host.width / 2 / zoom - focusX,
                y: host.height / 2 / zoom - focusY,
                z: zoom
              },
              { immediate: true }
            )
            let row = { pathFound: false, tailError: null, headError: null }
            let framesToStable = 0
            // 刚进入视口的节点会先自动校正高度（一次文档变更），连线在其后一帧更新。
            for (; framesToStable < 30; framesToStable += 1) {
              await waitFrame()
              row = measureEdge(edge)
              const worst = Math.max(
                row.tailError === null ? Number.POSITIVE_INFINITY : row.tailError,
                row.headError === null ? Number.POSITIVE_INFINITY : row.headError
              )
              if (row.pathFound && worst <= 2.5) break
            }
            perEdge.push({ edgeId: edge.arrowId, framesToStable, ...row })
          }
          const hit = document.querySelector('.data-edge-hit')
          const frame = document.querySelector('.data-edge-frame')
          const tlShapes = document.querySelector('.tl-shapes')
          return {
            zoom,
            sameTransform: frame.style.transform === tlShapes.style.transform,
            transform: frame.style.transform,
            hitStrokeWidth: hit ? parseFloat(getComputedStyle(hit).strokeWidth) : null,
            visiblePaths: document.querySelectorAll('.data-edge-visible').length,
            flowAnimation: getComputedStyle(document.querySelector('.data-edge-flow'))
              .animationDuration,
            perEdge
          }
        },
        { zoom, edgeIds: fixture.edgeIds, nodeGap: NODE_GAP, nodeW: NODE_W }
      )
      alignment.push(report)
      assert.equal(
        report.visiblePaths,
        fixture.edgeIds.length,
        `zoom ${zoom}: 连线层必须始终保留全部 ${fixture.edgeIds.length} 条可见连线`
      )
      assert.ok(report.sameTransform, `zoom ${zoom}: 连线层 transform 必须镜像 .tl-shapes`)
      assert.ok(
        Math.abs(report.hitStrokeWidth - 14 / zoom) <= 0.6,
        `zoom ${zoom}: 命中描边必须保持屏幕空间 14px，实际 ${report.hitStrokeWidth}`
      )
      assert.equal(report.flowAnimation, '4.05s', `zoom ${zoom}: 流光动画时长必须是 4.05s`)
      for (const row of report.perEdge) {
        assert.ok(row.pathFound, `zoom ${zoom}: 连线 ${row.edgeId} 的可见路径缺失`)
        assert.ok(
          row.tailError !== null,
          `zoom ${zoom}: 连线 ${row.edgeId} 的目标输入端口不可量测（不能静默跳过）`
        )
        assert.ok(
          row.headError !== null,
          `zoom ${zoom}: 连线 ${row.edgeId} 的源输出端口不可量测（不能静默跳过）`
        )
        assert.ok(
          row.tailError <= 2.5,
          `zoom ${zoom}: 连线 ${row.edgeId} 终点必须贴合目标端口，实际偏差 ${row.tailError}px`
        )
        assert.ok(
          row.headError <= 2.5,
          `zoom ${zoom}: 连线 ${row.edgeId} 起点必须贴合源端口，实际偏差 ${row.headError}px`
        )
      }
      await page.screenshot({ path: path.join(OUT, `edge-zoom-${zoom}x.png`) })
    }

    // ── 2. 页面坐标 mask 仍必须逐条挖空节点 ──
    const maskCheck = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const mask = document.querySelector('.data-edge-layer mask')
      if (!mask) return null
      const rects = Array.from(mask.querySelectorAll('rect')).map((rect) => ({
        x: Number(rect.getAttribute('x')),
        y: Number(rect.getAttribute('y')),
        width: Number(rect.getAttribute('width')),
        height: Number(rect.getAttribute('height')),
        fill: rect.getAttribute('fill')
      }))
      const white = rects.find((rect) => rect.fill === 'white')
      const black = rects.filter((rect) => rect.fill === 'black')
      const nodes = editor
        .getCurrentPageShapes()
        .filter((shape) => shape.type === 'node-card')
        .flatMap((shape) => {
          const bounds = editor.getShapePageBounds(shape.id)
          return bounds
            ? [{ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }]
            : []
        })
      return {
        attrs: {
          x: Number(mask.getAttribute('x')),
          y: Number(mask.getAttribute('y')),
          width: Number(mask.getAttribute('width')),
          height: Number(mask.getAttribute('height'))
        },
        white,
        black,
        nodes
      }
    })
    assert.ok(maskCheck, '连线层必须存在节点遮罩 mask')
    assert.equal(
      maskCheck.black.length,
      maskCheck.nodes.length,
      `mask 必须为每个节点卡片生成一个挖空矩形（实际 ${maskCheck.black.length}/${maskCheck.nodes.length}）`
    )
    for (const node of maskCheck.nodes) {
      const matched = maskCheck.black.some(
        (rect) =>
          Math.abs(rect.x - node.x) <= 0.01 &&
          Math.abs(rect.y - node.y) <= 0.01 &&
          Math.abs(rect.width - node.width) <= 0.01 &&
          Math.abs(rect.height - node.height) <= 0.01
      )
      assert.ok(matched, `mask 挖空矩形必须与节点页面边界一致：${JSON.stringify(node)}`)
      assert.ok(
        maskCheck.attrs.x <= node.x &&
          maskCheck.attrs.y <= node.y &&
          maskCheck.attrs.x + maskCheck.attrs.width >= node.x + node.width &&
          maskCheck.attrs.y + maskCheck.attrs.height >= node.y + node.height,
        `mask 覆盖范围必须包含节点 ${JSON.stringify(node)}`
      )
    }

    // ── 3. 只动相机：不允许重写 path 几何/滤镜/描边，连线数量不得跳变 ──
    const cameraOnly = await page.evaluate(async (expectedEdges) => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const layer = document.querySelector('.data-edge-layer')
      const mutations = { d: 0, filter: 0, strokeWidth: 0, otherStyleAttributes: 0 }
      const flowFilters = new Set()
      const edgeCounts = new Set()
      let transformMismatches = 0
      let documentChanges = 0
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
      // MutationObserver 在微任务队列里回调：排空微任务后再比对，等价于"浏览器绘制前"的同步结果。
      const settleMicrotasks = async () => {
        await Promise.resolve()
        await Promise.resolve()
      }
      const assertSynced = () => {
        const frame = document.querySelector('.data-edge-frame')
        const tlShapes = document.querySelector('.tl-shapes')
        if (frame.style.transform !== tlShapes.style.transform) transformMismatches += 1
      }
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
          await settleMicrotasks()
          assertSynced()
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
            if (!style.includes('filter') && !style.includes('stroke-width')) {
              mutations.otherStyleAttributes += 1
            }
          } else mutations.otherStyleAttributes += 1
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
        await settleMicrotasks()
        assertSynced()
        const flow = document.querySelector('.data-edge-flow')
        if (flow) flowFilters.add(getComputedStyle(flow).filter)
        edgeCounts.add(document.querySelectorAll('.data-edge-visible').length)
      }
      await waitFrame()
      observer.disconnect()
      offDocument()
      return {
        mutations: { ...mutations },
        documentChanges,
        distinctFlowFilters: flowFilters.size,
        edgeCounts: [...edgeCounts],
        expectedEdges,
        transformMismatches
      }
    }, fixture.edgeIds.length)
    assert.equal(cameraOnly.documentChanges, 0, '第二轮扫描不应再出现文档变更（预热不足）')
    assert.equal(cameraOnly.transformMismatches, 0, '每一帧镜像 transform 都必须与 .tl-shapes 一致')
    assert.equal(cameraOnly.mutations.d, 0, '相机变化不得重写连线 path 的 d')
    assert.equal(cameraOnly.mutations.filter, 0, '相机变化不得重写滤镜')
    assert.equal(cameraOnly.mutations.strokeWidth, 0, '相机变化不得重写描边宽度')
    assert.equal(cameraOnly.distinctFlowFilters, 1, '缩放期间流光滤镜必须保持单一取值')
    assert.deepEqual(
      cameraOnly.edgeCounts,
      [fixture.edgeIds.length],
      '缩放期间可见连线数量不得跳变，也不得为 0'
    )

    // ── 4. 追溯线（artifact:）可悬浮出剪刀并隐藏，但仍不可点击选中 ──
    let provenanceHidden = null
    const provenance = await page.evaluate(async (expectedEdges) => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const assetId = 'shape:edge-zoom-asset'
      editor.createShape({
        id: assetId,
        type: 'node-card',
        x: 80,
        y: 760,
        props: {
          w: 240,
          h: 160,
          nodeType: 'image',
          title: '追溯资产',
          text: ''
        },
        meta: {
          artifactProducerId: 'shape:edge-zoom-node-0',
          artifactProducerPortId: 'out-text'
        }
      })
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
      for (let frame = 0; frame < 30; frame += 1) {
        await waitFrame()
        if (document.querySelectorAll('.data-edge-visible').length === expectedEdges + 1) break
      }
      const host = document.querySelector('.canvas-host').getBoundingClientRect()
      const focusX = 80 + 170
      const focusY = (120 + 260 + 760) / 2
      editor.setCamera(
        { x: host.width / 2 - focusX, y: host.height / 2 - focusY, z: 1 },
        { immediate: true }
      )
      for (let frame = 0; frame < 5; frame += 1) await waitFrame()
      const svg = document.querySelector('.data-edge-layer')
      const ctm = svg.getScreenCTM()
      const provenancePath = document.querySelector(
        '[data-edge-id^="artifact:"] .data-edge-visible'
      )
      const hitPaths = document.querySelectorAll('.data-edge-hit[data-edge-id^="artifact:"]')
      let point = null
      if (provenancePath) {
        const middle = provenancePath.getPointAtLength(provenancePath.getTotalLength() / 2)
        const screen = new DOMPoint(middle.x, middle.y).matrixTransform(ctm)
        point = { x: screen.x, y: screen.y }
      }
      return {
        created: Boolean(provenancePath),
        visibleCount: document.querySelectorAll('.data-edge-visible').length,
        hitPathCount: hitPaths.length,
        // 命中路径只用于 isPointInStroke 的几何判定，必须保持 pointer-events:none。
        hitPointerEvents: hitPaths[0] ? getComputedStyle(hitPaths[0]).pointerEvents : null,
        point,
        assetId
      }
    }, fixture.edgeIds.length)
    assert.ok(provenance.created, '追溯线必须正常绘制')
    assert.equal(
      provenance.hitPathCount,
      1,
      '追溯线必须注册命中路径（悬浮与剪刀依赖它），且只能有一条'
    )
    assert.equal(
      provenance.hitPointerEvents,
      'none',
      '命中路径不得拦截 DOM 指针事件（否则画布框选/平移被吞）'
    )
    assert.ok(provenance.point, '必须能取到追溯线中段的屏幕坐标')
    if (provenance.point) {
      await page.mouse.move(provenance.point.x, provenance.point.y)
      await page.waitForSelector('.data-edge-scissors', { timeout: 5000 })
      assert.equal(
        await page.locator('.data-edge-scissors').count(),
        1,
        '悬浮追溯线必须出现 1 个剪刀（可隐藏追溯关系）'
      )
      assert.equal(
        await page.locator('.data-edge-scissors').getAttribute('aria-label'),
        '隐藏追溯线',
        '追溯线的剪刀必须表达“隐藏追溯线”，不能复用普通连线的“删除此连线”'
      )
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
      }, provenance.point)
      await page.waitForTimeout(120)
      assert.equal(
        await page.locator('.data-edge.is-selected').count(),
        0,
        '点击追溯线不得选中伪边 ID（追溯线不可选中）'
      )
      // 真实点击剪刀：隐藏追溯线（写 meta），不删除任何数据边。
      await page.locator('.data-edge-scissors').click()
      await page.waitForFunction(
        (expected) => document.querySelectorAll('.data-edge-visible').length === expected,
        fixture.edgeIds.length,
        { timeout: 5000 }
      )
      const hidden = await page.evaluate(async (assetId) => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        return {
          artifactLinkHidden: editor.getShape(assetId)?.meta?.artifactLinkHidden === true,
          artifactLines: document.querySelectorAll('[data-edge-id^="artifact:"] .data-edge-visible')
            .length,
          scissors: document.querySelectorAll('.data-edge-scissors').length,
          dataEdgeGroups: document.querySelectorAll('.data-edge').length
        }
      }, provenance.assetId)
      assert.equal(
        hidden.artifactLinkHidden,
        true,
        '点剪刀后目标节点 meta.artifactLinkHidden 必须为 true（隐藏而非删除）'
      )
      assert.equal(hidden.artifactLines, 0, '隐藏后追溯线必须消失')
      assert.equal(hidden.scissors, 0, '隐藏后剪刀必须消失')
      assert.equal(
        hidden.dataEdgeGroups,
        fixture.edgeIds.length,
        '隐藏追溯线不得删除任何普通数据边'
      )
      provenanceHidden = hidden
    }
    await page.evaluate(async (assetId) => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([assetId])
      await new Promise((resolve) => requestAnimationFrame(() => resolve()))
    }, provenance.assetId)
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.data-edge-visible').length === expected,
      fixture.edgeIds.length,
      { timeout: 5000 }
    )

    // ── 5. 低/中/高倍率：悬浮出现剪刀 + 按下选中（覆盖 getScreenCTM 与命中宽度换算） ──
    const interaction = []
    for (const zoom of INTERACTION_ZOOMS) {
      const point = await page.evaluate(
        async ({ zoom, nodeW, nodeGap }) => {
          const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
          const host = document.querySelector('.canvas-host').getBoundingClientRect()
          const sourceRight = 80 + nodeW
          const targetLeft = 80 + nodeGap
          const focusX = (sourceRight + targetLeft) / 2
          const focusY = 250
          editor.setCamera(
            { x: host.width / 2 / zoom - focusX, y: host.height / 2 / zoom - focusY, z: zoom },
            { immediate: true }
          )
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
          const svg = document.querySelector('.data-edge-layer')
          const ctm = svg.getScreenCTM()
          const edgePath = document.querySelector(
            '[data-edge-id="shape:edge-zoom-edge-0"] .data-edge-visible'
          )
          const middle = edgePath.getPointAtLength(edgePath.getTotalLength() / 2)
          const screen = new DOMPoint(middle.x, middle.y).matrixTransform(ctm)
          return { x: screen.x, y: screen.y }
        },
        { zoom, nodeW: NODE_W, nodeGap: NODE_GAP }
      )
      await page.mouse.move(point.x, point.y)
      await page.waitForSelector('.data-edge-scissors', { timeout: 5000 })
      // 剪刀按钮始终贴在光标上，真实点击会落到按钮；用同坐标 pointerdown 验证"按下连线即选中"。
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
      }, point)
      await page.waitForTimeout(120)
      const selected = await page.locator('.data-edge.is-selected').count()
      assert.equal(selected, 1, `zoom ${zoom}: 点击连线必须选中该连线`)
      const selectedId = await page
        .locator('.data-edge.is-selected')
        .getAttribute('data-edge-id')
      assert.equal(selectedId, 'shape:edge-zoom-edge-0', `zoom ${zoom}: 选中的必须是命中的那条连线`)
      interaction.push({ zoom, point, selectedId })
      // 移开指针清除 hover，避免影响下一轮。
      await page.mouse.move(1240, 780)
      await page.waitForTimeout(120)
      assert.equal(await page.locator('.data-edge-scissors').count(), 0, `zoom ${zoom}: 移开后剪刀必须消失`)
    }

    // ── 6. 剪刀删除（中倍率真实点击）──
    const deletePoint = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const host = document.querySelector('.canvas-host').getBoundingClientRect()
      const focusX = (80 + 340 + 550) / 2
      editor.setCamera({ x: host.width / 2 - focusX, y: host.height / 2 - 250, z: 1 }, { immediate: true })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const svg = document.querySelector('.data-edge-layer')
      const ctm = svg.getScreenCTM()
      const edgePath = document.querySelectorAll('.data-edge-visible')[0]
      const middle = edgePath.getPointAtLength(edgePath.getTotalLength() / 2)
      const screen = new DOMPoint(middle.x, middle.y).matrixTransform(ctm)
      return { x: screen.x, y: screen.y }
    })
    await page.mouse.move(deletePoint.x, deletePoint.y)
    await page.waitForSelector('.data-edge-scissors', { timeout: 5000 })
    const before = await page.locator('.data-edge-layer .data-edge-visible').count()
    await page.locator('.data-edge-scissors').click()
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.data-edge-visible').length === expected,
      before - 1,
      { timeout: 5000 }
    )
    const after = await page.locator('.data-edge-layer .data-edge-visible').count()
    assert.equal(after, before - 1, '剪刀必须删除一条连线')

    fs.writeFileSync(
      path.join(OUT, 'evidence.json'),
      JSON.stringify(
        { zooms: ZOOMS, alignment, maskCheck, cameraOnly, provenance, provenanceHidden, interaction, before, after },
        null,
        2
      )
    )
    console.log(
      'PASS: 连线随相机同帧变换、逐条端点贴合端口、页面坐标 mask 仍挖空节点、缩放期间零几何/滤镜重写、流光 4.05s、低/中/高倍率悬浮/选中/删除可用、追溯线可悬浮隐藏但不可选中'
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
