/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// H02 参数真实编译/执行验收：真实 Electron Host/Store + CLI/MCP + 人工 GUI 确认。
// 仅模型解析与最终 videoSubmit 使用确定性 fixture；不调用供应商、不产生费用。
// 前置：未打包开发构建；helper 使用 CANVAS_LICENSE_DEV_BYPASS，非授权验收。
// 真实桌面由验收负责人串行执行。
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const {
  root,
  sleep,
  cli,
  ok,
  launchApp,
  startMcp,
  mcpOk,
  key,
  LICENSE_MODE
} = require('./lib/e2e-transport.cjs')

const reportDir = path.join(__dirname, '..', '..', 'qa', 'local-agent-access', 'capability-params-e2e')
const reportPath = path.join(reportDir, 'report.json')
const sourceValue = { profile: { title: '雨巷' } }

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = require('node:net').createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function startSourceRenderer() {
  const port = await reserveLoopbackPort()
  const url = `http://127.0.0.1:${port}`
  const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js')
  const server = spawn(process.execPath, [
    viteBin,
    '--config', 'vite.browser.config.ts',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--strictPort'
  ], { cwd: root, stdio: 'ignore', windowsHide: true })
  let spawnError
  server.once('error', (error) => { spawnError = error })
  const deadline = Date.now() + 45000
  while (true) {
    if (spawnError) throw spawnError
    if (server.exitCode !== null) throw new Error('PARAMS_VITE_EXITED')
    try {
      const [indexResponse, moduleResponse] = await Promise.all([
        fetch(url),
        fetch(`${url}/src/stores/gateway.ts`)
      ])
      const moduleType = moduleResponse.headers.get('content-type') ?? ''
      if (indexResponse.ok && moduleResponse.ok && !moduleType.includes('text/html')) {
        return { server, url }
      }
    } catch { /* renderer is still starting */ }
    if (Date.now() > deadline) {
      server.kill()
      throw new Error('PARAMS_VITE_TIMEOUT')
    }
    await sleep(250)
  }
}

async function startVideoSubmitFixture() {
  const calls = { videoSubmits: 0 }
  const server = createServer((request, response) => {
    request.resume()
    calls.videoSubmits++
    response.writeHead(500, { 'Content-Type': 'application/json' }).end('{}')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, port: server.address().port, calls }
}

async function seedVideoValidationFixture(app, dir, fixture) {
  return app.evaluate(async ({ app }, input) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const Database = require('better-sqlite3')
    const db = new Database(input.dir + '/app.db')
    try {
      const now = new Date().toISOString()
      // 与 H10 legacy rows 同类：这是明确的测试 setup，不是供应商验证回执。
      db.prepare(`INSERT INTO model_validations
        (connection_id,model_definition_id,operation,status,message,action,checked_at,verified_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(connection_id,model_definition_id,operation) DO UPDATE SET
          status=excluded.status,message=excluded.message,action=excluded.action,
          checked_at=excluded.checked_at,verified_at=excluded.verified_at`).run(
        input.connectionId,
        input.definitionId,
        'video.generate',
        'verified',
        'TEST SETUP ONLY: no supplier validation was performed',
        'acceptance setup only',
        now,
        now
      )
      return db.prepare(`SELECT status,message FROM model_validations
        WHERE connection_id=? AND model_definition_id=? AND operation='video.generate'`)
        .get(input.connectionId, input.definitionId)
    } finally {
      db.close()
    }
  }, { dir, ...fixture })
}

function graphBase(graphId, name, nodes, from, to) {
  return {
    schemaVersion: 1,
    graphId,
    name,
    goal: name,
    nodes,
    edges: [{ from, to }],
    entry: nodes[0].nodeId,
    exits: [nodes[1].nodeId]
  }
}

function humanNode(nodeId, outputType) {
  return {
    nodeId,
    title: nodeId,
    participation: 'human',
    kind: 'human-task',
    humanOutputType: outputType,
    goal: '提交确定性测试材料',
    completion: '人工材料已提交'
  }
}

function capabilityNode(nodeId, id, params, goal = '处理测试材料') {
  return {
    nodeId,
    title: nodeId,
    participation: 'autonomous',
    kind: 'capability',
    capabilityRef: { kind: 'node', id, version: id === 'video' ? '7' : '1' },
    goal,
    completion: '能力执行事实已交付',
    params
  }
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-capability-params-'))
  const receipt = {
    ok: false,
    mode: 'real Electron Host/Store + CLI/MCP + GUI confirmation; deterministic model fixture; no supplier calls',
    licenseMode: LICENSE_MODE,
    rendererMode: 'vite.browser.config.ts source renderer + real built main/preload',
    checks: [],
    outputs: {},
    boundaries: [
      'featureKey 由生产 model.binding.resolve + executor 进入 seed 预检共同证明；未单独执行 image-gen featureKey',
      'video seed 本用例验证不支持能力的提交前拒绝；支持能力的 gateway 路径由 capability-params 单元效果测试覆盖',
      '未调用真实供应商，未验证供应商受理或媒体质量',
      'CANVAS_LICENSE_DEV_BYPASS 仅用于未打包开发构建；不复制本机 license/security，不构成授权验收'
    ]
  }
  let app
  let page
  let mcp
  let vite
  let videoFixture
  let projectId
  let previousElectronRendererUrl
  const check = (label) => {
    receipt.checks.push(label)
    console.log(`[check] ${label}`)
  }
  const assert = (condition, label) => {
    if (!condition) throw new Error(`ASSERT_FAILED:${label}`)
    check(label)
  }
  const readProject = () => JSON.parse(
    fs.readFileSync(path.join(dir, 'projects', projectId, 'project.json'), 'utf8')
  )
  const confirmGraph = async (preview, transport = 'cli') => {
    const pending = transport === 'mcp'
      ? mcp.call('flowGraph.confirm', { projectId, buildId: preview.buildId })
      : cli(dir, ['flowGraph', 'confirm'], { projectId, buildId: preview.buildId })
    await appPage().getByRole('button', { name: '允许落画布', exact: true }).click({ timeout: 60000 })
    const confirmed = transport === 'mcp'
      ? mcpOk(await pending, 'FLOW_GRAPH_CONFIRM_MCP')
      : ok(await pending, 'FLOW_GRAPH_CONFIRM_CLI')
    assert(
      confirmed.preview?.state === 'committed' && confirmed.committedNodeIds?.length > 0,
      `${transport} flowGraph.confirm 经 GUI 允许后持久化为 committed`
    )
    return confirmed
  }
  const appPage = () => page
  const submitHuman = async (nodeId, value) => {
    const current = ok(await cli(dir, ['humanTask', 'get'], { projectId, nodeId }), 'HUMAN_GET')
    const revision = current.instance?.revision ?? current.revision ?? 1
    const pending = cli(dir, ['humanTask', 'submit'], {
      projectId,
      nodeId,
      expectedRevision: revision,
      value
    })
    await appPage().getByRole('button', { name: '允许提交', exact: true }).click({ timeout: 60000 })
    ok(await pending, 'HUMAN_SUBMIT')
  }
  const continueFlow = async (nodeId, task) => {
    const pending = cli(dir, ['flowAgent', 'run'], {
      projectId,
      nodeId,
      action: 'continue',
      eventId: key(),
      expectedTaskId: task.taskId,
      expectedWaitRevision: task.waitRevision
    })
    await appPage().getByRole('button', { name: '允许继续', exact: true }).click({ timeout: 60000 })
    return pending
  }

  try {
    const renderer = await startSourceRenderer()
    vite = renderer.server
    // 普通主窗口读 ELECTRON_RENDERER_URL；CANVAS_AGENT_RENDERER_URL 只属于专用 Agent harness。
    // 两个值都指向同一 Vite 实例，finally 恢复调用前环境。
    previousElectronRendererUrl = process.env.ELECTRON_RENDERER_URL
    process.env.ELECTRON_RENDERER_URL = renderer.url
    const launched = await launchApp(dir, '[TEST] H02 capability 参数编译执行', renderer.url)
    app = launched.app
    page = launched.page
    receipt.outputs.renderer = {
      requestedUrl: renderer.url,
      actualUrl: page.url()
    }
    page.on('pageerror', (error) => {
      receipt.outputs.lastPageError = String(error).slice(0, 1000)
    })

    const created = ok(await cli(dir, ['project', 'create'], {
      name: '[TEST] H02 capability 参数'
    }), 'PROJECT_CREATE')
    projectId = created.meta.id
    ok(await cli(dir, ['project', 'open'], { projectId }), 'PROJECT_OPEN')
    mcp = await startMcp(dir, { instanceId: launched.instanceId, pid: launched.pid })
    check('共享 e2e-transport 启动真实桌面、CLI 与 MCP')

    // ── 1. processor field：公开别名 → pick/path → 正式字段提取输出 ──
    const processorGraph = graphBase(
      'params-field',
      'H02 processor 字段提取',
      [
        humanNode('field-source', 'json'),
        capabilityNode('field-pick', 'text-pass', {
          operation: 'field',
          field: 'profile.title'
        })
      ],
      { nodeId: 'field-source', portId: 'out-json' },
      { nodeId: 'field-pick', portId: 'in-value' }
    )
    const cliValidation = ok(await cli(dir, ['flowGraph', 'validate'], {
      graph: processorGraph
    }), 'FIELD_VALIDATE_CLI')
    const mcpValidation = mcpOk(await mcp.call('flowGraph.validate', {
      graph: processorGraph
    }), 'FIELD_VALIDATE_MCP')
    assert(
      cliValidation.ok === true && mcpValidation.ok === true,
      'processor operation=field + field 在 CLI/MCP 均通过 flowGraph.validate'
    )
    const proposed = ok(await cli(dir, ['flowGraph', 'propose'], {
      projectId,
      graph: processorGraph
    }), 'FIELD_PROPOSE')
    assert(proposed.ok === true && proposed.preview?.buildId, 'processor 图生成持久化预览')
    await confirmGraph(proposed.preview, 'cli')

    const compiledNode = mcpOk(await mcp.call('node.get', {
      projectId,
      nodeId: 'shape:field-pick'
    }), 'FIELD_NODE_GET').node
    assert(
      compiledNode?.config?.operation === 'pick' && compiledNode?.config?.path === 'profile.title',
      '落画布后的 processor 配置为真实 operation=pick + path=profile.title'
    )
    const persistedBeforeRun = readProject().tldrawSnapshot.store['shape:field-pick'].props
    assert(
      JSON.parse(persistedBeforeRun.config).operation === 'pick' &&
        JSON.parse(persistedBeforeRun.config).path === 'profile.title',
      'project.json 中的 processor 配置与 MCP node.get 一致'
    )
    receipt.outputs.processor = {
      nodeId: 'shape:field-pick',
      operation: compiledNode.config.operation,
      path: compiledNode.config.path
    }

    const coordinatorId = proposed.preview.coordinatorNodeId
    const started = ok(await cli(dir, ['flowAgent', 'run'], {
      projectId,
      nodeId: coordinatorId,
      action: 'start'
    }), 'FIELD_FLOW_START')
    assert(started.task?.state === 'waiting', 'processor 流程先等待确定性 human-task JSON 输入')
    await submitHuman('shape:field-source', { kind: 'json', data: sourceValue })
    const completed = ok(
      await continueFlow(coordinatorId, started.task),
      'FIELD_FLOW_CONTINUE'
    )
    const delivered = completed.outputs?.['out-text']
    assert(
      completed.task?.state === 'completed' && delivered?.kind === 'text' && delivered.text === '雨巷',
      '真实协调器完成且 processor 从 JSON 提取 profile.title=雨巷'
    )
    const formal = mcpOk(await mcp.call('output.get', {
      projectId,
      nodeId: 'shape:field-pick'
    }), 'FIELD_OUTPUT_GET')
    const outValue = (formal.outputs ?? []).find((output) => output.portId === 'out-value')
    assert(
      outValue?.kind === 'text' && outValue.text === '雨巷',
      'MCP output.get 读取到 processor out-value 正式提取值'
    )
    const persistedAfterRun = readProject().tldrawSnapshot.store['shape:field-pick'].meta.nodeRun
    assert(
      persistedAfterRun?.status === 'success' && persistedAfterRun.outputPorts?.includes('out-value'),
      'processor 持久化运行事实为 success 且声明 out-value'
    )
    const overview = mcpOk(await mcp.call('flowRun.overview', {
      projectId,
      nodeId: coordinatorId
    }), 'FIELD_OVERVIEW').overview
    assert(
      overview?.state === 'completed' &&
        overview.children?.some((child) => child.nodeId === 'shape:field-pick' && child.state === 'completed'),
      'Host/Store 运行总览同时记录协调器与 processor 子任务 completed'
    )
    Object.assign(receipt.outputs.processor, {
      output: outValue.text,
      runStatus: persistedAfterRun.status,
      coordinatorState: overview.state
    })

    // ── 2. video featureKey + 不支持 seed：模型解析可证，提交必须为零 ──
    const videoGraph = graphBase(
      'params-video-seed',
      'H02 video 功能身份与种子门禁',
      [
        humanNode('video-source', 'text'),
        capabilityNode('video-capability', 'video', {
          featureKey: 'acceptance.video.custom',
          mode: 'text',
          params: { seed: 17 }
        }, '根据固定材料生成视频')
      ],
      { nodeId: 'video-source', portId: 'out-text' },
      { nodeId: 'video-capability', portId: 'in-text' }
    )
    const videoValidation = mcpOk(await mcp.call('flowGraph.validate', {
      graph: videoGraph
    }), 'VIDEO_VALIDATE_MCP')
    assert(videoValidation.ok === true, 'video featureKey + seed 公开图通过真实目录校验')
    const videoProposed = mcpOk(await mcp.call('flowGraph.propose', {
      projectId,
      graph: videoGraph
    }), 'VIDEO_PROPOSE_MCP')
    assert(videoProposed.ok === true && videoProposed.preview?.buildId, 'MCP 持久化 video 建图预览')
    await confirmGraph(videoProposed.preview, 'mcp')
    const persistedVideo = readProject().tldrawSnapshot.store['shape:video-capability'].props
    const videoConfig = JSON.parse(persistedVideo.config)
    assert(
      videoConfig.featureKey === 'acceptance.video.custom' && videoConfig.params?.seed === 17,
      'video 落画布配置保留自定义 featureKey 与 seed=17'
    )

    const videoCoordinatorId = videoProposed.preview.coordinatorNodeId
    videoFixture = await startVideoSubmitFixture()
    const connectionId = 'fixture-video'
    const definitionId = 'fixture-video-definition'
    const modelId = 'fixture-video-unsupported-seed'
    const baseUrl = `http://127.0.0.1:${videoFixture.port}`
    ok(await cli(dir, ['model', 'connection', 'save'], {
      id: connectionId,
      name: '[TEST] local video model',
      protocol: 'minimax',
      baseUrl,
      apiKey: 'canvas-local-video-fixture'
    }), 'VIDEO_CONNECTION_SAVE')
    ok(await cli(dir, ['model', 'definition', 'save'], {
      id: definitionId,
      connectionId,
      name: '[TEST] unsupported seed video model',
      modelId,
      capabilities: [{ operation: 'video.generate' }]
    }), 'VIDEO_DEFINITION_SAVE')
    const validationFixture = await seedVideoValidationFixture(app, dir, { connectionId, definitionId })
    assert(
      validationFixture?.status === 'verified' && validationFixture.message.includes('TEST SETUP ONLY'),
      'SQLite verified 行是明确标记的测试 setup，不是供应商业务回执'
    )
    const binding = ok(await cli(dir, ['model', 'binding', 'save'], {
      featureKey: 'acceptance.video.custom',
      connectionId,
      modelDefinitionId: definitionId,
      operation: 'video.generate'
    }), 'VIDEO_BINDING_SAVE')
    assert(binding.enabled === true, '生产 model.binding.save 接受已 setup 的自定义 video 绑定')
    const bindingResolution = ok(await cli(dir, ['model', 'binding', 'resolve'], {
      featureKey: 'acceptance.video.custom',
      operation: 'video.generate'
    }), 'VIDEO_BINDING_RESOLVE')
    assert(
      bindingResolution.featureKey === 'acceptance.video.custom' &&
        bindingResolution.providerId === connectionId &&
        bindingResolution.modelId === modelId &&
        bindingResolution.resolvedFrom === 'feature-binding',
      '生产 model.binding.resolve 返回自定义 video fixture 目标'
    )
    receipt.outputs.video = {
      pageUrl: page.url(),
      binding,
      bindingResolution,
      validationFixture
    }

    const videoStarted = ok(await cli(dir, ['flowAgent', 'run'], {
      projectId,
      nodeId: videoCoordinatorId,
      action: 'start'
    }), 'VIDEO_FLOW_START')
    assert(videoStarted.task?.state === 'waiting', 'video 流程先等待固定文本输入')
    await submitHuman('shape:video-source', { kind: 'text', text: '固定镜头文本' })

    // 只设置真实执行器读取的 provider 缓存；不覆盖任何 window.api 方法。
    await page.evaluate(async ({ connectionId: providerId, modelId: fixtureModelId, baseUrl: fixtureUrl }) => {
      const { useGatewayStore } = await import('/src/stores/gateway.ts')
      useGatewayStore.setState({
        loaded: true,
        providers: [{
          id: providerId,
          name: '[TEST] local video model',
          specId: 'minimax',
          baseURL: fixtureUrl,
          createdAt: 0,
          hasApiKey: true,
          models: [{
            id: fixtureModelId,
            name: 'Unsupported seed fixture',
            modality: 'video',
            operations: ['video.generate']
          }]
        }]
      })
    }, { connectionId, modelId, baseUrl })
    const rejected = await continueFlow(videoCoordinatorId, videoStarted.task)
    const rejectionEnvelope = rejected.response ?? rejected
    const fixtureFacts = {
      pageUrl: page.url(),
      videoSubmitCount: videoFixture.calls.videoSubmits
    }
    // 先落完整诊断，再断言；失败报告不能丢掉真实回执和本地提交计数。
    Object.assign(receipt.outputs.video, {
      pageUrl: fixtureFacts.pageUrl,
      rejectionEnvelope,
      videoSubmitCount: fixtureFacts.videoSubmitCount
    })
    assert(
      rejectionEnvelope.error || rejectionEnvelope.task?.state === 'blocked',
      '不支持 seed 的 video 流程以错误/blocked 终态结束，而非伪造完成'
    )

    let videoRun
    for (let attempt = 0; attempt < 30; attempt++) {
      videoRun = readProject().tldrawSnapshot.store['shape:video-capability'].meta.nodeRun
      if (videoRun?.status === 'skipped') break
      await sleep(200)
    }
    receipt.outputs.video.actualNodeRun = videoRun
    assert(
      videoRun?.status === 'skipped' && videoRun.error?.reason?.includes('不支持种子参数'),
      'video 持久化 nodeRun 记录不支持种子参数且状态为 skipped'
    )
    assert(fixtureFacts.videoSubmitCount === 0, '不支持 seed 时本地 HTTP server 收到 videoSubmit=0')
    const videoOutputs = mcpOk(await mcp.call('output.get', {
      projectId,
      nodeId: 'shape:video-capability'
    }), 'VIDEO_OUTPUT_GET')
    assert(
      !(videoOutputs.outputs ?? []).some((output) => output.portId === 'out-video'),
      'seed 拒绝后没有伪造 out-video 正式输出'
    )
    Object.assign(receipt.outputs.video, {
      featureKey: videoConfig.featureKey,
      seed: videoConfig.params.seed,
      actualNodeRun: videoRun,
      runStatus: videoRun.status,
      reason: videoRun.error.reason,
      formalOutputCount: (videoOutputs.outputs ?? []).length
    })

    receipt.ok = true
    console.log(JSON.stringify(receipt, null, 2))
  } catch (error) {
    receipt.error = String(error?.stack || error).slice(0, 4000)
    process.exitCode = 1
    console.error(receipt.error)
  } finally {
    receipt.ok = receipt.ok === true && !receipt.error
    if (mcp) await mcp.close().catch(() => undefined)
    if (app) await app.close().catch(() => undefined)
    if (previousElectronRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = previousElectronRendererUrl
    if (vite && vite.exitCode === null) vite.kill()
    if (videoFixture) await new Promise((resolve) => videoFixture.server.close(() => resolve()))
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    fs.mkdirSync(reportDir, { recursive: true })
    fs.writeFileSync(reportPath, JSON.stringify(receipt, null, 2))
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
