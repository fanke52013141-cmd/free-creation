// 文本节点 Body（路线图 R6：bodies.tsx 拆分）
import { useRef, useState } from 'react'
import { createShapeId, stopEventPropagation, useEditor, type TLShapeId } from 'tldraw'
import { generateSlashPrompts, parseSlashCommand } from '../../slash-commands'
import { markUndoPoint } from '../../../canvas/history'
import { toast } from '../../../stores/toast'
import { Icon } from '../../../components/Icon'
import { useWheelScroll } from './shared'
import type { NodeBodyProps } from '../../registry'

export function TextBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(shape.props.text)
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)

  // Slash 指令检测：/九宫格 /25宫格 /三视图
  const slashCmd = parseSlashCommand(shape.props.text)

  const commit = (): void => {
    setEditing(false)
    if (draft !== shape.props.text) {
      editor.updateShape({ id: shape.id, type: 'node-card', props: { text: draft } })
      markUndoPoint(editor, 'text-edit')
    }
  }

  // 一键生成宫格图片节点
  const generateSlashGrid = (): void => {
    if (!slashCmd || !slashCmd.subject) {
      toast('请在指令后输入主题，例如：/三视图 穿和服的女孩')
      return
    }
    const prompts = generateSlashPrompts(slashCmd.command, slashCmd.subject)
    const cols = slashCmd.command.cols
    const startX = shape.x + shape.props.w + 60
    const startY = shape.y - 40
    const nodeW = 340
    const nodeH = 260
    const gap = 12
    const ids: TLShapeId[] = []

    editor.run(() => {
      prompts.forEach((prompt, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        const id = createShapeId()
        ids.push(id)
        editor.createShape({
          id,
          type: 'node-card',
          x: startX + col * (nodeW + gap),
          y: startY + row * (nodeH + gap),
          props: {
            nodeType: 'image-gen',
            title: `${slashCmd.command.label} ${i + 1}`,
            w: 340,
            h: 260,
            config: JSON.stringify({ prompt, modelKey: '', size: 'auto' })
          }
        })
      })
    })
    markUndoPoint(editor, 'slash-generate')
    toast(`已创建 ${prompts.length} 个生图节点，逐个点击生成`)
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
      ref={scrollRef}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setDraft(shape.props.text)
        setEditing(true)
      }}
    >
      {shape.props.text || <span className="node-hint">双击输入文本内容</span>}
      {shape.props.text && !slashCmd && (
        <div className="text-node-meta">
          <span>{shape.props.text.length} 字</span>
          <span>双击编辑</span>
        </div>
      )}
      {slashCmd && (
        <div className="slash-cmd-bar">
          <div className="slash-cmd-info">
            <span className="slash-cmd-icon">
              <Icon name={slashCmd.command.icon} size={14} />
            </span>
            <span>{slashCmd.command.label}</span>
            {slashCmd.subject ? (
              <span className="slash-cmd-subject">：{slashCmd.subject.slice(0, 20)}</span>
            ) : (
              <span className="slash-cmd-warn">（请输入主题）</span>
            )}
          </div>
          <button
            className="slash-cmd-gen"
            disabled={!slashCmd.subject}
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              generateSlashGrid()
            }}
          >
            <>
              <Icon name="spark" size={13} /> 生成{slashCmd.command.count}图
            </>
          </button>
        </div>
      )}
    </div>
  )
}
