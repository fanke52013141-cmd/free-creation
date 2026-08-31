/**
 * WorkflowService — 工作流校验、执行预估与运行管理
 *
 * 提供工作流级别的操作：校验整个流程、估算运行成本、管理运行状态。
 * 实际的节点执行由 ExecutionService 负责（当前阶段委托给渲染进程的引擎）。
 */

import { nanoid } from 'nanoid'
import type { CanvasNode, CanvasEdge } from '@shared/types'
import { getCapabilityByNodeType } from '@capabilities'
import { isPortTypeCompatible } from './node-service'
import type {
  Result,
  ServiceContext,
  ValidateWorkflowRequest,
  WorkflowValidationResult,
  RunEstimate,
  RunHandle,
  RunWorkflowRequest,
  RunNodeRequest
} from '../types'
import { ok, fail } from '../types'
import type { ConfigFieldSchema } from '@capabilities/types'

export class WorkflowService {
  constructor(private ctx: ServiceContext) {}

  // ── 校验 ──────────────────────────────────────────────────

  async validateWorkflow(req: ValidateWorkflowRequest): Promise<Result<WorkflowValidationResult>> {
    const allNodes = await this.ctx.store.getNodes(req.projectId)
    const allEdges = await this.ctx.store.getEdges(req.projectId)

    // 筛选范围
    const nodes = req.nodeIds
      ? allNodes.filter((n) => req.nodeIds!.includes(n.id))
      : allNodes

    const nodeIds = new Set(nodes.map((n) => n.id))
    const edges = allEdges.filter(
      (e) => nodeIds.has(e.from.nodeId) && nodeIds.has(e.to.nodeId)
    )

    const errors: WorkflowValidationResult['errors'] = []
    let inputIssues = 0
    let connectionIssues = 0

    // 1. 检查每个节点的必填输入端口
    for (const node of nodes) {
      const cap = getCapabilityByNodeType(node.type)
      if (!cap) {
        errors.push({
          nodeId: node.id,
          message: `未注册的节点类型: ${node.type}`,
          severity: 'error'
        })
        continue
      }

      for (const inputPort of cap.inputs) {
        if (!inputPort.required) continue

        const hasInput = edges.some(
          (e) => e.to.nodeId === node.id && e.to.portId === inputPort.id
        )

        // 检查节点自身是否有内容（如文本节点的 text 参数）
        const hasInlineContent = node.params && Object.keys(node.params).length > 0

        if (!hasInput && !hasInlineContent) {
          inputIssues++
          errors.push({
            nodeId: node.id,
            portId: inputPort.id,
            message: `缺少必填输入: ${inputPort.name}`,
            severity: 'error'
          })
        }
      }
    }

    // 2. 检查连线类型兼容性
    for (const edge of edges) {
      const fromNode = allNodes.find((n) => n.id === edge.from.nodeId)
      const toNode = allNodes.find((n) => n.id === edge.to.nodeId)
      if (!fromNode || !toNode) {
        connectionIssues++
        errors.push({
          message: `连线 ${edge.id} 引用了不存在的节点`,
          severity: 'error'
        })
        continue
      }

      const fromPort = fromNode.ports.find((p) => p.id === edge.from.portId)
      const toPort = toNode.ports.find((p) => p.id === edge.to.portId)
      if (!fromPort || !toPort) {
        connectionIssues++
        errors.push({
          message: `连线 ${edge.id} 引用了不存在的端口`,
          severity: 'error'
        })
        continue
      }

      if (!isPortTypeCompatible(fromPort.type, toPort.type)) {
        connectionIssues++
        errors.push({
          nodeId: toNode.id,
          message: `类型不兼容: ${fromPort.type} → ${toPort.type}`,
          severity: 'error'
        })
      }
    }

    // 3. 检测环路（简化版——依赖拓扑排序是否能完成）
    const hasCycle = detectCycle(nodes, edges)
    if (hasCycle) {
      errors.push({
        message: '工作流中存在环路',
        severity: 'error'
      })
    }

    return ok({
      valid: errors.filter((e) => e.severity === 'error').length === 0,
      errors,
      stats: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        inputIssues,
        connectionIssues
      }
    })
  }

  // ── 运行预估 ─────────────────────────────────────────────

  async estimateRun(req: RunWorkflowRequest): Promise<Result<RunEstimate>> {
    const nodes = await this.ctx.store.getNodes(req.projectId)

    // 确定执行范围
    let scopeNodes: CanvasNode[]
    if (req.nodeIds) {
      scopeNodes = nodes.filter((n) => req.nodeIds!.includes(n.id))
    } else if (req.toNodeId) {
      // 包含目标节点及其所有上游
      const allUpstream = collectUpstream(req.toNodeId, nodes, await this.ctx.store.getEdges(req.projectId))
      scopeNodes = nodes.filter((n) => allUpstream.has(n.id))
    } else {
      scopeNodes = nodes
    }

    const models: RunEstimate['models'] = []
    const missingConfigs: RunEstimate['missingConfigs'] = []
    const risks: string[] = []

    for (const node of scopeNodes) {
      const cap = getCapabilityByNodeType(node.type)
      if (!cap) continue

      // 收集模型调用信息
      const providerId = node.params?.providerId as string | undefined
      const modelId = node.params?.modelId as string | undefined
      if (providerId && modelId) {
        models.push({ providerId, modelId, nodeId: node.id })
      }

      // 检查必填配置
      const missing: string[] = []
      for (const [key, field] of Object.entries(cap.configSchema) as Array<[string, ConfigFieldSchema]>) {
        if (field.required && !node.params?.[key]) {
          missing.push(key)
        }
      }
      if (missing.length > 0) {
        missingConfigs.push({ nodeId: node.id, fields: missing })
      }

      // 风险提示
      if (cap.runtime.batch) {
        risks.push(`节点 ${node.title} (${cap.id}) 支持批量执行，可能产生多份结果`)
      }
    }

    if (models.length === 0 && scopeNodes.length > 0) {
      risks.push('当前选中的节点不需要调用外部模型')
    }

    return ok({
      nodeCount: scopeNodes.length,
      models,
      missingConfigs,
      risks
    })
  }

  // ── 运行管理 ─────────────────────────────────────────────

  async runNode(req: RunNodeRequest): Promise<Result<RunHandle>> {
    if (req.dryRun) {
      const estimate = await this.estimateRun({
        projectId: req.projectId,
        nodeIds: [req.nodeId],
        dryRun: true
      })
      if (!estimate.ok) return estimate as any
      return ok({
        runId: 'dry-run',
        status: 'completed',
        scope: { type: 'node', nodeIds: [req.nodeId] },
        startedAt: Date.now()
      })
    }

    // 创建运行句柄（实际执行委托给执行引擎）
    const runId = nanoid(12)
    const handle: RunHandle = {
      runId,
      status: 'queued',
      scope: { type: 'node', nodeIds: [req.nodeId] },
      startedAt: Date.now()
    }

    this.ctx.audit.log({
      actor: 'agent',
      action: 'run-node',
      projectId: req.projectId,
      entityId: req.nodeId,
      after: { runId }
    })

    // 当前阶段：返回排队状态
    // 实际执行需要通过桌面端引擎或未来的 headless 执行器完成
    return ok(handle)
  }

  async runWorkflow(req: RunWorkflowRequest): Promise<Result<RunHandle>> {
    if (req.dryRun) {
      const estimate = await this.estimateRun(req)
      if (!estimate.ok) return estimate as any
      return ok({
        runId: 'dry-run',
        status: 'completed',
        scope: { type: 'workflow', nodeIds: req.nodeIds },
        startedAt: Date.now()
      })
    }

    // 先校验
    const validation = await this.validateWorkflow({
      projectId: req.projectId,
      nodeIds: req.nodeIds
    })
    if (!validation.ok) return validation as any
    if (!validation.data.valid) {
      return fail(
        'WORKFLOW_INVALID',
        '工作流校验未通过',
        { errors: validation.data.errors }
      )
    }

    const runId = nanoid(12)
    const handle: RunHandle = {
      runId,
      status: 'queued',
      scope: {
        type: req.nodeIds ? 'selection' : 'workflow',
        nodeIds: req.nodeIds
      },
      startedAt: Date.now()
    }

    this.ctx.audit.log({
      actor: 'agent',
      action: 'run-workflow',
      projectId: req.projectId,
      after: { runId, scope: handle.scope }
    })

    return ok(handle)
  }
}

// ── 辅助函数 ───────────────────────────────────────────────

function detectCycle(nodes: CanvasNode[], edges: CanvasEdge[]): boolean {
  const nodeIds = new Set(nodes.map((n) => n.id))
  const adjacency = new Map<string, string[]>()
  const visited = new Set<string>() // 0 = unvisited, 1 = in-progress
  const recursionStack = new Set<string>()

  for (const edge of edges) {
    if (!nodeIds.has(edge.from.nodeId) || !nodeIds.has(edge.to.nodeId)) continue
    const list = adjacency.get(edge.from.nodeId) ?? []
    list.push(edge.to.nodeId)
    adjacency.set(edge.from.nodeId, list)
  }

  function dfs(nodeId: string): boolean {
    visited.add(nodeId)
    recursionStack.add(nodeId)

    for (const neighbor of adjacency.get(nodeId) ?? []) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true
      } else if (recursionStack.has(neighbor)) {
        return true
      }
    }

    recursionStack.delete(nodeId)
    return false
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      if (dfs(node.id)) return true
    }
  }

  return false
}

function collectUpstream(
  nodeId: string,
  _nodes: CanvasNode[],
  edges: CanvasEdge[]
): Set<string> {
  const result = new Set<string>([nodeId])
  const queue = [nodeId]

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const edge of edges) {
      if (edge.to.nodeId === current && !result.has(edge.from.nodeId)) {
        result.add(edge.from.nodeId)
        queue.push(edge.from.nodeId)
      }
    }
  }

  return result
}
