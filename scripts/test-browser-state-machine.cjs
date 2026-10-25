/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// P2-A 状态机独立执行的真实画布验收：配置声明迁移 → 卡片提交事件 →
// 运行节点推进阶段 → JSON 快照重开一致 → 修订冲突恢复 → 完成阶段。
const assert = require('node:assert/strict')
const { mkdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { launchQaBrowser } = require('./qa-browser.cjs')
const { qaOutputPath } = require('./qa-output.cjs')
;(async () => {
  const browser = await launchQaBrowser()
  const evidence = qaOutputPath('qa/local-reliability/state-machine-standalone')
  await mkdir(evidence, { recursive: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5194')
    await page.locator('.node-palette').waitFor()

    // 1) 建节点并首次运行：初始化权威实例，投影 out-state。
    await page.evaluate(async () => {
      document.title = '[TEST] State machine standalone execution'
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const engine = await import('/src/engine/executor.ts')
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      const { projectNodeOutputs } = await import('/src/nodes/nodeValues.ts')
      const spec = getNodeType('state-machine')
      const config = JSON.stringify({
        ...JSON.parse(spec.initialConfig),
        schemaVersion: 1,
        initialState: 'draft',
        states: ['draft', 'working', 'completed'],
        transitions: [
          { from: 'draft', event: 'start', to: 'working' },
          { from: 'working', event: 'finish', to: 'completed' }
        ],
        relations: []
      })
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.createShape({
        id: 'shape:sm-e2e',
        type: 'node-card',
        x: 300,
        y: 180,
        props: { nodeType: 'state-machine', title: '状态机', config, text: '' }
      })
      editor.setCamera({ x: 0, y: 0, z: 0.9 }, { immediate: true })
      const first = await engine.runNodeManually(editor, 'demo', [], 'shape:sm-e2e')
      if (first.status !== 'done') throw new Error('SM_FIRST_RUN:' + first.reason)
      const shape = editor.getShape('shape:sm-e2e')
      const inst = shape.meta?.stateMachine ? JSON.parse(String(shape.meta.stateMachine)) : null
      if (!inst || inst.state !== 'draft' || inst.revision !== 1) {
        throw new Error('SM_INIT_INVALID:' + JSON.stringify(inst))
      }
      const outState = projectNodeOutputs(shape)['out-state']
      if (!outState || outState.data?.state !== 'draft') throw new Error('SM_OUT_STATE_MISSING')
    })

    // 2) 真实点击卡片按钮提交事件；pending 只入 meta，状态不动。
    const wrap = page.locator('[data-node-id="shape:sm-e2e"]')
    await wrap.getByRole('button', { name: /提交事件「start」/ }).click()
    const staged = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const shape = editor.getShape('shape:sm-e2e')
      const inst = shape.meta?.stateMachine ? JSON.parse(String(shape.meta.stateMachine)) : null
      return {
        staged: Boolean(shape.meta?.stateMachinePending),
        still: inst?.state,
        revision: inst?.revision
      }
    })
    assert.equal(staged.staged, true, 'SM_PENDING_NOT_STAGED')
    assert.equal(staged.still, 'draft', 'SM_STAGED_PREMATURE')
    assert.equal(staged.revision, 1, 'SM_STAGED_REVISION_CHANGED')

    // 3) 再次运行：消费提交、推进到 working、pending 清除。
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const engine = await import('/src/engine/executor.ts')
      const second = await engine.runNodeManually(editor, 'demo', [], 'shape:sm-e2e')
      if (second.status !== 'done') throw new Error('SM_SECOND_RUN:' + second.reason)
      const shape = editor.getShape('shape:sm-e2e')
      const inst = JSON.parse(String(shape.meta.stateMachine))
      if (inst.state !== 'working' || inst.revision !== 2 || !inst.lastEventId) {
        throw new Error('SM_TRANSITION_INVALID:' + JSON.stringify(inst))
      }
      // tldraw meta 浅合并：消费后写空串而不是删键。
      if (shape.meta?.stateMachinePending !== '') throw new Error('SM_PENDING_NOT_CONSUMED')
    })
    await page.screenshot({ path: join(evidence, 'stage-working.png') })

    // 4) 保存 → JSON 快照重开：实例与运行记录按原样恢复。
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const saved = JSON.parse(JSON.stringify(editor.store.getStoreSnapshot('document')))
      editor.store.loadStoreSnapshot(saved)
      const shape = editor.getShape('shape:sm-e2e')
      const inst = JSON.parse(String(shape.meta.stateMachine))
      if (inst.state !== 'working' || inst.revision !== 2) throw new Error('SM_REOPEN_DRIFT')
      if (shape.meta?.nodeRun?.status !== 'success') throw new Error('SM_REOPEN_RUN_LOST')
    })

    // 5) 基于过期修订的提交被明确拒绝，实例不被污染。
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const engine = await import('/src/engine/executor.ts')
      editor.updateShape({
        id: 'shape:sm-e2e',
        type: 'node-card',
        meta: {
          ...(editor.getShape('shape:sm-e2e').meta ?? {}),
          stateMachinePending: JSON.stringify({
            eventId: 'stale-event',
            event: 'finish',
            expectedRevision: 1
          })
        }
      })
      const stale = await engine.runNodeManually(editor, 'demo', [], 'shape:sm-e2e')
      if (stale.status !== 'failed') throw new Error('SM_STALE_ACCEPTED')
      if (!String(stale.reason).includes('状态修订冲突')) throw new Error('SM_STALE_REASON')
      const shape = editor.getShape('shape:sm-e2e')
      if (JSON.parse(String(shape.meta.stateMachine)).state !== 'working') {
        throw new Error('SM_STALE_MUTATED')
      }
    })

    // 6) 正确修订的提交恢复推进：finish → completed。
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const engine = await import('/src/engine/executor.ts')
      editor.updateShape({
        id: 'shape:sm-e2e',
        type: 'node-card',
        meta: {
          ...(editor.getShape('shape:sm-e2e').meta ?? {}),
          stateMachinePending: JSON.stringify({
            eventId: 'evt-finish',
            event: 'finish',
            expectedRevision: 2
          })
        }
      })
      const finish = await engine.runNodeManually(editor, 'demo', [], 'shape:sm-e2e')
      if (finish.status !== 'done') throw new Error('SM_FINISH_RUN:' + finish.reason)
      const shape = editor.getShape('shape:sm-e2e')
      const inst = JSON.parse(String(shape.meta.stateMachine))
      if (inst.state !== 'completed' || inst.revision !== 3) {
        throw new Error('SM_FINISH_INVALID:' + JSON.stringify(inst))
      }
    })
    await page.screenshot({ path: join(evidence, 'stage-completed.png') })
    const report = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const shape = editor.getShape('shape:sm-e2e')
      const inst = JSON.parse(String(shape.meta.stateMachine))
      return { finalState: inst.state, revision: inst.revision, history: inst.history.length }
    })
    assert.equal(report.finalState, 'completed')
    await writeFile(join(evidence, 'report.json'), JSON.stringify({ status: 'passed', ...report }, null, 2))
    process.stdout.write('状态机独立执行：卡片提交事件、运行推进、快照重开、修订冲突恢复与完成全部通过。\n')
  } finally { await browser.close() }
})().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1 })
