import { checkModelAvailability, providerAvailabilityKey } from './model-availability'
import type { ModelOperation } from '@free-creation/model-contracts'
import { nodePageIndex } from './node-page-index'
// NodeCard 卡片视图：头部（序号/图标/标题/状态灯）+ 类型化内容体 + 端口圆点 + 媒体预览浮层
import { HTMLContainer, stopEventPropagation, useEditor, useValue } from 'tldraw'
import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { getNodePorts, getNodeType, nodeIconColor, PORT_TYPE_LABELS } from '../nodes/registry'
import type { PortDecl, PortSchemaRef, PortType } from '@shared/types'
import { useConnectionStore } from '../stores/connection'
import { useNodePanelStore } from '../stores/nodePanel'
import { beginConnectionDrag } from './connection-drag'
import { batchConnectionFromSelection } from './batch-connection'
import { dynamicPortIdsForShape, portPairCompatible } from './graph'
import { markUndoPoint } from './history'
import type { NodeCardShape } from './NodeCardShape'
import { Icon } from '../components/Icon'
import { NODE_UI, resolveNodeHeight } from './node-ui-tokens'
import { nodeExecLabel } from './node-status'
import { currentNodeFingerprint, successfulInputFingerprint } from '../engine/resultFreshness'
import { projectNodeOutputs } from '../nodes/nodeValues'
import { deriveNodeReadiness } from './node-readiness'
import { runNodeManually } from '../engine/executor'
import { useAppStore } from '../stores/app'
import { useGatewayStore } from '../stores/gateway'
import { Tooltip } from '../components/Tooltip'
import { NODE_PORT_OUTSET, NODE_PORT_SIZE } from './edge-geometry'
import { createNodePortLayout } from './node-port-layout'
import { ConnectedInputPreview } from './ConnectedInputPreview'
import { GenerationLoadingOverlay } from './GenerationLoadingOverlay'
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
import { readNodeRunHistory, readNodeRunRecord } from '../engine/runRecord'
import type { GenerationTimingSample } from '@shared/contracts'
import { estimateGenerationDuration } from './generation-time-estimate'
import './image-gen-adaptive.css'
import { NodeCardShell } from './NodePresentation'

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
  const modelCheckKey = `${shape.props.nodeType}:${shape.props.config}:${providersKey}`
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
      chat: { feature: 'text.chat', operation: 'text.generate' }
    }
    const target = features[shape.props.nodeType]
    let cancelled = false
    if (target) {
      let config: { featureKey?: string; modelKey?: string } = {}
      try {
        config = JSON.parse(shape.props.config || '{}')
      } catch {
        /* executor owns invalid config errors */
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
  }, [shape.props.nodeType, shape.props.config, stableProviders, modelCheckKey])
  const spec = getNodeType(shape.props.nodeType)
  const displayTitle =
    shape.props.nodeType === 'speech' && shape.props.title === '配音'
      ? '语音合成'
      : shape.props.title
  const draft = useConnectionStore((s) => s.draft)
  const [preview, setPreview] = useState<{
    url: string
    kind: 'image' | 'video' | 'audio'
    title: string
  } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [portFollow, setPortFollow] = useState<PortFollowPosition | null>(null)
  const portFollowRef = useRef<PortFollowPosition | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const titleEditable = true

  /** 圆点只在节点外侧的半圆命中区内随鼠标移动。 */
  const updatePortFollow = (
    event: React.PointerEvent<HTMLSpanElement>,
    key: string,
    side: 'in' | 'out'
  ): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    let x = event.clientX - (rect.left + rect.width / 2)
    let y = event.clientY - (rect.top + rect.height / 2)
    x = side === 'out' ? Math.max(0, x) : Math.min(0, x)
    const radius = 16
    const length = Math.hypot(x, y)
    if (length > radius) {
      const ratio = radius / length
      x *= ratio
      y *= ratio
    }
    const position = { key, x, y }
    portFollowRef.current = position
    setPortFollow((current) =>
      current?.key === key && Math.abs(current.x - x) < 0.5 && Math.abs(current.y - y) < 0.5
        ? current
        : position
    )
  }

  const clearPortFollow = (key: string): void => {
    if (portFollowRef.current?.key !== key) return
    portFollowRef.current = null
    setPortFollow(null)
  }

  const portFollowStyle = (key: string): Record<string, string> => {
    const position = portFollow?.key === key ? portFollow : null
    return position
      ? {
          ['--port-follow-x' as string]: `${position?.x ?? 0}px`,
          ['--port-follow-y' as string]: `${position?.y ?? 0}px`
        }
      : {}
  }

  /** 连线起点取随鼠标移动后的可见圆心，而不是透明命中区中的任意点。 */
  const portCenter = (
    event: React.PointerEvent<HTMLSpanElement>,
    key: string
  ): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    const follow = portFollowRef.current?.key === key ? portFollowRef.current : null
    return {
      x: rect.left + rect.width / 2 + (follow?.x ?? 0),
      y: rect.top + rect.height / 2 + (follow?.y ?? 0)
    }
  }

  // 预览切换时不能沿用上一份媒体的错误状态；尤其是同一节点重新生成视频后，
  // 新输出应立即获得一个干净的播放器，而不是继续显示旧文件的加载错误。
  const openMediaPreview = (next: {
    url: string
    kind: 'image' | 'video' | 'audio'
    title: string
  }): void => {
    setPreviewError(null)
    setPreview(next)
  }
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

  const beginTitleEditing = (): void => {
    if (!titleEditable) return
    setEditing(true)
    requestAnimationFrame(() => titleRef.current?.focus())
  }

  // 双击标题进入编辑模式。原生 CustomEvent 是画布捕获指针后的可靠桥接，
  // 否则 tldraw 会把第二击的 dblclick 重定向到画布而不是标题元素。
  useEffect(() => {
    const title = titleRef.current
    if (!title) return
    title.addEventListener('canvas:edit-node-title', beginTitleEditing)
    return () => title.removeEventListener('canvas:edit-node-title', beginTitleEditing)
  })

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
    if (
      shape.props.nodeType === 'ai-process' &&
      event.target instanceof Element &&
      event.target.closest('.node-standard-scroll')
    )
      stopEventPropagation(event)
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

  const portsKey = JSON.stringify(spec ? getNodePorts(spec, shape) : { in: [], out: [] })
  // JSON key is an immutable value snapshot; cloned port data is never mutated.
  const resolvedPorts = useMemo(
    () => JSON.parse(portsKey) as { in: PortDecl[]; out: PortDecl[] },
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- immutable serialized contract snapshot
    [portsKey]
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
  const isSource = draft?.from.shapeId === shape.id
  const statusLabel = nodeExecLabel(shape.props.exec)
  const activeExecution = ['pending', 'queued', 'running'].includes(shape.props.exec)
  const nodeRun = readNodeRunRecord(shape.meta?.nodeRun)
  const imageRun = shape.props.nodeType === 'image-gen' ? nodeRun : null
  const imageRunActive = Boolean(
    shape.props.nodeType === 'image-gen' && activeExecution && imageRun?.status === 'running'
  )
  const nodeConfig = (() => {
    try {
      const parsed = JSON.parse(shape.props.config) as Record<string, unknown>
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  })()
  const textConfig = (() => {
    try {
      const parsed = JSON.parse(shape.props.text) as Record<string, unknown>
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  })()
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
    typeof nodeConfig?.providerKey === 'string' && nodeConfig.providerKey
      ? nodeConfig.providerKey
      : typeof nodeConfig?.modelKey === 'string'
        ? nodeConfig.modelKey.split('::')[0]
        : ''
  const imageModelKey = typeof nodeConfig?.modelKey === 'string' ? nodeConfig.modelKey : ''
  const imageCount =
    typeof nodeConfig?.count === 'number' && Number.isFinite(nodeConfig.count)
      ? Math.max(1, Math.min(9, Math.floor(nodeConfig.count)))
      : 1
  const [imageTimingEstimateMs, setImageTimingEstimateMs] = useState(
    DEFAULT_IMAGE_GENERATION_ESTIMATE_MS
  )
  const [executionElapsedMs, setExecutionElapsedMs] = useState(0)
  const [generationTimingSamples, setGenerationTimingSamples] = useState<GenerationTimingSample[]>(
    []
  )
  const timingRecordedRunRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeExecution || nodeRun?.status !== 'running') return
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
    activeExecution,
    nodeRun?.runId,
    nodeRun?.status,
    nodeRun?.startedAt,
    shape.props.nodeType,
    imageProviderKey,
    imageModelKey,
    imageCount
  ])

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
    activeExecution,
    nodeRun?.status,
    shape.props.nodeType,
    imageRun?.runId,
    imageRun?.status,
    imageRun?.durationMs,
    imageRun?.finishedAt,
    imageProviderKey,
    imageModelKey,
    imageCount
  ])

  const nodeRunDurationEstimateMs = useValue(
    'node execution average duration',
    () => {
      const runs = editor.getCurrentPageShapes().flatMap((candidate) => {
        if (candidate.type !== 'node-card' || candidate.props.nodeType !== shape.props.nodeType) {
          return []
        }
        const history = readNodeRunHistory(candidate.meta?.nodeRunHistory)
        const latest = readNodeRunRecord(candidate.meta?.nodeRun)
        const uniqueRuns = new Map(history.map((run) => [run.runId, run]))
        if (latest && latest.status !== 'running') uniqueRuns.set(latest.runId, latest)
        return [...uniqueRuns.values()]
          .filter((run) => run.status === 'success' && typeof run.durationMs === 'number')
          .map((run) => ({
            durationMs: run.durationMs!,
            providerId: run.target?.providerId,
            modelId: run.target?.modelId,
            recordedAt: run.finishedAt ?? run.startedAt
          }))
      })
      const exactModelRuns = configuredModelKey
        ? runs.filter((run) => run.modelId === configuredModelKey)
        : []
      const exactProviderRuns = configuredProviderKey
        ? runs.filter((run) => run.providerId === configuredProviderKey)
        : []
      const matchingRuns = exactModelRuns.length
        ? exactModelRuns
        : exactProviderRuns.length
          ? exactProviderRuns
          : runs
      const recentDurations = matchingRuns
        .sort((left, right) => right.recordedAt - left.recordedAt)
        .slice(0, 20)
        .map((run) => run.durationMs)
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
    activeExecution && nodeRun?.status === 'running'
      ? shape.props.nodeType === 'image-gen'
        ? imageGenerationProgressPercent(executionElapsedMs, executionEstimateMs)
        : nodeExecutionProgressPercent(executionElapsedMs, executionEstimateMs)
      : 0
  const remainingEstimateMs = executionEstimateMs - executionElapsedMs
  const executionLabel: Record<string, string> = {
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
  const executionTitle = executionLabel[shape.props.nodeType] ?? '节点执行中'
  const readinessState = useValue(
    'node readiness',
    () => {
      const incomingCounts = new Map<string, number>()
      const availableInputCounts = new Map<string, number>()
      const outgoingCounts = new Map<string, number>()
      const incomingNodeColors = new Map<string, string>()
      const incomingPortIds = new Set<string>()
      const outgoingPortIds = new Set<string>()
      for (const arrow of nodePageIndex(editor).arrows.get(shape.id) ?? []) {
        if (arrow.type !== 'arrow') continue
        const bindings = editor.getBindingsFromShape(arrow.id, 'arrow')
        if (typeof arrow.meta?.toPort === 'string') {
          const end = bindings.find((binding) => binding.props.terminal === 'end')
          if (end?.toId === shape.id) {
            incomingCounts.set(arrow.meta.toPort, (incomingCounts.get(arrow.meta.toPort) ?? 0) + 1)
            incomingPortIds.add(arrow.meta.toPort)
            const start = bindings.find((binding) => binding.props.terminal === 'start')
            const source = start ? editor.getShape<NodeCardShape>(start.toId) : undefined
            const sourceOutput =
              source?.type === 'node-card' && typeof arrow.meta.fromPort === 'string'
                ? projectNodeOutputs(source)[arrow.meta.fromPort]
                : undefined
            if (sourceOutput)
              availableInputCounts.set(
                arrow.meta.toPort,
                (availableInputCounts.get(arrow.meta.toPort) ?? 0) + 1
              )
            const sourceColor =
              source?.type === 'node-card' ? getNodeType(source.props.nodeType)?.color : undefined
            // 同类型的多值输入共用一个连接点，按第一条真实来源取色。
            if (sourceColor && !incomingNodeColors.has(arrow.meta.toPort)) {
              incomingNodeColors.set(arrow.meta.toPort, sourceColor)
            }
          }
        }
        if (typeof arrow.meta?.fromPort === 'string') {
          const start = bindings.find((binding) => binding.props.terminal === 'start')
          if (start?.toId === shape.id) {
            outgoingPortIds.add(arrow.meta.fromPort)
            outgoingCounts.set(
              arrow.meta.fromPort,
              (outgoingCounts.get(arrow.meta.fromPort) ?? 0) + 1
            )
          }
        }
      }
      for (const card of nodePageIndex(editor).artifacts.get(shape.id) ?? []) {
        if (card.type !== 'node-card') continue
        const meta = card.meta as Record<string, unknown> | undefined
        if (
          meta?.artifactProducerId === shape.id &&
          typeof meta.artifactProducerPortId === 'string'
        ) {
          outgoingPortIds.add(meta.artifactProducerPortId)
          outgoingCounts.set(
            meta.artifactProducerPortId,
            (outgoingCounts.get(meta.artifactProducerPortId) ?? 0) + 1
          )
        }
      }
      return {
        readiness: deriveNodeReadiness({
          executionMode: spec?.executionMode ?? 'auto',
          exec: shape.props.exec,
          nodeType: shape.props.nodeType,
          text: shape.props.text,
          inputs: inPorts,
          incomingCounts,
          availableInputCounts,
          modelAvailable,
          outputs: spec?.projectOutputs?.(shape) ?? {}
        }),
        incomingCounts,
        outgoingCounts,
        incomingNodeColors,
        incomingPortIds,
        outgoingPortIds,
        // T09（F08）：当前输入指纹与上次成功运行不一致 = 输入已修改。
        // 使用与执行器相同的正文、配置、真实端口与输入产物口径。
        inputStale: (() => {
          const fingerprint = successfulInputFingerprint(shape)
          return Boolean(fingerprint && currentNodeFingerprint(editor, shape) !== fingerprint)
        })()
      }
    },
    [editor, shape, spec, inPorts, modelAvailable]
  )
  const readiness = readinessState.readiness
  // T09：输入已修改时在状态文案后追加标注——只标注不阻断：旧结果保留且仍可
  // 作为下游输入，是否重新生成由用户决定。
  const readinessWithFreshness =
    readinessState.inputStale && (readiness.kind === 'ready' || readiness.kind === 'manual-publish')
      ? {
          ...readiness,
          label: `${readiness.label} · 输入已修改`,
          detail: `${readiness.detail} 输入在上次成功运行后有修改，当前结果可能不再对应最新输入。`
        }
      : readiness
  // 每侧每种数据类型呈现一个连接点：同类型端口共用锚点，不同类型分别均分卡片高度。
  // 可见圆点始终绑定真实契约 portId，拖线候选只选择同类型组中的代表端口。
  // 用户显式声明的动态端口（代码参数/输出字段）例外：始终渲染且各自独立锚点。
  const candidateInPortIds = new Set(
    draft && draft.from.direction !== 'in' && !isSource
      ? inPorts.filter((port) => canAttachPort(draft.from, port)).map((port) => port.id)
      : []
  )
  const candidateOutPortIds = new Set(
    draft && draft.from.direction === 'in' && !isSource
      ? outPorts.filter((port) => canAttachPort(draft.from, port, 'in')).map((port) => port.id)
      : []
  )
  const dynamicPortIds = dynamicPortIdsForShape(shape)
  const layoutKey = JSON.stringify([
    inPorts,
    outPorts,
    [...readinessState.incomingPortIds],
    [...readinessState.outgoingPortIds],
    shape.props.h,
    [...candidateInPortIds],
    [...candidateOutPortIds],
    [...dynamicPortIds.in],
    [...dynamicPortIds.out]
  ])
  const [inLayout, outLayout] = useMemo(() => {
    const [
      inputs,
      outputs,
      incoming,
      outgoing,
      height,
      candidatesIn,
      candidatesOut,
      dynamicIn,
      dynamicOut
    ] = JSON.parse(layoutKey) as [
      PortDecl[],
      PortDecl[],
      string[],
      string[],
      number,
      string[],
      string[],
      string[],
      string[]
    ]
    return [
      createNodePortLayout(
        inputs,
        new Set(incoming),
        height,
        new Set(candidatesIn),
        new Set(dynamicIn)
      ),
      createNodePortLayout(
        outputs,
        new Set(outgoing),
        height,
        new Set(candidatesOut),
        new Set(dynamicOut)
      )
    ]
  }, [layoutKey])
  const visibleInPorts = inLayout.ports
  const visibleOutPorts = outLayout.ports
  const visibleInY = inLayout.offsets
  const visibleOutY = outLayout.offsets

  /** 被更上层卡片盖住的端口不可见、不可命中，不能从节点覆盖关系中穿透出来。 */
  const occludedPortKeys = useValue(
    'occluded node ports',
    () => {
      const bounds = editor.getShapePageBounds(shape.id)
      if (!bounds) return new Set<string>()
      const coveringBounds = editor
        .getCurrentPageShapes()
        .filter(
          (candidate): candidate is NodeCardShape =>
            candidate.type === 'node-card' &&
            candidate.id !== shape.id &&
            candidate.index.localeCompare(shape.index) > 0
        )
        .map((candidate) => editor.getShapePageBounds(candidate.id))
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
      const isCovered = (x: number, y: number): boolean =>
        coveringBounds.some(
          (cover) =>
            x >= cover.x - 12 && x <= cover.maxX + 12 && y >= cover.y - 12 && y <= cover.maxY + 12
        )
      const pageY = (offset: number): number =>
        shape.props.h > 0 ? bounds.y + (bounds.height * offset) / shape.props.h : bounds.y
      const keys = new Set<string>()
      visibleInPorts.forEach((port) => {
        if (isCovered(bounds.x - NODE_PORT_OUTSET, pageY(visibleInY.get(port.id) ?? 0)))
          keys.add(`in:${port.id}`)
      })
      visibleOutPorts.forEach((port) => {
        if (isCovered(bounds.maxX + NODE_PORT_OUTSET, pageY(visibleOutY.get(port.id) ?? 0))) {
          keys.add(`out:${port.id}`)
        }
      })
      if (
        inPorts.length === 0 &&
        isCovered(bounds.x - NODE_PORT_OUTSET, bounds.y + bounds.height / 2)
      ) {
        keys.add('in:artifact')
      }
      return keys
    },
    [
      editor,
      shape.id,
      shape.index,
      shape.props.h,
      visibleInPorts,
      visibleOutPorts,
      visibleInY,
      visibleOutY
    ]
  )

  // 运行按钮常驻在标题行右侧（用户 2026-09-18 拍板：不能用时置灰，而不是消失）。
  // 置灰原因复用契约派生的 readiness，不引入第二套“能不能跑”的判断。
  const runBusy = activeExecution
  const runBlockedReason = !project
    ? '项目未就绪'
    : runBusy
      ? '节点正在运行'
      : readiness.kind === 'blocked'
        ? readinessWithFreshness.label
        : null

  // 全节点统一高度边界；旧尺寸仅迁移几何，不改业务内容。
  useEffect(() => {
    const body = bodyRef.current
    const scroll = body?.closest<HTMLElement>('.node-standard-scroll')
    if (!body || !scroll) return
    let frame = 0
    let composing = false
    const fitHeight = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const latest = editor.getShape<NodeCardShape>(shape.id)
        if (!latest) return
        const metadata = latest.meta
        const current = latest.props.h
        const clamped = Math.max(NODE_UI.height.min, Math.min(NODE_UI.height.manualMax, current))
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
                  nodeHeightMode: metadata.nodeHeightMode ?? 'manual'
                }
              }),
            { history: 'ignore' }
          )
          return
        }
        if (metadata.nodeHeightMode === 'manual') return
        if (!metadata.nodeHeightMode && resolveNodeHeight(current) !== current) {
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
        const identity = scroll.querySelector<HTMLElement>('.node-standard-identity')
        // 正文实际子项与顶部说明量高；不把 flex 填充的空白反算成内容。
        const content = body.querySelector<HTMLElement>('.node-body-content')
        const natural = content
          ? Array.from(content.children).reduce((sum, child) => {
              if (!(child instanceof HTMLElement)) return sum
              const style = getComputedStyle(child)
              return (
                sum +
                Math.max(child.offsetHeight, child.scrollHeight) +
                (Number.parseFloat(style.marginTop) || 0) +
                (Number.parseFloat(style.marginBottom) || 0)
              )
            }, 0)
          : body.scrollHeight
        const references = body.querySelector<HTMLElement>('.connected-inputs')?.offsetHeight ?? 0
        const required =
          (scroll.parentElement?.querySelector<HTMLElement>('.node-standard-action-bar')
            ?.offsetHeight || NODE_UI.actionBar.bottomInset) +
          NODE_UI.content.padding +
          natural -
          (identity ? Math.max(0, identity.offsetHeight - NODE_UI.identity.minHeight) : 0) +
          references
        const fittedPreview =
          ['image', 'image-split', 'image-crop', 'video-asset'].includes(latest.props.nodeType) ||
          (latest.props.nodeType === 'video' && Boolean(latest.props.mediaPath))
        const prompt = body.querySelector<HTMLElement>('.gen-prompt')
        const formMinimum =
          latest.props.nodeType === 'image-gen' && prompt
            ? required -
              natural +
              Array.from(prompt.parentElement?.children ?? []).reduce(
                (height, child) =>
                  child instanceof HTMLElement && child !== prompt
                    ? height + child.offsetHeight + 8
                    : height,
                0
              ) +
              Math.max(72, Number.parseFloat(prompt.style.height) || 72) +
              (references ? 8 : 0)
            : required
        // 引用是新增内容：从至少默认正文高度开始增加，不消耗原正文的空白。
        const referencedMinimum = references
          ? Math.max(NODE_UI.height.default, formMinimum - references - (prompt ? 8 : 0)) +
            references +
            8
          : formMinimum
        let next = fittedPreview ? NODE_UI.height.default : resolveNodeHeight(referencedMinimum)
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
    const compositionStart = (): void => {
      composing = true
    }
    const compositionEnd = (): void => {
      composing = false
      fitHeight()
    }
    fitHeight()
    const observer = new ResizeObserver(fitHeight)
    observer.observe(scroll)
    const mutations = new MutationObserver(fitHeight)
    mutations.observe(body, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'src', 'class']
    })
    scroll.addEventListener('input', fitHeight)
    scroll.addEventListener('focusout', fitHeight)
    scroll.addEventListener('compositionstart', compositionStart)
    scroll.addEventListener('compositionend', compositionEnd)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      mutations.disconnect()
      scroll.removeEventListener('input', fitHeight)
      scroll.removeEventListener('focusout', fitHeight)
      scroll.removeEventListener('compositionstart', compositionStart)
      scroll.removeEventListener('compositionend', compositionEnd)
    }
  }, [
    editor,
    shape.id,
    shape.props.h,
    shape.props.nodeType,
    shape.props.text,
    shape.props.config,
    shape.meta
  ])

  // 端口 tooltip 只保留身份信息（呈现规范 v1.0 §11：名称 · 类型，类型给中文名），
  // 连接手势、多选建线等操作教学不再随 tooltip 重复。
  // 拖线过程中，兼容端口额外浮出端口名标签：圆点本身无法回答“这个口收的是什么”，
  // 而用户正是在这里最容易松错手；不兼容的端口保持淡出，校验不因可发现性而放宽。

  // 裁剪、拆图和视频各自已经在正文内呈现可操作的素材区；继续显示通用输入条会
  // 重复“原图 / 图片名称”，并挤占预览高度。其他节点仍保留统一的关系可见性。
  const hasDedicatedInputSurface = ['image-crop', 'image-split', 'video', 'ai-process'].includes(
    shape.props.nodeType
  )

  return (
    <HTMLContainer style={{ pointerEvents: 'all' }}>
      {/* 外层包一层无裁切的容器：端口圆点要压在卡片边缘外侧，不能被卡片 overflow:hidden 裁掉 */}
      <div
        className={`node-card-wrap ${selected ? 'is-selected' : ''}`}
        data-node-id={shape.id}
        style={{ width: shape.props.w, height: shape.props.h }}
        onPointerDown={handleCardPointerDown}
      >
        <div className="node-header">
          {/* 标题行布局：左侧依次为 序号 → 图标 → 名称 → 可选字数 → 查看输入输出说明；
                状态灯保留在标题行，运行动作独立浮在卡片右上角，避免挤压标题。 */}
          <span className="node-seq" title={`节点序号 ${seq}`}>
            {seq}
          </span>
          <span className="node-icon" style={{ color: nodeIconColor(nodePortColor) }}>
            {/* JSX 尺寸与 ui-surfaces 对 .node-icon svg 的强制 17px 保持一致 */}
            {spec ? <Icon name={spec.icon} size={17} /> : <Icon name="help" size={17} />}
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
            onKeyDown={(e) => {
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
          {/* info 按钮（查看输入输出说明）：紧跟节点名称，点击显式打开右侧契约面板。
                对话节点也必须能查看与其他节点相同的输入输出契约。标题必须和 openNodePanel 的
                去向一致——预演台从卡片按钮进，这里写「打开 3D 预演台」会是假提示。 */}
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
          {/* 弹性占位：运行与状态都固定在标题行的右侧。 */}
          <span className="node-header-spacer" />
          {shape.meta.nodeHeightMode === 'manual' && (
            <button
              className="node-info-btn"
              aria-label="恢复自动高度"
              title="恢复自动高度"
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
              <Tooltip label={runBlockedReason ?? '运行节点'}>
                <button
                  className="node-run-btn"
                  aria-label="运行节点"
                  disabled={Boolean(runBlockedReason)}
                  onPointerDown={(event) => stopEventPropagation(event)}
                  onClick={(event) => {
                    stopEventPropagation(event)
                    if (project && !runBlockedReason) {
                      void runNodeManually(editor, project.id, providers, shape.id)
                    }
                  }}
                >
                  {/* 与 ui-surfaces 对 .node-run-btn svg 的强制 16px 保持一致 */}
                  <Icon name="play" size={16} />
                </button>
              </Tooltip>
            </span>
          )}
        </div>
        <div
          className={`node-card type-${shape.props.nodeType}`}
          data-node-type={shape.props.nodeType}
          style={{
            ['--node-accent' as string]: spec?.color ?? '#42b9f5',
            ['--node-action-bottom-inset' as string]: `${NODE_UI.actionBar.bottomInset}px`,
            ['--node-standard-action-height' as string]: `${NODE_UI.actionBar.height}px`
          }}
        >
          {/* 保留 DOM 锚点以兼容旧快照；视觉改由 card 左上角的 45° 类型切角承担。 */}
          <div
            className="node-color-bar"
            style={{ ['--node-accent' as string]: spec?.color ?? '#42b9f5' }}
          />
          {spec && (
            <NodeCardShell
              spec={spec}
              busy={activeExecution}
              openDescription={() =>
                useNodePanelStore.getState().open('contract', shape.id, 'overview')
              }
            >
              <div ref={bodyRef} className="node-body">
                {!hasDedicatedInputSurface && (
                  <ConnectedInputPreview
                    editor={editor}
                    shape={shape}
                    openPreview={openMediaPreview}
                  />
                )}
                <div className="node-body-content">
                  <spec.Body shape={shape} openPreview={openMediaPreview} />
                </div>
              </div>
            </NodeCardShell>
          )}
          {!spec && (
            <div className="node-body">
              <div className="node-empty">未知节点类型：{shape.props.nodeType}</div>
            </div>
          )}
          {activeExecution && spec?.executor && (
            <div className="node-execution-overlay">
              <GenerationLoadingOverlay
                title={executionTitle}
                progress={executionProgress}
                remainingMs={remainingEstimateMs}
                waiting={nodeRun?.status !== 'running'}
              />
            </div>
          )}
        </div>
        {/* 输入端口（左侧）：out 方向拖线时按类型兼容高亮；从输入端口也可发起反向连线 */}
        {visibleInPorts.map((p) => {
          if (occludedPortKeys.has(`in:${p.id}`)) return null
          const draftIn = draft && draft.from.direction === 'in' ? draft.from : null
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
            (ok && draft?.from.nodeColor) ||
            (connectedPort && readinessState.incomingNodeColors.get(connectedPort.id)) ||
            nodePortColor
          const portKey = `in:${p.id}`
          return (
            <span
              key={p.id}
              className={`port-dot in ${isConnected ? 'connected' : 'unconnected'} ${isAnchor ? 'ok' : draft && draft.from.direction !== 'in' ? (ok ? 'ok' : 'dim') : ''}`}
              data-port-id={p.id}
              style={{
                top: (visibleInY.get(p.id) ?? shape.props.h / 2) - NODE_PORT_SIZE / 2,
                ['--pc' as string]: inputColor,
                ['--node-port-color' as string]: inputColor,
                ...portFollowStyle(portKey)
              }}
              aria-label={portHint(p)}
              onPointerEnter={(event) => updatePortFollow(event, portKey, 'in')}
              onPointerMove={(event) => updatePortFollow(event, portKey, 'in')}
              onPointerLeave={() => clearPortFollow(portKey)}
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
          Boolean((shape.meta as Record<string, unknown> | undefined)?.artifactProducerId) && (
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
            (candidate) =>
              candidate.type === p.type && Boolean(spec?.projectOutputs?.(shape)[candidate.id])
          )
          const isConnected = outPorts.some(
            (candidate) =>
              candidate.type === p.type && readinessState.outgoingPortIds.has(candidate.id)
          )
          const draftIn = draft && draft.from.direction === 'in' ? draft.from : null
          const okUpstream = draftIn && !isSource ? canAttachPort(draftIn, p, 'in') : false
          const portKey = `out:${p.id}`
          return (
            <span
              key={p.id}
              className={`port-dot out ${hasOutput ? 'has-output' : 'no-output'} ${isConnected ? 'connected' : 'unconnected'} ${isSource && draft?.from.portId === p.id && draft.from.direction !== 'in' ? 'ok' : ''} ${draftIn ? (okUpstream ? 'ok' : 'dim') : ''}`}
              data-port-id={p.id}
              style={{
                top: (visibleOutY.get(p.id) ?? shape.props.h / 2) - NODE_PORT_SIZE / 2,
                ['--pc' as string]: nodePortColor,
                ['--node-port-color' as string]: nodePortColor,
                ...portFollowStyle(portKey)
              }}
              aria-label={portHint(p)}
              onPointerEnter={(event) => updatePortFollow(event, portKey, 'out')}
              onPointerMove={(event) => updatePortFollow(event, portKey, 'out')}
              onPointerLeave={() => clearPortFollow(portKey)}
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
                      void window.api.copyMediaPath(shape.props.mediaId)
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
