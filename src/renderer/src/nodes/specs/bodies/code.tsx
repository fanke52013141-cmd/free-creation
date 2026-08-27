// 代码节点 Body（路线图 R6：bodies.tsx 拆分）
// 支持 Coze 风格 async function main(args) 写法，可用 lodash(_) 和 dayjs
// 支持自定义参数端口：用户在 UI 表格中声明额外输入参数
// 支持 AI 生成代码：用户写自然语言描述，AI 自动生成代码
import { useRef, useState, type ReactNode } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { markUndoPoint } from '../../../canvas/history'
import { Icon } from '../../../components/Icon'
import { useWheelScroll, VARIABLE_TYPES, type VariableValueType } from './shared'
import { useGatewayStore, findTextModel } from '../../../stores/gateway'
import { waitForChat, parseJsonObj } from '../../../engine/executors/shared'
import { sanitizePortId } from '../../../engine/executors/code'

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

/** 动态参数端口以归一化 ID 寻址；提前显式提示碰撞，不能让两个表项悄悄共用端口。 */
function duplicateParamPortIds(params: CodeParam[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const param of params) {
    const id = sanitizePortId(param.name)
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  return [...duplicates]
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

/* ── AI 代码生成的系统提示词 ── */

function buildCodeGenSystem(config: CodeConfig): string {
  const paramList =
    config.params.length > 0
      ? config.params
          .map((p) => `   - args.${p.name}：${p.type} 类型，用户声明的输入参数`)
          .join('\n')
      : '   （无自定义参数）'
  return `你是一个 JavaScript 代码生成专家。根据用户的自然语言描述，生成一段可在 Worker 中执行的代码。

严格要求：
1. 必须使用 async function main(args) { ... } 格式
2. 可用变量：
   - args.text：字符串，上游文本输入
   - args.json：数组，上游 JSON 输入
${paramList}
3. 可用库：_(lodash) 和 dayjs
4. 必须 return 一个值（字符串、数字、布尔值、对象或数组）
5. 代码要简洁、高效、有适当注释
6. 只输出代码本身，不要任何解释文字、不要 markdown 代码块标记`
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
  const duplicateParamIds = duplicateParamPortIds(data.params)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(data.source)
  const [generating, setGenerating] = useState(false)
  const [aiError, setAiError] = useState('')
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

  /** AI 生成代码：用自然语言描述调用对话模型生成代码。 */
  const generateCode = async (): Promise<void> => {
    const description = data.prompt.trim()
    if (!description) return
    const providers = useGatewayStore.getState().providers
    const option = findTextModel(
      providers,
      (parseJsonObj(shape.props.text)?.modelKey as string) ?? '',
      true
    )
    if (!option) {
      setAiError('未配置可用的对话模型，请先在设置中添加')
      return
    }
    setGenerating(true)
    setAiError('')
    try {
      const reply = await waitForChat(
        {
          providerId: option.provider.id,
          modelId: option.model.id,
          system: buildCodeGenSystem(data),
          messages: [{ role: 'user', content: description }]
        },
        { cancelled: false }
      )
      // 提取代码：去掉可能的 markdown 代码块标记
      const cleaned = reply
        .replace(/^```(?:javascript|js)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim()
      const newConfig = { ...data, source: cleaned }
      updateConfig(newConfig)
      markUndoPoint(editor, 'code-ai-generate')
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error))
    } finally {
      setGenerating(false)
    }
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
          onPointerDown={(e) => stopEventPropagation(e)}
          spellCheck={false}
        />
      </div>
    )
  }

  const text = data.source
  const isMainStyle = /^\s*(async\s+)?function\s+main\b/.test(text)
  return (
    <div className="code-body" ref={scrollRef}>
      {/* AI 代码生成区域 */}
      <div className="code-ai-section">
        <textarea
          className="code-ai-input"
          value={data.prompt}
          placeholder="描述你想要的代码功能，例如：把 JSON 数组按日期排序并提取标题字段"
          rows={2}
          spellCheck={false}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => updateConfig({ ...data, prompt: e.target.value })}
        />
        <button
          className="btn-ai-generate"
          disabled={generating || !data.prompt.trim()}
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            void generateCode()
          }}
        >
          {generating ? (
            <>
              <span className="code-ai-spinner" />
              生成中...
            </>
          ) : (
            <>
              <Icon name="edit" size={12} />
              AI 生成代码
            </>
          )}
        </button>
      </div>
      {aiError && <div className="code-ai-error">{aiError}</div>}

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
        {duplicateParamIds.length > 0 && (
          <div className="code-ai-error">
            输入参数名称归一化后重复：{duplicateParamIds.join('、')}。请修改其中一个名称。
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
          双击编写代码，或在上方描述功能让 AI 生成
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
