// 数据处理执行器：按配置提取字段或套用模板；旧原样传递配置保留兼容。
// 输入/输出端口固定为 in-value / out-value，因此配置里没有“变量名”概念：
// 任何名字都不会影响连线，曾经的名字输入框只是装饰，已删除。
import { inputValue } from '../inputs'
import type { NodeValue } from '../values'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { parseJsonObj, type VariableValueType } from '../helpers'
import { readNodeConfig } from '../node-config'

export interface ProcessorData {
  valueType: VariableValueType
  fallback: string
  operation: 'pass' | 'pick' | 'template'
  path: string
  template: string
}

export function parseProcessor(text: string): ProcessorData {
  const value = parseJsonObj(text)
  return {
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
      if (!current || typeof current !== 'object') return undefined
      return (current as Record<string, unknown>)[key]
    }, value)
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value)
}

/** The card preflight and executor use the same effective value and validation. */
export function resolveProcessorInput(
  data: ProcessorData,
  connected: NodeValue | null
): NodeValue | null {
  if (connected) return connected
  if (!data.fallback.trim()) return null
  if (data.valueType !== 'string') {
    try {
      return { kind: 'json', data: JSON.parse(data.fallback) }
    } catch {
      // Plain fixed content remains text; field extraction must explicitly reject it.
    }
  }
  return { kind: 'text', text: data.fallback }
}

export function processorInputIssue(data: ProcessorData, value: NodeValue | null): string | null {
  if (!value) return '请连接输入或填写固定内容'
  if (data.operation !== 'pick') return null
  if (value.kind !== 'json') return '提取字段需要 JSON 输入，请改用字符串模板'
  if (!data.path.trim()) return '请填写字段路径'
  if (valueAtPath(value.data, data.path) === undefined) return `字段路径不存在：${data.path}`
  return null
}

export const processorExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  const data = parseProcessor(readNodeConfig(ctx.shape))
  let output = resolveProcessorInput(data, inputValue(ctx.inputs, 'in-value'))
  if (!output) return { status: 'skipped', reason: '处理节点没有输入变量或固定值' }
  const issue = processorInputIssue(data, output)
  if (issue) return { status: 'failed', reason: issue }
  if (data.operation === 'pick') {
    if (output.kind !== 'json') return { status: 'failed', reason: '提取字段需要 JSON 输入' }
    const picked = valueAtPath(output.data, data.path)
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
  ctx.updateResult(JSON.stringify(output))
  return { status: 'done' }
}
