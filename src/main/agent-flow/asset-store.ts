import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { ProjectFile } from '../../shared/types'
import type { NodeShape } from '../../shared/engine/executor-types'
import {
  DETERMINISTIC_PROJECTIONS,
  readPinnedOutputs
} from '../../shared/engine/deterministic-projections'
import { AgentFlowAssetRefSchema } from '../../shared/agent-flow/node-contracts'
import { readStoredNodeRunStatus } from '../../shared/engine/run-status'
import {
  AssetSubmitSchema,
  FlowAssetError,
  type AssetSubmit,
  type FlowAssetVersion,
  type FlowAssetSummary
} from '../../shared/agent-flow/assets'

interface AssetRow {
  version_id: string
  asset_id: string
  project_id: string
  node_id: string
  port_id: string
  ordinal: number
  graph_version: number
  created_at: number
  digest: string
  value_json: string
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function fail(code: string): never {
  throw new FlowAssetError(code)
}
function summary(row: Omit<AssetRow, 'value_json'>): FlowAssetSummary {
  return {
    ref: {
      assetId: row.asset_id,
      versionId: row.version_id,
      sourceNodeId: row.node_id,
      sourcePortId: row.port_id
    },
    projectId: row.project_id,
    ordinal: row.ordinal,
    graphVersion: row.graph_version,
    createdAt: row.created_at,
    digest: row.digest
  }
}
function decode(row: AssetRow): FlowAssetVersion {
  return { ...summary(row), value: JSON.parse(row.value_json) }
}

/** Main-only authority. Values come from the saved desktop snapshot, never an IPC body. */
export class FlowAssetStore {
  constructor(
    private readonly db: Database.Database,
    private readonly project: (id: string) => ProjectFile | null
  ) {}

  submit(raw: AssetSubmit): FlowAssetVersion {
    const input = AssetSubmitSchema.parse(raw)
    const signature = hash(JSON.stringify([input.nodeId, input.portId, input.expectedGraphVersion]))
    let phase = 'project-read'
    try {
      return this.db.transaction(() => {
        const project = this.project(input.projectId) ?? fail('ASSET_PROJECT_MISSING')
        phase = 'receipt-lookup'
        const previous = this.db
          .prepare(
            'SELECT signature, version_id FROM flow_asset_submissions WHERE project_id = ? AND submission_id = ?'
          )
          .get(input.projectId, input.submissionId) as
          { signature: string; version_id: string } | undefined
        if (previous) {
          if (previous.signature !== signature) fail('ASSET_SUBMISSION_CONFLICT')
          phase = 'receipt-read'
          const version = this.read(input.projectId, previous.version_id)
          phase = 'transaction-commit'
          return version
        }
        phase = 'revision'
        if (project.meta.graphVersion !== input.expectedGraphVersion)
          fail('ASSET_REVISION_CONFLICT')
        phase = 'source-projection'
        const snapshot = project.tldrawSnapshot as { store?: Record<string, unknown> } | undefined
        const record = snapshot?.store?.[input.nodeId] as
          (NodeShape & { id: string; type: string }) | undefined
        if (!record || record.id !== input.nodeId || record.type !== 'node-card')
          fail('ASSET_NODE_MISSING')
        const projection =
          DETERMINISTIC_PROJECTIONS[
            record.props?.nodeType as keyof typeof DETERMINISTIC_PROJECTIONS
          ]
        if (!Object.hasOwn(DETERMINISTIC_PROJECTIONS, record.props?.nodeType) || !projection)
          fail('ASSET_TYPE_UNSUPPORTED')
        const pinned = readPinnedOutputs(
          (record.meta as Record<string, unknown> | undefined)?.pinnedOutput
        )
        // Same pinned-first rule as the public renderer projection.
        const runStatus = readStoredNodeRunStatus(record.meta?.nodeRun)
        if (
          !pinned &&
          record.props.nodeType === 'processor' &&
          runStatus &&
          runStatus !== 'success'
        )
          fail('ASSET_OUTPUT_UNAVAILABLE')
        const declaredPort =
          record.props.nodeType === 'text'
            ? 'out-text'
            : record.props.nodeType === 'json'
              ? 'out-json'
              : 'out-value'
        if (input.portId !== declaredPort) fail('ASSET_PORT_INVALID')
        if (pinned && Object.keys(pinned).some((key) => key !== declaredPort))
          fail('ASSET_OUTPUT_INVALID')
        const value = (pinned ?? projection(record))[input.portId]
        if (!value) fail('ASSET_OUTPUT_UNAVAILABLE')
        if (
          (record.props.nodeType === 'json' && value.kind !== 'json') ||
          (record.props.nodeType === 'text' && value.kind !== 'text' && value.kind !== 'markdown')
        )
          fail('ASSET_OUTPUT_INVALID')
        if (value.kind !== 'text' && value.kind !== 'markdown' && value.kind !== 'json')
          fail('ASSET_VALUE_UNSUPPORTED')
        const body = JSON.stringify(value)
        if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) fail('ASSET_VALUE_TOO_LARGE')
        const last = this.db
          .prepare(
            'SELECT asset_id, ordinal FROM flow_asset_versions WHERE project_id = ? AND node_id = ? AND port_id = ? ORDER BY ordinal DESC LIMIT 1'
          )
          .get(input.projectId, input.nodeId, input.portId) as
          { asset_id: string; ordinal: number } | undefined
        const versionId = randomUUID()
        phase = 'version-persist'
        this.db
          .prepare('INSERT INTO flow_asset_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            versionId,
            last?.asset_id ?? randomUUID(),
            input.projectId,
            input.nodeId,
            input.portId,
            (last?.ordinal ?? 0) + 1,
            project.meta.graphVersion,
            Date.now(),
            hash(body),
            body
          )
        phase = 'receipt-persist'
        this.db
          .prepare('INSERT INTO flow_asset_submissions VALUES (?, ?, ?, ?)')
          .run(input.projectId, input.submissionId, signature, versionId)
        const version = this.read(input.projectId, versionId)
        phase = 'transaction-commit'
        return version
      })()
    } catch (error) {
      throw new FlowAssetError(
        error instanceof FlowAssetError ? error.code : 'ASSET_STORAGE_FAILED',
        phase
      )
    }
  }

  read(projectId: string, versionId: string): FlowAssetVersion {
    if (!this.project(projectId)) fail('ASSET_PROJECT_MISSING')
    const row = this.db
      .prepare('SELECT * FROM flow_asset_versions WHERE project_id = ? AND version_id = ?')
      .get(projectId, versionId) as AssetRow | undefined
    if (!row) fail('ASSET_VERSION_MISSING')
    if (hash(row.value_json) !== row.digest) fail('ASSET_INTEGRITY_FAILED')
    return decode(row)
  }

  list(projectId: string, nodeId: string, portId: string): FlowAssetSummary[] {
    if (!this.project(projectId)) fail('ASSET_PROJECT_MISSING')
    const rows = this.db
      .prepare(
        'SELECT version_id, asset_id, project_id, node_id, port_id, ordinal, graph_version, created_at, digest FROM flow_asset_versions WHERE project_id = ? AND node_id = ? AND port_id = ? ORDER BY ordinal DESC LIMIT 100'
      )
      .all(projectId, nodeId, portId) as Omit<AssetRow, 'value_json'>[]
    return rows.map(summary)
  }

  /** Ordered immutable reads for C2.2. Ref identity is checked in full, not just versionId. */
  resolveInputs(projectId: string, refs: unknown[]): FlowAssetVersion[] {
    if (refs.length > 128) fail('ASSET_INPUT_LIMIT')
    return refs.map((raw) => {
      const ref = AgentFlowAssetRefSchema.parse(raw)
      const version = this.read(projectId, ref.versionId)
      if (
        version.ref.assetId !== ref.assetId ||
        version.ref.sourceNodeId !== ref.sourceNodeId ||
        version.ref.sourcePortId !== ref.sourcePortId
      )
        fail('ASSET_REFERENCE_MISMATCH')
      return version
    })
  }
}
