/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// runtimeVersion=1 real CLI/MCP acceptance: published legacy headless execution plus
// an old inline `{manifest}` composite instance on the desktop. No fake ports/receipts.
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const {
  root,
  sleep,
  cli,
  ok,
  launchApp,
  startMcp,
  mcpOk
} = require('./lib/e2e-transport.cjs')

const evidenceDir = path.join(root, 'qa', 'local-agent-access', 'composite-legacy-runtime-e2e')
const reportPath = path.join(evidenceDir, 'report.json')
const report = {
  schemaVersion: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  scenarios: []
}

function assert(condition, label) {
  if (!condition) throw new Error(`ASSERT_FAILED:${label}`)
}

function persist() {
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
}

function legacyManifest(capabilityId) {
  return {
    schemaVersion: 1,
    // Deliberately absent: historical manifests run with runtimeVersion=1.
    capabilityId,
    version: '1.0',
    name: capabilityId,
    inputs: [],
    outputs: [
      {
        id: 'picture',
        label: '历史图片',
        type: 'image',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n1', portId: 'out-image' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'n1',
          nodeType: 'image',
          contractVersion: 3,
          title: '固定历史图片',
          dx: 0,
          dy: 0,
          w: 340,
          h: 300,
          mediaRefs: [
            {
              mediaId: 'legacy-media',
              mediaPath: 'projects/legacy.png',
              mime: 'image/png'
            }
          ],
          ports: [
            {
              id: 'out-image',
              name: '图片',
              dir: 'out',
              type: 'image',
              required: true,
              cardinality: 'one'
            }
          ]
        }
      ],
      edges: []
    },
    dependencies: [{ kind: 'node', id: 'image', contractVersion: 3 }],
    executionPolicy: {
      timeoutMs: 120000,
      maxDepth: 5,
      maxExpandedNodes: 40,
      maxExpandedEdges: 120,
      waitForInput: true
    }
  }
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

async function waitCompositeCompleted(driver, runId) {
  let status = 'not-created'
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const detail = await driver.ok('composite.run.get', { runId })
      status = detail.run.status
      if (status === 'completed') return detail
      if (['failed', 'cancelled', 'interrupted'].includes(status))
        throw new Error(`LEGACY_HEADLESS_${status}:${detail.run.errorCode}`)
    } catch (error) {
      if (String(error?.message ?? error).includes('LEGACY_HEADLESS_')) throw error
    }
    await sleep(100)
  }
  throw new Error(`LEGACY_HEADLESS_TIMEOUT:${status}`)
}

async function readLegacyHeadlessDb(session, runId) {
  return session.app.evaluate(async ({ app }, { dir, runId }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const Database = require('better-sqlite3')
    const db = new Database(dir + '/app.db', { readonly: true, fileMustExist: true })
    try {
      return db.prepare('SELECT output_summary,output_values FROM composite_runs WHERE id=?').get(runId)
    } finally {
      db.close()
    }
  }, { dir: session.dir, runId })
}

async function waitInlineOutput(driver, projectId, nodeId) {
  let last = null
  for (let attempt = 0; attempt < 100; attempt++) {
    const output = await driver.ok('output.get', { projectId, nodeId })
    last = output
    if (output.outputs.some((item) => item.portId === 'out-picture')) return output
    await sleep(100)
  }
  throw new Error(`LEGACY_INLINE_OUTPUT_TIMEOUT:${JSON.stringify(last).slice(0, 500)}`)
}

async function runLegacyScenario(driver, session) {
  const manifest = legacyManifest(`accept-legacy-${driver.kind}`)
  const validation = await driver.ok('composite.validate', { manifest })
  assert(validation.ok === true, `${driver.kind} legacy validation ${JSON.stringify(validation.issues)}`)
  await driver.ok('composite.publish', { manifest })

  const started = await driver.ok('composite.execute', {
    capabilityId: manifest.capabilityId,
    version: '1.0',
    inputs: [],
    confirmCost: true
  })
  const detail = await waitCompositeCompleted(driver, started.runId)
  assert(detail.run.outputValues?.['out-picture']?.kind === 'image' &&
    detail.run.outputValues['out-picture'].mediaId === 'legacy-media',
  `${driver.kind} headless run.get out-picture`)
  const waited = await driver.ok('composite.execute.wait', { runId: started.runId, timeoutMs: 100 })
  assert(waited.status === 'completed' && waited.outputs?.['out-picture']?.mediaId === 'legacy-media',
    `${driver.kind} headless execute.wait out-picture`)
  const stored = await readLegacyHeadlessDb(session, started.runId)
  const storedValues = JSON.parse(stored.output_values)
  const storedSummary = JSON.parse(stored.output_summary)
  assert(storedValues.picture?.mediaId === 'legacy-media' && storedValues.picture?.kind === 'image',
    `${driver.kind} database keeps bare public id with real media value`)
  assert(storedSummary.length === 1 && storedSummary[0].portId === 'out-picture',
    `${driver.kind} database stores out-picture summary`)

  const created = await driver.ok('project.create', { name: `[TEST] legacy inline ${driver.kind}` })
  const projectId = created.meta.id
  await driver.ok('project.open', { projectId })
  const graph = await driver.ok('graph.get', { projectId })
  const patch = await driver.ok('graph.patch', {
    projectId,
    expectedGraphVersion: graph.graphVersion,
    ops: [
      {
        action: 'node.create',
        ref: 'legacy-inline',
        nodeType: 'composite',
        title: '旧内嵌实例',
        x: 100,
        y: 100,
        config: { manifest }
      }
    ]
  })
  const nodeId = patch.created.find((item) => item.ref === 'legacy-inline')?.nodeId
  assert(typeof nodeId === 'string', `${driver.kind} old inline composite persisted`)
  const executed = await driver.ok('node.execute', {
    projectId,
    expectedGraphVersion: patch.graphVersion,
    nodeIds: [nodeId],
    mode: 'single'
  })
  const nodeRun = await driver.ok('run.wait', {
    projectId,
    taskId: executed.taskId,
    timeoutMs: 30000
  })
  assert(nodeRun.state === 'completed', `${driver.kind} inline node run completed`)
  const inlineOutput = await waitInlineOutput(driver, projectId, nodeId)
  const picture = inlineOutput.outputs.find((item) => item.portId === 'out-picture')
  assert(picture?.kind === 'image' && picture.mediaId === 'legacy-media' &&
    picture.mediaPath === 'projects/legacy.png',
  `${driver.kind} old inline instance output.get`)

  report.scenarios.push({
    transport: driver.kind,
    scenario: 'runtimeVersion=1',
    headlessRunId: started.runId,
    headlessOutputPorts: Object.keys(detail.run.outputValues),
    storedOutputKeys: Object.keys(storedValues),
    inlineNodeRun: nodeRun.state,
    inlineOutputPort: picture.portId
  })
  persist()
  console.log(`[pass] ${driver.kind} legacy headless + inline`)
}

async function cleanup(dir) {
  const resolved = path.resolve(dir)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith('canvas-composite-legacy-'))
    throw new Error(`cleanup target rejected: ${resolved}`)
  await fsp.rm(resolved, { recursive: true, force: true })
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-composite-legacy-'))
  const session = { dir, app: null, page: null, instanceId: null, pid: null }
  let mcpSession = null
  try {
    const launched = await launchApp(dir, '[TEST] legacy composite runtime')
    Object.assign(session, launched)
    await runLegacyScenario(cliDriver(dir), session)

    mcpSession = await startMcp(dir, { instanceId: session.instanceId, pid: session.pid })
    await runLegacyScenario(mcpDriver(mcpSession), session)
    report.status = 'passed'
    report.finishedAt = new Date().toISOString()
    persist()
  } catch (error) {
    report.status = 'failed'
    report.error = String(error?.stack ?? error).slice(0, 5000)
    report.finishedAt = new Date().toISOString()
    persist()
    console.error(`[fail] ${report.error.split('\n')[0]}`)
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
    report: path.relative(root, reportPath)
  }))
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
