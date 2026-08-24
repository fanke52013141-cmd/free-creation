// NodeCard 卡片视图：头部（序号/图标/标题/状态灯）+ 类型化内容体 + 端口圆点 + 媒体预览浮层
import { HTMLContainer, stopEventPropagation, useEditor } from 'tldraw'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getNodeType, portCompatible, portOffsets, PORT_COLORS } from '../nodes/registry'
import { useConnectionStore } from '../stores/connection'
import { beginConnectionDrag } from './connection-drag'
import { markUndoPoint } from './history'
import type { NodeCardShape } from './NodeCardShape'

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
      if (selected.length !== 1 || selected[0].type !== 'node-card' || selected[0].id === shape.id) {
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
      const canReceive = targetSpec.ports.out.some((o) =>
        spec.ports.in.some((i) => portCompatible(i.type, o.type))
      )
      const canSend = spec.ports.out.some((o) =>
        targetSpec.ports.in.some((i) => portCompatible(i.type, o.type))
      )
      setConnectable(canReceive || canSend)
    }
    check()
    const unsub = editor.store.listen(check, { scope: 'session' })
    return unsub
  }, [editor, shape.id, spec])

  // 计算节点序号：按创建顺序排序所有 node-card，返回当前节点的序号
  const seq = (() => {
    const shapes = editor
      .getCurrentPageShapes()
      .filter((s) => s.type === 'node-card')
      .sort((a, b) => (a.id > b.id ? 1 : -1))
    const idx = shapes.findIndex((s) => s.id === shape.id)
    return idx >= 0 ? idx + 1 : 0
  })()

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

  const inPorts = spec?.ports.in ?? []
  const outPorts = spec?.ports.out ?? []
  const inY = portOffsets(inPorts.length, shape.props.h)
  const outY = portOffsets(outPorts.length, shape.props.h)
  const isSource = draft?.from.shapeId === shape.id

  return (
    <HTMLContainer style={{ pointerEvents: 'all' }}>
      {/* 外层包一层无裁切的容器：端口圆点要压在卡片边缘外侧，不能被卡片 overflow:hidden 裁掉 */}
      <div className={`node-card-wrap ${connectable ? 'connectable' : ''}`} style={{ width: shape.props.w, height: shape.props.h }}>
        <div
          className={`node-card type-${shape.props.nodeType}`}
        >
          {/* 顶部颜色条（按类型区分） */}
          <div className="node-color-bar" style={{ background: spec?.color }} />
          <div className="node-header">
            <span className="node-seq" style={{ color: spec?.color }}>{seq}</span>
            <span className="node-icon">{spec?.icon ?? '?'}</span>
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
              title={shape.props.exec}
            />
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
              title={`${p.name}（${p.type}）输入`}
            >
              <span className="port-dot-inner" style={{ background: PORT_COLORS[p.type] }} />
            </span>
          )
        })}

        {/* 输出端口（右侧「+」拉出连线，LibTV 风格） */}
        {outPorts.map((p, i) => (
          <span
            key={p.id}
            className={`port-plus ${isSource && draft?.from.portId === p.id ? 'ok' : ''}`}
            style={{
              top: outY[i] - 9,
              borderColor: PORT_COLORS[p.type],
              ['--pc' as string]: PORT_COLORS[p.type]
            }}
            title={`${p.name}（${p.type}）输出 · 按住「+」拖出连线`}
            onPointerDown={(e) => {
              stopEventPropagation(e)
              beginConnectionDrag(
                { shapeId: shape.id, portId: p.id, portType: p.type },
                { x: e.clientX, y: e.clientY }
              )
            }}
          >
            +
          </span>
        ))}
      </div>
      {/* tldraw 画布容器带 transform，fixed 元素会以它为包含块导致错位，必须 portal 到 body */}
      {preview &&
        createPortal(
          <div className="media-preview-mask" onClick={() => setPreview(null)}>
            <div className="media-preview-box" onClick={(e) => e.stopPropagation()}>
              <div className="media-preview-title">
                <span>{preview.title}</span>
                <button className="icon-btn" onClick={() => setPreview(null)}>
                  ✕
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
