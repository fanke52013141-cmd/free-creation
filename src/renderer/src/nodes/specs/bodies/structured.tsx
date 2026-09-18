// 结构数据节点 Body：Schema 选择 + JSON 模板编辑 + 占位符可用性。
//
// 占位符（{{text}} / {{input[n].field}}）由执行器按 in-context / in-text 端口的连接顺序
// 解析，界面上必须把「有几个可引用」显式画出来，否则用户无从知道下标从哪来。
import { useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { validateNodeSchema } from '@shared/node-schemas'
import { markUndoPoint } from '../../../canvas/history'
import { countIncomingConnections } from '../../../canvas/graph'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { jsonErrorLocation, useWheelScroll } from './shared'
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

/** 占位符卡片：把执行器认得的 token 与端口真实连线数一起呈现。 */
function PlaceholderTokens({
  textCount,
  contextCount
}: {
  textCount: number
  contextCount: number
}): React.JSX.Element {
  const indexes = Array.from({ length: Math.max(contextCount, 1) }, (_, index) => index).slice(0, 4)
  const copy = (token: string): void => {
    void navigator.clipboard.writeText(token)
  }
  return (
    <div className="structured-tokens" aria-label="占位符">
      <button
        type="button"
        className={`structured-token ${textCount ? 'ready' : 'idle'}`}
        title={
          textCount > 1
            ? `替换为 ${textCount} 条文本上下文按顺序拼接的结果`
            : '替换为 in-text 端口连入的文本'
        }
        onPointerDown={(event) => stopEventPropagation(event)}
        onClick={(event) => {
          event.stopPropagation()
          copy('{{text}}')
        }}
      >
        <code>{'{{text}}'}</code>
        <span>文本上下文 ×{textCount}</span>
      </button>
      {indexes.map((index) => (
        <button
          type="button"
          key={index}
          className={`structured-token ${contextCount > index ? 'ready' : 'idle'}`}
          title={`替换为 in-context 第 ${index + 1} 个 JSON 输入，字段写作 {{input[${index}].名称}}`}
          onPointerDown={(event) => stopEventPropagation(event)}
          onClick={(event) => {
            event.stopPropagation()
            copy(`{{input[${index}]}}`)
          }}
        >
          <code>{`{{input[${index}]}}`}</code>
          <span>结构上下文 ×{contextCount}</span>
        </button>
      ))}
    </div>
  )
}

export function StructuredBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useWheelScroll(scrollRef)
  const config = parseStructuredDataConfig(readNodeConfig(shape))
  const option = schemaOption(config.schema)
  const raw = shape.props.text
  const hasText = Boolean(raw.trim())
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(raw)
  const contextCount = countIncomingConnections(editor, shape.id, 'in-context')
  const textCount = countIncomingConnections(editor, shape.id, 'in-text')
  let parsed: unknown = null
  let parseError: string | null = null
  try {
    parsed = hasText ? JSON.parse(raw) : null
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error)
  }
  const validation = hasText && !parseError ? validateNodeSchema(config.schema, parsed) : null
  // 含占位符的模板在运行前必然校验不过，那是待注入而不是写错了。
  const pendingPlaceholders =
    !parseError && validation !== null && !validation.ok && raw.includes('{{')
  const fields = validation?.ok ? fieldEntries(parsed) : []

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

  const commit = (): void => {
    setEditing(false)
    if (draft === raw) return
    editor.updateShape({ id: shape.id, type: 'node-card', props: { text: draft } })
    markUndoPoint(editor, 'structured-edit')
  }

  const status: { tone: 'valid' | 'invalid' | 'pending'; text: string; title?: string } | null =
    !hasText
      ? null
      : parseError
        ? {
            tone: 'invalid',
            text: jsonErrorLocation(raw, parseError),
            title: parseError
          }
        : validation?.ok
          ? { tone: 'valid', text: `符合${option.label}，可连线使用` }
          : pendingPlaceholders
            ? {
                tone: 'pending',
                text: '含占位符，运行注入连线值后才校验',
                title: validation?.errors.join('；')
              }
            : {
                tone: 'invalid',
                text: `不符合${option.label}`,
                title: validation?.errors.join('；')
              }

  return (
    <div className="json-body structured-body" ref={scrollRef}>
      <div className="structured-header" onPointerDown={(event) => stopEventPropagation(event)}>
        <AppSelect
          className="gen-select"
          aria-label="结构 Schema"
          title="决定 out-json 端口声明的结构，以及运行时按哪套字段校验"
          value={schemaKey(config.schema)}
          onChange={(event) => updateConfig(event.target.value)}
        >
          {STRUCTURED_SCHEMA_OPTIONS.map((item) => (
            <option key={schemaKey(item.schema)} value={schemaKey(item.schema)}>
              {item.label}
            </option>
          ))}
        </AppSelect>
        {status && (
          <span className={`json-status ${status.tone}`} title={status.title}>
            {status.text}
          </span>
        )}
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
            setDraft(raw)
            setEditing(true)
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {hasText ? (parseError ? raw : JSON.stringify(parsed, null, 2)) : '暂无结构数据'}
        </button>
      )}
      <PlaceholderTokens textCount={textCount} contextCount={contextCount} />
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
            setDraft(raw)
            setEditing(true)
          }}
        >
          {hasText ? '编辑' : '输入 JSON'}
        </button>
      </div>
    </div>
  )
}
