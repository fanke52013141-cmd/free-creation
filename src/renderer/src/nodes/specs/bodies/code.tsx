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
import {
  CODE_VALUE_TYPES,
  codePortConfigErrors,
  outputFieldPortId,
  outputPortId,
  paramPortId,
  parseCodeConfigs,
  type CodeConfig as SharedCodeConfig,
  type CodeOutputField,
  type CodeParam,
  type CodeValueType
} from '../../../engine/executors/code'

interface CodeConfig extends SharedCodeConfig {
  /** 自然语言描述：用户描述想要的代码功能，AI 据此生成代码。 */
  prompt: string
}

interface CodeResultDisplay {
  kind: 'text' | 'json' | 'error'
  summary: string
}

function parseCodeConfig(text: string): CodeConfig {
  let prompt = ''
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (typeof value.prompt === 'string') prompt = value.prompt
  } catch {
    // 旧版本纯代码文本直接迁移为 source。
  }
  return { ...parseCodeConfigs(text), prompt }
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
    if (value.kind === 'camera') {
      const data =
        value.data && typeof value.data === 'object' && !Array.isArray(value.data)
          ? (value.data as Record<string, unknown>)
          : {}
      const label = typeof data.name === 'string' ? data.name : String(data.id ?? '已输出')
      return { kind: 'json', summary: `机位参数 · ${label}` }
    }
    if (value.kind === 'code-outputs' && value.values && typeof value.values === 'object') {
      return {
        kind: 'json',
        summary: `已输出 ${Object.keys(value.values as object).length} 个字段`
      }
    }
    if (
      value.kind === 'image' ||
      value.kind === 'video' ||
      value.kind === 'audio' ||
      value.kind === 'file'
    ) {
      return { kind: 'json', summary: `已输出 ${value.kind} 资产引用` }
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
  //   args.json   — 按连线顺序排列的 JSON 值（值本身仍可为数组）
  //   args.images / videos / audios / files — 媒体资产引用数组
  //   args.{自定义参数名} — 在上方"输入参数"表格中声明的端口
  // 本地帮助：_.get / pick / omit / map / filter / groupBy / uniq / chunk / cloneDeep，dayjs

  const data = args.json || []
  return {
    output: data
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
    updateConfig({
      ...data,
      params: [...data.params, { name, type: 'any', cardinality: 'one', portId: paramPortId(name) }]
    })
    markUndoPoint(editor, 'code-add-param')
  }

  const updateParam = (index: number, patch: Partial<CodeParam>): void => {
    const params = data.params.map((p, i) =>
      i === index ? { ...p, portId: p.portId || paramPortId(p.name), ...patch } : p
    )
    updateConfig({ ...data, params })
  }

  const removeParam = (index: number): void => {
    const params = data.params.filter((_, i) => i !== index)
    updateConfig({ ...data, params })
    markUndoPoint(editor, 'code-remove-param')
  }

  const enableMultiOutput = (): void => {
    updateConfig({
      ...data,
      outputMode: 'fields',
      outputs: [
        { name: data.outputName, type: data.outputType, portId: outputPortId(data.outputName) }
      ]
    })
    markUndoPoint(editor, 'code-enable-multi-output')
  }

  const addOutput = (): void => {
    const used = new Set(data.outputs.map((output) => output.name))
    let name = 'output2'
    let i = 2
    while (used.has(name)) name = `output${++i}`
    const outputs =
      data.outputMode === 'fields'
        ? data.outputs
        : [{ name: data.outputName, type: data.outputType, portId: outputPortId(data.outputName) }]
    updateConfig({
      ...data,
      outputMode: 'fields',
      outputs: [...outputs, { name, type: 'any', portId: outputPortId(name) }]
    })
    markUndoPoint(editor, 'code-add-output')
  }

  const updateOutput = (index: number, patch: Partial<CodeOutputField>): void => {
    const outputs = data.outputs.map((output, i) =>
      i === index
        ? { ...output, portId: output.portId || outputPortId(output.name), ...patch }
        : output
    )
    updateConfig({ ...data, outputMode: 'fields', outputs })
  }

  const removeOutput = (index: number): void => {
    if (data.outputs.length <= 1) return
    updateConfig({
      ...data,
      outputMode: 'fields',
      outputs: data.outputs.filter((_, i) => i !== index)
    })
    markUndoPoint(editor, 'code-remove-output')
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
  const inputExpr = isMainStyle ? `args.${data.inputName}` : `input.${data.inputName}`
  return (
    <div className="code-body" ref={scrollRef}>
      <div className="code-variable-contract">
        <div className="variable-row input">
          <span className="variable-direction">输入</span>
          <input
            value={data.inputName}
            aria-label="代码输入变量名"
            spellCheck={false}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              updateConfig({ ...data, inputName: e.target.value.replace(/[^\w]/g, '') || 'input' })
            }
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
          <code className="variable-expr">{inputExpr}</code>
        </div>
        {data.outputMode === 'single' ? (
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
                updateConfig({ ...data, outputType: e.target.value as CodeValueType })
              }
            >
              {CODE_VALUE_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </AppSelect>
            <code className="variable-expr">return → 端口</code>
          </div>
        ) : (
          <div className="variable-row output">
            <span className="variable-direction">输出</span>
            <code className="code-output-object">
              {`return { ${data.outputs.map((output) => output.name).join(', ')} }`}
            </code>
            <span className="variable-type-badge">按字段接到多个端口</span>
          </div>
        )}
        <div className="code-variable-help">
          {isMainStyle ? (
            <>
              代码里读 <code>args.text</code> / <code>args.json</code> / <code>{inputExpr}</code>
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
              ；
              {data.outputMode === 'fields' ? (
                <>返回对象的已声明字段分别流向多个输出端口</>
              ) : (
                <>
                  <code>return</code> 的值从右侧 <code>{outputPortId(data.outputName)}</code>{' '}
                  端口流出
                </>
              )}
            </>
          ) : (
            <>
              读取 <code>{inputExpr}</code>，<code>return</code> 的值写入端口{' '}
              {data.outputMode === 'fields' ? (
                <>返回对象的已声明字段分别流向多个输出端口</>
              ) : (
                <>
                  <code>{outputPortId(data.outputName)}</code>
                </>
              )}
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
                  onChange={(e) => updateParam(index, { type: e.target.value as CodeValueType })}
                >
                  {CODE_VALUE_TYPES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </AppSelect>
                <AppSelect
                  className="code-param-cardinality"
                  aria-label={`${param.name} 输入基数`}
                  title="单值只接一条上游；多值会按连线顺序作为数组传入代码"
                  value={param.cardinality ?? 'one'}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    updateParam(index, { cardinality: e.target.value as 'one' | 'many' })
                  }
                >
                  <option value="one">单值</option>
                  <option value="many">多值</option>
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
        {data.params.length === 0 && (
          <div className="code-params-empty">添加字段后，会在画布上出现同名输入端口。</div>
        )}
        {portConfigErrors.length > 0 && (
          <div className="code-ai-error" role="alert">
            动态端口配置无效：{portConfigErrors.join('；')}。请修改后再连线或运行。
          </div>
        )}
      </div>
      <div className="code-params-section code-outputs-section">
        <div className="code-params-header">
          <span className="code-params-title">输出字段</span>
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              if (data.outputMode === 'single') enableMultiOutput()
              else addOutput()
            }}
          >
            <Icon name="add" size={12} />
            {data.outputMode === 'single' ? '启用多输出' : '添加输出'}
          </button>
        </div>
        {data.outputMode === 'single' ? (
          <div className="code-params-empty">
            当前为单输出兼容模式。启用多输出后，代码需返回与字段名一致的对象，例如{' '}
            {'{ caption: "...", count: 2 }'}。
          </div>
        ) : (
          <div className="code-params-table">
            {data.outputs.map((output, index) => (
              <div className="code-param-row code-output-row" key={output.portId ?? index}>
                <input
                  className="code-param-name"
                  value={output.name}
                  spellCheck={false}
                  placeholder="字段名"
                  aria-label={`输出字段 ${index + 1} 名称`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    updateOutput(index, { name: e.target.value.replace(/[^\w]/g, '') })
                  }
                />
                <AppSelect
                  className="code-param-type"
                  aria-label={`${output.name} 输出类型`}
                  value={output.type}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => updateOutput(index, { type: e.target.value as CodeValueType })}
                >
                  {CODE_VALUE_TYPES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </AppSelect>
                <span className="code-output-port-id" title={outputFieldPortId(output)}>
                  {outputFieldPortId(output)}
                </span>
                <button
                  className="code-param-remove"
                  aria-label={`删除输出字段 ${output.name}`}
                  disabled={data.outputs.length <= 1}
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeOutput(index)
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>
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
          暂无代码
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
            {text ? '编辑代码' : '编写代码'}
          </>
        </button>
      </div>
    </div>
  )
}
