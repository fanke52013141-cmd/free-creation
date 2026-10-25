/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { qaOutputPath } = require('./qa-output.cjs')
const { launchQaBrowser } = require('./qa-browser.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  const browser = await launchQaBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 2000, height: 1600 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5198')
    await page.waitForSelector('.tl-canvas', { timeout: 60000 })
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      for (const [id, type, title, x, y] of [
        ['agent', 'agent', '主控 Agent', 260, 330], ['producer', 'text', '生产内容', 820, 330],
        ['review', 'ai-review', '质量审核', 260, 660], ['next', 'text', '后续步骤', 820, 660],
        ['state', 'state-machine', '流程阶段', 260, 990], ['specialist-a', 'agent', '材料分析', 820, 990], ['specialist-b', 'agent', '结果整理', 1300, 330]
      ]) editor.createShape({ id: `shape:flow-${id}`, type: 'node-card', x, y,
        props: { nodeType: type, title, config: type === 'agent' ? JSON.stringify({ ...JSON.parse(getNodeType(type).initialConfig), interactionMode: id === 'specialist-b' ? 'autonomous' : 'collaborative' }) : getNodeType(type).initialConfig || '', text: type === 'text' ? '合成验收文本' : id === 'specialist-a' ? '材料分析目标' : id === 'specialist-b' ? '结果整理目标' : id === 'agent' ? '协调目标' : '' } })
      ;(await import('/src/canvas/graph.ts')).createEdge(editor,
        { shapeId: 'shape:flow-producer', portId: 'out-text' }, { shapeId: 'shape:flow-review', portId: 'in-text' })
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
    })
    const settings = page.locator('.agent-flow-settings')
    const open = async (id) => {
      await page.evaluate(async (id) => (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().open('contract', `shape:flow-${id}`, 'settings'), id)
      await settings.waitFor()
    }
    const save = async () => { await settings.getByRole('button', { name: '保存配置', exact: true }).click(); assert.equal(await settings.locator('[role="alert"]').count(), 0) }
    const choose = async (label, value) => {
      await settings.getByLabel(label, { exact: true }).click()
      await page.getByRole('option', { name: value, exact: true }).click()
    }
    await open('agent')
    await choose('职责', '主控 Agent')
    await settings.getByRole('group', { name: '允许处理的节点', exact: true }).getByLabel('生产内容 · 文本', { exact: true }).check()
    await settings.getByRole('group', { name: '允许处理的节点', exact: true }).getByLabel('质量审核 · AI 审核', { exact: true }).check()
    await settings.getByRole('group', { name: '允许处理的节点', exact: true }).getByLabel('材料分析 · Agent', { exact: true }).check()
    await settings.getByRole('group', { name: '允许处理的节点', exact: true }).getByLabel('结果整理 · Agent', { exact: true }).check()
    await save()
    await open('review')
    await choose('负责修订的节点', '主控 Agent · Agent')
    await settings.getByRole('group', { name: '等待审核通过的节点', exact: true }).getByLabel('后续步骤 · 文本', { exact: true }).check()
    await settings.getByRole('group', { name: '审核对象来源', exact: true }).locator('input[type="checkbox"]').check()
    await save()
    await open('state')
    // P2-A：状态机卡片展示权威实例状态；未运行时显示初始阶段（未启动）。
    assert.equal(await page.locator('[data-node-id="shape:flow-state"]').getByText('当前阶段：draft（未启动）', { exact: true }).isVisible(), true)
    await settings.getByRole('group', { name: '观察的节点', exact: true }).getByLabel('主控 Agent · Agent', { exact: true }).check()
    await settings.getByRole('group', { name: '观察的节点', exact: true }).getByLabel('质量审核 · AI 审核', { exact: true }).check()
    await settings.getByRole('button', { name: '添加转换', exact: true }).click()
    await settings.getByLabel('触发事件 1', { exact: true }).fill('submitted')
    await settings.getByRole('button', { name: '添加转换', exact: true }).click()
    await choose('起始阶段 2', 'working')
    await choose('目标阶段 2', 'completed')
    await settings.getByLabel('触发事件 2', { exact: true }).fill('review_passed')
    await save()
    await page.waitForFunction(() => document.querySelectorAll('.agent-flow-control-path').length === 8)
    const snapshot = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const graph = (await import('/src/canvas/graph.ts')).deriveGraph(editor)
      return { configs: Object.fromEntries(graph.nodes.filter(node => ['agent', 'state-machine', 'ai-review'].includes(node.type)).map(node => [node.id, node.params.config])),
        tasks: Object.fromEntries(graph.nodes.filter(node => node.type === 'agent').map(node => [node.id, node.content])), edges: graph.edges.length }
    })
    assert.equal(snapshot.edges, 1)
    assert.deepEqual(snapshot.tasks['shape:flow-specialist-a'], { kind: 'text', text: '材料分析目标' })
    assert.deepEqual(snapshot.tasks['shape:flow-specialist-b'], { kind: 'text', text: '结果整理目标' })
    assert.equal(JSON.parse(snapshot.configs['shape:flow-agent']).role, 'coordinator')
    assert.equal(JSON.parse(snapshot.configs['shape:flow-specialist-a']).interactionMode, 'collaborative')
    assert.equal(JSON.parse(snapshot.configs['shape:flow-specialist-b']).interactionMode, 'autonomous')
    await settings.getByRole('button', { name: '添加转换', exact: true }).click()
    await settings.getByLabel('触发事件 3', { exact: true }).fill('submitted')
    await settings.getByRole('button', { name: '保存配置', exact: true }).click()
    assert.equal(await settings.locator('[role="alert"]').count(), 1)
    assert.equal(await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      return JSON.parse(editor.getShape('shape:flow-state').props.config).transitions.length
    }), 2)
    await settings.getByRole('button', { name: '删除转换 3', exact: true }).click()
    await save()
    const control = page.locator('.agent-flow-control-path[data-control-target="shape:flow-producer"]')
    const before = await control.getAttribute('d')
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.updateShape({ id: 'shape:flow-producer', type: 'node-card', x: 910 })
    })
    await page.waitForFunction((before) => document.querySelector('.agent-flow-control-path[data-control-target="shape:flow-producer"]').getAttribute('d') !== before, before)
    const moved = await control.getAttribute('d')
    await page.evaluate(async () => { (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.setCamera({ x: 0, y: 0, z: .8 }, { immediate: true }) })
    await page.waitForFunction((before) => document.querySelector('.agent-flow-control-path[data-control-target="shape:flow-producer"]').getAttribute('d') !== before, moved)
    const restored = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const doc = JSON.parse(JSON.stringify(editor.store.getStoreSnapshot('document')))
      editor.store.loadStoreSnapshot(doc)
      const graph = (await import('/src/canvas/graph.ts')).deriveGraph(editor)
      return { configs: Object.fromEntries(graph.nodes.filter(node => ['agent', 'state-machine', 'ai-review'].includes(node.type)).map(node => [node.id, node.params.config])), tasks: Object.fromEntries(graph.nodes.filter(node => node.type === 'agent').map(node => [node.id, node.content])), edges: graph.edges.length }
    })
    assert.deepEqual(restored, snapshot)
    // An underlying data stroke must not capture a control label's pointer event.
    await page.evaluate(() => {
      const label = document.querySelector('[aria-label="配置控制关系：审核放行"]')
      const labelBounds = label.getBoundingClientRect()
      const dataSvg = document.querySelector('.data-edge-layer')
      const bounds = dataSvg.getBoundingClientRect()
      const x = labelBounds.x + labelBounds.width / 2 - bounds.x
      const y = labelBounds.y + labelBounds.height / 2 - bounds.y
      dataSvg.querySelector('.data-edge-hit').setAttribute('d', `M ${x - 100} ${y} L ${x + 100} ${y}`)
    })
    await page.getByRole('button', { name: '配置控制关系：审核放行', exact: true }).click()
    assert.equal(await page.evaluate(async () => (await import('/src/stores/edgeSelection.ts')).useEdgeSelectionStore.getState().selectedEdgeId), null)
    assert.equal(await page.evaluate(async () => (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().shapeId), 'shape:flow-review')
    // Switching settings through a canvas control label must preserve the click
    // even when a different owner's panel is already open.
    for (const owner of ['agent', 'state', 'review']) {
      await open(owner)
      await page.getByRole('button', { name: '配置控制关系：审核放行', exact: true }).click()
      assert.equal(await page.evaluate(async () => (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().shapeId), 'shape:flow-review')
    }
    await page.evaluate(async () => { (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.deleteShapes(['shape:flow-next']) })
    await page.waitForFunction(() => document.querySelectorAll('.agent-flow-control-path').length === 7)
    assert.ok((await settings.locator('[role="status"]').textContent()).includes('已删除'))
    await settings.getByRole('group', { name: '等待审核通过的节点', exact: true }).getByLabel('失效引用（可取消引用）', { exact: true }).click()
    await save()
    fs.mkdirSync(qaOutputPath('qa/canvas-agent-flow/C1'), { recursive: true })
    await page.screenshot({ path: qaOutputPath('qa/canvas-agent-flow/C1/control-relations.png') })
    fs.writeFileSync(qaOutputPath('qa/canvas-agent-flow/C1/declaration-results.json'), JSON.stringify({
      threeIndependentAgents: true, targetSelection: true, reviewSubjectsConnected: true, transitionsEdited: true, invalidTransitionBlocked: true,
      controlsSeparateFromData: true, dragAndZoom: true, snapshotRestored: true, missingTargetRepair: true,
      modelRequests: 0, runtimeExecution: false
    }, null, 2))
    console.log('C1 控制声明：目标/审核来源/阶段转换、虚线与数据边分离、拖动缩放、失效修复和快照恢复通过')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
