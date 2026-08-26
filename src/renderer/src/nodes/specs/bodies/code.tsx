// 代码节点 Body（路线图 R6：bodies.tsx 拆分）
// 支持 Coze 风格 async function main(args) 写法，可用 lodash(_) 和 dayjs
// 支持自定义参数端口：用户在 UI 表格中声明额外输入参数
import { useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { markUndoPoint } from '../../../canvas/history'
import { Icon } from '../../../components/Icon'
import { useWheelScroll, VARIABLE_TYPES, type VariableValueType } from './shared'

interface CodeParam {
  name: string
  type: VariableValueType
}

interface CodeConfig {
  source: string
  inputName: string
  inputType: VariableValueType
  outputName: string
  outputType: VariableValueType
  params: CodeParam[]
}

interface CodeResultDisplay {
  kind: 'text' | 'json' | 'error'
  summary: string
}

function parseCodeConfig(text: string): CodeConfig {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (value && typeof value === 'object' && typeof value.source === 'string') {
      const allowed: VariableValueType[] = ['string', 'number', 'boolean', 'object', 'array', 'any']
      const rawParams = Array.isArray(value.params) ? value.params : []
      const params: CodeParam[] = rawParams
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
        .map((p) => ({
          name: typeof p.name === 'string' ? p.name : '',
          type: allowed.includes(p.type as VariableValueType)
            ? (p.type as VariableValueType)
            : 'any'
        }))
        .filter((p) => p.name.trim())
      return {
        source: value.source,
        inputName: typeof value.inputName === 'string' ? value.inputName : 'input',
        inputType: allowed.includes(value.inputType as VariableValueType)
          ? (value.inputType as VariableValueType)
          : 'any',
        outputName: typeof value.outputName === 'string' ? value.outputName : 'output',
        outputType: allowed.includes(value.outputType as VariableValueType)
          ? (value.outputType as VariableValueType)
          : 'any',
        params
      }
    }
  } catch {
    // 旧版本纯代码文本直接迁移为 source。
  }
  return {
    source: text,
    inputName: 'input',
    inputType: 'any',
    outputName: 'output',
    outputType: 'any',
    params: []
  }
}

/** 从 shape.meta.nodeResult 解析上次执行结果（成功摘要或错误信息）。 */
function parseCodeResult(metaResult: string | undefined): CodeResultDisplay | null {
  if (!metaResult) return null
  try {
    const value = JSON.parse(metaResult) as Record<string, unknown>
    if (value.kind === 'error' && typeof value.message === 'string') {
      return { kind: 'error', summary: value.message }
    }
    if (value.kind === 'text' && typeof value.text === 'string') {
      return { kind: 'text', summary: value.text.slice(0, 80) }
    }
    if (value.kind === 'json') {
      const keys = typeof value.data === 'object' && value.data !== null && !Array.isArray(value.data)
        ? Object.keys(value.data as object).join(', ')
        : Array.isArray(value.data)
          ? `Array[${(value.data as unknown[]).length}]`
          : ''
      return { kind: 'json', summary: keys ? `JSON { ${keys} }` : 'JSON' }
    }
  } catch {
    // 忽略
  }
  return null
}

const CODE_TEMPLATE = `async function main(args) {
  // 可用变量：
  //   args.text   — 上游文本输入
  //   args.json   — 上游 JSON 数组
  //   args.{自定义参数名} — 在上方"输入参数"表格中声明的端口
  // 可用库：_(lodash)、dayjs

  const data = args.json || []
  return {
    result: data
  }
}`

export function CodeBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const data = parseCodeConfig(shape.props.text)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(data.source)
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)

  const resultDisplay = parseCodeResult(shape.meta?.nodeResult as string | undefined)

  const commit = (): void => {
    setEditing(false)
    if (draft !== data.source) {
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: { text: JSON.stringify({ ...data, source: draft }) }
      })
      markUndoPoint(editor, 'code-edit')
    }
  }

  const updateConfig = (next: CodeConfig): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  const addParam = (): void => {
    const used = new Set(data.params.map((p) => p.name))
    let name = 'param1'
    let i = 1
    while (used.has(name)) name = `param${++i}`
    updateConfig({ ...data, params: [...data.params, { name, type: 'any' }] })
    markUndoPoint(editor, 'code-add-param')
  }

  const updateParam = (index: number, patch: Partial<CodeParam>): void => {
    const params = data.params.map((p, i) => (i === index ? { ...p, ...patch } : p))
    updateConfig({ ...data, params })
  }

  const removeParam = (index: number): void => {
    const params = data.params.filter((_, i) => i !== index)
    updateConfig({ ...data, params })
    markUndoPoint(editor, 'code-remove-param')
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

  const text = data.source
  const isMainStyle = /^\s*(async\s+)?function\s+main\b/.test(text)
  return (
    <div className="code-body" ref={scrollRef}>
      <div className="code-variable-contract">
        <div className="variable-row input">
          <span className="variable-direction">输入</span>
          <input
            value={data.inputName}
            aria-label="代码输入变量名"
            spellCheck={false}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) => updateConfig({ ...data, inputName: e.target.value || 'input' })}
          />
          <select
            value={data.inputType}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) =>
              updateConfig({ ...data, inputType: e.target.value as VariableValueType })
            }
          >
            {VARIABLE_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="variable-row output">
          <span className="variable-direction">输出</span>
          <input
            value={data.outputName}
            aria-label="代码输出变量名"
            spellCheck={false}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) => updateConfig({ ...data, outputName: e.target.value || 'output' })}
          />
          <select
            value={data.outputType}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) =>
              updateConfig({ ...data, outputType: e.target.value as VariableValueType })
            }
          >
            {VARIABLE_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="code-variable-help">
          {isMainStyle ? (
            <>
              读取 <code>args.text</code> / <code>args.json</code>
              {data.params.length > 0 && (
                <>
                  {' '}
                  /{' '}
                  {data.params.map((p, i) => (
                    <span key={i}>
                      {i > 0 && ' / '}
                      <code>args.{p.name}</code>
                    </span>
                  ))}
                </>
              )}
              ，可用库 <code>_</code> <code>dayjs</code>
            </>
          ) : (
            <>
              读取 <code>input.{data.inputName}</code>，return 值写入{' '}
              <code>{data.outputName}</code>
            </>
          )}
        </div>
      </div>
      <div className="code-params-section">
        <div className="code-params-header">
          <span className="code-params-title">输入参数</span>
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              addParam()
            }}
          >
            <Icon name="add" size={12} />
            添加
          </button>
        </div>
        {data.params.length > 0 && (
          <div className="code-params-table">
            {data.params.map((param, index) => (
              <div key={index} className="code-param-row">
                <input
                  className="code-param-name"
                  value={param.name}
                  spellCheck={false}
                  placeholder="参数名"
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onChange={(e) =>
                    updateParam(index, { name: e.target.value.replace(/[^\w]/g, '') })
                  }
                />
                <select
                  className="code-param-type"
                  value={param.type}
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onChange={(e) =>
                    updateParam(index, { type: e.target.value as VariableValueType })
                  }
                >
                  {VARIABLE_TYPES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <button
                  className="code-param-remove"
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeParam(index)
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {data.params.length === 0 && (
          <div className="code-params-empty">添加自定义输入参数，每个参数生成一个独立输入端口</div>
        )}
      </div>
      {text ? (
        <pre
          className="code-pre"
          onPointerDown={(e) => stopEventPropagation(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setDraft(data.source)
            setEditing(true)
          }}
        >
          {text}
        </pre>
      ) : (
        <div
          className="node-hint center"
          onPointerDown={(e) => stopEventPropagation(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setDraft(CODE_TEMPLATE)
            setEditing(true)
          }}
        >
          双击编写代码（可用 _ lodash、dayjs、async/await）
        </div>
      )}
      {resultDisplay && (
        <div className={`code-result ${resultDisplay.kind === 'error' ? 'error' : 'success'}`}>
          <span className="code-result-badge">
            {resultDisplay.kind === 'error' ? '✗' : '✓'}
          </span>
          <span className="code-result-text">{resultDisplay.summary}</span>
        </div>
      )}
      <div className="code-toolbar">
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            setDraft(text || CODE_TEMPLATE)
            setEditing(true)
          }}
        >
          <>
            <Icon name="edit" size={14} />
            {text ? '编辑' : '输入'}
          </>
        </button>
      </div>
    </div>
  )
}
