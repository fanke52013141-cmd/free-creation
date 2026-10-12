import { DiagnosticsProducer, newProducerId, newTraceId, newSpanId } from '@shared/observability'
import { emitDiagnosticsEvent } from '../../engine/diagnosticsReporter'
const producer = new DiagnosticsProducer({
  process: 'renderer',
  producerId: newProducerId('renderer')
})

export function beginFlowConfigEdit(
  projectId: string,
  nodeId: string,
  nodeType: string
): (state: 'applied' | 'failed', phase: 'validation' | 'apply') => void {
  const context = { projectId, nodeId, nodeType, traceId: newTraceId(), spanId: newSpanId() }
  const emit = (state: 'started' | 'applied' | 'failed', phase: string): void => {
    try {
      emitDiagnosticsEvent(
        producer.build(`canvas.flow_config.${state}`, undefined, '画布协作声明编辑', context, {
          attributes: {
            phase,
            ...(state === 'failed'
              ? {
                  code: phase === 'validation' ? 'FLOW_CONFIG_INVALID' : 'FLOW_CONFIG_APPLY_FAILED'
                }
              : {})
          },
          ...(state === 'started' ? {} : { status: state === 'applied' ? 'success' : 'failed' })
        })
      )
    } catch {
      /* Diagnostic failures never affect the document edit. */
    }
  }
  emit('started', 'validation')
  let ended = false
  return (state, phase): void => {
    if (ended) return
    ended = true
    emit(state, phase)
  }
}
