// 工作流执行编排层（契约规范 P3 / 路线图 R1 / R4）。
//
// 这里只保留运行器：拓扑排序 → 收集输入 → 契约校验 → 按节点执行器执行
// → 读取 shape 投影输出 → 输出契约校验 → 登记。节点专属执行逻辑已迁移到
// engine/executors/* 下各节点自注册的执行器；新增普通节点无需改动本文件。
//
// 运行器对每个节点注入统一的 runSubflow 钩子（迭代控制节点用它驱动下游迭代体
// 子流程逐项执行；非迭代节点不会调用它），保持「运行器零节点特判」。
//
// 节点卡片内的手动生成与全局运行共用同一输出投影（nodes/nodeValues.ts），
// 因此执行器只需把运行结果写回 shape props / meta，投影交给运行器统一处理。
import type { Editor, TLShapeId } from 'tldraw'
import type { CanvasEdge, CanvasNode, ExecStatus, ProviderConfig } from '@shared/types'
import { deriveGraph } from '../canvas/graph'
import { markUndoPoint } from '../canvas/history'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import { buildOutputPackets, collectContractInputs, type ContractOutputs } from './contracts'
import type { NodeExecutionContext, NodeExecutionResult, SubflowRequest } from './executor-types'
import { getNodeType } from '../nodes/registry'
import { projectNodeOutputs } from '../nodes/nodeValues'
import { toast } from '../stores/toast'
import { useEngineStore } from './store'

interface CancelToken {
  cancelled: boolean
}

interface WorkflowContext {
  editor: Editor
  projectId: string
  providers: ProviderConfig[]
  token: CancelToken
  graph: { nodes: CanvasNode[]; edges: CanvasEdge[] }
  /** 运行期累积的输出登记：nodeId -> 端口输出数据包。 */
  outputs: Map<string, ContractOutputs>
  runId: string
}

function topoSort(graph: { nodes: CanvasNode[]; edges: CanvasEdge[] }): CanvasNode[] | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]))
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!byId.has(edge.from.nodeId) || !byId.has(edge.to.nodeId)) continue
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1)
    const next = adjacency.get(edge.from.nodeId) ?? []
    next.push(edge.to.nodeId)
    adjacency.set(edge.from.nodeId, next)
  }
  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const ordered: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    ordered.push(id)
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  return ordered.length === graph.nodes.length ? ordered.map((id) => byId.get(id)!) : null
}

function setExec(editor: Editor, id: TLShapeId, status: ExecStatus): void {
  editor.updateShape({ id, type: 'node-card', props: { exec: status } })
}

/**
 * 取出节点声明中自注册的执行器并调用。执行器拿到的 NodeExecutionContext 把
 * 写回持久化状态的入口收敛为 updateProps / updateResult，运行器据此读取最新
 * shape 并统一投影输出，避免执行器各自缓存或猜测端口输出。
 */
async function invokeExecutor(
  ctx: WorkflowContext,
  node: CanvasNode,
  shape: NodeCardShape,
  inputs: NodeExecutionContext['inputs'],
  runSubflow: (request: SubflowRequest) => Promise<Record<string, ContractOutputs>>
): Promise<NodeExecutionResult> {
  const spec = getNodeType(node.type)
  if (!spec?.executor) return { status: 'failed', reason: `未实现节点类型：${node.type}` }

  const id = shape.id
  // 直接下游节点 id（迭代体识别用）：从图边推导以本节点为起点的输出边目标。
  const downstream = ctx.graph.edges
    .filter((e) => e.from.nodeId === node.id)
    .map((e) => e.to.nodeId)
  const nodeCtx: NodeExecutionContext = {
    node,
    shape,
    inputs,
    projectId: ctx.projectId,
    providers: ctx.providers,
    signal: ctx.token,
    downstream,
    updateProps: (patch) => {
      ctx.editor.updateShape({ id, type: 'node-card', props: patch })
    },
    updateResult: (result) => {
      const current = ctx.editor.getShape<NodeCardShape>(id)
      ctx.editor.updateShape({
        id,
        type: 'node-card',
        meta: {
          ...(current?.meta ?? {}),
          nodeResult: result ?? undefined
        }
      })
    },
    runSubflow
  }
  return spec.executor(nodeCtx)
}

/**
 * 收集某个节点的输入。非迭代体节点用图上连边收集；迭代体首节点会把 runSubflow
 * 请求里的 item 以 in-json 注入（供批处理模板读取当前项）。
 */
function collectNodeInputs(
  ctx: WorkflowContext,
  node: CanvasNode,
  item?: Record<string, unknown>
): { value: ReturnType<typeof collectContractInputs>['value']; errors: string[] } {
  const spec = getNodeType(node.type)
  if (!spec) return { value: new Map(), errors: [`未知节点类型：${node.type}`] }
  // 迭代体首节点：item 作为 in-json 输入（若有该端口）
  const hasJsonPort =
    node.ports.length > 0
      ? node.ports.some((p) => p.dir === 'in' && p.id === 'in-json')
      : spec.ports.in.some((p) => p.id === 'in-json')
  if (item && hasJsonPort) {
    const inputs = new Map([
      [
        'in-json',
        [
          {
            type: 'json' as const,
            value: { kind: 'json' as const, data: item },
            source: { nodeId: 'iterate', portId: 'out-items', runId: ctx.runId },
            createdAt: Date.now()
          }
        ]
      ]
    ])
    return { value: inputs, errors: [] }
  }
  const collected = collectContractInputs(node, ctx.graph.edges, ctx.outputs)
  return collected
}

/**
 * 对单个节点执行一次并登记输出。返回执行状态；失败时不抛错，错误写入 store.errors。
 * 供主工作流循环和迭代体子流程共用。
 */
async function executeNodeOnce(
  ctx: WorkflowContext,
  node: CanvasNode,
  runSubflow: (request: SubflowRequest) => Promise<Record<string, ContractOutputs>>,
  item?: Record<string, unknown>
): Promise<NodeExecutionResult> {
  const { editor } = ctx
  const shapeId = node.id as TLShapeId
  const shape = editor.getShape<NodeCardShape>(shapeId)
  if (!shape) return { status: 'skipped', reason: '节点已不存在' }

  setExec(editor, shapeId, 'running')
  try {
    const collected = collectNodeInputs(ctx, node, item)
    if (collected.errors.length > 0) {
      throw new Error(`输入契约校验失败：${collected.errors.join('；')}`)
    }
    const result = await invokeExecutor(ctx, node, shape, collected.value, runSubflow)
    const latest = editor.getShape<NodeCardShape>(shapeId)
    if (ctx.token.cancelled) {
      setExec(editor, shapeId, 'cancelled')
      return { status: 'skipped', reason: '已取消' }
    }
    if (result.status === 'done') {
      if (!latest) throw new Error('节点执行后已不存在')
      const projected = buildOutputPackets(node, projectNodeOutputs(latest), ctx.runId)
      if (projected.errors.length > 0) {
        setExec(editor, shapeId, 'failed')
        useEngineStore
          .getState()
          .addError(node.title || node.type, `输出契约校验失败：${projected.errors.join('；')}`)
        return { status: 'failed', reason: '输出契约校验失败' }
      }
      ctx.outputs.set(node.id, projected.value)
      setExec(editor, shapeId, 'success')
      return { status: 'done' }
    }
    if (result.status === 'failed') {
      setExec(editor, shapeId, 'failed')
      useEngineStore.getState().addError(node.title || node.type, result.reason ?? '执行失败')
    } else {
      setExec(editor, shapeId, 'idle')
    }
    return result
  } catch (error) {
    if (ctx.token.cancelled) setExec(editor, shapeId, 'cancelled')
    else {
      const reason = error instanceof Error ? error.message : String(error)
      setExec(editor, shapeId, 'failed')
      useEngineStore.getState().addError(node.title || node.type, reason)
    }
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 迭代体子流程执行：对请求里的迭代体节点链（nodeIds）执行一次，把 item 注入首节点。
 * 返回各节点的契约输出。非迭代节点不会调到这里。
 */
async function runSubflowForIterate(
  ctx: WorkflowContext,
  runSubflow: (request: SubflowRequest) => Promise<Record<string, ContractOutputs>>,
  request: SubflowRequest
): Promise<Record<string, ContractOutputs>> {
  const results: Record<string, ContractOutputs> = {}
  const byId = new Map(ctx.graph.nodes.map((n) => [n.id, n]))
  let index = 0
  for (const nodeId of request.nodeIds) {
    if (ctx.token.cancelled) break
    const node = byId.get(nodeId)
    if (!node) continue
    // 首节点注入当前 item；后续节点用正常图连边收集（此时 outputs 已包含首节点输出）
    const itemForNode = index === 0 ? (request.item ?? {}) : undefined
    const result = await executeNodeOnce(ctx, node, runSubflow, itemForNode)
    const latest = ctx.editor.getShape<NodeCardShape>(node.id as TLShapeId)
    if (result.status === 'done' && latest) {
      results[node.id] = buildOutputPackets(node, projectNodeOutputs(latest), ctx.runId).value ?? {}
    }
    index += 1
  }
  return results
}

export async function runWorkflow(
  editor: Editor,
  projectId: string,
  providers: ProviderConfig[]
): Promise<void> {
  const store = useEngineStore.getState()
  if (store.phase === 'running') return
  const graph = deriveGraph(editor)
  if (graph.nodes.length === 0) return toast('画布上没有节点')
  const order = topoSort(graph)
  if (!order) return toast('工作流存在循环连线，无法执行')

  const token: CancelToken = { cancelled: false }
  useEngineStore.getState().setStop(() => {
    token.cancelled = true
    useEngineStore.getState().setStopping()
  })
  store.beginRun(order.length)
  const ctx: WorkflowContext = {
    editor,
    projectId,
    providers,
    token,
    graph,
    outputs: new Map<string, ContractOutputs>(),
    runId: crypto.randomUUID()
  }

  const runSubflow = (request: SubflowRequest): Promise<Record<string, ContractOutputs>> =>
    runSubflowForIterate(ctx, runSubflow, request)

  for (const node of order) {
    if (token.cancelled) break
    store.setCurrent(node.title || node.type)
    await executeNodeOnce(ctx, node, runSubflow)
    store.nodeDone()
  }

  const after = useEngineStore.getState()
  after.endRun()
  after.setStop(null)
  if (token.cancelled) toast('工作流已停止')
  else if (after.errors.length > 0) toast(`工作流完成，${after.errors.length} 个节点失败`)
  else toast('工作流执行完成')
  markUndoPoint(editor, 'workflow-run')
}
