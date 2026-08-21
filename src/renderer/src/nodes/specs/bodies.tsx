// 五类基础节点的内容组件（LibTV 式卡片内容区）
import { useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps } from '../registry'

// 点击 vs 拖拽判定：拖动卡片时元素随指针移动，pointerup 仍会触发 click，
// 位移超过阈值视为拖拽，不触发预览
function useClickGuard(): {
  onPointerDown: (e: React.PointerEvent) => void
  onClick: (e: React.MouseEvent, open: () => void) => void
} {
  const downRef = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: (e) => {
      downRef.current = { x: e.clientX, y: e.clientY }
    },
    onClick: (e, open) => {
      const d = downRef.current
      downRef.current = null
      if (!d) return
      if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) return
      e.stopPropagation()
      open()
    }
  }
}

export function TextBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(shape.props.text)

  const commit = (): void => {
    setEditing(false)
    if (draft !== shape.props.text) {
      editor.updateShape({ id: shape.id, type: 'node-card', props: { text: draft } })
    }
  }

  if (editing) {
    return (
      <textarea
        className="node-textarea"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') commit()
        }}
        onPointerDown={(e) => stopEventPropagation(e)}
      />
    )
  }

  return (
    <div
      className="node-text"
      onDoubleClick={(e) => {
        e.stopPropagation()
        setDraft(shape.props.text)
        setEditing(true)
      }}
    >
      {shape.props.text || <span className="node-hint">双击输入文本内容</span>}
    </div>
  )
}

export function ImageBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  if (!shape.props.mediaPath) {
    return <div className="node-hint center">拖入图片或从菜单上传</div>
  }
  return (
    <div
      className="node-media"
      onPointerDown={guard.onPointerDown}
      onClick={(e) =>
        guard.onClick(e, () =>
          openPreview({
            kind: 'image',
            url: mediaUrl(shape.props.mediaPath),
            title: shape.props.title
          })
        )
      }
    >
      <img src={mediaUrl(shape.props.mediaPath)} alt={shape.props.title} draggable={false} />
    </div>
  )
}

export function VideoBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  if (!shape.props.mediaPath) {
    return <div className="node-hint center">拖入视频或从菜单上传</div>
  }
  return (
    <div
      className="node-media"
      onPointerDown={guard.onPointerDown}
      onClick={(e) =>
        guard.onClick(e, () =>
          openPreview({
            kind: 'video',
            url: mediaUrl(shape.props.mediaPath),
            title: shape.props.title
          })
        )
      }
    >
      <video src={mediaUrl(shape.props.mediaPath)} preload="metadata" muted playsInline />
      <span className="play-badge">▶</span>
    </div>
  )
}

export function AudioBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  if (!shape.props.mediaPath) {
    return <div className="node-hint center">拖入音频或从菜单上传</div>
  }
  return (
    <div className="node-audio">
      <div className="audio-wave">♪ ♫ ♪</div>
      <button
        className="btn-ghost small"
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          openPreview({
            kind: 'audio',
            url: mediaUrl(shape.props.mediaPath),
            title: shape.props.title
          })
        }}
      >
        播放
      </button>
    </div>
  )
}

export function ChatBody(): React.JSX.Element {
  return (
    <div className="node-hint center">
      💬 对话功能将在模型接入后开放
      <br />
      <span className="dim">（M4 模型网关）</span>
    </div>
  )
}
