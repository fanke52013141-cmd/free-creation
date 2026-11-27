/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// H01/H09/H10 real desktop acceptance. CLI and MCP independently drive the production
// access service; no fake desktop port, synthetic operation response, or success receipt.
// Legacy H10 versions are fixture rows in the real store so the current runtime admission
// can be tested even though current publication validation intentionally rejects them.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const {
  root,
  sleep,
  cli,
  ok,
  launchApp,
  startMcp,
  mcpOk
} = require('./lib/e2e-transport.cjs')

const evidenceDir = path.join(root, 'qa', 'local-agent-access', 'composite-remediation-e2e')
const reportPath = path.join(evidenceDir, 'report.json')
const nativeConfirmScript = path.join(root, 'scripts', 'acceptance', 'lib', 'confirm-native-dialog.ps1')
const report = {
  schemaVersion: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  transports: {
    cli: 'real Electron local-agent process',
    mcp: 'official MCP SDK stdio client'
  },
  restartVerified: false,
  humanConfirmations: [],
  scenarios: []
}
let currentScenario = 'startup'

function assert(condition, label) {
  if (!condition) throw new Error(`ASSERT_FAILED:${label}`)
}

function persist() {
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
}

function pass(driver, scenario, details) {
  report.scenarios.push({ transport: driver.kind, scenario, ...details })
  persist()
  console.log(`[pass] ${driver.kind} ${scenario}`)
}

function textNode(id, text = '') {
  return {
    id,
    nodeType: 'text',
    contractVersion: 3,
    title: id,
    dx: 0,
    dy: 0,
    w: 340,
    h: 260,
    text,
    ports: [
      { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: false, cardinality: 'many' },
      { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }
    ]
  }
}

function humanNode(id) {
  return {
    id,
    nodeType: 'human-task',
    contractVersion: 1,
    title: id,
    dx: 0,
    dy: 0,
    w: 340,
    h: 260,
    config: JSON.stringify({ schemaVersion: 1, outputType: 'text' }),
    ports: [
      { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: false, cardinality: 'many' },
      { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }
    ]
  }
}

function basePolicy(patch = {}) {
  return {
    timeoutMs: 120000,
    maxDepth: 5,
    maxExpandedNodes: 40,
    maxExpandedEdges: 120,
    waitForInput: true,
    ...patch
  }
}

function h01Manifest(capabilityId) {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId,
    version: '1.0',
    name: capabilityId,
    inputs: [
      {
        id: 'payload',
        label: 'JSON 原文',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'source', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'parsed',
        label: '解析结果',
        type: 'json',
        required: true,
        cardinality: 'one',
        schemaRef: { id: 'json.any', version: 1 },
        source: { nodeId: 'bad-json', portId: 'out-json' }
      },
      {
        id: 'independent',
        label: '独立分支',
        type: 'text',
        required: false,
        cardinality: 'one',
        source: { nodeId: 'independent', portId: 'out-text' }
      }
    ],
    graph: {
      nodes: [
        textNode('source'),
        {
          id: 'bad-json',
          nodeType: 'json',
          contractVersion: 1,
          title: 'bad-json',
          dx: 380,
          dy: 0,
          w: 340,
          h: 260,
          ports: [
            { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: true, cardinality: 'one' },
            {
              id: 'out-json',
              name: 'JSON',
              dir: 'out',
              type: 'json',
              required: true,
              cardinality: 'one',
              schemaRef: { id: 'json.any', version: 1 }
            }
          ]
        },
        textNode('independent', 'independent-ok')
      ],
      edges: [
        {
          from: { nodeId: 'source', portId: 'out-text' },
          to: { nodeId: 'bad-json', portId: 'in-text' }
        }
      ]
    },
    dependencies: [
      { kind: 'node', id: 'text', contractVersion: 3 },
      { kind: 'node', id: 'json', contractVersion: 1 }
    ],
    executionPolicy: basePolicy({ onBranchFailure: 'continue', maxConcurrency: 2 })
  }
}

function h09Manifest(capabilityId, first) {
  const second = first === 'h1' ? 'h2' : 'h1'
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId,
    version: '1.0',
    name: capabilityId,
    inputs: [],
    outputs: ['h1', 'h2'].map((id) => ({
      id,
      label: id,
      type: 'text',
      required: true,
      cardinality: 'one',
      source: { nodeId: id, portId: 'out-text' }
    })),
    graph: { nodes: [humanNode(first), humanNode(second)], edges: [] },
    dependencies: [{ kind: 'node', id: 'human-task', contractVersion: 1 }],
    executionPolicy: basePolicy({ requiresManualGate: true, maxConcurrency: 4 })
  }
}

function humanLeaf(capabilityId) {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId,
    version: '1.0',
    name: capabilityId,
    inputs: [
      {
        id: 'msg',
        label: '人工输入',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'h1', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'echo',
        label: '人工输出',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'h1', portId: 'out-text' }
      }
    ],
    graph: { nodes: [humanNode('h1')], edges: [] },
    dependencies: [{ kind: 'node', id: 'human-task', contractVersion: 1 }],
    executionPolicy: basePolicy({ requiresManualGate: true })
  }
}

function nestedShell(capabilityId, child, childHash) {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId,
    version: '1.0',
    name: capabilityId,
    inputs: [
      {
        id: 'msg',
        label: '外层输入',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'c1', portId: 'in-msg' }]
      }
    ],
    outputs: [
      {
        id: 'final',
        label: '外层输出',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'c1', portId: 'out-echo' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'c1',
          nodeType: 'composite',
          contractVersion: 1,
          title: 'nested-human-gate',
          dx: 0,
          dy: 0,
          w: 340,
          h: 260,
          config: JSON.stringify({
            ref: {
              capabilityId: child.capabilityId,
              version: child.version,
              contentHash: childHash
            }
          }),
          ports: [
            { id: 'in-msg', name: '输入', dir: 'in', type: 'text', required: true, cardinality: 'one' },
            { id: 'out-echo', name: '输出', dir: 'out', type: 'text', required: true, cardinality: 'one' }
          ]
        }
      ],
      edges: []
    },
    dependencies: [
      { kind: 'node', id: 'composite', contractVersion: 1 },
      { kind: 'capability', id: child.capabilityId, version: child.version }
    ],
    // Deliberately models a legacy snapshot without requiresManualGate propagation.
    executionPolicy: basePolicy()
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function manifestHash(manifest) {
  const { contentHash: ignored, ...rest } = manifest
  void ignored
  return createHash('sha256').update(stableStringify(rest)).digest('hex')
}

async function seedLegacyVersions(session, manifests) {
  const records = manifests.map((manifest) => ({ manifest, contentHash: manifestHash(manifest) }))
  return session.app.evaluate(async ({ app }, { dir, records }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const Database = require('better-sqlite3')
    const db = new Database(dir + '/app.db')
    try {
      return db.transaction(() => {
        const now = Date.now()
        for (const { manifest, contentHash } of records) {
          db.prepare(`INSERT INTO composite_capabilities
            (id,name,description,tags,latest_version,archived,created_at,updated_at)
            VALUES (?,?,?,?,?,0,?,?)`).run(
            manifest.capabilityId,
            manifest.name,
            manifest.description ?? '',
            JSON.stringify(manifest.tags ?? []),
            manifest.version,
            now,
            now
          )
          db.prepare(`INSERT INTO composite_versions
            (capability_id,version,manifest,content_hash,published_at,published_by)
            VALUES (?,?,?,?,?,?)`).run(
            manifest.capabilityId,
            manifest.version,
            JSON.stringify(manifest),
            contentHash,
            now,
            'acceptance-legacy-fixture'
          )
        }
        return records.length
      }).immediate()
    } finally {
      db.close()
    }
  }, { dir: session.dir, records })
}

async function readRunDb(session, runId) {
  return session.app.evaluate(async ({ app }, { dir, runId }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const Database = require('better-sqlite3')
    const db = new Database(dir + '/app.db', { readonly: true, fileMustExist: true })
    try {
      return {
        run: db.prepare('SELECT * FROM composite_runs WHERE id=?').get(runId),
        waits: db.prepare('SELECT * FROM composite_run_waits WHERE run_id=? ORDER BY revision').all(runId),
        steps: db.prepare('SELECT * FROM composite_run_steps WHERE run_id=? ORDER BY started_at,step_key').all(runId)
      }
    } finally {
      db.close()
    }
  }, { dir: session.dir, runId })
}

function cliDriver(dir) {
  return {
    kind: 'cli',
    async ok(operationId, input) {
      return ok(await cli(dir, operationId.split('.'), input), operationId)
    }
  }
}

function mcpDriver(mcp) {
  return {
    kind: 'mcp',
    async ok(operationId, input) {
      return mcpOk(await mcp.call(operationId, input), operationId)
    }
  }
}

async function waitForRun(driver, session, runId, predicate, label) {
  let lastStatus = 'not-created'
  let lastError = ''
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const [detail, db] = await Promise.all([
        driver.ok('composite.run.get', { runId }),
        readRunDb(session, runId)
      ])
      lastStatus = detail.run.status
      if (predicate(detail, db)) return { detail, db }
      if (detail.run.status === 'failed' && !label.includes('failed')) {
        throw new Error(`${label}:unexpected failure ${detail.run.errorCode}`)
      }
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 300)
    }
    await sleep(100)
  }
  throw new Error(`${label}:timeout status=${lastStatus} ${lastError}`)
}

async function validateAndPublish(driver, manifest) {
  const validation = await driver.ok('composite.validate', { manifest })
  assert(validation.ok === true, `${manifest.capabilityId} validation ${JSON.stringify(validation.issues)}`)
  await driver.ok('composite.publish', { manifest })
}

async function stepFailureEvents(driver, runId, stepKey) {
  const result = await driver.ok('diagnostics.query', { traceId: runId, limit: 200 })
  return result.events.filter((event) =>
    event.event === 'composite.run.step_failed' && event.attributes?.stepKey === stepKey
  )
}

async function runH01(driver, session) {
  const capabilityId = `accept-h01-${driver.kind}`
  const manifest = h01Manifest(capabilityId)
  await validateAndPublish(driver, manifest)
  const started = await driver.ok('composite.execute', {
    capabilityId,
    version: '1.0',
    inputs: [{ portId: 'in-payload', value: { kind: 'text', text: '{not-valid-json' } }],
    confirmCost: true
  })
  const runId = started.runId
  const { detail } = await waitForRun(
    driver,
    session,
    runId,
    (current) => current.run.status === 'failed',
    'H01 failed'
  )
  assert(detail.run.errorCode === 'NODE_FAILED', 'H01 overall NODE_FAILED')
  assert(detail.run.failureNodeId === 'bad-json', 'H01 failure node is bad-json')
  assert(detail.steps.filter((step) => step.stepKey === 'bad-json' && step.status === 'failed').length === 1,
    'H01 failed step row')
  assert(detail.steps.some((step) => step.stepKey === 'independent' && step.status === 'completed'),
    'H01 independent branch completed')
  let events = []
  for (let attempt = 0; attempt < 30; attempt++) {
    events = await stepFailureEvents(driver, runId, 'bad-json')
    if (events.length > 0) break
    await sleep(200)
  }
  await sleep(600)
  events = await stepFailureEvents(driver, runId, 'bad-json')
  assert(events.length === 1, `H01 bad-json admitted exactly once (diagnostics=${events.length})`)
  pass(driver, 'H01', {
    runId,
    status: detail.run.status,
    failedStep: 'bad-json',
    failureAdmissions: events.length,
    independentCompleted: true
  })
}

function confirmNativeHumanDecision(session) {
  if (process.platform !== 'win32') {
    console.log('[manual] 请在应用弹出的原生确认框中点击「允许提交」；脚本会等待生产门禁返回')
    return Promise.resolve('manual-native-dialog')
  }
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', nativeConfirmScript,
      '-ProcessId', String(session.pid),
      '-WindowTitle', '外部 Agent 请求代你提交节点流人工结果',
      '-ButtonName', '允许提交',
      '-TimeoutMs', '60000'
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && stdout.includes('NATIVE_CONFIRM_INVOKED')) {
        resolve('windows-uia-invoke')
        return
      }
      reject(new Error(
        `NATIVE_CONFIRM_DRIVER_FAILED: code=${code} signal=${signal} ${stdout}\n${stderr}`.slice(0, 1000)
      ))
    })
  })
}

async function submitHumanWithConfirmation(driver, session, input) {
  console.log(`[human] ${driver.kind}/${input.nodeId}: 发起生产人工确认并等待真实「允许提交」按钮`)
  const pending = driver.ok('composite.run.submitHuman', input)
  const confirmation = confirmNativeHumanDecision(session)
  const [result, mode] = await Promise.all([pending, confirmation])
  report.humanConfirmations.push({
    transport: driver.kind,
    nodeId: input.nodeId,
    mode,
    confirmedAt: new Date().toISOString()
  })
  persist()
  return result
}

async function runH09(driver, session, first, restart) {
  const second = first === 'h1' ? 'h2' : 'h1'
  const capabilityId = `accept-h09-${driver.kind}-${first}`
  const manifest = h09Manifest(capabilityId, first)
  await validateAndPublish(driver, manifest)
  const started = await driver.ok('composite.execute', {
    capabilityId,
    version: '1.0',
    inputs: [],
    confirmCost: true
  })
  const runId = started.runId
  const submissions = {
    h1: `h1-${driver.kind}-approved`,
    h2: `h2-${driver.kind}-approved`
  }
  const firstWait = await waitForRun(
    driver,
    session,
    runId,
    (current, db) => current.run.status === 'waiting-input' &&
      db.waits.length === 1 && db.waits[0].state === 'open' &&
      db.waits[0].step_key === first && db.waits[0].revision === 1,
    'H09 first wait'
  )
  assert(firstWait.db.waits.filter((wait) => wait.state === 'open').length === 1,
    'H09 only one unsatisfied wait at first checkpoint')

  if (restart) {
    await session.app.close()
    const launched = await launchApp(session.dir, '[TEST] composite remediation restart')
    session.app = launched.app
    session.page = launched.page
    session.instanceId = launched.instanceId
    session.pid = launched.pid
    const recovered = await waitForRun(
      driver,
      session,
      runId,
      (current, db) => current.run.status === 'waiting-input' &&
        db.waits.length === 1 && db.waits[0].state === 'open' && db.waits[0].step_key === first,
      'H09 restart recovery'
    )
    assert(recovered.db.waits[0].revision === 1, 'H09 open wait revision survives restart')
    report.restartVerified = true
    persist()
  }

  await submitHumanWithConfirmation(driver, session, {
    runId,
    nodeId: first,
    value: { kind: 'text', text: submissions[first] }
  })
  const satisfiedFirst = await readRunDb(session, runId)
  assert(satisfiedFirst.waits[0].state === 'satisfied' && satisfiedFirst.waits[0].revision === 1,
    'H09 first submission satisfies revision 1')
  await driver.ok('composite.run.resume', { runId })
  const secondWait = await waitForRun(
    driver,
    session,
    runId,
    (current, db) => current.run.status === 'waiting-input' &&
      db.waits.length === 2 && db.waits[0].state === 'satisfied' &&
      db.waits[1].state === 'open' && db.waits[1].step_key === second && db.waits[1].revision === 2,
    'H09 second wait'
  )
  assert(secondWait.db.waits.filter((wait) => wait.state === 'open').length === 1,
    'H09 only one unsatisfied wait at second checkpoint')
  assert(secondWait.db.steps.filter((step) => step.step_key === first && step.status === 'completed').length === 1,
    `H09 first human completed before second wait: ${JSON.stringify(secondWait.db.steps)}`)

  await submitHumanWithConfirmation(driver, session, {
    runId,
    nodeId: second,
    value: { kind: 'text', text: submissions[second] }
  })
  await driver.ok('composite.run.resume', { runId })
  const completed = await waitForRun(
    driver,
    session,
    runId,
    (current) => current.run.status === 'completed',
    'H09 completed'
  )
  const finalDb = await readRunDb(session, runId)
  assert(finalDb.waits.length === 2, 'H09 exactly two wait revisions')
  assert(finalDb.waits.every((wait) => wait.state === 'satisfied'), 'H09 both waits satisfied')
  assert(finalDb.waits.map((wait) => wait.revision).join(',') === '1,2', 'H09 revisions are 1,2')
  assert(finalDb.waits.map((wait) => wait.step_key).join(',') === `${first},${second}`,
    'H09 wait order matches submission order')
  assert(finalDb.waits.filter((wait) => wait.state === 'open').length === 0, 'H09 no open wait remains')
  for (const nodeId of [first, second]) {
    assert(finalDb.steps.filter((step) => step.step_key === nodeId && step.status === 'completed').length === 1,
      `H09 ${nodeId} completed once`)
  }
  const storedOutputs = JSON.parse(finalDb.run.output_values)
  assert(storedOutputs.h1?.text === submissions.h1 && storedOutputs.h2?.text === submissions.h2,
    'H09 database stores both real human outputs')
  assert(completed.detail.run.outputValues?.['out-h1']?.text === submissions.h1 &&
    completed.detail.run.outputValues?.['out-h2']?.text === submissions.h2,
  'H09 run.get exposes out- prefixed outputs')
  const waited = await driver.ok('composite.execute.wait', { runId, timeoutMs: 100 })
  assert(waited.status === 'completed' && waited.outputs?.['out-h1']?.text === submissions.h1 &&
    waited.outputs?.['out-h2']?.text === submissions.h2,
  'H09 execute.wait exposes the same out- outputs')
  pass(driver, 'H09', {
    runId,
    order: `${first}->${second}`,
    revisions: finalDb.waits.map((wait) => wait.revision),
    steps: finalDb.steps.map((step) => ({ stepKey: step.step_key, status: step.status })),
    outputPorts: Object.keys(completed.detail.run.outputValues).sort(),
    restart
  })
}

async function runH10(driver, session, indirect) {
  const scenario = indirect ? 'H10-indirect' : 'H10-direct'
  const suffix = `${driver.kind}-${indirect ? 'indirect' : 'direct'}`
  const leaf = humanLeaf(`accept-h10-leaf-${suffix}`)
  const leafHash = manifestHash(leaf)
  let top
  let fixtures
  if (indirect) {
    const mid = nestedShell(`accept-h10-mid-${suffix}`, leaf, leafHash)
    const midHash = manifestHash(mid)
    top = nestedShell(`accept-h10-top-${suffix}`, mid, midHash)
    fixtures = [leaf, mid, top]
  } else {
    top = nestedShell(`accept-h10-top-${suffix}`, leaf, leafHash)
    fixtures = [leaf, top]
  }
  await seedLegacyVersions(session, fixtures)
  const validation = await driver.ok('composite.validate', { manifest: top })
  assert(validation.ok === false, `${scenario} validation rejected`)
  assert(validation.issues.some((issue) => issue.code === 'NESTED_MANUAL_GATE_UNSUPPORTED'),
    `${scenario} validation stable nested manual-gate code`)
  const started = await driver.ok('composite.execute', {
    capabilityId: top.capabilityId,
    version: '1.0',
    inputs: [{ portId: 'in-msg', value: { kind: 'text', text: 'legacy nested input' } }],
    confirmCost: true
  })
  const runId = started.runId
  const { detail, db } = await waitForRun(
    driver,
    session,
    runId,
    (current) => current.run.status === 'failed' &&
      current.run.errorCode === 'NESTED_MANUAL_GATE_UNSUPPORTED',
    `${scenario} failed`
  )
  assert(detail.run.failureNodeId === 'c1', `${scenario} failure points to direct nested node`)
  assert(detail.steps.length === 0 && db.steps.length === 0, `${scenario} zero internal steps`)
  pass(driver, scenario, {
    runId,
    levels: fixtures.length,
    validationCode: 'NESTED_MANUAL_GATE_UNSUPPORTED',
    runError: detail.run.errorCode,
    internalSteps: detail.steps.length
  })
}

async function cleanup(dir) {
  const resolved = path.resolve(dir)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith('canvas-composite-remediation-'))
    throw new Error(`cleanup target rejected: ${resolved}`)
  await fsp.rm(resolved, { recursive: true, force: true })
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-composite-remediation-'))
  const session = { dir, app: null, page: null, instanceId: null, pid: null }
  let mcpSession = null
  try {
    const launched = await launchApp(dir)
    session.app = launched.app
    session.page = launched.page
    session.instanceId = launched.instanceId
    session.pid = launched.pid
    const cli = cliDriver(dir)

    currentScenario = 'cli/H01'
    await runH01(cli, session)
    currentScenario = 'cli/H09'
    await runH09(cli, session, 'h1', true)
    currentScenario = 'cli/H10-direct'
    await runH10(cli, session, false)
    currentScenario = 'cli/H10-indirect'
    await runH10(cli, session, true)

    currentScenario = 'mcp/startup'
    mcpSession = await startMcp(dir, { instanceId: session.instanceId, pid: session.pid })
    const tools = await mcpSession.client.listTools()
    assert(tools.tools.some((tool) => tool.name === 'composite_execute'), 'MCP exposes real composite_execute')
    const mcp = mcpDriver(mcpSession)
    currentScenario = 'mcp/H01'
    await runH01(mcp, session)
    currentScenario = 'mcp/H09'
    await runH09(mcp, session, 'h2', false)
    currentScenario = 'mcp/H10-direct'
    await runH10(mcp, session, false)
    currentScenario = 'mcp/H10-indirect'
    await runH10(mcp, session, true)

    report.status = 'passed'
    report.finishedAt = new Date().toISOString()
    persist()
  } catch (error) {
    report.status = 'failed'
    report.failedScenario = currentScenario
    report.error = String(error?.stack ?? error).slice(0, 5000)
    report.finishedAt = new Date().toISOString()
    persist()
    console.error(`[fail] ${currentScenario}: ${report.error.split('\n')[0]}`)
    process.exitCode = 1
  } finally {
    if (mcpSession) await mcpSession.close().catch(() => undefined)
    if (session.app) await session.app.close().catch(() => undefined)
    if (process.env.CANVAS_ACCEPTANCE_KEEP_FIXTURE !== '1') {
      await cleanup(dir).catch((error) => {
        console.error(`[cleanup] ${String(error?.message ?? error)}`)
        process.exitCode = 1
      })
    }
  }
  console.log(JSON.stringify({
    status: report.status,
    scenarios: report.scenarios.length,
    restartVerified: report.restartVerified,
    report: path.relative(root, reportPath)
  }))
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
