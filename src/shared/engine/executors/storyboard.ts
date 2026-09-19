// 分镜板节点执行器：从上游 JSON/文本或节点存量解析分镜，标准化后写回 props.text。
// 解析一律走 helpers 的共享出口，卡片渲染用同一份，避免两边字段口径漂移。
import { inputJson, inputPackets, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { parseStoryboardData, readStoryboardText } from '../helpers'

export const storyboardExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  const jsonConnected = inputPackets(ctx.inputs, 'in-json').length > 0
  const json = parseStoryboardData(inputJson(ctx.inputs, 'in-json')[0])
  const text = readStoryboardText(inputText(ctx.inputs, 'in-text'))
  const local = readStoryboardText(ctx.shape.props.text)
  const data =
    json ?? (text.kind === 'ok' ? text.data : null) ?? (local.kind === 'ok' ? local.data : null)
  if (data) {
    ctx.updateProps({ text: JSON.stringify(data) })
    return { status: 'done' }
  }
  // 拿不到分镜时分清是哪一路出的问题：一句「无分镜数据」会让用户去猜自己到底没连线还是 JSON 写错。
  if (jsonConnected)
    return { status: 'failed', reason: 'in-json 输入不是分镜数据（需要 {"shots":[…]} 或镜头数组）' }
  if (text.kind !== 'empty')
    return {
      status: 'failed',
      reason: 'in-text 输入不是分镜 JSON（需要 {"shots":[…]} 或镜头数组）'
    }
  if (local.kind !== 'empty')
    return { status: 'failed', reason: '本卡片正文不是分镜 JSON（需要 {"shots":[…]} 或镜头数组）' }
  return { status: 'skipped', reason: '未连接上游分镜数据，且本卡片为空' }
}
