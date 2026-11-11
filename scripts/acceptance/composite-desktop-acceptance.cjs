/* eslint-disable */
// 节点流桌面验收（W1 起，仓库内可重复）：隔离数据目录，真实 Electron + CLI + MCP，退出后清理。
// 前置：npx electron-vite build；本机已激活授权（%APPDATA%\canvas-studio\data\security）。
// 运行：node scripts/acceptance/composite-desktop-acceptance.cjs
const { _electron } = require('playwright')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const key = () => `${Date.now()}:${randomUUID()}`

async function cli(dir, args, input) {
  const file = path.join(dir, `input-${randomUUID()}.json`)
  if (input) fs.writeFileSync(file, JSON.stringify({ input, idempotencyKey: key() }))
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath.includes('electron') ? process.execPath : require('electron'), [
      path.join(root, 'out/main/local-agent.js'),
      ...args,
      '--data-dir',
      dir,
      ...(input ? ['--input-file', file] : [])
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI_TIMEOUT')) }, 40000)
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err = (err + c).slice(-1000)))
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      try { resolve({ code, response: JSON.parse(out), err }) } catch { resolve({ code, response: null, raw: out, err }) }
    })
  })
}

function manifest() {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'copy-polish',
    version: '1.0',
    name: '文案整理',
    inputs: [],
    outputs: [{ id: 'polished', label: '整理结果', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'n1', portId: 'out-text' } }],
    graph: {
      nodes: [{
        id: 'n1', nodeType: 'text', contractVersion: 3, title: '文案', dx: 0, dy: 0, w: 340, h: 300, text: '内部说明',
        ports: [
          { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: true, cardinality: 'many' },
          { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }
        ]
      }],
      edges: []
    },
    dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }]
  }
}

function ok2(res, label) {
  if (res.code !== 0 || !res.response || res.response.error) {
    throw new Error(`${label}:${JSON.stringify(res.response || res).slice(0, 600)}`)
  }
  return res.response.data
}

// 运行结果异步落盘会推进 graphVersion；补丁读最新版本并在 REVISION_CONFLICT 时有界重试。
// OUTCOME_UNKNOWN（桌面握手超时）：先核对补丁是否已落盘（graph.patch 原子，按标题匹配），
// 已落盘直接采用，未落盘才重发，避免重复插入。
async function patchWithRetry(dir, projectId, ops, label) {
  let last = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const graph = ok2(await cli(dir, ['graph', 'get'], { projectId }), `${label}_GRAPH`)
    const res = await cli(dir, ['graph', 'patch'], {
      projectId,
      expectedGraphVersion: graph.graphVersion,
      ops
    })
    if (res.code === 0 && res.response && !res.response.error) return res.response.data
    last = res
    const code = res.response?.error?.code
    if (code === 'REVISION_CONFLICT') {
      await new Promise((r) => setTimeout(r, 250))
      continue
    }
    if (code === 'OUTCOME_UNKNOWN') {
      const creates = ops.filter((op) => op.action === 'node.create')
      let reconciled = null
      for (let poll = 0; poll < 6; poll++) {
        await new Promise((r) => setTimeout(r, 800))
        const after = ok2(await cli(dir, ['graph', 'get'], { projectId }), `${label}_RECONCILE`)
        const matched = creates.map((op) => after.nodes.find((n) => n.title === op.title))
        if (creates.length > 0 && matched.every(Boolean)) {
          reconciled = { created: matched.map((n) => ({ nodeId: n.nodeId })), graphVersion: after.graphVersion }
          break
        }
      }
      if (reconciled) return reconciled
      continue
    }
    break
  }
  throw new Error(`${label}:${JSON.stringify(last?.response || last).slice(0, 600)}`)
}

// node.execute / composite.upgrade.apply 同样携带 expectedGraphVersion，冲突时读新版本重试。
// 本脚本全部为确定性本地运行（文本/JSON/资产，无模型与付费请求），OUTCOME_UNKNOWN 时
// 等待落盘稳定后重试不会造成付费重复提交。
async function withVersionRetry(dir, projectId, label, call) {
  let last = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const graph = ok2(await cli(dir, ['graph', 'get'], { projectId }), `${label}_GRAPH`)
    const res = await call(graph.graphVersion)
    if (res.code === 0 && res.response && !res.response.error) return res.response.data
    last = res
    const code = res.response?.error?.code
    if (code !== 'REVISION_CONFLICT' && code !== 'OUTCOME_UNKNOWN') break
    await new Promise((r) => setTimeout(r, code === 'OUTCOME_UNKNOWN' ? 2000 : 250))
  }
  throw new Error(`${label}:${JSON.stringify(last?.response || last).slice(0, 600)}`)
}

// 运行终态先于渲染层 meta 落盘：output.get 读持久化快照，需轮询到本次输出可见。
async function waitForOutputs(dir, projectId, nodeId, predicate, label, timeoutMs = 30000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeoutMs) {
    last = ok2(await cli(dir, ['output', 'get'], { projectId, nodeId }), label)
    if (predicate(last)) return last
    await new Promise((r) => setTimeout(r, 700))
  }
  throw new Error(`${label}_TIMEOUT:${JSON.stringify(last).slice(0, 600)}`)
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-w1-accept-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  let app
  const receipt = { checks: [], outputs: {} }
  const consoleLog = []
  try {
    // 宿主 shell 可能注入 ELECTRON_RUN_AS_NODE；GUI 启动必须清除，CLI 子进程单独显式设置。
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [root, '--local-agent-access'],
      env: launchEnv
    })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    page.on('console', (msg) => consoleLog.push(`[${msg.type()}] ${msg.text()}`))
    page.on('pageerror', (err) => consoleLog.push(`[pageerror] ${String(err?.stack || err)}`))
    app.process().stdout?.on('data', (c) => consoleLog.push(`[main] ${String(c).trimEnd()}`))
    app.process().stderr?.on('data', (c) => consoleLog.push(`[main:err] ${String(c).trimEnd()}`))
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.setTitle('[TEST] 节点流桌面验收 W1/W3')
    })
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await new Promise((r) => setTimeout(r, 200))
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json')))
      throw new Error('CONNECTION_NOT_READY')

    const created = await cli(dir, ['project', 'create'], { name: '[TEST] W1/W3 桌面验收' })
    if (created.code !== 0) throw new Error(`CREATE_FAILED:${JSON.stringify(created.response)}`)
    const projectId = created.response.data.meta.id
    receipt.checks.push('CLI project.create')
    const opened = await cli(dir, ['project', 'open'], { projectId })
    if (opened.code !== 0) throw new Error(`OPEN_FAILED:${JSON.stringify(opened.response)}`)
    receipt.checks.push('CLI project.open')

    const inner = manifest()
    const published = await cli(dir, ['composite', 'publish'], { manifest: inner })
    if (published.code !== 0) throw new Error(`PUBLISH_FAILED:${JSON.stringify(published.response)}`)
    receipt.checks.push('CLI composite.publish')
    const duplicate = await cli(dir, ['composite', 'publish'], { manifest: { ...inner, name: '覆盖尝试' } })
    if (duplicate.response?.error?.code !== 'VERSION_IMMUTABLE')
      throw new Error(`IMMUTABLE_NOT_ENFORCED:${JSON.stringify(duplicate.response)}`)
    receipt.checks.push('CLI composite.publish rejects same-version overwrite')

    const alive = await cli(dir, ['capability', 'list'])
    if (!alive.response) throw new Error(`CLI_DIED:${JSON.stringify(alive)}`)
    receipt.checks.push('CLI server still answers after publish conflict')

    const patched = await patchWithRetry(dir, projectId, [
      { action: 'node.create', nodeType: 'composite', title: '文案整理', x: 120, y: 120, w: 340, h: 260, config: { manifest: inner } }
    ], 'PATCH_INSTANCE')
    const nodeId = patched.created[0].nodeId
    receipt.checks.push('CLI graph.patch insert composite instance')

    const executed = await withVersionRetry(dir, projectId, 'EXECUTE', (graphVersion) =>
      cli(dir, ['node', 'execute'], {
        projectId,
        expectedGraphVersion: graphVersion,
        nodeIds: [nodeId],
        mode: 'single'
      })
    )
    const taskId = executed.taskId
    const waited = await cli(dir, ['run', 'wait'], { projectId, taskId, timeoutMs: 60000 })
    receipt.checks.push(`CLI node.execute -> run.wait state=${waited.response.data.state}`)
    const output = await waitForOutputs(dir, projectId, nodeId, (r) => r.outputs.some((item) => item.portId === 'out-polished' && item.text === '内部说明'), 'OUTPUT')
    const text = output.outputs.find((item) => item.portId === 'out-polished')?.text
    receipt.outputs.text = text
    if (text !== '内部说明') throw new Error(`TEXT_MISMATCH:${String(text)}`)
    receipt.checks.push('CLI output.get real composite text')

    // 失败路径：可选输入未传 + 正文为空 → 文本节点 skipped，必需输出缺失。
    const failing = manifest()
    failing.capabilityId = 'title-polish'
    failing.name = '标题整理'
    failing.inputs = [{
      id: 'copy',
      label: '文案',
      type: 'text',
      required: false,
      cardinality: 'one',
      targets: [{ nodeId: 'n1', portId: 'in-text' }]
    }]
    failing.graph.nodes[0].text = ''
    const failingPublished = await cli(dir, ['composite', 'publish'], { manifest: failing })
    if (failingPublished.code !== 0)
      throw new Error(`FAILING_PUBLISH:${JSON.stringify(failingPublished.response)}`)
    const patched2 = await patchWithRetry(dir, projectId, [
      { action: 'node.create', nodeType: 'composite', title: '标题整理', x: 520, y: 120, w: 340, h: 260, config: { manifest: failing } }
    ], 'FAILING_PATCH')
    const failingNodeId = patched2.created[0].nodeId
    const executed2 = await withVersionRetry(dir, projectId, 'FAILING_EXECUTE', (graphVersion) =>
      cli(dir, ['node', 'execute'], {
        projectId,
        expectedGraphVersion: graphVersion,
        nodeIds: [failingNodeId],
        mode: 'single'
      })
    )
    const waited2 = await cli(dir, ['run', 'wait'], { projectId, taskId: executed2.taskId, timeoutMs: 60000 })
    receipt.outputs.failureState = waited2.response.data.state
    if (waited2.response.data.state !== 'failed')
      throw new Error(`FAILURE_NOT_REPORTED:${JSON.stringify(waited2.response)}`)
    const runs = await cli(dir, ['composite', 'run', 'list'], { projectId, limit: 10 })
    const failedRun = (runs.response.data || []).find((run) => run.status === 'failed')
    receipt.outputs.failureRun = failedRun
    if (!failedRun || failedRun.errorCode !== 'REQUIRED_OUTPUT_MISSING' || failedRun.failurePhase !== 'output')
      throw new Error(`FAILURE_LOCATION_MISSING:${JSON.stringify(failedRun)}`)
    receipt.checks.push('CLI failure located to output phase')

    // ── W3：实例升级（兼容迁移 / 不兼容阻断）──
    const inner20 = { ...inner, version: '2.0' }
    ok2(await cli(dir, ['composite', 'publish'], { manifest: inner20 }), 'PUBLISH_20')
    await withVersionRetry(dir, projectId, 'UPGRADE_APPLY', (graphVersion) =>
      cli(dir, ['composite', 'upgrade', 'apply'], {
        projectId, nodeId, nextManifest: inner20, expectedGraphVersion: graphVersion
      })
    )
    const nodeAfter = ok2(await cli(dir, ['node', 'get'], { projectId, nodeId }), 'NODE_AFTER_UPGRADE')
    if (nodeAfter.node.config?.version !== '2.0' || nodeAfter.node.config?.capabilityId !== 'copy-polish')
      throw new Error(`UPGRADE_REF_NOT_WRITTEN:${JSON.stringify(nodeAfter.node.config)}`)
    const execUp = await withVersionRetry(dir, projectId, 'EXEC_UPGRADED', (graphVersion) =>
      cli(dir, ['node', 'execute'], {
        projectId, expectedGraphVersion: graphVersion, nodeIds: [nodeId], mode: 'single'
      })
    )
    const waitUp = await cli(dir, ['run', 'wait'], { projectId, taskId: execUp.taskId, timeoutMs: 60000 })
    if (waitUp.response?.data?.state !== 'completed') throw new Error(`UPGRADED_RUN_FAILED:${JSON.stringify(waitUp.response)}`)
    receipt.checks.push('CLI composite.upgrade.apply 兼容升级（引用形态写入并运行成功）')

    const breaking = {
      ...inner,
      version: '3.0',
      graph: {
        nodes: [...inner.graph.nodes, { ...inner.graph.nodes[0], id: 'n-extra', title: '额外', dx: 480, text: '' }],
        edges: []
      },
      inputs: [...inner.inputs, { id: 'extra', label: '额外必填', type: 'text', required: true, cardinality: 'one', targets: [{ nodeId: 'n-extra', portId: 'in-text' }] }]
    }
    ok2(await cli(dir, ['composite', 'publish'], { manifest: breaking }), 'PUBLISH_30')
    let blocked = null
    for (let attempt = 0; attempt < 6; attempt++) {
      const g3 = ok2(await cli(dir, ['graph', 'get'], { projectId }), 'GRAPH_W3_3')
      blocked = await cli(dir, ['composite', 'upgrade', 'apply'], {
        projectId, nodeId, nextManifest: breaking, expectedGraphVersion: g3.graphVersion
      })
      if (blocked.response?.error?.code !== 'REVISION_CONFLICT') break
      await new Promise((r) => setTimeout(r, 250))
    }
    if (blocked.response?.error?.code !== 'UPGRADE_BLOCKED')
      throw new Error(`UPGRADE_NOT_BLOCKED:${JSON.stringify(blocked.response)}`)
    const nodeStill = ok2(await cli(dir, ['node', 'get'], { projectId, nodeId }), 'NODE_STILL')
    if (nodeStill.node.config?.version !== '2.0') throw new Error('BLOCKED_UPGRADE_CHANGED_INSTANCE')
    receipt.checks.push('CLI composite.upgrade.apply 不兼容阻断且原实例不变')

    // ── W3：固定版本引用插入（外部不再携带大快照）──
    const refPatch = await patchWithRetry(dir, projectId, [
      { action: 'node.create', nodeType: 'composite', title: '引用实例', x: 900, y: 120, config: { capabilityId: 'copy-polish', version: '1.0' } }
    ], 'REF_PATCH')
    const refNodeId = refPatch.created[0].nodeId
    const execRef = await withVersionRetry(dir, projectId, 'EXEC_REF', (graphVersion) =>
      cli(dir, ['node', 'execute'], {
        projectId, expectedGraphVersion: graphVersion, nodeIds: [refNodeId], mode: 'single'
      })
    )
    const waitRef = await cli(dir, ['run', 'wait'], { projectId, taskId: execRef.taskId, timeoutMs: 60000 })
    if (waitRef.response?.data?.state !== 'completed') throw new Error(`REF_RUN_FAILED:${JSON.stringify(waitRef.response)}`)
    const outRef = await waitForOutputs(dir, projectId, refNodeId, (r) => r.outputs.some((o) => o.portId === 'out-polished' && o.text === '内部说明'), 'OUT_REF')
    if (!outRef.outputs.some((o) => o.portId === 'out-polished' && o.text === '内部说明'))
      throw new Error(`REF_OUTPUT_MISMATCH:${JSON.stringify(outRef)}`)
    receipt.checks.push('CLI graph.patch 引用形态插入 composite 并运行输出真实文本')

    // ── W3：运行期递归守卫（手工快照绕过发布校验，运行时按 capabilityId 链拒绝）──
    const textNode = (id, body) => ({
      id, nodeType: 'text', contractVersion: 3, title: id, dx: 0, dy: 0, w: 340, h: 300, text: body,
      ports: [
        { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: true, cardinality: 'many' },
        { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }
      ]
    })
    // 叶子与顶层同一 capabilityId：调用链 loop-a → loop-b → loop-a 即递归。
    // 不用互相嵌入的循环结构（JSON 序列化会丢最内层 config），叶子是普通文本节点流。
    const loopLeaf = { ...manifest(), capabilityId: 'loop-a', name: '递归A叶子' }
    const loopB = {
      schemaVersion: 1, runtimeVersion: 2, capabilityId: 'loop-b', version: '1.0', name: '递归B',
      inputs: [], outputs: [{ id: 'text', label: '文本', type: 'text', required: true, cardinality: 'one', source: { nodeId: 't1', portId: 'out-text' } }],
      graph: {
        nodes: [
          textNode('t1', '递归正文'),
          { id: 'n2', nodeType: 'composite', contractVersion: 1, title: '嵌套A', dx: 400, dy: 0, w: 340, h: 260, config: JSON.stringify({ manifest: loopLeaf }) }
        ],
        edges: []
      },
      dependencies: []
    }
    const loopA = {
      schemaVersion: 1, runtimeVersion: 2, capabilityId: 'loop-a', version: '1.0', name: '递归A',
      inputs: [], outputs: [{ id: 'text', label: '文本', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'n1', portId: 'out-text' } }],
      graph: {
        nodes: [{ id: 'n1', nodeType: 'composite', contractVersion: 1, title: '嵌套B', dx: 0, dy: 0, w: 340, h: 260, config: JSON.stringify({ manifest: loopB }) }],
        edges: []
      },
      dependencies: []
    }
    const loopPatch = await patchWithRetry(dir, projectId, [
      { action: 'node.create', nodeType: 'composite', title: '递归实例', x: 1300, y: 120, config: { manifest: loopA } }
    ], 'LOOP_PATCH')
    const execLoop = await withVersionRetry(dir, projectId, 'EXEC_LOOP', (graphVersion) =>
      cli(dir, ['node', 'execute'], {
        projectId, expectedGraphVersion: graphVersion, nodeIds: [loopPatch.created[0].nodeId], mode: 'single'
      })
    )
    const waitLoop = await cli(dir, ['run', 'wait'], { projectId, taskId: execLoop.taskId, timeoutMs: 60000 })
    if (waitLoop.response?.data?.state !== 'failed') throw new Error(`RECURSION_NOT_REJECTED:${JSON.stringify(waitLoop.response)}`)
    const loopRuns = ok2(await cli(dir, ['composite', 'run', 'list'], { projectId, limit: 50 }), 'LOOP_RUNS')
    if (!loopRuns.some((r) => r.errorCode === 'RECURSIVE_COMPOSITE'))
      throw new Error(`RECURSION_CODE_MISSING:${JSON.stringify(loopRuns.map((r) => ({ code: r.errorCode, message: r.errorMessage })))}`)
    receipt.checks.push('CLI 运行期递归守卫拒绝互相引用快照（RECURSIVE_COMPOSITE）')

    // ── W3：JSON 与多输出逐类运行 ──
    const jsonManifest = {
      schemaVersion: 1, runtimeVersion: 2, capabilityId: 'json-pass', version: '1.0', name: 'JSON直通',
      inputs: [], outputs: [{ id: 'data', label: '数据', type: 'json', required: true, cardinality: 'one', source: { nodeId: 'j1', portId: 'out-json' } }],
      graph: { nodes: [{ id: 'j1', nodeType: 'json', contractVersion: 1, title: 'JSON', dx: 0, dy: 0, w: 340, h: 300, text: '{"a":1}',
        ports: [
          { id: 'in-json', name: 'JSON', dir: 'in', type: 'json', required: false, cardinality: 'one' },
          { id: 'out-json', name: 'JSON', dir: 'out', type: 'json', required: true, cardinality: 'one' }
        ] }], edges: [] },
      dependencies: [{ kind: 'node', id: 'json', contractVersion: 1 }]
    }
    ok2(await cli(dir, ['composite', 'publish'], { manifest: jsonManifest }), 'PUBLISH_JSON')
    const multiManifest = {
      schemaVersion: 1, runtimeVersion: 2, capabilityId: 'multi-out', version: '1.0', name: '多输出',
      inputs: [],
      outputs: [
        { id: 'o1', label: '甲', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'n1', portId: 'out-text' } },
        { id: 'o2', label: '乙', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'n2', portId: 'out-text' } }
      ],
      graph: { nodes: [textNode('n1', '甲'), textNode('n2', '乙')], edges: [] },
      dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }]
    }
    ok2(await cli(dir, ['composite', 'publish'], { manifest: multiManifest }), 'PUBLISH_MULTI')
    const typePatch = await patchWithRetry(dir, projectId, [
      { action: 'node.create', nodeType: 'composite', title: 'JSON实例', x: 1700, y: 120, config: { capabilityId: 'json-pass', version: '1.0' } },
      { action: 'node.create', nodeType: 'composite', title: '多输出实例', x: 2100, y: 120, config: { capabilityId: 'multi-out', version: '1.0' } }
    ], 'TYPE_PATCH')
    // single 模式契约语义为「仅该节点」：逐节点提交执行，不把多个节点塞进一次调用。
    for (const created of typePatch.created) {
      const execOne = await withVersionRetry(dir, projectId, 'EXEC_TYPE', (graphVersion) =>
        cli(dir, ['node', 'execute'], {
          projectId, expectedGraphVersion: graphVersion, nodeIds: [created.nodeId], mode: 'single'
        })
      )
      const waitOne = await cli(dir, ['run', 'wait'], { projectId, taskId: execOne.taskId, timeoutMs: 60000 })
      if (waitOne.response?.data?.state !== 'completed') throw new Error(`TYPES_RUN_FAILED:${JSON.stringify(waitOne.response)}`)
    }
    const outJson = await waitForOutputs(dir, projectId, typePatch.created[0].nodeId, (r) => r.outputs.some((o) => o.portId === 'out-data'), 'OUT_JSON')
    if (!outJson.outputs.some((o) => o.portId === 'out-data')) throw new Error(`JSON_OUTPUT_MISSING:${JSON.stringify(outJson)}`)
    const outMulti = await waitForOutputs(dir, projectId, typePatch.created[1].nodeId, (r) => {
      const texts = r.outputs.filter((o) => o.portId === 'out-o1' || o.portId === 'out-o2').map((o) => o.text)
      return texts.includes('甲') && texts.includes('乙')
    }, 'OUT_MULTI')
    const multiTexts = outMulti.outputs.filter((o) => o.portId === 'out-o1' || o.portId === 'out-o2').map((o) => o.text)
    if (!multiTexts.includes('甲') || !multiTexts.includes('乙')) throw new Error(`MULTI_OUTPUT_MISMATCH:${JSON.stringify(outMulti)}`)
    receipt.checks.push('CLI JSON 与多输出节点流运行并收集全部公开输出')

    // ── W3：嵌套深度守卫（各层 maxDepth=2，三层手工快照运行时拒绝）──
    const depthLeaf = { ...manifest(), capabilityId: 'depth-3', name: '深度3', executionPolicy: { maxDepth: 2 } }
    const depthMid = {
      ...manifest(), capabilityId: 'depth-2', name: '深度2',
      executionPolicy: { maxDepth: 2 },
      outputs: [{ id: 'text', label: '文本', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'c1', portId: 'out-text' } }],
      graph: { nodes: [{ id: 'c1', nodeType: 'composite', contractVersion: 1, title: '嵌套3', dx: 0, dy: 0, w: 340, h: 260, config: JSON.stringify({ manifest: depthLeaf }) }], edges: [] },
      dependencies: []
    }
    const depthTop = {
      ...manifest(), capabilityId: 'depth-1', name: '深度1',
      executionPolicy: { maxDepth: 2 },
      outputs: [{ id: 'text', label: '文本', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'c1', portId: 'out-text' } }],
      graph: { nodes: [{ id: 'c1', nodeType: 'composite', contractVersion: 1, title: '嵌套2', dx: 0, dy: 0, w: 340, h: 260, config: JSON.stringify({ manifest: depthMid }) }], edges: [] },
      dependencies: []
    }
    const depthPatch = await patchWithRetry(dir, projectId, [
      { action: 'node.create', nodeType: 'composite', title: '深度实例', x: 2500, y: 120, config: { manifest: depthTop } }
    ], 'DEPTH_PATCH')
    const execDepth = await withVersionRetry(dir, projectId, 'EXEC_DEPTH', (graphVersion) =>
      cli(dir, ['node', 'execute'], {
        projectId, expectedGraphVersion: graphVersion, nodeIds: [depthPatch.created[0].nodeId], mode: 'single'
      })
    )
    const waitDepth = await cli(dir, ['run', 'wait'], { projectId, taskId: execDepth.taskId, timeoutMs: 60000 })
    if (waitDepth.response?.data?.state !== 'failed') throw new Error(`DEPTH_NOT_REJECTED:${JSON.stringify(waitDepth.response)}`)
    const depthRuns = ok2(await cli(dir, ['composite', 'run', 'list'], { projectId, limit: 50 }), 'DEPTH_RUNS')
    if (!depthRuns.some((r) => r.errorCode === 'DEPTH_EXCEEDED'))
      throw new Error(`DEPTH_CODE_MISSING:${JSON.stringify(depthRuns.map((r) => r.errorCode))}`)
    receipt.checks.push('CLI 运行期深度守卫拒绝超限嵌套（DEPTH_EXCEEDED）')

    // ── W3：展开预算守卫（maxExpandedNodes=2，内部 3 节点运行时拒绝）──
    const budgetManifest = {
      ...manifest(), capabilityId: 'budget-over', name: '预算超限',
      executionPolicy: { maxExpandedNodes: 2 },
      outputs: [{ id: 'text', label: '文本', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'n1', portId: 'out-text' } }],
      graph: { nodes: [textNode('n1', '甲'), textNode('n2', '乙'), textNode('n3', '丙')], edges: [] }
    }
    const budgetPatch = await patchWithRetry(dir, projectId, [
      { action: 'node.create', nodeType: 'composite', title: '预算实例', x: 2900, y: 120, config: { manifest: budgetManifest } }
    ], 'BUDGET_PATCH')
    const execBudget = await withVersionRetry(dir, projectId, 'EXEC_BUDGET', (graphVersion) =>
      cli(dir, ['node', 'execute'], {
        projectId, expectedGraphVersion: graphVersion, nodeIds: [budgetPatch.created[0].nodeId], mode: 'single'
      })
    )
    const waitBudget = await cli(dir, ['run', 'wait'], { projectId, taskId: execBudget.taskId, timeoutMs: 60000 })
    if (waitBudget.response?.data?.state !== 'failed') throw new Error(`BUDGET_NOT_REJECTED:${JSON.stringify(waitBudget.response)}`)
    const budgetRuns = ok2(await cli(dir, ['composite', 'run', 'list'], { projectId, limit: 50 }), 'BUDGET_RUNS')
    if (!budgetRuns.some((r) => r.errorCode === 'EXPANSION_BUDGET_EXCEEDED'))
      throw new Error(`BUDGET_CODE_MISSING:${JSON.stringify(budgetRuns.map((r) => r.errorCode))}`)
    receipt.checks.push('CLI 运行期展开预算守卫拒绝超限节点数（EXPANSION_BUDGET_EXCEEDED）')

    // ── W3：媒体资产节点流（真实 PNG 文件，无模型确定性运行，媒体产物可被下游消费）──
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    const mediaRel = `projects/${projectId}/media/w3-asset.png`
    await fsp.mkdir(path.join(dir, 'projects', projectId, 'media'), { recursive: true })
    await fsp.writeFile(path.join(dir, mediaRel), png1x1)
    const mediaManifest = {
      schemaVersion: 1, runtimeVersion: 2, capabilityId: 'media-kit', version: '1.0', name: '媒体套件',
      inputs: [],
      outputs: [{ id: 'poster', label: '海报', type: 'image', required: true, cardinality: 'one', source: { nodeId: 'i1', portId: 'out-image' } }],
      graph: {
        nodes: [{
          id: 'i1', nodeType: 'image', contractVersion: 3, title: '图片资产', dx: 0, dy: 0, w: 340, h: 260,
          mediaRefs: [{ mediaId: 'w3-asset', mediaPath: mediaRel, mime: 'image/png' }],
          ports: [{ id: 'out-image', name: '图片', dir: 'out', type: 'image', required: true, cardinality: 'one' }]
        }],
        edges: []
      },
      dependencies: [{ kind: 'node', id: 'image', contractVersion: 3 }]
    }
    ok2(await cli(dir, ['composite', 'publish'], { manifest: mediaManifest }), 'PUBLISH_MEDIA')
    const mediaPatch = await patchWithRetry(dir, projectId, [
      { action: 'node.create', nodeType: 'composite', title: '媒体实例', x: 3300, y: 120, config: { capabilityId: 'media-kit', version: '1.0' } }
    ], 'MEDIA_PATCH')
    const mediaNodeId = mediaPatch.created[0].nodeId
    const execMedia = await withVersionRetry(dir, projectId, 'EXEC_MEDIA', (graphVersion) =>
      cli(dir, ['node', 'execute'], {
        projectId, expectedGraphVersion: graphVersion, nodeIds: [mediaNodeId], mode: 'single'
      })
    )
    const waitMedia = await cli(dir, ['run', 'wait'], { projectId, taskId: execMedia.taskId, timeoutMs: 60000 })
    if (waitMedia.response?.data?.state !== 'completed') throw new Error(`MEDIA_RUN_FAILED:${JSON.stringify(waitMedia.response)}`)
    const outMedia = await waitForOutputs(dir, projectId, mediaNodeId, (r) => {
      const m = r.outputs.find((o) => o.portId === 'out-poster')
      return !!m && m.kind === 'image' && m.mediaId === 'w3-asset' && m.mediaPath === mediaRel
    }, 'OUT_MEDIA')
    const mediaOut = outMedia.outputs.find((o) => o.portId === 'out-poster')
    if (!mediaOut || mediaOut.kind !== 'image' || mediaOut.mediaId !== 'w3-asset' || mediaOut.mediaPath !== mediaRel)
      throw new Error(`MEDIA_OUTPUT_MISMATCH:${JSON.stringify(outMedia)}`)
    // output.get 的媒体投影即下游消费视图：runtimeVersion 2 下它唯一读取 meta.nodeExtra，
    // 因此 out-poster 含正确 mediaId/mediaPath 已证明媒体产物写入 nodeExtra 且可被下游消费。
    // （node.get 契约不返回 meta，不在此读取不存在的字段。）
    receipt.outputs.mediaOutput = mediaOut
    receipt.checks.push('CLI 媒体资产节点流运行：output.get 投影含可下游消费的图片产物（nodeExtra 来源）')

    // ── W3：引用保护（画布实例 + 嵌套引用阻断删除；归档不影响绑定实例）──
    const refs = ok2(await cli(dir, ['composite', 'references'], { capabilityId: 'copy-polish' }), 'REFERENCES')
    if (!Array.isArray(refs.projectInstances) || refs.projectInstances.length < 2)
      throw new Error(`REFERENCES_INSTANCES_MISSING:${JSON.stringify(refs)}`)
    receipt.outputs.referenceCount = refs.projectInstances.length
    const deleteBlocked = await cli(dir, ['composite', 'delete'], { capabilityId: 'copy-polish' })
    if (deleteBlocked.response?.error?.code !== 'CAPABILITY_IN_USE')
      throw new Error(`DELETE_NOT_BLOCKED:${JSON.stringify(deleteBlocked.response)}`)
    receipt.checks.push('CLI composite.references 列出画布实例；composite.delete 被 CAPABILITY_IN_USE 阻断')

    // 嵌套引用：手工构造外层发布版本固定引用 copy-polish@1.0。
    // W3：内部组合节点用引用形态 config（capabilityId/version/contentHash），
    // 隔离执行必须经宿主解析快照并缓存 meta，才能推导公开端口。
    const nestedOuter = {
      ...manifest(), capabilityId: 'nested-outer', name: '嵌套外层',
      outputs: [{ id: 'text', label: '文本', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'c1', portId: 'out-polished' } }],
      graph: {
        nodes: [{
          id: 'c1', nodeType: 'composite', contractVersion: 1, title: '内层', dx: 0, dy: 0, w: 340, h: 260,
          config: JSON.stringify({ capabilityId: 'copy-polish', version: '1.0', contentHash: published.response.data.contentHash }),
          ports: [{ id: 'out-polished', name: '整理结果', dir: 'out', type: 'text', required: true, cardinality: 'one' }]
        }],
        edges: []
      },
      dependencies: [
        { kind: 'node', id: 'composite', contractVersion: 1 },
        { kind: 'capability', id: 'copy-polish', version: '1.0' }
      ]
    }
    ok2(await cli(dir, ['composite', 'publish'], { manifest: nestedOuter }), 'PUBLISH_NESTED')
    const refsNested = ok2(await cli(dir, ['composite', 'references'], { capabilityId: 'copy-polish' }), 'REFERENCES_NESTED')
    if (!refsNested.nestedVersions.some((r) => r.capabilityId === 'nested-outer' && r.refVersion === '1.0'))
      throw new Error(`NESTED_REFERENCE_MISSING:${JSON.stringify(refsNested)}`)
    receipt.checks.push('CLI composite.references 识别发布版本嵌套固定引用')

    // W3：嵌套外层真实运行（引用形态内部节点 → 隔离执行解析快照 → 输出投影）。
    const nestedPatched = await patchWithRetry(dir, projectId, [
      { action: 'node.create', nodeType: 'composite', title: '嵌套外层实例', x: 600, y: 120, w: 340, h: 260, config: { capabilityId: 'nested-outer', version: '1.0' } }
    ], 'PATCH_NESTED_INSTANCE')
    const nestedNodeId = nestedPatched.created[0].nodeId
    const nestedExecuted = await withVersionRetry(dir, projectId, 'EXECUTE_NESTED', (graphVersion) =>
      cli(dir, ['node', 'execute'], {
        projectId,
        expectedGraphVersion: graphVersion,
        nodeIds: [nestedNodeId],
        mode: 'single'
      })
    )
    await cli(dir, ['run', 'wait'], { projectId, taskId: nestedExecuted.taskId, timeoutMs: 60000 })
    const nestedOutput = await waitForOutputs(dir, projectId, nestedNodeId, (r) => r.outputs.some((item) => item.portId === 'out-text' && item.text === '内部说明'), 'OUTPUT_NESTED')
    const nestedText = nestedOutput.outputs.find((item) => item.portId === 'out-text')?.text
    if (nestedText !== '内部说明') throw new Error(`NESTED_TEXT_MISMATCH:${String(nestedText)}`)
    receipt.outputs.nestedRunText = nestedText
    receipt.checks.push('CLI 嵌套外层真实运行：引用形态内部节点解析固定版本并输出文本')

    // 无引用能力可删除；归档隐藏发现入口但版本仍可读。
    const disposable = { ...manifest(), capabilityId: 'disposable', name: '待删除' }
    ok2(await cli(dir, ['composite', 'publish'], { manifest: disposable }), 'PUBLISH_DISPOSABLE')
    const deleted = ok2(await cli(dir, ['composite', 'delete'], { capabilityId: 'disposable' }), 'DELETE_DISPOSABLE')
    if (deleted.deleted !== true) throw new Error(`DELETE_FAILED:${JSON.stringify(deleted)}`)
    const gone = await cli(dir, ['composite', 'get'], { capabilityId: 'disposable' })
    if (gone.response?.error?.code !== 'NOT_FOUND') throw new Error(`DELETE_NOT_PERSISTED:${JSON.stringify(gone.response)}`)
    const archivable = { ...manifest(), capabilityId: 'archivable', name: '待归档' }
    ok2(await cli(dir, ['composite', 'publish'], { manifest: archivable }), 'PUBLISH_ARCHIVABLE')
    ok2(await cli(dir, ['composite', 'archive'], { capabilityId: 'archivable' }), 'ARCHIVE')
    const searchDefault = ok2(await cli(dir, ['composite', 'search'], {}), 'SEARCH_DEFAULT')
    if (searchDefault.items.some((item) => item.id === 'archivable'))
      throw new Error(`ARCHIVE_NOT_HIDDEN:${JSON.stringify(searchDefault)}`)
    const searchAll = ok2(await cli(dir, ['composite', 'search'], { includeArchived: true }), 'SEARCH_ALL')
    if (!searchAll.items.some((item) => item.id === 'archivable'))
      throw new Error(`ARCHIVE_NOT_LISTED:${JSON.stringify(searchAll)}`)
    const archivedVersion = ok2(await cli(dir, ['composite', 'get'], { capabilityId: 'archivable', version: '1.0' }), 'ARCHIVED_VERSION')
    if (archivedVersion.version !== '1.0') throw new Error(`ARCHIVED_VERSION_UNREADABLE:${JSON.stringify(archivedVersion)}`)
    ok2(await cli(dir, ['composite', 'archive'], { capabilityId: 'archivable', archived: false }), 'UNARCHIVE')
    receipt.checks.push('CLI 无引用删除成功；归档隐藏发现入口、固定版本仍可读、可恢复')

    // MCP：同一 Registry/业务实现，验证工具目录与 composite.validate 输出。
    const transport = new StdioClientTransport({
      command: require('electron'),
      args: [path.join(root, 'out/main/local-agent.js'), 'mcp', 'serve', '--stdio', '--data-dir', dir],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe'
    })
    const mcp = new Client({ name: 'w1-acceptance', version: '1.0.0' }, { capabilities: {} })
    await mcp.connect(transport)
    try {
      const tools = await mcp.listTools()
      if (!tools.tools.some((tool) => tool.name === 'composite_upgrade_preview'))
        throw new Error('MCP_COMPOSITE_TOOL_MISSING')
      if (!tools.tools.some((tool) => tool.name === 'composite_upgrade_apply'))
        throw new Error('MCP_UPGRADE_APPLY_TOOL_MISSING')
      if (!tools.tools.some((tool) => tool.name === 'composite_references'))
        throw new Error('MCP_REFERENCES_TOOL_MISSING')
      if (!tools.tools.some((tool) => tool.name === 'composite_delete'))
        throw new Error('MCP_DELETE_TOOL_MISSING')
      const validated = await mcp.callTool({
        name: 'composite_validate',
        arguments: { input: { manifest: inner } }
      })
      if (validated.structuredContent?.status !== 'completed' || validated.structuredContent?.data?.ok !== true)
        throw new Error(`MCP_VALIDATE_FAILED:${JSON.stringify(validated)}`)
      const fetched = await mcp.callTool({
        name: 'composite_get',
        arguments: { input: { capabilityId: 'copy-polish', version: '1.0' } }
      })
      if (fetched.structuredContent?.status !== 'completed' || fetched.structuredContent?.data?.version !== '1.0')
        throw new Error(`MCP_GET_FAILED:${JSON.stringify(fetched)}`)
      const mcpRefs = await mcp.callTool({
        name: 'composite_references',
        arguments: { input: { capabilityId: 'copy-polish' } }
      })
      if (mcpRefs.structuredContent?.status !== 'completed' || !(mcpRefs.structuredContent?.data?.projectInstances?.length >= 2))
        throw new Error(`MCP_REFERENCES_FAILED:${JSON.stringify(mcpRefs)}`)
      // 写操作必须带幂等键（与 CLI 助手同口径）；缺键会在协议层 INVALID_INPUT，
      // 到不了引用保护分支。
      const mcpDelete = await mcp.callTool({
        name: 'composite_delete',
        arguments: { input: { capabilityId: 'copy-polish' }, idempotencyKey: key() }
      })
      if (mcpDelete.structuredContent?.error?.code !== 'CAPABILITY_IN_USE')
        throw new Error(`MCP_DELETE_NOT_BLOCKED:${JSON.stringify(mcpDelete)}`)
      receipt.checks.push('MCP composite.validate / composite.get / references / delete 引用保护')
    } finally {
      await mcp.close().catch(() => undefined)
    }
    console.log(JSON.stringify({ ok: true, ...receipt }, null, 2))
    fs.mkdirSync(path.join(root, 'qa', 'w3-desktop-acceptance'), { recursive: true })
    fs.writeFileSync(path.join(root, 'qa', 'w3-desktop-acceptance', 'receipt.json'), JSON.stringify({ ok: true, ...receipt }, null, 2))
    fs.writeFileSync(path.join(root, 'qa', 'w3-desktop-acceptance', 'renderer-console.log'), consoleLog.join('\n'))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error?.stack || error), ...receipt }, null, 2))
    fs.mkdirSync(path.join(root, 'qa', 'w3-desktop-acceptance'), { recursive: true })
    fs.writeFileSync(path.join(root, 'qa', 'w3-desktop-acceptance', 'receipt.json'), JSON.stringify({ ok: false, error: String(error?.stack || error), ...receipt }, null, 2))
    fs.writeFileSync(path.join(root, 'qa', 'w3-desktop-acceptance', 'renderer-console.log'), consoleLog.join('\n'))
    process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => undefined)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})()
