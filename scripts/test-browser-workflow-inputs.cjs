/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { launchQaBrowser } = require('./qa-browser.cjs')

;(async () => {
  const browser = await launchQaBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5295')
    await page.locator('.node-palette').waitFor()
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { createEdge } = await import('/src/canvas/graph.ts')
      const { useGatewayStore } = await import('/src/stores/gateway.ts')
      const provider = { id: 'fixture', name: 'Fixture', specId: 'toapis', models: [
        { id: 'text', modality: 'text' }, { id: 'image', modality: 'image' }
      ] }
      useGatewayStore.setState({ providers: [provider], loaded: true })
      window.api.models.resolveBinding = async ({ operation }) => {
        const modelId = operation === 'text.generate' ? 'text' : 'image'
        return { ok: true, data: { providerId: 'fixture', modelId, modelKey: `fixture::${modelId}` } }
      }
      window.workflowCalls = []
      window.workflowImages = []
      let listener
      window.api.gateway.onEvent = (callback) => { listener = callback; return () => { listener = undefined } }
      window.api.gateway.chatStart = async (input) => {
        window.workflowCalls.push(input.messages.at(-1).content)
        setTimeout(() => {
          listener?.({ kind: 'chat-delta', taskId: 'fixture-chat', text: '生成一张海边的图' })
          listener?.({ kind: 'chat-done', taskId: 'fixture-chat' })
        }, 100)
        return { ok: true, data: { taskId: 'fixture-chat' } }
      }
      window.api.gateway.imageGenerate = async (input) => {
        window.workflowCalls.push(input.prompt)
        window.workflowImages.push(input.referenceMediaIds)
        const image = document.createElement('canvas')
        image.width = image.height = 16
        const blob = await new Promise((resolve) => image.toBlob(resolve, 'image/png'))
        return window.api.importMediaBuffer({ projectId: input.projectId, data: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', name: 'fixture.png' })
      }
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      const nodes = [['text', '文本'], ['ai-process', 'AI 处理'], ['image-gen', '生图']]
      for (const [index, [type, title]] of nodes.entries()) {
        editor.createShape({ id: `shape:workflow-${type}`, type: 'node-card', x: 240 + index * 380, y: 270, props: { nodeType: type, title } })
      }
      if (!createEdge(editor, { shapeId: 'shape:workflow-text', portId: 'out-text' }, { shapeId: 'shape:workflow-ai-process', portId: 'in-text' }) ||
          !createEdge(editor, { shapeId: 'shape:workflow-ai-process', portId: 'out-text' }, { shapeId: 'shape:workflow-image-gen', portId: 'in-text' })) throw Error('fixture wiring failed')
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      editor.select(...nodes.map(([type]) => `shape:workflow-${type}`))
    })
    const plan = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { previewWorkflowInputs } = await import('/src/engine/executor.ts')
      return previewWorkflowInputs(editor, ['shape:workflow-image-gen'])
    })
    assert.equal(plan.nodeCount, 3)
    assert.deepEqual(plan.missing, [{ nodeId: 'shape:workflow-text', title: '文本', portId: 'in-text', label: '文本', type: 'text' }])
    await page.locator('.ms-run').click()
    const dialog = page.getByRole('dialog', { name: '补充运行输入' })
    await dialog.getByRole('textbox').fill('海边风景')
    await dialog.getByRole('button', { name: '继续运行' }).click()
    await page.waitForFunction(() => window.workflowCalls.length === 2)
    await page.getByText(/已运行所选流程/).waitFor()
    const state = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      return {
        calls: window.workflowCalls,
        text: editor.getShape('shape:workflow-text').props.text,
        artifacts: editor.getCurrentPageShapes().filter((shape) => shape.type === 'node-card' && !shape.id.startsWith('shape:workflow-')).map((shape) => shape.props.nodeType)
      }
    })
    assert.deepEqual(state.calls, ['海边风景', '生成一张海边的图'])
    assert.equal(state.text, '')
    assert.deepEqual(state.artifacts, ['image'])
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { createEdge } = await import('/src/canvas/graph.ts')
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.createShape({ id: 'shape:workflow-source', type: 'node-card', x: 240, y: 270, props: { nodeType: 'image', title: '原图' } })
      editor.createShape({ id: 'shape:workflow-gen', type: 'node-card', x: 620, y: 270, props: { nodeType: 'image-gen', title: '生图', text: '参考原图' } })
      if (!createEdge(editor, { shapeId: 'shape:workflow-source', portId: 'out-image' }, { shapeId: 'shape:workflow-gen', portId: 'in-images' })) throw Error('image wiring failed')
      editor.select('shape:workflow-source', 'shape:workflow-gen')
    })
    await page.locator('.ms-run').click()
    await dialog.getByRole('button', { name: '取消运行' }).click()
    await page.getByText('子图运行已停止', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.workflowCalls.length), 2)
    await page.locator('.ms-run').click()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
    await dialog.locator('input[type=file]').setInputFiles({ name: '参考图.png', mimeType: 'image/png', buffer: png })
    await dialog.getByRole('button', { name: '继续运行' }).click()
    await page.waitForFunction(() => window.workflowCalls.length === 3)
    assert.equal((await page.evaluate(() => window.workflowImages.at(-1))).length, 1)
    assert.equal(await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      return editor.getShape('shape:workflow-source').props.mediaId
    }), '')
    await page.waitForFunction(async () => (await import('/src/engine/store.ts')).useEngineStore.getState().phase === 'idle')
    const external = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { runWorkflowForNodes } = await import('/src/engine/executor.ts')
      const project = (await import('/src/stores/app.ts')).useAppStore.getState().currentProject
      const nodeId = 'shape:workflow-external'
      editor.createShape({ id: nodeId, type: 'node-card', x: 900, y: 270, props: { nodeType: 'text', text: '固定正文' } })
      const status = await runWorkflowForNodes(editor, project.id, [], [nodeId], {
        inputs: [{ nodeId, portId: 'in-text', value: { kind: 'text', text: '本次调用' } }]
      })
      return { status, text: editor.getShape(nodeId).props.text }
    })
    assert.deepEqual(external, { status: 'completed', text: '固定正文' })
    await page.evaluate(() => {
      window.api.workspace.listTemplates = async () => ({ ok: true, data: [{
        id: 'saved-fixture', name: '保存的文案模板', createdAt: 1, nodeCount: 1, edges: [],
        nodes: [{ nodeType: 'text', title: '模板输入', dx: 0, dy: 0, w: 340, h: 260 }]
      }] })
    })
    await page.getByRole('button', { name: '打开节点库', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索节点库' }).fill('文案模板')
    await page.getByRole('button', { name: '运行 保存的文案模板' }).click()
    await dialog.getByRole('textbox').fill('只用于模板运行')
    await dialog.getByRole('button', { name: '继续运行' }).click()
    await page.getByText('已运行所选流程（1 个节点）', { exact: true }).first().waitFor()
    console.log('Selected workflow: transient text, real graph edges, one final image, no intermediate document card')
  } finally {
    await browser.close()
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })
