// JSON 节点 Body（路线图 R6：bodies.tsx 拆分）
import { useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { markUndoPoint } from '../../../canvas/history'
import { toast } from '../../../stores/toast'
import { Icon } from '../../../components/Icon'
import { useWheelScroll } from './shared'
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
  useWheelScroll(scrollRef)

  const commit = (): void => {
    setEditing(false)
    if (draft !== shape.props.text) {
      editor.updateShape({ id: shape.id, type: 'node-card', props: { text: draft } })
      markUndoPoint(editor, 'json-edit')
    }
  }

  if (editing) {
    return (
      <textarea
        className="node-textarea code-edit"
        autoFocus
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
        onPointerDown={(e) => stopEventPropagation(e)}
        spellCheck={false}
      />
    )
  }

  const text = shape.props.text || ''
  let formatted = text
  let parsedJson: unknown
  let parseError = false
  try {
    parsedJson = JSON.parse(text)
    formatted = JSON.stringify(parsedJson, null, 2)
  } catch {
    // 非合法 JSON 原样展示
    parseError = Boolean(text)
  }
  const isValid = Boolean(text) && !parseError
  const summary = Array.isArray(parsedJson)
    ? `${parsedJson.length} 项`
    : typeof parsedJson === 'object' && parsedJson !== null
      ? `${Object.keys(parsedJson).length} 个字段`
      : isValid
        ? '基础值'
        : '等待输入'

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
          onPointerDown={(e) => stopEventPropagation(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setDraft(shape.props.text)
            setEditing(true)
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
          onPointerDown={(e) => stopEventPropagation(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setDraft(shape.props.text)
            setEditing(true)
          }}
        >
          双击输入 JSON 数据
        </div>
      )}
      <div className="code-toolbar">
        <span className={`json-status ${isValid ? 'valid' : parseError ? 'invalid' : ''}`}>
          {isValid ? 'JSON 有效' : parseError ? 'JSON 格式有误' : summary}
        </span>
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            setDraft(shape.props.text)
            setEditing(true)
          }}
        >
          <>
            <Icon name="edit" size={14} />
            {text ? '编辑' : '输入'}
          </>
        </button>
        {text && (
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
        )}
        {text && (
          <button
            className="btn-ghost small"
            title="复制当前 JSON"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              void navigator.clipboard.writeText(formatted).then(() => toast('已复制 JSON'))
            }}
          >
            <Icon name="copy" size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
