// 处理节点 Body（路线图 R6：bodies.tsx 拆分）
import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { hasIncomingConnection } from '../../../canvas/graph'
import { VARIABLE_TYPES, parseJsonProp, type VariableValueType } from './shared'

interface ProcessorData {
  inputName: string
  outputName: string
  valueType: VariableValueType
  fallback: string
}

function parseProcessor(text: string): ProcessorData {
  return parseJsonProp(
    text,
    (value) => {
      const data = value as Record<string, unknown>
      if (!data || typeof data !== 'object') return null
      const allowed: VariableValueType[] = ['string', 'number', 'boolean', 'object', 'array', 'any']
      return {
        inputName: typeof data.inputName === 'string' ? data.inputName : 'input',
        outputName: typeof data.outputName === 'string' ? data.outputName : 'output',
        valueType: allowed.includes(data.valueType as VariableValueType)
          ? (data.valueType as VariableValueType)
          : 'any',
        fallback: typeof data.fallback === 'string' ? data.fallback : ''
      }
    },
    { inputName: 'input', outputName: 'output', valueType: 'any', fallback: '' }
  )
}

export function ProcessorBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const data = parseProcessor(shape.props.text)

  const update = (next: ProcessorData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  const hasInput = hasIncomingConnection(editor, shape.id, 'in-value')

  return (
    <div className="processor-body">
      <div className="variable-section-title">变量映射</div>
      <div className="variable-row input">
        <span className="variable-direction">输入</span>
        <input
          value={data.inputName}
          aria-label="输入变量名"
          spellCheck={false}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => update({ ...data, inputName: e.target.value || 'input' })}
        />
        <select
          value={data.valueType}
          aria-label="变量类型"
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => update({ ...data, valueType: e.target.value as VariableValueType })}
        >
          {VARIABLE_TYPES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <div className="variable-map-arrow">↓ 原样传递</div>
      <div className="variable-row output">
        <span className="variable-direction">输出</span>
        <input
          value={data.outputName}
          aria-label="输出变量名"
          spellCheck={false}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => update({ ...data, outputName: e.target.value || 'output' })}
        />
        <span className="variable-type-badge">{data.valueType}</span>
      </div>
      {!hasInput && (
        <input
          className="processor-fallback"
          value={data.fallback}
          placeholder="未连线时使用的固定值（可选）"
          spellCheck={false}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => update({ ...data, fallback: e.target.value })}
        />
      )}
      <div className={`processor-status ${hasInput ? 'connected' : ''}`}>
        {hasInput ? '输入变量已由连线填充' : '等待连线或填写固定值'}
      </div>
    </div>
  )
}
