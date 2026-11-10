import { DesktopAccessError } from './desktop'
import type { CompositeManifest } from '../../shared/composite/manifest'
import { validateCompositeManifest } from '../../shared/composite/validate'
import {
  archiveCompositeCapability,
  getCompositeCapability,
  getCompositeDraft,
  getCompositeVersion,
  listCompositeCapabilities,
  publishCompositeVersion,
  saveCompositeDraft
} from '../store/composite.repo'
import { getCompositeRun, listCompositeRuns } from '../store/composite-run.repo'

interface CompositeOperationContext {
  diagnostics?: { traceId: string; spanId: string }
}

function validManifest(value: unknown): CompositeManifest {
  const result = validateCompositeManifest(value)
  if (!result.ok) {
    throw new DesktopAccessError(
      'INVALID_INPUT',
      false,
      result.issues.map((issue) => `${issue.code}:${issue.path}`).join(',')
    )
  }
  return value as CompositeManifest
}

/** P1 Agent 入口：与 GUI/IPC 使用同一 repo 与同一校验；不另写执行器。 */
export async function runCompositeOperation(
  operationId: string,
  input: Record<string, unknown>,
  _context: CompositeOperationContext
): Promise<unknown> {
  void _context
  switch (operationId) {
    case 'composite.search': {
      const items = listCompositeCapabilities({
        query: typeof input.query === 'string' ? input.query : undefined,
        includeArchived: input.includeArchived === true,
        limit: typeof input.limit === 'number' ? input.limit : undefined
      })
      return { total: items.length, items }
    }
    case 'composite.get': {
      const capabilityId = String(input.capabilityId ?? '')
      const capability = getCompositeCapability(capabilityId)
      if (!capability) throw new DesktopAccessError('NOT_FOUND', false, 'capability')
      const version =
        typeof input.version === 'string' ? input.version : capability.latestVersion
      if (!version) throw new DesktopAccessError('NOT_FOUND', false, 'published-version')
      const record = getCompositeVersion(capabilityId, version)
      if (!record) throw new DesktopAccessError('NOT_FOUND', false, 'published-version')
      const validation = validateCompositeManifest(record.manifest)
      if (!validation.ok)
        throw new DesktopAccessError('STORAGE_INCONSISTENT', true, 'manifest-invalid')
      return {
        capabilityId: record.capabilityId,
        version: record.version,
        manifest: record.manifest,
        contentHash: record.contentHash,
        publishedAt: record.publishedAt
      }
    }
    case 'composite.draft.get': {
      const record = getCompositeDraft(String(input.capabilityId ?? ''))
      return record
    }
    case 'composite.draft.save': {
      const record = await saveCompositeDraft(
        input.manifest,
        typeof input.expectedRevision === 'number' ? input.expectedRevision : undefined
      )
      return { capabilityId: record.capabilityId, revision: record.revision, updatedAt: record.updatedAt }
    }
    case 'composite.validate': {
      return validateCompositeManifest(input.manifest)
    }
    case 'composite.publish': {
      const manifest = validManifest(input.manifest)
      const result = await publishCompositeVersion(manifest)
      return {
        capabilityId: result.record.capabilityId,
        version: result.record.version,
        contentHash: result.record.contentHash,
        created: result.created
      }
    }
    case 'composite.run.get': {
      const record = getCompositeRun(String(input.runId ?? ''))
      if (!record) throw new DesktopAccessError('NOT_FOUND', false, 'composite-run')
      return record
    }
    case 'composite.run.list': {
      return listCompositeRuns(
        String(input.projectId ?? ''),
        typeof input.limit === 'number' ? input.limit : undefined
      )
    }
    case 'composite.archive': {
      const capabilityId = String(input.capabilityId ?? '')
      if (!getCompositeCapability(capabilityId))
        throw new DesktopAccessError('NOT_FOUND', false, 'capability')
      const archived = input.archived !== false
      archiveCompositeCapability(capabilityId, archived)
      return { capabilityId, archived }
    }
    default:
      throw new DesktopAccessError('UNSUPPORTED_OPERATION', false, 'composite-dispatch')
  }
}

