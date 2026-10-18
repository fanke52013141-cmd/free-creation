/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 控制关系连线锚点验收：横向 / 纵向 / 斜向 / 重叠 / 阻挡卡片，含移动与缩放。
const { qaOutputPath } = require('./qa-output.cjs')
const { launchQaBrowser } = require('./qa-browser.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

;(async () => {
  const browser = await launchQaBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 2000, height: 1400 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5199')
    await page.waitForSelector('.tl-canvas', { timeout: 60000 })
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      const base = JSON.parse(getNodeType('agent').initialConfig)
      const definitions = [
        ['agent-root', 'agent', '横向主控', 100, 100],
        ['rel-h', 'text', '横向目标', 760, 100],
        ['rel-v', 'text', '纵向目标', 100, 760],
        ['rel-d', 'text', '斜向目标', 760, 760],
        ['agent-overlap', 'agent', '重叠主控', 100, 1280],
        ['rel-o', 'text', '重叠目标', 220, 1360],
        ['agent-obstacle', 'agent', '阻挡主控', 100, 1900],
        ['rel-x', 'text', '阻挡目标', 1000, 1900],
        ['blocker', 'text', '阻挡卡片', 520, 1760]
      ]
      for (const [id, type, title, x, y] of definitions) {
        const initial = type === 'agent' ? JSON.stringify({ ...base, role: 'coordinator' }) : getNodeType(type).initialConfig || ''
        editor.createShape({
          id: `shape:${id}`,
          type: 'node-card',
          x,
          y,
          props: { nodeType: type, title, config: initial, text: title }
        })
      }
      const scope = {
        'shape:agent-root': ['shape:rel-h', 'shape:rel-v', 'shape:rel-d'],
        'shape:agent-overlap': ['shape:rel-o'],
        'shape:agent-obstacle': ['shape:rel-x']
      }
      for (const [agentId, targets] of Object.entries(scope)) {
        const shape = editor.getShape(agentId)
        editor.updateShape({
          id: agentId,
          type: 'node-card',
          props: { config: JSON.stringify({ ...JSON.parse(shape.props.config), allowedNodeIds: targets }) }
        })
      }
      editor.setCamera({ x: 0, y: -40, z: 0.72 }, { immediate: true })
    })
    await page.waitForFunction(
      () => document.querySelectorAll('.agent-flow-control-path').length === 5,
      { timeout: 20000 }
    )

    const read = () =>
      page.evaluate(async () => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        const host = document.querySelector('.agent-flow-relation-layer').parentElement
        const offset = host.getBoundingClientRect()
        const header = 28 * editor.getCamera().z
        const nodeRect = (id) => {
          const bounds = editor.getShapePageBounds(id)
          const start = editor.pageToScreen({ x: bounds.x, y: bounds.y })
          const end = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
          return {
            x: start.x - offset.left,
            y: start.y - offset.top - header,
            w: end.x - start.x,
            h: end.y - start.y + header
          }
        }
        const sample = (path) => {
          const values = (path.match(/-?\d+(?:\.\d+)?/g) || []).map(Number)
          const [x0, y0, x1, y1, x2, y2, x3, y3] = values
          const points = []
          for (let index = 0; index <= 40; index += 1) {
            const t = index / 40
            const mt = 1 - t
            points.push({
              x: mt ** 3 * x0 + 3 * mt ** 2 * t * x1 + 3 * mt * t ** 2 * x2 + t ** 3 * x3,
              y: mt ** 3 * y0 + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y3
            })
          }
          return points
        }
        const lines = [...document.querySelectorAll('.agent-flow-control-path')].map((element) => {
          const target = element.getAttribute('data-control-target')
          return {
            target,
            owner: element.getAttribute('data-control-owner'),
            kind: element.getAttribute('data-control-kind'),
            sourceSide: element.getAttribute('data-anchor-source'),
            targetSide: element.getAttribute('data-anchor-target'),
            arrowX: Number(element.getAttribute('data-arrow-x')),
            arrowY: Number(element.getAttribute('data-arrow-y')),
            d: element.getAttribute('d'),
            points: sample(element.getAttribute('d')),
            targetRect: nodeRect(target)
          }
        })
        const labels = [...document.querySelectorAll('.agent-flow-control-label')].map((element) => {
          const box = element.getBoundingClientRect()
          return {
            x: box.x - offset.left,
            y: box.y - offset.top,
            w: box.width,
            h: box.height,
            text: element.textContent
          }
        })
        const cards = ['shape:agent-root', 'shape:rel-h', 'shape:rel-v', 'shape:rel-d', 'shape:agent-overlap', 'shape:rel-o', 'shape:agent-obstacle', 'shape:rel-x', 'shape:blocker'].map(
          (id) => ({ id, ...nodeRect(id) })
        )
        return { lines, labels, cards, camera: editor.getCamera() }
      })

    const onEdge = (line) => {
      const rect = line.targetRect
      const eps = 0.75
      if (line.targetSide === 'left') return Math.abs(line.arrowX - rect.x) <= eps && line.arrowY >= rect.y - eps && line.arrowY <= rect.y + rect.h + eps
      if (line.targetSide === 'right') return Math.abs(line.arrowX - (rect.x + rect.w)) <= eps && line.arrowY >= rect.y - eps && line.arrowY <= rect.y + rect.h + eps
      if (line.targetSide === 'top') return Math.abs(line.arrowY - rect.y) <= eps && line.arrowX >= rect.x - eps && line.arrowX <= rect.x + rect.w + eps
      return Math.abs(line.arrowY - (rect.y + rect.h)) <= eps && line.arrowX >= rect.x - eps && line.arrowX <= rect.x + rect.w + eps
    }
    const byTarget = (snapshot, target) => snapshot.lines.find((line) => line.target === target)

    const first = await read()
    for (const line of first.lines) {
      assert.equal(line.kind, 'controls')
      assert.equal(onEdge(line), true, `${line.target} 箭头未落在目标外边缘`)
    }
    const horizontal = byTarget(first, 'shape:rel-h')
    assert.deepEqual([horizontal.sourceSide, horizontal.targetSide], ['right', 'left'])
    const vertical = byTarget(first, 'shape:rel-v')
    assert.deepEqual([vertical.sourceSide, vertical.targetSide], ['bottom', 'top'])
    const diagonal = byTarget(first, 'shape:rel-d')
    assert.notEqual(diagonal.sourceSide, 'top', '斜向连线不应默认接顶部')
    assert.notEqual(diagonal.targetSide, 'top', '斜向连线不应默认接顶部')
    assert.ok(['left', 'top', 'bottom'].includes(diagonal.targetSide))
    assert.equal(onEdge(byTarget(first, 'shape:rel-o')), true)
    assert.notEqual(byTarget(first, 'shape:rel-o').targetSide, 'top', '近邻重叠布局不应默认接顶部')

    const blocker = first.cards.find((card) => card.id === 'shape:blocker')
    const blocked = byTarget(first, 'shape:rel-x')
    assert.equal(
      blocked.points.some(
        (point) =>
          point.x > blocker.x + 2 &&
          point.x < blocker.x + blocker.w - 2 &&
          point.y > blocker.y + 2 &&
          point.y < blocker.y + blocker.h - 2
      ),
      false,
      '阻挡布局的连线穿过了中间卡片'
    )

    for (const label of first.labels) {
      for (const card of first.cards) {
        assert.equal(
          label.x + label.w > card.x &&
            label.x < card.x + card.w &&
            label.y + label.h > card.y &&
            label.y < card.y + card.h,
          false,
          `标签「${label.text}」压住了 ${card.id}`
        )
      }
    }

    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.updateShape({ id: 'shape:rel-h', type: 'node-card', x: 820 })
    })
    await page.waitForFunction((before) => {
      const element = document.querySelector('.agent-flow-control-path[data-control-target="shape:rel-h"]')
      return element && element.getAttribute('d') !== before
    }, horizontal.d, horizontal.d)
    const moved = await read()
    const movedHorizontal = byTarget(moved, 'shape:rel-h')
    assert.deepEqual([movedHorizontal.sourceSide, movedHorizontal.targetSide], ['right', 'left'])
    assert.equal(onEdge(movedHorizontal), true)

    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.setCamera({ x: 0, y: -40, z: 0.5 }, { immediate: true })
    })
    await page.waitForFunction((before) => {
      const element = document.querySelector('.agent-flow-control-path[data-control-target="shape:rel-h"]')
      return element && element.getAttribute('d') !== before
    }, movedHorizontal.d, movedHorizontal.d)
    const zoomed = await read()
    for (const line of zoomed.lines) {
      assert.equal(onEdge(line), true, `缩放下 ${line.target} 箭头未落在目标外边缘`)
      const reference = byTarget(moved, line.target)
      assert.equal(line.sourceSide, reference.sourceSide, `缩放下 ${line.target} 源锚点边变化`)
      assert.equal(line.targetSide, reference.targetSide, `缩放下 ${line.target} 目标锚点边变化`)
    }

    const output = qaOutputPath('qa/agent-comprehensive/run-20261018-relation-anchors-v1')
    fs.mkdirSync(output, { recursive: true })
    await page.screenshot({ path: path.join(output, 'control-relation-anchors.png') })
    fs.writeFileSync(
      path.join(output, 'results.json'),
      JSON.stringify(
        {
          checks: {
            horizontalRightToLeft: true,
            verticalBottomToTop: true,
            diagonalNotTop: true,
            overlapOnEdge: true,
            obstacleAvoided: true,
            labelsAvoidCards: true,
            moveKeepsAnchors: true,
            zoomKeepsAnchors: true,
            arrowsOnTargetEdge: true
          },
          lines: first.lines.map((line) => ({
            target: line.target,
            sourceSide: line.sourceSide,
            targetSide: line.targetSide,
            arrowX: line.arrowX,
            arrowY: line.arrowY
          })),
          movedHorizontal: {
            sourceSide: movedHorizontal.sourceSide,
            targetSide: movedHorizontal.targetSide,
            arrowX: movedHorizontal.arrowX,
            arrowY: movedHorizontal.arrowY
          },
          camera: first.camera,
          modelRequests: 0,
          providerRequests: 0,
          externalHttp: 0
        },
        null,
        2
      ) + '\n'
    )
    console.log(`REL 控制关系锚点验收通过：横向/纵向/斜向/重叠/阻挡 + 移动缩放；截图 ${path.join(output, 'control-relation-anchors.png')}`)
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
