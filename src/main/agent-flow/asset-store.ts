import { fixedFlowImage, fixedFlowMedia } from './image-assets'
import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { ProjectFile } from '../../shared/types'
import type { NodeShape } from '../../shared/engine/executor-types'
import { FlowReviewStore } from './review-store'
import {
  DETERMINISTIC_PROJECTIONS,
  readPinnedOutputs
} from '../../shared/engine/deterministic-projections'
import {
  AgentFlowAssetRefSchema,
  type AgentFlowAssetRef
} from '../../shared/agent-flow/node-contracts'
import { readStoredNodeRunStatus } from '../../shared/engine/run-status'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { agentReplyOutputProjection } from '../../shared/agent-flow/agent-outputs'
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

  submit(
    raw: AssetSubmit,
    commandPermit?: { commandId: string; leaseId: string }
  ): FlowAssetVersion {
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
        phase = 'occupancy'
        const occupied = this.db
          .prepare(
            "SELECT command_id, lease_id FROM flow_commands WHERE project_id = ? AND target_node_id = ? AND state IN ('pending', 'unknown')"
          )
          .get(input.projectId, input.nodeId) as
          { command_id: string; lease_id: string } | undefined
        if (
          occupied &&
          (occupied.command_id !== commandPermit?.commandId ||
            occupied.lease_id !== commandPermit?.leaseId)
        )
          fail('ASSET_SOURCE_OCCUPIED')
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
          ['processor', 'agent', 'video', 'image-gen', 'image-edit', 'speech', 'tts'].includes(
            record.props.nodeType
          ) &&
          runStatus &&
          runStatus !== 'success'
        )
          fail('ASSET_OUTPUT_UNAVAILABLE')
        const declaredPort =
          record.props.nodeType === 'text'
            ? 'out-text'
            : record.props.nodeType === 'json'
              ? 'out-json'
              : record.props.nodeType === 'audio'
                ? 'out-audio'
                : ['image-gen', 'image-edit'].includes(record.props.nodeType)
                  ? 'out-image'
                  : record.props.nodeType === 'speech'
                    ? 'out-audio'
                    : record.props.nodeType === 'tts'
                      ? 'out-json'
                      : ['video', 'video-asset', 'image'].includes(record.props.nodeType)
                        ? record.props.nodeType === 'image'
                          ? 'out-image'
                          : 'out-video'
                        : 'out-value'
        if (record.props.nodeType === 'agent') {
          if (!['out-text', 'out-json'].includes(input.portId)) fail('ASSET_PORT_INVALID')
          if (runStatus !== 'success') fail('ASSET_OUTPUT_UNAVAILABLE')
          const result = JSON.parse(record.meta?.nodeResult ?? '{}')
          if (typeof result.taskId !== 'string') fail('ASSET_OUTPUT_UNAVAILABLE')
          const task =
            (this.db
              .prepare(
                "SELECT output_refs_json FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=? AND task_id=? AND state='completed'"
              )
              .get(input.projectId, input.nodeId, result.taskId) as
              { output_refs_json: string } | undefined) ??
            (this.db
              .prepare(
                "SELECT json_extract(body_json,'$.outputs') AS output_refs_json FROM flow_coordination_runs WHERE project_id=? AND node_id=? AND task_id=? AND json_extract(body_json,'$.state')='completed'"
              )
              .get(input.projectId, input.nodeId, result.taskId) as
              { output_refs_json: string } | undefined)
          if (!task || pinned) fail('ASSET_OUTPUT_UNAVAILABLE')
          const outputRefs = JSON.parse(task.output_refs_json) as AgentFlowAssetRef[]
          const versions = this.resolveInputs(input.projectId, outputRefs)
          const expected = agentReplyOutputProjection(
            outputRefs,
            versions.map((version) => version.value)
          )
          const actual = projection(record)[input.portId]
          if (
            !actual ||
            !expected[input.portId as 'out-text' | 'out-json'] ||
            canonicalFlowJson(expected[input.portId as 'out-text' | 'out-json']) !==
              canonicalFlowJson(actual)
          )
            fail('ASSET_OUTPUT_INVALID')
        } else if (record.props.nodeType === 'ai-review') {
          const review = new FlowReviewStore(this.db).latest(input.projectId, input.nodeId)
          if (
            !review ||
            pinned ||
            runStatus !== 'success' ||
            !['out-review', 'out-feedback'].includes(input.portId)
          )
            fail('ASSET_OUTPUT_UNAVAILABLE')
          if (
            canonicalFlowJson(JSON.parse(record.meta?.nodeResult ?? '{}')) !==
            canonicalFlowJson(review.decision)
          )
            fail('ASSET_OUTPUT_INVALID')
        } else if (input.portId !== declaredPort) fail('ASSET_PORT_INVALID')
        if (pinned && Object.keys(pinned).some((key) => key !== declaredPort))
          fail('ASSET_OUTPUT_INVALID')
        let value = (pinned ?? projection(record))[input.portId]
        if (!value) fail('ASSET_OUTPUT_UNAVAILABLE')
        if (
          (record.props.nodeType === 'json' && value.kind !== 'json') ||
          (record.props.nodeType === 'text' && value.kind !== 'text' && value.kind !== 'markdown')
        )
          fail('ASSET_OUTPUT_INVALID')
        if (
          value.kind !== 'text' &&
          value.kind !== 'markdown' &&
          value.kind !== 'json' &&
          value.kind !== 'video' &&
          value.kind !== 'image' &&
          value.kind !== 'audio'
        )
          fail('ASSET_VALUE_UNSUPPORTED')
        if (value.kind === 'image') {
          if (!['image', 'image-gen', 'image-edit'].includes(record.props.nodeType) || pinned)
            fail('ASSET_OUTPUT_INVALID')
          value = fixedFlowImage(this.db, input.projectId, value)
        }
        if (value.kind === 'audio') {
          if (!['audio', 'speech'].includes(record.props.nodeType) || pinned)
            fail('ASSET_OUTPUT_INVALID')
          value = fixedFlowMedia(this.db, input.projectId, value)
        }
        if (value.kind === 'video' && record.props.nodeType === 'video-asset' && !pinned) {
          value = fixedFlowMedia(this.db, input.projectId, value)
        } else if (value.kind === 'video') {
          if (
            record.props.nodeType !== 'video' ||
            !commandPermit ||
            pinned ||
            runStatus !== 'success'
          )
            fail('ASSET_OUTPUT_INVALID')
          const task = this.db
            .prepare(
              "SELECT output FROM tasks WHERE project_id=? AND node_id=? AND kind='video' AND status='success' AND json_extract(input,'$.flowCommandId')=?"
            )
            .get(input.projectId, input.nodeId, commandPermit.commandId) as
            { output: string } | undefined
          const saved = task ? JSON.parse(task.output) : null
          const media = this.db
            .prepare('SELECT path,mime,kind FROM media WHERE id=?')
            .get(value.mediaId) as { path: string; mime: string; kind: string } | undefined
          if (
            !saved ||
            saved.mediaId !== value.mediaId ||
            saved.videoMaterialization?.phase !== 'committed' ||
            !media ||
            media.kind !== 'video' ||
            media.path !== value.mediaPath ||
            media.mime !== value.mime
          )
            fail('ASSET_OUTPUT_INVALID')
        }
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

  readSubmission(projectId: string, submissionId: string): FlowAssetVersion | null {
    if (!this.project(projectId)) fail('ASSET_PROJECT_MISSING')
    const receipt = this.db
      .prepare(
        'SELECT version_id FROM flow_asset_submissions WHERE project_id = ? AND submission_id = ?'
      )
      .get(projectId, submissionId) as { version_id: string } | undefined
    return receipt ? this.read(projectId, receipt.version_id) : null
  }

  read(projectId: string, versionId: string): FlowAssetVersion {
    if (!this.project(projectId)) fail('ASSET_PROJECT_MISSING')
    const row = this.db
      .prepare('SELECT * FROM flow_asset_versions WHERE project_id = ? AND version_id = ?')
      .get(projectId, versionId) as AssetRow | undefined
    if (!row) fail('ASSET_VERSION_MISSING')
    if (hash(row.value_json) !== row.digest) fail('ASSET_INTEGRITY_FAILED')
    const version = decode(row)
    if (version.value.kind === 'image') {
      if (!/^[a-f0-9]{64}$/.test(version.value.contentSha256)) fail('ASSET_INTEGRITY_FAILED')
      fixedFlowImage(this.db, projectId, version.value)
    }
    if (version.value.kind === 'video' && version.value.contentSha256 !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(version.value.contentSha256)) fail('ASSET_INTEGRITY_FAILED')
      fixedFlowMedia(this.db, projectId, version.value)
    }
    if (version.value.kind === 'audio') {
      if (!/^[a-f0-9]{64}$/.test(version.value.contentSha256 ?? '')) fail('ASSET_INTEGRITY_FAILED')
      fixedFlowMedia(this.db, projectId, version.value)
    }
    return version
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
