// 处理节点执行器：上游值原样传递；未连线时用固定值兜底（按声明类型推断）。
import { inputValue } from '../contracts'
import type { NodeValue } from '../../nodes/nodeValues'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { parseJsonObj, type VariableValueType } from './shared'

interface ProcessorData {
  inputName: string
  outputName: string
  valueType: VariableValueType
  fallback: string
}

export function parseProcessor(text: string): ProcessorData {
  const value = parseJsonObj(text)
  return {
    inputName: typeof value?.inputName === 'string' ? value.inputName : 'input',
    outputName: typeof value?.outputName === 'string' ? value.outputName : 'output',
    valueType: (typeof value?.valueType === 'string'
      ? value.valueType
      : 'any') as VariableValueType,
    fallback: typeof value?.fallback === 'string' ? value.fallback : ''
  }
}

export const processorExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  const data = parseProcessor(ctx.shape.props.text)
  let output: NodeValue | null = inputValue(ctx.inputs, 'in-value')
  if (!output && data.fallback.trim()) {
    if (data.valueType === 'string') {
      output = { kind: 'text', text: data.fallback }
    } else {
      try {
        output = { kind: 'json', data: JSON.parse(data.fallback) }
      } catch {
        output = { kind: 'text', text: data.fallback }
      }
    }
  }
  if (!output) return { status: 'skipped', reason: '处理节点没有输入变量或固定值' }
  ctx.updateResult(JSON.stringify({ ...output, variableName: data.outputName }))
  return { status: 'done' }
}
