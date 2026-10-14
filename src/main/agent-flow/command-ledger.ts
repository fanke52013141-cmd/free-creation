import type Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import type { ProjectFile, PortDecl } from '../../shared/types'
import type { NodeShape } from '../../shared/engine/executor-types'
import { readStoredNodeRunStatus } from '../../shared/engine/run-status'
import { computeInputFingerprint } from '../../shared/engine/input-fingerprint'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { readPinnedOutputs } from '../../shared/engine/deterministic-projections'
import { AgentFlowAssetRefSchema } from '../../shared/agent-flow/node-contracts'
import {
  AgentNodeConfigSchema,
  ReviewNodeConfigSchema
} from '../../shared/agent-flow/node-contracts'
import {
  PROCESSOR_PORTS,
  PROCESSOR_CONTRACT_VERSION
} from '../../shared/agent-flow/processor-contract'
import {
  NodeExecuteCommandSchema,
  CommandLookupSchema,
  CommandLeaseSchema,
  FlowCommandError,
  type NodeExecuteCommand,
  type CommandLookup,
  type CommandLease,
  type FlowCommandReceipt,
  type FlowCommandPrepareResult,
  type FlowCommandGrant
} from '../../shared/agent-flow/commands'
import { nodeCommandIntentSignature, projectSemanticRevision } from './command-intent'
import { FlowAssetStore } from './asset-store'
import { FlowAssetError } from '../../shared/agent-flow/assets'
import { FlowReviewStore } from './review-store'
import { controlledReview } from './coordination-store'

interface Row {
  project_id: string
  command_id: string
  command_json: string
  signature: string
  lease_id: string
  owner_session: string
  run_id: string
  state: FlowCommandReceipt['state']
  receipt_json: string
  admitted: number
}
type SavedShape = NodeShape & { id: string; type: string; meta?: Record<string, unknown> }
function fail(code: string, phase: string): never {
  throw new FlowCommandError(code, phase)
}
function savedShape(project: ProjectFile, id: string): SavedShape {
  const snapshot = project.tldrawSnapshot as { store?: Record<string, SavedShape> } | undefined
  const shape = snapshot?.store?.[id]
  if (shape?.id !== id || shape.type !== 'node-card') return fail('FLOW_NODE_MISSING', 'scope')
  return shape
}
function portIdentity(ports: PortDecl[]): string {
  return JSON.stringify(
    [...ports]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((port) => [
        port.id,
        port.dir,
        port.type,
        port.required,
        port.cardinality,
        port.schema ?? null,
        port.exclusiveGroup ?? null
      ])
  )
}

/** Durable desktop command authority. No business execution occurs in main. */
export class FlowCommandLedger {
  readonly sessionId = randomUUID()
  private readonly assets: FlowAssetStore
  constructor(
    private readonly db: Database.Database,
    private readonly project: (id: string) => ProjectFile | null
  ) {
    this.assets = new FlowAssetStore(db, project)
  }

  /** Startup is conservative: a lost renderer may have performed an effect. Keep occupancy. */
  recoverAbandoned(): FlowCommandReceipt[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM flow_commands WHERE state = 'pending' AND owner_session != ?")
        .all(this.sessionId) as Row[]
      return rows.map((row) =>
        this.update(row, {
          ...JSON.parse(row.receipt_json),
          state: 'unknown',
          code: 'FLOW_SESSION_LOST'
        })
      )
    })()
  }
  loseRenderer(): FlowCommandReceipt[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM flow_commands WHERE state = 'pending' AND owner_session = ?")
        .all(this.sessionId) as Row[]
      return rows.map((row) =>
        this.update(row, {
          ...JSON.parse(row.receipt_json),
          state: 'unknown',
          code: 'FLOW_RENDERER_LOST'
        })
      )
    })()
  }
  private file(projectId: string): ProjectFile {
    return this.project(projectId) ?? fail('FLOW_PROJECT_MISSING', 'project-read')
  }
  private row(input: CommandLookup): Row {
    this.file(input.projectId)
    return (
      (this.db
        .prepare('SELECT * FROM flow_commands WHERE project_id = ? AND command_id = ?')
        .get(input.projectId, input.commandId) as Row | undefined) ??
      fail('FLOW_COMMAND_MISSING', 'receipt-read')
    )
  }
  private update(row: Row, receipt: FlowCommandReceipt): FlowCommandReceipt {
    this.db
      .prepare(
        'UPDATE flow_commands SET state = ?, receipt_json = ? WHERE project_id = ? AND command_id = ?'
      )
      .run(receipt.state, JSON.stringify(receipt), row.project_id, row.command_id)
    return receipt
  }
  lookup(raw: CommandLookup): FlowCommandReceipt {
    const row = this.row(CommandLookupSchema.parse(raw))
    return JSON.parse(row.receipt_json)
  }
  assertNodeAvailable(input: {
    projectId: string
    nodeId: string
    controlledRequestId?: string
  }): void {
    if (
      this.file(input.projectId).nodes.find((n) => n.id === input.nodeId)?.type !== 'agent' &&
      !(
        input.controlledRequestId &&
        controlledReview(this.db, input.projectId, input.nodeId, input.controlledRequestId)
      ) &&
      this.db
        .prepare('SELECT 1 FROM flow_coordination_scope WHERE project_id=? AND node_id=?')
        .get(input.projectId, input.nodeId)
    )
      fail('FLOW_CONTROL_OCCUPIED', 'occupancy')
    this.assertReviewReady(this.file(input.projectId), input.nodeId)
    if (
      this.db
        .prepare(
          "SELECT 1 FROM flow_commands WHERE project_id = ? AND target_node_id = ? AND state IN ('pending', 'unknown')"
        )
        .get(input.projectId, input.nodeId)
    )
      fail('FLOW_NODE_OCCUPIED', 'occupancy')
  }
  diagnostics(
    input: CommandLookup
  ): NodeExecuteCommand & { runId: string; nodeExecutionId?: string } {
    const row = this.row(input)
    const receipt = JSON.parse(row.receipt_json) as FlowCommandReceipt
    return {
      ...JSON.parse(row.command_json),
      runId: row.run_id,
      nodeExecutionId: receipt.nodeExecutionId
    }
  }

  private assertReviewReady(
    project: ProjectFile,
    targetNodeId: string,
    manifest?: NodeExecuteCommand['inputs']
  ): void {
    // First slice never bypasses a declared review gate. Its runtime is a later package.
    for (const review of project.nodes.filter((item) => item.type === 'ai-review')) {
      let raw: unknown
      try {
        raw = JSON.parse(savedShape(project, review.id).props.config)
      } catch {
        fail('FLOW_REVIEW_NOT_READY', 'review')
      }
      const rule = ReviewNodeConfigSchema.safeParse(raw)
      if (!rule.success) fail('FLOW_REVIEW_NOT_READY', 'review')
      if (rule.data.gatedNodeIds.includes(targetNodeId)) {
        const approval = new FlowReviewStore(this.db).approval(project, review.id)
        if (!approval) fail('FLOW_REVIEW_NOT_READY', 'review')
        if (manifest) {
          for (const [index, ref] of approval.decision.subjects.entries()) {
            const source = rule.data.subjectSources[index]
            const edge = project.edges.find(
              (e) =>
                e.to.nodeId === targetNodeId &&
                e.from.nodeId === source.nodeId &&
                e.from.portId === source.portId
            )
            if (
              edge &&
              !manifest.some(
                (entry) =>
                  entry.targetPortId === edge.to.portId &&
                  entry.assets.some((asset) => canonicalFlowJson(asset) === canonicalFlowJson(ref))
              )
            )
              fail('FLOW_REVIEW_NOT_READY', 'review')
          }
        }
      }
    }
  }
  private authorize(command: NodeExecuteCommand, project: ProjectFile): void {
    if (projectSemanticRevision(project) !== command.expectedSemanticRevision)
      fail('FLOW_REVISION_CONFLICT', 'revision')
    const agent = savedShape(project, command.agentNodeId)
    let config: unknown
    try {
      config = JSON.parse(agent.props.config)
    } catch {
      fail('FLOW_AGENT_CONFIG_INVALID', 'scope')
    }
    const parsed = AgentNodeConfigSchema.safeParse(config)
    if (agent.props.nodeType !== 'agent' || !parsed.success)
      fail('FLOW_AGENT_CONFIG_INVALID', 'scope')
    if (!parsed.data.allowedNodeIds.includes(command.targetNodeId))
      fail('FLOW_SCOPE_REJECTED', 'scope')
    const scopeOwner = (nodeId: string): string | undefined =>
      (
        this.db
          .prepare('SELECT task_id FROM flow_coordination_scope WHERE project_id=? AND node_id=?')
          .get(command.projectId, nodeId) as { task_id: string } | undefined
      )?.task_id
    if (
      scopeOwner(command.targetNodeId) &&
      scopeOwner(command.targetNodeId) !== scopeOwner(command.agentNodeId)
    )
      fail('FLOW_CONTROL_OCCUPIED', 'scope')
    const target = savedShape(project, command.targetNodeId)
    const node = project.nodes.find((item) => item.id === command.targetNodeId)
    if (target.props.nodeType !== 'processor' || node?.type !== 'processor')
      fail('FLOW_TYPE_UNSUPPORTED', 'contract')
    if (
      command.contractVersion !== PROCESSOR_CONTRACT_VERSION ||
      node.contractVersion !== PROCESSOR_CONTRACT_VERSION ||
      portIdentity(node.ports) !== portIdentity([...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out]) ||
      target.meta?.pinnedOutput !== undefined
    )
      fail('FLOW_CONTRACT_MISMATCH', 'contract')
    this.assertReviewReady(project, command.targetNodeId, command.inputs)
    const incoming = project.edges.filter((edge) => edge.to.nodeId === command.targetNodeId)
    if (
      incoming.length > 1 ||
      incoming.some(
        (edge) => !command.inputs.some((input) => input.targetPortId === edge.to.portId)
      )
    )
      fail('FLOW_INPUT_MANIFEST_INCOMPLETE', 'input')
    for (const input of command.inputs) {
      const port = PROCESSOR_PORTS.in.find((item) => item.id === input.targetPortId)
      if (!port || (port.cardinality === 'one' && input.assets.length > 1))
        fail('FLOW_INPUT_CONTRACT_INVALID', 'input')
    }
  }
  private resolveInputs(
    command: NodeExecuteCommand,
    project: ProjectFile
  ): FlowCommandGrant['inputs'] {
    return command.inputs.map((input) => {
      const versions = this.assets.resolveInputs(command.projectId, input.assets)
      const edge = project.edges.find(
        (edge) => edge.to.nodeId === command.targetNodeId && edge.to.portId === input.targetPortId
      )
      const sources = versions.map((version) => {
        if (!edge) return { nodeId: version.ref.sourceNodeId, portId: version.ref.sourcePortId }
        if (
          edge.from.nodeId === version.ref.sourceNodeId &&
          edge.from.portId === version.ref.sourcePortId
        )
          return edge.from
        const source = savedShape(project, edge.from.nodeId)
        let ref: unknown
        try {
          ref = JSON.parse(String(source.meta?.flowAssetRef ?? ''))
        } catch {
          fail('FLOW_INPUT_SOURCE_MISMATCH', 'input')
        }
        const parsed = AgentFlowAssetRefSchema.safeParse(ref)
        const pinned = readPinnedOutputs(source.meta?.pinnedOutput)?.[edge.from.portId]
        if (
          !parsed.success ||
          parsed.data.assetId !== version.ref.assetId ||
          parsed.data.versionId !== version.ref.versionId ||
          parsed.data.sourceNodeId !== version.ref.sourceNodeId ||
          parsed.data.sourcePortId !== version.ref.sourcePortId ||
          JSON.stringify(pinned) !== JSON.stringify(version.value)
        )
          fail('FLOW_INPUT_SOURCE_MISMATCH', 'input')
        return edge.from
      })
      return { targetPortId: input.targetPortId, versions, sources }
    })
  }
  prepare(raw: NodeExecuteCommand): FlowCommandPrepareResult {
    const command = NodeExecuteCommandSchema.parse(raw)
    const signature = nodeCommandIntentSignature(command)
    return this.db.transaction(() => {
      const project = this.file(command.projectId)
      const previous = this.db
        .prepare('SELECT * FROM flow_commands WHERE project_id = ? AND command_id = ?')
        .get(command.projectId, command.commandId) as Row | undefined
      if (previous) {
        if (previous.signature !== signature) fail('FLOW_COMMAND_CONFLICT', 'dedupe')
        return {
          state: previous.state,
          receipt: JSON.parse(previous.receipt_json)
        } as FlowCommandPrepareResult
      }
      this.authorize(command, project)
      const inputs = this.resolveInputs(command, project)
      const agentConfig = AgentNodeConfigSchema.parse(
        JSON.parse(savedShape(project, command.agentNodeId).props.config)
      )
      const task = this.db
        .prepare(
          'SELECT agent_node_id, max_steps FROM flow_command_tasks WHERE project_id = ? AND task_id = ?'
        )
        .get(command.projectId, command.taskId) as
        { agent_node_id: string; max_steps: number } | undefined
      if (task && task.agent_node_id !== command.agentNodeId) fail('FLOW_TASK_CONFLICT', 'task')
      const count = (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM flow_commands WHERE project_id = ? AND task_id = ?')
          .get(command.projectId, command.taskId) as { n: number }
      ).n
      if (count >= Math.min(task?.max_steps ?? agentConfig.maxSteps, agentConfig.maxSteps))
        fail('FLOW_TASK_BUDGET_EXHAUSTED', 'task')
      if (
        this.db
          .prepare(
            "SELECT 1 FROM flow_commands WHERE project_id = ? AND target_node_id = ? AND state IN ('pending', 'unknown')"
          )
          .get(command.projectId, command.targetNodeId)
      )
        fail('FLOW_NODE_OCCUPIED', 'occupancy')
      if (!task)
        this.db
          .prepare('INSERT INTO flow_command_tasks VALUES (?, ?, ?, ?)')
          .run(command.taskId, command.projectId, command.agentNodeId, agentConfig.maxSteps)
      const leaseId = randomUUID(),
        runId = randomUUID()
      const receipt: FlowCommandReceipt = {
        commandId: command.commandId,
        projectId: command.projectId,
        taskId: command.taskId,
        targetNodeId: command.targetNodeId,
        state: 'pending',
        runId,
        inputs: command.inputs,
        outputRefs: []
      }
      this.db
        .prepare(
          'INSERT INTO flow_commands(project_id, command_id, signature, command_json, target_node_id, task_id, lease_id, owner_session, run_id, state, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          command.projectId,
          command.commandId,
          signature,
          JSON.stringify(command),
          command.targetNodeId,
          command.taskId,
          leaseId,
          this.sessionId,
          runId,
          'pending',
          JSON.stringify(receipt),
          Date.now()
        )
      const grant: FlowCommandGrant = { command, leaseId, runId, inputs }
      return { state: 'ready', grant } as const
    })()
  }
  /** Called after renderer resource admission, immediately before any executor invocation. */
  check(raw: CommandLease): void {
    const input = CommandLeaseSchema.parse(raw),
      row = this.row(input)
    if (
      row.lease_id !== input.leaseId ||
      row.owner_session !== this.sessionId ||
      row.state !== 'pending' ||
      row.admitted !== 0
    )
      fail('FLOW_LEASE_REJECTED', 'lease')
    this.authorize(JSON.parse(row.command_json), this.file(input.projectId))
    const command = JSON.parse(row.command_json) as NodeExecuteCommand
    for (const input of command.inputs) this.assets.resolveInputs(command.projectId, input.assets)
    this.db
      .prepare('UPDATE flow_commands SET admitted = 1 WHERE project_id = ? AND command_id = ?')
      .run(input.projectId, input.commandId)
  }
  abortUnstarted(raw: CommandLease): FlowCommandReceipt {
    const input = CommandLeaseSchema.parse(raw),
      row = this.row(input)
    if (
      row.lease_id !== input.leaseId ||
      row.owner_session !== this.sessionId ||
      row.admitted !== 0 ||
      row.state !== 'pending'
    )
      fail('FLOW_LEASE_REJECTED', 'lease')
    return this.update(row, {
      ...JSON.parse(row.receipt_json),
      state: 'skipped',
      code: 'FLOW_NOT_STARTED'
    })
  }
  unknown(raw: CommandLease): FlowCommandReceipt {
    const input = CommandLeaseSchema.parse(raw),
      row = this.row(input)
    if (row.lease_id !== input.leaseId) fail('FLOW_LEASE_REJECTED', 'lease')
    const receipt = JSON.parse(row.receipt_json) as FlowCommandReceipt
    if (receipt.state !== 'pending') return receipt
    return this.update(row, { ...receipt, state: 'unknown', code: 'FLOW_RESULT_UNCONFIRMED' })
  }
  /** Only saved, matching execution facts can commit; no caller-supplied body/status is accepted. */
  commit(raw: CommandLookup): FlowCommandReceipt {
    const input = CommandLookupSchema.parse(raw)
    let phase = 'receipt-lookup'
    try {
      return this.db.transaction(() => {
        const row = this.row(input),
          previous = JSON.parse(row.receipt_json) as FlowCommandReceipt
        if (row.state !== 'pending' && row.state !== 'unknown') return previous
        const command = JSON.parse(row.command_json) as NodeExecuteCommand
        phase = 'saved-project'
        const project = this.file(input.projectId)
        if (projectSemanticRevision(project) !== command.expectedSemanticRevision)
          fail('FLOW_REVISION_CONFLICT', 'saved-revision')
        phase = 'saved-run'
        const shape = savedShape(project, command.targetNodeId)
        const record = shape.meta?.nodeRun as
          | {
              runId?: string
              nodeExecutionId?: string
              commandId?: string
              commandLeaseId?: string
              fixedInputs?: unknown
              inputFingerprint?: string
              inputs?: unknown
              outputPorts?: string[]
              status?: string
            }
          | undefined
        const status = readStoredNodeRunStatus(record)
        if (status === 'success' && row.admitted !== 1) fail('FLOW_LEASE_REJECTED', 'saved-run')
        if (
          !status ||
          status === 'running' ||
          record?.runId !== row.run_id ||
          record.commandId !== command.commandId ||
          record.commandLeaseId !== row.lease_id ||
          typeof record.nodeExecutionId !== 'string' ||
          !record.nodeExecutionId ||
          JSON.stringify(record.fixedInputs) !== JSON.stringify(command.inputs)
        )
          fail('FLOW_SAVED_RUN_MISMATCH', 'saved-run')
        const state = status === 'success' ? 'committed' : status
        if (!record.inputFingerprint) fail('FLOW_SAVED_RUN_MISMATCH', 'saved-input')
        phase = 'saved-input'
        const resolved = this.resolveInputs(command, project)
        const expectedSources = Object.fromEntries(
          resolved.map((input) => [
            input.targetPortId,
            input.versions.map((version, index) => ({
              nodeId: input.sources![index].nodeId,
              portId: input.sources![index].portId,
              assetId: version.ref.assetId,
              versionId: version.ref.versionId
            }))
          ])
        )
        const fingerprint = computeInputFingerprint({
          contractVersion: command.contractVersion,
          config: shape.props.config,
          text: shape.props.text,
          sources: [...resolved]
            .sort((a, b) => a.targetPortId.localeCompare(b.targetPortId))
            .flatMap((input) =>
              input.versions.map((version, index) => ({
                portId: input.targetPortId,
                nodeId: input.sources![index].nodeId,
                sourcePortId: input.sources![index].portId,
                value: version.value
              }))
            )
        })
        if (
          canonicalFlowJson(record.inputs) !== canonicalFlowJson(expectedSources) ||
          record.inputFingerprint !== fingerprint
        )
          fail('FLOW_SAVED_INPUT_MISMATCH', 'saved-input')
        const receipt: FlowCommandReceipt = {
          ...previous,
          state,
          nodeExecutionId: record.nodeExecutionId,
          inputFingerprint: record.inputFingerprint,
          graphVersion: project.meta.graphVersion,
          code: status === 'success' ? undefined : `FLOW_EXECUTION_${status.toUpperCase()}`
        }
        if (status === 'success') {
          if (!record.outputPorts?.includes('out-value'))
            fail('FLOW_SAVED_OUTPUT_MISMATCH', 'saved-output')
          phase = 'output-version'
          const version = this.assets.submit(
            {
              projectId: input.projectId,
              nodeId: command.targetNodeId,
              portId: 'out-value',
              submissionId: `command:${createHash('sha256')
                .update(JSON.stringify([input.projectId, input.commandId]))
                .digest('hex')}`,
              expectedGraphVersion: project.meta.graphVersion,
              traceId: command.traceId,
              spanId: command.spanId
            },
            { commandId: command.commandId, leaseId: row.lease_id }
          )
          receipt.outputRefs = [version.ref]
        }
        phase = 'receipt-persist'
        return this.update(row, receipt)
      })()
    } catch (error) {
      if (error instanceof FlowCommandError || error instanceof FlowAssetError) throw error
      throw new FlowCommandError('FLOW_RECEIPT_STORAGE_FAILED', phase)
    }
  }
}
