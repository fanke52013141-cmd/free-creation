// 代码节点 Body（路线图 R6：bodies.tsx 拆分）
import { useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { markUndoPoint } from '../../../canvas/history'
import { Icon } from '../../../components/Icon'
import { useWheelScroll, VARIABLE_TYPES, type VariableValueType } from './shared'

interface CodeConfig {
  source: string
  inputName: string
  inputType: VariableValueType
  outputName: string
  outputType: VariableValueType
}

function parseCodeConfig(text: string): CodeConfig {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (value && typeof value === 'object' && typeof value.source === 'string') {
      const allowed: VariableValueType[] = ['string', 'number', 'boolean', 'object', 'array', 'any']
      return {
        source: value.source,
        inputName: typeof value.inputName === 'string' ? value.inputName : 'input',
        inputType: allowed.includes(value.inputType as VariableValueType)
          ? (value.inputType as VariableValueType)
          : 'any',
        outputName: typeof value.outputName === 'string' ? value.outputName : 'output',
        outputType: allowed.includes(value.outputType as VariableValueType)
          ? (value.outputType as VariableValueType)
          : 'any'
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
    outputType: 'any'
  }
}

export function CodeBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const data = parseCodeConfig(shape.props.text)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(data.source)
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)

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
          代码中读取 <code>input.{data.inputName}</code>，return 值写入{' '}
          <code>{data.outputName}</code>
        </div>
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
            setDraft(data.source)
            setEditing(true)
          }}
        >
          双击输入代码片段（可处理文本 / JSON 数据）
        </div>
      )}
      <div className="code-toolbar">
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            setDraft(data.source)
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
