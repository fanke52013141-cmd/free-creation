/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const evidence = []
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5196')
    await page.waitForSelector('.tl-canvas')
    for (const type of ['agent', 'state-machine', 'ai-review']) {
      await page.evaluate(async (type) => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        const spec = (await import('/src/nodes/registry.tsx')).getNodeType(type)
        ;(await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().close()
        editor.deleteShapes([...editor.getCurrentPageShapeIds()])
        editor.createShape({ id: 'shape:c1-audit', type: 'node-card', x: 340, y: 180,
          props: { nodeType: type, title: spec.label, config: spec.initialConfig } })
        editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      }, type)
      const card = page.locator(`[data-node-type="${type}"]`)
      if (type === 'agent') await card.locator('..').locator('.node-info-btn').click()
      else await card.getByRole('button', { name: '配置节点', exact: true }).click()
      const settings = page.locator('.agent-flow-settings')
      await settings.waitFor()
      const field = type === 'agent' ? '最多处理步数' : type === 'ai-review' ? '最多返工次数' : '初始阶段'
      const value = type === 'agent' ? '17' : type === 'ai-review' ? '2' : 'working'
      if (type === 'state-machine') {
        await settings.getByLabel(field, { exact: true }).click()
        await page.getByRole('option', { name: value, exact: true }).click()
      } else await settings.getByLabel(field, { exact: true }).fill(value)
      await settings.getByRole('button', { name: '保存配置', exact: true }).click()
      assert.equal(await settings.locator('[role="alert"]').count(), 0)
      const saved = await page.evaluate(async (type) => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        const spec = (await import('/src/nodes/registry.tsx')).getNodeType(type)
        const shape = editor.getShape('shape:c1-audit')
        const config = shape.props.config
        const snapshot = JSON.parse(JSON.stringify(editor.store.getStoreSnapshot('document')))
        editor.store.loadStoreSnapshot(snapshot)
        const restored = editor.getShape('shape:c1-audit')
        const graph = (await import('/src/canvas/graph.ts')).deriveGraph(editor)
        return { before: config, after: restored.props.config, graphConfig: graph.nodes[0].params.config,
          edges: graph.edges.length, outputs: spec.projectOutputs(restored), disabled: Boolean(spec.executionDisabledReason) }
      }, type)
      assert.equal(saved.before, saved.after)
      assert.equal(saved.before, saved.graphConfig)
      const config = JSON.parse(saved.after)
      assert.equal(type === 'agent' ? config.maxSteps : type === 'ai-review' ? config.maxReworks : config.initialState,
        type === 'state-machine' ? value : Number(value))
      assert.equal(saved.edges, 0)
      assert.deepEqual(saved.outputs, {})
      assert.equal(saved.disabled, type !== 'agent')
      evidence.push({ type, settingsSaved: true, snapshotRestored: true, executionDisabled: type !== 'agent' })
    }
    fs.mkdirSync('qa/canvas-agent-flow/C1', { recursive: true })
    fs.writeFileSync('qa/canvas-agent-flow/C1/settings-results.json', JSON.stringify(evidence, null, 2))
    await page.screenshot({ path: 'qa/canvas-agent-flow/C1/review-settings.png' })
    console.log('C1 三种节点设置、快照/图一致性、无假输出与执行可用性通过')
  } finally { await browser.close() }
})().catch((error) => { console.error(error); process.exitCode = 1 })
