import { useEditor, stopEventPropagation } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { projectNodeOutputs } from '../../nodeValues'
import { readConnectedNodeInputs } from '../../../canvas/graph'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { VARIABLE_TYPES, type VariableValueType } from './shared'
import { AppSelect } from '../../../components/AppSelect'
import {
  parseProcessor,
  processorInputIssue,
  resolveProcessorInput
} from '@shared/engine/executors/processor'

export function ProcessorBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const data = parseProcessor(readNodeConfig(shape))
  const input = readConnectedNodeInputs(editor, shape.id).find(
    (item) => item.targetPortId === 'in-value'
  )
  const effectiveInput = resolveProcessorInput(data, input?.value ?? null)
  const supportsPick = effectiveInput
    ? effectiveInput.kind === 'json'
    : ['any', 'object', 'array'].includes(data.valueType)
  const issue = processorInputIssue(data, effectiveInput)
  const result = projectNodeOutputs(shape)['out-value']
  const resultText =
    result?.kind === 'text' || result?.kind === 'markdown'
      ? result.text
      : result?.kind === 'json'
        ? JSON.stringify(result.data, null, 2)
        : result
          ? JSON.stringify(result, null, 2)
          : ''
  const update = (next: typeof data): void => {
    editor.updateShape({ id: shape.id, type: 'node-card', props: { config: JSON.stringify(next) } })
  }
  return (
    <div className="processor-body" onPointerDown={stopEventPropagation}>
      <label className="processor-type-label">
        <span>数据类型</span>
        <AppSelect
          className="processor-fixed-type"
          aria-label="数据类型"
          value={data.valueType}
          onChange={(event) => {
            const valueType = event.target.value as VariableValueType
            update({
              ...data,
              valueType,
              operation:
                data.operation === 'pick' && !['any', 'object', 'array'].includes(valueType)
                  ? 'template'
                  : data.operation
            })
          }}
        >
          {VARIABLE_TYPES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </AppSelect>
      </label>
      {!input && (
        <input
          className="processor-fallback"
          value={data.fallback}
          aria-label="固定值"
          placeholder={
            data.operation === 'pick' ? '例如：{"description":"画面描述"}' : '输入固定内容（可选）'
          }
          onChange={(event) => update({ ...data, fallback: event.target.value })}
        />
      )}
      <div className="processor-mode">
        <label className="processor-type-label">
          <span>处理方式</span>
          <AppSelect
            className="gen-select"
            aria-label="处理方式"
            value={data.operation}
            onChange={(event) =>
              update({ ...data, operation: event.target.value as typeof data.operation })
            }
          >
            <option value="pick" disabled={!supportsPick}>
              提取字段
            </option>
            <option value="template">字符串模板</option>
            <option value="pass">原样传递</option>
          </AppSelect>
        </label>
        {data.operation === 'pick' && (
          <input
            value={data.path}
            aria-label="字段路径"
            placeholder="字段路径，例如 description"
            onChange={(event) => update({ ...data, path: event.target.value })}
          />
        )}
        {data.operation === 'template' && (
          <input
            value={data.template}
            aria-label="字符串模板"
            placeholder="例如：镜头：{{value}}"
            onChange={(event) => update({ ...data, template: event.target.value })}
          />
        )}
      </div>
      {issue && (
        <div className="processor-mode-hint" role="status">
          {issue}
        </div>
      )}
      <div className="processor-output">
        <span>输出结果</span>
        {resultText ? (
          <pre>{resultText}</pre>
        ) : (
          <span className="processor-port-state">运行后显示结果</span>
        )}
      </div>
    </div>
  )
}
