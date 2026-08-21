// NodeCard 卡片视图：头部（图标/标题/状态灯）+ 类型化内容体 + 端口圆点 + 媒体预览浮层
import { HTMLContainer, stopEventPropagation, useEditor } from 'tldraw'
import { useState } from 'react'
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

  // 只在真正可交互的元素上拦事件（可编辑标题/端口）；卡片其余区域必须放行给 tldraw，
  // 否则选中和拖拽会被吞掉（此前根节点拦了 pointerdown 导致节点完全拖不动）
  const handleTitlePointerDown = (e: React.PointerEvent): void => {
    if (titleEditable) stopEventPropagation(e)
  }

  const handleTitleBlur = (e: React.FocusEvent<HTMLDivElement>): void => {
    const next = e.currentTarget.textContent ?? ''
    if (next !== shape.props.title) {
      editor.updateShape({ id: shape.id, type: 'node-card', props: { title: next } })
      markUndoPoint(editor, 'title-edit')
    }
  }

  const titleEditable = spec?.type === 'text' || spec?.type === 'chat' || spec?.type === 'script'

  const inPorts = spec?.ports.in ?? []
  const outPorts = spec?.ports.out ?? []
  const inY = portOffsets(inPorts.length, shape.props.h)
  const outY = portOffsets(outPorts.length, shape.props.h)
  const isSource = draft?.from.shapeId === shape.id

  return (
    <HTMLContainer style={{ pointerEvents: 'all' }}>
      {/* 外层包一层无裁切的容器：端口圆点要压在卡片边缘外侧，不能被卡片 overflow:hidden 裁掉 */}
      <div className="node-card-wrap" style={{ width: shape.props.w, height: shape.props.h }}>
        <div
          className={`node-card type-${shape.props.nodeType}`}
          style={{ borderColor: spec?.color }}
        >
          <div className="node-header" style={{ color: spec?.color }}>
            <span className="node-icon">{spec?.icon ?? '?'}</span>
            <div
              className={`node-title ${titleEditable ? 'editable' : ''}`}
              contentEditable={titleEditable}
              suppressContentEditableWarning
              spellCheck={false}
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

        {/* 输入端口（左侧，空心）：拖线时按类型兼容高亮 */}
        {inPorts.map((p, i) => {
          const ok = draft && !isSource && portCompatible(p.type, draft.from.portType)
          return (
            <span
              key={p.id}
              className={`port-dot in ${draft ? (ok ? 'ok' : 'dim') : ''}`}
              style={{ top: inY[i] - 5, borderColor: PORT_COLORS[p.type] }}
              title={`${p.name}（${p.type}）输入`}
            />
          )
        })}

        {/* 输出端口（右侧，实心）：按下即开始拖出连线 */}
        {outPorts.map((p, i) => (
          <span
            key={p.id}
            className={`port-dot out ${isSource && draft?.from.portId === p.id ? 'ok' : ''}`}
            style={{ top: outY[i] - 5, borderColor: PORT_COLORS[p.type] }}
            title={`${p.name}（${p.type}）输出 · 按住拖出连线`}
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
