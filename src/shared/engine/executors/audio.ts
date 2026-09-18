// 音频资产节点只承接/保存媒体。
//
// 通用配音（speech）已拆到 executors/speech.ts：它是模型驱动节点，端口与参数面
// 由所选协议决定，和「导入一段音频」的资产节点不是同一种职责。
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'

export const audioExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  // audio 是纯资产源节点，不读取或转发上游值；只有其已导入媒体才可发布为 out-audio。
  if (ctx.node.type !== 'audio') {
    return { status: 'skipped', reason: '音频资产执行器不支持该节点类型' }
  }
  return ctx.shape.props.mediaPath
    ? { status: 'done' }
    : { status: 'skipped', reason: '未导入音频资产' }
}
