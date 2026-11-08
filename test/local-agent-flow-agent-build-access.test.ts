// F8（收官）：Flow 建图预览/提交与模型审核外部接入测试。
//
// 这些用例要证明的不是"接口能返回"而是四条安全边界：
// 1) 只经启动时创建的同一宿主端口执行（端口未发布 → FLOW_AGENTS_UNAVAILABLE，不降级替身）；
// 2) propose/review 的模型预检发生在宿主调用之前——预检失败时零模型请求（付费路径不被触发）；
// 3) 外部不能自带建图内容：commit 只按 buildId 触发渲染器权威动作，且 main 以持久化
//    预览状态与已保存节点核对，不把桌面回执当成功；超时/失联返回 unknown；
// 4) 审核结论由模型产生：外部输入没有 passed/decision 字段（strict schema 拒绝），
//    main 生成的 request/trace/span 不能由调用方伪造。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasNode } from '../src/shared/types'
import { closeDb, getDataDir } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import {
  publishFlowAgentAccessPort,
  resetFlowAgentAccessPortForTest
} from '../src/main/agent-access/flow-bridge'
import { DesktopAccessError, type AccessDesktop } from '../src/main/agent-access/desktop'
import { AgentRuntimeError } from '../src/shared/agent-flow/runtime-contracts'
import type { BuildPreview } from '../src/shared/agent-flow/builder'
import type { ReviewDecision } from '../src/shared/agent-flow/node-contracts'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory: string
let service: LocalAccessService
let active: string | null
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

interface FakePort {
  buildCalls: Array<Record<string, unknown>>
  reviewCalls: Array<Record<string, unknown>>
  prechecks: Array<{ kind: 'scope' | 'review'; projectId: string; nodeId: string }>
  precheckError: Error | null
  reviewPrecheckError: Error | null
  /** 依次返回的 inspect 结果；用尽后回退到 inspectReply。 */
  inspectReplies: unknown[]
  inspectReply: unknown
  proposeReply: unknown
  reviewReply: unknown
  reviewError: Error | null
}

function publishFakePort(overrides: Partial<FakePort> = {}): FakePort {
  const port: FakePort = {
    buildCalls: [],
    reviewCalls: [],
    prechecks: [],
    precheckError: null,
    reviewPrecheckError: null,
    inspectReplies: [],
    inspectReply: null,
    proposeReply: null,
    reviewReply: reviewDecision(),
    reviewError: null,
    ...overrides
  }
  publishFlowAgentAccessPort({
    async run() {
      return { task: null, refs: [], outputs: {} }
    },
    pause() {
      return null
    },
    stop() {
      return null
    },
    async assertAgentScopeToolCalling(projectId, nodeId) {
      port.prechecks.push({ kind: 'scope', projectId, nodeId })
      if (port.precheckError) throw port.precheckError
    },
    async build(raw) {
      const call = raw as Record<string, unknown>
      port.buildCalls.push(call)
      if (call.action === 'propose') return port.proposeReply
      if (call.action === 'inspect') {
        if (port.inspectReplies.length > 0) return port.inspectReplies.shift()
        return port.inspectReply
      }
      return null
    },
    async review(raw) {
      port.reviewCalls.push(raw as Record<string, unknown>)
      if (port.reviewError) throw port.reviewError
      return port.reviewReply
    },
    async assertReviewToolCalling(projectId, nodeId) {
      port.prechecks.push({ kind: 'review', projectId, nodeId })
      if (port.reviewPrecheckError) throw port.reviewPrecheckError
    }
  })
  return port
}

function graphNode(id: string, title = '节点'): CanvasNode {
  return {
    id,
    type: 'agent',
    contractVersion: 1,
    title,
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [],
    params: { config: '{}' },
    content: { kind: 'empty' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  }
}

function seedNodes(projectId: string, ids: string[]): void {
  saveProject({
    id: projectId,
    graph: { nodes: ids.map((id) => graphNode(id)), edges: [], groups: [] }
  })
}

function preview(state: BuildPreview['state'] = 'preview'): BuildPreview {
  return {
    buildId: 'build-test-1',
    projectId: 'project-placeholder',
    nodeId: 'shape:builder',
    semanticRevision: 'rev-1',
    state,
    plan: {
      title: '建图标题',
      topology: 'sequential',
      steps: [
        {
          title: '一步',
          goal: '目标文本',
          mode: 'autonomous',
          capability: 'text-template@1',
          template: '{{value}}'
        }
      ]
    },
    nodes: [
      {
        id: 'shape:build-test-1-main',
        type: 'agent',
        title: '建图主节点',
        // 正文/配置是业务内容：外部响应不得回传（断言见 build.inspect 用例）。
        text: '秘密建图正文',
        config: '{"secret":"秘密配置"}',
        contractVersion: 1,
        x: 0,
        y: 0
      }
    ],
    edges: []
  }
}

function reviewDecision(): ReviewDecision {
  return {
    schemaVersion: 1,
    reviewId: 'review-abc',
    cycleId: 'cycle-1',
    reviewNodeId: 'shape:review',
    reviewRevision: 0,
    rulesVersion: 'builder-review-v1',
    subjects: [
      {
        assetId: 'asset-1',
        versionId: 'version-1',
        sourceNodeId: 'shape:source',
        sourcePortId: 'out-text'
      }
    ],
    passed: false,
    feedback: '需要补充细节',
    evidenceScope: 'complete-text-json',
    issues: [{ assetId: 'asset-1', versionId: 'version-1', feedback: '缺少结尾' }]
  }
}

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

function write(operationId: string, input: unknown, idempotencyKey = key()) {
  return call(operationId, input, idempotencyKey)
}

function withProject(overrides: Partial<BuildPreview> = {}): { projectId: string; preview: BuildPreview } {
  const project = createProject('建图测试项目')
  active = project.id
  return {
    projectId: project.id,
    preview: { ...preview(), projectId: project.id, ...overrides }
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-flow-build-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  setGatewayEventSink({ emit: () => undefined })
  resetFlowAgentAccessPortForTest()
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active
  })
})

afterEach(() => {
  resetFlowAgentAccessPortForTest()
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('flowAgent 建图/审核准入', () => {
  it('宿主端口未发布时四个操作都如实拒绝（不降级成本地替身）', async () => {
    const project = createProject('建图-无宿主')
    active = project.id
    for (const [operationId, input] of [
      ['flowAgent.build.inspect', { projectId: project.id, nodeId: 'shape:builder' }],
      ['flowAgent.build.propose', { projectId: project.id, nodeId: 'shape:builder' }],
      [
        'flowAgent.build.commit',
        { projectId: project.id, nodeId: 'shape:builder', buildId: 'build-test-1' }
      ],
      ['flowAgent.review', { projectId: project.id, nodeId: 'shape:review' }]
    ] as const) {
      const response = await write(operationId, input)
      expect(response.status).toBe('failed')
      expect(response.error?.code).toBe('FLOW_AGENTS_UNAVAILABLE')
    }
  })

  it('非活动画布：四个操作在调用宿主前拒绝', async () => {
    const project = createProject('建图-非活动')
    const other = createProject('建图-前台')
    active = other.id
    const port = publishFakePort()
    for (const [operationId, input] of [
      ['flowAgent.build.inspect', { projectId: project.id, nodeId: 'shape:builder' }],
      ['flowAgent.build.propose', { projectId: project.id, nodeId: 'shape:builder' }],
      [
        'flowAgent.build.commit',
        { projectId: project.id, nodeId: 'shape:builder', buildId: 'build-test-1' }
      ],
      ['flowAgent.review', { projectId: project.id, nodeId: 'shape:review' }]
    ] as const) {
      const response = await write(operationId, input)
      expect(response.status).toBe('failed')
      expect(response.error?.code).toBe('ACTIVE_PROJECT_REQUIRED')
    }
    expect(port.buildCalls).toEqual([])
    expect(port.reviewCalls).toEqual([])
    expect(port.prechecks).toEqual([])
  })

  it('build.inspect 只读持久化预览，不回传建图正文/配置', async () => {
    const { projectId, preview: current } = withProject()
    const port = publishFakePort({ inspectReply: current })
    const response = await write('flowAgent.build.inspect', {
      projectId,
      nodeId: 'shape:builder'
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    expect(port.buildCalls[0]).toMatchObject({
      projectId,
      nodeId: 'shape:builder',
      action: 'inspect'
    })
    const data = response.data as { build: { buildId: string; state: string }; graphVersion: number }
    expect(data.graphVersion).toBe(openProject(projectId)!.meta.graphVersion)
    expect(data.build).toMatchObject({ buildId: 'build-test-1', state: 'preview' })
    // 业务正文/配置不进入外部响应（避免建图内容泄漏）。
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain('秘密建图正文')
    expect(serialized).not.toContain('秘密配置')
  })

  it('没有预览时 build.inspect 返回 build:null，不编造空预览', async () => {
    const { projectId } = withProject()
    publishFakePort({ inspectReply: null })
    const response = await write('flowAgent.build.inspect', {
      projectId,
      nodeId: 'shape:builder'
    })
    expect(response.status).toBe('completed')
    expect((response.data as { build: unknown }).build).toBeNull()
  })

  it('build.propose 先做模型工具调用预检，再用 main 生成的身份调用同一宿主并读回持久化预览', async () => {
    const { projectId, preview: current } = withProject()
    const port = publishFakePort({ proposeReply: current, inspectReply: current })
    const response = await write('flowAgent.build.propose', {
      projectId,
      nodeId: 'shape:builder'
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    expect(port.prechecks).toEqual([{ kind: 'scope', projectId, nodeId: 'shape:builder' }])
    const propose = port.buildCalls.find((call) => call.action === 'propose')!
    expect(propose).toMatchObject({ projectId, nodeId: 'shape:builder', action: 'propose' })
    // 运行身份由 main 生成：外部没有传，requestId 是 UUID，trace/span 是 main 的
    // 关联 ID 前缀格式（外部无法指定）。
    expect(String(propose.requestId)).toMatch(/^[a-f0-9-]{36}$/)
    expect(String(propose.traceId)).toMatch(/^trace-[a-f0-9-]{36}$/)
    expect(String(propose.spanId)).toMatch(/^span-[a-f0-9-]{36}$/)
    // 读回同一条持久化预览（不是只信 propose 返回值）。
    expect(port.buildCalls.filter((call) => call.action === 'inspect')).toHaveLength(1)
    const data = response.data as { build: { buildId: string; state: string } }
    expect(data.build).toMatchObject({ buildId: 'build-test-1', state: 'preview' })
  })

  it('模型预检失败时 propose/review 一次都不会调用宿主（付费路径不被触发）', async () => {
    const { projectId } = withProject()
    const port = publishFakePort({
      precheckError: new AgentRuntimeError('AGENT_MODEL_TOOL_UNVERIFIED', 'model-capability'),
      reviewPrecheckError: new AgentRuntimeError('AGENT_MODEL_UNAVAILABLE', 'model-capability')
    })
    const proposed = await write('flowAgent.build.propose', {
      projectId,
      nodeId: 'shape:builder'
    })
    expect(proposed.status).toBe('failed')
    expect(proposed.error?.code).toBe('AGENT_MODEL_TOOL_UNVERIFIED')
    expect(port.buildCalls).toEqual([])
    const reviewed = await write('flowAgent.review', { projectId, nodeId: 'shape:review' })
    expect(reviewed.status).toBe('failed')
    expect(reviewed.error?.code).toBe('AGENT_MODEL_UNAVAILABLE')
    expect(port.reviewCalls).toEqual([])
  })

  it('build.commit 在预览不存在时拒绝，且不触发桌面提交', async () => {
    const { projectId } = withProject()
    const desktopCalls: unknown[] = []
    const port = publishFakePort({ inspectReply: null })
    service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(getDataDir(), 'agent-exports'),
      activeProjectId: () => active,
      desktop: {
        async run(input) {
          desktopCalls.push(input)
          return { graphVersion: 1 }
        },
        async ask() {
          return { authorized: false }
        }
      }
    })
    const response = await write('flowAgent.build.commit', {
      projectId,
      nodeId: 'shape:builder',
      buildId: 'build-test-1'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('FLOW_BUILD_MISSING')
    expect(desktopCalls).toEqual([])
    expect(port.buildCalls.filter((call) => call.action === 'commit')).toEqual([])
  })

  it('桌面宿主不可用时 build.commit 如实 DESKTOP_UNAVAILABLE（不伪造画布提交）', async () => {
    const { projectId, preview: proposed } = withProject()
    publishFakePort({ inspectReply: proposed })
    const response = await write('flowAgent.build.commit', {
      projectId,
      nodeId: 'shape:builder',
      buildId: 'build-test-1'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('DESKTOP_UNAVAILABLE')
  })

  it('build.commit 只按 buildId 触发权威桌面动作，并以持久化 committed 状态与节点核对成功', async () => {
    const { projectId, preview: proposed } = withProject()
    const committed = { ...proposed, state: 'committed' as const }
    const desktopCalls: Array<Record<string, unknown>> = []
    let saveProjectOnCommit = true
    const desktop: AccessDesktop = {
      async run(input) {
        desktopCalls.push(input as Record<string, unknown>)
        if (saveProjectOnCommit)
          seedNodes(
            projectId,
            committed.nodes.map((node) => node.id)
          )
        return {
          graphVersion: openProject(projectId)!.meta.graphVersion,
          result: { buildId: committed.buildId, state: 'committed' }
        }
      },
      async ask() {
        return { authorized: false }
      }
    }
    const port = publishFakePort({
      inspectReplies: [proposed, committed]
    })
    service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(getDataDir(), 'agent-exports'),
      activeProjectId: () => active,
      desktop
    })
    const response = await write('flowAgent.build.commit', {
      projectId,
      nodeId: 'shape:builder',
      buildId: 'build-test-1'
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    expect(desktopCalls).toHaveLength(1)
    expect(desktopCalls[0]).toMatchObject({
      action: 'flow-build',
      projectId,
      nodeId: 'shape:builder',
      buildId: 'build-test-1'
    })
    // 外部不能自带建图内容：桌面载荷里只有 buildId/目标，没有节点/边/正文。
    expect(JSON.stringify(desktopCalls[0])).not.toContain('秘密建图正文')
    const data = response.data as { build: { state: string }; committedNodeIds: string[] }
    expect(data.build.state).toBe('committed')
    expect(data.committedNodeIds).toEqual(['shape:build-test-1-main'])
    expect(openProject(projectId)!.nodes.map((node) => node.id)).toContain(
      'shape:build-test-1-main'
    )
    // 宿主 inspect 被调用两次：提交前预检 + 提交后核对。
    expect(port.buildCalls.filter((call) => call.action === 'inspect')).toHaveLength(2)
  })

  it('桌面提交后主机数据不一致（节点未落盘）时如实 failed，不把回执当成功', async () => {
    const { projectId, preview: proposed } = withProject()
    const committed = { ...proposed, state: 'committed' as const }
    publishFakePort({ inspectReplies: [proposed, committed] })
    service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(getDataDir(), 'agent-exports'),
      activeProjectId: () => active,
      desktop: {
        // 模拟"回执成功但保存未完成"：不写项目节点。
        async run() {
          return { graphVersion: 1, result: { buildId: committed.buildId } }
        },
        async ask() {
          return { authorized: false }
        }
      }
    })
    const response = await write('flowAgent.build.commit', {
      projectId,
      nodeId: 'shape:builder',
      buildId: 'build-test-1'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('STORAGE_INCONSISTENT')
  })

  it('桌面准入后失联按 unknown 返回，不报成功也不自动重发', async () => {
    const { projectId, preview: proposed } = withProject()
    publishFakePort({ inspectReply: proposed })
    const desktopCalls: unknown[] = []
    service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(getDataDir(), 'agent-exports'),
      activeProjectId: () => active,
      desktop: {
        async run(input) {
          desktopCalls.push(input)
          // desktop 层：超时/进程丢失 → unknownOutcome=true。
          throw new DesktopAccessError('DESKTOP_TIMEOUT', true)
        },
        async ask() {
          return { authorized: false }
        }
      }
    })
    const response = await write('flowAgent.build.commit', {
      projectId,
      nodeId: 'shape:builder',
      buildId: 'build-test-1'
    })
    expect(response.status).toBe('unknown')
    expect(response.error?.code).toBe('OUTCOME_UNKNOWN')
    expect(desktopCalls).toHaveLength(1)
  })

  it('桌面明确拒绝（准入前失败）如实 failed 并保留稳定错误码', async () => {
    const { projectId, preview: proposed } = withProject()
    publishFakePort({ inspectReply: proposed })
    service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(getDataDir(), 'agent-exports'),
      activeProjectId: () => active,
      desktop: {
        async run() {
          throw new DesktopAccessError('FLOW_REVISION_CONFLICT', false)
        },
        async ask() {
          return { authorized: false }
        }
      }
    })
    const response = await write('flowAgent.build.commit', {
      projectId,
      nodeId: 'shape:builder',
      buildId: 'build-test-1'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('FLOW_REVISION_CONFLICT')
  })

  it('已 committed 的预览重复提交不再次触发桌面动作（回执丢失后的幂等核对）', async () => {
    const { projectId, preview: proposed } = withProject()
    const committed = { ...proposed, state: 'committed' as const }
    seedNodes(
      projectId,
      committed.nodes.map((node) => node.id)
    )
    const desktopCalls: unknown[] = []
    publishFakePort({ inspectReply: committed })
    service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(getDataDir(), 'agent-exports'),
      activeProjectId: () => active,
      desktop: {
        async run(input) {
          desktopCalls.push(input)
          return { graphVersion: 1 }
        },
        async ask() {
          return { authorized: false }
        }
      }
    })
    const response = await write('flowAgent.build.commit', {
      projectId,
      nodeId: 'shape:builder',
      buildId: committed.buildId
    })
    expect(response.status).toBe('completed')
    expect(desktopCalls).toEqual([])
    expect((response.data as { committedNodeIds: string[] }).committedNodeIds).toEqual([
      'shape:build-test-1-main'
    ])
  })

  it('build.commit 必须携带 buildId（外部不能提交未指定预览的建图）', async () => {
    const { projectId } = withProject()
    publishFakePort()
    const response = await write('flowAgent.build.commit', {
      projectId,
      nodeId: 'shape:builder'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('INVALID_INPUT')
  })

  it('review 提交并读取模型报告；结论字段不可由外部改写（strict 输入拒绝）', async () => {
    const { projectId } = withProject()
    const port = publishFakePort()
    const response = await write('flowAgent.review', { projectId, nodeId: 'shape:review' })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    expect(port.prechecks).toEqual([{ kind: 'review', projectId, nodeId: 'shape:review' }])
    const raw = port.reviewCalls[0]
    expect(String(raw.requestId)).toMatch(/^[a-f0-9-]{36}$/)
    expect(String(raw.traceId)).toMatch(/^trace-[a-f0-9-]{36}$/)
    expect(String(raw.spanId)).toMatch(/^span-[a-f0-9-]{36}$/)
    const decision = (response.data as { decision: unknown }).decision as Record<string, unknown>
    expect(decision).toMatchObject({
      reviewId: 'review-abc',
      passed: false,
      feedback: '需要补充细节',
      evidenceScope: 'complete-text-json'
    })
    expect(decision.issues).toEqual([
      { assetId: 'asset-1', versionId: 'version-1', feedback: '缺少结尾' }
    ])
    // 外部不能把审核结论改成通过：输入带 passed/decision 会被 strict schema 拒绝。
    const forged = await write('flowAgent.review', {
      projectId,
      nodeId: 'shape:review',
      passed: true
    })
    expect(forged.status).toBe('failed')
    expect(forged.error?.code).toBe('INVALID_INPUT')
    expect(port.reviewCalls).toHaveLength(1)
  })

  it('propose 的模型预检失败时不会产生任务或模型调用（同幂等键重放也只调用一次）', async () => {
    const { projectId } = withProject()
    const port = publishFakePort({
      precheckError: new AgentRuntimeError('AGENT_MODEL_UNAVAILABLE', 'model-capability')
    })
    const idempotencyKey = key()
    const first = await call(
      'flowAgent.build.propose',
      { projectId, nodeId: 'shape:builder' },
      idempotencyKey
    )
    const replay = await call(
      'flowAgent.build.propose',
      { projectId, nodeId: 'shape:builder' },
      idempotencyKey
    )
    expect(first.status).toBe('failed')
    expect(first.error?.code).toBe('AGENT_MODEL_UNAVAILABLE')
    expect(replay.status).toBe('failed')
    expect(replay.data).toBeUndefined()
    expect(port.buildCalls).toEqual([])
    expect(port.prechecks).toHaveLength(1)
  })
})
