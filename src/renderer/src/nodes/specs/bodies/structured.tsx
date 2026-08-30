import { useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { validateNodeSchema } from '@shared/node-schemas'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import {
  parseStructuredDataConfig,
  schemaOption,
  STRUCTURED_SCHEMA_OPTIONS,
  schemaKey
} from '../../structured-data'
import type { NodeBodyProps } from '../../registry'
import { AppSelect } from '../../../components/AppSelect'

function fieldEntries(value: unknown, prefix = '', depth = 0): { path: string; value: unknown }[] {
  if (depth > 3 || !value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    const nested = fieldEntries(child, path, depth + 1)
    return [{ path, value: child }, ...nested]
  })
}

export function StructuredBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const config = parseStructuredDataConfig(readNodeConfig(shape))
  const option = schemaOption(config.schema)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(shape.props.text)
  let parsed: unknown = null
  let parseError = Boolean(shape.props.text.trim())
  try {
    parsed = shape.props.text.trim() ? JSON.parse(shape.props.text) : null
    parseError = false
  } catch {
    // 在界面内保留原文，运行时会给出明确字段错误。
  }
  const validation = shape.props.text.trim()
    ? validateNodeSchema(config.schema, parsed)
    : { ok: false, errors: ['等待输入'] }
  const waitingForMapping = !parseError && !validation.ok && shape.props.text.includes('{{')

  const updateConfig = (schemaId: string): void => {
    const next = STRUCTURED_SCHEMA_OPTIONS.find((item) => schemaKey(item.schema) === schemaId)
    if (!next) return
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify({ schema: next.schema }) }
    })
    markUndoPoint(editor, 'structured-schema')
  }

  const fields = validation.ok ? fieldEntries(parsed) : []
  const commit = (): void => {
    setEditing(false)
    if (draft === shape.props.text) return
    editor.updateShape({ id: shape.id, type: 'node-card', props: { text: draft } })
    markUndoPoint(editor, 'structured-edit')
  }

  return (
    <div className="json-body structured-body">
      <div className="structured-header" onPointerDown={(event) => stopEventPropagation(event)}>
        <AppSelect
          className="gen-select"
          aria-label="结构 Schema"
          value={schemaKey(config.schema)}
          onChange={(event) => updateConfig(event.target.value)}
        >
          {STRUCTURED_SCHEMA_OPTIONS.map((item) => (
            <option key={schemaKey(item.schema)} value={schemaKey(item.schema)}>
              {item.label}
            </option>
          ))}
        </AppSelect>
        <span
          className={
            validation.ok
              ? 'json-status valid'
              : waitingForMapping
                ? 'json-status'
                : 'json-status invalid'
          }
        >
          {validation.ok
            ? '字段有效'
            : waitingForMapping
              ? '等待映射'
              : parseError
                ? 'JSON 格式有误'
                : validation.errors[0]}
        </span>
      </div>
      {editing ? (
        <textarea
          className="node-textarea code-edit"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') commit()
          }}
          onPointerDown={(event) => stopEventPropagation(event)}
          spellCheck={false}
        />
      ) : (
        <button
          className="structured-preview"
          onPointerDown={(event) => stopEventPropagation(event)}
          onDoubleClick={(event) => {
            event.stopPropagation()
            setDraft(shape.props.text)
            setEditing(true)
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {shape.props.text.trim()
            ? JSON.stringify(parsed, null, 2)
            : '双击输入 JSON；可使用 {{text}} 或 {{input[0].field}} 引用已连接输入。'}
        </button>
      )}
      {fields.length > 0 && (
        <div className="structured-field-tree" aria-label="结构字段">
          <div className="structured-field-tree-title">字段路径</div>
          {fields.slice(0, 24).map((field) => (
            <button
              type="button"
              className="structured-field-row"
              key={field.path}
              title="复制字段路径"
              onPointerDown={(event) => stopEventPropagation(event)}
              onClick={(event) => {
                event.stopPropagation()
                void navigator.clipboard.writeText(field.path)
              }}
            >
              <code>{field.path}</code>
              <span>{Array.isArray(field.value) ? '数组' : typeof field.value}</span>
            </button>
          ))}
          {fields.length > 24 && <small>还有 {fields.length - 24} 个字段</small>}
        </div>
      )}
      <div className="structured-footer">
        <span>{option.hint}</span>
        <button
          className="btn-ghost small"
          onPointerDown={(event) => stopEventPropagation(event)}
          onClick={(event) => {
            event.stopPropagation()
            setDraft(shape.props.text)
            setEditing(true)
          }}
        >
          {shape.props.text.trim() ? '编辑' : '输入'}
        </button>
      </div>
    </div>
  )
}
