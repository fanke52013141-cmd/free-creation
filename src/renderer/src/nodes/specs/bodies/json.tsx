import { NodeIdentity, NodePrimaryButton } from '../../../canvas/NodePresentation'
// JSON 节点 Body（路线图 R6：bodies.tsx 拆分）
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { markUndoPoint } from '../../../canvas/history'
import { toast } from '../../../stores/toast'
import { Icon } from '../../../components/Icon'
import { jsonErrorLocation } from './shared'
import type { NodeBodyProps } from '../../registry'

function JsonValueCards({ value }: { value: unknown }): React.JSX.Element {
  const rows = Array.isArray(value)
    ? value
    : typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as { shots?: unknown }).shots)
      ? (value as { shots: unknown[] }).shots
      : null

  if (rows) {
    return (
      <div className="json-card-list">
        {rows.slice(0, 40).map((row, index) => {
          const fields =
            typeof row === 'object' && row !== null
              ? Object.entries(row as Record<string, unknown>)
              : [['value', row]]
          return (
            <article className="json-data-card" key={index}>
              <span className="json-card-index">{index + 1}</span>
              <div className="json-card-fields">
                {fields.slice(0, 10).map(([key, field]) => (
                  <div className="json-card-field" key={key}>
                    <span>{key}</span>
                    <strong>{typeof field === 'string' ? field : JSON.stringify(field)}</strong>
                  </div>
                ))}
              </div>
            </article>
          )
        })}
        {rows.length > 40 && <div className="json-card-more">还有 {rows.length - 40} 项未显示</div>}
      </div>
    )
  }

  if (typeof value === 'object' && value !== null) {
    return (
      <div className="json-object-card">
        {Object.entries(value as Record<string, unknown>).map(([key, field]) => (
          <div className="json-card-field" key={key}>
            <span>{key}</span>
            <strong>{typeof field === 'string' ? field : JSON.stringify(field)}</strong>
          </div>
        ))}
      </div>
    )
  }

  return <pre className="json-pre">{JSON.stringify(value, null, 2)}</pre>
}

// JSON 节点：结构化数据查看器 + 编辑器
export function JsonBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(shape.props.text)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const textRef = useRef(shape.props.text)

  useEffect(() => {
    textRef.current = shape.props.text
  }, [shape.props.text])

  useLayoutEffect(() => {
    if (!editing || !textareaRef.current) return
    const target = textareaRef.current
    target.focus()
    target.setSelectionRange(target.value.length, target.value.length)
  }, [editing])

  const exitEditing = useCallback((): void => {
    setEditing(false)
    editor.setEditingShape(null)
  }, [editor])

  const enterEditing = useCallback((): void => {
    setDraft(textRef.current)
    setEditing(true)
    editor.setEditingShape(shape.id)
  }, [editor, shape.id])

  useEffect(() => {
    return () => {
      if (editor.getEditingShapeId() === shape.id) editor.setEditingShape(null)
    }
  }, [editor, shape.id])

  const commit = (): void => {
    exitEditing()
    if (draft !== textRef.current) {
      editor.updateShape({ id: shape.id, type: 'node-card', props: { text: draft } })
      markUndoPoint(editor, 'json-edit')
    }
  }

  if (editing) {
    // 编辑态与文本节点同构（填满正文、底部保存按钮），但不用白底：
    // 2026-11-02 用户裁决「白色太突兀」，改用视频描述框那种暗色字段（见 ui-surfaces.json-editor）。
    return (
      <>
        <textarea
          ref={textareaRef}
          className="node-textarea code-edit"
          data-node-interactive="json-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') commit()
            // Tab key 支持
            if (e.key === 'Tab') {
              e.preventDefault()
              const target = e.currentTarget
              const start = target.selectionStart
              const end = target.selectionEnd
              const newVal = draft.slice(0, start) + '  ' + draft.slice(end)
              setDraft(newVal)
              requestAnimationFrame(() => {
                target.selectionStart = target.selectionEnd = start + 2
              })
            }
          }}
          /* 只阻止冒泡到画布层；不能 preventDefault，否则文本框无法聚焦（与文本节点同款）。 */
          onPointerDown={(e) => stopEventPropagation(e)}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          spellCheck={false}
        />
        <NodePrimaryButton
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => commit()}
        >
          <Icon name="check" size={16} />
          保存 JSON
        </NodePrimaryButton>
      </>
    )
  }

  const text = shape.props.text || ''
  let formatted = text
  let parsedJson: unknown
  let parseError: string | null = null
  try {
    parsedJson = JSON.parse(text)
    formatted = JSON.stringify(parsedJson, null, 2)
  } catch (error) {
    // 非合法 JSON 原样展示；短标签给行号，完整原因留在 tooltip 里
    const message = error instanceof Error ? error.message : String(error)
    parseError = text ? message : null
  }
  const isValid = Boolean(text) && !parseError
  const structSummary = Array.isArray(parsedJson)
    ? `${parsedJson.length} 项`
    : parsedJson && typeof parsedJson === 'object'
      ? `${Object.keys(parsedJson).length} 个字段`
      : 'JSON 有效'

  const formatJson = (): void => {
    try {
      const parsed = JSON.parse(text)
      const pretty = JSON.stringify(parsed, null, 2)
      if (pretty !== text) {
        editor.updateShape({ id: shape.id, type: 'node-card', props: { text: pretty } })
        markUndoPoint(editor, 'json-format')
      }
    } catch {
      toast('JSON 格式有误，无法格式化')
    }
  }

  return (
    <div className="json-body" ref={scrollRef}>
      {text ? (
        <div
          className="json-preview"
          data-node-interactive="json-content"
          onPointerDown={(e) => stopEventPropagation(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            enterEditing()
          }}
        >
          {parseError ? (
            <pre className="json-pre">{formatted}</pre>
          ) : (
            <JsonValueCards value={parsedJson} />
          )}
        </div>
      ) : (
        <div
          className="node-hint center"
          data-node-interactive="json-content"
          onPointerDown={(e) => stopEventPropagation(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            enterEditing()
          }}
        >
          <NodeIdentity>
            <small>粘贴数据，或连接上游结构化内容</small>
          </NodeIdentity>
        </div>
      )}
      {/* 2026-11-02 用户裁决：空态不再渲染这条只有一条描边的空工具栏（按钮上方那道横线）。
          主按钮经 portal 落到卡片底部操作条，DOM 位置不影响它的呈现。 */}
      {text && (
        <div className="code-toolbar">
          <span
            className={`json-status ${isValid ? 'valid' : 'invalid'}`}
            title={parseError ?? undefined}
          >
            {isValid ? structSummary : jsonErrorLocation(text, parseError ?? '')}
          </span>
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              formatJson()
            }}
          >
            <>
              <Icon name="spark" size={14} />
              格式化
            </>
          </button>
          <button
            className="btn-ghost small"
            aria-label="复制当前 JSON"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              void navigator.clipboard.writeText(formatted).then(() => toast('已复制 JSON'))
            }}
          >
            <Icon name="copy" size={14} />
          </button>
        </div>
      )}
      <NodePrimaryButton
        className="btn-ghost small"
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          enterEditing()
        }}
      >
        <>
          <Icon name="edit" size={14} />
          {text ? '编辑数据' : '粘贴 JSON'}
        </>
      </NodePrimaryButton>
    </div>
  )
}
