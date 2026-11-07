// F2 图读写外部接入测试：graph.get / node.get / graph.patch 的服务端行为。
// 覆盖：非打开项目拒绝、结构预检、幂等回执、权威宿主核对、读取不泄漏 config/text、
// validated 失败映射与 unknown 保守语义。renderer 侧 planGraphPatch 校验矩阵见同目录
// graph-patch 测试。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasNode, PortDecl } from '../src/shared/types'
import { closeDb, getDataDir } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { AccessDesktop } from '../src/main/agent-access/desktop'

let directory: string
let service: LocalAccessService
let active: string | null
let desktopCalls = 0
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

function call(operationId: string, input: unknown = {}, idempotencyKey?: string) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    ...(idempotencyKey ? { idempotencyKey } : {})
  })
}

function textNode(id: string, text: string, x = 0, y = 0): CanvasNode {
  return {
    id: `shape:${id}`,
    type: 'text',
    contractVersion: 3,
    title: `标题${id}`,
    x,
    y,
    w: 340,
    h: 260,
    ports: [
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
    params: { config: JSON.stringify({ privateConfigKey: 'private-config-value' }) },
    content: { kind: 'text', text },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  }
}

function edge(id: string, from: string, to: string, fromPort = 'out-text', toPort = 'in-text') {
  return { id: `shape:${id}`, from: { nodeId: `shape:${from}`, portId: fromPort }, to: { nodeId: `shape:${to}`, portId: toPort } }
}

function seedGraph(projectId: string, nodes: CanvasNode[], edges: ReturnType<typeof edge>[]): number {
  return saveProject({ id: projectId, graph: { nodes, edges, groups: [] } })!.graphVersion
}

function mockDesktop(graphVersion: number, result?: unknown, failValidated?: { code: string; detail?: string }): AccessDesktop {
  return {
    run: async (request, commit) => {
      desktopCalls += 1
      if (failValidated) throw Object.assign(new Error(failValidated.code), { code: failValidated.code })
      // 与真实渲染器一致：准入提交当前持久化版本，而不是随意编造。
      if (request.action === 'graph-patch' && commit) commit(openProject(String(request.projectId))!.meta.graphVersion)
      return { graphVersion, ...(result !== undefined ? { result } : {}) }
    }
  }
}

function withDesktop(desktop: AccessDesktop | undefined): void {
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active,
    desktop
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-graph-access-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  desktopCalls = 0
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active
  })
})

afterEach(() => {
  closeDb()
  setGatewayEventSink(null)
  process.env.CANVAS_DATA_DIR = originalDirectory
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-graph-access-test-')
  )
    throw new Error('GRAPH_ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('local Agent graph access', () => {
  it('reads a persisted graph view with pagination and without config or text contents', async () => {
    const p = createProject('读图')
    seedGraph(p.id, [textNode('a', 'private-text-a'), textNode('b', 'private-text-b', 500, 0)], [
      edge('e1', 'a', 'b')
    ])
    const read = await call('graph.get', { projectId: p.id, offset: 0, limit: 1 })
    expect(read.status).toBe('completed')
    const data = read.data as any
    expect(data).toMatchObject({ view: 'persisted', graphVersion: 1, total: 2, unsaved: false })
    expect(data.nodes).toHaveLength(1)
    expect(data.edges).toHaveLength(1)
    expect(data.edges[0]).toMatchObject({ from: { portId: 'out-text' }, to: { portId: 'in-text' } })
    expect(JSON.stringify(read)).not.toContain('private-text-a')
    expect(JSON.stringify(read)).not.toContain('private-config-value')
    const page2 = await call('graph.get', { projectId: p.id, offset: 1, limit: 1 })
    expect(((page2.data as any).nodes[0] as any).nodeId).toBe('shape:b')
  })

  it('reads a single node with config, text and edge references', async () => {
    const p = createProject('读节点')
    seedGraph(p.id, [textNode('a', '节点正文'), textNode('b', '', 500, 0)], [edge('e1', 'a', 'b')])
    const read = await call('node.get', { projectId: p.id, nodeId: 'shape:a' })
    expect(read.status).toBe('completed')
    const node = (read.data as any).node
    expect(node).toMatchObject({ type: 'text', contentKind: 'text' })
    expect(node.text).toBe('节点正文')
    expect(node.config).toEqual({ privateConfigKey: 'private-config-value' })
    expect(node.edgesOut).toHaveLength(1)
    expect(node.edgesOut[0].to.nodeId).toBe('shape:b')
    expect((await call('node.get', { projectId: p.id, nodeId: 'shape:missing' })).error?.code).toBe(
      'NODE_NOT_FOUND'
    )
  })

  it('falls back to the persisted view when latest is requested without a resident host', async () => {
    const p = createProject('未打开')
    seedGraph(p.id, [textNode('a', 'x')], [])
    const read = await call('graph.get', { projectId: p.id, view: 'latest' })
    expect((read.data as any).view).toBe('persisted')
    expect(desktopCalls).toBe(0)
  })

  it('rejects graph.patch for a project without a resident host and prechecks references', async () => {
    const p = createProject('离线')
    const ops = [{ action: 'node.create', ref: 'a', nodeType: 'text', x: 0, y: 0 }]
    const rejected = await call('graph.patch', { projectId: p.id, expectedGraphVersion: 0, ops }, key())
    expect(rejected.error?.code).toBe('ACTIVE_PROJECT_REQUIRED')
    expect(desktopCalls).toBe(0)
    active = p.id
    withDesktop(mockDesktop(1))
    const dangling = await call(
      'graph.patch',
      {
        projectId: p.id,
        expectedGraphVersion: 0,
        ops: [
          { action: 'node.create', ref: 'a', nodeType: 'text', x: 0, y: 0 },
          { action: 'edge.create', from: { nodeId: 'missing-ref', portId: 'out-text' }, to: { nodeId: 'a', portId: 'in-text' } }
        ]
      },
      key()
    )
    expect(dangling.error?.code).toBe('PATCH_REFERENCE_INVALID')
    expect(desktopCalls).toBe(0)
    // 版本核对由权威宿主在保存未保存内容后执行（见 validated 失败与 renderer 规划器测试）。
  })

  it('applies a batch through the authoritative host, maps created ids and replays idempotently', async () => {
    const p = createProject('建图')
    seedGraph(p.id, [textNode('up', '上游文本')], [])
    active = p.id
    const ops = [
      { action: 'node.create', ref: 'n1', nodeType: 'text', x: 100, y: 200, title: '外部节点' },
      {
        action: 'edge.create',
        ref: 'e1',
        from: { nodeId: 'shape:up', portId: 'out-text' },
        to: { nodeId: 'n1', portId: 'in-text' },
        connectOrder: 1
      }
    ]
    const createdNodeId = 'shape:agent-created-1'
    const edgeId = 'shape:agent-edge-1'
    withDesktop({
      run: async (request, commit) => {
        desktopCalls += 1
        expect(request.action).toBe('graph-patch')
        // 模拟权威宿主：准入（应用前版本）→ 应用并经正式保存路径落盘 → 回执。
        const before = openProject(p.id)!
        commit?.(before.meta.graphVersion)
        const saved = saveProject({
          id: p.id,
          expectedGraphVersion: before.meta.graphVersion,
          graph: {
            nodes: [
              ...before.nodes,
              {
                id: createdNodeId,
                type: 'text',
                contractVersion: 3,
                title: '外部节点',
                x: 100,
                y: 200,
                w: 340,
                h: 260,
                ports: [],
                params: {},
                content: { kind: 'empty' },
                exec: { status: 'idle' },
                meta: { source: 'input', createdAt: 1 }
              }
            ],
            edges: [
              ...before.edges,
              {
                id: edgeId,
                from: { nodeId: 'shape:up', portId: 'out-text' },
                to: { nodeId: createdNodeId, portId: 'in-text' },
                connectOrder: 1
              }
            ],
            groups: []
          }
        })!
        return {
          graphVersion: saved.graphVersion,
          result: {
            created: [
              { ref: 'n1', nodeId: createdNodeId },
              { ref: 'e1', nodeId: edgeId }
            ],
            counts: { nodeCreated: 1, nodeUpdated: 0, nodeDeleted: 0, edgeCreated: 1, edgeDeleted: 0 }
          }
        }
      }
    })
    const patchKey = key()
    const patched = await call('graph.patch', { projectId: p.id, expectedGraphVersion: 1, ops }, patchKey)
    expect(patched.status).toBe('completed')
    const data = patched.data as any
    expect(data).toMatchObject({
      projectId: p.id,
      graphVersion: 2,
      saved: true,
      applied: { nodeCreated: 1, edgeCreated: 1 }
    })
    expect(data.created).toEqual([
      { ref: 'n1', nodeId: createdNodeId },
      { ref: 'e1', nodeId: edgeId }
    ])
    expect(desktopCalls).toBe(1)
    // Same key replays the original receipt without a second desktop handshake.
    const replay = await call('graph.patch', { projectId: p.id, expectedGraphVersion: 1, ops }, patchKey)
    expect(replay.data).toEqual(data)
    expect(desktopCalls).toBe(1)
    // The host must have persisted the referenced node; the receipt matches disk facts.
    const file = openProject(p.id)!
    expect(file.nodes.some((n) => n.id === createdNodeId)).toBe(true)
    expect(file.edges.some((e) => e.id === edgeId)).toBe(true)
  })

  it('marks an acknowledged but unverified patch as unknown and never replays it silently', async () => {
    const p = createProject('丢失回执')
    active = p.id
    withDesktop(
      mockDesktop(1, {
        created: [{ ref: 'n1', nodeId: 'shape:never-persisted' }],
        counts: { nodeCreated: 1, nodeUpdated: 0, nodeDeleted: 0, edgeCreated: 0, edgeDeleted: 0 }
      })
    )
    const response = await call(
      'graph.patch',
      {
        projectId: p.id,
        expectedGraphVersion: 0,
        ops: [{ action: 'node.create', ref: 'n1', nodeType: 'text', x: 0, y: 0 }]
      },
      key()
    )
    // 准入后的一切失败按 unknown 保守语义处理；Agent 用确定 ID 与 graph.get 核对，
    // 不自动重放。
    expect(response.status).toBe('unknown')
    expect(response.error?.code).toBe('OUTCOME_UNKNOWN')
  })

  it('surfaces validated pre-mutation failures as failed with the host error code', async () => {
    const p = createProject('校验失败')
    active = p.id
    withDesktop({
      run: async () => {
        throw Object.assign(new Error('EDGE_PORT_INVALID'), { name: 'DesktopAccessError' })
      }
    })
    // A typed DesktopAccessError (validated, unknownOutcome=false) maps to failed with the code.
    const { DesktopAccessError } = await import('../src/main/agent-access/desktop')
    withDesktop({
      run: async () => {
        throw new DesktopAccessError('EDGE_PORT_INVALID', false, 'op[1]:in-text')
      }
    })
    const response = await call(
      'graph.patch',
      {
        projectId: p.id,
        expectedGraphVersion: 0,
        ops: [{ action: 'node.create', nodeType: 'text', x: 0, y: 0 }]
      },
      key()
    )
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('EDGE_PORT_INVALID')
    expect(response.error?.detail).toBe('op[1]:in-text')
    const file = openProject(p.id)!
    expect(file.nodes).toHaveLength(0)
    expect(graphVersionOf(p.id)).toBe(0)
  })

  it('keeps unknown semantics when the host fails after admission', async () => {
    const p = createProject('准入后失败')
    active = p.id
    const { DesktopAccessError } = await import('../src/main/agent-access/desktop')
    withDesktop({
      run: async (_request, commit) => {
        commit?.(openProject(p.id)!.meta.graphVersion)
        throw new DesktopAccessError('APPLY_CRASHED', true)
      }
    })
    const response = await call(
      'graph.patch',
      {
        projectId: p.id,
        expectedGraphVersion: 0,
        ops: [{ action: 'node.create', nodeType: 'text', x: 0, y: 0 }]
      },
      key()
    )
    expect(response.status).toBe('unknown')
    expect(response.error?.code).toBe('OUTCOME_UNKNOWN')
  })

  it('rejects undeclared ops and oversized batches at the schema boundary', async () => {
    const p = createProject('schema')
    active = p.id
    withDesktop(mockDesktop(1))
    const tooMany = Array.from({ length: 201 }, (_, i) => ({
      action: 'node.create',
      nodeType: 'text',
      x: i,
      y: 0
    }))
    expect(
      (await call('graph.patch', { projectId: p.id, expectedGraphVersion: 0, ops: tooMany }, key()))
        .error?.code
    ).toBe('INVALID_INPUT')
    expect(
      (
        await call(
          'graph.patch',
          {
            projectId: p.id,
            expectedGraphVersion: 0,
            ops: [{ action: 'node.create', nodeType: 'text', x: 0, y: 0, snapshot: {} }]
          },
          key()
        )
      ).error?.code
    ).toBe('INVALID_INPUT')
    expect(desktopCalls).toBe(0)
  })
})

function graphVersionOf(id: string): number {
  return (openProject(id)!.meta).graphVersion
}
