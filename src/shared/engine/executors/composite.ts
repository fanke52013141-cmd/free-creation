import type { NodeExecutor, NodeExecutionContext } from '../executor-types'

/**
 * composite 节点的公共执行器：不直接读画布，只把固定版本 manifest 与本次输入交给宿主注入的
 * 隔离执行服务。内部节点仍由 renderer 公共 executor/模型/媒体服务执行。
 */
export const compositeExecutor: NodeExecutor = async (
  ctx: NodeExecutionContext
): Promise<import('../executor-types').NodeExecutionResult> => {
  if (!ctx.runComposite) {
    return { status: 'failed', reason: '组合执行服务未注册（请在桌面宿主中运行）' }
  }
  let manifest: import('../../composite/manifest').CompositeManifest
  try {
    const parsed = JSON.parse(ctx.shape.props.config || '{}') as {
      manifest?: import('../../composite/manifest').CompositeManifest
    }
    if (!parsed.manifest) return { status: 'failed', reason: '组合节点缺少固定版本 manifest' }
    manifest = parsed.manifest
  } catch {
    return { status: 'failed', reason: '组合节点 manifest 已损坏' }
  }
  const outcome = await ctx.runComposite({ manifest, inputs: ctx.inputs, runId: ctx.runId })
  if (outcome.status === 'failed') {
    return { status: 'failed', reason: outcome.reason ?? '组合运行失败' }
  }
  return { status: 'done' }
}
