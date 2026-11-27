import { toast } from '../stores/toast'
import { checkModelAvailability, providerAvailabilityKey } from './model-availability'
import type { ModelOperation } from '@free-creation/model-contracts'
import { nodePageIndex } from './node-page-index'
import { nodePortOcclusionSignature } from './port-occlusion-index'
import { useComputedValue } from './use-computed-value'
import type { GenerationTimingSample } from '@shared/contracts'
import { nodeRunDurationIndex } from './node-run-duration-index'
import {
  averageNodeExecutionDuration,
  DEFAULT_NODE_EXECUTION_ESTIMATE_MS,
  DEFAULT_NODE_EXECUTION_ESTIMATES_MS,
  nodeExecutionProgressPercent
} from './node-execution-progress'
import {
  DEFAULT_IMAGE_GENERATION_ESTIMATE_MS,
  estimateImageGenerationDuration,
  imageGenerationProgressPercent
} from './image-generation-progress'
import { estimateGenerationDuration } from './generation-time-estimate'
import { GenerationLoadingOverlay } from './GenerationLoadingOverlay'
import type { NodeRunRecord } from '../engine/runRecord'
import type { Editor } from 'tldraw'
// NodeCard 卡片视图：头部（序号/图标/标题/状态灯）+ 类型化内容体 + 端口圆点 + 媒体预览浮层
import { HTMLContainer, stopEventPropagation, useEditor, useValue, getPointerInfo } from 'tldraw'
import { nodeOwnsPointer, nodeSelectableText, nodeTextField } from './node-pointer-policy'
import { memo, useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { getNodePorts, getNodeType, nodeIconColor, PORT_TYPE_LABELS } from '../nodes/registry'
import type { PortDecl, PortSchemaRef, PortType } from '@shared/types'
import { useConnectionStore } from '../stores/connection'
import { useNodePanelStore } from '../stores/nodePanel'
import { useFlowFocusStore } from '../stores/flowFocus'
import { beginConnectionDrag } from './connection-drag'
import { batchConnectionFromSelection } from './batch-connection'
import { dynamicPortIdsForShape, portPairCompatible } from './graph'
import { processorConfigurationIssue } from './processor-readiness'
import { markUndoPoint } from './history'
import type { NodeCardShape } from './NodeCardShape'
import { Icon } from '../components/Icon'
import { NODE_UI, STORYBOARD_UI, resolveNodeHeight } from './node-ui-tokens'
import { nodeExecLabel } from './node-status'
import { currentNodeFingerprint, successfulInputFingerprint } from '../engine/resultFreshness'
import { projectNodeOutputs } from '../nodes/nodeValues'
import { deriveNodeReadiness } from './node-readiness'
import { readCompositeInstanceManifest } from '@shared/composite/outputs'
import { CHAT_FEATURE_KEY } from '@shared/engine/models'
import { chatModelBinding } from './chat-readiness'
import { runNodeManually } from '../engine/executor'
import { guiWorkflowInputOptions } from '../stores/workflowInput'
import { useAppStore } from '../stores/app'
import { useGatewayStore } from '../stores/gateway'
import { Tooltip } from '../components/Tooltip'
import { NODE_PORT_OUTSET, NODE_PORT_SIZE } from './edge-geometry'
import { createNodePortLayout } from './node-port-layout'
import { ConnectedInputPreview } from './ConnectedInputPreview'
import { FlowReviewFeedback } from './FlowReviewFeedback'
import { FixedFlowAssetBody } from './FixedFlowAssetBody'
import { readFlowAssetSnapshot } from './flow-asset-snapshot'
import { IterationSnapshotBody } from './IterationSnapshotBody'
import { IterationTemplateBody } from './IterationTemplateBody'
import { IterationBoundaryBody } from './IterationBoundaryBody'
import {
  normalizeIterationTemplate,
  readIterationSnapshot,
  toggleIterationTemplate
} from './iteration-lanes'
import { readNodeRunRecord } from '../engine/runRecord'
import './image-gen-adaptive.css'
import { NodeCardShell } from './NodePresentation'

const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>()
const EMPTY_PORTS: { in: PortDecl[]; out: PortDecl[] } = { in: [], out: [] }

const EXECUTION_LABELS: Record<string, string> = {
  audio: '音频处理中',
  code: '代码执行中',
  director: '导演任务处理中',
  file: '文件处理中',
  image: '图片处理中',
  'image-gen': '图片生成中',
  'image-edit': 'P图中',
  'image-split': '正在拆分图片',
  'image-crop': '正在裁剪图片',
  json: 'JSON 处理中',
  processor: 'AI 处理中',
  video: '视频生成中',
  'video-asset': '视频素材处理中',
  'video-audio': '正在提取音轨',
  'video-clip': '正在裁剪视频',
  'video-depth': '深度视频生成中',
  'video-clay': '白模视频生成中',
  'video-frame': '正在提取视频帧',
  chat: 'AI 对话处理中',
  'ai-process': 'AI 处理中',
  speech: '语音生成中',
  tts: '配音生成中',
  'voice-design': '音色生成中',
  'vocal-separate': '人声分离中',
  script: '脚本生成中',
  iterate: '内容迭代中',
  storyboard: '分镜生成中',
  structured: '结构化内容生成中',
  text: '文本生成中'
}

/**
 * 仅在节点处于 pending/queued/running 时挂载的独立运行遮罩组件。
 * 空闲节点不再挂载 500ms 计时器、不拉取历史耗时 IPC、不订阅 nodeRunDurationIndex。
 */
function NodeExecutionOverlay({
  editor,
  shape,
  nodeRun,
  configuredProviderKey,
  configuredModelKey,
  imageProviderKey,
  imageModelKey,
  imageCount
}: {
  editor: Editor
  shape: NodeCardShape
  nodeRun: NodeRunRecord | null
  configuredProviderKey: string
  configuredModelKey: string
  imageProviderKey: string
  imageModelKey: string
  imageCount: number
}): React.JSX.Element {
  const imageRunActive = shape.props.nodeType === 'image-gen' && nodeRun?.status === 'running'
  const [imageTimingEstimateMs, setImageTimingEstimateMs] = useState(
    DEFAULT_IMAGE_GENERATION_ESTIMATE_MS
  )
  const [executionElapsedMs, setExecutionElapsedMs] = useState(0)
  const [generationTimingSamples, setGenerationTimingSamples] = useState<GenerationTimingSample[]>(
    []
  )

  useEffect(() => {
    if (nodeRun?.status !== 'running') return
    const startedAt = nodeRun.startedAt
    const refreshElapsed = (): void => setExecutionElapsedMs(Math.max(0, Date.now() - startedAt))
    const frame = window.requestAnimationFrame(refreshElapsed)
    const timer = window.setInterval(refreshElapsed, 500)
    let current = true
    if (shape.props.nodeType === 'image-gen' && imageProviderKey && imageModelKey) {
      void window.api.workspace
        .getImageGenerationTimings()
        .then((response) => {
          if (!current || !response.ok) return
          setImageTimingEstimateMs(
            estimateImageGenerationDuration(
              response.data,
              imageProviderKey,
              imageModelKey,
              imageCount
            )
          )
        })
        .catch(() => undefined)
    } else {
      void window.api.workspace
        .getGenerationTimings()
        .then((response) => {
          if (current && response.ok) setGenerationTimingSamples(response.data)
        })
        .catch(() => undefined)
    }
    return () => {
      current = false
      window.cancelAnimationFrame(frame)
      window.clearInterval(timer)
    }
  }, [
    nodeRun?.runId,
    nodeRun?.status,
    nodeRun?.startedAt,
    shape.props.nodeType,
    imageProviderKey,
    imageModelKey,
    imageCount
  ])

  const nodeRunDurationEstimateMs = useValue(
    'node execution average duration',
    () => {
      const runs = nodeRunDurationIndex(editor).samples.get(shape.props.nodeType) ?? []
      const exactModelRuns = configuredModelKey
        ? runs.filter(
            (run) =>
              run.modelId === configuredModelKey &&
              (!configuredProviderKey || run.providerId === configuredProviderKey)
          )
        : []
      const exactProviderRuns = configuredProviderKey
        ? runs.filter((run) => run.providerId === configuredProviderKey)
        : []
      const matchingRuns = exactModelRuns.length
        ? exactModelRuns
        : configuredProviderKey
          ? exactProviderRuns
          : runs
      const recentDurations = matchingRuns.slice(0, 20).map((run) => run.durationMs)
      return averageNodeExecutionDuration(
        recentDurations,
        DEFAULT_NODE_EXECUTION_ESTIMATES_MS[shape.props.nodeType] ??
          DEFAULT_NODE_EXECUTION_ESTIMATE_MS
      )
    },
    [editor, shape.props.nodeType, configuredProviderKey, configuredModelKey]
  )

  const executionEstimateMs = imageRunActive
    ? imageTimingEstimateMs
    : estimateGenerationDuration(
        shape.props.nodeType,
        nodeRun?.estimateFeatures,
        nodeRun?.estimateProviderKey ?? configuredProviderKey,
        nodeRun?.estimateModelKey ?? configuredModelKey,
        generationTimingSamples,
        nodeRunDurationEstimateMs
      )

  const executionProgress =
    nodeRun?.status === 'running'
      ? shape.props.nodeType === 'image-gen'
        ? imageGenerationProgressPercent(executionElapsedMs, executionEstimateMs)
        : nodeExecutionProgressPercent(executionElapsedMs, executionEstimateMs)
      : 0

  const remainingEstimateMs = executionEstimateMs - executionElapsedMs
  const executionTitle = EXECUTION_LABELS[shape.props.nodeType] ?? '节点执行中'

  return (
    <div className="node-execution-overlay">
      <GenerationLoadingOverlay
        title={executionTitle}
        progress={executionProgress}
        remainingMs={remainingEstimateMs}
        waiting={nodeRun?.status !== 'running'}
      />
    </div>
  )
}

type OpenMediaPreviewFn = (next: {
  url: string
  kind: 'image' | 'video' | 'audio'
  title: string
}) => void

const MemoizedNodeBody = memo(function MemoizedNodeBody({
  Body,
  shape,
  openPreview,
  upstreamToken
}: {
  Body: NonNullable<ReturnType<typeof getNodeType>>['Body']
  shape: NodeCardShape
  openPreview: OpenMediaPreviewFn
  /** 上游连线或上游投影变化时推进引用，确保依赖 gatherInputs/gatherUpstreamMedia 的 Body 及时刷新。 */
  upstreamToken: readonly unknown[]
}): React.JSX.Element {
  void upstreamToken
  return <Body shape={shape} openPreview={openPreview} />
})

const EXEC_COLORS: Record<string, string> = {
  idle: '#6b7280',
  pending: '#9ca3af',
  queued: '#9ca3af',
  running: '#fbbf24',
  success: '#34d399',
  failed: '#ff6b6b',
  cancelled: '#6b7280',
  cached: '#60a5fa'
}

function portHint(port: PortDecl): string {
  return `${port.name} · ${PORT_TYPE_LABELS[port.type]}`
}

interface PortFollowPosition {
  key: string
  x: number
  y: number
}

/**
 * 文本节点字数徽标格式：
 * - 不足一百字：精确显示（如「42 字」）；
 * - 一百到不足一千：按整百取整加“多”（567 →「500 多字」）；
 * - 达到一千：换算为 K，保留两位有效数字（1234 →「1.2K」，15600 →「16K」）。
 */
function formatCharCount(n: number): string {
  if (n >= 1000) return `${Number((n / 1000).toPrecision(2))}K`
  if (n >= 100) return `${Math.floor(n / 100) * 100} 多字`
  return `${n} 字`
}

/**
 * 拖线草稿与候选端口的兼容判断。
 *
 * - out 方向：source 是拖出的输出端口，target 是候选输入端口；
 * - in 方向：source 是候选输出端口，target 是拖出的输入端口。
 * 两种方向都统一走 portPairCompatible(out, in)，由函数签名固定参数顺序。
 */
function canAttachPort(
  source: { portType: PortType; schema?: PortSchemaRef },
  target: PortDecl,
  direction: 'out' | 'in' = 'out'
): boolean {
  const asPort = { type: source.portType, schema: source.schema }
  return direction === 'out'
    ? portPairCompatible(asPort, target)
    : portPairCompatible(target, asPort)
}

export function NodeCardView({ shape }: { shape: NodeCardShape }): React.JSX.Element {
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const providersKey = providerAvailabilityKey(providers)
  const stableProviders = useMemo(
    () => JSON.parse(providersKey) as typeof providers,
    [providersKey]
  )
  const modelCheckKey = `${shape.props.nodeType}:${shape.props.nodeType === 'chat' ? shape.props.text : shape.props.config}:${providersKey}`
  const [modelCheck, setModelCheck] = useState<{
    key: string
    available: boolean
  } | null>(null)
  const modelAvailable = modelCheck?.key === modelCheckKey ? modelCheck.available : undefined
  useEffect(() => {
    const features: Record<string, { feature: string; operation: ModelOperation }> = {
      'image-gen': { feature: 'image.generate', operation: 'image.generate' },
      'image-edit': { feature: 'image.edit', operation: 'image.edit' },
      video: { feature: 'video.generate', operation: 'video.generate' },
      'ai-process': { feature: 'text.process', operation: 'text.generate' },
      chat: { feature: CHAT_FEATURE_KEY, operation: 'text.generate' }
    }
    const target = features[shape.props.nodeType]
    let cancelled = false
    if (target) {
      // 对话节点的模型选择存在 props.text（序列化会话数据）里；读 props.config 会永远拿不到，
      // 且功能键曾误用 text.chat，导致合法绑定被判「模型尚未配置」。现与执行器同源。
      let config: { featureKey?: string; modelKey?: string } = {}
      if (shape.props.nodeType === 'chat') {
        config = chatModelBinding(shape.props.text)
      } else {
        try {
          config = JSON.parse(shape.props.config || '{}')
        } catch {
          /* executor owns invalid config errors */
        }
      }
      void checkModelAvailability(
        stableProviders,
        config.featureKey || target.feature,
        target.operation,
        config.modelKey
      )
        .then((option) => {
          if (!cancelled) setModelCheck({ key: modelCheckKey, available: option })
        })
        .catch(() => {
          if (!cancelled) setModelCheck({ key: modelCheckKey, available: false })
        })
    }
    return () => {
      cancelled = true
    }
  }, [shape.props.nodeType, shape.props.config, shape.props.text, stableProviders, modelCheckKey])
  const spec = getNodeType(shape.props.nodeType)
  // 循环分支快照卡：内核是文本节点，呈现层按产出节点身份覆盖图标/身份色，只读不可执行。
  const iterationSnapshot = readIterationSnapshot(shape)
  // 循环体模板卡（本体模具）：紧凑配方占位，双击展开真实定义节点。
  const isTemplateCard = Boolean((shape.meta as Record<string, unknown>)?.iterationTemplateCard)
  const isBoundaryMarker = Boolean((shape.meta as Record<string, unknown>)?.iterationBoundary)
  // 循环体容器成员（框内定义节点）：紧凑呈现，隐藏序号、收紧空态图标，更干净。
  const inTemplateContainer = Boolean(
    (shape.meta as Record<string, unknown>)?.iterationTemplateMember
  )
  // 旧快照可能残留 tldraw group（会画大包围框并吞掉展开按钮单击）：模板卡挂载时解散。
  useEffect(() => {
    if (!isTemplateCard) return
    const loopId = (shape.meta as Record<string, unknown>)?.iterationTemplateCard
    if (typeof loopId !== 'string') return
    const legacy = editor
      .getCurrentPageShapes()
      .find(
        (s) =>
          s.type === 'group' &&
          (s.meta as Record<string, unknown>)?.iterationTemplateLoopId === loopId
      )
    if (legacy && typeof editor.ungroupShapes === 'function') editor.ungroupShapes([legacy.id])
    // 加载归一化：修复旧快照不一致几何（框陈旧/节点跑框外），保证框包住所有节点。
    normalizeIterationTemplate(editor, shape)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, isTemplateCard, shape.id])
  const identitySpec = iterationSnapshot ? getNodeType(iterationSnapshot.role) : spec
  const displayTitle =
    shape.props.nodeType === 'speech' && shape.props.title === '配音'
      ? '语音合成'
      : shape.props.title
  // 只订阅稳定的 draft.from，避免拖线 pointermove 每帧触发全画布 N 张卡重渲染。
  const draftFrom = useConnectionStore((s) => s.draft?.from ?? null)
  const draft = useMemo(() => (draftFrom ? { from: draftFrom } : null), [draftFrom])
  const [preview, setPreview] = useState<{
    url: string
    kind: 'image' | 'video' | 'audio'
    title: string
  } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [headerActions, setHeaderActions] = useState<HTMLSpanElement | null>(null)
  const portFollowRef = useRef<PortFollowPosition | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  // 聚光灯 CSS 变量写入按 rAF 合并：每个指针事件都 getBoundingClientRect + 写样式
  // 会在鼠标移动时造成多处强制布局，与连线层命中测试叠加放大卡顿。
  const spotlightFrameRef = useRef(0)
  const spotlightPointRef = useRef<{ x: number; y: number; el: HTMLDivElement } | null>(null)
  useEffect(
    () => () => {
      if (spotlightFrameRef.current) cancelAnimationFrame(spotlightFrameRef.current)
    },
    []
  )
  const titleEditable = !iterationSnapshot

  /** Follow within the detached hit area, in canvas-local pixels (direct CSS var write, 0 React re-render). */
  const updatePortFollow = (event: React.PointerEvent<HTMLSpanElement>, key: string): void => {
    if (event.pointerType !== 'mouse' || event.buttons !== 0) return
    const el = event.currentTarget
    const rect = el.getBoundingClientRect()
    const zoom = rect.width / NODE_PORT_SIZE || 1
    let x = (event.clientX - (rect.left + rect.width / 2)) / zoom
    let y = (event.clientY - (rect.top + rect.height / 2)) / zoom
    const radius = NODE_PORT_SIZE / 2
    const length = Math.hypot(x, y)
    if (length > radius) {
      const ratio = radius / length
      x *= ratio
      y *= ratio
    }
    const prev = portFollowRef.current
    if (prev?.key === key && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.y - y) < 0.5) return
    portFollowRef.current = { key, x, y }
    el.style.setProperty('--port-follow-x', `${x}px`)
    el.style.setProperty('--port-follow-y', `${y}px`)
  }

  const clearPortFollow = (event: React.PointerEvent<HTMLSpanElement>, key: string): void => {
    event.currentTarget.style.removeProperty('--port-follow-x')
    event.currentTarget.style.removeProperty('--port-follow-y')
    if (portFollowRef.current?.key !== key) return
    portFollowRef.current = null
  }

  /** 连线起点取随鼠标移动后的可见圆心，而不是透明命中区中的任意点。 */
  const portCenter = (
    event: React.PointerEvent<HTMLSpanElement>,
    key: string
  ): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    const follow = portFollowRef.current?.key === key ? portFollowRef.current : null
    const zoom = rect.width / NODE_PORT_SIZE || 1
    return {
      x: rect.left + rect.width / 2 + (follow?.x ?? 0) * zoom,
      y: rect.top + rect.height / 2 + (follow?.y ?? 0) * zoom
    }
  }

  // 预览切换时不能沿用上一份媒体的错误状态；尤其是同一节点重新生成视频后，
  // 新输出应立即获得一个干净的播放器，而不是继续显示旧文件的加载错误。
  const openMediaPreview = useCallback(
    (next: { url: string; kind: 'image' | 'video' | 'audio'; title: string }): void => {
      setPreviewError(null)
      setPreview(next)
    },
    []
  )
  // 媒体预览浮层与「Esc 关闭」的全局面板行为保持一致
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])
  // 计算节点序号：按创建顺序排序所有 node-card，返回当前节点的序号
  const seq = useValue(
    'node sequence',
    () => {
      return nodePageIndex(editor).sequence.get(shape.id) ?? 0
    },
    [editor, shape.id]
  )

  const selected = useValue(
    'node selected',
    () => editor.getSelectedShapeIds().includes(shape.id),
    [editor, shape.id]
  )

  // 行首 info 图标统一打开节点契约详情；聊天工作区仍由聊天节点选中/工作区入口打开。
  const handleInfoOpen = (e: React.PointerEvent<HTMLButtonElement>): void => {
    // 阻止指针事件继续，避免落入卡片选中/拖动逻辑
    stopEventPropagation(e)
  }

  // 图标只做一件事：说明这个节点的契约。默认落在「设置」页——参数配置是高频操作，
  // 概览/输入输出说明看一眼即可（2026-10-05 用户反馈）。
  const openNodePanel = (): void => {
    useNodePanelStore.getState().open('contract', shape.id, 'settings')
  }

  const beginTitleEditing = useCallback((): void => {
    if (!titleEditable) return
    setEditing(true)
    requestAnimationFrame(() => {
      const title = titleRef.current
      if (!title?.isContentEditable) return
      title.focus()
      window.getSelection()?.selectAllChildren(title)
    })
  }, [titleEditable])

  // 双击标题进入编辑模式。原生 CustomEvent 是画布捕获指针后的可靠桥接，
  // 否则 tldraw 会把第二击的 dblclick 重定向到画布而不是标题元素。
  useEffect(() => {
    const title = titleRef.current
    if (!title) return
    title.addEventListener('canvas:edit-node-title', beginTitleEditing)
    return () => title.removeEventListener('canvas:edit-node-title', beginTitleEditing)
  }, [beginTitleEditing])

  const handleTitleDoubleClick = (e: React.MouseEvent): void => {
    stopEventPropagation(e)
    beginTitleEditing()
  }

  const handleTitlePointerDown = (e: React.PointerEvent): void => {
    if (editing) stopEventPropagation(e)
  }

  // HTML 节点的内容层会先接收 pointerdown。这里同步选中、但不阻断事件，
  // 让 tldraw 在同一次按住移动中直接进入拖动，不要求用户先单击一次再拖。
  const handleCardPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return
    if (!editor.getSelectedShapeIds().includes(shape.id)) editor.select(shape.id)
  }

  const finishTitleEditing = useCallback(
    (title: HTMLDivElement): void => {
      const next = title.textContent ?? ''
      const current = editor.getShape<NodeCardShape>(shape.id)
      if (current && next !== current.props.title) {
        editor.updateShape({ id: shape.id, type: 'node-card', props: { title: next } })
        markUndoPoint(editor, 'title-edit')
      }
      setEditing(false)
    },
    [editor, shape.id]
  )

  const handleTitleBlur = (e: React.FocusEvent<HTMLDivElement>): void => {
    finishTitleEditing(e.currentTarget)
  }

  // 画布会捕获指针事件，点击空白或不可聚焦控件时浏览器可能不会自动让
  // contentEditable 失焦。主动结束编辑，避免标题一直保留可编辑态。
  useEffect(() => {
    if (!editing) return
    const title = titleRef.current
    if (!title) return
    const finishOnOutsidePointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && title.contains(event.target)) return
      if (document.activeElement === title) title.blur()
      else finishTitleEditing(title)
    }
    document.addEventListener('pointerdown', finishOnOutsidePointerDown, true)
    return () => document.removeEventListener('pointerdown', finishOnOutsidePointerDown, true)
  }, [editing, finishTitleEditing])

  const resolvedPorts = useMemo(
    () => (spec ? getNodePorts(spec, shape) : EMPTY_PORTS),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dynamic ports only depend on nodeType/config/text/meta
    [spec, shape.props.config, shape.props.text, shape.meta]
  )
  const inPorts = resolvedPorts.in
  const outPorts = resolvedPorts.out
  // 空闲端口使用节点色；输入端口连接后继承上游节点色。端口 ID、类型与布局仍来自契约。
  const nodePortColor = spec?.color ?? '#42b9f5'
  const artifactProducerId = (shape.meta as Record<string, unknown> | undefined)?.artifactProducerId
  const artifactProducer =
    typeof artifactProducerId === 'string'
      ? editor.getShape<NodeCardShape>(artifactProducerId as NodeCardShape['id'])
      : undefined
  const artifactProducerColor =
    artifactProducer?.type === 'node-card'
      ? (getNodeType(artifactProducer.props.nodeType)?.color ?? nodePortColor)
      : nodePortColor
  const isSource = draftFrom?.shapeId === shape.id
  const statusLabel = nodeExecLabel(shape.props.exec)
  const activeExecution = ['pending', 'queued', 'running'].includes(shape.props.exec)
  const nodeRun = readNodeRunRecord(shape.meta?.nodeRun)
  const imageRun = shape.props.nodeType === 'image-gen' ? nodeRun : null
  const nodeConfig = useMemo(() => {
    if (!shape.props.config) return null
    try {
      const parsed = JSON.parse(shape.props.config) as Record<string, unknown>
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }, [shape.props.config])
  const textConfig = useMemo(() => {
    if (!shape.props.text || shape.props.text[0] !== '{') return null
    try {
      const parsed = JSON.parse(shape.props.text) as Record<string, unknown>
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }, [shape.props.text])
  const configuredModelKey =
    typeof nodeConfig?.modelKey === 'string' && nodeConfig.modelKey
      ? nodeConfig.modelKey
      : typeof textConfig?.modelKey === 'string'
        ? textConfig.modelKey
        : ''
  const configuredProviderKey =
    typeof nodeConfig?.providerKey === 'string' && nodeConfig.providerKey
      ? nodeConfig.providerKey
      : configuredModelKey.includes('::')
        ? configuredModelKey.split('::')[0]
        : ''
  const imageProviderKey =
    imageRun?.estimateProviderKey ??
    (typeof nodeConfig?.providerKey === 'string' && nodeConfig.providerKey
      ? nodeConfig.providerKey
      : typeof nodeConfig?.modelKey === 'string'
        ? nodeConfig.modelKey.split('::')[0]
        : '')
  const imageModelKey =
    imageRun?.estimateModelKey ??
    (typeof nodeConfig?.modelKey === 'string' ? nodeConfig.modelKey : '')
  const imageCount =
    imageRun?.estimateFeatures?.imageCount ??
    (typeof nodeConfig?.count === 'number' && Number.isFinite(nodeConfig.count)
      ? Math.max(1, Math.min(9, Math.floor(nodeConfig.count)))
      : 1)
  const timingRecordedRunRef = useRef<string | null>(null)

  useEffect(() => {
    if (
      shape.props.nodeType !== 'image-gen' ||
      imageRun?.status !== 'success' ||
      !imageRun.runId ||
      !imageProviderKey ||
      !imageModelKey ||
      typeof imageRun.durationMs !== 'number' ||
      imageRun.durationMs <= 0 ||
      timingRecordedRunRef.current === imageRun.runId
    ) {
      return
    }
    timingRecordedRunRef.current = imageRun.runId
    void window.api.workspace
      .recordImageGenerationTiming({
        runId: imageRun.runId,
        providerKey: imageProviderKey,
        modelKey: imageModelKey,
        durationMs: Math.round(imageRun.durationMs / imageCount),
        recordedAt: imageRun.finishedAt ?? Date.now()
      })
      .catch(() => undefined)
  }, [
    shape.props.nodeType,
    imageRun?.runId,
    imageRun?.status,
    imageRun?.durationMs,
    imageRun?.finishedAt,
    imageProviderKey,
    imageModelKey,
    imageCount
  ])

  const projectedOutputs = useMemo(
    () => (spec?.projectOutputs?.(shape) ?? {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shape props/meta are immutable
    [spec, shape.props, shape.meta]
  )

  const readinessState = useComputedValue(
    'node readiness',
    () => {
      const incomingCounts = new Map<string, number>()
      const availableInputCounts = new Map<string, number>()
      const outgoingCounts = new Map<string, number>()
      const incomingNodeColors = new Map<string, string>()
      const incomingPortIds = new Set<string>()
      const outgoingPortIds = new Set<string>()
      const upstreamRefs: unknown[] = []
      const pageIndex = nodePageIndex(editor)
      for (const edge of pageIndex.incomingByNode.get(shape.id) ?? []) {
        if (edge.toPort && edge.endId === shape.id) {
          incomingCounts.set(edge.toPort, (incomingCounts.get(edge.toPort) ?? 0) + 1)
          incomingPortIds.add(edge.toPort)
          const source = edge.startId ? editor.getShape<NodeCardShape>(edge.startId) : undefined
          const sourceOutput =
            source?.type === 'node-card' && edge.fromPort
              ? projectNodeOutputs(source)[edge.fromPort]
              : undefined
          upstreamRefs.push(edge.arrowId, edge.fromPort ?? '', edge.toPort, sourceOutput)
          if (sourceOutput) {
            availableInputCounts.set(edge.toPort, (availableInputCounts.get(edge.toPort) ?? 0) + 1)
          }
          const sourceColor =
            source?.type === 'node-card' ? getNodeType(source.props.nodeType)?.color : undefined
          if (sourceColor && !incomingNodeColors.has(edge.toPort)) {
            incomingNodeColors.set(edge.toPort, sourceColor)
          }
        }
      }
      for (const edge of pageIndex.outgoingByNode.get(shape.id) ?? []) {
        if (edge.fromPort && edge.startId === shape.id) {
          outgoingPortIds.add(edge.fromPort)
          outgoingCounts.set(edge.fromPort, (outgoingCounts.get(edge.fromPort) ?? 0) + 1)
        }
      }
      for (const card of pageIndex.artifacts.get(shape.id) ?? []) {
        if (card.type !== 'node-card') continue
        const meta = card.meta as Record<string, unknown> | undefined
        if (
          meta?.artifactProducerId === shape.id &&
          meta.artifactLinkHidden !== true &&
          typeof meta.artifactProducerPortId === 'string'
        ) {
          outgoingPortIds.add(meta.artifactProducerPortId)
          outgoingCounts.set(
            meta.artifactProducerPortId,
            (outgoingCounts.get(meta.artifactProducerPortId) ?? 0) + 1
          )
        }
      }
      const fixedSatisfiedInputPorts = new Set<string>()
      if (shape.props.nodeType === 'composite') {
        const manifest = readCompositeInstanceManifest(shape)
        for (const input of manifest?.inputs ?? []) {
          if (input.defaultValue !== undefined) fixedSatisfiedInputPorts.add(`in-${input.id}`)
        }
      }
      const readiness = deriveNodeReadiness({
        executionMode: spec?.executionMode ?? 'auto',
        exec: shape.props.exec,
        nodeType: shape.props.nodeType,
        text: shape.props.text,
        inputs: inPorts,
        incomingCounts,
        availableInputCounts,
        modelAvailable,
        fixedSatisfiedInputPorts,
        configIssue:
          spec?.executionDisabledReason ??
          (shape.props.nodeType === 'processor'
            ? processorConfigurationIssue(editor, shape)
            : undefined),
        outputs: projectedOutputs
      })
      const fingerprint = successfulInputFingerprint(shape)
      const inputStale = Boolean(fingerprint && currentNodeFingerprint(editor, shape) !== fingerprint)
      const signature = `${readiness.kind}|${readiness.reason ?? ''}|${readiness.label}|${inputStale ? 1 : 0}|${[...incomingPortIds].sort().join(',')}|${[...outgoingPortIds].sort().join(',')}|${[...incomingNodeColors.entries()].map(([k, v]) => `${k}:${v}`).sort().join(',')}`
      return {
        signature,
        upstreamRefs,
        readiness,
        incomingCounts,
        outgoingCounts,
        incomingNodeColors,
        incomingPortIds,
        outgoingPortIds,
        inputStale
      }
    },
    (prev, next) =>
      prev.signature === next.signature &&
      prev.upstreamRefs.length === next.upstreamRefs.length &&
      prev.upstreamRefs.every((item, idx) => Object.is(item, next.upstreamRefs[idx])),
    [editor, shape, spec, inPorts, modelAvailable, projectedOutputs]
  )
  const readiness = readinessState.readiness
  const readinessWithFreshness =
    readinessState.inputStale && (readiness.kind === 'ready' || readiness.kind === 'manual-publish')
      ? {
          ...readiness,
          label: `${readiness.label} · 输入已修改`,
          detail: `${readiness.detail} 输入在上次成功运行后有修改，当前结果可能不再对应最新输入。`
        }
      : readiness
  const [inLayout, outLayout] = useMemo(() => {
    const candidateInPortIds = new Set(
      draftFrom && draftFrom.direction !== 'in' && !isSource
        ? inPorts.filter((port) => canAttachPort(draftFrom, port)).map((port) => port.id)
        : []
    )
    const candidateOutPortIds = new Set(
      draftFrom && draftFrom.direction === 'in' && !isSource
        ? outPorts.filter((port) => canAttachPort(draftFrom, port, 'in')).map((port) => port.id)
        : []
    )
    const dynamicPortIds = dynamicPortIdsForShape(shape)
    return [
      createNodePortLayout(
        inPorts,
        readinessState.incomingPortIds,
        shape.props.h,
        candidateInPortIds,
        dynamicPortIds.in
      ),
      createNodePortLayout(
        outPorts,
        readinessState.outgoingPortIds,
        shape.props.h,
        candidateOutPortIds,
        dynamicPortIds.out
      )
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dynamicPortIds only depends on shape props/meta
  }, [
    inPorts,
    outPorts,
    readinessState.incomingPortIds,
    readinessState.outgoingPortIds,
    shape.props.h,
    draftFrom,
    isSource
  ])
  const stackMeta = shape.meta as Record<string, unknown> | undefined
  const stackMember = stackMeta?.stackRole === 'member'
  const comboTop = stackMeta?.stackRole === 'top'
  const visibleInPorts = stackMember || iterationSnapshot ? [] : inLayout.ports
  const visibleOutPorts = stackMember || iterationSnapshot ? [] : outLayout.ports
  const visibleInY = inLayout.offsets
  const visibleOutY = outLayout.offsets

  /** 被更上层卡片盖住的端口不可见、不可命中：走编辑器级共享空间网格索引，未重叠卡 0 次重渲染。 */
  const occlusionSignature = useValue(
    'occluded node ports',
    () => nodePortOcclusionSignature(editor, shape.id),
    [editor, shape.id]
  )
  const occludedPortKeys = useMemo(
    () => (occlusionSignature ? new Set(occlusionSignature.split('|')) : EMPTY_STRING_SET),
    [occlusionSignature]
  )

  // 运行按钮常驻在标题行右侧（用户 2026-09-18 拍板：不能用时置灰，而不是消失）。
  // 置灰原因复用契约派生的 readiness，不引入第二套“能不能跑”的判断。
  const runBusy = activeExecution
  // 缺输入/缺正文（not-connected/config-missing）改为可点→弹窗补输入；
  // 缺模型/等待上游结果仍置灰（弹窗补不了）。
  const runInputGap =
    readiness.kind === 'blocked' &&
    (readiness.reason === 'not-connected' || readiness.reason === 'config-missing')
  const runBlockedReason = !project
    ? '项目未就绪'
    : runBusy
      ? '节点正在运行'
      : readiness.kind === 'blocked' && !runInputGap
        ? readinessWithFreshness.label
        : null
  const runTooltip =
    runBlockedReason ??
    (runInputGap ? `${readinessWithFreshness.label}（点击补充输入并运行）` : '运行节点')

  const openDescription = useCallback(
    () => useNodePanelStore.getState().open('contract', shape.id, 'overview'),
    [shape.id]
  )

  const autoFitEnabled =
    !isTemplateCard &&
    !isBoundaryMarker &&
    spec?.sizePolicy !== 'free' &&
    shape.meta.nodeHeightMode !== 'manual'

  // manual 节点不建 Observer，但仍须在旧项目迁移/超界写入时执行一次高度夹取并记录原始高度。
  useEffect(() => {
    if (
      isTemplateCard ||
      isBoundaryMarker ||
      spec?.sizePolicy === 'free' ||
      shape.props.nodeType === 'storyboard' ||
      shape.meta.nodeHeightMode !== 'manual'
    ) {
      return
    }
    const heightCap =
      shape.props.nodeType === 'video' ? NODE_UI.height.autoMaxVideoGen : NODE_UI.height.autoMax
    const current = shape.props.h
    const clamped = Math.max(260, Math.min(heightCap, current))
    if (clamped === current) return
    const frame = requestAnimationFrame(() => {
      if (editor.inputs.isDragging) return
      const latest = editor.getShape<NodeCardShape>(shape.id)
      if (!latest || latest.meta.nodeHeightMode !== 'manual') return
      const latestHeight = latest.props.h
      const latestClamped = Math.max(260, Math.min(heightCap, latestHeight))
      if (latestClamped === latestHeight) return
      editor.run(
        () =>
          editor.updateShape({
            id: latest.id,
            type: 'node-card',
            props: { h: latestClamped },
            meta: {
              ...latest.meta,
              nodeOriginalHeight: latest.meta.nodeOriginalHeight ?? latestHeight,
              nodeHeightMode: 'manual'
            }
          }),
        { history: 'ignore' }
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [
    editor,
    isBoundaryMarker,
    isTemplateCard,
    shape.id,
    shape.meta.nodeHeightMode,
    shape.props.h,
    shape.props.nodeType,
    spec?.sizePolicy
  ])

  // 全节点统一高度边界；旧尺寸仅迁移几何，不改业务内容。
  // manual/free/模板卡不创建 Observer；Observer 生命周期固定，不再随输入反复拆建。
  useEffect(() => {
    if (!autoFitEnabled) return
    const body = bodyRef.current
    const scroll = body?.closest<HTMLElement>('.node-standard-scroll')
    if (!body || !scroll) return
    let frame = 0
    let debounceTimer = 0
    let composing = false
    const fitHeight = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (editor.inputs.isDragging) return
        const latest = editor.getShape<NodeCardShape>(shape.id)
        if (!latest) return
        const metadata = latest.meta
        const current = latest.props.h
        // 视频生成节点引用多图时内容超过通用上限，允许跳到专用档，避免输出参数被裁掉。
        const heightCap =
          latest.props.nodeType === 'video'
            ? NODE_UI.height.autoMaxVideoGen
            : NODE_UI.height.autoMax
        if (getNodeType(latest.props.nodeType)?.sizePolicy === 'free') return
        if (metadata.iterationTemplateCard || metadata.iterationBoundary) return
        if (latest.props.nodeType === 'storyboard') {
          if (metadata.nodeHeightMode === 'manual') return
          const table = body.querySelector<HTMLTableElement>('.storyboard-table')
          const columns = table?.querySelectorAll('thead th').length ?? 2
          const width = Math.max(
            STORYBOARD_UI.width,
            Math.max(0, columns - 2) * STORYBOARD_UI.columnWidth + STORYBOARD_UI.tableChromeWidth
          )
          const content = body.querySelector<HTMLElement>('.storyboard-body')
          const height = Math.max(
            STORYBOARD_UI.height,
            (content?.scrollHeight ?? 0) +
              80 +
              (body.querySelector<HTMLElement>('.connected-inputs')?.offsetHeight ?? 0)
          )
          if (width !== latest.props.w || height !== current) {
            editor.run(
              () =>
                editor.updateShape({
                  id: latest.id,
                  type: 'node-card',
                  props: { w: width, h: height },
                  meta: { ...metadata, nodeHeightMode: 'auto' }
                }),
              { history: 'ignore' }
            )
          }
          return
        }
        const minimum = metadata.nodeHeightMode === 'manual' ? 260 : NODE_UI.height.min
        const clamped = Math.max(minimum, Math.min(heightCap, current))
        if (clamped !== current) {
          editor.run(
            () =>
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                props: { h: clamped },
                meta: {
                  ...metadata,
                  nodeOriginalHeight: metadata.nodeOriginalHeight ?? current,
                  nodeHeightMode: metadata.nodeHeightMode ?? (current === 260 ? 'auto' : 'manual')
                }
              }),
            { history: 'ignore' }
          )
          return
        }
        if (metadata.nodeHeightMode === 'manual') return
        if (
          !metadata.nodeHeightMode &&
          current !== 260 &&
          resolveNodeHeight(current, heightCap) !== current
        ) {
          editor.run(
            () =>
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                meta: { ...metadata, nodeHeightMode: 'manual' }
              }),
            { history: 'ignore' }
          )
          return
        }
        const references = body.querySelector<HTMLElement>('.connected-inputs')?.offsetHeight ?? 0
        const fittedPreview =
          ['image', 'image-split', 'image-crop', 'video-asset'].includes(latest.props.nodeType) ||
          (latest.props.nodeType === 'video' && Boolean(latest.props.mediaPath))
        let next: number
        if (fittedPreview) {
          next = resolveNodeHeight(
            NODE_UI.height.default + (references ? references + NODE_UI.reference.bottomGap : 0)
          )
        } else {
          const identity = scroll.querySelector<HTMLElement>('.node-standard-identity')
          const content = body.querySelector<HTMLElement>('.node-body-content')
          const natural = content
            ? Array.from(content.children).reduce((sum, child) => {
                if (!(child instanceof HTMLElement)) return sum
                if (
                  child.matches(
                    '.node-textarea[data-node-interactive="text-editor"], .node-textarea[data-node-interactive="json-editor"]'
                  )
                ) {
                  return sum + NODE_UI.textEditor.naturalHeight
                }
                const style = getComputedStyle(child)
                return (
                  sum +
                  Math.max(child.offsetHeight, child.scrollHeight) +
                  (Number.parseFloat(style.marginTop) || 0) +
                  (Number.parseFloat(style.marginBottom) || 0)
                )
              }, 0)
            : body.scrollHeight
          const required =
            NODE_UI.header.height +
            (scroll.parentElement?.querySelector<HTMLElement>('.node-standard-action-bar')
              ?.offsetHeight || NODE_UI.actionBar.bottomInset) +
            NODE_UI.content.padding +
            natural -
            (identity ? Math.max(0, identity.offsetHeight - NODE_UI.identity.minHeight) : 0) +
            references
          const prompt = body.querySelector<HTMLElement>('.gen-prompt')
          const promptLayout = prompt?.closest('.image-mention-prompt') ?? prompt
          const formMinimum =
            latest.props.nodeType === 'image-gen' && prompt
              ? required -
                natural +
                Array.from(promptLayout?.parentElement?.children ?? []).reduce(
                  (height, child) =>
                    child instanceof HTMLElement && child !== promptLayout
                      ? height + child.offsetHeight + 8
                      : height,
                  0
                ) +
                Math.max(72, Number.parseFloat(prompt.style.height) || 72) +
                (references ? 8 : 0)
              : required
          const referencedMinimum = references
            ? Math.max(NODE_UI.height.default, formMinimum - references - (prompt ? 8 : 0)) +
              references +
              8
            : formMinimum
          next = resolveNodeHeight(referencedMinimum, heightCap)
        }
        const focused = document.activeElement
        const editingInput =
          scroll.contains(focused) &&
          ((focused instanceof HTMLTextAreaElement && !focused.readOnly) ||
            (focused instanceof HTMLInputElement && !focused.readOnly) ||
            (focused instanceof HTMLElement && focused.isContentEditable))
        if (next < current && (composing || editingInput)) next = current
        if (next === current) return
        editor.run(
          () =>
            editor.updateShape({
              id: shape.id,
              type: 'node-card',
              props: { h: next },
              meta: { ...metadata, nodeHeightMode: 'auto' }
            }),
          { history: 'ignore' }
        )
      })
    }
    const scheduleFit = (): void => {
      if (debounceTimer) window.clearTimeout(debounceTimer)
      debounceTimer = window.setTimeout(fitHeight, 80)
    }
    const compositionStart = (): void => {
      composing = true
    }
    const compositionEnd = (): void => {
      composing = false
      fitHeight()
    }
    fitHeight()
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(scroll)
    const mutations = new MutationObserver(scheduleFit)
    mutations.observe(body, {
      childList: true,
      characterData: true,
      subtree: true
    })
    scroll.addEventListener('input', scheduleFit)
    scroll.addEventListener('focusout', fitHeight)
    scroll.addEventListener('compositionstart', compositionStart)
    scroll.addEventListener('compositionend', compositionEnd)
    return () => {
      cancelAnimationFrame(frame)
      if (debounceTimer) window.clearTimeout(debounceTimer)
      observer.disconnect()
      mutations.disconnect()
      scroll.removeEventListener('input', scheduleFit)
      scroll.removeEventListener('focusout', fitHeight)
      scroll.removeEventListener('compositionstart', compositionStart)
      scroll.removeEventListener('compositionend', compositionEnd)
    }
  }, [editor, shape.id, autoFitEnabled, shape.props.nodeType])

  // 端口 tooltip 只保留身份信息（呈现规范 v1.0 §11：名称 · 类型，类型给中文名），
  // 连接手势、多选建线等操作教学不再随 tooltip 重复。
  // 拖线过程中，兼容端口额外浮出端口名标签：圆点本身无法回答“这个口收的是什么”，
  // 而用户正是在这里最容易松错手；不兼容的端口保持淡出，校验不因可发现性而放宽。

  // 裁剪/拆图的主素材与轨道线的可拖入素材池由各自工作区承载。
  // 2026-10-05 节点引用整改决策（docs/CHANGELOG-2026-10-05-NODE-REFERENCES.md）：
  // 「AI 处理仅展示输出」——它的结果区占满正文，不再显示通用已连接输入条；
  // 2026-09-10 a69b1a8 重写该表达式时漏掉了 ai-process，导致 AI 处理重新出现引用条
  // 并挤占结果高度（test-browser-node-standard 第 174 行断言失败，2026-11-24 修复）。
  const hasDedicatedInputSurface = ['image-crop', 'image-split', 'timeline', 'ai-process'].includes(
    shape.props.nodeType
  )

  const spotlightClass = useFlowFocusStore((state) => {
    if (!state.spotlightEnabled || !state.focusedNodeId) return ''
    if (state.focusedNodeId === shape.id) {
      return state.attentionNodeId === shape.id
        ? 'is-flow-spotlight-focus is-flow-spotlight-attention'
        : 'is-flow-spotlight-focus'
    }
    if (state.inputSourceIds.has(shape.id)) return 'is-flow-spotlight-source'
    return 'is-flow-spotlight-dim'
  })

  return (
    <HTMLContainer style={{ pointerEvents: shape.opacity === 0 ? 'none' : 'all' }}>
      {/* 外层包一层无裁切的容器：端口圆点要压在卡片边缘外侧，不能被卡片 overflow:hidden 裁掉 */}
      <div
        className={`node-card-wrap ${selected ? 'is-selected' : ''} ${spotlightClass} ${shape.opacity === 0 ? 'is-opacity-hidden' : ''} ${isTemplateCard ? 'iteration-template-card' : ''} ${isBoundaryMarker ? 'iteration-boundary-marker' : ''} ${inTemplateContainer && !isTemplateCard && !isBoundaryMarker ? 'iteration-template-member' : ''} ${
          (shape.meta as Record<string, unknown> | undefined)?.stackRole === 'member'
            ? 'stack-member'
            : ''
        } ${
          (shape.meta as Record<string, unknown> | undefined)?.stackRole === 'top'
            ? 'stack-top'
            : ''
        }`}
        data-node-id={shape.id}
        style={{
          width: shape.props.w,
          height: shape.props.h,
          ['--node-spot-radius' as string]:
            Math.max(260, Math.hypot(shape.props.w, shape.props.h) * 0.55) + 'px',
          ['--node-header-h' as string]: `${NODE_UI.header.height}px`,
          ['--node-empty-icon-size' as string]: `${NODE_UI.identity.iconSize}px`,
          ['--node-port-outset' as string]: `${NODE_PORT_OUTSET}px`,
          ['--node-port-hit' as string]: `${NODE_PORT_SIZE}px`
        }}
        onPointerMoveCapture={(event) => {
          if (event.pointerType !== 'mouse' || !event.currentTarget.contains(event.target as Node))
            return
          spotlightPointRef.current = {
            x: event.clientX,
            y: event.clientY,
            el: event.currentTarget
          }
          if (spotlightFrameRef.current) return
          spotlightFrameRef.current = requestAnimationFrame(() => {
            spotlightFrameRef.current = 0
            const point = spotlightPointRef.current
            if (!point) return
            const bounds = point.el.getBoundingClientRect()
            point.el.style.setProperty(
              '--node-mouse-x',
              `${((point.x - bounds.left) / bounds.width) * 100}%`
            )
            point.el.style.setProperty(
              '--node-mouse-y',
              `${((point.y - bounds.top) / bounds.height) * 100}%`
            )
          })
        }}
        onPointerDown={handleCardPointerDown}
        onPointerDownCapture={(event) => {
          if (
            event.button !== 0 ||
            !(event.target instanceof Element) ||
            !event.currentTarget.contains(event.target)
          )
            return
          if (nodeSelectableText(event.target)) {
            if (
              !event.shiftKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !editor.getSelectedShapeIds().includes(shape.id)
            )
              editor.select(shape.id)
            event.stopPropagation()
            return
          }
          const field = nodeTextField(event.target)
          if (field) {
            // 用户要求：点击输入框直接进入输入态——放行原生 focus（不再 preventDefault），
            // 同时顺手选中节点；阻止冒泡避免 wrapper 启动节点拖拽。
            if (
              !event.shiftKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !editor.getSelectedShapeIds().includes(shape.id)
            )
              editor.select(shape.id)
            event.stopPropagation()
            return
          }
          if (nodeOwnsPointer(event.target)) {
            if (
              !event.shiftKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !editor.getSelectedShapeIds().includes(shape.id)
            )
              editor.select(shape.id)
            return
          }
          // Descendant blanket stopPropagation must not swallow selection or movement.
          // Use tldraw's public pointer API once, with its normal modifier/group/undo semantics.
          event.stopPropagation()
          const canvas = editor.getContainer().querySelector<HTMLElement>('.tl-canvas')
          canvas?.setPointerCapture(event.pointerId)
          editor.dispatch({
            type: 'pointer',
            name: 'pointer_down',
            target: 'shape',
            shape,
            ...getPointerInfo(editor, event)
          })
        }}
        onFocusCapture={(event) => {
          if (!event.currentTarget.contains(event.target)) return
          const field = event.target instanceof Element ? nodeTextField(event.target) : null
          if (!field || editor.getEditingShapeId() === shape.id) return
          field.dataset.nodeInlineEditing = 'true'
          editor.setEditingShape(shape.id)
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.target)) return
          if (
            !(event.target instanceof HTMLElement) ||
            event.target.dataset.nodeInlineEditing !== 'true'
          )
            return
          delete event.target.dataset.nodeInlineEditing
          if (editor.getEditingShapeId() === shape.id) editor.setEditingShape(null)
        }}
        onKeyDownCapture={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return
          if (
            event.key === 'Escape' &&
            event.target instanceof HTMLElement &&
            event.target.dataset.nodeInlineEditing === 'true'
          ) {
            // Let node-specific Escape handlers keep their save/cancel semantics first.
            const field = event.target
            requestAnimationFrame(() => {
              if (document.activeElement === field) field.blur()
              if (!field.isConnected && editor.getEditingShapeId() === shape.id)
                editor.setEditingShape(null)
            })
          }
        }}
      >
        <div className="node-header">
          {/* 标题行布局：左侧依次为 序号 → 图标 → 名称 → 可选字数 → 查看输入输出说明；
                状态灯保留在标题行，运行动作独立浮在卡片右上角，避免挤压标题。 */}
          <span className="node-seq" title={`节点序号 ${seq}`}>
            {String(seq).padStart(2, '0')}
          </span>
          <span
            className="node-icon"
            style={{ color: nodeIconColor(identitySpec?.color ?? nodePortColor) }}
          >
            {/* JSX 尺寸与 ui-surfaces 对 .node-icon svg 的强制 17px 保持一致 */}
            {identitySpec ? (
              <Icon name={identitySpec.icon} size={17} />
            ) : (
              <Icon name="help" size={17} />
            )}
          </span>
          <div
            ref={titleRef}
            className={`node-title ${titleEditable ? 'editable' : ''} ${editing ? 'editing' : ''}`}
            data-node-interactive="node-title"
            title={displayTitle}
            contentEditable={editing}
            suppressContentEditableWarning
            spellCheck={false}
            onDoubleClick={handleTitleDoubleClick}
            onBlur={handleTitleBlur}
            onPointerDown={handleTitlePointerDown}
            onCopy={(event) => {
              if (!editing) return
              const selection = window.getSelection()
              const text =
                selection &&
                event.currentTarget.contains(selection.anchorNode) &&
                event.currentTarget.contains(selection.focusNode)
                  ? selection.toString()
                  : ''
              event.clipboardData.setData(
                'text/plain',
                text || event.currentTarget.textContent || ''
              )
              event.preventDefault()
              event.stopPropagation()
            }}
            onKeyDown={(e) => {
              if (editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c')
                e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.currentTarget as HTMLDivElement).blur()
              }
            }}
          >
            {displayTitle}
          </div>
          {/* 文本节点字数徽标：位于“查看输入输出说明”左侧。
                格式见 formatCharCount（N 字 / N 多字 / X.XK）。 */}
          {shape.props.nodeType === 'text' && shape.props.text && (
            <span className="node-text-count">{formatCharCount(shape.props.text.length)}</span>
          )}
          <span className="node-header-spacer" />
          <span ref={setHeaderActions} className="node-header-file-actions" />
          {/* info 按钮（查看输入输出说明）：点击显式打开右侧契约面板。
              对话节点也必须能查看与其他节点相同的输入输出契约。标题必须和 openNodePanel 的
              去向一致——预演台从卡片按钮进，这里写「打开 3D 预演台」会是假提示。
              折叠组合的首位卡不提供单节点属性入口，组合级操作在右上角图标。 */}
          {!comboTop && !iterationSnapshot && (
            <button
              className="node-info-btn"
              title="查看输入输出说明"
              aria-label="打开节点说明"
              onPointerDown={handleInfoOpen}
              onClick={(e) => {
                e.stopPropagation()
                openNodePanel()
              }}
            >
              <Icon name="document" size={16} />
            </button>
          )}
          {/* 弹性占位：运行与状态都固定在标题行的右侧。
              折叠组合的首位卡隐藏单节点状态与运行入口，组合级运行在右上角图标。 */}
          {!comboTop && !iterationSnapshot && (
            <>
              {shape.meta.nodeHeightMode === 'manual' && (
                <button
                  className="node-info-btn"
                  aria-label={
                    shape.props.nodeType === 'storyboard' ? '恢复内容自适应' : '恢复自动高度'
                  }
                  title={shape.props.nodeType === 'storyboard' ? '恢复内容自适应' : '恢复自动高度'}
                  onPointerDown={stopEventPropagation}
                  onClick={(event) => {
                    event.stopPropagation()
                    editor.updateShape({
                      id: shape.id,
                      type: 'node-card',
                      meta: { ...shape.meta, nodeHeightMode: 'auto' }
                    })
                  }}
                >
                  <Icon name="arrow" size={16} />
                </button>
              )}
              <span
                className={`node-status node-status-${shape.props.exec}`}
                style={{ background: EXEC_COLORS[shape.props.exec] ?? EXEC_COLORS.idle }}
                title={`${statusLabel} · ${readinessWithFreshness.label}`}
                aria-label={`${statusLabel} · ${readinessWithFreshness.label}`}
              />
              {spec?.executor && (
                <span className="node-action-float" aria-label="节点动作">
                  <Tooltip label={runTooltip}>
                    <button
                      className="node-run-btn"
                      aria-label="运行节点"
                      disabled={Boolean(runBlockedReason)}
                      onPointerDown={(event) => stopEventPropagation(event)}
                      onClick={(event) => {
                        stopEventPropagation(event)
                        if (project && !runBlockedReason) {
                          void runNodeManually(
                            editor,
                            project.id,
                            providers,
                            shape.id,
                            undefined,
                            undefined,
                            undefined,
                            guiWorkflowInputOptions
                          )
                        }
                      }}
                    >
                      {/* 与 ui-surfaces 对 .node-run-btn svg 的强制 16px 保持一致 */}
                      <Icon name="play" size={16} />
                    </button>
                  </Tooltip>
                </span>
              )}
            </>
          )}
        </div>
        <span className="node-hover-spot" aria-hidden="true" />
        {selected && <span className="node-selection-beam" aria-hidden="true" />}
        <div
          className={`node-card type-${shape.props.nodeType}${isTemplateCard ? ' iteration-template-card' : ''}`}
          data-node-type={shape.props.nodeType}
          style={{
            ['--node-accent' as string]: identitySpec?.color ?? '#42b9f5',
            ['--node-identity-accent' as string]: identitySpec?.color ?? '#42b9f5',
            ['--node-action-bottom-inset' as string]: `${NODE_UI.actionBar.bottomInset}px`,
            ['--node-standard-action-height' as string]: `${NODE_UI.actionBar.height}px`
          }}
        >
          {isBoundaryMarker ? (
            /* 边界圆点：纯圆点视觉接口，绕过标准卡片 chrome（无图标/序号/文案）。 */
            <div className="node-body">
              <IterationBoundaryBody shape={shape} />
            </div>
          ) : (
            <>
              {isTemplateCard &&
                Boolean((shape.meta as Record<string, unknown>)?.iterationTemplateExpanded) && (
                  <>
                    {/* 输入/输出圆点：框卡呈现层元素，永远贴框左右边垂直中点、随框移动。 */}
                    <span className="iteration-frame-dot is-input" />
                    <span className="iteration-frame-dot is-output" />
                  </>
                )}
              {/* 保留 DOM 锚点以兼容旧快照；视觉改由 card 左上角的 45° 类型切角承担。 */}
              <div
                className="node-color-bar"
                style={{ ['--node-accent' as string]: identitySpec?.color ?? '#42b9f5' }}
              />
              {spec && (
                <NodeCardShell
                  spec={spec}
                  busy={activeExecution}
                  header={headerActions}
                  openDescription={openDescription}
                >
                  <div ref={bodyRef} className="node-body">
                    {comboTop ? (
                      /* 折叠组合的首位卡：组合内单个节点的正文失去意义，
                         只呈现组合规模与操作提示，具体内容展开后查看。 */
                      <div className="node-combo-summary">
                        <span className="node-combo-hint">右上角图标可展开或运行整个组合</span>
                      </div>
                    ) : (
                      <>
                        {!hasDedicatedInputSurface && (
                          <ConnectedInputPreview
                            editor={editor}
                            shape={shape}
                            openPreview={openMediaPreview}
                          />
                        )}
                        <div className="node-body-content">
                          <FlowReviewFeedback shape={shape} />
                          {isTemplateCard ? (
                            <div
                              onDoubleClick={(e) => {
                                e.stopPropagation()
                                toggleIterationTemplate(editor, shape)
                              }}
                            >
                              <IterationTemplateBody shape={shape} />
                            </div>
                          ) : iterationSnapshot ? (
                            <IterationSnapshotBody shape={shape} />
                          ) : readFlowAssetSnapshot(shape) ? (
                            <FixedFlowAssetBody shape={shape} openPreview={openMediaPreview} />
                          ) : (
                            <MemoizedNodeBody
                              Body={spec.Body}
                              shape={shape}
                              openPreview={openMediaPreview}
                              upstreamToken={readinessState.upstreamRefs}
                            />
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </NodeCardShell>
              )}
              {!spec && (
                <div className="node-body">
                  <div className="node-empty">未知节点类型：{shape.props.nodeType}</div>
                </div>
              )}
            </>
          )}
        </div>
        {activeExecution && spec?.executor && (
          <NodeExecutionOverlay
            editor={editor}
            shape={shape}
            nodeRun={nodeRun}
            configuredProviderKey={configuredProviderKey}
            configuredModelKey={configuredModelKey}
            imageProviderKey={imageProviderKey}
            imageModelKey={imageModelKey}
            imageCount={imageCount}
          />
        )}
        {/* 输入端口（左侧）：out 方向拖线时按类型兼容高亮；从输入端口也可发起反向连线 */}
        {visibleInPorts.map((p) => {
          if (occludedPortKeys.has(`in:${p.id}`)) return null
          const draftIn = draftFrom && draftFrom.direction === 'in' ? draftFrom : null
          const isAnchor = draftIn && draftIn.shapeId === shape.id && draftIn.portId === p.id
          const ok =
            draft && draft.from.direction !== 'in'
              ? !isSource && canAttachPort(draft.from, p)
              : false
          const connectedPort = inPorts.find(
            (candidate) =>
              candidate.type === p.type && readinessState.incomingPortIds.has(candidate.id)
          )
          const isConnected = Boolean(connectedPort)
          const inputColor =
            (ok && draftFrom?.nodeColor) ||
            (connectedPort && readinessState.incomingNodeColors.get(connectedPort.id)) ||
            nodePortColor
          const portKey = `in:${p.id}`
          return (
            <span
              key={p.id}
              className={`port-dot in ${isConnected ? 'connected' : 'unconnected'} ${isAnchor ? 'ok' : draftFrom && draftFrom.direction !== 'in' ? (ok ? 'ok' : 'dim') : ''}`}
              data-port-id={p.id}
              style={{
                top: (visibleInY.get(p.id) ?? shape.props.h / 2) - NODE_PORT_SIZE / 2,
                ['--pc' as string]: inputColor,
                ['--node-port-color' as string]: inputColor
              }}
              aria-label={portHint(p)}
              onPointerEnter={(event) => updatePortFollow(event, portKey)}
              onPointerMove={(event) => updatePortFollow(event, portKey)}
              onPointerLeave={(event) => clearPortFollow(event, portKey)}
              onPointerDown={(e) => {
                stopEventPropagation(e)
                beginConnectionDrag(
                  {
                    shapeId: shape.id,
                    portId: p.id,
                    portType: p.type,
                    nodeColor: nodePortColor,
                    schema: p.schema,
                    direction: 'in'
                  },
                  portCenter(e, portKey)
                )
              }}
            >
              <span className="port-radar" aria-hidden="true" />
              <span className="port-core" aria-hidden="true" />
            </span>
          )
        })}

        {/* 产物节点溯源输入圆点：宫格拆分等节点产出的独立图片/视频节点，虽然不是 DAG 消费端，
            但在视觉上有追溯连线连接。按规范“节点与节点之间一定连接的是圆连接点”，此处在左侧
            居中渲染溯源圆点，让追溯连线精确落在圆连接点上。 */}
        {inPorts.length === 0 &&
          !occludedPortKeys.has('in:artifact') &&
          shape.meta.artifactLinkHidden !== true &&
          Boolean(artifactProducerId) && (
            <span
              key="artifact-in-provenance"
              className="port-dot in connected input-optional"
              style={{
                top: shape.props.h / 2 - NODE_PORT_SIZE / 2,
                ['--pc' as string]: artifactProducerColor,
                ['--node-port-color' as string]: artifactProducerColor
              }}
              aria-label="来源产物连线"
            >
              <span className="port-radar" aria-hidden="true" />
              <span className="port-core" aria-hidden="true" />
            </span>
          )}

        {/* 输出端口：与输入端口同样是纯圆形，按住后拖出连线；in 方向拖线时反向高亮。 */}
        {visibleOutPorts.map((p) => {
          if (occludedPortKeys.has(`out:${p.id}`)) return null
          const hasOutput = outPorts.some(
            (candidate) => candidate.type === p.type && Boolean(projectedOutputs[candidate.id])
          )
          const isConnected = outPorts.some(
            (candidate) =>
              candidate.type === p.type && readinessState.outgoingPortIds.has(candidate.id)
          )
          const draftIn = draftFrom && draftFrom.direction === 'in' ? draftFrom : null
          const okUpstream = draftIn && !isSource ? canAttachPort(draftIn, p, 'in') : false
          const portKey = `out:${p.id}`
          return (
            <span
              key={p.id}
              className={`port-dot out ${hasOutput ? 'has-output' : 'no-output'} ${isConnected ? 'connected' : 'unconnected'} ${isSource && draftFrom?.portId === p.id && draftFrom.direction !== 'in' ? 'ok' : ''} ${draftIn ? (okUpstream ? 'ok' : 'dim') : ''}`}
              data-port-id={p.id}
              style={{
                top: (visibleOutY.get(p.id) ?? shape.props.h / 2) - NODE_PORT_SIZE / 2,
                ['--pc' as string]: nodePortColor,
                ['--node-port-color' as string]: nodePortColor
              }}
              aria-label={portHint(p)}
              onPointerEnter={(event) => updatePortFollow(event, portKey)}
              onPointerMove={(event) => updatePortFollow(event, portKey)}
              onPointerLeave={(event) => clearPortFollow(event, portKey)}
              onPointerDown={(e) => {
                stopEventPropagation(e)
                const selectedNodeIds = editor
                  .getSelectedShapes()
                  .filter((candidate) => candidate.type === 'node-card')
                  .map((candidate) => candidate.id)
                const batch = selectedNodeIds.includes(shape.id)
                  ? batchConnectionFromSelection(editor, selectedNodeIds, p.id)
                  : null
                beginConnectionDrag(
                  batch
                    ? { ...batch, nodeColor: nodePortColor }
                    : {
                        shapeId: shape.id,
                        portId: p.id,
                        portType: p.type,
                        nodeColor: nodePortColor,
                        schema: p.schema
                      },
                  portCenter(e, portKey)
                )
              }}
            >
              <span className="port-radar" aria-hidden="true" />
              <span className="port-core" aria-hidden="true" />
            </span>
          )
        })}
      </div>
      {/* tldraw 画布容器带 transform，fixed 元素会以它为包含块导致错位，必须 portal 到 body */}
      {preview &&
        createPortal(
          <div
            className="media-preview-mask"
            role="dialog"
            aria-modal="true"
            aria-label="媒体预览"
            onPointerDown={(event) => stopEventPropagation(event)}
            onClick={(event) => {
              stopEventPropagation(event)
              if (event.target === event.currentTarget) setPreview(null)
            }}
          >
            <div
              className={`media-preview-box media-preview-${preview.kind}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="media-preview-title">
                <span>{preview.title}</span>
                <span className="media-preview-actions">
                  <button
                    className="icon-btn"
                    title="在资源管理器中定位"
                    aria-label="在资源管理器中定位"
                    onClick={(e) => {
                      e.stopPropagation()
                      void window.api.revealMedia(shape.props.mediaId)
                    }}
                  >
                    <Icon name="target" size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="复制文件路径"
                    aria-label="复制文件路径"
                    onClick={(e) => {
                      e.stopPropagation()
                      void window.api
                        .copyMediaPath(shape.props.mediaId)
                        .then((result) =>
                          toast(result.ok && result.data ? '复制成功' : '复制失败，请重试')
                        )
                        .catch(() => toast('复制失败，请重试'))
                    }}
                  >
                    <Icon name="copy" size={14} />
                  </button>
                </span>
                <button
                  className="icon-btn"
                  title="关闭预览"
                  aria-label="关闭预览"
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onClick={(e) => {
                    e.stopPropagation()
                    setPreview(null)
                  }}
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
              <div className="media-preview-stage">
                {preview.kind === 'image' && <img src={preview.url} alt={preview.title} />}
                {preview.kind === 'video' && (
                  <>
                    <video
                      key={preview.url}
                      src={preview.url}
                      controls
                      autoPlay
                      playsInline
                      preload="auto"
                      onLoadedMetadata={() => setPreviewError(null)}
                      onError={() =>
                        setPreviewError(
                          preview.url.startsWith('blob:')
                            ? '该临时视频已失效，请重新上传后预览。'
                            : '视频无法解码或读取。请确认文件完整，并优先使用 H.264 MP4 或 WebM。'
                        )
                      }
                    />
                    {previewError ? (
                      <p className="media-preview-error" role="alert">
                        {previewError}
                      </p>
                    ) : null}
                  </>
                )}
                {preview.kind === 'audio' && <audio src={preview.url} controls autoPlay />}
              </div>
            </div>
          </div>,
          document.body
        )}
    </HTMLContainer>
  )
}
