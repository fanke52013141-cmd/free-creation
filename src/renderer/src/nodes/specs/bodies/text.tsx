// 文本节点 Body（路线图 R6：bodies.tsx 拆分）
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 保持最新的 text 引用，让事件监听器始终读到当前值（避免闭包过期）
  const textRef = useRef(shape.props.text)
  useWheelScroll(scrollRef)

  useEffect(() => {
    textRef.current = shape.props.text
  }, [shape.props.text])

  useLayoutEffect(() => {
    if (!editing || !textareaRef.current) return
    const target = textareaRef.current
    target.focus()
    target.setSelectionRange(target.value.length, target.value.length)
  }, [editing])

  // 进入 tldraw 编辑态：告知 tldraw 此 shape 正在被编辑，
  // 编辑期间 tldraw 不再拦截键盘事件（快捷键等），textarea 才能正常接收输入。
  const enterEditing = useCallback((): void => {
    setDraft(textRef.current)
    setEditing(true)
    editor.setEditingShape(shape.id)
  }, [editor, shape.id])

  const exitEditing = (): void => {
    setEditing(false)
    editor.setEditingShape(null)
  }

  // 组件卸载时清理 tldraw 编辑态，防止卸载后键盘仍被 tldraw 扣留。
  useEffect(() => {
    return () => {
      if (editor.getEditingShapeId() === shape.id) editor.setEditingShape(null)
    }
  }, [editor, shape.id])

  // 监听器依赖 [editing]：每次从编辑态切回展示态时，展示 div 会重建，
  // 必须在新 div 上重新注册监听器，否则双击会失效。
  useEffect(() => {
    if (editing) return // 编辑态没有展示 div，无需注册
    const element = scrollRef.current
    if (!element) return
    element.addEventListener('canvas:edit-text-node', enterEditing)
    return () => element.removeEventListener('canvas:edit-text-node', enterEditing)
  }, [editing, enterEditing])

  // Slash 指令检测：/九宫格 /25宫格 /三视图
  const slashCmd = parseSlashCommand(shape.props.text)

  const commit = (): void => {
    exitEditing()
    if (draft !== textRef.current) {
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
        ref={textareaRef}
        className="node-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft(textRef.current)
            exitEditing()
          }
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') commit()
        }}
        /* 仅阻止冒泡到 tldraw 画布层，不调用 preventDefault ——
           否则浏览器无法执行 pointerdown 默认行为（聚焦文本框），导致无法输入。 */
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        data-node-interactive="text-editor"
      />
    )
  }

  return (
    <div
      className="node-text"
      ref={scrollRef}
      data-node-interactive="text-content"
      onDoubleClick={(e) => {
        e.stopPropagation()
        enterEditing()
      }}
    >
      {shape.props.text || <span className="node-hint">双击输入文本内容</span>}
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
