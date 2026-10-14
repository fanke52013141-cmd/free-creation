import { emitGatewayEvent } from '../diagnostics/gateway-events'
import type { AgentTaskSnapshot } from '../../shared/agent-flow/runtime-contracts'
import { newTraceId, newSpanId } from '../../shared/observability'

export type AgentTelemetry = (
  event:
    | 'started'
    | 'resumed'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'blocked'
    | 'checkpoint_saved'
    | 'skill_loaded'
    | 'admission_started'
    | 'admission_completed'
    | 'admission_failed'
    | 'resume_check_started'
    | 'resume_check_completed'
    | 'resume_check_failed',
  phase: string,
  code?: string
) => void
export function createAgentTelemetry(
  snapshot: AgentTaskSnapshot,
  operation?: { traceId: string; spanId: string }
): AgentTelemetry {
  let traceId = operation?.traceId ?? snapshot.traceId
  let spanId = operation?.spanId ?? snapshot.spanId
  return (event, phase, code) => {
    if (
      !operation &&
      (event === 'resume_check_started' || (event === 'resumed' && traceId === snapshot.traceId))
    ) {
      traceId = newTraceId()
      spanId = newSpanId()
    }
    emitGatewayEvent(
      `agent.runtime.${event}`,
      'Agent 任务阶段记录',
      {
        traceId,
        spanId,
        projectId: snapshot.projectId,
        nodeId: snapshot.agentNodeId,
        nodeType: 'agent',
        taskId: snapshot.taskId
      },
      {
        attributes: {
          phase,
          code,
          ...(event === 'resumed' ? { resumesTraceId: snapshot.traceId } : {})
        },
        ...(event === 'completed' ||
        event === 'admission_completed' ||
        event === 'resume_check_completed'
          ? { status: 'success' as const }
          : {}),
        ...(event === 'failed' || event === 'admission_failed' || event === 'resume_check_failed'
          ? { status: 'failed' as const }
          : {}),
        ...(event === 'cancelled' ? { status: 'cancelled' as const } : {})
      }
    )
  }
}
