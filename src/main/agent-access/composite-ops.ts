import { DesktopAccessError } from './desktop'
import type { CompositeManifest } from '../../shared/composite/manifest'
import { validateCompositeManifest } from '../../shared/composite/validate'
import { CompositePublishError } from '../../shared/composite/errors'
import { readCompositeManifest } from '../../shared/composite/outputs'
import { compositeRuntimeVersion } from '../../shared/composite/manifest'
import { planCompositeUpgrade, type CompositeConnectedPort } from '../../shared/composite/upgrade'
import * as projects from '../store/projects.repo'
import {
  archiveCompositeCapability,
  getCompositeCapability,
  getCompositeDraft,
  getCompositeVersion,
  listCompositeCapabilities,
  listCompositeVersions,
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

/** 把发布/草稿的结构化错误码原样透出，避免 CLI/MCP 只能解析中文 message。 */
function publishFailure(error: unknown): never {
  if (error instanceof CompositePublishError)
    throw new DesktopAccessError(error.code, false, error.details.version)
  throw error
}

function connectedPorts(projectId: string, nodeId: string, manifest: CompositeManifest): CompositeConnectedPort[] {
  const file = projects.openProject(projectId)
  if (!file) throw new DesktopAccessError('NOT_FOUND', false, 'project')
  const connected: CompositeConnectedPort[] = []
  for (const input of manifest.inputs) {
    const portId = `in-${input.id}`
    for (const edge of file.edges) {
      if (edge.to.nodeId !== nodeId || edge.to.portId !== portId) continue
      connected.push({
        dir: 'in',
        portId,
        type: input.type,
        cardinality: input.cardinality,
        nodeId: edge.from.nodeId,
        edgeId: edge.id
      })
    }
  }
  for (const output of manifest.outputs) {
    const portId = `out-${output.id}`
    for (const edge of file.edges) {
      if (edge.from.nodeId !== nodeId || edge.from.portId !== portId) continue
      connected.push({
        dir: 'out',
        portId,
        type: output.type,
        cardinality: output.cardinality,
        nodeId: edge.to.nodeId,
        edgeId: edge.id
      })
    }
  }
  return connected
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
      try {
        const record = await saveCompositeDraft(
          input.manifest,
          typeof input.expectedRevision === 'number' ? input.expectedRevision : undefined
        )
        return {
          capabilityId: record.capabilityId,
          revision: record.revision,
          updatedAt: record.updatedAt
        }
      } catch (error) {
        return publishFailure(error)
      }
    }
    case 'composite.validate': {
      return validateCompositeManifest(input.manifest)
    }
    case 'composite.publish': {
      const manifest = validManifest(input.manifest)
      try {
        const result = await publishCompositeVersion(manifest, {
          expectedRevision:
            typeof input.expectedRevision === 'number' ? input.expectedRevision : undefined
        })
        return {
          capabilityId: result.record.capabilityId,
          version: result.record.version,
          contentHash: result.record.contentHash,
          created: result.created
        }
      } catch (error) {
        return publishFailure(error)
      }
    }
    case 'composite.upgrade.preview': {
      const projectId = String(input.projectId ?? '')
      const nodeId = String(input.nodeId ?? '')
      const next = validManifest(input.nextManifest)
      const file = projects.openProject(projectId)
      if (!file) throw new DesktopAccessError('NOT_FOUND', false, 'project')
      const node = file.nodes.find((candidate) => candidate.id === nodeId)
      if (!node) throw new DesktopAccessError('NODE_NOT_FOUND', false, nodeId.slice(0, 60))
      if (node.type !== 'composite')
        throw new DesktopAccessError('INVALID_INPUT', false, 'target-node-is-not-composite')
      const previous = readCompositeManifest(
        typeof node.params.config === 'string' ? node.params.config : ''
      )
      if (!previous)
        throw new DesktopAccessError('STORAGE_INCONSISTENT', true, 'composite-instance-manifest')
      // 预检也走发布校验：下一版本本身不合法时直接返回问题，而不是给出可升级假象。
      const validation = validateCompositeManifest(next)
      if (!validation.ok) {
        return {
          previousVersion: previous.version,
          nextVersion: next.version,
          ok: false,
          issues: validation.issues,
          impact: null
        }
      }
      const plan = planCompositeUpgrade(
        previous,
        next,
        connectedPorts(projectId, nodeId, previous)
      )
      return {
        previousVersion: previous.version,
        nextVersion: next.version,
        runtimeVersion: compositeRuntimeVersion(previous),
        ok: plan.ok,
        impact: plan.impact
      }
    }
    case 'composite.version.list':
      return listCompositeVersions(String(input.capabilityId ?? ''))
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

