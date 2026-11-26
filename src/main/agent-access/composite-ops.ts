import { DesktopAccessError } from './desktop'
import type { CompositeManifest } from '../../shared/composite/manifest'
import { validateCompositeManifest, validateCompositePublication } from '../../shared/composite/validate'
import { CompositePublishError } from '../../shared/composite/errors'
import { readCompositeManifest } from '../../shared/composite/outputs'
import { compositeRuntimeVersion } from '../../shared/composite/manifest'
import { planCompositeUpgrade, type CompositeConnectedPort } from '../../shared/composite/upgrade'
import type { CompositeReferenceReport } from '../../shared/composite/types'
import * as projects from '../store/projects.repo'
import {
  archiveCompositeCapability,
  deleteCompositeCapability,
  getCompositeCapability,
  getCompositeDraft,
  getCompositeVersion,
  listCompositeCapabilities,
  listCompositeVersions,
  listNestedCompositeReferences,
  publishCompositeVersion,
  saveCompositeDraft
} from '../store/composite.repo'
import { getCompositeRun, listCompositeRuns } from '../store/composite-run.repo'
import type { CompositeRunRecord } from '../store/composite-run.repo'

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

/** Resolve a bare historical id or canonical out- key against the fixed manifest. */
export function normalizeCompositeOutputPortId(
  manifest: CompositeManifest,
  rawPortId: string
): { id: string; publicId: string } {
  const matches = manifest.outputs.filter(
    (output) => rawPortId === output.id || rawPortId === `out-${output.id}`
  )
  if (matches.length !== 1) {
    throw new DesktopAccessError(
      matches.length > 1 ? 'OUTPUT_PORT_AMBIGUOUS' : 'OUTPUT_PORTS_MISMATCH',
      false,
      rawPortId.slice(0, 100)
    )
  }
  return { id: matches[0]!.id, publicId: `out-${matches[0]!.id}` }
}

/**
 * Manifest-aware run output projection. Current storage keys are bare declared ids;
 * canonical out- keys are accepted only as an unambiguous legacy fallback.
 */
export function projectCompositeRunRecord(run: CompositeRunRecord): CompositeRunRecord {
  if (run.outputValues === null && run.outputSummary.length === 0) return run
  const version = getCompositeVersion(run.capabilityId, run.capabilityVersion)
  if (!version || version.contentHash !== run.contentHash) {
    throw new DesktopAccessError('STORAGE_INCONSISTENT', false, 'composite-run-version')
  }
  const manifest = version.manifest
  if (run.outputValues === null) {
    const outputSummary = run.outputSummary.map((entry) => ({
      ...entry,
      portId: normalizeCompositeOutputPortId(manifest, entry.portId).publicId
    }))
    return { ...run, outputSummary }
  }
  const stored = run.outputValues
  const outputValues: Record<string, unknown> = {}
  const consumed = new Set<string>()
  for (const output of manifest.outputs) {
    const publicId = `out-${output.id}`
    const hasBare = Object.hasOwn(stored, output.id)
    const hasLegacy = Object.hasOwn(stored, publicId)
    if (hasBare && hasLegacy && !manifest.outputs.some((candidate) => candidate.id === publicId)) {
      throw new DesktopAccessError('OUTPUT_KEY_CONFLICT', false, publicId.slice(0, 100))
    }
    if (hasBare) {
      outputValues[publicId] = stored[output.id]
      consumed.add(output.id)
      continue
    }
    if (hasLegacy) {
      // out-foo may be foo's legacy key or the real bare key of another declared
      // output also named out-foo. Never guess which value belongs to foo.
      if (manifest.outputs.some((candidate) => candidate.id === publicId)) {
        throw new DesktopAccessError('OUTPUT_KEY_AMBIGUOUS', false, publicId.slice(0, 100))
      }
      outputValues[publicId] = stored[publicId]
      consumed.add(publicId)
    }
  }
  const unknown = Object.keys(stored).find((key) => !consumed.has(key))
  if (unknown) {
    throw new DesktopAccessError('OUTPUT_KEY_UNKNOWN', false, unknown.slice(0, 100))
  }
  // With values present, derive the summary from those disambiguated values instead
  // of trusting a legacy summary key that may itself be ambiguous.
  const outputSummary = manifest.outputs.flatMap((output) => {
    const publicId = `out-${output.id}`
    if (!Object.hasOwn(outputValues, publicId)) return []
    const value = outputValues[publicId]
    const kind = value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string'
      ? (value as { kind: string }).kind
      : output.type
    return [{ portId: publicId, kind }]
  })
  return { ...run, outputSummary, outputValues }
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

/**
 * 实例升级预检（W3 起 GUI/CLI/MCP 共用）：读取实例当前固定版本，
 * 校验目标 manifest，并按项目实际连线运行同一份 planCompositeUpgrade。
 */
export function previewCompositeUpgrade(
  projectId: string,
  nodeId: string,
  nextManifestInput: unknown
): {
  previousVersion: string
  nextVersion: string
  ok: boolean
  runtimeVersion?: number
  issues?: Array<{ code: string; path: string; message: string }>
  impact: ReturnType<typeof planCompositeUpgrade>['impact'] | null
  previousManifest: CompositeManifest
  nextManifest: CompositeManifest
} {
  const next = validManifest(nextManifestInput)
  const file = projects.openProject(projectId)
  if (!file) throw new DesktopAccessError('NOT_FOUND', false, 'project')
  const node = file.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) throw new DesktopAccessError('NODE_NOT_FOUND', false, nodeId.slice(0, 60))
  if (node.type !== 'composite')
    throw new DesktopAccessError('INVALID_INPUT', false, 'target-node-is-not-composite')
  const previous = readCompositeManifest(
    typeof node.params.config === 'string' ? node.params.config : ''
  ) ?? readInstanceManifestMeta(node.meta)
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
      impact: null,
      previousManifest: previous,
      nextManifest: next
    }
  }
  const plan = planCompositeUpgrade(previous, next, connectedPorts(projectId, nodeId, previous))
  return {
    previousVersion: previous.version,
    nextVersion: next.version,
    runtimeVersion: compositeRuntimeVersion(previous),
    ok: plan.ok,
    impact: plan.impact,
    previousManifest: previous,
    nextManifest: next
  }
}

/** 引用形态实例把快照缓存在 meta.compositeManifest（config 只存固定版本引用）。 */
function readInstanceManifestMeta(meta: unknown): CompositeManifest | null {
  const cached = (meta as Record<string, unknown> | undefined)?.compositeManifest
  if (!cached) return null
  const result = validateCompositeManifest(cached)
  return result.ok ? (cached as CompositeManifest) : null
}

/**
 * 引用检查（W3，GUI/CLI/MCP 共用）：扫描全部项目画布的节点流实例
 * （内嵌 manifest 与固定版本引用两种形态）+ 其他能力发布版本的嵌套依赖。
 * 归档不阻断引用（已绑定实例按固定版本继续运行）；物理删除前必须无引用。
 */
export function findCompositeReferences(capabilityId: string): CompositeReferenceReport {
  const projectInstances: CompositeReferenceReport['projectInstances'] = []
  for (const meta of projects.listProjects()) {
    const file = projects.openProject(meta.id)
    if (!file) continue
    for (const node of file.nodes) {
      if (node.type !== 'composite') continue
      const config = typeof node.params.config === 'string' ? node.params.config : ''
      const embedded = readCompositeManifest(config)
      if (embedded) {
        if (embedded.capabilityId === capabilityId) {
          projectInstances.push({
            projectId: meta.id,
            projectName: meta.name,
            nodeId: node.id,
            version: embedded.version
          })
        }
        continue
      }
      let ref: { capabilityId?: unknown; version?: unknown } = {}
      try {
        ref = JSON.parse(config) as typeof ref
      } catch {
        continue
      }
      if (ref.capabilityId === capabilityId) {
        const cached = readInstanceManifestMeta(node.meta)
        projectInstances.push({
          projectId: meta.id,
          projectName: meta.name,
          nodeId: node.id,
          version: typeof ref.version === 'string' ? ref.version : (cached?.version ?? '')
        })
      }
    }
  }
  return {
    capabilityId,
    projectInstances,
    nestedVersions: listNestedCompositeReferences(capabilityId)
  }
}

/** 物理删除（W3）：与 GUI 同一引用检查；存在引用时拒绝且不改动任何数据。 */
export function deleteCompositeCapabilityChecked(capabilityId: string): { capabilityId: string; deleted: boolean } {
  if (!getCompositeCapability(capabilityId))
    throw new DesktopAccessError('NOT_FOUND', false, 'capability')
  const references = findCompositeReferences(capabilityId)
  const instanceCount = references.projectInstances.length
  const nestedCount = references.nestedVersions.length
  if (instanceCount > 0 || nestedCount > 0) {
    throw new DesktopAccessError(
      'CAPABILITY_IN_USE',
      false,
      `instances:${instanceCount},nested:${nestedCount}`
    )
  }
  const deleted = deleteCompositeCapability(capabilityId)
  if (!deleted) throw new DesktopAccessError('STORAGE_INCONSISTENT', true, 'composite-delete')
  return { capabilityId, deleted }
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
      return validateCompositePublication(input.manifest, {
        getCapability: (id, version) => getCompositeVersion(id, version)?.manifest ?? null
      })
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
      const preview = previewCompositeUpgrade(
        String(input.projectId ?? ''),
        String(input.nodeId ?? ''),
        input.nextManifest
      )
      return {
        previousVersion: preview.previousVersion,
        nextVersion: preview.nextVersion,
        ok: preview.ok,
        ...(preview.runtimeVersion !== undefined ? { runtimeVersion: preview.runtimeVersion } : {}),
        ...(preview.issues ? { issues: preview.issues } : {}),
        impact: preview.impact
      }
    }
    case 'composite.version.list':
      return listCompositeVersions(String(input.capabilityId ?? ''))
    case 'composite.run.get': {
      const record = getCompositeRun(String(input.runId ?? ''))
      if (!record) throw new DesktopAccessError('NOT_FOUND', false, 'composite-run')
      return { ...record, run: projectCompositeRunRecord(record.run) }
    }
    case 'composite.run.list': {
      return listCompositeRuns(
        String(input.projectId ?? ''),
        typeof input.limit === 'number' ? input.limit : undefined
      ).map(projectCompositeRunRecord)
    }
    case 'composite.archive': {
      const capabilityId = String(input.capabilityId ?? '')
      if (!getCompositeCapability(capabilityId))
        throw new DesktopAccessError('NOT_FOUND', false, 'capability')
      const archived = input.archived !== false
      archiveCompositeCapability(capabilityId, archived)
      return { capabilityId, archived }
    }
    case 'composite.references': {
      const capabilityId = String(input.capabilityId ?? '')
      if (!getCompositeCapability(capabilityId))
        throw new DesktopAccessError('NOT_FOUND', false, 'capability')
      return findCompositeReferences(capabilityId)
    }
    case 'composite.delete': {
      return deleteCompositeCapabilityChecked(String(input.capabilityId ?? ''))
    }
    default:
      throw new DesktopAccessError('UNSUPPORTED_OPERATION', false, 'composite-dispatch')
  }
}

