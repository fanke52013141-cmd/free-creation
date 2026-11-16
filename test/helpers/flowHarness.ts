// 节点流测试矩阵共享 harness（2026-11-17 全面测试）。
// 构造与 test/manual-run.test.ts 同口径的 mock tldraw Editor：
// NodeCardShape + arrow(meta.fromPort/toPort) + bindings(terminal start/end)。
import type { Editor } from 'tldraw'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { ProviderSummary } from '@shared/types'
import { useConfirmStore } from '@renderer/stores/confirm'
import { useEngineStore } from '@renderer/engine/store'
import { useSaveCoordinator } from '@renderer/stores/save-coordinator'

export interface FlowNodeInit {
  id: string
  nodeType: string
  title?: string
  text?: string
  config?: string | Record<string, unknown>
  mediaId?: string
  mediaPath?: string
  mediaMime?: string
  meta?: Record<string, unknown>
}

export function flowNode(init: FlowNodeInit): NodeCardShape {
  return {
    id: init.id as never,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1' as never,
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType: init.nodeType,
      title: init.title ?? init.nodeType,
      config:
        typeof init.config === 'string'
          ? (init.config ?? '')
          : init.config
            ? JSON.stringify(init.config)
            : '',
      text: init.text ?? '',
      mediaId: init.mediaId ?? '',
      mediaPath: init.mediaPath ?? '',
      mediaMime: init.mediaMime ?? '',
      exec: 'idle'
    },
    meta: { ...(init.meta ?? {}) }
  }
}

export interface FlowEdgeInit {
  id?: string
  from: string
  to: string
  fromPort: string
  toPort: string
  /** 多入度端口的取值顺序（1 起）；缺省排在带序边之后。 */
  connectOrder?: number
}

export interface FlowEditorHandle {
  editor: Editor
  shapes: Map<string, NodeCardShape | { id: string; type: string; meta: Record<string, unknown> }>
  node(id: string): NodeCardShape | undefined
}

export function buildFlowEditor(
  nodes: FlowNodeInit[],
  edges: FlowEdgeInit[] = []
): FlowEditorHandle {
  const shapes = new Map<
    string,
    ReturnType<typeof flowNode> | { id: string; type: string; meta: Record<string, unknown> }
  >()
  for (const init of nodes) shapes.set(init.id, flowNode(init))
  const bindings = new Map<string, Array<{ props: { terminal: string }; toId: string }>>()
  let edgeSeq = 0
  for (const edge of edges) {
    const id =
      edge.id ?? `shape:edge-${++edgeSeq}-${edge.from}-${edge.fromPort}-${edge.to}-${edge.toPort}`
    shapes.set(id, {
      id,
      type: 'arrow',
      meta: {
        fromPort: edge.fromPort,
        toPort: edge.toPort,
        ...(edge.connectOrder != null ? { connectOrder: edge.connectOrder } : {})
      }
    })
    bindings.set(id, [
      { props: { terminal: 'start' }, toId: edge.from },
      { props: { terminal: 'end' }, toId: edge.to }
    ])
  }
  const updateShape = (patch: {
    id: string
    props?: Record<string, unknown>
    meta?: Record<string, unknown>
  }): void => {
    const current = shapes.get(patch.id)
    if (!current || current.type !== 'node-card') return
    if (patch.props) Object.assign(current.props, patch.props)
    if (patch.meta) Object.assign(current.meta, patch.meta)
  }
  const editor = {
    getCurrentPageShapes: () => Array.from(shapes.values()),
    getShape: (id: string) => shapes.get(id),
    getBindingsFromShape: (id: string) => bindings.get(id) ?? [],
    updateShape,
    updateShapes: (patches: Parameters<typeof updateShape>[]) => patches.forEach(updateShape),
    // 泳道投影等引擎路径需要创建/删除画布形状；桩实现直接落进 shapes map。
    createShape: (shape: {
      id: string
      type: string
      props?: Record<string, unknown>
      meta?: Record<string, unknown>
    }) => {
      shapes.set(shape.id, {
        ...shape,
        props: shape.props ?? {},
        meta: shape.meta ?? {}
      } as unknown as NodeCardShape)
    },
    deleteShapes: (ids: string[]) => {
      ids.forEach((id) => shapes.delete(id))
    },
    createBinding: () => undefined,
    run: (fn: () => void) => fn(),
    markHistoryStoppingPoint: () => undefined
  } as unknown as Editor
  return { editor, shapes, node: (id) => shapes.get(id) as NodeCardShape | undefined }
}

/** 桩供应商目录：四类模态各一，hasApiKey=true；resolveFeatureOption 无 resolveModelFeature 时按模态回退取第一个。 */
export function stubProviders(): ProviderSummary[] {
  return [
    {
      id: 'stub-text',
      name: '测试文本商',
      specId: 'openai',
      baseURL: 'http://stub.local',
      createdAt: 0,
      hasApiKey: true,
      models: [
        { id: 'm-chat', name: '测试文本模型', modality: 'text', operations: ['text.generate'] }
      ]
    },
    {
      id: 'stub-image',
      name: '测试图像商',
      specId: 'openai',
      baseURL: 'http://stub.local',
      createdAt: 0,
      hasApiKey: true,
      models: [
        {
          id: 'm-image',
          name: '测试图像模型',
          modality: 'image',
          operations: ['image.generate', 'image.edit']
        }
      ]
    },
    {
      id: 'stub-video',
      name: '测试视频商',
      specId: 'openai',
      baseURL: 'http://stub.local',
      createdAt: 0,
      hasApiKey: true,
      models: [
        { id: 'm-video', name: '测试视频模型', modality: 'video', operations: ['video.generate'] }
      ]
    },
    {
      id: 'minimax',
      name: 'MiniMax（桩）',
      specId: 'minimax',
      baseURL: 'http://stub.local',
      createdAt: 0,
      hasApiKey: true,
      models: [
        { id: 'speech-01', name: '测试语音', modality: 'audio', operations: ['speech.synthesize'] },
        { id: 'voice-clone', name: '语音克隆', modality: 'audio', operations: ['voice.clone'] },
        { id: 'voice-design', name: '音色设计', modality: 'audio', operations: ['voice.design'] }
      ]
    }
  ]
}

/** 静默确认：生成类节点运行前的费用确认直接放行。 */
export function approveAllConfirms(calls?: unknown[]): () => void {
  const original = useConfirmStore.getState().confirm
  useConfirmStore.setState({
    confirm: async (options: unknown) => {
      calls?.push(options)
      return true
    }
  })
  return () => useConfirmStore.setState({ confirm: original })
}

/** 每个用例之间复位引擎运行相位，避免上一个流的中断状态卡住下一个流。 */
export function resetEnginePhase(): void {
  useEngineStore.setState({ phase: 'idle', errors: [] } as never)
}

/** 模拟健康宿主的保存协调器：agent/ai-review 等网关调用前会 ensureCanvasSaved。 */
export function bindSaveCoordinator(): void {
  const coordinator = useSaveCoordinator.getState() as unknown as {
    bind: (deps: unknown) => void
  }
  try {
    coordinator.bind({
      save: async () => ({ graphVersion: 1 }),
      onConflict: () => undefined,
      onFailure: () => undefined
    })
  } catch {
    // 已绑定时忽略。
  }
}

/**
 * 模型目录桩：按 operation 返回绑定结果；未登记的 operation 返回未绑定。
 * 真实宿主里 rendererGateway.resolveModelFeature 恒存在并调用 window.api.models.resolveBinding。
 */
export function modelCatalogApi(
  bindings: Record<string, { providerId: string; modelId: string; modelKey: string }> = {}
): Record<string, unknown> {
  return {
    models: {
      resolveBinding: async (input: { operation?: string; featureKey?: string }) => {
        const hit = bindings[input.operation ?? ''] ?? bindings[input.featureKey ?? '']
        return hit
          ? { ok: true, data: hit }
          : { ok: false, error: { code: 'BINDING_NOT_FOUND', message: '未绑定模型' } }
      }
    }
  }
}

const STUB_TEXT_BINDING = {
  providerId: 'stub-text',
  modelId: 'm-chat',
  modelKey: 'stub-text::m-chat'
}
const STUB_IMAGE_BINDING = {
  providerId: 'stub-image',
  modelId: 'm-image',
  modelKey: 'stub-image::m-image'
}
const STUB_VIDEO_BINDING = {
  providerId: 'stub-video',
  modelId: 'm-video',
  modelKey: 'stub-video::m-video'
}
const STUB_SPEECH_BINDING = {
  providerId: 'minimax',
  modelId: 'speech-01',
  modelKey: 'minimax::speech-01'
}
const STUB_VOICE_BINDING = {
  providerId: 'minimax',
  modelId: 'voice-design',
  modelKey: 'minimax::voice-design'
}

/** 全模态已绑定的模型目录（成功路径）。 */
export function fullModelCatalogApi(): Record<string, unknown> {
  return modelCatalogApi({
    'text.generate': STUB_TEXT_BINDING,
    'image.generate': STUB_IMAGE_BINDING,
    'image.edit': STUB_IMAGE_BINDING,
    'video.generate': STUB_VIDEO_BINDING,
    'speech.synthesize': STUB_SPEECH_BINDING,
    'voice.design': STUB_VOICE_BINDING,
    'voice.clone': {
      providerId: 'minimax',
      modelId: 'voice-clone',
      modelKey: 'minimax::voice-clone'
    }
  })
}

/** 安装 window.api 桩；返回还原函数。 */
export function installWindowApi(api: Record<string, unknown>): () => void {
  const previous = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return () => {
    if (previous) Object.defineProperty(window, 'api', previous)
    else delete (window as Window & { api?: unknown }).api
  }
}

export type GatewayEventListener = (event: Record<string, unknown>) => void

/** 桩模型网关：chatStart 立即成功，回包经 onEvent 事件派发（与真实网关同事件序）。 */
export function makeChatGatewayApi(
  options: {
    reply?: string
    reasoningOnly?: boolean
    failStart?: string
  } = {}
): Record<string, unknown> {
  const listeners = new Set<GatewayEventListener>()
  let taskSeq = 0
  return {
    gateway: {
      chatStart: async () => {
        const taskId = `stub-chat-${++taskSeq}`
        if (options.failStart) {
          return { ok: false, error: { code: 'UPSTREAM_ERROR', message: options.failStart } }
        }
        // 事件必须在 chatStart resolve 之后派发：用宏任务保证顺序。
        setTimeout(() => {
          for (const listener of listeners) {
            if (options.reasoningOnly) {
              listener({ kind: 'chat-reasoning', taskId, text: options.reply ?? '思考内容' })
            } else {
              listener({ kind: 'chat-delta', taskId, text: options.reply ?? '桩模型回复' })
            }
            listener({ kind: 'chat-done', taskId })
          }
        }, 0)
        return { ok: true, data: { taskId } }
      },
      chatCancel: async () => ({ ok: true }),
      onEvent: (cb: GatewayEventListener) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    }
  }
}

/** 本地媒体成功信封（与 preload IPC 返回同形：{ok,data:{id,path,mime}}）。 */
export function mediaEnvelopeOk(id: string, path: string, mime: string) {
  return { ok: true as const, data: { id, path, mime, name: id } }
}

export function localCapabilitiesOk() {
  return {
    ok: true as const,
    data: {
      ffmpeg: { available: true, message: '已就绪' },
      ffprobe: { available: true, message: '已就绪' },
      audioSeparator: { available: false, message: '未安装' }
    }
  }
}

/** 读取节点终态：exec + nodeRun.status + 失败原因（error.reason）。 */
export function runStateOf(shape: NodeCardShape | undefined): {
  exec: string
  run?: string
  reason?: string
  phase?: string
  result?: unknown
} {
  if (!shape) return { exec: 'missing' }
  const run = shape.meta.nodeRun as
    { status?: string; reason?: string; error?: { phase?: string; reason?: string } } | undefined
  let result: unknown
  const raw = shape.meta.nodeResult
  if (typeof raw === 'string' && raw.trim()) {
    try {
      result = JSON.parse(raw)
    } catch {
      result = raw
    }
  }
  return {
    exec: String(shape.props.exec),
    run: run?.status,
    reason: run?.error?.reason ?? run?.reason,
    phase: run?.error?.phase,
    result
  }
}
