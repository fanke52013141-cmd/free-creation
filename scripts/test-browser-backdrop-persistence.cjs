/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

async function main() {
  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'msedge',
    headless: true
  })
  try {
    const page = await browser.newPage()
    const origin = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5199'
    const id = 'shape:backdrop-persistence-probe'
    await page.goto(origin)
    await page.waitForFunction(() => Boolean(window.__canvasEditor))
    const original = await page.evaluate((shapeId) => {
      const editor = window.__canvasEditor
      editor.createShape({ id: shapeId, type: 'backdrop', x: 100, y: 100 })
      return editor.getShape(shapeId)?.props
    }, id)
    assert.deepEqual(original, {
      w: 420,
      h: 260,
      color: '#D2DDFE',
      fillOpacity: 0.5,
      title: '',
      memberIds: [],
      padding: { top: 48, right: 24, bottom: 24, left: 24 }
    })
    const fill = page.locator(`[data-canvas-backdrop="${id}"] > [aria-hidden="true"]`)
    await fill.waitFor()
    assert.deepEqual(
      await fill.evaluate((element) => {
        const style = getComputedStyle(element)
        return [style.backgroundColor, style.opacity]
      }),
      ['rgb(210, 221, 254)', '0.5']
    )

    await page.waitForFunction((shapeId) => {
      const snapshot = JSON.parse(sessionStorage.getItem('canvas-studio.browser-demo.snapshot.v1') || 'null')
      return snapshot?.store?.[shapeId]?.type === 'backdrop'
    }, id)
    await page.reload()
    await page.waitForFunction((shapeId) => {
      return window.__canvasEditor?.getShape(shapeId)?.type === 'backdrop'
    }, id)
    assert.deepEqual(
      await page.evaluate((shapeId) => window.__canvasEditor.getShape(shapeId).props, id),
      original
    )
    await fill.waitFor()

    const layout = await page.evaluate((shapeId) => {
      const editor = window.__canvasEditor
      const first = 'shape:backdrop-member-a'
      const second = 'shape:backdrop-member-b'
      const read = () => {
        const board = editor.getShape(shapeId)
        return [board.x, board.y, board.props.w, board.props.h, board.props.memberIds]
      }
      editor.createShapes([
        { id: first, type: 'node-card', x: 100, y: 200, props: { w: 340, h: 260 } },
        { id: second, type: 'node-card', x: 500, y: 260, props: { w: 340, h: 260 } }
      ])
      editor.updateShape({ id: shapeId, type: 'backdrop', props: { memberIds: [first, second] } })
      const initial = read()
      editor.updateShape({ id: second, type: 'node-card', x: 600, props: { h: 320 } })
      const expanded = read()
      editor.markHistoryStoppingPoint('before-remove-member')
      editor.deleteShapes([second])
      const shrunk = read()
      editor.undo()
      const restored = read()
      editor.redo()
      editor.deleteShapes([first])
      const empty = read()
      editor.createShape({ id: first, type: 'node-card', x: 100, y: 200, props: { w: 340, h: 260 } })
      editor.updateShape({
        id: shapeId,
        type: 'backdrop',
        props: { memberIds: [first], padding: { top: 56, right: 32, bottom: 16, left: 12 } }
      })
      const padded = read()
      return { initial, expanded, shrunk, restored, empty, padded, first, second }
    }, id)
    assert.deepEqual(layout.initial, [56, 152, 828, 392, [layout.first, layout.second]])
    assert.deepEqual(layout.expanded, [56, 152, 928, 452, [layout.first, layout.second]])
    assert.deepEqual(layout.shrunk, [56, 152, 428, 332, [layout.first]])
    assert.deepEqual(layout.restored, layout.expanded)
    assert.deepEqual(layout.empty, [56, 152, 428, 332, []])
    assert.deepEqual(layout.padded, [56, 144, 428, 332, [layout.first]])
    await page.waitForFunction(({ shapeId, first }) => {
      const snapshot = JSON.parse(sessionStorage.getItem('canvas-studio.browser-demo.snapshot.v1') || 'null')
      return snapshot?.store?.[shapeId]?.props?.memberIds?.includes(first)
    }, { shapeId: id, first: layout.first })
    await page.reload()
    await page.waitForFunction(({ shapeId, first }) => {
      return window.__canvasEditor?.getShape(shapeId)?.props.memberIds.includes(first)
    }, { shapeId: id, first: layout.first })
    await page.evaluate(({ first, second }) => {
      const editor = window.__canvasEditor
      editor.createShape({ id: second, type: 'node-card', x: 500, y: 260 })
      editor.select(first, second)
    }, layout)
    await page.getByRole('button', { name: '创建背景板' }).click()
    const created = await page.evaluate((oldId) => {
      const editor = window.__canvasEditor
      const selected = editor.getOnlySelectedShape()
      return {
        type: selected?.type,
        members: selected?.props.memberIds,
        formerMembers: editor.getShape(oldId)?.props.memberIds,
        behindNodes: editor.getCurrentPageShapesSorted().findIndex((shape) => shape.id === selected?.id) <
          editor.getCurrentPageShapesSorted().findIndex((shape) => shape.type === 'node-card')
      }
    }, id)
    assert.deepEqual(created, {
      type: 'backdrop',
      members: [layout.first, layout.second],
      formerMembers: [],
      behindNodes: true
    })
    const board = page.locator('[data-canvas-backdrop]').filter({
      has: page.getByRole('button', { name: '整理背景板节点' }).and(page.locator(':enabled'))
    })
    await board.getByRole('textbox', { name: '背景板名称' }).fill('图片参考')
    await board.getByRole('textbox', { name: '背景板名称' }).press('Enter')
    await board.getByRole('button', { name: '背景板颜色' }).click()
    const swatchRows = await board.locator('.backdrop-swatches button').evaluateAll((buttons) => {
      const rows = new Map()
      for (const button of buttons) {
        const y = button.getBoundingClientRect().top
        rows.set(y, (rows.get(y) || 0) + 1)
      }
      return [...rows.values()]
    })
    assert.deepEqual(swatchRows, [8, 8])
    await board.getByRole('button', { name: '雾蓝' }).click()
    await board.getByRole('button', { name: '背景板颜色' }).click()
    await board.getByLabel('HEX').fill('#AABBCC')
    await board.getByLabel('不透明度 %').fill('35')
    await board.getByRole('button', { name: '应用' }).click()
    const lowerRow = ['shape:backdrop-lower-left', 'shape:backdrop-lower-right']
    await page.evaluate(({ second, lowerRow }) => {
      const editor = window.__canvasEditor
      const selected = editor.getOnlySelectedShape()
      editor.updateShape({ id: second, type: 'node-card', x: 440 })
      editor.createShapes([
        { id: lowerRow[0], type: 'node-card', x: 105, y: 540, props: { w: 340, h: 260 } },
        { id: lowerRow[1], type: 'node-card', x: 450, y: 560, props: { w: 340, h: 260 } }
      ])
      editor.updateShape({
        id: selected.id, type: 'backdrop', props: { memberIds: [...selected.props.memberIds, ...lowerRow] }
      })
    }, { second: layout.second, lowerRow })
    await board.getByRole('button', { name: '整理背景板节点' }).click()
    const arrangement = await page.evaluate(({ first, second, lowerRow }) => {
      const editor = window.__canvasEditor
      const props = editor.getOnlySelectedShape().props
      const a = editor.getShapePageBounds(first)
      const b = editor.getShapePageBounds(second)
      const [c, d] = lowerRow.map((id) => editor.getShapePageBounds(id))
      return [
        props.title, props.color, props.fillOpacity, a.y, b.y, b.x - a.maxX,
        c.y - a.maxY, d.y - c.y, c.x - a.x, d.x - b.x
      ]
    }, { ...layout, lowerRow })
    assert.deepEqual(arrangement, ['图片参考', '#AABBCC', 0.35, 200, 200, 24, 24, 0, 0, 0])
    const boardId = await page.evaluate((second) => {
      const editor = window.__canvasEditor
      const id = editor.getOnlySelectedShape().id
      editor.undo()
      if (editor.getShapePageBounds(second).y !== 260) throw new Error('Arrange undo failed')
      editor.redo()
      return id
    }, layout.second)
    await page.waitForFunction((id) => {
      const snapshot = JSON.parse(sessionStorage.getItem('canvas-studio.browser-demo.snapshot.v1') || 'null')
      const props = snapshot?.store?.[id]?.props
      return props?.title === '图片参考' && props.color === '#AABBCC' && props.fillOpacity === 0.35
    }, boardId)
    await page.reload()
    await page.waitForFunction((id) => window.__canvasEditor?.getShape(id)?.props.title === '图片参考', boardId)
    const dragIds = [boardId, layout.first, layout.second, ...lowerRow]
    const readPositions = () => page.evaluate((ids) =>
      ids.map((id) => {
        const { x, y } = window.__canvasEditor.getShapePageBounds(id)
        return [x, y]
      }), dragIds)
    const beforeDrag = await readPositions()
    await page.evaluate((id) => {
      const editor = window.__canvasEditor
      editor.select(id)
      editor.zoomToSelection({ animation: { duration: 0 } })
      editor.selectNone()
    }, boardId)
    const boardRect = await page.locator(`[data-canvas-backdrop="${boardId}"]`).boundingBox()
    assert.ok(boardRect)
    const dragX = boardRect.x + boardRect.width - 10
    await page.mouse.move(dragX, boardRect.y + 90)
    await page.mouse.down()
    await page.mouse.move(dragX + 80, boardRect.y + 130, { steps: 8 })
    await page.mouse.up()
    const afterDrag = await readPositions()
    const dx = afterDrag[0][0] - beforeDrag[0][0]
    const dy = afterDrag[0][1] - beforeDrag[0][1]
    assert.ok(dx > 0 && dy > 0, JSON.stringify({ boardRect, beforeDrag, afterDrag }))
    for (const [index, [x, y]] of afterDrag.entries()) {
      assert.ok(Math.abs(x - beforeDrag[index][0] - dx) < 0.001)
      assert.ok(Math.abs(y - beforeDrag[index][1] - dy) < 0.001)
    }
    await page.evaluate(() => { window.__canvasEditor.undo() })
    assert.deepEqual(await readPositions(), beforeDrag)
    // Exercise the same graph.patch planner used by CLI and MCP on the real editor.
    await page.evaluate(async (id) => {
      const { planGraphPatch } = await import('/src/canvas/graph-patch.ts')
      const editor = window.__canvasEditor
      const result = planGraphPatch(editor, [{ action: 'backdrop.move', backdropId: id, dx: -24, dy: 36 }], [])
      if (!result.ok) throw new Error(result.issue.code)
      editor.markHistoryStoppingPoint('move backdrop via graph.patch')
      editor.run(() => result.plan.apply(editor))
    }, boardId)
    assert.deepEqual(await readPositions(), beforeDrag.map(([x, y]) => [x - 24, y + 36]))
    await page.evaluate(() => { window.__canvasEditor.undo() })
    assert.deepEqual(await readPositions(), beforeDrag)
    await page.evaluate((id) => { window.__canvasEditor.select(id) }, boardId)
    await page.getByRole('button', { name: '删除背景板' }).click()
    const retained = await page.evaluate(({ first, second }) => {
      const editor = window.__canvasEditor
      return [editor.getShape(first)?.type, editor.getShape(second)?.type]
    }, layout)
    assert.deepEqual(retained, ['node-card', 'node-card'])
    process.stdout.write('PASS: backdrop controls, arrangement, drag, undo, member bounds and reload\n')
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
