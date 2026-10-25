/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { mkdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { launchQaBrowser } = require('./qa-browser.cjs')
const { qaOutputPath } = require('./qa-output.cjs')

;(async () => {
  const browser = await launchQaBrowser()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const evidence = qaOutputPath('qa/local-reliability/stop-admission')
  await mkdir(evidence, { recursive: true })
  try {
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5194')
    await page.locator('.node-palette').waitFor()
    await page.evaluate(async () => {
      document.title = '[TEST] Local stop admission'
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.createShape({ id: 'shape:local-stop', type: 'node-card', x: 360, y: 170,
        props: { nodeType: 'text', text: 'local stop fixture' } })
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      const state = window.__localStop = { calls: 0, waiting: false, release: null }
      const spec = (await import('/src/nodes/registry.tsx')).getNodeType('text')
      const original = spec.executor
      spec.executor = async (context) => { state.calls++; return original(context) }
      window.api.checkFlowNodeAvailability = async () => {
        if (!state.waiting) {
          state.waiting = true
          await new Promise((resolve) => { state.release = resolve })
        }
        return { ok: true, data: true }
      }
    })
    await page.getByRole('button', { name: '运行', exact: true }).click()
    await page.waitForFunction(() => window.__localStop.waiting && window.__localStop.release)
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await page.evaluate(() => window.__localStop.release())
    await page.waitForFunction(async () =>
      (await import('/src/engine/store.ts')).useEngineStore.getState().phase === 'idle')
    const stopped = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const shape = editor.getShape('shape:local-stop')
      return { calls: window.__localStop.calls, exec: shape.props.exec, hasRun: !!shape.meta.nodeRun,
        tasks: (await import('/src/engine/resource-queue.ts')).useResourceQueue.getState().tasks.length }
    })
    assert.deepEqual(stopped, { calls: 0, exec: 'cancelled', hasRun: false, tasks: 0 })
    await page.screenshot({ path: join(evidence, 'stopped-before-executor.png') })
    await page.locator('[data-node-id="shape:local-stop"] .node-text').dblclick()
    await page.locator('textarea.node-textarea').fill('edited after stopping')
    await page.keyboard.press('Control+Enter')
    await page.getByRole('button', { name: '运行', exact: true }).click()
    await page.waitForFunction(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      return editor.getShape('shape:local-stop')?.meta.nodeRun?.status === 'success'
    })
    const rerun = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      return { calls: window.__localStop.calls, text: editor.getShape('shape:local-stop').props.text,
        tasks: (await import('/src/engine/resource-queue.ts')).useResourceQueue.getState().tasks.length }
    })
    assert.deepEqual(rerun, { calls: 1, text: 'edited after stopping', tasks: 0 })
    await page.screenshot({ path: join(evidence, 'edited-and-rerun.png') })
    await writeFile(join(evidence, 'report.json'), JSON.stringify({ status: 'passed', stopped, rerun }, null, 2))
    process.stdout.write('Local canvas stop: no executor after stop, released resources, editable and rerunnable passed.\n')
  } finally { await browser.close() }
})().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1 })
