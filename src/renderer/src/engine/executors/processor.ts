// 处理节点执行器：上游值原样传递；未连线时用固定值兜底（按声明类型推断）。
import { inputValue } from '../contracts'
import type { NodeValue } from '../../nodes/nodeValues'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { parseJsonObj, type VariableValueType } from './shared'
import { readNodeConfig } from '../../canvas/node-persistence'

interface ProcessorData {
  inputName: string
  outputName: string
  valueType: VariableValueType
  fallback: string
  operation: 'pass' | 'pick' | 'template'
  path: string
  template: string
}

export function parseProcessor(text: string): ProcessorData {
  const value = parseJsonObj(text)
  return {
    inputName: typeof value?.inputName === 'string' ? value.inputName : 'input',
    outputName: typeof value?.outputName === 'string' ? value.outputName : 'output',
    valueType: (typeof value?.valueType === 'string'
      ? value.valueType
      : 'any') as VariableValueType,
    fallback: typeof value?.fallback === 'string' ? value.fallback : '',
    operation:
      value?.operation === 'pick' || value?.operation === 'template' ? value.operation : 'pass',
    path: typeof value?.path === 'string' ? value.path : '',
    template: typeof value?.template === 'string' ? value.template : ''
  }
}

function valueAtPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
      return (current as Record<string, unknown>)[key]
    }, value)
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value)
}

export const processorExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  const data = parseProcessor(readNodeConfig(ctx.shape))
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
  if (data.operation === 'pick') {
    if (output.kind !== 'json') return { status: 'failed', reason: '提取字段模式只支持 JSON 输入' }
    const picked = valueAtPath(output.data, data.path)
    if (picked === undefined) return { status: 'failed', reason: `字段路径不存在：${data.path}` }
    output =
      typeof picked === 'string' ? { kind: 'text', text: picked } : { kind: 'json', data: picked }
  } else if (data.operation === 'template') {
    const value =
      output.kind === 'text' || output.kind === 'markdown'
        ? output.text
        : output.kind === 'json'
          ? output.data
          : output
    const template = data.template || '{{value}}'
    output = { kind: 'text', text: template.replace(/\{\{\s*value\s*\}\}/g, stringifyValue(value)) }
  }
  ctx.updateResult(JSON.stringify({ ...output, variableName: data.outputName }))
  return { status: 'done' }
}
