// 文本节点执行器：把上游文本与节点内文本合并写回 props.text。
import { inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { mergedPrompt } from '../helpers'

export const textExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  const text = mergedPrompt(ctx.shape.props.text, inputText(ctx.inputs, 'in-text'))
  if (!text.trim()) return { status: 'skipped', reason: '无文本输入' }
  if (text !== ctx.shape.props.text) ctx.updateProps({ text })
  return { status: 'done' }
}
