// 工作流执行引擎：按 DAG 拓扑顺序自动调度画布节点，把上游输出沿连线注入下游。
// 与各节点 Body 内的手动触发共享同一套网关 API（imageGenerate / chatStart / videoSubmit），
// 执行引擎是「编排层」，Body 内按钮是「单节点手动触发」，两者互补。
import type { Editor, TLShapeId } from 'tldraw'
import type { CanvasEdge, CanvasNode, ChatMessage, ExecStatus, VideoGenParams } from '@shared/types'
import { deriveGraph } from '../canvas/graph'
import { getNodeType } from '../nodes/registry'
import { markUndoPoint } from '../canvas/history'
import { toast } from '../stores/toast'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import { modelsByModality } from '../stores/gateway'
import type { ProviderConfig } from '@shared/types'
import { useEngineStore } from './store'

// ── 取消令牌 ──
interface CancelToken {
  cancelled: boolean
}

// ── 节点输出值（执行完后可被下游消费的数据） ──
type NodeOutput =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mediaId: string; mediaPath: string }
  | { kind: 'video'; mediaId: string; mediaPath: string }
  | { kind: 'audio'; mediaId: string; mediaPath: string }

// ── 聚合后的上游上下文 ──
interface NodeContext {
  /** 所有 text/any 端口的上游文本拼接 */
  textInput: string
  /** 第一个 image 端口上游的 mediaId（用于视频首帧） */
  imageMediaId?: string
}

// ── 轻量 JSON 解析（与 bodies.tsx 同款约定，避免跨模块导出私有函数） ──

function parseJsonObj(text: string): Record<string, unknown> | null {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // 非结构化内容
  }
  return null
}

/** 图片节点参数 {prompt, modelKey, size} */
interface ImageGenData {
  prompt: string
  modelKey: string
  size: string
}
function parseImageGen(text: string): ImageGenData {
  const o = parseJsonObj(text)
  if (o && typeof o.prompt === 'string') {
    return {
      prompt: o.prompt,
      modelKey: typeof o.modelKey === 'string' ? o.modelKey : '',
      size: typeof o.size === 'string' ? o.size : 'auto'
    }
  }
  return { prompt: text, modelKey: '', size: 'auto' }
}

/** 视频节点参数 {prompt, modelKey, params, taskId} */
interface VideoGenData {
  prompt: string
  modelKey: string
  params: VideoGenParams
  taskId: string
}
function parseVideoGen(text: string): VideoGenData {
  const o = parseJsonObj(text)
  if (o && typeof o.prompt === 'string') {
    const params = (typeof o.params === 'object' && o.params !== null ? o.params : {}) as {
      ratio?: unknown
      duration?: unknown
      resolution?: unknown
    }
    return {
      prompt: o.prompt,
      modelKey: typeof o.modelKey === 'string' ? o.modelKey : '',
      params: {
        ratio: typeof params.ratio === 'string' ? params.ratio : undefined,
        duration: typeof params.duration === 'number' ? params.duration : undefined,
        resolution: typeof params.resolution === 'string' ? params.resolution : undefined
      },
      taskId: typeof o.taskId === 'string' ? o.taskId : ''
    }
  }
  return { prompt: text, modelKey: '', params: {}, taskId: '' }
}

/** 对话节点参数 {system, modelKey, messages} */
function parseChat(text: string): { system: string; modelKey: string; messages: ChatMessage[] } {
  const o = parseJsonObj(text)
  if (o && Array.isArray(o.messages)) {
    const messages = (o.messages as unknown[])
      .map((m) => m as { role?: unknown; content?: unknown })
      .filter(
        (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
      )
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }))
    return {
      system: typeof o.system === 'string' ? o.system : '',
      modelKey: typeof o.modelKey === 'string' ? o.modelKey : '',
      messages
    }
  }
  return { system: '', modelKey: '', messages: [] }
}

/** 脚本节点 {source, shots} → 输出剧本文本 */
function parseScriptSource(text: string): string {
  const o = parseJsonObj(text)
  if (o && typeof o.source === 'string') return o.source
  return text
}

// ── 节点输出提取 ──

function extractOutput(shape: NodeCardShape): NodeOutput | null {
  const p = shape.props
  switch (p.nodeType) {
    case 'text':
      return p.text ? { kind: 'text', text: p.text } : null
    case 'script': {
      const src = parseScriptSource(p.text)
      return src ? { kind: 'text', text: src } : null
    }
    case 'chat': {
      const data = parseChat(p.text)
      for (let i = data.messages.length - 1; i >= 0; i--) {
        if (data.messages[i].role === 'assistant') {
          return { kind: 'text', text: data.messages[i].content }
        }
      }
      return null
    }
    case 'image':
      return p.mediaPath ? { kind: 'image', mediaId: p.mediaId, mediaPath: p.mediaPath } : null
    case 'video':
      return p.mediaPath ? { kind: 'video', mediaId: p.mediaId, mediaPath: p.mediaPath } : null
    case 'audio':
      return p.mediaPath ? { kind: 'audio', mediaId: p.mediaId, mediaPath: p.mediaPath } : null
    default:
      return null
  }
}

// ── 拓扑排序（Kahn 算法），返回 null 表示有环 ──

function topoSort(graph: { nodes: CanvasNode[]; edges: CanvasEdge[] }): CanvasNode[] | null {
  const { nodes, edges } = graph
  const ids = new Set(nodes.map((n) => n.id))
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const indeg = new Map<string, number>()
  for (const n of nodes) indeg.set(n.id, 0)
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!ids.has(e.from.nodeId) || !ids.has(e.to.nodeId)) continue
    indeg.set(e.to.nodeId, (indeg.get(e.to.nodeId) ?? 0) + 1)
    const list = adj.get(e.from.nodeId) ?? []
    list.push(e.to.nodeId)
    adj.set(e.from.nodeId, list)
  }

  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 1) - 1)
      if ((indeg.get(next) ?? 0) === 0) queue.push(next)
    }
  }
  if (order.length !== nodes.length) return null // 存在环
  return order.map((id) => byId.get(id)!)
}

// ── 上下文聚合：沿连线收集上游输出，按目标端口类型分组 ──

function gatherContext(
  node: CanvasNode,
  edges: CanvasEdge[],
  outputs: Map<string, NodeOutput>
): NodeContext {
  const spec = getNodeType(node.type)
  const inPorts = spec?.ports.in ?? []
  const textParts: string[] = []
  let imageMediaId: string | undefined

  for (const edge of edges) {
    if (edge.to.nodeId !== node.id) continue
    const out = outputs.get(edge.from.nodeId)
    if (!out) continue
    const toPort = inPorts.find((p) => p.id === edge.to.portId)
    if (!toPort) continue

    if ((toPort.type === 'text' || toPort.type === 'any') && out.kind === 'text') {
      textParts.push(out.text)
    } else if (toPort.type === 'image' && out.kind === 'image') {
      imageMediaId ??= out.mediaId
    }
  }
  return { textInput: textParts.join('\n\n'), imageMediaId }
}

// ── 提示词合并：上游文本 + 节点自身 prompt ──

function mergedPrompt(nodePrompt: string, upstreamText: string): string {
  if (!upstreamText.trim()) return nodePrompt
  if (!nodePrompt.trim()) return upstreamText
  return `${upstreamText}\n\n---\n\n${nodePrompt}`
}

// ── 网关等待 helpers ──

/** 对话流式：发 chatStart，监听事件聚合完整回复，支持取消 */
function waitForChat(
  input: {
    providerId: string
    modelId: string
    system?: string
    messages: ChatMessage[]
  },
  token: CancelToken
): Promise<string> {
  return new Promise((resolve, reject) => {
    let tid = ''
    let acc = ''
    const off = window.api.gateway.onEvent((e) => {
      if (!tid || e.taskId !== tid) return
      if (e.kind === 'chat-delta') {
        acc += e.text
      } else if (e.kind === 'chat-done') {
        cleanup()
        resolve(acc)
      } else if (e.kind === 'chat-error') {
        cleanup()
        reject(new Error(e.error))
      }
    })
    const timer = setInterval(() => {
      if (token.cancelled) {
        cleanup()
        if (tid) void window.api.gateway.chatCancel(tid)
        reject(new Error('已取消'))
      }
    }, 400)
    const cleanup = (): void => {
      off()
      clearInterval(timer)
    }
    void window.api.gateway.chatStart(input).then((res) => {
      if (!res.ok) {
        cleanup()
        reject(new Error(res.error.message))
        return
      }
      tid = res.data.taskId
    })
  })
}

/** 视频异步：提交后轮询任务状态直到完成，支持取消 + 超时 */
function waitForVideo(
  taskId: string,
  token: CancelToken
): Promise<{ mediaId: string; mediaPath: string; name: string; mime: string }> {
  return new Promise((resolve, reject) => {
    let stopped = false
    const stop = (): void => {
      stopped = true
      clearInterval(timer)
    }
    const timer = setInterval(async () => {
      if (token.cancelled) {
        stop()
        void window.api.gateway.videoCancel(taskId)
        reject(new Error('已取消'))
        return
      }
      const res = await window.api.gateway.videoTask(taskId)
      if (!res.ok || !res.data) return
      const d = res.data
      if (d.status === 'success' && d.mediaPath) {
        stop()
        resolve({ mediaId: d.mediaId ?? '', mediaPath: d.mediaPath, name: 'video', mime: 'video/mp4' })
      } else if (d.status === 'failed' || d.status === 'cancelled') {
        stop()
        reject(new Error(d.error ?? '视频生成失败'))
      }
    }, 5000)
    // 超时保护：10 分钟
    setTimeout(() => {
      if (!stopped) {
        stop()
        reject(new Error('视频生成超时（10 分钟）'))
      }
    }, 600000)
  })
}

// ── 节点状态回写 ──

function setExec(editor: Editor, id: TLShapeId, status: ExecStatus): void {
  editor.updateShape({ id, type: 'node-card', props: { exec: status } })
}

function updateShapeProps(
  editor: Editor,
  id: TLShapeId,
  props: Partial<NodeCardShape['props']>
): void {
  editor.updateShape({ id, type: 'node-card', props })
}

// ── 各节点类型的执行器 ──

/** 需要返回是否「真正执行了」(true) 还是「跳过了」(false) */
type ExecResult = { status: 'done' | 'skipped' | 'failed'; reason?: string }

async function executeNode(
  editor: Editor,
  shape: NodeCardShape,
  ctx: NodeContext,
  projectId: string,
  providers: ProviderConfig[],
  token: CancelToken
): Promise<ExecResult> {
  const id = shape.id
  const p = shape.props

  switch (p.nodeType) {
    // ── 纯数据节点：透传，无需生成 ──
    case 'text':
    case 'audio':
    case 'script':
    case 'group':
      return { status: 'done' }

    // ── 图片节点：注入上游文本 → 生图 ──
    case 'image': {
      const data = parseImageGen(p.text)
      if (!data.modelKey) return { status: 'skipped', reason: '未选择模型' }
      const options = modelsByModality(providers, 'image')
      const opt = options.find((o) => o.key === data.modelKey)
      if (!opt) return { status: 'skipped', reason: '模型不可用' }
      const prompt = mergedPrompt(data.prompt, ctx.textInput)
      if (!prompt.trim()) return { status: 'skipped', reason: '无提示词' }
      const res = await window.api.gateway.imageGenerate({
        projectId,
        providerId: opt.provider.id,
        modelId: opt.model.id,
        prompt,
        size: data.size
      })
      if (token.cancelled) return { status: 'skipped' }
      if (!res.ok) return { status: 'failed', reason: res.error.message }
      updateShapeProps(editor, id, {
        mediaId: res.data.id,
        mediaPath: res.data.path,
        mediaMime: res.data.mime,
        title: res.data.name || res.data.id
      })
      return { status: 'done' }
    }

    // ── 对话节点：注入上游文本作为 user 消息 → 流式等回复 ──
    case 'chat': {
      const data = parseChat(p.text)
      if (!data.modelKey) return { status: 'skipped', reason: '未选择模型' }
      const options = modelsByModality(providers, 'text')
      const opt = options.find((o) => o.key === data.modelKey)
      if (!opt) return { status: 'skipped', reason: '模型不可用' }
      // 无上游输入且已有历史时不重复发送（避免无意义重复）
      if (!ctx.textInput.trim() && data.messages.length > 0) return { status: 'done' }
      const userMsg: ChatMessage = { role: 'user', content: ctx.textInput || '（开始对话）' }
      const messages = [...data.messages, userMsg]
      const reply = await waitForChat(
        {
          providerId: opt.provider.id,
          modelId: opt.model.id,
          system: data.system,
          messages
        },
        token
      )
      if (token.cancelled) return { status: 'skipped' }
      updateShapeProps(editor, id, {
        text: JSON.stringify({
          system: data.system,
          modelKey: data.modelKey,
          messages: [...messages, { role: 'assistant' as const, content: reply }]
        })
      })
      return { status: 'done' }
    }

    // ── 视频节点：注入上游文本 + 首帧图 → 异步轮询 ──
    case 'video': {
      const data = parseVideoGen(p.text)
      if (!data.modelKey) return { status: 'skipped', reason: '未选择模型' }
      const options = modelsByModality(providers, 'video')
      const opt = options.find((o) => o.key === data.modelKey)
      if (!opt) return { status: 'skipped', reason: '模型不可用' }
      const prompt = mergedPrompt(data.prompt, ctx.textInput)
      if (!prompt.trim()) return { status: 'skipped', reason: '无提示词' }
      const submit = await window.api.gateway.videoSubmit({
        projectId,
        nodeId: id,
        providerId: opt.provider.id,
        modelId: opt.model.id,
        prompt,
        params: data.params,
        firstFrameMediaId: ctx.imageMediaId
      })
      if (token.cancelled) return { status: 'skipped' }
      if (!submit.ok) return { status: 'failed', reason: submit.error.message }
      const result = await waitForVideo(submit.data.taskId, token)
      if (token.cancelled) return { status: 'skipped' }
      updateShapeProps(editor, id, {
        mediaId: result.mediaId,
        mediaPath: result.mediaPath,
        mediaMime: result.mime,
        title: result.name
      })
      return { status: 'done' }
    }

    default:
      return { status: 'done' }
  }
}

// ── 主入口：运行整个工作流 ──

export async function runWorkflow(
  editor: Editor,
  projectId: string,
  providers: ProviderConfig[]
): Promise<void> {
  const store = useEngineStore.getState()
  if (store.phase === 'running') return

  const graph = deriveGraph(editor)
  if (graph.nodes.length === 0) {
    toast('画布上没有节点')
    return
  }

  const order = topoSort(graph)
  if (!order) {
    toast('工作流存在循环连线，无法执行')
    return
  }

  const token: CancelToken = { cancelled: false }
  // 把 cancel 令牌注册到 store，供「停止」按钮触发
  const stopFn = (): void => {
    token.cancelled = true
    useEngineStore.getState().setStopping()
  }
  useEngineStore.getState().setStop(stopFn)

  store.beginRun(order.length)

  const outputs = new Map<string, NodeOutput>()

  for (const node of order) {
    if (token.cancelled) break
    // CanvasNode.id 是 string，但 deriveGraph 从 tldraw shapes 提取，值即 TLShapeId 的字面量
    const shapeId = node.id as TLShapeId
    const shape = editor.getShape<NodeCardShape>(shapeId)
    if (!shape) {
      store.nodeDone()
      continue
    }

    store.setCurrent(node.title || node.type)
    const ctx = gatherContext(node, graph.edges, outputs)

    // 需要 providers 的节点提前检查是否有配置
    const needsProviders = node.type === 'image' || node.type === 'chat' || node.type === 'video'
    if (needsProviders && providers.length === 0) {
      store.addError(node.title || node.type, '尚未配置任何模型供应商')
      setExec(editor, shapeId, 'failed')
      store.nodeDone()
      continue
    }

    setExec(editor, shapeId, 'running')
    try {
      const result = await executeNode(editor, shape, ctx, projectId, providers, token)
      const latest = editor.getShape<NodeCardShape>(shapeId)

      if (token.cancelled) {
        setExec(editor, shapeId, 'cancelled')
      } else if (result.status === 'done') {
        setExec(editor, shapeId, 'success')
        if (latest) {
          const out = extractOutput(latest)
          if (out) outputs.set(node.id, out)
        }
      } else if (result.status === 'failed') {
        setExec(editor, shapeId, 'failed')
        store.addError(node.title || node.type, result.reason ?? '执行失败')
      } else {
        // skipped：不改状态（保持 idle），不阻断下游
      }
    } catch (e) {
      if (token.cancelled) {
        setExec(editor, shapeId, 'cancelled')
      } else {
        setExec(editor, shapeId, 'failed')
        store.addError(node.title || node.type, e instanceof Error ? e.message : String(e))
      }
    }
    store.nodeDone()
  }

  // 收尾
  const after = useEngineStore.getState()
  after.endRun()
  after.setStop(null)

  if (token.cancelled) {
    toast('工作流已停止')
  } else if (after.errors.length > 0) {
    const n = after.errors.length
    const first = after.errors[0]
    toast(`完成，${n} 个节点失败：${first.label}（${first.reason}）`, 6000)
  } else {
    toast(`工作流执行完成（${after.done} 个节点）`)
  }

  // 打一个撤销分段点：整批执行的状态变更合并为一步
  markUndoPoint(editor, 'run-workflow')
}
