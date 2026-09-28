// JSON 节点执行器：优先取上游 JSON，否则尝试解析文本，最终格式化回 props.text。
import { inputJson, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'

export const jsonExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  const jsonInputs = inputJson(ctx.inputs, 'in-json')
  const textInput = inputText(ctx.inputs, 'in-text')
  const candidate =
    jsonInputs.length > 0
      ? jsonInputs.length === 1
        ? jsonInputs[0]
        : jsonInputs
      : textInput.trim() || ctx.shape.props.text
  try {
    const value = typeof candidate === 'string' ? JSON.parse(candidate) : candidate
    // JSON 数字字面量会静默改型（"0012" → 12、"1e3" → 1000）：仅当解析结果是 number
    // 且与原文不一致时显式失败，提示加引号保留原样；对象 / 数组 / 布尔 / null /
    // 可精确往返的普通数字不受影响（R-17）。
    if (
      typeof candidate === 'string' &&
      typeof value === 'number' &&
      String(value) !== candidate.trim()
    ) {
      return {
        status: 'failed',
        reason: `纯数字文本 ${candidate.trim()} 会被解析为 ${value}，与原文不一致；如需保留原样请加引号作为字符串`
      }
    }
    ctx.updateProps({ text: JSON.stringify(value, null, 2) })
    return { status: 'done' }
  } catch {
    return { status: 'failed', reason: 'JSON 输入格式无效' }
  }
}
