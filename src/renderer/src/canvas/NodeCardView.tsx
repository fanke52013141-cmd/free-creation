// NodeCard 卡片视图：头部（图标/标题/状态灯）+ 类型化内容体 + 媒体预览浮层
import { HTMLContainer, stopEventPropagation, useEditor } from 'tldraw'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { getNodeType } from '../nodes/registry'
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
  const [preview, setPreview] = useState<{
    url: string
    kind: 'image' | 'video' | 'audio'
    title: string
  } | null>(null)

  // 只在真正可交互的元素上拦事件（可编辑标题）；卡片其余区域必须放行给 tldraw，
  // 否则选中和拖拽会被吞掉（此前根节点拦了 pointerdown 导致节点完全拖不动）
  const handleTitlePointerDown = (e: React.PointerEvent): void => {
    if (titleEditable) stopEventPropagation(e)
  }

  const handleTitleBlur = (e: React.FocusEvent<HTMLDivElement>): void => {
    const next = e.currentTarget.textContent ?? ''
    if (next !== shape.props.title) {
      editor.updateShape({ id: shape.id, type: 'node-card', props: { title: next } })
    }
  }

  const titleEditable = spec?.type === 'text' || spec?.type === 'chat'

  return (
    <HTMLContainer style={{ pointerEvents: 'all' }}>
      <div
        className={`node-card type-${shape.props.nodeType}`}
        style={{ width: shape.props.w, height: shape.props.h, borderColor: spec?.color }}
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
