import type { NodeExecutor } from '../executor-types'

export const AGENT_FLOW_EXECUTION_PENDING = '配置已开放，执行能力待接入'
/** C1 is configuration-only: no gateway call, state mutation or fabricated output. */
export const agentFlowPendingExecutor: NodeExecutor = () => ({
  status: 'skipped',
  reason: AGENT_FLOW_EXECUTION_PENDING
})
