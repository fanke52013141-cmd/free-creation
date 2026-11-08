// F8（一）Flow 观察与固定资产外部接入测试。
//
// 覆盖 flowAgent.inspect / flowAgent.catalog / flowAgent.collaboration（只读观察）与
// flowAsset.submit / flowAsset.list / flowAsset.read（固定资产），逐项验证：
// 正常路径、非法参数、跨项目越权、写操作幂等重放、不存在目标拒绝，以及"外部没有改写
// 内部事实"——运行中任务不会被外部判为会话丢失、账本/画布/协作记录不被外部读出即改、
// 未开放的生命周期动作在 Registry 里确实不存在（不是"登记了但空实现"）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasNode } from '../src/shared/types'
import { closeDb, getDataDir, getDb } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import type { AccessDesktop } from '../src/main/agent-access/desktop'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { FlowTaskStore, agentThread } from '../src/main/agent-flow/task-store'
import { FlowCollaborationStore } from '../src/main/agent-flow/collaboration-store'
import { SqliteModelHost } from '../src/main/model-host/sqlite-model-host'
import { ACCESS_OPERATIONS } from '../src/shared/agent-access/registry'

let directory: string
let service: LocalAccessService
let active: string | null
const events: Array<Record<string, unknown>> = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

function call(operationId: string, input: unknown = {}, idempotencyKey?: string): Promise<{
  status: 'completed' | 'failed' | 'unknown'
  data?: any
  error?: { code: string; phase: string; detail?: string }
}> {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    ...(idempotencyKey ? { idempotencyKey } : {})
  }) as any
}

function agentConfig(allowedNodeIds: string[] = ['shape:text1']): string {
  return JSON.stringify({
    schemaVersion: 1,
    role: 'specialist',
    interactionMode: 'collaborative',
    modelDefinitionId: 'fixture-model',
    skills: [],
    tools: [{ id: 'node.execute', version: '1' }],
    allowedNodeIds,
    maxSteps: 6,
    relations: []
  })
}

type SnapshotShape = {
  id: string
  type: 'node-card'
  x: number
  y: number
  props: Record<string, unknown>
  meta: Record<string, unknown>
}

function shape(
  id: string,
  nodeType: string,
  text: string,
  config: string,
  nodeRun?: Record<string, unknown>
): SnapshotShape {
  return {
    id,
    type: 'node-card',
    x: 0,
    y: 0,
    props: {
      w: 340,
      h: 260,
      nodeType,
      title: `${nodeType}-${id}`,
      text,
      config,
      mediaId: '',
      mediaPath: '',
      mediaMime: ''
    },
    meta: nodeRun ? { nodeRun } : {}
  }
}

function node(
  id: string,
  type: CanvasNode['type'],
  contractVersion: number,
  ports: CanvasNode['ports'],
  text: string,
  config: string
): CanvasNode {
  return {
    id,
    type,
    contractVersion,
    title: `${type}-${id}`,
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports,
    params: { config },
    content: { kind: 'text', text },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  } as CanvasNode
}

/** 最小 Flow 画布：一个 specialist Agent 节点 + 一个文本节点（固定资产来源）。 */
function seedFlowProject(
  name = 'Flow 观察',
  agentId = 'shape:agent1'
): { projectId: string; graphVersion: number } {
  const project = createProject(name)
  const agent = node(agentId, 'agent', 1, [], '整理材料并交付', agentConfig())
  const text = node(
    'shape:text1',
    'text',
    3,
    [
      {
        id: 'out-text',
        name: '文本',
        dir: 'out',
        type: 'text',
        required: true,
        cardinality: 'one',
        description: '输出文本'
      }
    ],
    '交付内容',
    JSON.stringify({ privateConfigKey: 'private-config-value' })
  )
  const saved = saveProject({
    id: project.id,
    graph: { nodes: [agent, text], edges: [], groups: [] },
    tldrawSnapshot: {
      store: {
        [agentId]: shape(agentId, 'agent', '整理材料并交付', agentConfig()),
        'shape:text1': shape(
          'shape:text1',
          'text',
          '交付内容',
          JSON.stringify({ privateConfigKey: 'private-config-value' })
        )
      }
    }
  })!
  return { projectId: project.id, graphVersion: saved.graphVersion }
}

/** 最小固定资产画布：只有一个文本节点，避免与任务占用校验互相干扰。 */
function seedAssetProject(name = '固定资产'): { projectId: string; graphVersion: number } {
  const project = createProject(name)
  const config = JSON.stringify({ privateConfigKey: 'private-config-value' })
  const text = node(
    'shape:text1',
    'text',
    3,
    [
      {
        id: 'out-text',
        name: '文本',
        dir: 'out',
        type: 'text',
        required: true,
        cardinality: 'one',
        description: '输出文本'
      }
    ],
    '交付内容',
    config
  )
  const saved = saveProject({
    id: project.id,
    graph: { nodes: [text], edges: [], groups: [] },
    tldrawSnapshot: { store: { 'shape:text1': shape('shape:text1', 'text', '交付内容', config) } }
  })!
  return { projectId: project.id, graphVersion: saved.graphVersion }
}

/** 用同一 FlowTaskStore（GUI 宿主使用的同一类）写入持久任务记录。 */
function seedTask(
  projectId: string,
  state: 'ready' | 'running' | 'waiting',
  taskId = 'task-1'
): { thread: string; taskId: string } {
  const store = new FlowTaskStore(getDb())
  const snapshot = {
    runtimeVersion: 1 as const,
    projectId,
    agentNodeId: 'shape:agent1',
    taskId,
    semanticRevision: `sha256:${'a'.repeat(64)}`,
    config: JSON.parse(agentConfig()),
    goal: '整理材料并交付',
    directInputs: [],
    targets: [{ nodeId: 'shape:text1', contractVersion: 3 as const, inputs: [] }],
    traceId: 'trace-test',
    spanId: 'span-test'
  }
  store.create(snapshot, [])
  const thread = agentThread(snapshot)
  if (state === 'running') store.setState(thread, 'running')
  if (state === 'waiting') store.wait(thread, 'human')
  return { thread, taskId }
}

function taskRow(taskId: string): { state: string; wait_kind: string | null; code: string | null } {
  return getDb()
    .prepare('SELECT state, wait_kind, code FROM flow_agent_tasks WHERE task_id=?')
    .get(taskId) as { state: string; wait_kind: string | null; code: string | null }
}

function assetVersionCount(projectId: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM flow_asset_versions WHERE project_id=?')
      .get(projectId) as { n: number }
  ).n
}

function collaborationCount(thread: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM flow_agent_collaboration WHERE thread=?')
      .get(thread) as { n: number }
  ).n
}

function withDesktop(desktop?: AccessDesktop): void {
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active,
    desktop
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-flow-agents-access-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event as unknown as Record<string, unknown>)
    }
  })
  withDesktop()
})

afterEach(() => {
  closeDb()
  setGatewayEventSink(null)
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-flow-agents-access-test-')
  )
    throw new Error('FLOW_AGENTS_ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('flowAgent.catalog', () => {
  it('reads the desktop capability catalog without exposing skill instructions or connection secrets', async () => {
    const { projectId, graphVersion } = seedFlowProject()
    active = projectId
    const host = new SqliteModelHost(getDb())
    await host.saveConnection({
      id: 'conn-1',
      name: '隔离验收连接',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:5999/v1'
    })
    host.saveModel({
      id: 'model-1',
      connectionId: 'conn-1',
      name: '验收模型',
      modelId: 'fixture',
      capabilities: [
        {
          operation: 'text.generate',
          asynchronous: false,
          streaming: true,
          acceptedAssetKinds: [],
          producedAssetKinds: [],
          controls: {}
        }
      ]
    })
    const result = await call('flowAgent.catalog', { projectId })
    expect(result.status).toBe('completed')
    const data = result.data
    expect(data).toMatchObject({ projectId, graphVersion })
    expect(data.tools.map((tool: any) => tool.id)).toEqual([
      'node.execute',
      'graph.preview',
      'agent.dispatch',
      'review.execute'
    ])
    expect(data.models).toEqual([
      { id: 'model-1', name: '验收模型', imageInput: false, audioInput: false }
    ])
    expect(data.skills.map((skill: any) => skill.id)).toContain('material-analysis')
    // 目录只给摘要：不含技能指令正文、连接地址或配置正文。
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('instructions')
    expect(serialized).not.toContain('不得编造材料之外的事实')
    expect(serialized).not.toContain('127.0.0.1:5999')
    expect(serialized).not.toContain('private-config-value')
  })

  it('requires the project to be open on the desktop canvas (GUI admission parity)', async () => {
    const { projectId } = seedFlowProject()
    // 未打开：与 GUI 面板同一前置条件，明确拒绝而不是伪造空目录。
    const closed = await call('flowAgent.catalog', { projectId })
    expect(closed.status).toBe('failed')
    expect(closed.error?.code).toBe('FLOW_PROJECT_INACTIVE')
    const missing = await call('flowAgent.catalog', { projectId: 'no-such-project' })
    expect(missing.error?.code).toBe('NOT_FOUND')
    const invalid = await call('flowAgent.catalog', { projectId: 'bad id with space' })
    expect(invalid.error?.code).toBe('INVALID_INPUT')
  })
})

describe('flowAgent.inspect', () => {
  it('returns the persisted task view for a waiting task through the desktop host path', async () => {
    const { projectId } = seedFlowProject()
    const { taskId } = seedTask(projectId, 'waiting')
    active = projectId
    const result = await call('flowAgent.inspect', { projectId, nodeId: 'shape:agent1' })
    expect(result.status).toBe('completed')
    expect(result.data.ownership).toBe('desktop-host')
    expect(result.data.task).toMatchObject({
      taskId,
      state: 'waiting',
      waitKind: 'human',
      waitRevision: 1
    })
    expect(result.data.graphVersion).toBe(openProject(projectId)!.meta.graphVersion)
  })

  it('returns no task without inventing facts', async () => {
    const { projectId } = seedFlowProject()
    active = projectId
    const result = await call('flowAgent.inspect', { projectId, nodeId: 'shape:agent1' })
    expect(result.status).toBe('completed')
    expect(result.data).toMatchObject({ ownership: 'desktop-host', task: null })
  })

  it('never rewrites a running task to session-lost from outside', async () => {
    const { projectId } = seedFlowProject()
    const { taskId } = seedTask(projectId, 'running')
    active = projectId
    const before = taskRow(taskId)
    expect(before).toMatchObject({ state: 'running', code: null })
    const result = await call('flowAgent.inspect', { projectId, nodeId: 'shape:agent1' })
    expect(result.status).toBe('completed')
    // 运行中任务：外部只读账本事实，不判定 AGENT_SESSION_LOST（那需要桌面宿主的运行上下文）。
    expect(result.data.ownership).toBe('ledger-only')
    expect(result.data.task).toMatchObject({ taskId, state: 'running' })
    expect(taskRow(taskId)).toMatchObject({ state: 'running', code: null })
  })

  it('rejects cross-project node ids, invalid input and unopened projects', async () => {
    const first = seedFlowProject('A')
    const second = seedFlowProject('B', 'shape:agentB')
    active = first.projectId
    // 节点属于另一个项目：在 A 的快照里不存在 → 拒绝，不泄漏对方任务。
    const cross = await call('flowAgent.inspect', {
      projectId: first.projectId,
      nodeId: 'shape:agentB'
    })
    expect(cross.status).toBe('failed')
    expect(cross.error?.code).toBe('AGENT_NODE_MISSING')
    // 项目未在桌面打开：与 GUI 同一前置条件。
    const inactive = await call('flowAgent.inspect', {
      projectId: second.projectId,
      nodeId: 'shape:agentB'
    })
    expect(inactive.error?.code).toBe('FLOW_PROJECT_INACTIVE')
    const invalid = await call('flowAgent.inspect', { projectId: first.projectId, nodeId: 'not-a-node' })
    expect(invalid.error?.code).toBe('INVALID_INPUT')
    const ghost = await call('flowAgent.inspect', {
      projectId: first.projectId,
      nodeId: 'shape:ghost'
    })
    expect(ghost.error?.code).toBe('AGENT_NODE_MISSING')
  })
})

describe('flowAgent.collaboration', () => {
  it('reads collaboration messages and never writes to the thread', async () => {
    const { projectId } = seedFlowProject()
    const { thread, taskId } = seedTask(projectId, 'waiting')
    new FlowCollaborationStore(getDb()).append(thread, {
      projectId,
      nodeId: 'shape:agent1',
      taskId,
      waitRevision: 1,
      revision: 0,
      eventId: 'evt-1',
      action: 'note',
      text: '人工备注：先核对来源'
    } as never)
    active = projectId
    const before = collaborationCount(thread)
    const result = await call('flowAgent.collaboration', { projectId, nodeId: 'shape:agent1' })
    expect(result.status).toBe('completed')
    expect(result.data).toMatchObject({
      projectId,
      nodeId: 'shape:agent1',
      goal: '整理材料并交付',
      revision: 1
    })
    expect(result.data.task).toMatchObject({ taskId, state: 'waiting', waitKind: 'human' })
    expect(result.data.messages).toEqual([
      { eventId: 'evt-1', kind: 'note', text: '人工备注：先核对来源' }
    ])
    expect(result.data.inputs).toEqual([])
    expect(result.data.candidates).toEqual([])
    // 外部只读：协作记录条数与任务状态都不变。
    expect(collaborationCount(thread)).toBe(before)
    expect(taskRow(taskId).state).toBe('waiting')
  })

  it('rejects nodes without a persisted task and non-agent nodes', async () => {
    const { projectId } = seedFlowProject()
    active = projectId
    const noTask = await call('flowAgent.collaboration', { projectId, nodeId: 'shape:agent1' })
    expect(noTask.error?.code).toBe('AGENT_TASK_MISSING')
    const notAgent = await call('flowAgent.collaboration', { projectId, nodeId: 'shape:text1' })
    expect(notAgent.error?.code).toBe('AGENT_NODE_MISSING')
  })
})

describe('flowAsset submit/list/read', () => {
  it('fixes the saved output into an immutable version with idempotent replay', async () => {
    const { projectId, graphVersion } = seedAssetProject()
    const original = openProject(projectId)!
    const idempotency = key()
    const first = await call(
      'flowAsset.submit',
      { projectId, nodeId: 'shape:text1', portId: 'out-text', expectedGraphVersion: graphVersion },
      idempotency
    )
    expect(first.status).toBe('completed')
    expect(first.data).toMatchObject({ projectId, ordinal: 1, graphVersion, valueKind: 'text' })
    expect(first.data.ref).toMatchObject({
      sourceNodeId: 'shape:text1',
      sourcePortId: 'out-text'
    })
    expect(assetVersionCount(projectId)).toBe(1)
    // 同幂等键重放返回原回执，不产生第二个版本。
    const replay = await call(
      'flowAsset.submit',
      { projectId, nodeId: 'shape:text1', portId: 'out-text', expectedGraphVersion: graphVersion },
      idempotency
    )
    expect(replay.status).toBe('completed')
    expect(replay.data.ref).toEqual(first.data.ref)
    expect(assetVersionCount(projectId)).toBe(1)
    // 同键不同意图明确冲突。
    const conflict = await call(
      'flowAsset.submit',
      { projectId, nodeId: 'shape:text1', portId: 'out-json', expectedGraphVersion: graphVersion },
      idempotency
    )
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT')
    // 固定资产是追加版本，不改画布。
    const after = openProject(projectId)!
    expect(after.meta.graphVersion).toBe(original.meta.graphVersion)
    expect(JSON.stringify(after.nodes)).toBe(JSON.stringify(original.nodes))

    const list = await call('flowAsset.list', {
      projectId,
      nodeId: 'shape:text1',
      portId: 'out-text'
    })
    expect(list.status).toBe('completed')
    expect(list.data.total).toBe(1)
    expect(list.data.items[0].ref).toEqual(first.data.ref)
    // 列表只有摘要，不含取值正文。
    expect(JSON.stringify(list)).not.toContain('交付内容')

    const read = await call('flowAsset.read', { projectId, versionId: first.data.ref.versionId })
    expect(read.status).toBe('completed')
    expect(read.data).toMatchObject({
      ref: first.data.ref,
      ordinal: 1,
      valueKind: 'text',
      value: { kind: 'text', text: '交付内容' }
    })
  })

  it('requires a matching saved revision and a valid target', async () => {
    const { projectId, graphVersion } = seedAssetProject()
    const stale = await call(
      'flowAsset.submit',
      {
        projectId,
        nodeId: 'shape:text1',
        portId: 'out-text',
        expectedGraphVersion: graphVersion + 3
      },
      key()
    )
    expect(stale.error?.code).toBe('REVISION_CONFLICT')
    const badPort = await call(
      'flowAsset.submit',
      {
        projectId,
        nodeId: 'shape:text1',
        portId: 'out-json',
        expectedGraphVersion: graphVersion
      },
      key()
    )
    expect(badPort.error?.code).toBe('ASSET_PORT_INVALID')
    const ghostNode = await call(
      'flowAsset.submit',
      {
        projectId,
        nodeId: 'shape:ghost',
        portId: 'out-text',
        expectedGraphVersion: graphVersion
      },
      key()
    )
    expect(ghostNode.error?.code).toBe('ASSET_NODE_MISSING')
    const ghostProject = await call(
      'flowAsset.submit',
      {
        projectId: 'no-such-project',
        nodeId: 'shape:text1',
        portId: 'out-text',
        expectedGraphVersion: graphVersion
      },
      key()
    )
    expect(ghostProject.error?.code).toBe('NOT_FOUND')
    const invalid = await call(
      'flowAsset.submit',
      { projectId, nodeId: 'shape:text1', portId: 'out text', expectedGraphVersion: graphVersion },
      key()
    )
    expect(invalid.error?.code).toBe('INVALID_INPUT')
    // 外部不能自带取值：契约里没有 value 字段，多带即非法（取值只来自已保存画布）。
    const injected = await call(
      'flowAsset.submit',
      {
        projectId,
        nodeId: 'shape:text1',
        portId: 'out-text',
        expectedGraphVersion: graphVersion,
        value: { kind: 'text', text: '伪造取值' }
      },
      key()
    )
    expect(injected.error?.code).toBe('INVALID_INPUT')
    // 写入失败不留版本。
    expect(assetVersionCount(projectId)).toBe(0)
  })

  it('flushes the open canvas through the desktop save barrier before fixing a version', async () => {
    const { projectId, graphVersion } = seedAssetProject()
    active = projectId
    const requests: Array<Record<string, unknown>> = []
    withDesktop({
      run: async (request) => {
        requests.push(request as unknown as Record<string, unknown>)
        return { graphVersion: openProject(projectId)!.meta.graphVersion }
      },
      ask: async () => ({ authorized: false })
    })
    const result = await call(
      'flowAsset.submit',
      { projectId, nodeId: 'shape:text1', portId: 'out-text', expectedGraphVersion: graphVersion },
      key()
    )
    expect(result.status).toBe('completed')
    expect(requests[0]).toMatchObject({ action: 'flush', projectId })
    // 打开但没有桌面宿主：不直接读内存/磁盘猜版本，明确要求宿主就绪。
    withDesktop(undefined)
    const noHost = await call(
      'flowAsset.submit',
      { projectId, nodeId: 'shape:text1', portId: 'out-text', expectedGraphVersion: graphVersion },
      key()
    )
    expect(noHost.error?.code).toBe('ACTIVE_PROJECT_REQUIRED')
  })

  it('does not bypass project occupancy for writes', async () => {
    const { projectId, graphVersion } = seedAssetProject()
    // 与 GUI 命令账本同构的 pending 命令（同一节点占用）由外部写策略先挡住：
    // 外部写操作在占用期一律 RESOURCE_BUSY，不能借固定资产提交绕过占用。
    const db = getDb()
    db.prepare(
      'INSERT INTO flow_command_tasks(task_id,project_id,agent_node_id,max_steps) VALUES (?,?,?,?)'
    ).run('task-occ', projectId, 'shape:agent1', 6)
    db.prepare(
      `INSERT INTO flow_commands
        (project_id,command_id,signature,command_json,target_node_id,task_id,lease_id,owner_session,run_id,state,receipt_json,created_at,admitted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      projectId,
      'cmd-occ',
      'sig',
      '{}',
      'shape:text1',
      'task-occ',
      'lease-1',
      'session-1',
      'run-1',
      'pending',
      '{}',
      Date.now(),
      0
    )
    const result = await call(
      'flowAsset.submit',
      { projectId, nodeId: 'shape:text1', portId: 'out-text', expectedGraphVersion: graphVersion },
      key()
    )
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('RESOURCE_BUSY')
    expect(assetVersionCount(projectId)).toBe(0)
  })

  it('rejects cross-project version reads and oversized values honestly', async () => {
    const first = seedAssetProject('资产 A')
    const second = createProject('资产 B')
    const submitted = await call(
      'flowAsset.submit',
      {
        projectId: first.projectId,
        nodeId: 'shape:text1',
        portId: 'out-text',
        expectedGraphVersion: first.graphVersion
      },
      key()
    )
    const versionId = submitted.data.ref.versionId
    const cross = await call('flowAsset.read', { projectId: second.id, versionId })
    expect(cross.error?.code).toBe('ASSET_VERSION_MISSING')
    const ghost = await call('flowAsset.read', { projectId: first.projectId, versionId: 'ghost-version' })
    expect(ghost.error?.code).toBe('ASSET_VERSION_MISSING')

    // 超出外部读取上限时如实拒绝（不截断、不伪装成功）。
    const config = JSON.stringify({ privateConfigKey: 'private-config-value' })
    const huge = 'x'.repeat(20001)
    const saved = saveProject({
      id: first.projectId,
      graph: {
        nodes: [
          node(
            'shape:text1',
            'text',
            3,
            [
              {
                id: 'out-text',
                name: '文本',
                dir: 'out',
                type: 'text',
                required: true,
                cardinality: 'one',
                description: '输出文本'
              }
            ],
            huge,
            config
          )
        ],
        edges: [],
        groups: []
      },
      tldrawSnapshot: { store: { 'shape:text1': shape('shape:text1', 'text', huge, config) } }
    })!
    const large = await call(
      'flowAsset.submit',
      {
        projectId: first.projectId,
        nodeId: 'shape:text1',
        portId: 'out-text',
        expectedGraphVersion: saved.graphVersion
      },
      key()
    )
    expect(large.status).toBe('completed')
    const tooLarge = await call('flowAsset.read', {
      projectId: first.projectId,
      versionId: large.data.ref.versionId
    })
    expect(tooLarge.status).toBe('failed')
    expect(tooLarge.error?.code).toBe('ASSET_VALUE_TOO_LARGE')
  })
})

describe('unopened Flow lifecycle actions', () => {
  it('keeps impersonation-prone actions unregistered while run/build/review go through the shared host port', async () => {
    // F8 第二批：run/pause/stop 已开放，但只经"启动时创建的那一个宿主实例"的窄接口执行
    // （见 flow-bridge）；F8 收官：build（inspect/propose/commit）与 review 也只经同一
    // builder/review 宿主端口开放。冒充人工决定或内部运行发布的 cooperate/publication
    // 仍不开放。
    const notOpened = ['flowAgent.cooperate', 'flowAgent.publication']
    for (const operationId of notOpened) expect(ACCESS_OPERATIONS).not.toHaveProperty(operationId)
    const capability = await call('capability.list')
    const listed = (capability.data as any).operations.map((item: any) => item.operationId)
    for (const operationId of notOpened) expect(listed).not.toContain(operationId)
    for (const operationId of [
      'flowAgent.inspect',
      'flowAgent.catalog',
      'flowAgent.collaboration',
      'flowAgent.run',
      'flowAgent.pause',
      'flowAgent.stop',
      'flowAgent.build.inspect',
      'flowAgent.build.propose',
      'flowAgent.build.commit',
      'flowAgent.review',
      'flowAsset.submit',
      'flowAsset.list',
      'flowAsset.read'
    ])
      expect(listed).toContain(operationId)

    const { projectId } = seedFlowProject()
    const { taskId } = seedTask(projectId, 'running')
    active = projectId
    const before = taskRow(taskId)
    // 冒充型动作：Registry 直接拒绝，账本事实不变。
    for (const operationId of notOpened) {
      const result = await call(operationId, { projectId, nodeId: 'shape:agent1' }, key())
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('UNSUPPORTED_OPERATION')
    }
    // 运行控制在本用例里没有发布宿主端口（测试未注入）：必须如实拒绝，
    // 仍然不改写账本。不新建宿主、不伪造任务——"同一实例"的完整证据见
    // test/local-agent-flow-agent-run-access.test.ts。
    const unavailable = await call(
      'flowAgent.run',
      { projectId, nodeId: 'shape:agent1', action: 'start' },
      key()
    )
    expect(unavailable.status).toBe('failed')
    expect(unavailable.error?.code).toBe('FLOW_AGENTS_UNAVAILABLE')
    for (const operationId of ['flowAgent.pause', 'flowAgent.stop']) {
      const result = await call(operationId, { projectId, nodeId: 'shape:agent1' }, key())
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('FLOW_AGENTS_UNAVAILABLE')
    }
    expect(taskRow(taskId)).toEqual(before)
  })

  it('records only the shared dispatch lifecycle for opened operations (no new event types)', async () => {
    const { projectId, graphVersion } = seedAssetProject()
    const result = await call(
      'flowAsset.submit',
      { projectId, nodeId: 'shape:text1', portId: 'out-text', expectedGraphVersion: graphVersion },
      key()
    )
    expect(result.status).toBe('completed')
    const lifecycle = events.filter((event) =>
      String(event.event ?? '').startsWith('agent.access.')
    )
    expect(lifecycle.map((event) => event.event)).toEqual([
      'agent.access.started',
      'agent.access.completed'
    ])
    expect((lifecycle[0] as any).attributes).toMatchObject({ operation: 'flowAsset.submit' })
    // 事件里不含正文、配置或绝对路径。
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('交付内容')
    expect(serialized).not.toContain('private-config-value')
    expect(serialized).not.toContain(directory)
  })
})
