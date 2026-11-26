/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Real Electron + CLI + MCP acceptance for BL-40 multi-input material and BL-21 adoption.
// All business facts come from production hosts, command ledger and desktop confirmation;
// there is no fake port, handwritten nodeRun, model call or paid provider in this fixture.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { createServer } = require('node:http')
const os = require('node:os')
const path = require('node:path')
const {
  root,
  sleep,
  cli,
  ok,
  launchApp,
  startMcp,
  mcpOk
} = require('./lib/e2e-transport.cjs')

const LARGE_TEXT = 'x'.repeat(1200)
const MATERIAL = 'short material'
const VOICE = { voice_id: 'fixture-voice', provider: 'local-deterministic' }
const evidenceFile = path.join(root, 'qa', 'local-agent-access', 'agent-flow-context-adoption-e2e', 'report.json')
const receipt = {
  mode: 'real Electron/CLI/MCP, deterministic local composites (no billing)',
  licenseMode: 'CANVAS_LICENSE_DEV_BYPASS=1 (development build only)',
  checks: [],
  runs: {}
}

const assert = (condition, label) => {
  if (!condition) throw new Error(`ASSERT_FAILED:${label}`)
  receipt.checks.push(label)
  console.log(`[check] ${label}`)
}

const port = (id, dir, type, required = true, cardinality = 'one', extra = {}) => ({
  id,
  name: id,
  dir,
  type,
  required,
  cardinality,
  ...extra
})

function sourceManifest() {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'e2e-context-source',
    version: '1.0',
    name: '[TEST] deterministic context source',
    inputs: [],
    outputs: [
      { id: 'text', label: '大文本', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'text', portId: 'out-text' } },
      { id: 'voice', label: '保留 JSON', type: 'json', required: true, cardinality: 'one', schemaRef: { id: 'json.any', version: 1 }, source: { nodeId: 'voice', portId: 'out-json' } }
    ],
    graph: {
      nodes: [
        {
          id: 'text', nodeType: 'text', contractVersion: 3, title: '固定大文本',
          text: LARGE_TEXT, dx: 0, dy: 0, w: 340, h: 300,
          ports: [
            port('in-text', 'in', 'text', false, 'many'),
            port('out-text', 'out', 'text')
          ]
        },
        {
          id: 'voice', nodeType: 'json', contractVersion: 1, title: '固定 JSON',
          text: JSON.stringify(VOICE), dx: 420, dy: 0, w: 340, h: 300,
          ports: [
            port('in-json', 'in', 'json', false, 'many', { schemaRef: { id: 'json.any', version: 1 } }),
            port('in-text', 'in', 'text', false, 'one'),
            port('out-json', 'out', 'json', true, 'one', { schemaRef: { id: 'json.any', version: 1 } })
          ]
        }
      ],
      edges: []
    },
    dependencies: [
      { kind: 'node', id: 'text', contractVersion: 3 },
      { kind: 'node', id: 'json', contractVersion: 1 }
    ],
    executionPolicy: { maxConcurrency: 1 }
  }
}

function contextManifest() {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'e2e-context-capability',
    version: '1.0',
    name: '[TEST] deterministic material capability',
    inputs: [
      {
        id: 'text', label: '待精简文本', type: 'text', required: true, cardinality: 'one',
        targets: [{ nodeId: 'text', portId: 'in-text' }]
      },
      {
        id: 'voice', label: '保留 JSON', type: 'json', required: true, cardinality: 'one',
        schemaRef: { id: 'json.any', version: 1 },
        targets: [{ nodeId: 'voice', portId: 'in-value' }]
      }
    ],
    outputs: [
      { id: 'summary', label: '精简文本', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'text', portId: 'out-text' } },
      { id: 'voice', label: '保留 JSON', type: 'json', required: true, cardinality: 'one', schemaRef: { id: 'json.any', version: 1 }, source: { nodeId: 'voice', portId: 'out-value' } }
    ],
    graph: {
      nodes: [
        {
          id: 'text', nodeType: 'text', contractVersion: 3, title: '精简文本', text: '',
          dx: 0, dy: 0, w: 340, h: 300,
          ports: [port('in-text', 'in', 'text', false, 'many'), port('out-text', 'out', 'text')]
        },
        {
          id: 'voice', nodeType: 'processor', contractVersion: 1, title: '保留 JSON',
          config: JSON.stringify({ operation: 'pass' }), dx: 420, dy: 0, w: 340, h: 300,
          ports: [port('in-value', 'in', 'any', false, 'one'), port('out-value', 'out', 'any')]
        }
      ],
      edges: []
    },
    dependencies: [
      { kind: 'node', id: 'text', contractVersion: 3 },
      { kind: 'node', id: 'processor', contractVersion: 1 }
    ],
    executionPolicy: { maxConcurrency: 1 }
  }
}

function flowGraph() {
  return {
    schemaVersion: 1,
    graphId: 'e2e-context-adoption',
    name: '[TEST] material and adoption',
    goal: '补料后由人采用，再执行 human-decision 下游',
    nodes: [
      {
        nodeId: 'source', title: '固定输入源', participation: 'autonomous', kind: 'capability',
        capabilityRef: { kind: 'composite', id: 'e2e-context-source', version: '1.0' },
        goal: '产出固定大文本和 JSON', completion: '两个固定输出已交付'
      },
      {
        nodeId: 'mid', title: '多输入补料并人工采用', participation: 'autonomous', kind: 'capability',
        capabilityRef: { kind: 'composite', id: 'e2e-context-capability', version: '1.0' },
        decider: 'human',
        inputs: {
          budgetBytes: 1024,
          overflow: 'ask-human',
          selectors: [
            { sourceStageKey: 'source', path: 'text', required: true },
            { sourceStageKey: 'source', path: '', required: true }
          ]
        },
        goal: '精简文本并保留 JSON', completion: '人工采用精简文本和保留 JSON'
      },
      {
        nodeId: 'downstream', title: '采用后下游', participation: 'autonomous', kind: 'capability',
        capability: 'text-pass@1', goal: '只执行一次下游透传', completion: '输出人工采用文本'
      }
    ],
    edges: [
      { from: { nodeId: 'source', portId: 'out-text' }, to: { nodeId: 'mid', portId: 'in-text' }, kind: 'data' },
      { from: { nodeId: 'source', portId: 'out-voice' }, to: { nodeId: 'mid', portId: 'in-voice' }, kind: 'data' },
      {
        from: { nodeId: 'mid', portId: 'out-summary' },
        to: { nodeId: 'downstream', portId: 'in-value' },
        kind: 'data',
        condition: [{ kind: 'human-decision', stageKey: 'mid' }]
      }
    ],
    entry: 'source',
    exits: ['downstream']
  }
}

async function readRun(app, dir, taskId) {
  return app.evaluate(({ app }, { dir, taskId }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const Database = require('better-sqlite3')
    const db = new Database(dir + '/app.db', { readonly: true })
    try {
      const row = db.prepare('SELECT body_json FROM flow_coordination_runs WHERE task_id=?').get(taskId)
      if (!row) return null
      const run = JSON.parse(row.body_json)
      const taskIds = run.children.map((child) => child.taskId)
      const commands = db.prepare(
        'SELECT command_id,task_id,target_node_id,state,command_json,receipt_json FROM flow_commands WHERE project_id=? AND task_id IN (' + taskIds.map(() => '?').join(',') + ')'
      ).all(run.projectId, ...taskIds).map((command) => ({
        ...command,
        command: JSON.parse(command.command_json),
        receipt: JSON.parse(command.receipt_json)
      }))
      return { run, commands }
    } finally {
      db.close()
    }
  }, { dir, taskId })
}

async function setupModel(dir, provider) {
  ok(await cli(dir, ['model', 'connection', 'save'], {
    id: 'e2e-context-connection',
    name: '[TEST] local deterministic model',
    protocol: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`
  }), 'MODEL_CONNECTION_SAVE')
  ok(await cli(dir, ['model', 'definition', 'save'], {
    id: 'e2e-context-model',
    connectionId: 'e2e-context-connection',
    name: '[TEST] deterministic tool model',
    modelId: 'fixture',
    capabilities: [{ operation: 'text.generate', streaming: true }]
  }), 'MODEL_DEFINITION_SAVE')
  const validated = ok(await cli(dir, ['model', 'validateAgentToolCalling'], {
    connectionId: 'e2e-context-connection',
    modelDefinitionId: 'e2e-context-model',
    confirmNetwork: true,
    confirmCost: true
  }), 'MODEL_TOOL_VALIDATION')
  assert(validated.status === 'verified', '本地模型结构化工具调用与结果往返验证通过')
}

async function publishFixtures(dir) {
  for (const manifest of [sourceManifest(), contextManifest()]) {
    const validated = ok(await cli(dir, ['composite', 'validate'], { manifest }), 'COMPOSITE_VALIDATE')
    assert(validated.ok === true, `${manifest.capabilityId} 通过生产发布校验`)
    const published = ok(await cli(dir, ['composite', 'publish'], { manifest }), 'COMPOSITE_PUBLISH')
    assert(published.contentHash, `${manifest.capabilityId} 发布本地固定版本`)
  }
}

async function run() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-context-adoption-'))
  let app = null
  let mcp = null
  let probeRequests = 0
  const provider = createServer(async (request, response) => {
    request.resume()
    probeRequests++
    const first = probeRequests === 1
    const name = first ? 'probe_echo' : 'probe_done'
    const args = first ? { marker: 'probe-ok', count: 7 } : { marker: 'receipt-only', count: 13 }
    const chunks = [
      { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `probe-${probeRequests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
      { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ]
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })
  try {
    const launched = await launchApp(dir, '[TEST] 多输入补料与人工采用')
    app = launched.app
    let page = launched.page
    await setupModel(dir, provider)
    await publishFixtures(dir)

    const drive = async (mode, operation, input) => {
      if (mode === 'cli') return ok(await cli(dir, operation.split('.'), input), `${mode}:${operation}`)
      return mcpOk(await mcp.call(operation, input), `${mode}:${operation}`)
    }
    const confirm = async (buttonName) => {
      await page.getByRole('button', { name: buttonName, exact: true }).click({ timeout: 60000 })
    }
    const attachCanvas = async (mode, identity) => {
      const attached = await page.evaluate(async (projectId) =>
        window.api.activateFlowCanvas({ projectId }), identity.projectId)
      receipt.diagnostics ??= {}
      const diagnostics = receipt.diagnostics[mode] ??= {}
      diagnostics.attachResponses ??= []
      diagnostics.attachResponses.push(attached)
      console.log(`[attach] ${mode} ${JSON.stringify(attached)}`)
      assert(attached?.ok === true, `${mode} continue 前完成 flowCommands attach`)
    }
    const overview = async (mode, identity) =>
      (await drive(mode, 'flowRun.overview', identity)).overview
    const recoveryStatus = async (mode) => ({
      appStatus: await drive(mode, 'app.status', {}),
      activeProjectId: await page.evaluate(async () => {
        const { useAppStore } = await import('/src/stores/app.ts')
        return useAppStore.getState().currentProject?.id ?? null
      })
    })

    const executePath = async (mode, restartAtAdoption) => {
      const created = await drive(mode, 'project.create', { name: `[TEST] ${mode} 多输入补料` })
      const projectId = created.meta.id
      await drive(mode, 'project.open', { projectId })
      const proposed = await drive(mode, 'flowGraph.propose', { projectId, graph: flowGraph() })
      assert(proposed.ok && proposed.preview?.buildId, `${mode} 真实建图预览生成`)
      const confirming = drive(mode, 'flowGraph.confirm', { projectId, buildId: proposed.preview.buildId })
      await confirm('允许落画布')
      await confirming
      const identity = { projectId, nodeId: proposed.preview.coordinatorNodeId }
      const started = await drive(mode, 'flowAgent.run', { ...identity, action: 'start' })
      assert(started.task.state === 'waiting' && started.task.code === 'FLOW_CONTEXT_OVER_BUDGET',
        `${mode} start 到达真实上下文超限等待`)

      let waiting = await overview(mode, identity)
      assert(waiting.contextMaterialWait?.stageKey.endsWith('mid'), `${mode} 总览给出中间 capability 补料表单`)
      const materialContinuation = {
        ...identity,
        action: 'continue',
        eventId: `material-${mode}`,
        expectedTaskId: started.task.taskId,
        expectedWaitRevision: started.task.waitRevision,
        contextMaterial: MATERIAL
      }
      await attachCanvas(mode, identity)
      const materialPending = drive(mode, 'flowAgent.run', materialContinuation)
      await confirm('提交材料并继续')
      const adoptedWait = await materialPending
      assert(adoptedWait.task.state === 'waiting' && adoptedWait.task.code === 'HUMAN_ADOPTION_REQUIRED',
        `${mode} 补料执行后到达人工采用等待`)

      waiting = await overview(mode, identity)
      const midWaiting = waiting.children.find((child) => child.nodeId.endsWith('mid'))
      assert(midWaiting?.state === 'waiting', `${mode} 采用前中间 capability 尚未完成`)

      if (restartAtAdoption) {
        await mcp.close()
        mcp = null
        await app.close()
        app = null
        const relaunched = await launchApp(dir, '[TEST] 多输入补料与人工采用（重开）')
        app = relaunched.app
        page = relaunched.page
        mcp = await startMcp(dir, relaunched)
        const reopenedTask = (await drive(mode, 'flowAgent.inspect', identity)).task
        assert(reopenedTask.taskId === adoptedWait.task.taskId &&
          reopenedTask.waitRevision === adoptedWait.task.waitRevision &&
          reopenedTask.code === 'HUMAN_ADOPTION_REQUIRED', `${mode} 重开保留同一采用等待和 waitRevision`)
        const persisted = await readRun(app, dir, adoptedWait.task.taskId)
        const mid = persisted.run.children.find((child) => child.nodeId.endsWith('mid'))
        assert(mid?.adoptionPending === true && mid.outputs.length === 2,
          `${mode} 重开后采用标记和两份真实能力输出仍在`)
      }

      const recovery = { firstError: null, attempts: [], samples: [] }
      receipt.diagnostics ??= {}
      receipt.diagnostics[mode] = { ...(receipt.diagnostics[mode] ?? {}), recovery }
      let done
      let lastError
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        try {
          await attachCanvas(mode, identity)
          const adoptionPending = drive(mode, 'flowAgent.run', {
            ...identity,
            action: 'continue',
            eventId: `adoption-${mode}-${attempt}`,
            expectedTaskId: adoptedWait.task.taskId,
            expectedWaitRevision: adoptedWait.task.waitRevision
          })
          await confirm('允许继续')
          done = await adoptionPending
        } catch (error) {
          lastError = error
          recovery.firstError ??= String(error?.stack || error)
          if (!String(error?.message ?? error).includes('FLOW_PROJECT_INACTIVE')) throw error
          recovery.attempts.push({ attempt, error: String(error?.message ?? error) })
          let active = false
          for (let poll = 0; poll < 120; poll++) {
            const sample = await recoveryStatus(mode)
            recovery.samples.push(sample)
            if (sample.activeProjectId === projectId) {
              active = true
              break
            }
            await sleep(250)
          }
          if (!active) break
        }
      }
      if (!done) throw lastError
      assert(done.task.state === 'completed', `${mode} 人工采用后流程完成`)
      assert(done.outputs?.['out-text']?.text === MATERIAL, `${mode} 最终公开文本来自真实补料`)

      const persisted = await readRun(app, dir, done.task.taskId)
      const { run, commands } = persisted
      const source = run.children.find((child) => child.nodeId.endsWith('source'))
      const mid = run.children.find((child) => child.nodeId.endsWith('mid'))
      const downstream = run.children.find((child) => child.nodeId.endsWith('downstream'))
      assert(mid?.state === 'completed' && mid.humanDecided === true && mid.adoptionPending === undefined,
        `${mode} 采用事实持久化为 humanDecided=true`)
      const delivery = run.stageDeliveries?.find((record) => record.nodeId === mid.nodeId)
      assert(delivery?.humanDecided === true && delivery.contextManifestHash === mid.contextManifest?.manifestHash,
        `${mode} 阶段交付记录与 effective manifest hash 一致`)
      const midCommand = commands.find((command) => command.task_id === mid.taskId)
      const entries = mid.contextManifest?.entries ?? []
      receipt.diagnostics ??= {}
      Object.assign(receipt.diagnostics[mode] ??= {}, {
        midContextManifestEntries: entries,
        midCommandInputs: midCommand?.command.inputs ?? null,
        deliveryOutputRefs: delivery.outputRefs
      })
      assert(entries.some((entry) => entry.sourceStageKey === 'human:context' && entry.value === MATERIAL),
        `${mode} effective manifest 含 human:context`)
      assert(entries.some((entry) => entry.sourceStageKey === source.nodeId && entry.path === '' &&
        JSON.stringify(entry.value) === JSON.stringify(VOICE)), `${mode} effective manifest 保留固定 JSON 输入`)
      assert(!entries.some((entry) => entry.value === LARGE_TEXT), `${mode} 原始超限文本未进入 effective manifest`)

      assert(commands.length === 3 && commands.every((command) => command.state === 'committed'),
        `${mode} source/mid/downstream 三条真实命令全部 committed`)
      assert(midCommand?.receipt.inputFingerprint?.startsWith('v1:'), `${mode} 中间命令保存真实输入指纹`)
      assert(midCommand.command.contextMaterial?.targetPortId === 'in-text' &&
        midCommand.command.contextMaterial.text === MATERIAL, `${mode} 账本命令携带已确认补料`)
      assert(midCommand.command.inputs.length === 1 &&
        midCommand.command.inputs[0].targetPortId === 'in-voice' &&
        midCommand.command.inputs[0].assets[0].sourceNodeId === 'shape:source' &&
        midCommand.command.inputs[0].assets[0].sourcePortId === 'out-voice',
        `${mode} 账本只保留 in-voice 固定资产版本`)
      const downstreamCommands = commands.filter((command) => command.task_id === downstream.taskId)
      assert(downstream?.state === 'completed' && downstreamCommands.length === 1,
        `${mode} human-decision 下游真实执行且仅一次`)

      const fixedAssets = []
      for (const ref of delivery.outputRefs) {
        fixedAssets.push(await drive(mode, 'flowAsset.read', { projectId, versionId: ref.versionId }))
      }
      assert(fixedAssets.some((asset) => asset.value.kind === 'text' && asset.value.text === MATERIAL),
        `${mode} 中间公开文本资产可由 flowAsset.read 读取`)
      assert(fixedAssets.some((asset) => asset.value.kind === 'json' &&
        JSON.stringify(asset.value.json ?? asset.value.data) === JSON.stringify(VOICE)),
        `${mode} 中间公开 JSON 固定资产保持原值`)
      assert(source?.state === 'completed', `${mode} 固定输入源真实完成`)
      return {
        taskId: done.task.taskId,
        commandIds: commands.map((command) => command.command_id),
        reopened: restartAtAdoption
      }
    }

    receipt.runs.cli = await executePath('cli', false)
    mcp = await startMcp(dir, launched)
    receipt.runs.mcp = await executePath('mcp', true)

    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true })
    fs.writeFileSync(evidenceFile, JSON.stringify({ ok: true, ...receipt }, null, 2))
    console.log(JSON.stringify({ ok: true, ...receipt }, null, 2))
  } catch (error) {
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true })
    fs.writeFileSync(evidenceFile, JSON.stringify({
      ok: false,
      error: String(error?.stack || error),
      ...receipt
    }, null, 2))
    console.log(JSON.stringify({ ok: false, error: String(error?.stack || error), ...receipt }, null, 2))
    process.exitCode = 1
  } finally {
    if (mcp) await mcp.close().catch(() => undefined)
    if (app) await app.close().catch(() => undefined)
    await new Promise((resolve) => provider.close(resolve))
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`)
  process.exitCode = 1
})
