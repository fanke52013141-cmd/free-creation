/* eslint-disable */
// C4 纯人工任务节点桌面级验收（无需真实模型/计费）：
// 停等语义 + 外部 humanTask.submit/get（与 GUI 同一 pending 写入）+ 修订防过期 + composite fail-closed。
// 前置：CANVAS_OWNER=1 构建。运行：node scripts/acceptance/agent-flow-human-task.cjs
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const packagedExe = process.env.CANVAS_ACCEPTANCE_PACKAGED_EXE
  ? path.resolve(process.env.CANVAS_ACCEPTANCE_PACKAGED_EXE)
  : null
const cliEntry = packagedExe
  ? path.join(path.dirname(packagedExe), 'resources', 'app', 'out', 'main', 'local-agent.js')
  : path.join(root, 'out', 'main', 'local-agent.js')
const evidenceDir = path.join(root, 'qa',
  process.env.CANVAS_ACCEPTANCE_MEDIA === '1' ? 'packaged-human-task-media' :
    packagedExe ? 'packaged-human-task-restart' : 'agent-flow-human-task')
const key = () => `${Date.now()}:${randomUUID()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cli(dir, args, input) {
  const file = path.join(dir, `input-${randomUUID()}.json`)
  if (input) fs.writeFileSync(file, JSON.stringify({ input, idempotencyKey: key() }))
  return await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [
      cliEntry,
      ...args, '--data-dir', dir,
      ...(input ? ['--input-file', file] : [])
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI_TIMEOUT')) }, 90000)
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err = (err + c).slice(-1000)))
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      try { resolve({ code, response: JSON.parse(out), err }) } catch { resolve({ code, response: null, raw: out, err }) }
    })
  })
}
const ok = (res, label) => {
  if (res.code !== 0 || !res.response || res.response.error)
    throw new Error(`${label}:${JSON.stringify(res.response || res).slice(0, 700)}`)
  return res.response.data
}
async function patchWithRetry(dir, projectId, ops, label) {
  let last = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const graph = ok(await cli(dir, ['graph', 'get'], { projectId }), `${label}_GRAPH`)
    const res = await cli(dir, ['graph', 'patch'], { projectId, expectedGraphVersion: graph.graphVersion, ops })
    if (res.code === 0 && !res.response?.error) return res.response.data
    last = res
    if (res.response?.error?.code !== 'REVISION_CONFLICT') break
    await sleep(400)
  }
  throw new Error(`${label}:${JSON.stringify(last?.response || last).slice(0, 600)}`)
}
async function runNode(dir, projectId, nodeId) {
  const g = ok(await cli(dir, ['graph', 'get'], { projectId }), 'RUN_GRAPH')
  const exec = ok(await cli(dir, ['node', 'execute'], {
    projectId, expectedGraphVersion: g.graphVersion, nodeIds: [nodeId], mode: 'single'
  }), 'EXECUTE')
  let waited = null
  for (let i = 0; i < 10; i++) {
    waited = ok(await cli(dir, ['run', 'wait'], { projectId, taskId: exec.taskId, timeoutMs: 30000 }), 'WAIT')
    if (waited.state === 'completed' || waited.state === 'failed') break
    await sleep(1500)
  }
  return waited
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-human-task-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  if (!packagedExe) await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  let app
  const receipt = { mode: 'deterministic (no model, no billing)', checks: [], outputs: {} }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  const assert = (cond, label) => { if (!cond) throw new Error(`ASSERT_FAILED:${label}`); check(label) }
  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    const launch = async () => {
      app = await _electron.launch({
        executablePath: packagedExe ?? require('electron'),
        args: [
          ...(packagedExe ? ['--disable-gpu', '--disable-gpu-sandbox',
            `--user-data-dir=${path.join(dir, 'chromium')}`] : [root]),
          '--local-agent-access'
        ],
        env: launchEnv
      })
      const window = await app.firstWindow()
      await window.waitForLoadState()
      await app.evaluate(({ BrowserWindow }) => {
        for (const current of BrowserWindow.getAllWindows()) current.setTitle('[TEST] C4 人工任务节点')
      })
      for (let i = 0; i < 100; i++) {
        if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) return window
        await sleep(200)
      }
      throw new Error('CONNECTION_NOT_READY')
    }
    const page = await launch()

    const created = ok(await cli(dir, ['project', 'create'], { name: '[TEST] C4 人工任务' }), 'CREATE')
    const projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'OPEN')
    const batch = await patchWithRetry(dir, projectId, [
      { action: 'node.create', ref: 'h1', nodeType: 'human-task', title: '人工审核', x: 200, y: 100,
        config: { schemaVersion: 1, outputType: 'text', humanRole: 'editor', instructions: '请人工填写审核结论。' } },
      { action: 'node.create', ref: 'h2', nodeType: 'human-task', title: 'Reviewer inbox fixture', x: 800, y: 900,
        config: { schemaVersion: 1, outputType: 'text', humanRole: 'reviewer' } }
    ], 'BATCH')
    const h1 = Object.fromEntries(batch.created.map((c) => [c.ref, c.nodeId])).h1
    check('创建 human-task 一等节点（text 输出）')

    // 停等：未提交先运行 → 节点跳过，不伪造完成。
    await runNode(dir, projectId, h1)
    let view = ok(await cli(dir, ['humanTask', 'get'], { projectId, nodeId: h1 }), 'GET1')
    receipt.outputs.beforeSubmit = view
    assert(view.status === 'pending' && view.revision === 1, `未提交停等（status=${view.status}, revision=${view.revision}）`)
    const out0 = ok(await cli(dir, ['output', 'get'], { projectId, nodeId: h1 }), 'OUT0')
    assert(!(out0.outputs || []).some((o) => o.portId === 'out-text'), '未提交不产生公开输出（不伪造成功）')
    await page.getByRole('button', { name: '打开待你处理收件箱' }).click()
    const roleFilter = page.getByLabel('查看角色')
    await roleFilter.selectOption('reviewer')
    assert(await roleFilter.inputValue() === 'reviewer', '收件箱已切换到 reviewer 角色')

    // 外部提交（与 GUI 同一 pending 写入）→ 运行 → 正式交付。
    // BL-01：外部提交会先弹人工确认，必须由人在窗口里点「允许提交」；这里扮演人。
    // 客户端按交互式操作等待（shared/agent-access/interactive），不会 15s 就报 OUTCOME_UNKNOWN。
    const submitPending = cli(dir, ['humanTask', 'submit'], {
      projectId, nodeId: h1, expectedRevision: 1, value: { kind: 'text', text: '人工审核结论：通过。' }
    })
    await page.getByRole('button', { name: '允许提交' }).click({ timeout: 60000 })
    const sub = ok(await submitPending, 'SUBMIT')
    assert(sub.pending === true, '外部提交写入待处理（pending=true）')
    const repeat = async (text) => {
      const pending = cli(dir, ['humanTask', 'submit'], {
        projectId, nodeId: h1, expectedRevision: 1, value: { kind: 'text', text }
      })
      await page.getByRole('button', { name: '允许提交' }).click({ timeout: 60000 })
      return pending
    }
    const replay = ok(await repeat('人工审核结论：通过。'), 'SUBMIT_REPLAY')
    assert(replay.submissionId === sub.submissionId, 'Duplicate canvas submission returns its original ID')
    const conflict = await repeat('不同的结果')
    assert(conflict.response?.error?.code === 'HUMAN_TASK_SUBMISSION_CONFLICT',
      'A competing canvas submission cannot replace the queued result')
    await runNode(dir, projectId, h1)
    view = ok(await cli(dir, ['humanTask', 'get'], { projectId, nodeId: h1 }), 'GET2')
    receipt.outputs.afterSubmit = view
    assert(view.status === 'completed' && view.revision === 2, `提交后运行完成（status=${view.status}, revision=${view.revision}）`)
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'projects', projectId, 'project.json'), 'utf8'))
    const { actor } = JSON.parse(file.tldrawSnapshot.store[h1].meta.humanTask)
    assert(actor?.kind === 'user' && actor.roleId === 'editor', '提交记录归属节点声明的 editor 角色')
    receipt.outputs.humanActor = actor
    const out1 = ok(await cli(dir, ['output', 'get'], { projectId, nodeId: h1 }), 'OUT1')
    const textOut = (out1.outputs || []).find((o) => o.portId === 'out-text' && o.kind === 'text')
    receipt.outputs.deliveredText = textOut?.text
    assert(textOut && textOut.text === '人工审核结论：通过。', '公开 out-text 投影人工交付结果')

    // 修订防过期：基于旧修订 1 的提交被拒绝。
    // 人工决定先于修订判定，所以这里也要人点一次「允许提交」；拒绝后不产生任何写入。
    const stalePending = cli(dir, ['humanTask', 'submit'], {
      projectId, nodeId: h1, expectedRevision: 1, value: { kind: 'text', text: '过期提交' }
    })
    await page.getByRole('button', { name: '允许提交' }).click({ timeout: 60000 })
    const stale = await stalePending
    assert(stale.response?.error?.code === 'HUMAN_TASK_REVISION_CONFLICT', `过期修订提交拒绝（${stale.response?.error?.code}）`)

    // composite fail-closed：内部 human-task 显式拒绝（隔离执行无人工通道）。
    const manifest = {
      schemaVersion: 1, runtimeVersion: 2, capabilityId: 'human-flow', version: '1.0', name: '含人工节点流',
      inputs: [], outputs: [{ id: 'res', label: '结果', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'hn1', portId: 'out-text' } }],
      graph: { nodes: [{ id: 'hn1', nodeType: 'human-task', contractVersion: 1, title: '人工', dx: 0, dy: 0, w: 340, h: 300,
        config: JSON.stringify({ schemaVersion: 1, outputType: 'text' }),
        ports: [
          { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: false, cardinality: 'many' },
          { id: 'in-json', name: 'JSON', dir: 'in', type: 'json', required: false, cardinality: 'one', schemaRef: { id: 'json.any', version: 1 } },
          { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: false, cardinality: 'one' },
          { id: 'out-json', name: 'JSON', dir: 'out', type: 'json', required: false, cardinality: 'one', schemaRef: { id: 'json.any', version: 1 } }
        ] }], edges: [] },
      dependencies: [{ kind: 'node', id: 'human-task', contractVersion: 1 }],
      executionPolicy: { timeoutMs: 60000, maxDepth: 5, maxExpandedNodes: 40, maxExpandedEdges: 120, waitForInput: true }
    }
    const validation = await cli(dir, ['composite', 'validate'], { manifest })
    if (validation.response?.data?.ok !== true)
      throw new Error(`MANIFEST_INVALID:${JSON.stringify(validation.response?.data ?? validation.response).slice(0, 500)}`)
    ok(await cli(dir, ['composite', 'publish'], { manifest }), 'PUBLISH')
    const batch2 = await patchWithRetry(dir, projectId, [
      { action: 'node.create', ref: 'inst', nodeType: 'composite', title: '含人工节点流', x: 600, y: 100,
        config: { capabilityId: 'human-flow', version: '1.0' } }
    ], 'BATCH2')
    const inst = Object.fromEntries(batch2.created.map((c) => [c.ref, c.nodeId])).inst
    // AF-07（2026-11-13 起）：节点流内部的人工任务不再 fail-closed，而是停在人工等待；
    // 运行记录保持 waiting-input，由人工提交 + 续跑消费。
    // 注意：外部 node-run 状态枚举没有 waiting，节点执行按暂停记账并透出等待原因
    // （与纯 human-task 停等同一口径），真相以 composite.run.get 的 waiting-input 为准。
    const waited = await runNode(dir, projectId, inst)
    assert(waited.state === 'failed', `节点流停在人工等待（运行 ${waited.state}）`)
    assert(
      String(waited.error ?? '').includes('等待人工任务'),
      `等待原因可读（${waited.error}）`
    )
    const runs = ok(await cli(dir, ['composite', 'run', 'list'], { projectId, limit: 5 }), 'RUN_LIST')
    const runId = runs[0].id
    let detail = ok(await cli(dir, ['composite', 'run', 'get'], { runId }), 'RUN_GET')
    assert(detail.run.status === 'waiting-input', `等待人工（status=${detail.run.status}）`)
    assert(detail.run.errorCode === null, `等待不是失败（code=${detail.run.errorCode}）`)
    if (packagedExe) {
      await app.close()
      app = null
      await launch()
      ok(await cli(dir, ['project', 'open'], { projectId }), 'REOPEN_PROJECT')
      const recovered = ok(await cli(dir, ['composite', 'run', 'get'], { runId }), 'GET_AFTER_RESTART')
      assert(recovered.run.status === 'waiting-input', '打包应用重启后保留同一个待人工子运行')
    }
    const submittedHuman = ok(await cli(dir, ['composite', 'run', 'submitHuman'], {
      runId, nodeId: 'hn1', value: { kind: 'text', text: '人工审核结论：通过。' }
    }), 'SUBMIT_HUMAN')
    assert(submittedHuman.satisfied === true, '人工提交满足开放等待')
    const repeatedWait = ok(await cli(dir, ['composite', 'run', 'submitHuman'], {
      runId, nodeId: 'hn1', value: { kind: 'text', text: '人工审核结论：通过。' }
    }), 'HUMAN_WAIT_REPLAY')
    assert(repeatedWait.satisfied === true, 'An identical node-flow submission reuses the satisfied wait')
    const conflictingWait = await cli(dir, ['composite', 'run', 'submitHuman'], {
      runId, nodeId: 'hn1', value: { kind: 'text', text: '不同的结果' }
    })
    assert(conflictingWait.response?.error?.code === 'WAIT_SUBMISSION_CONFLICT',
      'A competing node-flow submission cannot replace a satisfied wait')
    ok(await cli(dir, ['composite', 'run', 'resume'], { runId }), 'RESUME')
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      detail = ok(await cli(dir, ['composite', 'run', 'get'], { runId }), 'RUN_GET_FINAL')
      if (detail.run.status === 'completed' || detail.run.status === 'failed') break
    }
    receipt.outputs.compositeResume = {
      status: detail.run.status,
      steps: detail.steps.map((step) => ({ key: step.stepKey, status: step.status })),
      output: detail.run.outputValues?.res ?? null
    }
    assert(detail.run.status === 'completed', `续跑完成（status=${detail.run.status}）`)
    const resumedText = detail.run.outputValues?.res
    assert(
      resumedText?.kind === 'text' && resumedText.text === '人工审核结论：通过。',
      '续跑把人工提交消费为正式公开输出'
    )
    assert(
      detail.steps.some((step) => step.stepKey === 'hn1' && step.status === 'completed'),
      '内部人工步骤记为完成'
    )

    if (packagedExe) {
      const graph = {
        schemaVersion: 1,
        graphId: 'restart-parent',
        name: '重启后继续人工交付',
        goal: '让父流程从原子运行取回人工确认结果',
        nodes: [
          { nodeId: 'approval', title: '人工确认', kind: 'capability', participation: 'collaborative',
            goal: '等人确认', completion: '收到人工结论',
            capabilityRef: { kind: 'composite', id: 'human-flow', version: '1.0' } },
          { nodeId: 'delivery', title: '正式交付', kind: 'capability', participation: 'autonomous',
            goal: '交付已确认内容', completion: '输出正式文本',
            capabilityRef: { kind: 'node', id: 'text-pass', version: '1' } }
        ],
        edges: [{ from: { nodeId: 'approval', portId: 'out-res' },
          to: { nodeId: 'delivery', portId: 'in-value' } }],
        entry: 'approval',
        exits: ['delivery']
      }
      const proposed = ok(await cli(dir, ['flowGraph', 'propose'], { projectId, graph }), 'PARENT_PROPOSE')
      if (!proposed.ok || !proposed.preview) throw new Error(`PARENT_PREVIEW_INVALID:${JSON.stringify(proposed)}`)
      let window = await app.firstWindow()
      const confirming = cli(dir, ['flowGraph', 'confirm'], { projectId, buildId: proposed.preview.buildId })
      await window.getByRole('button', { name: '允许落画布' }).click({ timeout: 60000 })
      ok(await confirming, 'PARENT_CONFIRM')
      const nodeId = proposed.preview.coordinatorNodeId
      const identity = { projectId, nodeId }
      const parentStart = await cli(dir, ['flowAgent', 'run'], { ...identity, action: 'start' })
      if (parentStart.code !== 0) {
        receipt.outputs.failedParentOverview = (await cli(dir, ['flowRun', 'overview'], identity)).response
      }
      const parent = ok(parentStart, 'PARENT_START')
      assert(parent.task.state === 'waiting', '父流程等待子流程的人工步骤')
      const overview = async () => ok(await cli(dir, ['flowRun', 'overview'], identity), 'PARENT_OVERVIEW').overview
      const before = await overview()
      const waitingChild = before.children.find((child) => child.compositeWait)
      const waiting = waitingChild?.compositeWait
      assert(Boolean(waiting), '运行总览提供相同子运行的等待步骤')
      await app.close()
      app = null
      window = await launch()
      const coordinatorCard = window.locator('[data-node-id="' + nodeId + '"]').first()
      const projectCard = window.getByRole('button', { name: '打开项目 [TEST] C4 人工任务', exact: true })
      await coordinatorCard.or(projectCard).first().waitFor({ timeout: 30000 })
      if (await projectCard.isVisible()) await projectCard.click()
      await coordinatorCard.waitFor({ timeout: 30000 })
      const after = await overview()
      const afterWait = after.children.find((child) => child.compositeWait)?.compositeWait
      assert(after.taskId === before.taskId && afterWait?.runId === waiting.runId &&
        afterWait?.stepKey === waiting.stepKey, '重开后父运行和子运行身份保持一致')

      const submitAndContinue = async (task, childWait, text) => {
        ok(await cli(dir, ['composite', 'run', 'submitHuman'], {
          runId: childWait.runId, nodeId: childWait.stepKey, value: { kind: 'text', text }
        }), 'PARENT_SUBMIT')
        const continuation = {
          ...identity, action: 'continue', eventId: randomUUID(), expectedTaskId: task.taskId, expectedWaitRevision: task.waitRevision
        }
        const continuing = cli(dir, ['flowAgent', 'run'], continuation)
        await window.getByRole('button', { name: '允许继续' }).click({ timeout: 60000 })
        const done = ok(await continuing, 'PARENT_CONTINUE')
        assert(done.task.state === 'completed' &&
          Object.values(done.outputs).some((output) => output.kind === 'text' && output.text === text),
          '父流程完成并交付本轮采用的人工文本')
        const replay = ok(await cli(dir, ['flowAgent', 'run'], continuation), 'PARENT_CONTINUE_REPLAY')
        assert(replay.task.taskId === done.task.taskId && replay.refs[0]?.versionId === done.refs[0]?.versionId,
          'Continuing again returns the same run and delivery version')
        return done
      }
      const original = await submitAndContinue(parent.task, waiting, '报名日期：15 日')
      const rework = ok(await cli(dir, ['flowStage', 'rework'], {
        ...identity, stageKey: waitingChild.nodeId
      }), 'PARENT_REWORK')
      const corrected = ok(await cli(dir, ['flowAgent', 'run'], {
        ...identity, action: 'continue', eventId: randomUUID(), expectedTaskId: rework.task.taskId,
        expectedWaitRevision: rework.task.waitRevision
      }), 'PARENT_REWORK_WAIT')
      const freshWait = (await overview()).children.find((child) => child.compositeWait)?.compositeWait
      assert(corrected.task.state === 'waiting' && freshWait?.runId && freshWait.runId !== waiting.runId,
        '前序返工生成新的子运行及人工待办')
      const final = await submitAndContinue(corrected.task, freshWait, '报名日期：18 日')
      assert(original.refs[0]?.versionId && final.refs[0]?.versionId &&
        original.refs[0].versionId !== final.refs[0].versionId, '返工交付获得新的固定资产版本')
      receipt.outputs.parentRestart = { originalRunId: waiting.runId, revisedRunId: freshWait.runId,
        originalVersionId: original.refs[0].versionId, revisedVersionId: final.refs[0].versionId }
    }

    if (packagedExe) {
      const graph = {
        schemaVersion: 1, graphId: 'handoff-rework', name: '招生通知审核与交付',
        goal: '由招生编辑确认报名时间、地点与材料，固定发布稿并保留历史交付',
        roles: [{ roleId: 'editor', name: 'Editor' }],
        nodes: [
          { nodeId: 'source', title: 'Human source', kind: 'human-task', participation: 'human',
            humanRole: 'editor', goal: 'Supply a brief', completion: 'Brief submitted' },
          { nodeId: 'deliver', title: 'Deliver brief', kind: 'capability', participation: 'autonomous',
            goal: 'Deliver the brief', completion: 'Brief is available',
            capabilityRef: { kind: 'node', id: 'text-pass', version: '1' } }
        ],
        edges: [{ from: { nodeId: 'source', portId: 'out-text' },
          to: { nodeId: 'deliver', portId: 'in-value' } }],
        entry: 'source', exits: ['deliver']
      }
      const proposed = ok(await cli(dir, ['flowGraph', 'propose'], { projectId, graph }), 'HANDOFF_PROPOSE')
      const window = await app.firstWindow()
      const confirm = cli(dir, ['flowGraph', 'confirm'], { projectId, buildId: proposed.preview.buildId })
      await window.getByRole('button', { name: '允许落画布' }).click({ timeout: 60000 })
      ok(await confirm, 'HANDOFF_CONFIRM')
      const identity = { projectId, nodeId: proposed.preview.coordinatorNodeId }
      const launch = async (label, task, confirm = false) => {
        const request = task
          ? { ...identity, action: 'continue', eventId: randomUUID(),
              expectedTaskId: task.taskId, expectedWaitRevision: task.waitRevision }
          : { ...identity, action: 'start' }
        const pending = cli(dir, ['flowAgent', 'run'], request)
        if (confirm) await window.getByRole('button', { name: '允许继续' }).click({ timeout: 60000 })
        return ok(await pending, label)
      }
      const beforeFirst = ok(await cli(dir, ['flowRun', 'overview'], identity), 'BEFORE_FIRST_RUN')
      assert(beforeFirst.overview === null, 'The version test starts with no run history')
      await patchWithRetry(dir, projectId, [
        { action: 'node.update', nodeId: 'shape:source', title: 'First-run draft' }
      ], 'BEFORE_FIRST_RUN_EDIT')
      const draftOverview = ok(await cli(dir, ['flowRun', 'overview'], identity), 'BEFORE_FIRST_RUN_DRAFT')
      assert(draftOverview.overview === null && draftOverview.canvasVersion?.diverged === true,
        'CLI reports a divergent canvas before its first run')
      await window.getByRole('button', { name: '打开流程总览', exact: true }).click()
      await window.locator('.fo-flow-select').selectOption(identity.nodeId)
      const firstRestore = window.locator('.flow-overview').getByRole('button', { name: '恢复原定义', exact: true })
      await firstRestore.click({ timeout: 15000 })
      await window.getByRole('dialog').getByRole('button', { name: '恢复原定义', exact: true }).click()
      await firstRestore.waitFor({ state: 'hidden', timeout: 15000 })
      assert(await window.locator('[data-node-id="shape:source"]').getByText('Human source', { exact: true }).count() > 0,
        'The desktop restores a divergent graph before its first run')
      const first = await launch('HANDOFF_START')
      const overview = ok(await cli(dir, ['flowRun', 'overview'], identity), 'HANDOFF_OVERVIEW').overview
      const human = overview.graph.nodes.find((node) => node.kind === 'human-task')
      assert(human.humanRole === 'editor' && first.task.state === 'waiting', 'Packaged human stage waits with the declared role')
      const submit = async (task, text, handoffNote) => {
        const target = { projectId, nodeId: human.nodeId }
        const view = ok(await cli(dir, ['humanTask', 'get'], target), 'HANDOFF_GET_PENDING')
        const pending = cli(dir, ['humanTask', 'submit'], {
          ...target, expectedRevision: view.revision, value: { kind: 'text', text }, handoffNote
        })
        await window.getByRole('button', { name: '允许提交' }).click({ timeout: 60000 })
        ok(await pending, 'HANDOFF_SUBMIT')
        const done = await launch('HANDOFF_CONTINUE', task, true)
        assert(done.task.state === 'completed' &&
          Object.values(done.outputs).some((output) => output.kind === 'text' && output.text === text),
          'Packaged flow delivers the submitted result')
        const current = ok(await cli(dir, ['humanTask', 'get'], target), 'HANDOFF_GET_APPLIED')
        assert(current.handoffNote === handoffNote, 'Human task exposes the applied handoff note')
        return done
      }
      await submit(first.task, 'Original brief', 'Original handoff')
      const rework = ok(await cli(dir, ['flowStage', 'rework'], {
        ...identity, stageKey: human.nodeId
      }), 'HANDOFF_REWORK')
      const waiting = await launch('HANDOFF_REWORK_WAIT', rework.task)
      assert(waiting.task.state === 'waiting', 'Packaged rework opens a new human submission')
      await submit(waiting.task, 'Revised brief', 'Revised handoff')
      const deliveries = await app.evaluate(({ app }, { dir, taskId, nodeId }) => {
        const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
        const Database = require('better-sqlite3')
        const db = new Database(dir + '/app.db', { readonly: true })
        try {
          const row = db.prepare('SELECT body_json FROM flow_coordination_runs WHERE task_id=?').get(taskId)
          const record = JSON.parse(row.body_json)
          return {
            original: record.reworkHistory.find((entry) => entry.nodeId === nodeId),
            revised: record.stageDeliveries.find((entry) => entry.nodeId === nodeId)
          }
        } finally {
          db.close()
        }
      }, { dir, taskId: first.task.taskId, nodeId: human.nodeId })
      assert(deliveries.original?.stale === true && deliveries.original.handoffNote === 'Original handoff' &&
        deliveries.revised?.stale === false && deliveries.revised.handoffNote === 'Revised handoff' &&
        deliveries.original.outputRefs[0].versionId !== deliveries.revised.outputRefs[0].versionId,
        'Rework preserves the old handoff and attaches the revised note to a new asset version')
      receipt.outputs.handoffRework = deliveries
      const readOverview = async () =>
        ok(await cli(dir, ['flowRun', 'overview'], identity), 'VERSION_OVERVIEW').overview
      const rename = (title) => patchWithRetry(dir, projectId, [
        { action: 'node.update', nodeId: human.nodeId, title }
      ], 'VERSION_RENAME')
      const choose = async (action) => {
        const panel = window.locator('.flow-overview')
        await panel.getByRole('button', { name: action, exact: true }).click({ timeout: 15000 })
        await window.getByRole('dialog').getByRole('button', { name: action, exact: true }).click({ timeout: 15000 })
        for (let i = 0; i < 20; i++) {
          const current = await readOverview()
          if (current.canvasVersion?.diverged === false) return current.canvasVersion
          await sleep(300)
        }
        throw new Error('VERSION_BUTTON_DID_NOT_RESOLVE:' + await window.locator('body').innerText())
      }
      await rename('Unpublished draft')
      const refused = await cli(dir, ['flowAgent', 'run'], { ...identity, action: 'start' })
      assert(refused.response?.error?.code === 'FLOW_CANVAS_DIVERGED', 'A new run refuses an unresolved canvas draft')
      await window.getByRole('button', { name: '打开流程总览', exact: true }).click()
      await window.locator('.fo-flow-select').selectOption(identity.nodeId)
      await choose('恢复原定义')
      assert(await window.locator('[data-node-id="' + human.nodeId + '"]').getByText('Human source', { exact: true }).count() > 0,
        'The desktop restore action restores the original stage title')
      await rename('Published human source')
      const published = await choose('发布新版本')
      assert(published.sourceGraph?.version === 1, 'The desktop publish action freezes a graph definition')
      const next = await launch('PUBLISHED_VERSION_START')
      const adopting = await readOverview()
      assert(next.task.state === 'waiting' &&
        adopting.sourceGraph?.contentHash === published.sourceGraph.contentHash &&
        adopting.graph.nodes.find((node) => node.nodeId === human.nodeId)?.title === 'Published human source',
        'The next CLI run uses the published version and the updated stage')
      const editionA = '春季招生通知｜3 月 15 日 09:00–16:00，教学楼一层报名。请携带报名表与身份证明。'
      const firstEdition = await submit(next.task, editionA, '审核口径：核对报名日期、地点、携带材料。')
      const readAsset = async (versionId) =>
        ok(await cli(dir, ['flowAsset', 'read'], { projectId, versionId }), 'ADMISSIONS_ASSET')
      const archive = async (edition, result, prior) => {
        const fixed = await readAsset(result.refs[0].versionId)
        assert(fixed.value.text === edition, 'The admissions delivery is readable by immutable asset version')
        const created = await patchWithRetry(dir, projectId, [{
          action: 'node.create', ref: 'archive', nodeType: 'text', title: '招生通知发布稿', text: fixed.value.text,
          x: 1600, y: 700
        }], 'ARCHIVE_CARD')
        const archiveNode = created.created.find((node) => node.ref === 'archive').nodeId
        return ok(await cli(dir, ['library', 'captureProjectNodes'], {
          projectId, title: '招生通知发布稿', nodes: [{
            nodeId: archiveNode, title: '招生通知正文', nodeType: 'text', text: fixed.value.text
          }],
          ...(prior ? { resourceId: prior.resourceId, baseRevisionId: prior.revisionId } : {})
        }), 'ARCHIVE_RESOURCE')
      }
      const resourceA = await archive(editionA, firstEdition)
      const loadResource = async (version) => ok(await cli(dir, ['library', 'resource', 'get'], {
        resourceId: version.resourceId, revisionId: version.revisionId, includeText: true
      }), 'READ_ARCHIVED_EDITION')
      const reused = await loadResource(resourceA)
      const firstArchivedBody = reused.components.find((component) => component.text === editionA)?.text
      assert(firstArchivedBody, 'The second admissions batch reads the first archived edition')
      const editionB = firstArchivedBody
        .replace('春季', '秋季')
        .replace('3 月 15 日', '8 月 22 日')
        .replace('教学楼一层', '综合楼二层')
        .replace('身份证明', '成绩单')
      assert(editionB === '秋季招生通知｜8 月 22 日 09:00–16:00，综合楼二层报名。请携带报名表与成绩单。',
        'The autumn draft reuses the archived body with new enrollment details')
      const second = await launch('SECOND_ADMISSIONS_BATCH')
      const secondOverview = await readOverview()
      assert(second.task.taskId !== next.task.taskId &&
        secondOverview.sourceGraph?.contentHash === published.sourceGraph.contentHash,
        'Two admissions batches run using the same published template version')
      const secondEdition = await submit(second.task, editionB, '参照春季归档的字段顺序，已核对秋季报名时间、地点和材料。')
      const resourceB = await archive(editionB, secondEdition, resourceA)
      const [historyA, historyB] = await Promise.all([loadResource(resourceA), loadResource(resourceB)])
      assert(resourceA.resourceId === resourceB.resourceId && resourceA.revisionId !== resourceB.revisionId &&
        historyA.components.some((component) => component.text === editionA) &&
        historyB.components.some((component) => component.text === editionB),
        'The library keeps both admissions editions as separate revisions of the same resource')
      assert(firstEdition.refs[0].versionId !== secondEdition.refs[0].versionId &&
        (await readAsset(firstEdition.refs[0].versionId)).value.text === editionA,
        'The second batch preserves the original immutable delivery')
      const third = await launch('THIRD_ADMISSIONS_BATCH')
      const thirdOverview = await readOverview()
      assert(thirdOverview.sourceGraph?.contentHash === published.sourceGraph.contentHash,
        'The third admissions batch uses the same published template')
      const editionC = '补录通知｜9 月 5 日 10:00–12:00，招生办公室现场核验。请携带候补登记回执。'
      const thirdEdition = await submit(third.task, editionC, '补录只接受候补登记回执，已核对截止时间。')
      const resourceC = await archive(editionC, thirdEdition, resourceB)
      const editions = [editionA, editionB, editionC]
      const runs = [firstEdition, secondEdition, thirdEdition]
      const resources = [resourceA, resourceB, resourceC]
      const historical = await Promise.all(resources.map(loadResource))
      const assets = await Promise.all(runs.map((result) => readAsset(result.refs[0].versionId)))
      assert(new Set(runs.map((result) => result.task.taskId)).size === 3 &&
        new Set(runs.map((result) => result.refs[0].versionId)).size === 3 &&
        new Set(resources.map((resource) => resource.revisionId)).size === 3 &&
        resources.every((resource) => resource.resourceId === resourceA.resourceId) &&
        historical.every((entry, index) => entry.components.some((component) => component.text === editions[index])) &&
        assets.every((entry, index) => entry.value.text === editions[index]),
        'All three admissions runs preserve distinct immutable deliveries and library revisions')
      receipt.outputs.admissionsTemplateReuse = {
        template: published.sourceGraph,
        runs: runs.map((result) => ({
          taskId: result.task.taskId, versionId: result.refs[0].versionId
        })),
        resourceId: resourceA.resourceId,
        resourceRevisions: resources.map((resource) => resource.revisionId)
      }
      receipt.outputs.canvasVersionRoundtrip = { source: published.sourceGraph, adoptedBy: next.task.taskId }

      // Seed only the interrupted terminal status in this isolated fixture. All version and step
      // facts were written by the real node-flow execution above.
      await app.evaluate(({ app }, { dir, runId }) => {
        const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
        const Database = require('better-sqlite3')
        const db = new Database(dir + '/app.db')
        try {
          db.prepare("UPDATE composite_runs SET status='interrupted' WHERE id=?").run(runId)
        } finally {
          db.close()
        }
      }, { dir, runId })
      const unsafeRetry = await cli(dir, ['composite', 'run', 'retry'], { runId })
      assert(unsafeRetry.response?.error?.code === 'RUN_RETRY_REQUIRES_RECONCILIATION',
        'Retry refuses an interrupted run with prior human effects')

    }

    if (process.env.CANVAS_ACCEPTANCE_MEDIA === '1') {
      const fixtureFiles = { image: 'images/I-A.png', video: 'video/V-SILENT.mp4' }
      for (const [kind, filename] of Object.entries(fixtureFiles)) {
        const imported = ok(await cli(dir, ['media', 'import'], {
          projectId, filePath: path.join(root, 'qa-fixtures', 'media', filename)
        }), 'IMPORT_HUMAN_MEDIA')
        const resultPort = `out-${kind}`
        const flow = structuredClone(manifest)
        flow.capabilityId = `human-${kind}-flow`
        flow.name = `人工 ${kind} 交付`
        flow.graph.nodes[0].config = JSON.stringify({ schemaVersion: 1, outputType: kind })
        flow.graph.nodes[0].ports.push({
          id: resultPort, name: kind, type: kind, dir: 'out', required: false, cardinality: 'one'
        })
        flow.outputs[0].type = kind
        flow.outputs[0].source.portId = resultPort
        const published = ok(await cli(dir, ['composite', 'publish'], { manifest: flow }), 'PUBLISH_HUMAN_MEDIA')
        const batch = await patchWithRetry(dir, projectId, [{
          action: 'node.create', ref: 'mediaFlow', nodeType: 'composite', title: flow.name, x: 800, y: 500,
          config: { capabilityId: flow.capabilityId, version: flow.version, contentHash: published.contentHash }
        }], 'PLACE_HUMAN_MEDIA_FLOW')
        await runNode(dir, projectId, batch.created[0].nodeId)
        const waiting = ok(await cli(dir, ['composite', 'run', 'list'], { projectId, limit: 20 }), 'MEDIA_RUNS')
          .find((run) => run.capabilityId === flow.capabilityId && run.status === 'waiting-input')
        assert(Boolean(waiting), `${kind} 节点流等待人工交付`)
        const submitted = await cli(dir, ['composite', 'run', 'submitHuman'], {
          runId: waiting.id, nodeId: 'hn1', value: { kind, mediaId: imported.mediaId }
        })
        ok(submitted, 'SUBMIT_HUMAN_MEDIA')
        ok(await cli(dir, ['composite', 'run', 'resume'], { runId: waiting.id }), 'RESUME_HUMAN_MEDIA')
        let run
        for (let i = 0; i < 25; i++) {
          await sleep(250)
          run = ok(await cli(dir, ['composite', 'run', 'get'], { runId: waiting.id }), 'GET_HUMAN_MEDIA').run
          if (!['waiting-input', 'running'].includes(run.status)) break
        }
        assert(run.status === 'completed' && run.outputValues?.res?.mediaId === imported.mediaId,
          `${kind} 续跑公开输出与人工提交的项目素材一致（${run.status}）`)
      }
    }

    console.log(JSON.stringify({ ok: true, ...receipt }, null, 2))
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify({ ok: true, ...receipt }, null, 2))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error?.stack || error), ...receipt }, null, 2))
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify({ ok: false, error: String(error?.stack || error), ...receipt }, null, 2))
    process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => undefined)
    if (process.env.CANVAS_ACCEPTANCE_KEEP_FIXTURE === '1' && process.exitCode === 1)
      console.log(`Isolated failed fixture: ${dir}`)
    else await fsp.rm(dir, { recursive: true, force: true })
  }
})()
