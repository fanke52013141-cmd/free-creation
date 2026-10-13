import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { ProjectFile, CanvasNode } from '../src/shared/types'
import { FlowCommandLedger } from '../src/main/agent-flow/command-ledger'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import { projectSemanticRevision } from '../src/main/agent-flow/command-intent'
import { PROCESSOR_PORTS } from '../src/shared/agent-flow/processor-contract'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { computeInputFingerprint } from '../src/shared/engine/input-fingerprint'
import type { NodeExecuteCommand, FlowCommandGrant } from '../src/shared/agent-flow/commands'
import { createAgentRuntime } from '../src/main/agent-flow/runtime'
import { createLedgerToolPort } from '../src/main/agent-flow/ledger-tool'
import { FlowTaskStore } from '../src/main/agent-flow/task-store'
import { FlowSkillStore } from '../src/main/agent-flow/skill-store'
import { FlowAgentDesktopHost } from '../src/main/agent-flow/desktop-host'
import {
  AgentTaskSnapshotSchema,
  AgentRuntimeError
} from '../src/shared/agent-flow/runtime-contracts'

const dbs: Database.Database[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})
function fixture() {
  const db = new Database(':memory:')
  dbs.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?, ?, 0, 0)').run(
    'project-a',
    'fixture'
  )
  const agentConfig = {
    schemaVersion: 1,
    role: 'specialist',
    interactionMode: 'autonomous',
    skills: [],
    tools: [],
    allowedNodeIds: ['shape:target'],
    maxSteps: 3,
    relations: []
  }
  const shape = (id: string, type: string, text: string, config = '') => ({
    id,
    type: 'node-card',
    props: {
      nodeType: type,
      title: type,
      config,
      text,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      w: 340,
      h: 260
    },
    meta: {} as Record<string, unknown>
  })
  const source = shape('shape:source', 'text', 'private-v1')
  const agent = shape('shape:agent', 'agent', 'private-goal', JSON.stringify(agentConfig))
  const target = shape('shape:target', 'processor', '', '{"operation":"pass"}')
  const asNode = (record: typeof source): CanvasNode => ({
    id: record.id,
    type: record.props.nodeType as CanvasNode['type'],
    contractVersion: 1,
    title: record.props.title,
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: record === target ? [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out] : [],
    params: { config: record.props.config },
    content: record.props.text ? { kind: 'text', text: record.props.text } : { kind: 'empty' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 0 }
  })
  const file: ProjectFile = {
    version: 1,
    meta: { id: 'project-a', name: 'fixture', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes: [source, agent, target].map(asNode),
    groups: [],
    edges: [
      {
        id: 'edge-a',
        from: { nodeId: source.id, portId: 'out-text' },
        to: { nodeId: target.id, portId: 'in-value' }
      }
    ],
    tldrawSnapshot: {
      store: Object.fromEntries([source, agent, target].map((record) => [record.id, record]))
    }
  }
  const project = (id: string): ProjectFile | null => (id === file.meta.id ? file : null)
  const assets = new FlowAssetStore(db, project)
  const version = assets.submit({
    projectId: 'project-a',
    nodeId: source.id,
    portId: 'out-text',
    submissionId: 'asset-a',
    expectedGraphVersion: 1,
    traceId: 'trace-a',
    spanId: 'span-a'
  })
  const ledger = new FlowCommandLedger(db, project)
  const command = (): NodeExecuteCommand => ({
    schemaVersion: 1,
    kind: 'node.execute',
    projectId: 'project-a',
    commandId: 'command-a',
    taskId: 'task-a',
    agentNodeId: agent.id,
    targetNodeId: target.id,
    contractVersion: 1,
    expectedSemanticRevision: projectSemanticRevision(file),
    inputs: [{ targetPortId: 'in-value', assets: [version.ref] }],
    traceId: 'trace-a',
    spanId: 'span-a'
  })
  const prepare = (input = command()): FlowCommandGrant => {
    const result = ledger.prepare(input)
    if (result.state !== 'ready') throw new Error('expected grant')
    return result.grant
  }
  const savedRun = (grant: FlowCommandGrant, status = 'success'): void => {
    ledger.check({
      projectId: 'project-a',
      commandId: grant.command.commandId,
      leaseId: grant.leaseId
    })
    target.meta.nodeRun = {
      runId: grant.runId,
      status,
      startedAt: 0,
      finishedAt: 1,
      commandId: grant.command.commandId,
      commandLeaseId: grant.leaseId,
      nodeExecutionId: 'execution-a',
      fixedInputs: grant.command.inputs,
      inputs: {
        'in-value': [
          {
            nodeId: source.id,
            portId: 'out-text',
            assetId: version.ref.assetId,
            versionId: version.ref.versionId
          }
        ]
      },
      inputFingerprint: computeInputFingerprint({
        contractVersion: 1,
        config: target.props.config,
        text: target.props.text,
        sources: [
          { portId: 'in-value', nodeId: source.id, sourcePortId: 'out-text', value: version.value }
        ]
      }),
      outputPorts: status === 'success' ? ['out-value'] : []
    }
    target.meta.nodeResult = JSON.stringify({ kind: 'text', text: 'private-result' })
    file.meta.graphVersion++
  }
  return {
    db,
    file,
    source,
    agent,
    target,
    agentConfig,
    project,
    assets,
    ledger,
    version,
    command,
    prepare,
    savedRun
  }
}
const lookup = { projectId: 'project-a', commandId: 'command-a' }

describe('production durable command ledger', () => {
  it('persists bounded discussion without execution, rejects stale events, and prepares an immutable task revision without running it', async () => {
    const f = fixture()
    f.agent.props.config = JSON.stringify({
      ...f.agentConfig,
      interactionMode: 'collaborative',
      tools: [{ id: 'node.execute', version: '1' }],
      modelDefinitionId: 'fixture'
    })
    f.file.nodes[1].params.config = f.agent.props.config
    let decisions = 0,
      discussions = 0
    const createHost = (): FlowAgentDesktopHost =>
      new FlowAgentDesktopHost(
        f.db,
        f.project,
        {
          ledger: f.ledger,
          isActive: () => true,
          deliver: async () => {
            throw new Error('unexpected execution')
          }
        },
        async () => ({
          decide: async () => {
            decisions++
            return { kind: 'wait' }
          },
          discuss: async () => {
            discussions++
            return 'private-discussion-reply'
          }
        })
      )
    const host = createHost()
    await host.run({
      projectId: 'project-a',
      nodeId: f.agent.id,
      requestId: 'initial',
      traceId: 'trace',
      spanId: 'span',
      action: 'start'
    })
    const original = host.collaboration({ projectId: 'project-a', nodeId: f.agent.id })!
    const input = {
      projectId: 'project-a',
      nodeId: f.agent.id,
      taskId: original.task.taskId,
      waitRevision: original.task.waitRevision,
      revision: 0,
      eventId: 'note',
      action: 'note',
      text: 'private-feedback'
    }
    expect((await host.cooperate(input)).messages).toHaveLength(1)
    expect(decisions).toBe(1)
    await host.cooperate(input)
    expect(
      (
        await host.cooperate({ ...input, revision: 1, eventId: 'discuss', action: 'discuss' })
      ).messages.at(-1)?.reply
    ).toBe('private-discussion-reply')
    await host.cooperate({ ...input, revision: 1, eventId: 'discuss', action: 'discuss' })
    expect(discussions).toBe(1)
    await expect(host.cooperate({ ...input, eventId: 'stale' })).rejects.toThrow(
      'COLLABORATION_REVISION_CONFLICT'
    )
    await expect(host.cooperate({ ...input, text: 'changed' })).rejects.toThrow(
      'COLLABORATION_INTENT_CONFLICT'
    )
    await expect(
      host.cooperate({ ...input, eventId: 'foreign', revision: 2, taskId: 'other' })
    ).rejects.toThrow('RESUME_CONFLICT')
    f.agent.props.text = 'private-new-goal'
    f.file.nodes[1].content = { kind: 'text', text: f.agent.props.text }
    f.source.props.text = 'private-new-material'
    f.file.nodes[0].content = { kind: 'text', text: f.source.props.text }
    const revised = await host.cooperate({
      ...input,
      eventId: 'new-task',
      revision: 2,
      action: 'revise',
      text: f.agent.props.text,
      selectedInputs: [f.version.ref]
    })
    expect(revised.task).toMatchObject({ state: 'ready', prepared: true, taskId: 'new-task' })
    expect(decisions).toBe(1)
    const rows = f.db
      .prepare('SELECT snapshot_json,state FROM flow_agent_tasks ORDER BY rowid')
      .all() as Array<{ snapshot_json: string; state: string }>
    expect(JSON.parse(rows[0].snapshot_json).goal).toBe('private-goal')
    expect(rows[0].state).toBe('cancelled')
    expect(JSON.parse(rows[1].snapshot_json)).toMatchObject({
      goal: 'private-new-goal',
      parentTaskId: 'initial'
    })
    expect(JSON.parse(rows[1].snapshot_json).targets[0].inputs[0].assets).toEqual([f.version.ref])
    expect(f.assets.read('project-a', f.version.ref.versionId).value).toEqual({
      kind: 'text',
      text: 'private-v1'
    })
    expect(createHost().inspect({ projectId: 'project-a', nodeId: f.agent.id })).toMatchObject({
      state: 'ready',
      prepared: true
    })
    await expect(
      host.run({
        projectId: 'project-a',
        nodeId: f.agent.id,
        requestId: 'late',
        eventId: 'late-response',
        traceId: 'trace',
        spanId: 'span',
        action: 'continue',
        expectedTaskId: 'initial',
        expectedWaitRevision: 1
      })
    ).rejects.toThrow('RESUME_CONFLICT')
    await host.run({
      projectId: 'project-a',
      nodeId: f.agent.id,
      requestId: 'launch-child',
      traceId: 'trace',
      spanId: 'span',
      action: 'start',
      expectedTaskId: 'new-task'
    })
    expect(decisions).toBe(2)
  })
  it('rejects scope expansion, foreign material and rolls back revision admission together with the old task state', async () => {
    const f = fixture()
    f.agent.props.config = JSON.stringify({
      ...f.agentConfig,
      interactionMode: 'collaborative',
      tools: [{ id: 'node.execute', version: '1' }],
      modelDefinitionId: 'fixture'
    })
    f.file.nodes[1].params.config = f.agent.props.config
    const host = new FlowAgentDesktopHost(
      f.db,
      f.project,
      { ledger: f.ledger, isActive: () => true, deliver: async () => {} },
      async () => ({ decide: async () => ({ kind: 'wait' }) })
    )
    await host.run({
      projectId: 'project-a',
      nodeId: f.agent.id,
      requestId: 'initial',
      traceId: 'trace',
      spanId: 'span',
      action: 'start'
    })
    const input = {
      projectId: 'project-a',
      nodeId: f.agent.id,
      taskId: 'initial',
      waitRevision: 1,
      revision: 0,
      eventId: 'revision',
      action: 'revise',
      text: 'new-goal'
    }
    f.agent.props.text = input.text
    f.file.nodes[1].content = { kind: 'text', text: input.text }
    f.target.props.config = '{"operation":"template"}'
    await expect(host.cooperate(input)).rejects.toThrow('COLLABORATION_SCOPE_CONFLICT')
    f.target.props.config = '{"operation":"pass"}'
    await expect(
      host.cooperate({
        ...input,
        selectedInputs: [{ ...f.version.ref, versionId: 'foreign-version' }]
      })
    ).rejects.toThrow('ASSET_VERSION_MISSING')
    f.db.exec(
      "CREATE TRIGGER fail_revision BEFORE INSERT ON flow_agent_collaboration BEGIN SELECT RAISE(ABORT,'private-storage'); END"
    )
    await expect(host.cooperate(input)).rejects.toThrow()
    expect(host.inspect({ projectId: 'project-a', nodeId: f.agent.id })?.state).toBe('waiting')
    expect(f.db.prepare('SELECT COUNT(*) n FROM flow_agent_tasks').get()).toEqual({ n: 1 })
  })
  it('trusted desktop admission derives scope, resumes observed steps and publishes only verified assets', async () => {
    const f = fixture()
    f.agent.props.config = JSON.stringify({
      ...f.agentConfig,
      maxSteps: 12,
      interactionMode: 'collaborative',
      modelDefinitionId: 'fixture-model',
      tools: [{ id: 'node.execute', version: '1' }],
      skills: [{ id: 'result-check', version: '1' }]
    })
    f.file.nodes.find((node) => node.id === f.agent.id)!.params.config = f.agent.props.config
    let executions = 0
    const host = new FlowAgentDesktopHost(
      f.db,
      f.project,
      {
        ledger: f.ledger,
        isActive: () => true,
        deliver: async (grant) => {
          executions++
          f.savedRun(grant)
          const version = grant.inputs[0].versions[0]
          f.target.meta.nodeRun = {
            ...(f.target.meta.nodeRun as object),
            fixedInputs: grant.command.inputs,
            inputs: {
              'in-value': [
                {
                  nodeId: f.source.id,
                  portId: 'out-text',
                  assetId: version.ref.assetId,
                  versionId: version.ref.versionId
                }
              ]
            }
          }
        }
      },
      async () => ({
        decide: async (state) =>
          !Object.keys(state.loaded).length
            ? { kind: 'load-skill', skillId: 'result-check' }
            : state.receipts.length < 2
              ? { kind: 'execute', targetNodeId: f.target.id }
              : !state.humanAccepted
                ? { kind: 'wait' }
                : { kind: 'finish', outputs: state.receipts.at(-1)!.outputRefs }
      })
    )
    const input = {
      projectId: f.file.meta.id,
      nodeId: f.agent.id,
      requestId: 'desktop-task',
      action: 'start',
      traceId: 'desktop-trace',
      spanId: 'desktop-span'
    }
    f.source.meta.flowAssetRef = JSON.stringify(f.version.ref)
    f.source.meta.pinnedOutput = JSON.stringify({
      version: 1,
      outputs: { 'out-text': { kind: 'text', text: 'tampered' } }
    })
    await expect(host.run({ ...input, requestId: 'bad-fixed-input' })).rejects.toThrow(
      'AGENT_INPUT_NOT_FIXED'
    )
    expect(executions).toBe(0)
    delete f.source.meta.flowAssetRef
    delete f.source.meta.pinnedOutput
    const waiting = await host.run(input)
    expect(waiting.task.state).toBe('waiting')
    expect(executions).toBe(2)
    const result = await host.run({
      ...input,
      requestId: 'continue-run',
      action: 'continue',
      expectedTaskId: waiting.task.taskId,
      expectedWaitRevision: waiting.task.waitRevision,
      eventId: 'continue-event'
    })
    expect(result.task.state).toBe('completed')
    expect(result.outputs['out-text']).toEqual({ kind: 'text', text: 'private-result' })
    expect(executions).toBe(2)
    expect((await host.run(input)).task.state).toBe('completed')
    await expect(host.run({ ...input, allowedNodeIds: ['unauthorized'] })).rejects.toThrow()
    f.agent.meta.nodeRun = { runId: 'agent-run', startedAt: 0, inputs: {}, status: 'success' }
    f.agent.meta.nodeResult = JSON.stringify({
      schemaVersion: 1,
      taskId: result.task.taskId,
      outputs: result.outputs
    })
    const submit = (submissionId: string) =>
      f.assets.submit({
        projectId: f.file.meta.id,
        nodeId: f.agent.id,
        portId: 'out-text',
        submissionId,
        expectedGraphVersion: f.file.meta.graphVersion,
        traceId: 'trace',
        spanId: 'span'
      })
    expect(submit('agent-result').value).toEqual(result.outputs['out-text'])
    f.agent.meta.nodeResult = JSON.stringify({
      schemaVersion: 1,
      taskId: result.task.taskId,
      outputs: { 'out-text': { kind: 'text', text: 'forged' } }
    })
    expect(() => submit('forged-agent-result')).toThrow('ASSET_OUTPUT_INVALID')
  })
  it('C3 loop consumes two real C2 saved-run receipts and immutable output versions', async () => {
    const f = fixture()
    const command = f.command()
    const task = AgentTaskSnapshotSchema.parse({
      runtimeVersion: 1,
      projectId: command.projectId,
      agentNodeId: command.agentNodeId,
      taskId: command.taskId,
      semanticRevision: command.expectedSemanticRevision,
      config: { ...f.agentConfig, tools: [{ id: 'node.execute', version: '1' }] },
      goal: 'Process fixed fixture through the declared processor',
      targets: [{ nodeId: command.targetNodeId, contractVersion: 1, inputs: command.inputs }],
      traceId: command.traceId,
      spanId: command.spanId
    })
    let executions = 0
    const tools = createLedgerToolPort(f.ledger, async (grant) => {
      executions++
      f.savedRun(grant)
    })
    const runtime = createAgentRuntime({
      snapshot: task,
      store: new FlowTaskStore(f.db),
      skills: new FlowSkillStore(f.db),
      tools,
      model: {
        decide: async (state) =>
          state.receipts.length < 2
            ? { kind: 'execute', targetNodeId: command.targetNodeId }
            : { kind: 'finish', outputs: state.receipts.at(-1)!.outputRefs }
      },
      assertRevision: (snapshot) => {
        if (snapshot.semanticRevision !== projectSemanticRevision(f.file))
          throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'revision')
      },
      telemetry: () => {}
    })
    const result = await runtime.start()
    expect(result.state).toBe('completed')
    expect(executions).toBe(2)
    expect(result.outputRefs).toHaveLength(1)
    expect(f.assets.read(task.projectId, result.outputRefs[0].versionId).value).toEqual({
      kind: 'text',
      text: 'private-result'
    })
    await runtime.start()
    expect(executions).toBe(2)
    expect(
      f.db.prepare("SELECT COUNT(*) AS n FROM flow_commands WHERE state='committed'").get()
    ).toEqual({ n: 2 })
  })
  it('keeps declared review gates blocked in both command and manual entrances until their runtime is ready', () => {
    const f = fixture()
    const config = JSON.stringify({
      schemaVersion: 1,
      rulesVersion: 'rules-1',
      rejectPolicy: 'stop',
      maxReworks: 0,
      subjectSources: [],
      gatedNodeIds: [f.target.id],
      relations: []
    })
    const review = {
      ...structuredClone(f.agent),
      id: 'shape:review',
      props: { ...f.agent.props, nodeType: 'ai-review', config }
    }
    ;(f.file.tldrawSnapshot as { store: Record<string, unknown> }).store[review.id] = review
    f.file.nodes.push({ ...f.file.nodes[1], id: review.id, type: 'ai-review', params: { config } })
    expect(() => f.prepare()).toThrow('FLOW_REVIEW_NOT_READY')
    expect(() =>
      f.ledger.assertNodeAvailable({ projectId: 'project-a', nodeId: f.target.id })
    ).toThrow('FLOW_REVIEW_NOT_READY')
  })
  it('blocks manual execution and manual asset publication while command occupancy is unresolved', () => {
    const f = fixture(),
      grant = f.prepare()
    f.savedRun(grant)
    expect(() =>
      f.ledger.assertNodeAvailable({ projectId: 'project-a', nodeId: f.target.id })
    ).toThrow('FLOW_NODE_OCCUPIED')
    expect(() =>
      f.assets.submit({
        projectId: 'project-a',
        nodeId: f.target.id,
        portId: 'out-value',
        submissionId: 'manual-output',
        expectedGraphVersion: f.file.meta.graphVersion,
        traceId: 'trace-a',
        spanId: 'span-a'
      })
    ).toThrow('ASSET_SOURCE_OCCUPIED')
    f.ledger.commit(lookup)
    expect(() =>
      f.ledger.assertNodeAvailable({ projectId: 'project-a', nodeId: f.target.id })
    ).not.toThrow()
  })
  it('verifies saved input sources and recomputed fingerprints against immutable versions', () => {
    const f = fixture(),
      grant = f.prepare()
    f.savedRun(grant)
    const record = f.target.meta.nodeRun as { inputs: unknown; inputFingerprint: string }
    const original = structuredClone(record)
    record.inputFingerprint = 'forged-fingerprint'
    expect(() => f.ledger.commit(lookup)).toThrow('FLOW_SAVED_INPUT_MISMATCH')
    record.inputFingerprint = original.inputFingerprint
    record.inputs = {}
    expect(() => f.ledger.commit(lookup)).toThrow('FLOW_SAVED_INPUT_MISMATCH')
    record.inputs = original.inputs
    expect(f.ledger.commit(lookup).state).toBe('committed')
  })
  it('does not reserve a task or a command when pending persistence fails', () => {
    const f = fixture()
    f.db.exec(
      "CREATE TRIGGER fail_pending BEFORE INSERT ON flow_commands BEGIN SELECT RAISE(ABORT, 'fixture-failure'); END"
    )
    expect(() => f.prepare()).toThrow()
    expect(f.db.prepare('SELECT COUNT(*) n FROM flow_commands').get()).toEqual({ n: 0 })
    expect(f.db.prepare('SELECT COUNT(*) n FROM flow_command_tasks').get()).toEqual({ n: 0 })
  })
  it('persists pending before granting, freezes v1, deduplicates pending and commits one output receipt', () => {
    const f = fixture()
    f.source.props.text = 'private-v2'
    const input = f.command(),
      grant = f.prepare(input)
    expect(grant.inputs[0].versions[0].value).toEqual({ kind: 'text', text: 'private-v1' })
    expect(f.ledger.lookup(lookup).state).toBe('pending')
    expect(f.ledger.prepare({ ...input, traceId: 'retry' }).state).toBe('pending')
    f.savedRun(grant)
    const receipt = f.ledger.commit(lookup)
    expect(receipt).toMatchObject({
      state: 'committed',
      runId: grant.runId,
      nodeExecutionId: 'execution-a',
      inputFingerprint: expect.stringMatching(/^v1:/)
    })
    expect(receipt.outputRefs).toHaveLength(1)
    expect(f.assets.read('project-a', receipt.outputRefs[0].versionId).value).toEqual({
      kind: 'text',
      text: 'private-result'
    })
    f.source.props.text = 'later-edit'
    expect(f.ledger.prepare(input)).toEqual({ state: 'committed', receipt })
    expect(f.ledger.commit(lookup)).toEqual(receipt)
    expect(f.assets.list('project-a', f.target.id, 'out-value')).toHaveLength(1)
  })
  it('rejects same id/different intent, bad scope, stale revision, missing manifest and bad contract', () => {
    const f = fixture(),
      input = f.command()
    f.prepare(input)
    expect(() => f.ledger.prepare({ ...input, taskId: 'changed-task' })).toThrow(
      'FLOW_COMMAND_CONFLICT'
    )
    const bad = { ...input, commandId: 'other' }
    expect(() =>
      f.ledger.prepare({ ...bad, expectedSemanticRevision: `sha256:${'0'.repeat(64)}` })
    ).toThrow('FLOW_REVISION_CONFLICT')
    expect(() => f.ledger.prepare({ ...bad, inputs: [] })).toThrow('FLOW_INPUT_MANIFEST_INCOMPLETE')
    expect(() => f.ledger.prepare({ ...bad, contractVersion: 2 })).toThrow('FLOW_CONTRACT_MISMATCH')
    f.agent.props.config = JSON.stringify({ ...f.agentConfig, allowedNodeIds: [] })
    expect(() =>
      f.ledger.prepare({ ...bad, expectedSemanticRevision: projectSemanticRevision(f.file) })
    ).toThrow('FLOW_SCOPE_REJECTED')
  })
  it('holds occupancy for pending and unknown; admits each lease at most once', () => {
    const f = fixture(),
      input = f.command(),
      grant = f.prepare(input)
    expect(() => f.ledger.prepare({ ...input, commandId: 'other' })).toThrow('FLOW_NODE_OCCUPIED')
    f.ledger.check({ ...lookup, leaseId: grant.leaseId })
    expect(() => f.ledger.check({ ...lookup, leaseId: grant.leaseId })).toThrow(
      'FLOW_LEASE_REJECTED'
    )
    f.ledger.unknown({ ...lookup, leaseId: grant.leaseId })
    expect(() => f.ledger.prepare({ ...input, commandId: 'other' })).toThrow('FLOW_NODE_OCCUPIED')
    expect(f.ledger.prepare(input).state).toBe('unknown')
  })
  it('recovers abandoned pending to unknown across ledger sessions and reconciles a saved run without reexecution', () => {
    const f = fixture(),
      grant = f.prepare()
    f.savedRun(grant)
    const reopened = new FlowCommandLedger(f.db, f.project)
    expect(reopened.recoverAbandoned()).toHaveLength(1)
    expect(reopened.recoverAbandoned()).toHaveLength(0)
    expect(() => reopened.check({ ...lookup, leaseId: grant.leaseId })).toThrow(
      'FLOW_LEASE_REJECTED'
    )
    expect(reopened.commit(lookup).state).toBe('committed')
    expect(f.assets.list('project-a', f.target.id, 'out-value')).toHaveLength(1)
  })
  it('does not treat an absent or mismatched saved run as completed; revision changes remain unknown', () => {
    const f = fixture(),
      grant = f.prepare()
    f.ledger.unknown({ ...lookup, leaseId: grant.leaseId })
    expect(() => f.ledger.commit(lookup)).toThrow('FLOW_SAVED_RUN_MISMATCH')
    f.target.meta.nodeRun = { runId: 'unrelated', status: 'success', startedAt: 0, inputs: {} }
    expect(() => f.ledger.commit(lookup)).toThrow('FLOW_LEASE_REJECTED')
    f.target.props.config = '{"operation":"template"}'
    expect(() => f.ledger.commit(lookup)).toThrow('FLOW_REVISION_CONFLICT')
    expect(f.ledger.lookup(lookup).state).toBe('unknown')
  })
  it('rolls back asset and receipt together if the command receipt write fails', () => {
    const f = fixture(),
      grant = f.prepare()
    f.savedRun(grant)
    f.db.exec(
      "CREATE TRIGGER fail_receipt BEFORE UPDATE ON flow_commands WHEN NEW.state = 'committed' BEGIN SELECT RAISE(ABORT, 'private-db-failure'); END"
    )
    expect(() => f.ledger.commit(lookup)).toThrow()
    expect(f.ledger.lookup(lookup).state).toBe('pending')
    expect(f.assets.list('project-a', f.target.id, 'out-value')).toHaveLength(0)
    f.db.exec('DROP TRIGGER fail_receipt')
    expect(f.ledger.commit(lookup).state).toBe('committed')
  })
  it('records failed/cancelled/skipped runs without submitting stale output, releasing occupancy', () => {
    for (const status of ['failed', 'cancelled', 'skipped']) {
      const f = fixture(),
        grant = f.prepare()
      f.savedRun(grant, status)
      expect(f.ledger.commit(lookup).state).toBe(status)
      expect(f.assets.list('project-a', f.target.id, 'out-value')).toHaveLength(0)
      expect(f.ledger.prepare({ ...f.command(), commandId: 'next' }).state).toBe('ready')
    }
  })
  it('aborts only unadmitted leases and enforces a durable per-task budget', () => {
    const f = fixture()
    for (let index = 0; index < 3; index++) {
      const grant = f.prepare({ ...f.command(), commandId: `command-${index}` })
      f.ledger.abortUnstarted({
        projectId: 'project-a',
        commandId: grant.command.commandId,
        leaseId: grant.leaseId
      })
    }
    expect(() => f.prepare({ ...f.command(), commandId: 'command-4' })).toThrow(
      'FLOW_TASK_BUDGET_EXHAUSTED'
    )
  })
  it('rejects forged references, contract ports, leases and review gates before any pending record', () => {
    const f = fixture(),
      input = f.command()
    expect(() =>
      f.prepare({ ...input, inputs: [{ targetPortId: 'wrong', assets: [f.version.ref] }] })
    ).toThrow('FLOW_INPUT_MANIFEST_INCOMPLETE')
    expect(() =>
      f.prepare({
        ...input,
        inputs: [{ targetPortId: 'in-value', assets: [{ ...f.version.ref, assetId: 'forged' }] }]
      })
    ).toThrow('ASSET_REFERENCE_MISMATCH')
    f.file.nodes.find((node) => node.id === f.target.id)!.ports[0] = {
      ...PROCESSOR_PORTS.in[0],
      cardinality: 'many'
    }
    expect(() =>
      f.prepare({ ...input, expectedSemanticRevision: projectSemanticRevision(f.file) })
    ).toThrow('FLOW_CONTRACT_MISMATCH')
    expect(f.db.prepare('SELECT COUNT(*) n FROM flow_commands').get()).toEqual({ n: 0 })
  })
})
