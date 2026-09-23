// NodeCard 卡片视图：头部（序号/图标/标题/状态灯）+ 类型化内容体 + 端口圆点 + 媒体预览浮层
import { HTMLContainer, stopEventPropagation, useEditor, useValue } from 'tldraw'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  getNodePorts,
  getNodeType,
  portOffsets,
  PORT_COLORS,
  PORT_TYPE_LABELS
} from '../nodes/registry'
import type { PortDecl, PortSchemaRef, PortType } from '@shared/types'
import { useConnectionStore } from '../stores/connection'
import { useNodePanelStore } from '../stores/nodePanel'
import { beginConnectionDrag } from './connection-drag'
import { batchConnectionFromSelection } from './batch-connection'
import { portPairCompatible } from './graph'
import { markUndoPoint } from './history'
import type { NodeCardShape } from './NodeCardShape'
import { Icon } from '../components/Icon'
import { resolveNodeHeight } from './node-ui-tokens'
import { nodeExecLabel } from './node-status'
import { deriveNodeReadiness } from './node-readiness'
import { runNodeManually } from '../engine/executor'
import { useAppStore } from '../stores/app'
import { useGatewayStore } from '../stores/gateway'
import { Tooltip } from '../components/Tooltip'
import { NODE_PORT_OUTSET, NODE_PORT_SIZE } from './edge-geometry'
import { ConnectedInputPreview } from './ConnectedInputPreview'
import {
  DEFAULT_IMAGE_GENERATION_ESTIMATE_MS,
  estimateImageGenerationDuration,
  imageGenerationProgressPercent,
} from './image-generation-progress'
import { readNodeRunRecord } from '../engine/runRecord'
import { canConsumeWheel } from './node-wheel-scroll'

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
  const spec = getNodeType(shape.props.nodeType)
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
      const shapes = editor
        .getCurrentPageShapes()
        .filter((item) => item.type === 'node-card')
        .sort((a, b) => a.index.localeCompare(b.index))
      const idx = shapes.findIndex((item) => item.id === shape.id)
      return idx >= 0 ? idx + 1 : 0
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

  // 图标只做一件事：说明这个节点的契约。导演台有自己的全屏工作区，但它从卡片按钮
  // 进入；若 info 图标也跳去工作区，这个节点 7 个端口的契约就没有任何入口了。
  const openNodePanel = (): void => {
    useNodePanelStore
      .getState()
      .open('contract', shape.id, 'overview')
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
  }

  // Scroll ownership is deterministic: scrollable node content consumes the wheel while it
  // can move; at its edge the event bubbles to the canvas. Ctrl/Meta-wheel remains zoom.
  const handleNodeWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey) return
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    let element: HTMLElement | null =
      target instanceof HTMLElement ? target : target.parentElement
    while (element && element !== event.currentTarget) {
      const style = window.getComputedStyle(element)
      const verticalCanScroll =
        ['auto', 'scroll', 'overlay'].includes(style.overflowY) &&
        canConsumeWheel(
          { position: element.scrollTop, extent: element.scrollHeight, viewport: element.clientHeight },
          event.deltaY
        )
      const horizontalDelta = event.shiftKey ? event.deltaY || event.deltaX : event.deltaX
      const horizontalCanScroll =
        ['auto', 'scroll', 'overlay'].includes(style.overflowX) &&
        canConsumeWheel(
          { position: element.scrollLeft, extent: element.scrollWidth, viewport: element.clientWidth },
          horizontalDelta
        )
      if (verticalCanScroll || horizontalCanScroll) {
        event.stopPropagation()
        return
      }
      element = element.parentElement
    }
  }

  const handleTitleBlur = (e: React.FocusEvent<HTMLDivElement>): void => {
    const next = e.currentTarget.textContent ?? ''
    if (next !== shape.props.title) {
      editor.updateShape({ id: shape.id, type: 'node-card', props: { title: next } })
      markUndoPoint(editor, 'title-edit')
    }
    setEditing(false)
  }

  const resolvedPorts = spec
    ? getNodePorts(spec, shape)
    : { in: [] as PortDecl[], out: [] as PortDecl[] }
  const inPorts = resolvedPorts.in
  const outPorts = resolvedPorts.out
  // 空闲端口只表明“这是这个节点的一部分”，不提前泄露每个端口可传递的数据类型。
  // 类型色只在已连线或拖线候选态出现；端口 ID、schema 和连线判断仍完全来自契约。
  const nodePortColor = spec?.color ?? '#42b9f5'
  const inY = portOffsets(inPorts.length, shape.props.h)
  const outY = portOffsets(outPorts.length, shape.props.h)
  const isSource = draft?.from.shapeId === shape.id
  const statusLabel = nodeExecLabel(shape.props.exec)
  const activeExecution = ['pending', 'queued', 'running'].includes(shape.props.exec)
  const imageRun = shape.props.nodeType === 'image-gen' ? readNodeRunRecord(shape.meta?.nodeRun) : null
  const imageRunActive = Boolean(
    shape.props.nodeType === 'image-gen' && activeExecution && imageRun?.status === 'running'
  )
  const imageConfig = (() => {
    if (shape.props.nodeType !== 'image-gen') return null
    try {
      const parsed = JSON.parse(shape.props.config) as Record<string, unknown>
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  })()
  const imageProviderKey =
    typeof imageConfig?.providerKey === 'string' && imageConfig.providerKey
      ? imageConfig.providerKey
      : typeof imageConfig?.modelKey === 'string'
        ? imageConfig.modelKey.split('::')[0]
        : ''
  const imageModelKey = typeof imageConfig?.modelKey === 'string' ? imageConfig.modelKey : ''
  const imageCount =
    typeof imageConfig?.count === 'number' && Number.isFinite(imageConfig.count)
      ? Math.max(1, Math.min(9, Math.floor(imageConfig.count)))
      : 1
  const [imageTimingEstimateMs, setImageTimingEstimateMs] = useState(
    DEFAULT_IMAGE_GENERATION_ESTIMATE_MS
  )
  const [imageExecutionElapsedMs, setImageExecutionElapsedMs] = useState(0)
  const timingRecordedRunRef = useRef<string | null>(null)

  useEffect(() => {
    if (!imageRunActive || !imageRun) return
    const startedAt = imageRun.startedAt
    const refreshElapsed = (): void =>
      setImageExecutionElapsedMs(Math.max(0, Date.now() - startedAt))
    const frame = window.requestAnimationFrame(refreshElapsed)
    const timer = window.setInterval(refreshElapsed, 500)
    let current = true
    if (imageProviderKey && imageModelKey) {
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
    }
    return () => {
      current = false
      window.cancelAnimationFrame(frame)
      window.clearInterval(timer)
    }
  }, [imageRunActive, imageRun?.runId, imageRun?.startedAt, imageProviderKey, imageModelKey, imageCount])

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
    void window.api.workspace.recordImageGenerationTiming({
      runId: imageRun.runId,
      providerKey: imageProviderKey,
      modelKey: imageModelKey,
      durationMs: Math.round(imageRun.durationMs / imageCount),
      recordedAt: imageRun.finishedAt ?? Date.now()
    }).catch(() => undefined)
  }, [shape.props.nodeType, imageRun?.runId, imageRun?.status, imageRun?.durationMs, imageRun?.finishedAt, imageProviderKey, imageModelKey, imageCount])

  const imageProgress = imageRunActive
    ? imageGenerationProgressPercent(imageExecutionElapsedMs, imageTimingEstimateMs)
    : 0
  const executionLabel: Record<string, string> = {
    'image-gen': '图片生成中',
    'image-edit': 'P图中',
    'image-split': '正在拆分图片',
    'image-crop': '正在裁剪图片',
    video: '视频生成中'
  }
  const executionDetail: Record<string, string> = {
    'image-gen': '正在调用已选模型，完成后会自动替换为生成结果。',
    'image-edit': '正在发送原图与标注参考。',
    'image-split': '正在按当前行列导出独立图片，不会覆盖原图。',
    'image-crop': '正在导出裁剪后的新图片，原图保持不变。',
    video: '正在提交视频任务，完成后会自动显示成片。'
  }
  const executionTitle = executionLabel[shape.props.nodeType] ?? '节点执行中'
  const executionDescription =
    executionDetail[shape.props.nodeType] ?? '正在运行本节点，完成后自动更新。'
  const readinessState = useValue(
    'node readiness',
    () => {
      const incomingCounts = new Map<string, number>()
      const outgoingCounts = new Map<string, number>()
      for (const arrow of editor.getCurrentPageShapes()) {
        if (arrow.type !== 'arrow') continue
        const bindings = editor.getBindingsFromShape(arrow.id, 'arrow')
        if (typeof arrow.meta?.toPort === 'string') {
          const end = bindings.find((binding) => binding.props.terminal === 'end')
          if (end?.toId === shape.id) {
            incomingCounts.set(arrow.meta.toPort, (incomingCounts.get(arrow.meta.toPort) ?? 0) + 1)
          }
        }
        if (typeof arrow.meta?.fromPort === 'string') {
          const start = bindings.find((binding) => binding.props.terminal === 'start')
          if (start?.toId === shape.id) {
            outgoingCounts.set(
              arrow.meta.fromPort,
              (outgoingCounts.get(arrow.meta.fromPort) ?? 0) + 1
            )
          }
        }
      }
      for (const card of editor.getCurrentPageShapes()) {
        if (card.type !== 'node-card') continue
        const meta = card.meta as Record<string, unknown> | undefined
        if (
          meta?.artifactProducerId === shape.id &&
          typeof meta.artifactProducerPortId === 'string'
        ) {
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
          inputs: inPorts,
          incomingCounts,
          outputs: spec?.projectOutputs?.(shape) ?? {}
        }),
        incomingCounts,
        outgoingCounts
      }
    },
    [editor, shape, spec, inPorts]
  )
  const readiness = readinessState.readiness
  const hasNodeConnections =
    readinessState.incomingCounts.size > 0 || readinessState.outgoingCounts.size > 0
  // 未连接的节点只显示一个居中的入口和出口。连上线后恢复完整端口布局；这些圆点
  // 始终映射到真实契约端口，端口 ID、类型和运行时校验不变。
  const visibleInPorts = hasNodeConnections ? inPorts : inPorts.slice(0, 1)
  const visibleOutPorts = hasNodeConnections ? outPorts : outPorts.slice(0, 1)
  const visibleInY = hasNodeConnections ? inY : portOffsets(visibleInPorts.length, shape.props.h)
  const visibleOutY = hasNodeConnections ? outY : portOffsets(visibleOutPorts.length, shape.props.h)

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
      visibleInPorts.forEach((port, index) => {
        if (isCovered(bounds.x - NODE_PORT_OUTSET, pageY(visibleInY[index] ?? 0)))
          keys.add(`in:${port.id}`)
      })
      visibleOutPorts.forEach((port, index) => {
        if (isCovered(bounds.maxX + NODE_PORT_OUTSET, pageY(visibleOutY[index] ?? 0))) {
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
        ? readiness.label
        : null

  // 节点有规范的初始档位尺寸；内容溢出时只按固定档位跳档（呈现规范 v1.0 §3.2/§3.4：
  // 260→320→380→440），超过 autoMax 的内容在 node-body 内部滚动，
  // 绝不把卡片撑成任意像素高度，也不会压缩用户手动拉大的节点。
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    let frame = 0
    const fitHeight = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        let overflow = Math.ceil(body.scrollHeight - body.clientHeight)
        // 媒体结果网格等嵌套滚动容器（flex min-height:0 链 + overflow-y:auto）会把溢出
        // 吸收在自己的滚动条里，body.scrollHeight 因此恒等于 clientHeight。此时扫描
        // body 内所有纵向滚动容器，把它们的隐藏溢出计入，拆分 9/16 格等大结果才能
        // 撑高档位，而不是挤在小窗口里滚动、视觉上“叠在一起”。
        if (overflow <= 2) {
          for (const el of body.querySelectorAll<HTMLElement>('*')) {
            const oy = getComputedStyle(el).overflowY
            if (oy !== 'auto' && oy !== 'scroll') continue
            overflow = Math.max(overflow, Math.ceil(el.scrollHeight - el.clientHeight))
          }
        }
        if (overflow <= 2) return
        const tier = resolveNodeHeight(shape.props.h + overflow)
        if (tier > shape.props.h + 2) {
          editor.updateShape({ id: shape.id, type: 'node-card', props: { h: tier } })
        }
      })
    }
    fitHeight()
    const observer = new ResizeObserver(fitHeight)
    observer.observe(body)
    // 图片等异步媒体在 onLoad 后才会改写子树的真实内容高度（如拆分九宫格按原图
    // 宽高比重设 aspect-ratio）。这只改变 body 内部的布局，body 自身盒子尺寸
    // 不变，ResizeObserver 不会触发；必须监听子树结构 / style / src 变化后重新
    // 量高，否则新的网格高度只会被卡片 overflow:hidden 静默裁掉（底部格子缺半格）。
    const mutations = new MutationObserver(fitHeight)
    mutations.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'src', 'class']
    })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      mutations.disconnect()
    }
  }, [editor, shape.id, shape.props.h])

  // 端口 tooltip 只保留身份信息（呈现规范 v1.0 §11：名称 · 类型，类型给中文名），
  // 连接手势、多选建线等操作教学不再随 tooltip 重复。
  // 拖线过程中，兼容端口额外浮出端口名标签：圆点本身无法回答“这个口收的是什么”，
  // 而用户正是在这里最容易松错手；不兼容的端口保持淡出，校验不因可发现性而放宽。

  // 裁剪、拆图和视频各自已经在正文内呈现可操作的素材区；继续显示通用输入条会
  // 重复“原图 / 图片名称”，并挤占预览高度。其他节点仍保留统一的关系可见性。
  const hasDedicatedInputSurface = ['image-crop', 'image-split', 'video'].includes(
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
        onWheel={handleNodeWheel}
      >
        <div className="node-header">
          {/* 标题行布局：左侧依次为 序号 → 图标 → 名称 → 查看输入输出说明；
                状态灯保留在标题行，运行动作独立浮在卡片右上角，避免挤压标题。 */}
          <span className="node-seq" title={`节点序号 ${seq}`}>
            {seq}
          </span>
          <span className="node-icon" style={{ color: spec?.color, opacity: 0.82 }}>
            {spec ? <Icon name={spec.icon} size={15} /> : <Icon name="help" size={15} />}
          </span>
          <div
            ref={titleRef}
            className={`node-title ${titleEditable ? 'editable' : ''} ${editing ? 'editing' : ''}`}
            data-node-interactive="node-title"
            title={shape.props.title}
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
            {shape.props.title}
          </div>
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
          {/* 文本节点字数徽标：位于“查看输入输出说明”右侧。
                格式见 formatCharCount（N 字 / N 多字 / X.XK）。 */}
          {shape.props.nodeType === 'text' && shape.props.text && (
            <span className="node-text-count">{formatCharCount(shape.props.text.length)}</span>
          )}
          {/* 弹性占位：运行与状态都固定在标题行的右侧。 */}
          <span className="node-header-spacer" />
          <span
            className={`node-status node-status-${shape.props.exec}`}
            style={{ background: EXEC_COLORS[shape.props.exec] ?? EXEC_COLORS.idle }}
            title={`${statusLabel} · ${readiness.label}`}
            aria-label={`${statusLabel} · ${readiness.label}`}
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
                  <Icon name="play" size={14} />
                </button>
              </Tooltip>
            </span>
          )}
        </div>
        <div
          className={`node-card type-${shape.props.nodeType}`}
          data-node-type={shape.props.nodeType}
          style={{ ['--node-accent' as string]: spec?.color ?? '#42b9f5' }}
        >
          {/* 保留 DOM 锚点以兼容旧快照；视觉改由 card 左上角的 45° 类型切角承担。 */}
          <div
            className="node-color-bar"
            style={{ ['--node-accent' as string]: spec?.color ?? '#42b9f5' }}
          />
          <div ref={bodyRef} className="node-body">
            {!hasDedicatedInputSurface && (
              <ConnectedInputPreview editor={editor} shape={shape} openPreview={openMediaPreview} />
            )}
            <div className="node-body-content">
              {spec ? (
                <spec.Body shape={shape} openPreview={openMediaPreview} />
              ) : (
                <div className="node-empty">未知节点类型：{shape.props.nodeType}</div>
              )}
            </div>
          </div>
          {activeExecution && spec?.executor && (
            <div className="node-execution-overlay" role="status" aria-live="polite">
              <span className="node-execution-spinner" aria-hidden="true">
                <Icon name="loader" size={22} />
              </span>
              <span className="node-execution-copy">
                <strong>{executionTitle}</strong>
                {shape.props.nodeType === 'image-gen' ? (
                  <span
                    className="node-execution-progress"
                    role="progressbar"
                    aria-label="图片生成预计进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={imageProgress}
                  >
                    <span className="node-execution-progress-track">
                      <span style={{ width: `${imageProgress}%` }} />
                    </span>
                    <small>预计进度 {imageProgress}%</small>
                  </span>
                ) : (
                  <small>{executionDescription}</small>
                )}
              </span>
            </div>
          )}
        </div>
        {/* 输入端口（左侧）：out 方向拖线时按类型兼容高亮；从输入端口也可发起反向连线 */}
        {visibleInPorts.map((p, i) => {
          if (occludedPortKeys.has(`in:${p.id}`)) return null
          const draftIn = draft && draft.from.direction === 'in' ? draft.from : null
          const isAnchor = draftIn && draftIn.shapeId === shape.id && draftIn.portId === p.id
          const ok =
            draft && draft.from.direction !== 'in'
              ? !isSource &&
                (hasNodeConnections
                  ? canAttachPort(draft.from, p)
                  : inPorts.some((candidate) => canAttachPort(draft.from, candidate)))
              : false
          const isConnected = (readinessState.incomingCounts?.get(p.id) ?? 0) > 0
          const portKey = `in:${p.id}`
          return (
            <Tooltip key={p.id} label={portHint(p)} placement="top">
              <span
                className={`port-dot in ${isConnected ? 'connected' : 'unconnected'} ${isAnchor ? 'ok' : draft && draft.from.direction !== 'in' ? (ok ? 'ok' : 'dim') : ''}`}
                data-port-id={p.id}
                style={{
                  top: visibleInY[i] - NODE_PORT_SIZE / 2,
                  ['--pc' as string]: PORT_COLORS[p.type],
                  ['--node-port-color' as string]: nodePortColor,
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
                      schema: p.schema,
                      direction: 'in'
                    },
                    portCenter(e, portKey)
                  )
                }}
              ></span>
            </Tooltip>
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
                ['--pc' as string]:
                  PORT_COLORS[
                    shape.props.nodeType === 'video-asset'
                      ? 'video'
                      : shape.props.nodeType === 'audio'
                        ? 'audio'
                        : 'image'
                  ] ??
                  '#34d399',
                ['--node-port-color' as string]: nodePortColor
              }}
              aria-label="来源产物连线"
            />
          )}

        {/* 输出端口：与输入端口同样是纯圆形，按住后拖出连线；in 方向拖线时反向高亮。 */}
        {visibleOutPorts.map((p, i) => {
          if (occludedPortKeys.has(`out:${p.id}`)) return null
          const hasOutput = Boolean(spec?.projectOutputs?.(shape)[p.id])
          const isConnected = (readinessState.outgoingCounts?.get(p.id) ?? 0) > 0
          const draftIn = draft && draft.from.direction === 'in' ? draft.from : null
          const okUpstream =
            draftIn && !isSource
              ? hasNodeConnections
                ? canAttachPort(draftIn, p, 'in')
                : outPorts.some((candidate) => canAttachPort(draftIn, candidate, 'in'))
              : false
          const portKey = `out:${p.id}`
          return (
            <Tooltip key={p.id} label={portHint(p)} placement="top">
              <span
                className={`port-dot out ${hasOutput ? 'has-output' : 'no-output'} ${isConnected ? 'connected' : 'unconnected'} ${isSource && draft?.from.portId === p.id && draft.from.direction !== 'in' ? 'ok' : ''} ${draftIn ? (okUpstream ? 'ok' : 'dim') : ''}`}
                data-port-id={p.id}
                style={{
                  top: visibleOutY[i] - NODE_PORT_SIZE / 2,
                  ['--pc' as string]: PORT_COLORS[p.type],
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
                    batch ?? {
                      shapeId: shape.id,
                      portId: p.id,
                      portType: p.type,
                      schema: p.schema
                    },
                    portCenter(e, portKey)
                  )
                }}
              ></span>
            </Tooltip>
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
