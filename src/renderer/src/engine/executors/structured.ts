import { validateNodeSchema } from '@shared/node-schemas'
import { readNodeConfig } from '../../canvas/node-persistence'
import { inputJson, inputText } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import {
  interpolateStructuredValue,
  parseStructuredDataConfig,
  schemaOption
} from '../../nodes/structured-data'

/** 通用结构数据执行器：校验本地正文，并可用声明的上下文输入替换字段占位符。 */
export const structuredExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  const config = parseStructuredDataConfig(readNodeConfig(ctx.shape))
  const source = ctx.shape.props.text.trim()
  if (!source) return { status: 'skipped', reason: '请先输入结构化 JSON 数据' }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return { status: 'failed', reason: '结构数据正文不是有效 JSON' }
  }
  const value = interpolateStructuredValue(
    parsed,
    inputJson(ctx.inputs, 'in-context'),
    inputText(ctx.inputs, 'in-text')
  )
  const validation = validateNodeSchema(config.schema, value)
  if (!validation.ok) {
    return {
      status: 'failed',
      reason: `不符合${schemaOption(config.schema).label}：${validation.errors.join('；')}`
    }
  }
  ctx.updateProps({ text: JSON.stringify(value, null, 2), config: JSON.stringify(config) })
  return { status: 'done' }
}
