// JSON 节点执行器：优先取上游 JSON，否则尝试解析文本，最终格式化回 props.text。
import { inputJson, inputText } from '../contracts'
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
    ctx.updateProps({ text: JSON.stringify(value, null, 2) })
    return { status: 'done' }
  } catch {
    return { status: 'failed', reason: 'JSON 输入格式无效' }
  }
}
