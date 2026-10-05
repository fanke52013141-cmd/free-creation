import { DiagnosticsProducer, newProducerId, newTraceId, newSpanId } from '@shared/observability'
import { emitDiagnosticsEvent } from '../engine/diagnosticsReporter'
const producer = new DiagnosticsProducer({
  process: 'renderer',
  producerId: newProducerId('renderer')
})
export function reportCanvasFailure(projectId: string, phase: string): void {
  const event = producer.build(
    'project.canvas_failed',
    undefined,
    '画布数据操作失败',
    { projectId, traceId: newTraceId(), spanId: newSpanId() },
    { status: 'failed' }
  )
  emitDiagnosticsEvent(event ? { ...event, phase } : null)
}
