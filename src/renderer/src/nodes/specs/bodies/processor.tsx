// 处理节点 Body（路线图 R6：bodies.tsx 拆分）
//
// 这一版将界面对齐到 processorExecutor 的真实分支：端口固定为 in-value / out-value，
// 所以旧的「输入/输出变量名」输入框被删除——改名不会改变任何连线，只会让人以为需要填。
import { useRef } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { hasIncomingConnection } from '../../../canvas/graph'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { VARIABLE_TYPES, parseJsonProp, useWheelScroll, type VariableValueType } from './shared'
import { AppSelect } from '../../../components/AppSelect'

interface ProcessorData {
  valueType: VariableValueType
  fallback: string
  operation: 'pass' | 'pick' | 'template'
  path: string
  template: string
}

const EMPTY: ProcessorData = {
  valueType: 'any',
  fallback: '',
  operation: 'pass',
  path: '',
  template: ''
}

function parseProcessor(text: string): ProcessorData {
  return parseJsonProp(
    text,
    (value) => {
      const data = value as Record<string, unknown>
      if (!data || typeof data !== 'object') return null
      const allowed: VariableValueType[] = ['string', 'number', 'boolean', 'object', 'array', 'any']
      return {
        valueType: allowed.includes(data.valueType as VariableValueType)
          ? (data.valueType as VariableValueType)
          : 'any',
        fallback: typeof data.fallback === 'string' ? data.fallback : '',
        operation:
          data.operation === 'pick' || data.operation === 'template' ? data.operation : 'pass',
        path: typeof data.path === 'string' ? data.path : '',
        template: typeof data.template === 'string' ? data.template : ''
      }
    },
    EMPTY
  )
}

/** 与执行器分支一一对应，避免界面描述出格。 */
const MODE_HINTS: Record<ProcessorData['operation'], string> = {
  pass: '输入值原样写入 out-value，类型不变。',
  pick: '只支持 JSON 输入：按 . 分段从输入值取字段，取不到就失败。',
  template: '模板里的 {{value}} 换成输入值，对象与数组会写成 JSON 文本。'
}

export function ProcessorBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useWheelScroll(scrollRef)
  const data = parseProcessor(readNodeConfig(shape))
  const hasInput = hasIncomingConnection(editor, shape.id, 'in-value')
  const usesFallback = !hasInput && Boolean(data.fallback.trim())

  const update = (next: ProcessorData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify(next) }
    })
  }

  const hasPlaceholder = /\{\{\s*value\s*\}\}/.test(data.template)
  const status: { text: string; tone: 'idle' | 'connected' | 'warn' } =
    !hasInput && !usesFallback
      ? { text: '既没有连线也没有固定值，运行会跳过', tone: 'warn' }
      : data.operation === 'pick' && !data.path.trim()
        ? { text: '未填字段路径，运行会失败', tone: 'warn' }
        : data.operation === 'template' && data.template.trim() && !hasPlaceholder
          ? { text: '模板不含 {{value}}，输出将固定不变', tone: 'warn' }
          : hasInput
            ? { text: '取 in-value 连线值，运行后写入 out-value', tone: 'connected' }
            : { text: '取固定值，运行后写入 out-value', tone: 'idle' }

  return (
    <div className="processor-body" ref={scrollRef}>
      <div className="variable-row input">
        <span className="variable-direction">输入</span>
        <span className={`processor-port-state ${hasInput ? 'connected' : ''}`}>
          {hasInput ? '连线已接入' : usesFallback ? '未连线，用固定值' : '未连线'}
        </span>
        <code className="variable-expr">in-value</code>
      </div>
      {!hasInput && (
        <div className="processor-fixed">
          <input
            className="processor-fallback"
            value={data.fallback}
            aria-label="固定值"
            placeholder="无连线时当作输入值的固定内容"
            spellCheck={false}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) => update({ ...data, fallback: e.target.value })}
          />
          <AppSelect
            className="processor-fixed-type"
            aria-label="固定值类型"
            title="只决定固定值怎么解释：文本保持原样，其它类型按 JSON 解析"
            value={data.valueType}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) => update({ ...data, valueType: e.target.value as VariableValueType })}
          >
            {VARIABLE_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </AppSelect>
        </div>
      )}
      <div className="processor-mode">
        <AppSelect
          className="gen-select"
          aria-label="处理方式"
          value={data.operation}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) =>
            update({ ...data, operation: e.target.value as ProcessorData['operation'] })
          }
        >
          <option value="pass">原样传递</option>
          <option value="pick">提取字段</option>
          <option value="template">字符串模板</option>
        </AppSelect>
        {data.operation === 'pick' && (
          <input
            value={data.path}
            aria-label="字段路径"
            placeholder="以输入值为根的字段路径，例如 description"
            spellCheck={false}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) => update({ ...data, path: e.target.value })}
          />
        )}
        {data.operation === 'template' && (
          <input
            value={data.template}
            aria-label="字符串模板"
            placeholder="例如：镜头：{{value}}"
            spellCheck={false}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) => update({ ...data, template: e.target.value })}
          />
        )}
        <div className="processor-mode-hint">{MODE_HINTS[data.operation]}</div>
      </div>
      <div className="variable-map-arrow">
        ↓{' '}
        {data.operation === 'pass'
          ? '原样传递'
          : data.operation === 'pick'
            ? '取出字段'
            : '套入模板'}
      </div>
      <div className="variable-row output">
        <span className="variable-direction">输出</span>
        <span className="processor-port-state">运行后产出</span>
        <code className="variable-expr">out-value</code>
      </div>
      <div className={`processor-status ${status.tone}`}>{status.text}</div>
    </div>
  )
}
