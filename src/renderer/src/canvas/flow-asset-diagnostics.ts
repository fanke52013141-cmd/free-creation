import { DiagnosticsProducer, newProducerId, newSpanId, newTraceId } from '@shared/observability'
import { emitDiagnosticsEvent } from '../engine/diagnosticsReporter'
const producer = new DiagnosticsProducer({
  process: 'renderer',
  producerId: newProducerId('renderer')
})
export function beginAssetPlacement(
  projectId: string,
  nodeId: string,
  phase: 'canvas-apply' | 'draft-apply' = 'canvas-apply'
): (success: boolean) => void {
  const context = { projectId, nodeId, traceId: newTraceId(), spanId: newSpanId() }
  const emit = (stage: 'started' | 'applied' | 'failed'): void => {
    try {
      emitDiagnosticsEvent(
        producer.build(`asset.placement.${stage}`, undefined, '固定资产放到画布', context, {
          attributes: { phase },
          ...(stage === 'started' ? {} : { status: stage === 'applied' ? 'success' : 'failed' })
        })
      )
    } catch {
      /* A diagnostic failure cannot change the edit. */
    }
  }
  emit('started')
  let ended = false
  return (success): void => {
    if (!ended) {
      ended = true
      emit(success ? 'applied' : 'failed')
    }
  }
}
