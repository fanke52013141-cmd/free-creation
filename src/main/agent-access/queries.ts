import type { DiagnosticsService } from '../diagnostics/service'
import { searchResources } from '../store/library.repo'
import type { AccessOutput } from '../../shared/agent-access/registry'

/** Only the metadata selected here crosses the external discovery boundary. */
export function searchAccessLibrary(
  input: Parameters<typeof searchResources>[0]
): AccessOutput<'library.search'> {
  const result = searchResources(input)
  return {
    items: result.items.map((resource) => ({
      id: resource.id,
      title: resource.title.slice(0, 200),
      formPreset: resource.formPreset,
      latestRevisionId: resource.latestRevisionId,
      revisionNumber: resource.revisionNumber,
      componentCount: resource.componentCount,
      updatedAt: resource.updatedAt,
      archived: resource.archivedAt !== undefined
    })),
    nextCursor: result.nextCursor
  }
}

export function accessDiagnosticsSummary(
  service?: Pick<DiagnosticsService, 'health'> | null
): AccessOutput<'diagnostics.summary'> {
  const health = service?.health()
  return {
    available: health?.available ?? false,
    degraded: health?.degraded ?? true,
    received: health?.received ?? 0,
    written: health?.written ?? 0,
    queueDepth: health?.queueDepth ?? 0,
    droppedTotal: health?.droppedTotal ?? 0,
    writeFailures: health?.writeFailures ?? 0,
    badLines: health?.badLines ?? 0
  }
}
