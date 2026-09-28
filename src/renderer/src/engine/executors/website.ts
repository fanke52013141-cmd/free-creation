import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readWebsiteLink } from '@shared/website-link'

export const websiteExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  if (!readWebsiteLink(ctx.shape.props.config)) {
    return { status: 'skipped', reason: '请先在右侧设置网址名称和有效链接' }
  }
  return { status: 'done' }
}
