/**
 * WorkflowService — 工作流校验、执行预估与运行管理
 *
 * 提供工作流级别的操作：校验整个流程、估算运行成本、管理运行状态。
 * 运行记录通过 RunService 落盘，不再返回假 queued。
 * manual-publish 节点（agentRunnable: false）会被明确拒绝。
 */

import type { CanvasNode, CanvasEdge } from '@shared/types'
import { nanoid } from 'nanoid'
import { getCapabilityByNodeType, isAgentRunnable } from '@capabilities'
import { nodeSchemasCompatible } from '@shared/node-schemas'
import { isPortTypeCompatible } from './node-service'
import type {
  Result,
  ServiceContext,
  ValidateWorkflowRequest,
  WorkflowValidationResult,
  RunEstimate,
  RunHandle,
  RunRecord,
  RunWorkflowRequest,
  RunNodeRequest
} from '../types'
import { ok, fail } from '../types'
import { requireExecution } from './authorization'
import type { ConfigFieldSchema } from '@capabilities/types'

export class WorkflowService {
  constructor(private ctx: ServiceContext) {}

  /** 返回可供 Agent 读取的持久化运行记录。 */
  async getRun(runId: string): Promise<Result<RunRecord>> {
    return this.ctx.store
      .getRun(runId)
      .then((record) => (record ? ok(record) : fail('RUN_NOT_FOUND', `运行不存在: ${runId}`)))
  }

  /** 按项目读取运行历史；只暴露项目内的结构化状态，不泄露供应商密钥或路径。 */
  async listRuns(
    projectId: string,
    filter?: { status?: RunRecord['status'] }
  ): Promise<Result<RunRecord[]>> {
    return ok(await this.ctx.store.listRuns(projectId, filter))
  }

  /**
   * 取消由 headless consumer 接受的运行。不能中断的供应商原子调用完成后会丢弃
   * 结果，不会把已取消运行的输出写入画布。
   */
  async cancelRun(runId: string): Promise<Result<RunRecord>> {
    const current = await this.ctx.store.getRun(runId)
    if (!current) return fail('RUN_NOT_FOUND', `运行不存在: ${runId}`)
    if (current.status !== 'queued' && current.status !== 'running') {
      return fail('RUN_NOT_CANCELLABLE', `运行 ${runId} 当前状态 ${current.status} 不可取消`)
    }
    const permissionError = requireExecution(this.ctx)
    if (permissionError) return fail('EXECUTION_DISABLED', permissionError)
    if (!this.ctx.cancelRun) {
      return fail('CANCELLATION_UNAVAILABLE', '当前入口未接入可取消的无界面运行消费者')
    }
    const accepted = await this.ctx.cancelRun(runId)
    if (!accepted) {
      return fail('RUN_NOT_CANCELLABLE', `运行 ${runId} 已结束或取消请求未被执行器接受`)
    }
    const cancelled = await this.ctx.store.getRun(runId)
    if (!cancelled) return fail('RUN_NOT_FOUND', `运行不存在: ${runId}`)
    return ok(cancelled)
  }

  /**
   * 基于终态运行的原始 scope 创建一次新的真实运行，再交由同一个 headless consumer
   * 执行；不会把“重试已排队”伪装成已完成。
   */
  async retryRun(runId: string): Promise<Result<RunHandle>> {
    const original = await this.ctx.store.getRun(runId)
    if (!original) return fail('RUN_NOT_FOUND', `运行不存在: ${runId}`)
    if (original.status === 'queued' || original.status === 'running') {
      return fail('RUN_STILL_ACTIVE', `运行 ${runId} 仍在进行中（${original.status}），无法重试`)
    }
    const permissionError = requireExecution(this.ctx)
    if (permissionError) return fail('EXECUTION_DISABLED', permissionError)
    if (!this.ctx.executeRun) return fail('EXECUTION_UNAVAILABLE', '当前入口没有已接入的运行消费者')

    const nodes = await this.ctx.store.getNodes(original.projectId)
    const scopeNodeIds = original.scope.nodeIds ? new Set(original.scope.nodeIds) : null
    const blocked = nodes
      .filter((node) => !scopeNodeIds || scopeNodeIds.has(node.id))
      .map((node) => ({ node, capability: getCapabilityByNodeType(node.type) }))
      .filter(({ capability }) => capability && !isAgentRunnable(capability.runtime))
      .map(({ node, capability }) => `${node.title}（${capability!.id}）`)
    if (blocked.length > 0) {
      return fail(
        'AGENT_NOT_RUNNABLE',
        `原运行范围包含 manual-publish 节点，不能由 Agent 重试：${blocked.join('、')}`
      )
    }

    const retry = await this.ctx.store.createRun({
      runId: nanoidFallback(),
      projectId: original.projectId,
      scope: original.scope,
      status: 'queued',
      actor: this.ctx.actor,
      startedAt: Date.now()
    })
    await this.ctx.executeRun(retry)
    const completed = await this.ctx.store.getRun(retry.runId)
    return ok(toHandle(completed ?? retry))
  }

  // ── 校验 ──────────────────────────────────────────────────

  async validateWorkflow(req: ValidateWorkflowRequest): Promise<Result<WorkflowValidationResult>> {
    const allNodes = await this.ctx.store.getNodes(req.projectId)
    const allEdges = await this.ctx.store.getEdges(req.projectId)

    // 筛选范围
    const nodes = req.nodeIds ? allNodes.filter((n) => req.nodeIds!.includes(n.id)) : allNodes

    const nodeIds = new Set(nodes.map((n) => n.id))
    const edges = allEdges.filter((e) => nodeIds.has(e.from.nodeId) && nodeIds.has(e.to.nodeId))

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

        const hasInput = edges.some((e) => e.to.nodeId === node.id && e.to.portId === inputPort.id)

        // 只允许明确映射到当前端口的本地值满足必填输入，不能把任意配置误当输入。
        const hasInlineContent = hasInlineInput(node, inputPort.id)

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
      if (
        fromPort.type === 'json' &&
        toPort.type === 'json' &&
        !nodeSchemasCompatible(fromPort.schema, toPort.schema)
      ) {
        connectionIssues++
        errors.push({
          nodeId: toNode.id,
          portId: toPort.id,
          message: `JSON Schema 不兼容: ${schemaLabel(fromPort.schema)} → ${schemaLabel(toPort.schema)}`,
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
      const allUpstream = collectUpstream(
        req.toNodeId,
        nodes,
        await this.ctx.store.getEdges(req.projectId)
      )
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
      for (const [key, field] of Object.entries(cap.configSchema) as Array<
        [string, ConfigFieldSchema]
      >) {
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
      if (!estimate.ok)
        return fail(estimate.error.code, estimate.error.message, estimate.error.details)
      return ok({
        runId: 'dry-run',
        status: 'succeeded',
        scope: { type: 'node', nodeIds: [req.nodeId] },
        startedAt: Date.now()
      })
    }

    const node = (await this.ctx.store.getNodes(req.projectId)).find(
      (item) => item.id === req.nodeId
    )
    if (!node) return fail('NODE_NOT_FOUND', `节点不存在: ${req.nodeId}`)
    const cap = getCapabilityByNodeType(node.type)
    const permissionError = requireExecution(this.ctx, cap?.id)
    if (permissionError) return fail('EXECUTION_DISABLED', permissionError)
    if (!this.ctx.executeRun) return fail('EXECUTION_UNAVAILABLE', '当前入口没有已接入的运行消费者')

    // manual-publish 节点不可被 Agent 自动执行
    if (cap && !isAgentRunnable(cap.runtime)) {
      return fail(
        'AGENT_NOT_RUNNABLE',
        `节点 ${node.title}（${cap.id}）是 manual-publish 类型，不支持 Agent 自动执行。请在桌面端手动操作。`
      )
    }

    // 创建持久化 Run 记录（不再返回假 queued）
    const scope = { type: 'node' as const, nodeIds: [req.nodeId] }
    const startedAt = Date.now()
    const record = await this.ctx.store.createRun({
      runId: nanoidFallback(),
      projectId: req.projectId,
      scope,
      status: 'queued',
      actor: this.ctx.actor,
      startedAt
    })

    this.ctx.audit.log({
      actor: this.ctx.actor,
      action: 'run-node',
      projectId: req.projectId,
      entityId: req.nodeId,
      after: { runId: record.runId }
    })

    await this.ctx.executeRun(record)
    const completed = await this.ctx.store.getRun(record.runId)
    return ok(toHandle(completed ?? record))
  }

  async runWorkflow(req: RunWorkflowRequest): Promise<Result<RunHandle>> {
    if (req.dryRun) {
      const estimate = await this.estimateRun(req)
      if (!estimate.ok)
        return fail(estimate.error.code, estimate.error.message, estimate.error.details)
      return ok({
        runId: 'dry-run',
        status: 'succeeded',
        scope: { type: 'workflow', nodeIds: req.nodeIds },
        startedAt: Date.now()
      })
    }

    // 先校验
    const validation = await this.validateWorkflow({
      projectId: req.projectId,
      nodeIds: req.nodeIds
    })
    if (!validation.ok)
      return fail(validation.error.code, validation.error.message, validation.error.details)
    if (!validation.data.valid) {
      return fail('WORKFLOW_INVALID', '工作流校验未通过', { errors: validation.data.errors })
    }

    const permissionError = requireExecution(this.ctx)
    if (permissionError) return fail('EXECUTION_DISABLED', permissionError)
    if (!this.ctx.executeRun) return fail('EXECUTION_UNAVAILABLE', '当前入口没有已接入的运行消费者')

    // 检查范围内所有节点是否可被 Agent 自动执行
    const allNodes = await this.ctx.store.getNodes(req.projectId)
    const scopeNodeIds = req.nodeIds ? new Set(req.nodeIds) : new Set(allNodes.map((n) => n.id))
    const blocked: string[] = []
    for (const node of allNodes) {
      if (!scopeNodeIds.has(node.id)) continue
      const cap = getCapabilityByNodeType(node.type)
      if (cap && !isAgentRunnable(cap.runtime)) {
        blocked.push(`${node.title}（${cap.id}）`)
      }
    }
    if (blocked.length > 0) {
      return fail(
        'AGENT_NOT_RUNNABLE',
        `范围内包含 ${blocked.length} 个 manual-publish 节点，不支持 Agent 自动执行：${blocked.join('、')}`
      )
    }

    // 创建持久化 Run 记录
    const scope: RunHandle['scope'] = req.nodeIds
      ? { type: 'selection', nodeIds: req.nodeIds }
      : { type: 'workflow' }
    const startedAt = Date.now()
    const record = await this.ctx.store.createRun({
      runId: nanoidFallback(),
      projectId: req.projectId,
      scope,
      status: 'queued',
      actor: this.ctx.actor,
      startedAt
    })

    this.ctx.audit.log({
      actor: this.ctx.actor,
      action: 'run-workflow',
      projectId: req.projectId,
      after: { runId: record.runId, scope }
    })

    await this.ctx.executeRun(record)
    const completed = await this.ctx.store.getRun(record.runId)
    return ok(toHandle(completed ?? record))
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

function collectUpstream(nodeId: string, _nodes: CanvasNode[], edges: CanvasEdge[]): Set<string> {
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

function hasInlineInput(node: CanvasNode, portId: string): boolean {
  if (portId === 'in-text') {
    return node.content.kind === 'text' && node.content.text.trim().length > 0
  }
  if (portId === 'in-json' || portId === 'in-value') {
    return (
      node.content.kind === 'json' ||
      node.params.value !== undefined ||
      node.params.data !== undefined
    )
  }
  if (portId === 'in-image' || portId === 'in-video' || portId === 'in-audio') {
    return node.content.kind === 'media' || typeof node.params.mediaId === 'string'
  }
  return false
}

function schemaLabel(schema: import('@shared/types').PortSchemaRef | undefined): string {
  return schema ? `${schema.id}@${schema.version}` : '未声明 Schema'
}

// ── Run 辅助 ───────────────────────────────────────────────

function nanoidFallback(): string {
  return nanoid(12)
}

function toHandle(record: RunRecord): RunHandle {
  return {
    runId: record.runId,
    status: record.status,
    scope: record.scope,
    startedAt: record.startedAt ?? record.createdAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    error: record.error
  }
}
