// 文本节点 Body（路线图 R6：bodies.tsx 拆分）
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createShapeId, stopEventPropagation, useEditor, useValue, type TLShapeId } from 'tldraw'
import { generateSlashPrompts, parseSlashCommand, SLASH_COMMANDS } from '../../slash-commands'
import { markUndoPoint } from '../../../canvas/history'
import { countIncomingConnections } from '../../../canvas/graph'
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
  // 指令清单只有 SLASH_COMMANDS 一个来源。此前指令能用但界面上从不出现，
  // 用户只能靠别人告诉才知道文本节点有批量视角能力；打错前缀也没有任何回执。
  const trimmed = shape.props.text.trim()
  const showSlashHint = !slashCmd && (trimmed === '' || trimmed.startsWith('/'))
  // 上游文本不会自己出现在正文里：执行器在运行时才把它并入并写回 props.text，而下游读的
  // 就是正文。不印出来，用户看到的就是「线连上了但下游拿不到字」，只能瞎猜哪一侧坏了
  // （§16.16：判据是真实连线数，不是节点类型猜测）。
  const incomingText = useValue(
    'text in-text incoming',
    () => countIncomingConnections(editor, shape.id, 'in-text'),
    [editor, shape.id]
  )
  const wiring =
    incomingText === 0
      ? {
          warn: !trimmed,
          text: trimmed ? '正文由本节点输入' : '正文为空：双击输入，或连一个上游节点'
        }
      : trimmed
        ? { warn: false, text: `上游 ${incomingText} 路文本，运行时并入正文` }
        : { warn: true, text: `上游 ${incomingText} 路文本已连，运行一次才会并入正文` }

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
            // 用户可编辑的生成描述属于正文；config 只保存模型的固定参数。
            text: prompt,
            config: JSON.stringify({ modelKey: '', size: 'auto' })
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
      {/* 正文单独成元素：卡片里还有提示、指令块与连线事实句，混在一起时按文本精确定位
          正文的自动化检查会连这些附加文字一起吃掉。 */}
      {shape.props.text ? (
        <span className="node-text-body">{shape.props.text}</span>
      ) : (
        <span className="node-hint">双击输入文本内容，或从上游连一条文本线进来</span>
      )}
      {showSlashHint && (
        <div className="slash-cmd-hint">
          <div className="slash-cmd-hint-title">
            {trimmed.startsWith('/')
              ? '未识别的指令，可用：'
              : '批量视角指令（指令 + 空格 + 主题）'}
          </div>
          {SLASH_COMMANDS.map((cmd) => (
            <div className="slash-cmd-option" key={cmd.pattern} title={cmd.desc}>
              <code>{cmd.pattern}</code> + 主题 · {cmd.count} 图
            </div>
          ))}
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
      {/* 空正文且没连上游时，上面的提示块已经把该说的说完了；连了上游就必须把连线事实印出来。 */}
      {(!showSlashHint || incomingText > 0) && (
        <span className={`node-wiring ${wiring.warn ? 'warn' : 'ok'}`}>{wiring.text}</span>
      )}
    </div>
  )
}
