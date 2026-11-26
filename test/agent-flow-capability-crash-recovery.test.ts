import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowCommandLedger } from '../src/main/agent-flow/command-ledger'
import { FlowAgentDesktopHost } from '../src/main/agent-flow/desktop-host'
import { FlowCoordinatorHost } from '../src/main/agent-flow/coordinator-host'
import { CoordinationStore } from '../src/main/agent-flow/coordination-store'
import { FlowGraphSchema } from '../src/shared/agent-flow/flow-graph'
import { deriveFlowPhaseStateMachine } from '../src/shared/agent-flow/flow-graph-compiler'
import { PROCESSOR_PORTS } from '../src/shared/agent-flow/processor-contract'
import { computeInputFingerprint } from '../src/shared/engine/input-fingerprint'
import type { ProjectFile, CanvasNode } from '../src/shared/types'
import type { FlowCommandGrant } from '../src/shared/agent-flow/commands'

const directories: string[] = []
let worker: string

function isolated(): string {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-capability-crash-'))
  directories.push(directory)
  return directory
}

function runtime(directory: string, recovering: boolean) {
  const db = new Database(join(directory, 'flow.sqlite'))
  migrateDatabase(db)
  const projectPath = join(directory, 'project.json')
  const shape = (id: string, type: string, text = '', config = '') => ({
    id, type: 'node-card',
    props: { nodeType: type, title: id, text, config, mediaId: '', mediaPath: '', mediaMime: '', exec: 'idle', w: 340, h: 260 },
    meta: {} as Record<string, unknown>
  })
  let file: ProjectFile
  if (recovering) {
    file = JSON.parse(readFileSync(projectPath, 'utf8')) as ProjectFile
  } else {
    db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('isolated', 'test')
    const graph = FlowGraphSchema.parse({
      schemaVersion: 1,
      graphId: 'capability-hard-kill',
      name: 'capability hard kill',
      goal: 'verify committed recovery without replay',
      nodes: [
        { nodeId: 'target', title: 'target', participation: 'autonomous', kind: 'capability', capability: 'text-pass@1', goal: 'first', completion: 'first' },
        { nodeId: 'second', title: 'second', participation: 'autonomous', kind: 'capability', capability: 'text-pass@1', goal: 'second', completion: 'second' }
      ],
      edges: [{ from: { nodeId: 'target', portId: 'out-value' }, to: { nodeId: 'second', portId: 'in-value' }, kind: 'data' }],
      entry: 'target', exits: ['second']
    })
    const sm = deriveFlowPhaseStateMachine()
    const mainConfig = {
      schemaVersion: 1,
      role: 'coordinator', interactionMode: 'autonomous', skills: [],
      tools: [{ id: 'agent.dispatch', version: '1' }],
      allowedNodeIds: ['target', 'second'], maxSteps: 8, executionMode: 'graph', graph,
      relations: [{ relationId: 'state', kind: 'observes', sourceNodeId: 'main', targetNodeId: 'state' }]
    }
    const stateConfig = {
      schemaVersion: 1, initialState: 'idle', states: sm.states,
      transitions: sm.transitions, relations: []
    }
    const source = shape('source', 'text', 'private input')
    const main = shape('main', 'agent', 'capability recovery', JSON.stringify(mainConfig))
    const target = shape('target', 'processor', '', JSON.stringify({ operation: 'pass' }))
    const second = shape('second', 'processor', '', JSON.stringify({ operation: 'pass' }))
    const state = shape('state', 'state-machine', '', JSON.stringify(stateConfig))
    const asNode = (record: typeof source): CanvasNode => ({
      id: record.id,
      type: record.props.nodeType as CanvasNode['type'],
      contractVersion: record.props.nodeType === 'text' ? 3 : 1,
      title: record.props.title,
      x: 0, y: 0, w: 340, h: 260,
      ports: ['target', 'second'].includes(record.id)
        ? [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out]
        : record.id === 'source'
          ? [{ id: 'out-text', name: 'text', dir: 'out', type: 'text', cardinality: 'one', required: true }]
          : [],
      params: { config: record.props.config },
      content: record.props.text ? { kind: 'text', text: record.props.text } : { kind: 'empty' },
      exec: { status: 'idle' }, meta: { source: 'input', createdAt: 0 }
    })
    file = {
      version: 1,
      meta: { id: 'isolated', name: 'test', createdAt: 0, updatedAt: 0, graphVersion: 1 },
      nodes: [source, main, target, second, state].map(asNode),
      edges: [
        { id: 'edge-source-target', from: { nodeId: 'source', portId: 'out-text' }, to: { nodeId: 'target', portId: 'in-value' } },
        { id: 'edge-target-second', from: { nodeId: 'target', portId: 'out-value' }, to: { nodeId: 'second', portId: 'in-value' } }
      ],
      groups: [],
      tldrawSnapshot: { store: Object.fromEntries([source, main, target, second, state].map((record) => [record.id, record])) }
    }
  }
  const project = () => file
  const ledger = new FlowCommandLedger(db, project)
  const counts: Record<string, number> = { target: 0, second: 0 }
  const save = () => writeFileSync(projectPath, JSON.stringify(file))
  if (!recovering) save()
  const host = new FlowAgentDesktopHost(db, project, {
    ledger,
    isActive: () => true,
    deliver: async (grant: FlowCommandGrant) => {
      const command = grant.command
      const targetId = command.targetNodeId
      if (recovering) throw new Error(`UNEXPECTED_REPLAY:${targetId}`)
      if (targetId === 'second') {
        process.stdout.write('cut-ready\n')
        await new Promise(() => undefined)
      }
      ledger.check({ projectId: command.projectId, commandId: command.commandId, leaseId: grant.leaseId })
      const target = (file.tldrawSnapshot as { store: Record<string, ReturnType<typeof shape>> }).store[targetId]
      target.meta.nodeRun = {
        runId: grant.runId, status: 'success', startedAt: 0, finishedAt: 1,
        commandId: command.commandId, commandLeaseId: grant.leaseId,
        nodeExecutionId: `execution-${targetId}`,
        fixedInputs: command.inputs,
        inputs: Object.fromEntries(grant.inputs.map((input) => [
          input.targetPortId,
          input.versions.map((version, index) => ({
            nodeId: input.sources![index].nodeId,
            portId: input.sources![index].portId,
            assetId: version.ref.assetId,
            versionId: version.ref.versionId
          }))
        ])),
        inputFingerprint: computeInputFingerprint({
          contractVersion: 1,
          config: target.props.config,
          text: target.props.text,
          sources: grant.inputs.flatMap((input) => input.versions.map((version, index) => ({
            portId: input.targetPortId,
            nodeId: input.sources![index].nodeId,
            sourcePortId: input.sources![index].portId,
            value: version.value
          })))
        }),
        outputPorts: ['out-value']
      }
      target.meta.nodeResult = JSON.stringify({ kind: 'text', text: `output-${targetId}` })
      counts[targetId]++
      file.meta.graphVersion++
      save()
      ledger.commit({ projectId: command.projectId, commandId: command.commandId })
    }
  }, async () => ({ decide: async () => { throw new Error('model not expected') } }))
  host.setCoordinator(new FlowCoordinatorHost(
    db,
    project,
    () => true,
    host,
    async () => ({ decide: async () => { throw new Error('model not expected') } }),
    async () => undefined
  ))
  return { db, file, ledger, host, counts }
}

async function runWorker(directory: string, mode: string): Promise<Record<string, unknown> | undefined> {
  const f = runtime(directory, mode === 'recover')
  try {
    if (mode === 'cut') {
      await f.host.run({
        projectId: 'isolated', nodeId: 'main', requestId: 'hard-kill-flow',
        traceId: 'trace', spanId: 'span', action: 'start'
      })
      return undefined
    }
    f.ledger.recoverAbandoned()
    const run = new CoordinationStore(f.db).latest('isolated', 'main')!
    const recovered = await f.host.run({
      projectId: 'isolated', nodeId: 'main', requestId: 'recover-hard-kill',
      traceId: 'trace-recovery', spanId: 'span-recovery', action: 'reconcile',
      eventId: 'recover-hard-kill', expectedTaskId: run.taskId,
      expectedWaitRevision: run.waitRevision
    })
    const commands = f.db.prepare('SELECT task_id,state FROM flow_commands ORDER BY rowid').all()
    return { state: recovered.task.state, commands, executions: f.counts }
  } finally {
    f.db.close()
  }
}

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  const directory = isolated()
  worker = join(directory, 'capability-worker.cjs')
  await build({
    entryPoints: [resolve('test/agent-flow-capability-crash-recovery.test.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    tsconfig: resolve('tsconfig.node.json'),
    format: 'cjs',
    external: ['better-sqlite3', 'electron', 'onnxruntime-node', 'vitest'],
    alias: {
      '@shared': resolve('src/shared'),
      '@free-creation/model-runtime': resolve('packages/model-runtime/src/index.ts')
    },
    plugins: [{
      name: 'worker-vitest-stub',
      setup(build) {
        build.onResolve({ filter: /^vitest$/ }, () => ({ path: 'vitest-stub', namespace: 'worker-stub' }))
        build.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
          contents: 'export const describe=()=>{}; export const it=()=>{}; export const expect=()=>{}; export const beforeAll=()=>{}; export const afterAll=()=>{};',
          loader: 'js'
        }))
      }
    }],
    logLevel: 'silent'
  })
})

afterAll(() => {
  for (const directory of directories) {
    if (resolve(directory, '..') !== resolve(tmpdir()) || !basename(directory).startsWith('canvas-capability-crash-'))
      throw new Error('CAPABILITY_CRASH_CLEANUP_REJECTED')
    rmSync(directory, { recursive: true, force: true })
  }
})

async function subprocess(directory: string, mode: string, terminate: boolean): Promise<string> {
  const child = spawn(process.execPath, [worker, 'worker', directory, mode], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = '', stderr = '', killed = false
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  try {
    return await new Promise<string>((done, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (terminate && !killed && output.includes('cut-ready\n')) {
          killed = true
          child.kill('SIGKILL')
        }
      })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (code) => {
        if (terminate ? killed : code === 0) done(output)
        else reject(new Error(`CAPABILITY_CRASH_WORKER_FAILED:${mode}:${code}:${stderr.slice(0, 1000)}`))
      })
    })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

describe('capability hard-kill recovery', () => {
  it('recovers the committed capability and never replays the unknown second effect', async () => {
    const directory = isolated()
    await subprocess(directory, 'cut', true)
    const result = JSON.parse(await subprocess(directory, 'recover', false)) as {
      state: string
      commands: Array<{ task_id: string; state: string }>
      executions: Record<string, number>
    }
    expect(result.state).toBe('waiting')
    expect(result.commands[0].state).toBe('committed')
    expect(result.commands[1].state).toBe('unknown')
    // A recovery deliver would throw UNEXPECTED_REPLAY; zero calls proves the
    // interrupted second effect was not automatically submitted again.
    expect(result.executions).toEqual({ target: 0, second: 0 })
  }, 45000)
})

if (process.argv[2] === 'worker') {
  void runWorker(process.argv[3], process.argv[4]).then((result) => {
    if (result) process.stdout.write(JSON.stringify(result))
  })
}
