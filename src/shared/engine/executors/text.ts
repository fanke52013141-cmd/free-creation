// 文本节点执行器：把上游文本与节点内文本合并写回 props.text。
import { inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { mergedPrompt } from '../helpers'

export const textExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  const text = mergedPrompt(ctx.shape.props.text, inputText(ctx.inputs, 'in-text'))
  if (!text.trim()) return { status: 'skipped', reason: '无文本输入' }
  // C1：Agent 调度执行（flowCommand）不写回节点正文——正文属于语义修订，
  // 写回会让固定修订契约在提交阶段失败（FLOW_REVISION_CONFLICT）。
  // 合并结果作为本次运行的固定资产走 nodeResult，输出投影按 runId 匹配读取；
  // 用户素材节点保持原样，符合"AI 出候选、人不被静默修改"的产品原则。
  if (ctx.flowCommand) {
    ctx.updateMeta?.({
      nodeResult: JSON.stringify({ kind: 'text', text, runId: ctx.runId })
    })
    return { status: 'done' }
  }
  if (text !== ctx.shape.props.text) ctx.updateProps({ text })
  return { status: 'done' }
}
