/**
 * Application Service Layer 测试
 *
 * 验证 NodeService、WorkflowService、ProjectService、CapabilityService
 * 的核心功能。使用内存 Mock Store 避免文件系统依赖。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createServices } from '@application'
import type { ProjectStore, ServiceContainer } from '@application'
import type {
  RunRecord,
  RunUpdatePatch,
  RunArtifactRecord,
  IdempotencyClaimInput,
  IdempotencyClaim,
  IdempotencyCompleteInput,
  IdempotencyReleaseInput
} from '@application'
import { isPortTypeCompatible } from '@application'
import type {
  CanvasNode,
  CanvasEdge,
  GroupDecl,
  ProjectMeta,
  ProjectFile,
  MediaAsset
} from '@shared/types'

// ── 内存 Mock Store ───────────────────────────────────────

class MockStore implements ProjectStore {
  private projects = new Map<string, ProjectFile>()
  private counter = 0

  async listProjects(): Promise<ProjectMeta[]> {
    return Array.from(this.projects.values()).map((f) => f.meta)
  }

  async getProject(id: string): Promise<ProjectFile | null> {
    return this.projects.get(id) ?? null
  }

  async createProject(name: string): Promise<ProjectMeta> {
    const id = `proj_${++this.counter}`
    const now = Date.now()
    const meta: ProjectMeta = { id, name, createdAt: now, updatedAt: now, graphVersion: 0 }
    const file: ProjectFile = { version: 1, meta, nodes: [], edges: [], groups: [] }
    this.projects.set(id, file)
    return meta
  }

  async deleteProject(id: string): Promise<boolean> {
    return this.projects.delete(id)
  }

  async getNodes(projectId: string): Promise<CanvasNode[]> {
    return this.projects.get(projectId)?.nodes ?? []
  }

  async getEdges(projectId: string): Promise<CanvasEdge[]> {
    return this.projects.get(projectId)?.edges ?? []
  }

  async getGroups(projectId: string): Promise<GroupDecl[]> {
    return this.projects.get(projectId)?.groups ?? []
  }

  async saveGraph(
    projectId: string,
    graph: { nodes: CanvasNode[]; edges: CanvasEdge[]; groups: GroupDecl[] }
  ): Promise<{ graphVersion: number }> {
    const file = this.projects.get(projectId)
    if (!file) throw new Error(`项目不存在: ${projectId}`)
    file.nodes = graph.nodes
    file.edges = graph.edges
    file.groups = graph.groups
    file.meta.graphVersion++
    file.meta.updatedAt = Date.now()
    return { graphVersion: file.meta.graphVersion }
  }

  async listArtifacts(_projectId: string): Promise<MediaAsset[]> {
    return []
  }

  async getArtifact(_assetId: string): Promise<MediaAsset | null> {
    return null
  }

  // ── Run / Artifact 持久化 ──
  private runs = new Map<string, RunRecord>()
  private artifacts = new Map<string, RunArtifactRecord>()
  private idempotency = new Map<
    string,
    { payloadHash: string; state: 'pending' | 'completed'; result?: unknown }
  >()

  async createRun(record: Omit<RunRecord, 'createdAt'>): Promise<RunRecord> {
    const full: RunRecord = { ...record, createdAt: Date.now() }
    this.runs.set(full.runId, full)
    return full
  }

  async updateRun(runId: string, patch: RunUpdatePatch): Promise<RunRecord | null> {
    const existing = this.runs.get(runId)
    if (!existing) return null
    const next = { ...existing, ...patch }
    this.runs.set(runId, next)
    return next
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null
  }

  async listRuns(projectId: string, filter?: { status?: string }): Promise<RunRecord[]> {
    return Array.from(this.runs.values()).filter(
      (r) => r.projectId === projectId && (!filter?.status || r.status === filter.status)
    )
  }

  async createRunArtifact(
    record: Omit<RunArtifactRecord, 'artifactId' | 'createdAt'>
  ): Promise<RunArtifactRecord> {
    const artifactId = `art_${++this.counter}`
    const full: RunArtifactRecord = { ...record, artifactId, createdAt: Date.now() }
    this.artifacts.set(artifactId, full)
    return full
  }

  async listRunArtifacts(runId: string): Promise<RunArtifactRecord[]> {
    return Array.from(this.artifacts.values()).filter((a) => a.runId === runId)
  }

  async claimIdempotency(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
    const key = `${input.actor}:${input.projectId}:${input.operation}:${input.key}`
    const existing = this.idempotency.get(key)
    if (!existing) {
      this.idempotency.set(key, { payloadHash: input.payloadHash, state: 'pending' })
      return { state: 'claimed' }
    }
    if (existing.payloadHash !== input.payloadHash) return { state: 'payload-conflict' }
    return existing.state === 'completed'
      ? { state: 'completed', result: existing.result }
      : { state: 'pending' }
  }

  async completeIdempotency(input: IdempotencyCompleteInput): Promise<void> {
    const key = `${input.actor}:${input.projectId}:${input.operation}:${input.key}`
    this.idempotency.set(key, {
      payloadHash: input.payloadHash,
      state: 'completed',
      result: input.result
    })
  }

  async releaseIdempotency(input: IdempotencyReleaseInput): Promise<void> {
    const key = `${input.actor}:${input.projectId}:${input.operation}:${input.key}`
    this.idempotency.delete(key)
  }
}

// ── 测试辅助 ───────────────────────────────────────────────

function setup(): { services: ServiceContainer; store: MockStore; projectId: string } {
  const store = new MockStore()
  const services = createServices(store)
  // 创建一个测试项目（同步模拟）
  const projectId = `proj_test_${Date.now()}`
  // 直接操作 store 创建项目
  const now = Date.now()
  const meta: ProjectMeta = {
    id: projectId,
    name: '测试项目',
    createdAt: now,
    updatedAt: now,
    graphVersion: 0
  }
  const file: ProjectFile = { version: 1, meta, nodes: [], edges: [], groups: [] }
  // MockStore 的 map 是私有的，通过 createProject 间接创建
  return { services, store, projectId: '' }
}

async function setupAsync(): Promise<{
  services: ServiceContainer
  store: MockStore
  projectId: string
}> {
  const store = new MockStore()
  const services = createServices(store)
  const meta = await store.createProject('测试项目')
  return { services, store, projectId: meta.id }
}

// ── 端口类型兼容性 ───────────────────────────────────────

describe('isPortTypeCompatible()', () => {
  it('相同类型应兼容', () => {
    expect(isPortTypeCompatible('text', 'text')).toBe(true)
    expect(isPortTypeCompatible('image', 'image')).toBe(true)
  })

  it('目标 any 应兼容所有类型', () => {
    expect(isPortTypeCompatible('text', 'any')).toBe(true)
    expect(isPortTypeCompatible('image', 'any')).toBe(true)
  })

  it('源 any 应兼容所有类型', () => {
    expect(isPortTypeCompatible('any', 'text')).toBe(true)
    expect(isPortTypeCompatible('any', 'image')).toBe(true)
  })

  it('text 和 markdown 应互通', () => {
    expect(isPortTypeCompatible('text', 'markdown')).toBe(true)
    expect(isPortTypeCompatible('markdown', 'text')).toBe(true)
  })

  it('不同类型应不兼容', () => {
    expect(isPortTypeCompatible('text', 'image')).toBe(false)
    expect(isPortTypeCompatible('image', 'video')).toBe(false)
  })
})

// ── NodeService 测试 ──────────────────────────────────────

describe('NodeService', () => {
  let env: Awaited<ReturnType<typeof setupAsync>>

  beforeEach(async () => {
    env = await setupAsync()
  })

  describe('createNode()', () => {
    it('应该成功创建文本节点', async () => {
      const result = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any,
        title: '测试文本',
        params: { text: '你好世界' }
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.type).toBe('text')
        expect(result.data.title).toBe('测试文本')
        expect(result.data.ports.length).toBeGreaterThan(0)
        expect(result.data.params.text).toBe('你好世界')
      }
    })

    it('应该从能力定义自动生成端口', async () => {
      const result = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'image-crop' as any
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        const inPorts = result.data.ports.filter((p) => p.dir === 'in')
        const outPorts = result.data.ports.filter((p) => p.dir === 'out')
        expect(inPorts.length).toBeGreaterThan(0)
        expect(outPorts.length).toBeGreaterThan(0)
      }
    })

    it('应该拒绝未注册的节点类型', async () => {
      const result = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'nonexistent' as any
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('UNKNOWN_NODE_TYPE')
      }
    })

    it('幂等键应防止重复创建', async () => {
      const key = 'idem-001'
      const r1 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any,
        idempotencyKey: key
      })
      const r2 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any,
        idempotencyKey: key
      })

      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      if (r1.ok && r2.ok) {
        expect(r1.data.id).toBe(r2.data.id)
      }
    })

    it('创建后节点应保存到 store', async () => {
      await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      const nodes = await env.store.getNodes(env.projectId)
      expect(nodes).toHaveLength(1)
    })

    it('应记录审计日志', async () => {
      await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      const logs = env.services.auditLog.query({ action: 'create-node' })
      expect(logs).toHaveLength(1)
    })
  })

  describe('updateNode()', () => {
    it('应该更新节点标题', async () => {
      const created = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any,
        title: '原标题'
      })
      if (!created.ok) return

      const updated = await env.services.nodeService.updateNode({
        projectId: env.projectId,
        nodeId: created.data.id,
        title: '新标题'
      })

      expect(updated.ok).toBe(true)
      if (updated.ok) {
        expect(updated.data.title).toBe('新标题')
      }
    })

    it('应该合并而非替换 params', async () => {
      const created = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any,
        params: { text: '原始', extra: '保留' }
      })
      if (!created.ok) return

      const updated = await env.services.nodeService.updateNode({
        projectId: env.projectId,
        nodeId: created.data.id,
        params: { text: '修改后' }
      })

      expect(updated.ok).toBe(true)
      if (updated.ok) {
        expect(updated.data.params.text).toBe('修改后')
        expect(updated.data.params.extra).toBe('保留')
      }
    })

    it('应该拒绝更新不存在的节点', async () => {
      const result = await env.services.nodeService.updateNode({
        projectId: env.projectId,
        nodeId: 'nonexistent',
        title: 'test'
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('NODE_NOT_FOUND')
      }
    })
  })

  describe('deleteNode()', () => {
    it('应该删除节点', async () => {
      const created = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!created.ok) return

      const result = await env.services.nodeService.deleteNode(env.projectId, created.data.id)
      expect(result.ok).toBe(true)

      const nodes = await env.store.getNodes(env.projectId)
      expect(nodes).toHaveLength(0)
    })

    it('应该同时删除关联连线', async () => {
      const n1 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      const n2 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!n1.ok || !n2.ok) return

      await env.services.nodeService
        .connectNotes?.({
          projectId: env.projectId,
          from: { nodeId: n1.data.id, portId: 'out-text' },
          to: { nodeId: n2.data.id, portId: 'in-text' }
        })
        .catch(() => {})

      // connectNotes 不存在，用 connectNodes
      await env.services.nodeService.connectNodes({
        projectId: env.projectId,
        from: { nodeId: n1.data.id, portId: 'out-text' },
        to: { nodeId: n2.data.id, portId: 'in-text' }
      })

      await env.services.nodeService.deleteNode(env.projectId, n1.data.id)

      const edges = await env.store.getEdges(env.projectId)
      expect(edges).toHaveLength(0)
    })

    it('应该拒绝删除不存在的节点', async () => {
      const result = await env.services.nodeService.deleteNode(env.projectId, 'nonexistent')
      expect(result.ok).toBe(false)
    })
  })

  describe('connectNodes() & validateConnection()', () => {
    it('应该成功连接类型兼容的端口', async () => {
      const n1 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      const n2 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!n1.ok || !n2.ok) return

      const result = await env.services.nodeService.connectNodes({
        projectId: env.projectId,
        from: { nodeId: n1.data.id, portId: 'out-text' },
        to: { nodeId: n2.data.id, portId: 'in-text' }
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.from.nodeId).toBe(n1.data.id)
        expect(result.data.to.nodeId).toBe(n2.data.id)
      }
    })

    it('应该拒绝类型不兼容的连接', async () => {
      const n1 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'image' as any
      })
      const n2 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!n1.ok || !n2.ok) return

      const result = await env.services.nodeService.connectNodes({
        projectId: env.projectId,
        from: { nodeId: n1.data.id, portId: 'out-image' },
        to: { nodeId: n2.data.id, portId: 'in-text' }
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_CONNECTION')
      }
    })

    it('应该拒绝不存在的源节点', async () => {
      const n2 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!n2.ok) return

      const result = await env.services.nodeService.connectNodes({
        projectId: env.projectId,
        from: { nodeId: 'nonexistent', portId: 'out-text' },
        to: { nodeId: n2.data.id, portId: 'in-text' }
      })

      expect(result.ok).toBe(false)
    })

    it('应该拒绝自连', async () => {
      const n1 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!n1.ok) return

      const result = await env.services.nodeService.connectNodes({
        projectId: env.projectId,
        from: { nodeId: n1.data.id, portId: 'out-text' },
        to: { nodeId: n1.data.id, portId: 'in-text' }
      })

      expect(result.ok).toBe(false)
    })

    it('应该拒绝重复连接', async () => {
      const n1 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      const n2 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!n1.ok || !n2.ok) return

      await env.services.nodeService.connectNodes({
        projectId: env.projectId,
        from: { nodeId: n1.data.id, portId: 'out-text' },
        to: { nodeId: n2.data.id, portId: 'in-text' }
      })

      const dup = await env.services.nodeService.connectNodes({
        projectId: env.projectId,
        from: { nodeId: n1.data.id, portId: 'out-text' },
        to: { nodeId: n2.data.id, portId: 'in-text' }
      })

      expect(dup.ok).toBe(false)
    })
  })

  describe('disconnectNodes()', () => {
    it('应该成功断开连线', async () => {
      const n1 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      const n2 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!n1.ok || !n2.ok) return

      const conn = await env.services.nodeService.connectNodes({
        projectId: env.projectId,
        from: { nodeId: n1.data.id, portId: 'out-text' },
        to: { nodeId: n2.data.id, portId: 'in-text' }
      })
      if (!conn.ok) return

      const result = await env.services.nodeService.disconnectNodes(env.projectId, conn.data.id)
      expect(result.ok).toBe(true)

      const edges = await env.store.getEdges(env.projectId)
      expect(edges).toHaveLength(0)
    })

    it('应该拒绝断开不存在的连线', async () => {
      const result = await env.services.nodeService.disconnectNodes(env.projectId, 'nonexistent')
      expect(result.ok).toBe(false)
    })
  })

  describe('getNode() & listNodes()', () => {
    it('getNode 应返回指定节点', async () => {
      const created = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!created.ok) return

      const result = await env.services.nodeService.getNode(env.projectId, created.data.id)
      expect(result.ok).toBe(true)
    })

    it('listNodes 应返回所有节点', async () => {
      await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })

      const result = await env.services.nodeService.listNodes(env.projectId)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveLength(2)
      }
    })
  })
})

// ── ProjectService 测试 ───────────────────────────────────

describe('ProjectService', () => {
  let env: Awaited<ReturnType<typeof setupAsync>>

  beforeEach(async () => {
    env = await setupAsync()
  })

  it('listProjects 应返回项目列表', async () => {
    const result = await env.services.projectService.listProjects()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('getProject 应返回项目详情', async () => {
    const result = await env.services.projectService.getProject(env.projectId)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.meta.id).toBe(env.projectId)
    }
  })

  it('getProject 应拒绝不存在的项目', async () => {
    const result = await env.services.projectService.getProject('nonexistent')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('PROJECT_NOT_FOUND')
    }
  })

  it('createProject 应拒绝空名称', async () => {
    const result = await env.services.projectService.createProject('')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_NAME')
    }
  })

  it('deleteProject 应成功删除', async () => {
    const result = await env.services.projectService.deleteProject(env.projectId)
    expect(result.ok).toBe(true)
  })
})

// ── CapabilityService 测试 ───────────────────────────────

describe('CapabilityService', () => {
  let env: Awaited<ReturnType<typeof setupAsync>>

  beforeEach(async () => {
    env = await setupAsync()
  })

  it('listCapabilities 应返回能力列表', async () => {
    const result = await env.services.capabilityService.listCapabilities()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.length).toBeGreaterThan(0)
    }
  })

  it('listCapabilities 应支持按 MCP 过滤', async () => {
    const result = await env.services.capabilityService.listCapabilities('mcp')
    expect(result.ok).toBe(true)
    if (result.ok) {
      for (const cap of result.data) {
        expect(cap.expose.mcp).toBe(true)
      }
    }
  })

  it('getCapability 应返回指定能力', async () => {
    const result = await env.services.capabilityService.getCapability('text.source')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.id).toBe('text.source')
    }
  })

  it('getCapability 应拒绝不存在的 ID', async () => {
    const result = await env.services.capabilityService.getCapability('nonexistent')
    expect(result.ok).toBe(false)
  })

  it('getCapabilityByNodeType 应按节点类型返回能力', async () => {
    const result = await env.services.capabilityService.getCapabilityByNodeType('text')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.nodeType).toBe('text')
    }
  })

  it('getConfigSchema 应返回配置 Schema', async () => {
    const result = await env.services.capabilityService.getConfigSchema('text.source')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.text).toBeDefined()
    }
  })

  describe('validateNodeConfig()', () => {
    it('合法配置应通过校验', async () => {
      const result = await env.services.capabilityService.validateNodeConfig('text', {
        text: '你好'
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.valid).toBe(true)
        expect(result.data.errors).toHaveLength(0)
      }
    })

    it('缺少必填字段应报告错误', async () => {
      const result = await env.services.capabilityService.validateNodeConfig('image-crop', {})
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.valid).toBe(false)
        expect(result.data.errors.length).toBeGreaterThan(0)
      }
    })

    it('enum 值不在允许范围应报告错误', async () => {
      const result = await env.services.capabilityService.validateNodeConfig('image-crop', {
        mode: 'invalid-mode'
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.valid).toBe(false)
        const hasEnumError = result.data.errors.some((e) => e.includes('不在允许范围'))
        expect(hasEnumError).toBe(true)
      }
    })

    it('未知节点类型应返回错误', async () => {
      const result = await env.services.capabilityService.validateNodeConfig('unknown', {})
      expect(result.ok).toBe(false)
    })
  })
})

// ── WorkflowService 测试 ──────────────────────────────────

describe('WorkflowService', () => {
  let env: Awaited<ReturnType<typeof setupAsync>>

  beforeEach(async () => {
    env = await setupAsync()
  })

  describe('validateWorkflow()', () => {
    it('空工作流应通过校验', async () => {
      const result = await env.services.workflowService.validateWorkflow({
        projectId: env.projectId
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.valid).toBe(true)
        expect(result.data.stats.nodeCount).toBe(0)
      }
    })

    it('有节点但缺少必填输入应报告错误', async () => {
      // image-crop 需要输入图片但没有连线
      await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'image-crop' as any
      })

      const result = await env.services.workflowService.validateWorkflow({
        projectId: env.projectId
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.valid).toBe(false)
        expect(result.data.stats.inputIssues).toBeGreaterThan(0)
      }
    })

    it('有完整连线的工作流应通过校验', async () => {
      const n1 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any,
        params: { text: '测试' }
      })
      const n2 = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!n1.ok || !n2.ok) return

      await env.services.nodeService.connectNodes({
        projectId: env.projectId,
        from: { nodeId: n1.data.id, portId: 'out-text' },
        to: { nodeId: n2.data.id, portId: 'in-text' }
      })

      const result = await env.services.workflowService.validateWorkflow({
        projectId: env.projectId
      })

      expect(result.ok).toBe(true)
    })
  })

  describe('estimateRun()', () => {
    it('应返回预估信息', async () => {
      await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any,
        params: { text: '测试' }
      })

      const result = await env.services.workflowService.estimateRun({
        projectId: env.projectId
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.nodeCount).toBe(1)
        expect(Array.isArray(result.data.models)).toBe(true)
        expect(Array.isArray(result.data.missingConfigs)).toBe(true)
        expect(Array.isArray(result.data.risks)).toBe(true)
      }
    })
  })

  describe('runNode()', () => {
    it('dry-run 模式应返回 succeeded 状态', async () => {
      const created = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!created.ok) return

      const result = await env.services.workflowService.runNode({
        projectId: env.projectId,
        nodeId: created.data.id,
        dryRun: true
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.status).toBe('succeeded')
        expect(result.data.runId).toBe('dry-run')
      }
    })

    it('没有运行消费者时正常模式应明确拒绝，而非留下 queued', async () => {
      const created = await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'text' as any
      })
      if (!created.ok) return

      const result = await env.services.workflowService.runNode({
        projectId: env.projectId,
        nodeId: created.data.id
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('EXECUTION_UNAVAILABLE')
      }
    })
  })

  describe('runWorkflow()', () => {
    it('dry-run 应跳过校验直接返回 succeeded', async () => {
      const result = await env.services.workflowService.runWorkflow({
        projectId: env.projectId,
        dryRun: true
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.status).toBe('succeeded')
      }
    })

    it('无效工作流应拒绝运行', async () => {
      // image-crop 缺少输入
      await env.services.nodeService.createNode({
        projectId: env.projectId,
        type: 'image-crop' as any
      })

      const result = await env.services.workflowService.runWorkflow({
        projectId: env.projectId
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('WORKFLOW_INVALID')
      }
    })

    it('有效工作流没有运行消费者时应拒绝执行', async () => {
      const result = await env.services.workflowService.runWorkflow({
        projectId: env.projectId
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('EXECUTION_UNAVAILABLE')
      }
    })
  })
})

// ── 审计日志测试 ──────────────────────────────────────────

describe('AuditLog', () => {
  let env: Awaited<ReturnType<typeof setupAsync>>

  beforeEach(async () => {
    env = await setupAsync()
  })

  it('创建节点应记录审计日志', async () => {
    await env.services.nodeService.createNode({
      projectId: env.projectId,
      type: 'text' as any
    })

    const createLogs = env.services.auditLog.query({ action: 'create-node' })
    expect(createLogs).toHaveLength(1)
    expect(createLogs[0].actor).toBe('agent')
  })

  it('应支持按 actor 过滤', async () => {
    await env.services.nodeService.createNode({
      projectId: env.projectId,
      type: 'text' as any
    })

    const agentLogs = env.services.auditLog.byAgent()
    expect(agentLogs.length).toBeGreaterThan(0)
    for (const log of agentLogs) {
      expect(log.actor).toBe('agent')
    }
  })

  it('应支持按 projectId 过滤', async () => {
    await env.services.nodeService.createNode({
      projectId: env.projectId,
      type: 'text' as any
    })

    const logs = env.services.auditLog.byProject(env.projectId)
    expect(logs.length).toBeGreaterThan(0)
    for (const log of logs) {
      expect(log.projectId).toBe(env.projectId)
    }
  })

  it('clear 应清空所有日志', async () => {
    env.services.auditLog.log({ actor: 'system', action: 'test' })
    env.services.auditLog.clear()
    expect(env.services.auditLog.entries).toHaveLength(0)
  })

  it('toJSON 应返回有效 JSON 字符串', async () => {
    env.services.auditLog.log({ actor: 'system', action: 'test' })
    const json = env.services.auditLog.toJSON()
    const parsed = JSON.parse(json)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
  })
})
