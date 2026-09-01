// 图片资产节点执行器：只输出已导入媒体，执行时不隐式触发任何模型调用。
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'

export const imageExecutor = (ctx: NodeExecutionContext): NodeExecutionResult =>
  ctx.shape.props.mediaPath ? { status: 'done' } : { status: 'skipped', reason: '未导入图片资产' }
