import {
  DiagnosticsProducer,
  newProducerId,
  type DiagnosticContext,
  type DiagnosticsEventInput
} from '../../../shared/observability'

export type C0Event =
  | 'started'
  | 'resumed'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'command_replayed'
  | 'command_blocked'
  | 'command_completed'
  | 'command_unknown'
  | 'bridge_dispatch'
  | 'checkpoint_saved'
  | 'storage_failed'
export type C0Telemetry = (
  event: C0Event,
  phase: string,
  code?: string,
  command?: { commandId: string; targetNodeId: string }
) => void

export function createC0Telemetry(
  sink: { emit(event: DiagnosticsEventInput | null): void },
  context: DiagnosticContext
): C0Telemetry {
  const producer = new DiagnosticsProducer({ process: 'main', producerId: newProducerId('main') })
  return (event, phase, code, command): void => {
    try {
      sink.emit(
        producer.build(`agent.c0.${event}`, undefined, 'Agent C0 阶段记录', context, {
          attributes: {
            phase,
            ...(code ? { code } : {}),
            ...(command ? { commandId: command.commandId, targetNodeId: command.targetNodeId } : {})
          },
          ...(event === 'completed' || event === 'command_completed'
            ? { status: 'success' as const }
            : {}),
          ...(event === 'failed' ? { status: 'failed' as const } : {}),
          ...(event === 'command_unknown' ? { status: 'unknown' as const } : {})
        })
      )
    } catch {
      // Diagnostics must never change checkpoint, command or model results.
    }
  }
}
