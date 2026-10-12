/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1900, height: 1050 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5196')
    await page.waitForSelector('.tl-canvas')
    await page.evaluate(async () => {
      // UI-only adapter. Production SQLite, IPC and process reopening are checked separately.
      const versions = new Map(), submissions = new Map()
      let ordinal = 0, dropReceipt = false
      window.__assetUiFixture = { versions, submissions, dropNext: () => { dropReceipt = true } }
      window.api.listFlowAssets = async () => ({ ok: true, data: [...versions.values()].reverse().map(({ value, ...summary }) => { void value; return summary }) })
      window.api.readFlowAsset = async ({ versionId }) => ({ ok: true, data: versions.get(versionId) })
      window.api.submitFlowAsset = async (input) => {
        if (submissions.has(input.submissionId)) return { ok: true, data: submissions.get(input.submissionId) }
        const file = (await window.api.openProject(input.projectId)).data
        const shape = file.tldrawSnapshot.store[input.nodeId]
        const output = (await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(shape)[input.portId]
        const version = { projectId: input.projectId, ordinal: ++ordinal, graphVersion: input.expectedGraphVersion, createdAt: Date.now(), digest: 'ui-fixture', ref: { assetId: 'ui-asset', versionId: `ui-v${ordinal}`, sourceNodeId: input.nodeId, sourcePortId: input.portId }, value: JSON.parse(JSON.stringify(output)) }
        versions.set(version.ref.versionId, version); submissions.set(input.submissionId, version)
        if (dropReceipt) { dropReceipt = false; throw new Error('fixture receipt gap') }
        return { ok: true, data: version }
      }
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.createShape({ id: 'shape:asset-source', type: 'node-card', x: 100, y: 130, props: { nodeType: 'text', title: '人工材料', text: '材料 v1' } })
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      ;(await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().open('contract', 'shape:asset-source', 'overview')
    })
    await page.getByRole('tab', { name: '输入输出', exact: true }).click()
    const panel = page.locator('.flow-asset-panel')
    await panel.getByRole('button', { name: '提交当前输出为新版本' }).click()
    await panel.getByText('当前查看 v1', { exact: false }).waitFor()
    assert.equal(await panel.locator('pre').innerText(), '材料 v1')
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.updateShape({ id: 'shape:asset-source', type: 'node-card', props: { text: '材料 v2' } })
      window.__assetUiFixture.dropNext()
    })
    await panel.getByRole('button', { name: '提交当前输出为新版本' }).click()
    await panel.getByRole('alert').waitFor()
    assert.match(await panel.getByRole('alert').innerText(), /不会生成重复版本/)
    await panel.getByRole('button', { name: '提交当前输出为新版本' }).click()
    await panel.getByText('当前查看 v2', { exact: false }).waitFor()
    assert.equal(await page.evaluate(() => window.__assetUiFixture.versions.size), 2)
    await panel.getByLabel('已提交资产版本').click()
    await page.getByRole('option', { name: /^v1 ·/ }).click()
    await panel.getByText('当前查看 v1', { exact: false }).waitFor()
    await panel.getByRole('button', { name: '将此版本放到画布' }).click()
    const evidence = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { projectNodeOutputs } = await import('/src/nodes/nodeValues.ts')
      const pinned = editor.getCurrentPageShapes().find((shape) => shape.type === 'node-card' && shape.meta.flowAssetRef)
      if (!pinned) throw new Error('fixed asset missing')
      const first = projectNodeOutputs(pinned)
      editor.updateShape({ id: pinned.id, type: 'node-card', props: { text: '用户后来修改正文' } })
      const edited = projectNodeOutputs(editor.getShape(pinned.id))
      // Link by declared ports and run the normal executor: no second processing path.
      editor.createShape({ id: 'shape:asset-target', type: 'node-card', x: 1000, y: 130, props: { nodeType: 'processor', title: '加工资产', config: JSON.stringify({ operation: 'template', valueType: 'any', fallback: '', path: '', template: '结果：{{value}}' }) } })
      if (!(await import('/src/canvas/graph.ts')).createEdge(editor, { shapeId: pinned.id, portId: 'out-text' }, { shapeId: 'shape:asset-target', portId: 'in-value' })) throw new Error('asset port connection failed')
      const result = await (await import('/src/engine/executor.ts')).runNodeManually(editor, 'demo', [], 'shape:asset-target')
      const output = projectNodeOutputs(editor.getShape('shape:asset-target'))
      const snapshot = JSON.parse(JSON.stringify(editor.store.getStoreSnapshot('document')))
      editor.store.loadStoreSnapshot(snapshot)
      editor.updateViewportScreenBounds(editor.getContainer())
      const reopened = projectNodeOutputs(editor.getShape(pinned.id))
      return { first, edited, reopened, result, output, ref: JSON.parse(pinned.meta.flowAssetRef), pinnedId: pinned.id }
    })
    assert.deepEqual(evidence.first, { 'out-text': { kind: 'text', text: '材料 v1' } })
    assert.deepEqual(evidence.edited, evidence.first)
    assert.deepEqual(evidence.reopened, evidence.first)
    assert.equal(evidence.result.status, 'done')
    assert.equal(evidence.output['out-value'].text, '结果：材料 v1')
    const fixed = page.locator(`[data-node-id="${evidence.pinnedId}"]`)
    await page.waitForTimeout(120)
    assert.equal(await fixed.locator('.fixed-flow-asset-body .node-text-body').innerText(), '材料 v1')
    await page.evaluate(async () => { (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.selectNone() })
    const content = await fixed.locator('.fixed-flow-asset-body .node-text-body').boundingBox()
    await page.mouse.click(content.x + 15, content.y + 8)
    assert.ok(await page.evaluate(async (id) => (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getSelectedShapeIds().includes(id), evidence.pinnedId))
    const before = await page.evaluate(async (id) => { const shape = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getShape(id); return { x: shape.x, y: shape.y } }, evidence.pinnedId)
    await page.mouse.move(content.x + 15, content.y + 8); await page.mouse.down()
    await page.mouse.move(content.x + 55, content.y + 38, { steps: 8 }); await page.mouse.up()
    const after = await page.evaluate(async (id) => { const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor; const shape = editor.getShape(id); return { x: shape.x, y: shape.y, h: shape.props.h, edges: (await import('/src/canvas/graph.ts')).deriveGraph(editor).edges.map(edge => ({ from: edge.from, to: edge.to })), selected: editor.getSelectedShapeIds() } }, evidence.pinnedId)
    assert.ok(after.x > before.x + 25 && after.y > before.y + 15, JSON.stringify({ before, after, content }))
    assert.equal(await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      return (await import('/src/canvas/graph.ts')).deriveGraph(editor).edges.length
    }), 1, 'moving a fixed asset must not attach new input edges')
    await fixed.getByRole('button', { name: '创建可编辑副本', exact: true }).click()
    const draftId = await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getCurrentPageShapes().find((shape) => shape.type === 'node-card' && shape.props.title === '资产草稿').id)
    const draft = page.locator(`[data-node-id="${draftId}"]`)
    await page.evaluate(async (id) => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.centerOnPoint(editor.getShapePageBounds(id).center, { animation: { duration: 0 } })
    }, draftId)
    await draft.getByRole('button', { name: '编辑文本', exact: true }).click()
    await draft.locator('textarea').fill('材料 v3')
    await draft.getByRole('button', { name: '保存文本', exact: true }).click()
    const copied = await page.evaluate(async ({ draftId, pinnedId }) => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { projectNodeOutputs } = await import('/src/nodes/nodeValues.ts')
      return { draft: projectNodeOutputs(editor.getShape(draftId)), fixed: projectNodeOutputs(editor.getShape(pinnedId)), pinned: Boolean(editor.getShape(draftId).meta.pinnedOutput) }
    }, { draftId, pinnedId: evidence.pinnedId })
    assert.equal(copied.draft['out-text'].text, '材料 v3'); assert.deepEqual(copied.fixed, evidence.first); assert.equal(copied.pinned, false)
    await page.evaluate(async () => { (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.zoomToFit({ animation: { duration: 0 } }) })
    const jsonId = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { placeFlowAsset } = await import('/src/canvas/flow-asset-actions.ts')
      const id = placeFlowAsset(editor, { projectId: 'demo', ordinal: 1, graphVersion: 1, createdAt: Date.now(), digest: 'ui-json', ref: { assetId: 'ui-json', versionId: 'ui-json-v1', sourceNodeId: 'shape:asset-source', sourcePortId: 'out-json' }, value: { kind: 'json', data: { zero: 0, flag: false } } }, 'shape:asset-source')
      editor.centerOnPoint(editor.getShapePageBounds(id).center, { animation: { duration: 0 } })
      return id
    })
    const jsonAsset = page.locator(`[data-node-id="${jsonId}"]`)
    assert.match(await jsonAsset.locator('.fixed-flow-asset-body .node-text-body').innerText(), /"flag": false/)
    await jsonAsset.getByRole('button', { name: '创建可编辑副本', exact: true }).click()
    const jsonDraftId = await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.getCurrentPageShapes().find((shape) => shape.type === 'node-card' && shape.props.nodeType === 'json' && shape.props.title === '资产草稿').id)
    await page.evaluate(async (id) => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.centerOnPoint(editor.getShapePageBounds(id).center, { animation: { duration: 0 } })
    }, jsonDraftId)
    const jsonDraft = page.locator(`[data-node-id="${jsonDraftId}"]`)
    await jsonDraft.getByRole('button', { name: '编辑数据', exact: true }).click()
    await jsonDraft.locator('textarea').fill('{"zero":2,"flag":true}')
    await jsonDraft.locator('textarea').blur()
    assert.deepEqual(await page.evaluate(async (id) => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      return (await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(editor.getShape(id))
    }, jsonDraftId), { 'out-json': { kind: 'json', data: { zero: 2, flag: true } } })
    assert.deepEqual(await page.evaluate(async (id) => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      return (await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(editor.getShape(id))
    }, jsonId), { 'out-json': { kind: 'json', data: { zero: 0, flag: false } } })
    await page.evaluate(async () => { (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.zoomToFit({ animation: { duration: 0 } }) })
    fs.mkdirSync('qa/canvas-agent-flow/C2', { recursive: true })
    fs.writeFileSync('qa/canvas-agent-flow/C2/browser-assets-results.json', JSON.stringify({ fixedOutputs: true, duplicateReceiptGapHandled: true, ordinaryPortConnection: true, manualExecutor: true, snapshotRestored: true, boundary: 'UI adapter only; production IPC/SQLite verified by separate Electron acceptance' }, null, 2))
    await page.screenshot({ path: 'qa/canvas-agent-flow/C2/fixed-asset-canvas.png' })
    console.log('Asset UI: submit v1/v2, receipt-gap retry, fixed version, port connection, normal executor and snapshot reopening passed.')
  } finally { await browser.close() }
})().catch((error) => { console.error(error); process.exitCode = 1 })
