import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { FlowCoordinatorHost } from '../src/main/agent-flow/coordinator-host'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowGraphSchema, type FlowGraph, type FlowNode } from '../src/shared/agent-flow/flow-graph'
import { assembleContextManifest, buildContextManifest } from '../src/shared/agent-flow/context-manifest'
import { CoordinationStore } from '../src/main/agent-flow/coordination-store'
import type { ProjectFile, CanvasNode, PortDecl } from '../src/shared/types'
import type { CoordinationRun } from '../src/main/agent-flow/coordination-store'
import type { FlowAgentRun } from '../src/shared/agent-flow/desktop-tasks'
import type { StageEntryFacts } from '../src/shared/agent-flow/stage-contracts'
import type { NodeExecuteCommand } from '../src/shared/agent-flow/commands'

const dbs: Database.Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
  dbs.splice(0).forEach((db) => db.close())
})

function fixture(options: { optionalRetained?: boolean; secondTextPort?: boolean; adoption?: boolean; separateSource?: boolean; retainedOverBudget?: boolean; duplicateShortTextMarkdown?: boolean } = {}) {
  const db = new Database(':memory:')
  dbs.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('p', 'isolated')
  const text = options.duplicateShortTextMarkdown ? 'short' : 'x'.repeat(1200)
  const json = { payload: 'y'.repeat(options.retainedOverBudget ? 1300 : 400) }
  const putAsset = (portId: string, value: unknown, ordinal: number, nodeId = 'source') => {
    const body = JSON.stringify(value)
    db.prepare('INSERT INTO flow_asset_versions VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      `version-${nodeId}-${portId}`,
      `asset-${nodeId}-${portId}`,
      'p',
      nodeId,
      portId,
      ordinal,
      1,
      0,
      createHash('sha256').update(body).digest('hex'),
      body
    )
    return {
      assetId: `asset-${nodeId}-${portId}`,
      versionId: `version-${nodeId}-${portId}`,
      sourceNodeId: nodeId,
      sourcePortId: portId
    }
  }
  const retainedNodeId = options.separateSource ? 'aux' : 'source'
  const textRef = putAsset('out-text', { kind: 'text', text }, 1)
  const jsonRef = putAsset('out-json', { kind: 'json', data: json }, 2, retainedNodeId)
  const bigRef = options.duplicateShortTextMarkdown
    ? putAsset('out-big', { kind: 'text', text: 'b'.repeat(1200) }, 3)
    : null
  const markdownRef = options.duplicateShortTextMarkdown
    ? putAsset('out-markdown', { kind: 'markdown', text }, 4)
    : null
  const retainedType = options.secondTextPort ? 'text' : options.duplicateShortTextMarkdown ? 'any' : 'json'
  const manifest = {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'ctx-cap',
    version: '1.0',
    name: 'context fixture',
    inputs: [
      { id: 'text', label: '文本', type: 'text', required: true, cardinality: options.duplicateShortTextMarkdown ? 'many' : 'one', targets: [{ nodeId: 'n1', portId: 'in-text' }] },
      { id: 'voice', label: '保留', type: retainedType, required: true, cardinality: 'one', targets: [{ nodeId: 'n1', portId: 'in-json' }] }
    ],
    outputs: [{ id: 'result', label: '结果', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'n1', portId: 'out-text' } }],
    graph: { nodes: [{ id: 'n1', nodeType: 'text', contractVersion: 3, title: 'n1', dx: 0, dy: 0, w: 340, h: 300 }], edges: [] }
  } as const
  const contentHash = 'c'.repeat(64)
  db.prepare("INSERT INTO composite_capabilities (id,name,description,tags,latest_version,archived,created_at,updated_at) VALUES (?,?,?,'[]',?,0,0,0)")
    .run('ctx-cap', 'context fixture', '', '1.0')
  db.prepare('INSERT INTO composite_versions (capability_id,version,manifest,content_hash,published_at,published_by) VALUES (?,?,?,?,0,\'test\')')
    .run('ctx-cap', '1.0', JSON.stringify(manifest), contentHash)
  const ports: PortDecl[] = [
    { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: true, cardinality: options.duplicateShortTextMarkdown ? 'many' : 'one' },
    { id: 'in-voice', name: '保留', dir: 'in', type: retainedType, required: true, cardinality: 'one' },
    { id: 'out-result', name: '结果', dir: 'out', type: 'text', required: true, cardinality: 'one' }
  ]
  const nodes: CanvasNode[] = [
    { id: 'main', type: 'agent', contractVersion: 1, title: 'main', x: 0, y: 0, w: 340, h: 300, ports: [], params: { config: '' }, content: { kind: 'empty' }, exec: { status: 'idle' }, meta: {} },
    { id: 'source', type: 'agent', contractVersion: 1, title: 'source', x: 0, y: 0, w: 340, h: 300, ports: [], params: { config: '' }, content: { kind: 'empty' }, exec: { status: 'idle' }, meta: {} },
    { id: 'cap', type: 'composite', contractVersion: 1, title: 'cap', x: 0, y: 0, w: 340, h: 300, ports, params: { config: JSON.stringify({ capabilityId: 'ctx-cap', version: '1.0', contentHash }) }, content: { kind: 'empty' }, exec: { status: 'idle' }, meta: {} },
    { id: 'sink', type: 'agent', contractVersion: 1, title: 'sink', x: 0, y: 0, w: 340, h: 300, ports: [{ id: 'in-text', name: '文本', dir: 'in', type: 'text', required: false, cardinality: 'one' }], params: { config: '' }, content: { kind: 'empty' }, exec: { status: 'idle' }, meta: {} }
  ]
  if (options.separateSource) {
    const source = nodes.find((node) => node.id === 'source')!
    nodes.push({ ...source, id: 'aux', title: 'aux' })
  }
  const cap: FlowNode = {
    nodeId: 'cap',
    title: 'cap',
    participation: 'autonomous',
    kind: 'capability',
    capabilityRef: { kind: 'composite', id: 'ctx-cap', version: '1.0' },
    ...(options.adoption ? { decider: 'human' as const } : {}),
    goal: 'cap',
    completion: 'cap',
    inputs: {
      budgetBytes: 1024,
      overflow: 'ask-human',
      selectors: options.duplicateShortTextMarkdown
        ? [{ sourceStageKey: 'source', path: 'text', required: true }]
        : [
            { sourceStageKey: 'source', path: 'text', required: true },
            { sourceStageKey: retainedNodeId, path: 'payload', required: !options.optionalRetained }
          ]
    }
  }
  const graph = FlowGraphSchema.parse({
    schemaVersion: 1,
    graphId: 'effective',
    name: 'effective',
    goal: 'effective',
    nodes: [
      { nodeId: 'source', title: 'source', participation: 'autonomous', kind: 'agent', goal: 'source', completion: 'source' },
      ...(options.separateSource ? [{ nodeId: 'aux', title: 'aux', participation: 'autonomous' as const, kind: 'agent' as const, goal: 'aux', completion: 'aux' }] : []),
      cap,
      { nodeId: 'sink', title: 'sink', participation: 'autonomous', kind: 'agent', goal: 'sink', completion: 'sink' }
    ],
    edges: [
      ...(options.duplicateShortTextMarkdown
        ? [{ from: { nodeId: 'source', portId: 'out-big' }, to: { nodeId: 'cap', portId: 'in-text' }, kind: 'data' as const }]
        : []),
      { from: { nodeId: 'source', portId: 'out-text' }, to: { nodeId: 'cap', portId: 'in-text' }, kind: 'data' },
      { from: { nodeId: retainedNodeId, portId: options.duplicateShortTextMarkdown ? 'out-markdown' : 'out-json' }, to: { nodeId: 'cap', portId: 'in-voice' }, kind: 'data' },
      { from: { nodeId: 'cap', portId: 'out-result' }, to: { nodeId: 'sink', portId: 'in-text' }, kind: 'data', ...(options.adoption ? { condition: [{ kind: 'human-decision' as const, stageKey: 'cap' }] } : {}) }
    ],
    entry: 'source',
    exits: ['sink']
  })
  const file: ProjectFile = {
    version: 1,
    meta: { id: 'p', name: 'isolated', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes,
    edges: graph.edges.map((edge, index) => ({ id: `edge-${index}`, from: edge.from, to: edge.to })),
    groups: [],
    tldrawSnapshot: {
      store: Object.fromEntries(nodes.map((node) => [
        node.id,
        {
          id: node.id,
          type: 'node-card',
          props: {
            nodeType: node.type,
            title: node.title,
            config: node.params.config,
            text: '',
            mediaId: '',
            mediaPath: '',
            mediaMime: '',
            exec: 'idle',
            w: 340,
            h: 300
          },
          meta: {}
        }
      ]))
    }
  }
  const config = {
    schemaVersion: 1,
    role: 'coordinator',
    interactionMode: 'autonomous',
    skills: [],
    tools: [{ id: 'agent.dispatch', version: '1' }],
    allowedNodeIds: ['source', ...(options.separateSource ? ['aux'] : []), 'cap', 'sink'],
    maxSteps: 8,
    executionMode: 'graph',
    graph,
    relations: []
  } as const
  const run: CoordinationRun = {
    projectId: 'p',
    nodeId: 'main',
    taskId: 'run',
    goal: 'run',
    config,
    stateNodeId: 'state',
    stateConfig: {
      schemaVersion: 1,
      initialState: 'draft',
      states: ['draft', 'working', 'waiting', 'completed'],
      transitions: [
        { from: 'working', event: 'agent.dispatched', to: 'working' },
        { from: 'working', event: 'agent.completed', to: 'working' },
        { from: 'working', event: 'human.wait', to: 'waiting' },
        { from: 'waiting', event: 'agent.completed', to: 'working' },
        { from: 'working', event: 'flow.completed', to: 'completed' }
      ],
      relations: []
    },
    scopeIds: [],
    scopeRevision: 'a'.repeat(64),
    childIds: ['source', ...(options.separateSource ? ['aux'] : []), 'cap', 'sink'],
    state: 'running',
    phase: 'working',
    revision: 0,
    waitRevision: 1,
    decisions: 0,
    paused: false,
    code: 'FLOW_CONTEXT_OVER_BUDGET',
    contextWaitStageKey: 'cap',
    contextWaitLimitBytes: 1024,
    traceId: 'trace',
    spanId: 'span',
    children: [
      { nodeId: 'source', taskId: 'source-task', goal: 'source', completion: 'source', inputs: [], state: 'completed', outputs: options.duplicateShortTextMarkdown ? [bigRef!, textRef, markdownRef!] : options.separateSource ? [textRef] : [textRef, jsonRef] },
      ...(options.separateSource ? [{ nodeId: 'aux', taskId: 'aux-task', goal: 'aux', completion: 'aux', inputs: [], state: 'completed', outputs: [jsonRef] }] : [])
    ],
    outputs: []
  }
  db.prepare('INSERT INTO flow_coordination_runs VALUES (?,?,?,?)').run('p', 'main', 'run', JSON.stringify(run))
  const commands: NodeExecuteCommand[] = []
  const specialists = {
    humanDecision: () => false,
    deliveryHandoff: () => undefined,
    executeNodeCommand: vi.fn(async (command: NodeExecuteCommand) => {
      commands.push(command)
      return {
        commandId: command.commandId,
        projectId: command.projectId,
        taskId: command.taskId,
        targetNodeId: command.targetNodeId,
        state: 'committed',
        runId: 'command-run',
        inputs: command.inputs,
        outputRefs: [textRef]
      }
    })
  }
  const host = new FlowCoordinatorHost(
    db,
    () => file,
    () => true,
    specialists as never,
    async () => { throw new Error('no model') },
    async () => undefined
  )
  const hostInternals = host as unknown as { check: () => ProjectFile }
  vi.spyOn(hostInternals, 'check').mockReturnValue(file)
  const input = {
    projectId: 'p', nodeId: 'main', requestId: 'resume', traceId: 'trace', spanId: 'span',
    action: 'continue', eventId: 'resume', expectedTaskId: 'run', expectedWaitRevision: 1,
    humanConfirmed: 'gui', contextMaterial: 'short'
  } satisfies FlowAgentRun
  const dispatch = () => (host as unknown as {
    dispatchCapability: (
      run: CoordinationRun,
      input: FlowAgentRun,
      next: FlowNode,
      graph: FlowGraph,
      facts: StageEntryFacts,
      edgeState: () => 'satisfied',
      loopIterations: Record<string, number>,
      signal: AbortSignal
    ) => Promise<boolean>
  }).dispatchCapability(
    run,
    input,
    cap,
    graph,
    {
      deliveries: [
        { stageKey: 'source', nodeId: 'source', outputs: options.duplicateShortTextMarkdown ? [{ kind: 'text', text: 'b'.repeat(1200) }, { kind: 'text', text }, { kind: 'markdown', text }] : options.separateSource ? [{ kind: 'text', text }] : [{ kind: 'text', text }, { kind: 'json', data: json }], humanDecided: false },
        ...(options.separateSource ? [{ stageKey: 'aux', nodeId: 'aux', outputs: [{ kind: 'json', data: json }], humanDecided: false }] : [])
      ],
      reviews: []
    },
    () => 'satisfied',
    {},
    new AbortController().signal
  )
  return { db, host, run, cap, graph, input, commands, dispatch, textRef }
}

describe('BL-40 effective context inputs', () => {
  it('replaces only the material contribution when one source feeds two ports', async () => {
    const f = fixture()
    await f.dispatch()
    expect(f.commands).toHaveLength(1)
    const command = f.commands[0]
    expect(command.inputs).toHaveLength(1)
    expect(command.inputs[0]).toMatchObject({ targetPortId: 'in-voice' })
    expect(command.contextMaterial).toEqual({ targetPortId: 'in-text', text: 'short' })
    const child = f.run.children.find((item) => item.nodeId === 'cap')!
    expect(child.contextManifest?.entries).toMatchObject([
      { sourceStageKey: 'source', path: 'payload', value: 'y'.repeat(400) },
      { sourceStageKey: 'human:context', path: 'text', value: 'short' }
    ])
    expect(child.contextManifest?.budget).toMatchObject({ exceeded: false })
  })

  it('keeps a fixed contribution from a different shape in the same effective set', async () => {
    const f = fixture({ separateSource: true })
    await f.dispatch()
    expect(f.commands).toHaveLength(1)
    expect(f.commands[0].inputs[0].assets[0].sourceNodeId).toBe('aux')
    const child = f.run.children.find((item) => item.nodeId === 'cap')!
    expect(child.contextManifest?.entries).toMatchObject([
      { sourceStageKey: 'aux', path: 'payload' },
      { sourceStageKey: 'human:context', path: 'text', value: 'short' }
    ])
  })

  it('readmits an originally dropped optional contribution when material makes room', async () => {
    const f = fixture({ optionalRetained: true })
    await f.dispatch()
    expect(f.commands).toHaveLength(1)
    const child = f.run.children.find((item) => item.nodeId === 'cap')!
    expect(child.contextManifest?.entries).toMatchObject([
      { sourceStageKey: 'source', path: 'payload', required: false },
      { sourceStageKey: 'human:context', path: 'text', required: true }
    ])
    expect(child.contextManifest?.dropped).toEqual([])
    expect(child.contextManifest?.budget.exceeded).toBe(false)
  })

  it('fails before execution when the retained optional contribution no longer fits', async () => {
    const f = fixture({ optionalRetained: true })
    f.input.contextMaterial = 'z'.repeat(800)
    await expect(f.dispatch()).rejects.toMatchObject({ code: 'FLOW_CONTEXT_OVER_BUDGET' })
    expect(f.commands).toEqual([])
    expect(f.run.children.some((item) => item.nodeId === 'cap')).toBe(false)
  })

  it('rejects when the retained source is itself over budget before material', async () => {
    const f = fixture({ optionalRetained: true, retainedOverBudget: true })
    await expect(f.dispatch()).rejects.toMatchObject({ code: 'FLOW_CONTEXT_OVER_BUDGET' })
    expect(f.commands).toEqual([])
    expect(f.run.children.some((item) => item.nodeId === 'cap')).toBe(false)
  })

  it('keeps command inputs and deduplicated entries aligned for text and markdown', async () => {
    const f = fixture({ duplicateShortTextMarkdown: true })
    await f.dispatch()
    expect(f.commands).toHaveLength(1)
    const command = f.commands[0]
    expect(command.inputs).toHaveLength(1)
    expect(command.inputs[0]).toMatchObject({ targetPortId: 'in-voice' })
    expect(command.inputs[0].assets[0].sourcePortId).toBe('out-markdown')
    expect(command.contextMaterial).toEqual({ targetPortId: 'in-text', text: 'short' })
    const child = f.run.children.find((item) => item.nodeId === 'cap')!
    expect(child.contextManifest?.entries).toHaveLength(2)
    expect(child.contextManifest?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceStageKey: 'source', path: 'text', kind: 'markdown', value: 'short' }),
      expect.objectContaining({ sourceStageKey: 'human:context', kind: 'text', value: 'short' })
    ]))
    expect(child.contextManifest?.dropped).toEqual([])
    expect(child.contextManifest?.budget.exceeded).toBe(false)
  })

  it('collects optional candidates above 1 MiB without a synthetic budget cap', () => {
    const large = 'o'.repeat(1048576 + 10)
    const manifest = buildContextManifest('cap', {
      selectors: [{ sourceStageKey: 'source', path: 'payload', required: false }],
      budgetBytes: 1024
    }, [{
      stageKey: 'source', nodeId: 'source', humanDecided: false,
      outputs: [{ kind: 'json', data: { payload: large } }]
    }], { includeAllCandidates: true })
    expect(manifest.entries).toHaveLength(1)
    expect(manifest.entries[0]).toMatchObject({ required: false, value: large })
    expect(manifest.dropped).toEqual([])
    expect(manifest.budget.limitBytes).toBe(1024)
    expect(manifest.budget.usedBytes).toBeGreaterThan(1048576)
  })

  it('deduplicates identical text and markdown contributions before budgeting', () => {
    const inputs = {
      selectors: [{ sourceStageKey: 'source', path: 'text', required: true }],
      budgetBytes: 1024
    }
    const text = buildContextManifest('cap', inputs, [
      { stageKey: 'source', nodeId: 'source', outputs: [{ kind: 'text', text: 'same' }], humanDecided: false }
    ])
    const markdown = buildContextManifest('cap', inputs, [
      { stageKey: 'source', nodeId: 'source', outputs: [{ kind: 'markdown', text: 'same' }], humanDecided: false }
    ])
    const manifest = assembleContextManifest('cap', 1024, [...text.entries, ...markdown.entries])
    expect(manifest.entries).toHaveLength(1)
    expect(manifest.budget).toMatchObject({ exceeded: false, usedBytes: manifest.entries[0].bytes })
    expect(manifest.dropped).toEqual([])
  })

  it('keeps required contributions from different sources even when their values are identical', () => {
    const manifest = buildContextManifest('cap', {
      selectors: [
        { sourceStageKey: 'source-a', path: 'text', required: true },
        { sourceStageKey: 'source-b', path: 'text', required: true }
      ],
      budgetBytes: 1024
    }, [
      { stageKey: 'source-a', nodeId: 'source-a', outputs: [{ kind: 'text', text: 'same' }], humanDecided: false },
      { stageKey: 'source-b', nodeId: 'source-b', outputs: [{ kind: 'text', text: 'same' }], humanDecided: false }
    ])
    expect(manifest.entries.map((entry) => entry.sourceStageKey)).toEqual(['source-a', 'source-b'])
  })

  it('selects only edges whose own output resolves the declared selector path', () => {
    const f = fixture()
    const internals = f.host as unknown as {
      graphFacts: (run: CoordinationRun) => StageEntryFacts
      selectedIncomingEdges: (
        run: CoordinationRun,
        node: import('../src/shared/agent-flow/flow-graph').FlowNode,
        graph: import('../src/shared/agent-flow/flow-graph').FlowGraph,
        facts: StageEntryFacts,
        edgeState: () => 'satisfied'
      ) => import('../src/shared/agent-flow/flow-graph').FlowGraph['edges']
    }
    const facts = internals.graphFacts(f.run)
    const textOnly = {
      ...f.cap,
      inputs: {
        budgetBytes: 1024,
        selectors: [{ sourceStageKey: 'source', path: 'text', required: true }]
      }
    }
    const payloadOnly = {
      ...f.cap,
      inputs: {
        budgetBytes: 1024,
        selectors: [{ sourceStageKey: 'source', path: 'payload', required: true }]
      }
    }
    expect(internals.selectedIncomingEdges(f.run, textOnly, f.graph, facts, () => 'satisfied')
      .map((edge) => edge.to.portId)).toEqual(['in-text'])
    expect(internals.selectedIncomingEdges(f.run, payloadOnly, f.graph, facts, () => 'satisfied')
      .map((edge) => edge.to.portId)).toEqual(['in-voice'])
  })

  it('rejects ambiguous text targets instead of silently choosing the first port', async () => {
    const f = fixture({ secondTextPort: true })
    await expect(f.dispatch()).rejects.toMatchObject({ code: 'FLOW_CONTEXT_MATERIAL_AMBIGUOUS' })
    expect(f.commands).toEqual([])
  })

  it('persists capability adoption and releases a human-decision downstream edge', async () => {
    const f = fixture({ adoption: true })
    await f.dispatch()
    const capability = f.run.children.find((child) => child.nodeId === 'cap')!
    expect(capability).toMatchObject({ state: 'waiting', adoptionPending: true })
    const internals = f.host as unknown as {
      graphStep: (run: CoordinationRun, input: FlowAgentRun, signal: AbortSignal) => Promise<boolean>
      dispatchRoutedAgent: (
        run: CoordinationRun,
        input: FlowAgentRun,
        next: FlowNode
      ) => Promise<boolean>
    }
    vi.spyOn(internals, 'dispatchRoutedAgent').mockImplementation(async (run, _input, next) => {
      run.children.push({
        nodeId: next.nodeId,
        taskId: 'sink-task',
        goal: next.goal,
        completion: next.completion,
        inputs: [],
        state: 'completed',
        outputs: [f.textRef]
      })
      return true
    })
    const step = () => internals.graphStep(f.run, f.input, new AbortController().signal)
    await step()
    await step()
    expect(capability.humanDecided).toBe(true)
    expect(capability.adoptionPending).toBeUndefined()
    expect(f.run.state).toBe('completed')
    expect(f.run.stageDeliveries?.find((record) => record.nodeId === 'cap')).toMatchObject({
      humanDecided: true,
      stale: false
    })
    const facts = (f.host as unknown as {
      graphFacts: (run: CoordinationRun) => StageEntryFacts
    }).graphFacts(f.run)
    expect(facts.deliveries.find((delivery) => delivery.stageKey === 'cap')?.humanDecided).toBe(true)
    const persisted = new CoordinationStore(f.db).latest('p', 'main')!
    expect(persisted.children.find((child) => child.nodeId === 'cap')?.humanDecided).toBe(true)
    expect(persisted.stageDeliveries?.find((record) => record.nodeId === 'cap')?.humanDecided).toBe(true)
  })
})
