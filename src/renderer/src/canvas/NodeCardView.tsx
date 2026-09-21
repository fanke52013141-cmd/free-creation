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
import { deriveInputPortReadiness, deriveNodeReadiness } from './node-readiness'
import { runNodeManually } from '../engine/executor'
import { useAppStore } from '../stores/app'
import { useGatewayStore } from '../stores/gateway'
import { Tooltip } from '../components/Tooltip'
import { NODE_PORT_SIZE } from './edge-geometry'
import { ConnectedInputPreview } from './ConnectedInputPreview'

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

/** 端口身份信息：中文名 · 中文类型名。同一份文案同时用于 tooltip 与拖线标签。 */
function portHint(p: PortDecl): string {
  return `${p.name} · ${PORT_TYPE_LABELS[p.type]}`
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
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const titleEditable = true

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

  // 行首 info 图标：显式打开该节点的右侧面板（对话节点→聊天面板，其余→契约信息窗）。
  // 单击卡片本身只负责选中，不直接调面板；对话节点是唯一的例外——CanvasEditor 里监听
  // 选中变化的 store listener 会在单选对话节点时自动打开聊天面板（P2-2），因为它的正文
  // 就在右侧面板里。图标按钮自己吞掉指针事件，避免与选中/拖动打架。
  const handleInfoOpen = (e: React.PointerEvent<HTMLButtonElement>): void => {
    // 阻止指针事件继续，避免落入卡片选中/拖动逻辑
    stopEventPropagation(e)
  }

  // 图标只做一件事：说明这个节点的契约。导演台有自己的全屏工作区，但它从卡片按钮
  // 进入；若 info 图标也跳去工作区，这个节点 7 个端口的契约就没有任何入口了。
  const openNodePanel = (): void => {
    useNodePanelStore
      .getState()
      .open(shape.props.nodeType === 'chat' ? 'chat' : 'contract', shape.id, 'settings')
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
  const inY = portOffsets(inPorts.length, shape.props.h)
  const outY = portOffsets(outPorts.length, shape.props.h)
  const isSource = draft?.from.shapeId === shape.id
  const statusLabel = nodeExecLabel(shape.props.exec)
  const activeExecution = ['pending', 'queued', 'running'].includes(shape.props.exec)
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
        inputs: deriveInputPortReadiness(inPorts, incomingCounts),
        incomingCounts,
        outgoingCounts
      }
    },
    [editor, shape, spec, inPorts]
  )
  const readiness = readinessState.readiness
  const inputReadiness = readinessState.inputs

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
          {/* info 按钮（查看输入输出说明）：紧跟节点名称，点击显式打开右侧面板
                （对话节点→聊天面板，其余→契约信息窗）。标题必须和 openNodePanel 的
                去向一致——预演台从卡片按钮进，这里写「打开 3D 预演台」会是假提示。 */}
          <button
            className="node-info-btn"
            title={shape.props.nodeType === 'chat' ? '打开对话面板' : '查看输入输出说明'}
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
        >
          {/* 顶部类型色条：文档流内 4px（呈现规范 v1.0 §8.1），高度计算无 padding 补偿。 */}
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
                <small>{executionDescription}</small>
              </span>
            </div>
          )}
        </div>
        {/* 输入端口（左侧）：out 方向拖线时按类型兼容高亮；从输入端口也可发起反向连线 */}
        {inPorts.map((p, i) => {
          const draftIn = draft && draft.from.direction === 'in' ? draft.from : null
          const isAnchor = draftIn && draftIn.shapeId === shape.id && draftIn.portId === p.id
          const ok =
            draft && draft.from.direction !== 'in'
              ? !isSource && canAttachPort(draft.from, p)
              : false
          const state = inputReadiness.get(p.id)
          const isConnected = (readinessState.incomingCounts?.get(p.id) ?? 0) > 0
          return (
            <span
              key={p.id}
              className={`port-dot in input-${state?.kind ?? 'optional'} ${isConnected ? 'connected' : 'unconnected'} ${isAnchor ? 'ok' : draft && draft.from.direction !== 'in' ? (ok ? 'ok' : 'dim') : ''}`}
              data-port-id={p.id}
              style={{
                top: inY[i] - NODE_PORT_SIZE / 2,
                ['--pc' as string]: PORT_COLORS[p.type]
              }}
              title={portHint(p)}
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
                  { x: e.clientX, y: e.clientY }
                )
              }}
            >
              {ok ? <span className="port-label">{p.name}</span> : null}
            </span>
          )
        })}

        {/* 产物节点溯源输入圆点：宫格拆分等节点产出的独立图片/视频节点，虽然不是 DAG 消费端，
            但在视觉上有追溯连线连接。按规范“节点与节点之间一定连接的是圆连接点”，此处在左侧
            居中渲染溯源圆点，让追溯连线精确落在圆连接点上。 */}
        {inPorts.length === 0 &&
          Boolean((shape.meta as Record<string, unknown> | undefined)?.artifactProducerId) && (
            <span
              key="artifact-in-provenance"
              className="port-dot in connected input-optional"
              style={{
                top: shape.props.h / 2 - NODE_PORT_SIZE / 2,
                ['--pc' as string]:
                  PORT_COLORS[shape.props.nodeType === 'video-asset' ? 'video' : 'image'] ??
                  '#34d399'
              }}
              title="来源产物连线"
            />
          )}

        {/* 输出端口：与输入端口同样是纯圆形，按住后拖出连线；in 方向拖线时反向高亮。 */}
        {outPorts.map((p, i) => {
          const hasOutput = Boolean(spec?.projectOutputs?.(shape)[p.id])
          const isConnected = (readinessState.outgoingCounts?.get(p.id) ?? 0) > 0
          const draftIn = draft && draft.from.direction === 'in' ? draft.from : null
          const okUpstream = draftIn && !isSource ? canAttachPort(draftIn, p, 'in') : false
          return (
            <span
              key={p.id}
              className={`port-dot out ${hasOutput ? 'has-output' : 'no-output'} ${isConnected ? 'connected' : 'unconnected'} ${isSource && draft?.from.portId === p.id && draft.from.direction !== 'in' ? 'ok' : ''} ${draftIn ? (okUpstream ? 'ok' : 'dim') : ''}`}
              data-port-id={p.id}
              style={{
                top: outY[i] - NODE_PORT_SIZE / 2,
                ['--pc' as string]: PORT_COLORS[p.type]
              }}
              title={portHint(p)}
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
                  batch ?? { shapeId: shape.id, portId: p.id, portType: p.type, schema: p.schema },
                  { x: e.clientX, y: e.clientY }
                )
              }}
            >
              {draftIn && okUpstream ? <span className="port-label">{p.name}</span> : null}
            </span>
          )
        })}
      </div>
      {/* tldraw 画布容器带 transform，fixed 元素会以它为包含块导致错位，必须 portal 到 body */}
      {preview &&
        createPortal(
          <div className="media-preview-mask" onClick={() => setPreview(null)}>
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
                    {previewError ? <p className="media-preview-error">{previewError}</p> : null}
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
