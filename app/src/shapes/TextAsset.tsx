// ===== 文本资产节点（铁律§4.3/4.5：内容载体，可被聊天节点引用为上下文）=====

import {
  BaseBoxShapeUtil,
  T,
  useEditor,
  type RecordProps,
  type TLShape,
} from 'tldraw'
import { useState } from 'react'
import type { TextAssetShape } from './types'
import { TEXT_TYPE } from './types'
import { getDependencyMeta, markNodeAndDependentsDirty } from './dependencies'

export class TextAssetUtil extends BaseBoxShapeUtil<TextAssetShape> {
  static override type = TEXT_TYPE

  static override props: RecordProps<TextAssetShape> = {
    w: T.number,
    h: T.number,
    text: T.string,
  }

  override getDefaultProps(): TextAssetShape['props'] {
    return { w: 360, h: 360, text: '在这里输入文本内容…' }
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
  const [draft, setDraft] = useState('')

  const commit = () => {
    setEditing(false)
    if (draft !== shape.props.text) {
      editor.updateShape({ id: shape.id, type: 'text-asset', props: { text: draft } })
      markNodeAndDependentsDirty(editor, shape.id, false)
    }
  }

  // 由任一节点作为真实数据输入时高亮（铁律§3.2 数据依赖的可视化）
  const allShapes = editor.getCurrentPageShapes() as TLShape[]
  const isReferenced = allShapes.some((candidate) => {
    const dependency = getDependencyMeta(candidate)
    return dependency?.sourceId === shape.id
  })

  return (
    <div
      className="w-full h-full flex flex-col node-card node-card-text"
      style={{
        pointerEvents: 'all',
        borderColor: isReferenced ? '#3b82f6' : '#e5e7eb',
        outline: isReferenced ? '2px solid rgba(59,130,246,0.25)' : 'none',
      }}
    >
      <div className="node-header">
        <span className="node-kicker">T</span>
        <span className="node-title">文本资产</span>
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
          onDoubleClick={() => { setDraft(shape.props.text); setEditing(true) }}
          className="node-body w-full text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap break-words cursor-text"
        >
          {shape.props.text || <span className="text-neutral-300">双击编辑</span>}
        </div>
      )}
    </div>
  )
}
