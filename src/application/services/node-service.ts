/**
 * NodeService — 节点 CRUD 与连线管理
 *
 * 所有节点和连线操作都通过此服务进行。
 * 桌面端、CLI 和 MCP 调用同一套方法，保证行为一致。
 */

import { nanoid } from 'nanoid'
import type { CanvasNode, CanvasEdge, PortDecl, NodeTypeId } from '@shared/types'
import { GraphVersionConflictError } from '@shared/graph-snapshot-sync'
import { getCapabilityByNodeType } from '@capabilities'
import type {
  Result,
  ServiceContext,
  CreateNodeRequest,
  UpdateNodeRequest,
  ConnectNodesRequest,
  ConnectionValidation
} from '../types'
import { ok, fail } from '../types'
import { requireWrite } from './authorization'

// ── 幂等性缓存 ─────────────────────────────────────────────

const idempotencyCache = new Map<string, Result<CanvasNode | CanvasEdge>>()

function scopedIdempotencyKey(
  operation: 'create-node' | 'update-node' | 'connect',
  projectId: string,
  key: string
): string {
  return `${operation}:${projectId}:${key}`
}

// ── ID 与错误映射 ──────────────────────────────────────────

/**
 * 节点/连线 id 直接采用 tldraw shape id 形态，与画布侧 deriveGraph 产出的
 * id 同源：Agent 写入、快照同步、画布回读全程稳定，避免同一实体出现两套 id。
 */
function newShapeId(): string {
  return `shape:${nanoid(10)}`
}

/** 把 store 层抛出的保存错误映射为结构化 Result，调用方无需 try/catch。 */
function saveError(
  error: unknown,
  expectedGraphVersion?: number
): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof GraphVersionConflictError) {
    return {
      code: 'REVISION_CONFLICT',
      message: '项目已被其他操作更新，请重新读取后再试',
      details: {
        expectedGraphVersion: expectedGraphVersion ?? error.expectedVersion,
        actualGraphVersion: error.actualVersion
      }
    }
  }
  return {
    code: 'SAVE_FAILED',
    message: `项目保存失败: ${error instanceof Error ? error.message : String(error)}`
  }
}

export class NodeService {
  constructor(private ctx: ServiceContext) {}

  // ── 节点 CRUD ────────────────────────────────────────────

  async createNode(req: CreateNodeRequest): Promise<Result<CanvasNode>> {
    const capability = getCapabilityByNodeType(req.type)
    if (!capability) {
      return fail('UNKNOWN_NODE_TYPE', `未注册的节点类型: ${req.type}`)
    }
    const denied = requireWrite(this.ctx, capability.id)
    if (denied) return fail('WRITE_DISABLED', denied)

    // 幂等性检查
    if (req.idempotencyKey) {
      const cached = idempotencyCache.get(
        scopedIdempotencyKey('create-node', req.projectId, req.idempotencyKey)
      )
      if (cached) return cached as Result<CanvasNode>
    }

    // 从能力注册表获取端口定义
    const cap = capability

    // 构建端口声明
    const ports: PortDecl[] = [
      ...cap.inputs.map((p) => ({
        id: p.id,
        name: p.name,
        dir: 'in' as const,
        type: p.type,
        required: p.required,
        cardinality: p.cardinality,
        description: p.description
      })),
      ...cap.outputs.map((p) => ({
        id: p.id,
        name: p.name,
        dir: 'out' as const,
        type: p.type,
        required: p.required,
        cardinality: p.cardinality,
        description: p.description
      }))
    ]

    // 创建节点
    const node: CanvasNode = {
      id: newShapeId(),
      type: req.type as NodeTypeId,
      contractVersion: cap.contractVersion,
      title: req.title ?? cap.title,
      x: req.x ?? 0,
      y: req.y ?? 0,
      w: 320,
      h: 200,
      ports,
      params: req.params ?? {},
      content: { kind: 'empty' },
      exec: { status: 'idle' },
      meta: {
        source: 'input',
        createdAt: Date.now()
      }
    }

    // 保存到项目
    const project = await this.ctx.store.getProject(req.projectId)
    if (!project) return fail('PROJECT_NOT_FOUND', `项目不存在: ${req.projectId}`)
    if (
      req.expectedGraphVersion !== undefined &&
      project.meta.graphVersion !== req.expectedGraphVersion
    ) {
      return fail('REVISION_CONFLICT', '项目已被其他操作更新，请重新读取后再试', {
        expectedGraphVersion: req.expectedGraphVersion,
        actualGraphVersion: project.meta.graphVersion
      })
    }
    const nodes = await this.ctx.store.getNodes(req.projectId)
    const edges = await this.ctx.store.getEdges(req.projectId)
    const groups = await this.ctx.store.getGroups(req.projectId)
    nodes.push(node)
    try {
      await this.ctx.store.saveGraph(
        req.projectId,
        { nodes, edges, groups },
        {
          expectedGraphVersion: req.expectedGraphVersion
        }
      )
    } catch (error) {
      const mapped = saveError(error, req.expectedGraphVersion)
      return fail(mapped.code, mapped.message, mapped.details)
    }

    this.ctx.audit.log({
      actor: this.ctx.actor,
      action: 'create-node',
      projectId: req.projectId,
      entityId: node.id,
      after: { type: node.type, title: node.title }
    })

    const result = ok(node)

    // 缓存幂等结果
    if (req.idempotencyKey) {
      idempotencyCache.set(
        scopedIdempotencyKey('create-node', req.projectId, req.idempotencyKey),
        result
      )
    }

    return result
  }

  async updateNode(req: UpdateNodeRequest): Promise<Result<CanvasNode>> {
    const permissionError = requireWrite(this.ctx)
    if (permissionError) return fail('WRITE_DISABLED', permissionError)
    if (req.idempotencyKey) {
      const cached = idempotencyCache.get(
        scopedIdempotencyKey('update-node', req.projectId, req.idempotencyKey)
      )
      if (cached) return cached as Result<CanvasNode>
    }
    const project = await this.ctx.store.getProject(req.projectId)
    if (!project) return fail('PROJECT_NOT_FOUND', `项目不存在: ${req.projectId}`)
    if (
      req.expectedGraphVersion !== undefined &&
      project.meta.graphVersion !== req.expectedGraphVersion
    ) {
      return fail('REVISION_CONFLICT', '项目已被其他操作更新，请重新读取后再试')
    }
    const nodes = await this.ctx.store.getNodes(req.projectId)
    const node = nodes.find((n) => n.id === req.nodeId)
    if (!node) {
      return fail('NODE_NOT_FOUND', `节点不存在: ${req.nodeId}`, { entityId: req.nodeId })
    }

    const before = { ...node }

    if (req.title !== undefined) node.title = req.title
    if (req.params !== undefined) {
      node.params = { ...node.params, ...req.params }
    }
    if (req.position) {
      node.x = req.position.x
      node.y = req.position.y
    }

    const edges = await this.ctx.store.getEdges(req.projectId)
    const groups = await this.ctx.store.getGroups(req.projectId)
    try {
      await this.ctx.store.saveGraph(
        req.projectId,
        { nodes, edges, groups },
        {
          expectedGraphVersion: req.expectedGraphVersion
        }
      )
    } catch (error) {
      const mapped = saveError(error, req.expectedGraphVersion)
      return fail(mapped.code, mapped.message, mapped.details)
    }

    this.ctx.audit.log({
      actor: this.ctx.actor,
      action: 'update-node',
      projectId: req.projectId,
      entityId: node.id,
      before,
      after: { title: node.title, params: node.params }
    })

    const result = ok(node)
    if (req.idempotencyKey) {
      idempotencyCache.set(
        scopedIdempotencyKey('update-node', req.projectId, req.idempotencyKey),
        result
      )
    }
    return result
  }

  async deleteNode(projectId: string, nodeId: string): Promise<Result<boolean>> {
    const permissionError = requireWrite(this.ctx)
    if (permissionError) return fail('WRITE_DISABLED', permissionError)
    const nodes = await this.ctx.store.getNodes(projectId)
    const idx = nodes.findIndex((n) => n.id === nodeId)
    if (idx === -1) {
      return fail('NODE_NOT_FOUND', `节点不存在: ${nodeId}`, { entityId: nodeId })
    }

    const removed = nodes[idx]
    nodes.splice(idx, 1)

    // 同时删除关联的连线
    const edges = await this.ctx.store.getEdges(projectId)
    const filteredEdges = edges.filter((e) => e.from.nodeId !== nodeId && e.to.nodeId !== nodeId)

    const groups = await this.ctx.store.getGroups(projectId)
    try {
      await this.ctx.store.saveGraph(projectId, { nodes, edges: filteredEdges, groups })
    } catch (error) {
      const mapped = saveError(error)
      return fail(mapped.code, mapped.message, mapped.details)
    }

    this.ctx.audit.log({
      actor: this.ctx.actor,
      action: 'delete-node',
      projectId,
      entityId: nodeId,
      before: removed
    })

    return ok(true)
  }

  async getNode(projectId: string, nodeId: string): Promise<Result<CanvasNode>> {
    const nodes = await this.ctx.store.getNodes(projectId)
    const node = nodes.find((n) => n.id === nodeId)
    if (!node) {
      return fail('NODE_NOT_FOUND', `节点不存在: ${nodeId}`, { entityId: nodeId })
    }
    return ok(node)
  }

  async listNodes(projectId: string): Promise<Result<CanvasNode[]>> {
    const nodes = await this.ctx.store.getNodes(projectId)
    return ok(nodes)
  }

  // ── 连线管理 ─────────────────────────────────────────────

  async connectNodes(req: ConnectNodesRequest): Promise<Result<CanvasEdge>> {
    const permissionError = requireWrite(this.ctx)
    if (permissionError) return fail('WRITE_DISABLED', permissionError)
    // 幂等性检查
    if (req.idempotencyKey) {
      const cached = idempotencyCache.get(
        scopedIdempotencyKey('connect', req.projectId, req.idempotencyKey)
      )
      if (cached) return cached as Result<CanvasEdge>
    }

    // 校验连接
    const validation = await this.validateConnection(req)
    if (!validation.valid) {
      return fail('INVALID_CONNECTION', validation.errors.join('; '))
    }

    const edge: CanvasEdge = {
      id: newShapeId(),
      from: req.from,
      to: req.to
    }

    const nodes = await this.ctx.store.getNodes(req.projectId)
    const edges = await this.ctx.store.getEdges(req.projectId)
    const groups = await this.ctx.store.getGroups(req.projectId)
    edges.push(edge)
    try {
      await this.ctx.store.saveGraph(
        req.projectId,
        { nodes, edges, groups },
        {
          expectedGraphVersion: req.expectedGraphVersion
        }
      )
    } catch (error) {
      const mapped = saveError(error, req.expectedGraphVersion)
      return fail(mapped.code, mapped.message, mapped.details)
    }

    this.ctx.audit.log({
      actor: this.ctx.actor,
      action: 'connect',
      projectId: req.projectId,
      entityId: edge.id,
      after: edge
    })

    const result = ok(edge)
    if (req.idempotencyKey) {
      idempotencyCache.set(
        scopedIdempotencyKey('connect', req.projectId, req.idempotencyKey),
        result
      )
    }

    return result
  }

  async disconnectNodes(projectId: string, edgeId: string): Promise<Result<boolean>> {
    const permissionError = requireWrite(this.ctx)
    if (permissionError) return fail('WRITE_DISABLED', permissionError)
    const edges = await this.ctx.store.getEdges(projectId)
    const idx = edges.findIndex((e) => e.id === edgeId)
    if (idx === -1) {
      return fail('EDGE_NOT_FOUND', `连线不存在: ${edgeId}`, { entityId: edgeId })
    }

    const removed = edges[idx]
    edges.splice(idx, 1)

    const nodes = await this.ctx.store.getNodes(projectId)
    const groups = await this.ctx.store.getGroups(projectId)
    try {
      await this.ctx.store.saveGraph(projectId, { nodes, edges, groups })
    } catch (error) {
      const mapped = saveError(error)
      return fail(mapped.code, mapped.message, mapped.details)
    }

    this.ctx.audit.log({
      actor: this.ctx.actor,
      action: 'disconnect',
      projectId,
      entityId: edgeId,
      before: removed
    })

    return ok(true)
  }

  async listEdges(projectId: string): Promise<Result<CanvasEdge[]>> {
    const edges = await this.ctx.store.getEdges(projectId)
    return ok(edges)
  }

  // ── 校验 ──────────────────────────────────────────────────

  async validateConnection(req: ConnectNodesRequest): Promise<ConnectionValidation> {
    const nodes = await this.ctx.store.getNodes(req.projectId)

    const fromNode = nodes.find((n) => n.id === req.from.nodeId)
    const toNode = nodes.find((n) => n.id === req.to.nodeId)

    if (!fromNode) {
      return { valid: false, errors: [`源节点不存在: ${req.from.nodeId}`] }
    }
    if (!toNode) {
      return { valid: false, errors: [`目标节点不存在: ${req.to.nodeId}`] }
    }

    const fromPort = fromNode.ports.find((p) => p.id === req.from.portId && p.dir === 'out')
    const toPort = toNode.ports.find((p) => p.id === req.to.portId && p.dir === 'in')

    if (!fromPort) {
      return { valid: false, errors: [`源端口不存在: ${req.from.portId}`] }
    }
    if (!toPort) {
      return { valid: false, errors: [`目标端口不存在: ${req.to.portId}`] }
    }

    // 类型兼容性检查
    if (!isPortTypeCompatible(fromPort.type, toPort.type)) {
      return {
        valid: false,
        errors: [`端口类型不兼容: ${fromPort.type} → ${toPort.type}`],
        fromType: fromPort.type,
        toType: toPort.type
      }
    }

    // 不能自连
    if (req.from.nodeId === req.to.nodeId) {
      return { valid: false, errors: ['不能连接到自身'] }
    }

    // 检查是否已存在相同连接
    const edges = await this.ctx.store.getEdges(req.projectId)
    const duplicate = edges.find(
      (e) =>
        e.from.nodeId === req.from.nodeId &&
        e.from.portId === req.from.portId &&
        e.to.nodeId === req.to.nodeId &&
        e.to.portId === req.to.portId
    )
    if (duplicate) {
      return { valid: false, errors: ['连接已存在'] }
    }

    // cardinality 检查：如果目标端口是 one 且已有连接
    if (toPort.cardinality === 'one') {
      const existing = edges.find(
        (e) => e.to.nodeId === req.to.nodeId && e.to.portId === req.to.portId
      )
      if (existing) {
        return {
          valid: false,
          errors: [`目标端口 ${toPort.name} 只接受单个连接，且已有连接`],
          fromType: fromPort.type,
          toType: toPort.type
        }
      }
    }

    return {
      valid: true,
      errors: [],
      fromType: fromPort.type,
      toType: toPort.type
    }
  }
}

// ── 端口类型兼容性矩阵 ────────────────────────────────────

export function isPortTypeCompatible(from: string, to: string): boolean {
  if (from === to) return true
  if (to === 'any') return true
  if (from === 'any') return true
  // text 和 markdown 互通
  if ((from === 'text' && to === 'markdown') || (from === 'markdown' && to === 'text')) return true
  return false
}
