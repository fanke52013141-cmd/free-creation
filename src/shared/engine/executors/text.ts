// 文本节点执行器：上游文本与正文合并的结果只作为本次运行结果，不改写用户正文。
// 正文（props.text）属于用户素材；合并结果写 nodeResult，输出投影按 runId 匹配读取，
// 卡片用独立只读结果区呈现（见 NODE_UI_STANDARD「文本节点运行结果区」）。
import { inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { mergedPrompt } from '../helpers'

export const textExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  const text = mergedPrompt(ctx.shape.props.text, inputText(ctx.inputs, 'in-text'))
  if (!text.trim()) return { status: 'skipped', reason: '无文本输入' }
  // Agent 调度（flowCommand）与手动运行同构：都不写回正文，避免上游增删改后旧前缀累积。
  ctx.updateMeta?.({
    nodeResult: JSON.stringify({ kind: 'text', text, runId: ctx.runId })
  })
  return { status: 'done' }
}