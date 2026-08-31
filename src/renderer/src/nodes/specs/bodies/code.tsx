// 代码节点 Body（路线图 R6：bodies.tsx 拆分）
// 支持 Coze 风格 async function main(args) 写法，可用本地工具 `_` 和 `dayjs`
// 支持自定义参数端口：用户在 UI 表格中声明额外输入参数
import { useRef, useState, type ReactNode } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import { useWheelScroll, VARIABLE_TYPES, type VariableValueType } from './shared'
import { codePortConfigErrors } from '../../../engine/executors/code'

interface CodeParam {
  name: string
  type: VariableValueType
}

interface CodeConfig {
  source: string
  /** 自然语言描述：用户描述想要的代码功能，AI 据此生成代码。 */
  prompt: string
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
        prompt: typeof value.prompt === 'string' ? value.prompt : '',
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
    prompt: '',
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
      const keys =
        typeof value.data === 'object' && value.data !== null && !Array.isArray(value.data)
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

/* ── 轻量 JS 语法高亮（纯前端 tokenizer，无外部依赖） ── */

const JS_KEYWORDS = new Set([
  'async',
  'await',
  'function',
  'return',
  'const',
  'let',
  'var',
  'if',
  'else',
  'for',
  'while',
  'do',
  'try',
  'catch',
  'finally',
  'new',
  'typeof',
  'instanceof',
  'class',
  'extends',
  'import',
  'export',
  'from',
  'default',
  'of',
  'in',
  'this',
  'null',
  'undefined',
  'true',
  'false',
  'void',
  'delete',
  'break',
  'continue',
  'switch',
  'case',
  'throw'
])

const JS_BUILTINS = new Set([
  'console',
  'JSON',
  'Math',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Date',
  'Promise',
  'Map',
  'Set',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'RegExp',
  'Error',
  'Symbol',
  'Proxy',
  'Reflect',
  'WeakMap',
  'WeakSet'
])

const TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|([a-zA-Z_$][a-zA-Z0-9_$]*)|(\s+)|([^\w\s])/g

function highlightLine(line: string): ReactNode[] {
  const nodes: ReactNode[] = []
  TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = TOKEN_RE.exec(line)) !== null) {
    if (match[1]) {
      nodes.push(
        <span key={key++} className="tok-comment">
          {match[1]}
        </span>
      )
    } else if (match[2]) {
      nodes.push(
        <span key={key++} className="tok-string">
          {match[2]}
        </span>
      )
    } else if (match[3]) {
      nodes.push(
        <span key={key++} className="tok-number">
          {match[3]}
        </span>
      )
    } else if (match[4]) {
      const word = match[4]
      if (JS_KEYWORDS.has(word)) {
        nodes.push(
          <span key={key++} className="tok-keyword">
            {word}
          </span>
        )
      } else if (JS_BUILTINS.has(word) || word === '_' || word === 'dayjs') {
        nodes.push(
          <span key={key++} className="tok-builtin">
            {word}
          </span>
        )
      } else if (/^[A-Z]/.test(word)) {
        nodes.push(
          <span key={key++} className="tok-builtin">
            {word}
          </span>
        )
      } else {
        nodes.push(<span key={key++}>{word}</span>)
      }
    } else {
      nodes.push(<span key={key++}>{match[5] ?? match[6]}</span>)
    }
  }
  return nodes
}

function HighlightedCode({ code }: { code: string }): React.JSX.Element {
  const lines = code.split('\n')
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className="code-line">
          {highlightLine(line)}
        </div>
      ))}
    </>
  )
}

const CODE_TEMPLATE = `async function main(args) {
  // 可用变量：
  //   args.text   — 上游文本输入
  //   args.json   — 上游 JSON 数组
  //   args.{自定义参数名} — 在上方"输入参数"表格中声明的端口
  // 本地帮助：_.get / pick / omit / map / filter / groupBy / uniq / chunk / cloneDeep，dayjs

  const data = args.json || []
  return {
    result: data
  }
}`

export function CodeBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const data = parseCodeConfig(readNodeConfig(shape))
  const portConfigErrors = codePortConfigErrors(readNodeConfig(shape))
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
        props: { config: JSON.stringify({ ...data, source: draft }) }
      })
      markUndoPoint(editor, 'code-edit')
    }
  }

  const updateConfig = (next: CodeConfig): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify(next) }
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
    const lines = draft.split('\n')
    return (
      <div className="code-editor-wrap" ref={scrollRef}>
        <div className="code-editor-gutter">
          {lines.map((_, i) => (
            <div key={i} className="code-line-number">
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          className="node-textarea code-edit with-gutter"
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
          onPointerDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
      </div>
    )
  }

  const text = data.source
  const isMainStyle = /^\s*(async\s+)?function\s+main\b/.test(text)
  return (
    <div className="code-body" ref={scrollRef}>
      <div className="code-ai-section">
        <span className="code-ai-guidance">
          AI 代码生成不在此节点内隐式执行；请使用 AI 处理节点生成文本后，审阅并粘贴代码。
        </span>
      </div>

      <div className="code-variable-contract">
        <div className="variable-row input">
          <span className="variable-direction">输入</span>
          <input
            value={data.inputName}
            aria-label="代码输入变量名"
            spellCheck={false}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => updateConfig({ ...data, inputName: e.target.value || 'input' })}
          />
          <AppSelect
            value={data.inputType}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              updateConfig({ ...data, inputType: e.target.value as VariableValueType })
            }
          >
            {VARIABLE_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </AppSelect>
        </div>
        <div className="variable-row output">
          <span className="variable-direction">输出</span>
          <input
            value={data.outputName}
            aria-label="代码输出变量名"
            spellCheck={false}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => updateConfig({ ...data, outputName: e.target.value || 'output' })}
          />
          <AppSelect
            value={data.outputType}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              updateConfig({ ...data, outputType: e.target.value as VariableValueType })
            }
          >
            {VARIABLE_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </AppSelect>
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
              ，本地帮助 <code>_</code> <code>dayjs</code>（不联网；时间固定、随机数可复跑）
            </>
          ) : (
            <>
              读取 <code>input.{data.inputName}</code>，return 值写入 <code>{data.outputName}</code>
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
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    updateParam(index, { name: e.target.value.replace(/[^\w]/g, '') })
                  }
                />
                <AppSelect
                  className="code-param-type"
                  value={param.type}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    updateParam(index, { type: e.target.value as VariableValueType })
                  }
                >
                  {VARIABLE_TYPES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </AppSelect>
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
        {portConfigErrors.length > 0 && (
          <div className="code-ai-error">
            动态端口配置无效：{portConfigErrors.join('；')}。请修改后再连线或运行。
          </div>
        )}
        {data.params.length === 0 && (
          <div className="code-params-empty">添加自定义输入参数，每个参数生成一个独立输入端口</div>
        )}
      </div>
      {text ? (
        <pre
          className="code-pre highlighted"
          onPointerDown={(e) => stopEventPropagation(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setDraft(data.source)
            setEditing(true)
          }}
        >
          <HighlightedCode code={text} />
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
          双击编写代码
        </div>
      )}
      {resultDisplay && (
        <div className={`code-result ${resultDisplay.kind === 'error' ? 'error' : 'success'}`}>
          <span className="code-result-badge">{resultDisplay.kind === 'error' ? '✗' : '✓'}</span>
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
