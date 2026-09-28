import { validateNodeSchema } from '@shared/node-schemas'
import { readNodeConfig } from '../node-config'
import { inputJson, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import {
  interpolateStructuredValueWithMissing,
  parseStructuredDataConfig,
  schemaOption
} from '../../structured-data'

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
  const { value, missing } = interpolateStructuredValueWithMissing(
    parsed,
    inputJson(ctx.inputs, 'in-context'),
    inputText(ctx.inputs, 'in-text')
  )
  // 缺失占位符必须显式失败：静默成功会让对象键被 JSON.stringify 丢弃、字符串内插
  // 空串，下游拿到缺字段的数据还显示 success（R-15）。非占位符字段不受影响。
  if (missing.length > 0) {
    return { status: 'failed', reason: `占位符无法从已连接输入解析：${missing.join('、')}` }
  }
  const validation = validateNodeSchema(config.schema, value)
  if (!validation.ok) {
    return {
      status: 'failed',
      reason: `不符合${schemaOption(config.schema).label}：${validation.errors.join('；')}`
    }
  }
  // props.text 是用户维护的模板，不能用本次插值结果覆盖；否则下一次运行会丢失
  // {{text}} / {{input[n]}} 占位符。运行产物与其它执行器一致写入 meta.nodeResult。
  ctx.updateResult(
    JSON.stringify({ kind: 'structured-result', schema: config.schema, data: value })
  )
  return { status: 'done' }
}
