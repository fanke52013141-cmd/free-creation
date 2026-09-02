import type { CanvasEdge, CanvasNode, PortDecl } from '@shared/types'
import { getExecutor } from '@shared/engine/executors'
import type { NodeShape } from '@shared/engine/executor-types'
import type { ContractInputMap, ContractOutputs, NodeValuePacket } from '@shared/engine/inputs'
import type { NodeValue, RawNodeOutputs } from '@shared/engine/values'
import { parseStoredNodeValue } from '@shared/engine/values'
import type { GatewayClient } from '@shared/engine/gateway-client'
import type { ProjectStore, RunRecord } from '@application/types'
import { runCodeHeadless } from './run-code'

interface HeadlessRunOptions {
  store: ProjectStore
  gateway: GatewayClient
}

/**
 * 可由 MCP/CLI 调用的主进程执行器。它只依赖 shared engine，执行完会更新
 * graph 节点状态、Run 状态和媒体 Artifact；没有窗口或 renderer 参与。
 */
export class HeadlessRunExecutor {
  /** 活跃运行的协作式取消令牌。执行器在每个原子节点前后检查它。 */
  private readonly tokens = new Map<string, { cancelled: boolean }>()

  constructor(private readonly options: HeadlessRunOptions) {}

  /**
   * 请求取消一个真实运行。正在等待可取消网关任务的执行器会通过同一 token
   * 终止轮询；不可中断的原子调用完成后，其结果会被丢弃而不会写回项目。
   */
  async cancel(runId: string): Promise<boolean> {
    const token = this.tokens.get(runId)
    if (token) {
      token.cancelled = true
      return true
    }
    const run = await this.options.store.getRun(runId)
    if (!run || run.status !== 'queued') return false
    await this.options.store.updateRun(runId, {
      status: 'cancelled',
      finishedAt: Date.now(),
      durationMs: 0
    })
    return true
  }

  async execute(run: RunRecord): Promise<void> {
    const project = await this.options.store.getProject(run.projectId)
    if (!project) throw new Error(`项目不存在: ${run.projectId}`)
    const token = { cancelled: false }
    this.tokens.set(run.runId, token)
    await this.options.store.updateRun(run.runId, { status: 'running', startedAt: Date.now() })

    try {
      const scope = new Set(run.scope.nodeIds ?? project.nodes.map((node) => node.id))
      const nodes = project.nodes.map((node) => ({
        ...node,
        params: { ...node.params },
        meta: { ...node.meta }
      }))
      const nodeById = new Map(nodes.map((node) => [node.id, node]))
      const internalEdges = project.edges.filter(
        (edge) => scope.has(edge.from.nodeId) && scope.has(edge.to.nodeId)
      )
      const packets = new Map<string, ContractOutputs>()
      const providersEnvelope = await this.options.gateway.listProviders()
      if (!providersEnvelope.ok) throw new Error(providersEnvelope.error.message)
      const providers = providersEnvelope.data

      for (const nodeId of topoSort(scope, internalEdges)) {
        throwIfCancelled(token)
        const node = nodeById.get(nodeId)
        if (!node) throw new Error(`运行范围包含不存在的节点: ${nodeId}`)
        node.exec = { status: 'running', updatedAt: Date.now() }
        const shape = toShape(node)
        // project.edges 而不是 internalEdges：运行单节点时，范围外上游已经持久化的
        // 产物也必须可以作为输入消费；范围内输出则优先取本轮 packet。
        const inputs = collectInputs(node, project.edges, packets, nodeById)
        const executor = getExecutor(node.type)
        if (!executor) throw new Error(`节点 ${node.type} 没有可用的 headless 执行器`)
        const result = await executor({
          node,
          shape,
          inputs,
          projectId: run.projectId,
          runId: run.runId,
          providers,
          signal: token,
          gateway: this.options.gateway,
          runCode: (source, args) => runCodeHeadless(source, args),
          updateProps: (patch) => Object.assign(shape.props, patch),
          updateResult: (value) => {
            shape.meta = { ...shape.meta, nodeResult: value ?? undefined }
          }
        })
        if (result.status === 'failed')
          throw new Error(result.reason ?? `节点 ${node.title} 执行失败`)
        throwIfCancelled(token)
        if (result.status === 'skipped') {
          node.exec = { status: 'idle', updatedAt: Date.now() }
          continue
        }
        const outputs = projectOutputs(node, shape)
        persistPrimaryOutput(node, outputs)
        node.exec = { status: 'success', updatedAt: Date.now() }
        packets.set(node.id, toPackets(node, outputs, run.runId))
        await this.registerMediaArtifacts(run, node, outputs)
      }

      throwIfCancelled(token)

      await this.options.store.saveGraph(
        run.projectId,
        { nodes, edges: project.edges, groups: project.groups },
        { expectedGraphVersion: project.meta.graphVersion }
      )
      const finishedAt = Date.now()
      await this.options.store.updateRun(run.runId, {
        status: 'succeeded',
        finishedAt,
        durationMs: finishedAt - (run.startedAt ?? run.createdAt)
      })
    } catch (error) {
      const finishedAt = Date.now()
      if (isRunCancelled(error) || token.cancelled) {
        await this.options.store.updateRun(run.runId, {
          status: 'cancelled',
          finishedAt,
          durationMs: finishedAt - (run.startedAt ?? run.createdAt)
        })
        return
      }
      await this.options.store.updateRun(run.runId, {
        status: 'failed',
        finishedAt,
        durationMs: finishedAt - (run.startedAt ?? run.createdAt),
        error: {
          code: 'HEADLESS_RUN_FAILED',
          message: error instanceof Error ? error.message : String(error)
        }
      })
    } finally {
      this.tokens.delete(run.runId)
    }
  }

  private async registerMediaArtifacts(
    run: RunRecord,
    node: CanvasNode,
    outputs: RawNodeOutputs
  ): Promise<void> {
    for (const [portId, value] of Object.entries(outputs)) {
      if (!value || !isMedia(value)) continue
      await this.options.store.createRunArtifact({
        runId: run.runId,
        projectId: run.projectId,
        nodeId: node.id,
        portId,
        mediaId: value.mediaId,
        artifactType: value.kind,
        mimeType: value.mime,
        label: node.title
      })
    }
  }
}

class RunCancelledError extends Error {
  constructor() {
    super('运行已取消')
  }
}

function throwIfCancelled(token: { cancelled: boolean }): void {
  if (token.cancelled) throw new RunCancelledError()
}

function isRunCancelled(error: unknown): error is RunCancelledError {
  return error instanceof RunCancelledError
}

function toShape(node: CanvasNode): NodeShape {
  const content = node.content
  const text =
    content.kind === 'text'
      ? content.text
      : content.kind === 'json'
        ? JSON.stringify(content.data)
        : ''
  return {
    props: {
      nodeType: node.type,
      title: node.title,
      config: JSON.stringify(node.params),
      text,
      mediaId: content.kind === 'media' ? content.mediaId : '',
      mediaPath: typeof node.params.mediaPath === 'string' ? node.params.mediaPath : '',
      mediaMime: typeof node.params.mediaMime === 'string' ? node.params.mediaMime : '',
      exec: JSON.stringify(node.exec),
      w: node.w,
      h: node.h
    },
    meta: {}
  }
}

function collectInputs(
  node: CanvasNode,
  edges: CanvasEdge[],
  packets: Map<string, ContractOutputs>,
  nodes: Map<string, CanvasNode>
): ContractInputMap {
  const map = new Map<string, NodeValuePacket[]>()
  for (const edge of edges) {
    if (edge.to.nodeId !== node.id) continue
    const packet = packets.get(edge.from.nodeId)?.[edge.from.portId]
    if (packet) map.set(edge.to.portId, [...(map.get(edge.to.portId) ?? []), packet])
  }
  // 运行范围外的上游节点可用其已持久化内容作为输入。
  for (const edge of edges) {
    if (edge.to.nodeId !== node.id || packets.has(edge.from.nodeId)) continue
    const source = nodes.get(edge.from.nodeId)
    if (!source) continue
    const output = inlineOutputs(source)[edge.from.portId]
    if (!output) continue
    const port = source.ports.find((item) => item.id === edge.from.portId)
    if (!port) continue
    map.set(edge.to.portId, [makePacket(source.id, port, output, 'persisted')])
  }
  return map
}

function projectOutputs(node: CanvasNode, shape: NodeShape): RawNodeOutputs {
  const fromResult = shape.meta?.nodeResult
    ? parseStoredNodeValue(String(shape.meta.nodeResult))
    : null
  const outputs: RawNodeOutputs = {}
  const primary = node.ports.filter((port) => port.dir === 'out')
  if (fromResult) {
    const port = primary.find((item) => item.type === fromResult.kind) ?? primary[0]
    if (port) outputs[port.id] = fromResult
  }
  for (const port of primary) {
    if (outputs[port.id]) continue
    if (port.type === 'text' || port.type === 'markdown') {
      if (shape.props.text.trim()) outputs[port.id] = { kind: port.type, text: shape.props.text }
    } else if (port.type === 'json' && shape.props.text.trim()) {
      try {
        outputs[port.id] = { kind: 'json', data: JSON.parse(shape.props.text) }
      } catch {
        // JSON 节点执行器已经负责返回失败，这里不把普通文本伪装成 JSON。
      }
    } else if (isMediaPort(port) && shape.props.mediaId && shape.props.mediaPath) {
      outputs[port.id] = {
        kind: port.type,
        mediaId: shape.props.mediaId,
        mediaPath: shape.props.mediaPath,
        mime: shape.props.mediaMime || 'application/octet-stream'
      } as Extract<NodeValue, { kind: 'image' | 'video' | 'audio' | 'file' }>
    }
  }
  return outputs
}

function inlineOutputs(node: CanvasNode): RawNodeOutputs {
  const shape = toShape(node)
  return projectOutputs(node, shape)
}

function persistPrimaryOutput(node: CanvasNode, outputs: RawNodeOutputs): void {
  const value = Object.values(outputs)[0]
  if (!value) return
  if (value.kind === 'text') node.content = { kind: 'text', text: value.text }
  else if (value.kind === 'json') node.content = { kind: 'json', data: value.data }
  else if (isMedia(value)) {
    node.content = { kind: 'media', mediaId: value.mediaId }
    node.params = { ...node.params, mediaPath: value.mediaPath, mediaMime: value.mime }
  }
}

function toPackets(node: CanvasNode, outputs: RawNodeOutputs, runId: string): ContractOutputs {
  const packets: ContractOutputs = {}
  for (const [portId, value] of Object.entries(outputs)) {
    const port = node.ports.find((item) => item.id === portId)
    if (port && value) packets[portId] = makePacket(node.id, port, value, runId)
  }
  return packets
}

function makePacket(
  nodeId: string,
  port: PortDecl,
  value: NodeValue,
  runId: string
): NodeValuePacket {
  return {
    type: port.type,
    value,
    schema: port.schema,
    source: { nodeId, portId: port.id, runId },
    createdAt: Date.now()
  }
}

function isMediaPort(
  port: PortDecl
): port is PortDecl & { type: 'image' | 'video' | 'audio' | 'file' } {
  return (
    port.type === 'image' || port.type === 'video' || port.type === 'audio' || port.type === 'file'
  )
}

function isMedia(
  value: NodeValue
): value is Extract<NodeValue, { kind: 'image' | 'video' | 'audio' | 'file' }> {
  return (
    value.kind === 'image' ||
    value.kind === 'video' ||
    value.kind === 'audio' ||
    value.kind === 'file'
  )
}

function topoSort(scope: Set<string>, edges: CanvasEdge[]): string[] {
  const indegree = new Map([...scope].map((id) => [id, 0]))
  const next = new Map<string, string[]>()
  for (const edge of edges) {
    if (!scope.has(edge.from.nodeId) || !scope.has(edge.to.nodeId)) continue
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1)
    next.set(edge.from.nodeId, [...(next.get(edge.from.nodeId) ?? []), edge.to.nodeId])
  }
  const queue = [...scope].filter((id) => indegree.get(id) === 0)
  const ordered: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    ordered.push(id)
    for (const target of next.get(id) ?? []) {
      indegree.set(target, (indegree.get(target) ?? 1) - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  }
  if (ordered.length !== scope.size) throw new Error('工作流中存在环路')
  return ordered
}
