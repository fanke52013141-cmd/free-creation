// ===== 文本资产节点（铁律§4.3/4.5：内容载体，可被聊天节点引用为上下文）=====

import {
  BaseBoxShapeUtil,
  T,
  useEditor,
  type RecordProps,
  type TLShape,
} from 'tldraw'
import { useState, useEffect } from 'react'
import type { TextAssetShape } from './types'
import { TEXT_TYPE } from './types'

export class TextAssetUtil extends BaseBoxShapeUtil<TextAssetShape> {
  static override type = TEXT_TYPE

  static override props: RecordProps<TextAssetShape> = {
    w: T.number,
    h: T.number,
    text: T.string,
  }

  override getDefaultProps(): TextAssetShape['props'] {
    return { w: 340, h: 240, text: '在这里输入文本内容…' }
  }

  component(shape: TextAssetShape) {
    return <TextAssetComponent shape={shape} />
  }

  getIndicatorPath(shape: TextAssetShape) {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, 10)
    return path
  }
}

function TextAssetComponent({ shape }: { shape: TextAssetShape }) {
  const editor = useEditor()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(shape.props.text)

  useEffect(() => {
    if (!editing) setDraft(shape.props.text)
  }, [shape.props.text, editing])

  const commit = () => {
    setEditing(false)
    if (draft !== shape.props.text) {
      editor.updateShape({ id: shape.id, type: 'text-asset', props: { text: draft } })
    }
  }

  // 被 chat-node 引用时高亮（铁律§3.2 数据依赖的可视化）
  const allShapes = editor.getCurrentPageShapes() as TLShape[]
  const isReferenced = allShapes.some((s) => {
    if (s.type !== 'chat-node') return false
    return (s.props as { contextRef?: string }).contextRef === shape.id
  })

  return (
    <div
      className="w-full h-full flex flex-col bg-white rounded-lg border shadow-sm overflow-hidden"
      style={{
        borderColor: isReferenced ? '#3b82f6' : '#e5e7eb',
        outline: isReferenced ? '2px solid rgba(59,130,246,0.25)' : 'none',
      }}
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-neutral-100 bg-neutral-50">
        <span className="text-xs">📝</span>
        <span className="text-xs font-medium text-neutral-600">文本资产</span>
        {isReferenced && (
          <span className="text-[10px] text-blue-500 ml-auto">● 被引用</span>
        )}
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onBlur={commit}
          placeholder="输入文本…"
          className="flex-1 w-full resize-none p-3 text-sm outline-none leading-relaxed"
        />
      ) : (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={() => setEditing(true)}
          className="flex-1 w-full p-3 text-sm text-neutral-700 leading-relaxed overflow-auto whitespace-pre-wrap break-words cursor-text"
        >
          {shape.props.text || <span className="text-neutral-300">双击编辑</span>}
        </div>
      )}
    </div>
  )
}
