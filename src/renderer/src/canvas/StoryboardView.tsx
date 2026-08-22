// 故事板视图（创作者视图）：将画布节点按流程顺序渲染为水平卡片流
// 与节点工作流视图共享同一份底层数据，仅展示方式不同（LibTV 双视图切换）
import { useEffect, useState } from 'react'
import type { Editor } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { mediaUrl } from '../nodes/registry'
import { getNodeType } from '../nodes/registry'

const NODE_TYPE_ICON: Record<string, string> = {
  text: '📝',
  image: '🖼️',
  video: '🎥',
  audio: '🎵',
  chat: '💬',
  script: '🎬',
  storyboard: '📋',
  compose: '🎞',
  code: '⌨',
  json: '🔧',
  group: '📦'
}

// 从节点 shape 提取预览文本
function extractPreview(shape: NodeCardShape): { text: string; imagePath?: string } {
  const text = shape.props.text || ''
  const nodeType = shape.props.nodeType
  // 直接有媒体的节点
  if (shape.props.mediaPath && (nodeType === 'image' || nodeType === 'video')) {
    return { text: shape.props.title, imagePath: shape.props.mediaPath }
  }
  // JSON 结构化节点
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (nodeType === 'image' && typeof parsed.prompt === 'string') {
        return { text: parsed.prompt }
      }
      if (nodeType === 'chat' && Array.isArray(parsed.messages)) {
        const msgs = parsed.messages as { role: string; content: string }[]
        const last = [...msgs].reverse().find((m) => m.role === 'assistant')
        return { text: last?.content ?? text.slice(0, 200) }
      }
      if (nodeType === 'script' && typeof parsed.source === 'string') {
        return { text: parsed.source }
      }
      if (nodeType === 'storyboard' && Array.isArray(parsed.shots)) {
        const shots = parsed.shots as unknown[]
        return { text: `${shots.length} 个分镜` }
      }
    } catch {
      // 非合法 JSON，按纯文本处理
    }
  }
  return { text: text || '（空）' }
}

interface StoryboardViewProps {
  editor: Editor | null
}

export function StoryboardView({ editor }: StoryboardViewProps): React.JSX.Element | null {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!editor) return
    return editor.store.listen(() => setTick((t) => t + 1), { scope: 'document' })
  }, [editor])

  if (!editor) return null

  const shapes = editor
    .getCurrentPageShapes()
    .filter((s): s is NodeCardShape => s.type === 'node-card')
  // 按 x 坐标排序（从左到右的流程顺序）
  shapes.sort((a, b) => a.x - b.x || a.y - b.y)

  if (shapes.length === 0) {
    return (
      <div className="sb-view-empty">
        <span className="sb-view-empty-icon">🎬</span>
        <p>故事板视图将按照流程顺序展示你的创作内容。</p>
        <p className="sb-view-empty-hint">
          先在节点工作流视图中添加节点，切换到这里即可查看故事板效果。
        </p>
      </div>
    )
  }

  return (
    <div className="storyboard-view">
      <div className="sb-view-header">
        <span>📋 故事板视图</span>
        <span className="sb-view-count">{shapes.length} 个节点</span>
      </div>
      <div className="sb-view-track">
        {shapes.map((shape, i) => {
          const preview = extractPreview(shape)
          const spec = getNodeType(shape.props.nodeType)
          return (
            <div key={shape.id} className="sb-view-card-wrap">
              {i > 0 && <div className="sb-view-arrow">→</div>}
              <div className={`sb-view-card type-${shape.props.nodeType}`}>
                <div className="sb-view-card-head">
                  <span className="sb-view-card-num">#{i + 1}</span>
                  <span className="sb-view-card-icon">
                    {NODE_TYPE_ICON[shape.props.nodeType] ?? '📄'}
                  </span>
                  <span className="sb-view-card-title">
                    {shape.props.title || spec?.label || shape.props.nodeType}
                  </span>
                </div>
                <div className="sb-view-card-body">
                  {preview.imagePath ? (
                    <div className="sb-view-card-thumb">
                      <img src={mediaUrl(preview.imagePath)} alt="" draggable={false} />
                    </div>
                  ) : (
                    <p className="sb-view-card-text">{preview.text.slice(0, 300)}</p>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
