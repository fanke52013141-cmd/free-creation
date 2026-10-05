/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
;(async () => {
  const out = path.resolve('qa/optimization-remaining')
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const checks = []
  try {
    await page.addInitScript(() => {
      const originalAdd = window.addEventListener.bind(window),
        originalRemove = window.removeEventListener.bind(window)
      const active = new Set()
      window.addEventListener = (type, listener, options) => {
        if (type === 'wheel' && (options === true || options?.capture)) active.add(listener)
        return originalAdd(type, listener, options)
      }
      window.removeEventListener = (type, listener, options) => {
        if (type === 'wheel' && (options === true || options?.capture)) active.delete(listener)
        return originalRemove(type, listener, options)
      }
      window.__wheelCaptures = () => active.size
    })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5191')
    await page.waitForSelector('.palette-category-item')
    await page.evaluate(async () =>
      (await import('/src/stores/search.ts')).useSearchStore.getState().toggle()
    )
    const input = page.locator('.search-input')
    await input.fill('生图', { force: true })
    await input.press('Enter')
    await page.locator('textarea.gen-prompt').last().waitFor()
    checks.push('搜索 Enter 创建')
    await page.evaluate(async () =>
      (await import('/src/stores/search.ts')).useSearchStore.getState().toggle()
    )
    await page.locator('.search-input').press('Escape')
    assert.equal(await page.locator('.search-panel').count(), 0)
    checks.push('输入框 Esc 关闭搜索')
    const card = page
      .locator('.node-card-wrap')
      .filter({ has: page.locator('.gen-prompt') })
      .last()
    await card.locator('textarea.gen-prompt').fill('分组测试')
    await card.locator('textarea.gen-prompt').press('Tab')
    for (let i = 0; i < 2; i++) {
      await card.locator('.node-run-btn').click()
      await page.waitForTimeout(2500)
    }
    assert.equal(await page.locator('.artifact-group').count(), 2)
    const before = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const graph = (await import('/src/canvas/graph.ts')).deriveGraph(editor)
      return JSON.stringify({
        nodes: graph.nodes.map((node) => {
          const copy = { ...node }
          delete copy.meta
          return copy
        }),
        edges: graph.edges,
        groups: graph.groups
      })
    })
    await page.locator('.artifact-group button').first().click({ force: true })
    assert.equal(await page.locator('.artifact-group.collapsed').count(), 1)
    assert.equal(
      await page.evaluate(async () => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        const graph = (await import('/src/canvas/graph.ts')).deriveGraph(editor)
        return JSON.stringify({
          nodes: graph.nodes.map((node) => {
            const copy = { ...node }
            delete copy.meta
            return copy
          }),
          edges: graph.edges,
          groups: graph.groups
        })
      }),
      before
    )
    await page.locator('.artifact-group.collapsed button').click({ force: true })
    checks.push('两轮独立分组；折叠展开不改变图')
    await page.screenshot({ path: path.join(out, 'groups.png') })
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const sourceId = 'shape:qa-storyboard'
      editor.createShape({
        id: sourceId,
        type: 'node-card',
        x: 0,
        y: 600,
        props: {
          nodeType: 'storyboard',
          title: '分镜',
          text: JSON.stringify({ shots: [{ id: 's1', scene: '森林' }] })
        }
      })
      ;(await import('/src/canvas/storyboard-batch-flow.ts')).createStoryboardBatchFlow(
        editor,
        editor.getShape(sourceId)
      )
      const graph = (await import('/src/canvas/graph.ts')).deriveGraph(editor)
      if (graph.edges.length !== 3) throw new Error('批处理缺少真实连线')
      await new Promise((resolve) => setTimeout(resolve, 100))
      editor.undo()
      const undone = (await import('/src/canvas/graph.ts')).deriveGraph(editor)
      if (undone.edges.length !== 0 || undone.nodes.some((node) => node.type === 'iterate'))
        throw new Error(
          '批处理撤销未覆盖整个组合 ' +
            JSON.stringify({
              edges: undone.edges.length,
              canUndo: editor.canUndo(),
              nodes: undone.nodes.map((n) => n.type)
            })
        )
      editor.redo()
    })
    checks.push('分镜转换三节点、三条真实连线')
    const project = await page.evaluate(
      async () => (await import('/src/stores/app.ts')).useAppStore.getState().currentProject
    )
    // Track only CanvasEditor mount registrations, not tldraw's internal listeners.
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const active = new Set()
      for (const [target, names] of [
        [Object.getPrototypeOf(editor.store), ['listen']],
        [
          Object.getPrototypeOf(editor.sideEffects),
          ['registerAfterDeleteHandler', 'registerAfterCreateHandler']
        ]
      ]) {
        for (const name of names) {
          const original = target[name]
          target[name] = function (...args) {
            const owned = new Error().stack?.includes('CanvasEditor')
            const dispose = original.apply(this, args)
            if (!owned) return dispose
            const token = {}
            active.add(token)
            return () => {
              active.delete(token)
              dispose()
            }
          }
        }
      }
      window.__canvasMountListeners = () => active.size
    })
    for (let i = 0; i < 5; i++) {
      await page.evaluate(async () =>
        (await import('/src/stores/app.ts')).useAppStore.getState().setHome()
      )
      await page.getByRole('button', { name: '最近删除', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.__wheelCaptures()), 0)
      assert.equal(await page.evaluate(() => window.__canvasMountListeners()), 0)
      assert.equal(
        await page.evaluate(
          async () =>
            (await import('/src/stores/editor.ts')).useEditorStore.getState().editor === null
        ),
        true
      )
      await page.evaluate(
        async (project) =>
          (await import('/src/stores/app.ts')).useAppStore.getState().openProject(project),
        project
      )
      await page.waitForSelector('.palette-category-item')
      assert.equal(await page.evaluate(() => window.__canvasMountListeners()), 5)
    }
    checks.push('五次画布卸载无残留 wheel 或五项挂载监听')
    await page.evaluate(async () =>
      (await import('/src/stores/app.ts')).useAppStore.getState().setHome()
    )
    await page.getByRole('button', { name: '最近删除', exact: true }).waitFor()
    const p = await page.evaluate(
      async () => (await window.api.createProject({ name: '删除恢复测试' })).data
    )
    await page.evaluate(async (id) => window.api.deleteProject(id), p.id)
    await page.getByRole('button', { name: '最近删除', exact: true }).click()
    await page.getByText('删除恢复测试', { exact: true }).waitFor()
    await page.getByRole('button', { name: '恢复项目', exact: true }).click()
    await page.getByRole('button', { name: '我的项目', exact: true }).click()
    await page.getByText('删除恢复测试', { exact: true }).waitFor()
    checks.push('最近删除 UI 恢复')
    await page.screenshot({ path: path.join(out, 'recent-delete.png') })
    fs.writeFileSync(
      path.join(out, 'results.json'),
      JSON.stringify({ passed: true, checks }, null, 2)
    )
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'failure.png') })
    throw error
  } finally {
    await browser.close()
  }
})().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
