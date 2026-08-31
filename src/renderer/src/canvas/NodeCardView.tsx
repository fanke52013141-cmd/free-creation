// NodeCard 卡片视图：头部（序号/图标/标题/状态灯）+ 类型化内容体 + 端口圆点 + 媒体预览浮层
import { HTMLContainer, stopEventPropagation, useEditor, useValue } from 'tldraw'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import {
  getNodePorts,
  getNodeType,
  portCompatible,
  portOffsets,
  PORT_COLORS
} from '../nodes/registry'
import type { PortDecl } from '@shared/types'
import { nodeSchemasCompatible } from '@shared/node-schemas'
import { useConnectionStore } from '../stores/connection'
import { useNodePanelStore } from '../stores/nodePanel'
import { beginConnectionDrag } from './connection-drag'
import { markUndoPoint } from './history'
import type { NodeCardShape } from './NodeCardShape'
import { Icon } from '../components/Icon'
import { nodeExecLabel } from './node-status'
import { deriveInputPortReadiness, deriveNodeReadiness } from './node-readiness'
import { runNodeManually } from '../engine/executor'
import { useAppStore } from '../stores/app'
import { useGatewayStore } from '../stores/gateway'
import { Tooltip } from '../components/Tooltip'

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

function canAttachPort(
  source: { portType: PortDecl['type']; schema?: PortDecl['schema'] },
  target: PortDecl
): boolean {
  return (
    portCompatible(source.portType, target.type) &&
    !(
      source.portType === 'json' &&
      target.type === 'json' &&
      !nodeSchemasCompatible(source.schema, target.schema)
    )
  )
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
  const [editing, setEditing] = useState(false)
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

  // 右上角 info 图标：显式打开该节点的右侧面板。对话节点→聊天面板，其余→契约信息窗。
  // 单击节点只负责选中，不再自动弹出；点击此图标才呈现，避免选中与点图标打架。
  const handleInfoOpen = (e: React.PointerEvent<HTMLButtonElement>): void => {
    // 阻止指针事件继续，避免落入卡片选中/拖动逻辑
    stopEventPropagation(e)
  }

  const openNodePanel = (): void => {
    const kind =
      shape.props.nodeType === 'chat'
        ? 'chat'
        : shape.props.nodeType === 'director'
          ? 'director'
          : 'contract'
    useNodePanelStore.getState().open(kind, shape.id)
  }

  // 双击标题进入编辑模式
  const handleTitleDoubleClick = (e: React.MouseEvent): void => {
    if (!titleEditable) return
    stopEventPropagation(e)
    setEditing(true)
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

  const titleEditable = true

  const resolvedPorts = spec
    ? getNodePorts(spec, shape)
    : { in: [] as PortDecl[], out: [] as PortDecl[] }
  const inPorts = resolvedPorts.in
  const outPorts = resolvedPorts.out
  const inY = portOffsets(inPorts.length, shape.props.h)
  const outY = portOffsets(outPorts.length, shape.props.h)
  const isSource = draft?.from.shapeId === shape.id
  const statusLabel = nodeExecLabel(shape.props.exec)
  const readinessState = useValue(
    'node readiness',
    () => {
      const incomingCounts = new Map<string, number>()
      for (const arrow of editor.getCurrentPageShapes()) {
        if (arrow.type !== 'arrow' || arrow.meta?.toPort === undefined) continue
        const bindings = editor.getBindingsFromShape(arrow.id, 'arrow')
        const end = bindings.find((binding) => binding.props.terminal === 'end')
        if (end?.toId !== shape.id || typeof arrow.meta.toPort !== 'string') continue
        incomingCounts.set(arrow.meta.toPort, (incomingCounts.get(arrow.meta.toPort) ?? 0) + 1)
      }
      return {
        readiness: deriveNodeReadiness({
          executionMode: spec?.executionMode ?? 'auto',
          exec: shape.props.exec,
          inputs: inPorts,
          incomingCounts,
          outputs: spec?.projectOutputs?.(shape) ?? {}
        }),
        inputs: deriveInputPortReadiness(inPorts, incomingCounts)
      }
    },
    [editor, shape, spec, inPorts]
  )
  const readiness = readinessState.readiness
  const inputReadiness = readinessState.inputs

  const portSummary = (port: PortDecl, direction: '输入' | '输出'): string =>
    [
      `${port.name}（${port.type}）${direction}`,
      port.required ? '必填' : '可选',
      port.cardinality === 'many' ? '多值' : '单值',
      port.schema ? `${port.schema.id}@${port.schema.version}` : null,
      port.description
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <HTMLContainer style={{ pointerEvents: 'all' }}>
      {/* 外层包一层无裁切的容器：端口圆点要压在卡片边缘外侧，不能被卡片 overflow:hidden 裁掉 */}
      <div
        className={`node-card-wrap ${selected ? 'is-selected' : ''}`}
        style={{ width: shape.props.w, height: shape.props.h }}
        onPointerDown={handleCardPointerDown}
      >
        <div
          className={`node-card type-${shape.props.nodeType}`}
          data-node-type={shape.props.nodeType}
        >
          {/* 底部颜色条（按类型区分，避免干扰标题区域） */}
          <div
            className="node-color-bar"
            style={{ ['--node-accent' as string]: spec?.color ?? '#42b9f5' }}
          />
          <div className="node-header">
            <span className="node-seq" style={{ color: spec?.color }}>
              {seq}
            </span>
            <span className="node-icon" style={{ color: spec?.color }}>
              {spec ? <Icon name={spec.icon} size={15} /> : <Icon name="help" size={15} />}
            </span>
            <div
              className={`node-title ${titleEditable ? 'editable' : ''} ${editing ? 'editing' : ''}`}
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
            <span
              className={`node-status node-status-${shape.props.exec}`}
              style={{ background: EXEC_COLORS[shape.props.exec] ?? EXEC_COLORS.idle }}
              title={`${statusLabel} · ${readiness.label}`}
              aria-label={`${statusLabel} · ${readiness.label}`}
            />
            {selected && spec?.executor && (
              <Tooltip label="运行此节点（使用已连接的上游结果）">
                <button
                  className="node-run-btn"
                  aria-label="运行此节点"
                  disabled={shape.props.exec === 'running' || !project}
                  onPointerDown={(event) => stopEventPropagation(event)}
                  onClick={(event) => {
                    stopEventPropagation(event)
                    if (project) void runNodeManually(editor, project.id, providers, shape.id)
                  }}
                >
                  <Icon name="play" size={12} />
                </button>
              </Tooltip>
            )}
            <button
              className="node-info-btn"
              title={
                shape.props.nodeType === 'chat'
                  ? '打开对话面板'
                  : shape.props.nodeType === 'director'
                    ? '打开 3D 预演台'
                    : '查看输入输出说明'
              }
              aria-label="打开节点说明"
              onPointerDown={handleInfoOpen}
              onClick={(e) => {
                stopEventPropagation(e)
                openNodePanel()
              }}
            >
              <Icon name="info" size={13} />
            </button>
          </div>
          <div className="node-body">
            {spec ? (
              <spec.Body shape={shape} openPreview={(p) => setPreview(p)} />
            ) : (
              <div className="node-empty">未知节点类型：{shape.props.nodeType}</div>
            )}
          </div>
        </div>

        {/* 输入端口（左侧）：拖线时按类型兼容高亮 */}
        {inPorts.map((p, i) => {
          const ok = draft && !isSource && canAttachPort(draft.from, p)
          const state = inputReadiness.get(p.id)
          return (
            <span
              key={p.id}
              className={`port-dot in input-${state?.kind ?? 'optional'} ${draft ? (ok ? 'ok' : 'dim') : ''}`}
              style={{
                top: inY[i] - 6,
                borderColor: PORT_COLORS[p.type],
                ['--pc' as string]: PORT_COLORS[p.type]
              }}
              title={`${portSummary(p, '输入')} · ${state?.label ?? '未连接'}`}
            >
              <span className="port-dot-inner" style={{ background: PORT_COLORS[p.type] }} />
            </span>
          )
        })}

        {/* 输出端口：与输入端口同样是纯圆形，按住后拖出连线。 */}
        {outPorts.map((p, i) => {
          const hasOutput = Boolean(spec?.projectOutputs?.(shape)[p.id])
          return (
            <span
              key={p.id}
              className={`port-dot out ${hasOutput ? 'has-output' : 'no-output'} ${isSource && draft?.from.portId === p.id ? 'ok' : ''}`}
              style={{
                top: outY[i] - 6,
                borderColor: PORT_COLORS[p.type],
                ['--pc' as string]: PORT_COLORS[p.type]
              }}
              title={`${portSummary(p, '输出')} · ${hasOutput ? '当前输出可用' : '当前尚无可用输出'} · 按住圆点拖出连线`}
              onPointerDown={(e) => {
                stopEventPropagation(e)
                beginConnectionDrag(
                  { shapeId: shape.id, portId: p.id, portType: p.type, schema: p.schema },
                  { x: e.clientX, y: e.clientY }
                )
              }}
            />
          )
        })}
      </div>
      {/* tldraw 画布容器带 transform，fixed 元素会以它为包含块导致错位，必须 portal 到 body */}
      {preview &&
        createPortal(
          <div className="media-preview-mask" onClick={() => setPreview(null)}>
            <div className="media-preview-box" onClick={(e) => e.stopPropagation()}>
              <div className="media-preview-title">
                <span>{preview.title}</span>
                {shape.props.mediaId && (
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
                    <button
                      className="icon-btn"
                      title="用系统默认程序打开"
                      onClick={(e) => {
                        e.stopPropagation()
                        void window.api.openMedia(shape.props.mediaId)
                      }}
                    >
                      <Icon name="external" size={14} />
                    </button>
                  </span>
                )}
                <button className="icon-btn" onClick={() => setPreview(null)}>
                  <Icon name="close" size={16} />
                </button>
              </div>
              <div className="media-preview-stage">
                {preview.kind === 'image' && <img src={preview.url} alt={preview.title} />}
                {preview.kind === 'video' && <video src={preview.url} controls autoPlay />}
                {preview.kind === 'audio' && <audio src={preview.url} controls autoPlay />}
              </div>
            </div>
          </div>,
          document.body
        )}
    </HTMLContainer>
  )
}
