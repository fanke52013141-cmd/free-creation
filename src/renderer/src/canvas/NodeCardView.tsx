// NodeCard 卡片视图：头部（序号/图标/标题/状态灯）+ 类型化内容体 + 端口圆点 + 媒体预览浮层
import { HTMLContainer, stopEventPropagation, useEditor, useValue } from 'tldraw'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  getNodePorts,
  getNodeType,
  portCompatible,
  portOffsets,
  PORT_COLORS
} from '../nodes/registry'
import type { PortDecl } from '@shared/types'
import { useConnectionStore } from '../stores/connection'
import { useNodePanelStore } from '../stores/nodePanel'
import { beginConnectionDrag } from './connection-drag'
import { markUndoPoint } from './history'
import { NodeHoverToolbar } from './node-toolbar/NodeHoverToolbar'
import type { NodeCardShape } from './NodeCardShape'
import { Icon } from '../components/Icon'
import type { RunMeta } from '@shared/contracts'

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

export function NodeCardView({ shape }: { shape: NodeCardShape }): React.JSX.Element {
  const editor = useEditor()
  const spec = getNodeType(shape.props.nodeType)
  const draft = useConnectionStore((s) => s.draft)
  const [preview, setPreview] = useState<{
    url: string
    kind: 'image' | 'video' | 'audio'
    title: string
  } | null>(null)
  const [editing, setEditing] = useState(false)
  const [connectable, setConnectable] = useState(false)

  // 选中节点时，判断当前节点是否能与选中节点建立连线（双向检测）
  useEffect((): (() => void) => {
    const check = (): void => {
      const selected = editor.getSelectedShapes()
      if (
        selected.length !== 1 ||
        selected[0].type !== 'node-card' ||
        selected[0].id === shape.id
      ) {
        setConnectable(false)
        return
      }
      const target = selected[0] as NodeCardShape
      const targetSpec = getNodeType(target.props.nodeType)
      if (!spec || !targetSpec) {
        setConnectable(false)
        return
      }
      // 双向兼容：选中节点的输出 → 本节点输入，或 本节点输出 → 选中节点输入
      const targetPorts = getNodePorts(targetSpec, target)
      const myPorts = spec ? getNodePorts(spec, shape) : { in: [], out: [] }
      const canReceive = targetPorts.out.some((o) =>
        myPorts.in.some((i) => portCompatible(i.type, o.type))
      )
      const canSend = myPorts.out.some((o) =>
        targetPorts.in.some((i) => portCompatible(i.type, o.type))
      )
      setConnectable(canReceive || canSend)
    }
    check()
    const unsub = editor.store.listen(check, { scope: 'session' })
    return unsub
  }, [editor, shape, spec])

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

  // 双击标题进入编辑模式
  const handleTitleDoubleClick = (e: React.MouseEvent): void => {
    if (!titleEditable) return
    stopEventPropagation(e)
    setEditing(true)
  }

  const handleTitlePointerDown = (e: React.PointerEvent): void => {
    if (editing) stopEventPropagation(e)
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

  // 解析 runMeta JSON 构造状态灯 hover 提示文本
  const statusTitle = (() => {
    const execLabel = shape.props.exec
    if (!shape.props.runMeta) return execLabel
    try {
      const meta = JSON.parse(shape.props.runMeta) as RunMeta
      const d = new Date(meta.at)
      const timeStr = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
      const secs =
        meta.durationMs >= 1000
          ? `${(meta.durationMs / 1000).toFixed(1)}s`
          : `${Math.round(meta.durationMs)}ms`
      const outcome = meta.error ? `失败：${meta.error}` : '成功'
      return `上次运行：${outcome} · ${secs} · ${timeStr}`
    } catch {
      return execLabel
    }
  })()

  const resolvedPorts = spec
    ? getNodePorts(spec, shape)
    : { in: [] as PortDecl[], out: [] as PortDecl[] }
  const inPorts = resolvedPorts.in
  const outPorts = resolvedPorts.out
  const inY = portOffsets(inPorts.length, shape.props.h)
  const outY = portOffsets(outPorts.length, shape.props.h)
  const isSource = draft?.from.shapeId === shape.id

  return (
    <HTMLContainer style={{ pointerEvents: 'all' }}>
      {/* 外层包一层无裁切的容器：端口圆点要压在卡片边缘外侧，不能被卡片 overflow:hidden 裁掉 */}
      <div
        className={`node-card-wrap ${connectable ? 'connectable' : ''} ${selected ? 'is-selected' : ''}`}
        style={{ width: shape.props.w, height: shape.props.h }}
      >
        {/* 媒体节点悬浮工具栏：hover 出现的「第二功能」（查看/裁剪/拆分/放大等） */}
        <NodeHoverToolbar shape={shape} onPreview={(p) => setPreview(p)} />
        <div className={`node-card type-${shape.props.nodeType} ${!spec ? 'is-frozen' : ''}`}>
          {/* 顶部颜色条（按类型区分） */}
          <div className="node-color-bar" style={{ background: spec?.color ?? '#9ca3af' }} />
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
              className="node-status"
              style={{ background: EXEC_COLORS[shape.props.exec] ?? EXEC_COLORS.idle }}
              title={statusTitle}
            />
            <button
              className="node-info-btn"
              title={shape.props.nodeType === 'chat' ? '打开对话面板' : '查看输入输出说明'}
              aria-label="打开节点说明"
              onPointerDown={handleInfoOpen}
              onClick={(e) => {
                stopEventPropagation(e)
                const kind = shape.props.nodeType === 'chat' ? 'chat' : 'contract'
                useNodePanelStore.getState().open(kind, shape.id)
              }}
            >
              <Icon name="info" size={13} />
            </button>
          </div>
          <div className="node-body">
            {spec ? (
              <spec.Body shape={shape} openPreview={(p) => setPreview(p)} />
            ) : (
              <div className="node-frozen-placeholder">
                <Icon name="lock" size={20} />
                <div className="node-frozen-type">{shape.props.nodeType}</div>
                <div className="node-frozen-hint">来自更高版本或已移除的节点，不参与运行</div>
              </div>
            )}
          </div>
        </div>

        {/* 输入端口（左侧）：拖线时按类型兼容高亮 */}
        {inPorts.map((p, i) => {
          const ok = draft && !isSource && portCompatible(p.type, draft.from.portType)
          return (
            <span
              key={p.id}
              className={`port-dot in ${draft ? (ok ? 'ok' : 'dim') : ''}`}
              style={{
                top: inY[i] - 6,
                borderColor: PORT_COLORS[p.type],
                ['--pc' as string]: PORT_COLORS[p.type]
              }}
              title={`${p.name}（${p.type}）输入：${p.description}`}
            >
              <span className="port-dot-inner" style={{ background: PORT_COLORS[p.type] }} />
            </span>
          )
        })}

        {/* 输出端口：与输入端口同样是纯圆形，按住后拖出连线。 */}
        {outPorts.map((p, i) => (
          <span
            key={p.id}
            className={`port-dot out ${isSource && draft?.from.portId === p.id ? 'ok' : ''}`}
            style={{
              top: outY[i] - 7,
              borderColor: PORT_COLORS[p.type],
              ['--pc' as string]: PORT_COLORS[p.type]
            }}
            title={`${p.name}（${p.type}）输出：${p.description} · 按住圆点拖出连线`}
            onPointerDown={(e) => {
              stopEventPropagation(e)
              beginConnectionDrag(
                { shapeId: shape.id, portId: p.id, portType: p.type },
                { x: e.clientX, y: e.clientY }
              )
            }}
          />
        ))}
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
