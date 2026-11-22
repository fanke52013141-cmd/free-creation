// 文本节点执行器：合并上游文本与节点内正文并写回正文（保留卡片可见结果），
// 但记住本次合并结果，下一次运行先还原用户正文，避免上游变更后旧内容累积重复。
import { inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { mergedPrompt } from '../helpers'

/** 上一次合并的结果与合并前的用户正文；只用于识别「正文是否仍是我们写回的内容」。 */
interface MergeState {
  result: string
  body: string
}

function readMergeState(meta: Record<string, unknown> | undefined): MergeState | null {
  const raw = meta?.textMerge
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw) as { result?: unknown; body?: unknown }
    if (typeof parsed.result === 'string' && typeof parsed.body === 'string') {
      return { result: parsed.result, body: parsed.body }
    }
    return null
  } catch {
    return null
  }
}

export const textExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  const current = ctx.shape.props.text
  // 正文仍是上次写回的结果 → 还原合并前的用户正文；用户手动改过则按新正文处理。
  const state = readMergeState(ctx.shape.meta)
  const body = state && state.result === current ? state.body : current
  const text = mergedPrompt(body, inputText(ctx.inputs, 'in-text'))
  if (!text.trim()) return { status: 'skipped', reason: '无文本输入' }
  // C1：Agent 调度执行（flowCommand）不写回节点正文——正文属于语义修订，
  // 写回会让固定修订契约在提交阶段失败（FLOW_REVISION_CONFLICT）。
  // 合并结果作为本次运行的固定资产走 nodeResult，输出投影按 runId 匹配读取。
  if (ctx.flowCommand) {
    ctx.updateMeta?.({
      nodeResult: JSON.stringify({ kind: 'text', text, runId: ctx.runId })
    })
    return { status: 'done' }
  }
  if (text !== current) ctx.updateProps({ text })
  ctx.updateMeta?.({ textMerge: JSON.stringify({ result: text, body }) })
  return { status: 'done' }
}