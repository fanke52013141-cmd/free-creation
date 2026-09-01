/**
 * RunService — 运行生命周期管理（P3）
 *
 * 管理持久化 Run 记录的状态机：
 *   queued → running → succeeded / failed
 *           ↘ cancelled（任何活跃状态均可取消）
 *
 * 提供：
 * - 创建、启动、完成、失败、取消运行
 * - 查询运行列表与状态
 * - 重试（用相同 scope 创建新 Run）
 * - 注册运行产出（Artifact）
 *
 * 所有写操作通过 ServiceContext.store 落盘，不直接访问 SQLite。
 */

import { nanoid } from 'nanoid'
import type {
  Result,
  ServiceContext,
  RunRecord,
  RunStatus,
  RunUpdatePatch,
  RunArtifactRecord,
  AuditActor
} from '../types'
import { ok, fail } from '../types'

/** 合法的状态迁移路径。 */
const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: ['cancelled'], // failed run 可被标记 cancelled（清理），但不回退
  cancelled: []
}

export class RunService {
  constructor(private ctx: ServiceContext) {}

  // ── 创建 ──────────────────────────────────────────────────

  async createRun(params: {
    projectId: string
    scope: RunRecord['scope']
    actor?: AuditActor
  }): Promise<Result<RunRecord>> {
    const runId = nanoid(12)
    const now = Date.now()
    const record = await this.ctx.store.createRun({
      runId,
      projectId: params.projectId,
      scope: params.scope,
      status: 'queued',
      actor: params.actor ?? this.ctx.actor,
      startedAt: now
    })

    this.ctx.audit.log({
      actor: this.ctx.actor,
      action: 'create-run',
      projectId: params.projectId,
      after: { runId, scope: params.scope }
    })

    return ok(record)
  }

  // ── 状态迁移 ──────────────────────────────────────────────

  private async transition(
    runId: string,
    target: RunStatus,
    extra?: RunUpdatePatch
  ): Promise<Result<RunRecord>> {
    const current = await this.ctx.store.getRun(runId)
    if (!current) return fail('RUN_NOT_FOUND', `运行不存在: ${runId}`)

    const allowed = VALID_TRANSITIONS[current.status]
    if (!allowed.includes(target)) {
      return fail(
        'INVALID_TRANSITION',
        `运行 ${runId} 当前状态 ${current.status} 不可迁移到 ${target}`
      )
    }

    const patch: RunUpdatePatch = { status: target, ...extra }

    if (target === 'running' && !current.startedAt) {
      patch.startedAt = Date.now()
    }
    if (target === 'succeeded' || target === 'failed' || target === 'cancelled') {
      const finishedAt = Date.now()
      patch.finishedAt = finishedAt
      if (current.startedAt) {
        patch.durationMs = finishedAt - current.startedAt
      }
    }

    const updated = await this.ctx.store.updateRun(runId, patch)
    if (!updated) return fail('RUN_NOT_FOUND', `运行不存在: ${runId}`)

    this.ctx.audit.log({
      actor: this.ctx.actor,
      action: `run-${target}`,
      projectId: current.projectId,
      entityId: runId,
      after: { status: target, durationMs: updated.durationMs }
    })

    return ok(updated)
  }

  async startRun(runId: string): Promise<Result<RunRecord>> {
    return this.transition(runId, 'running')
  }

  async completeRun(runId: string): Promise<Result<RunRecord>> {
    return this.transition(runId, 'succeeded')
  }

  async failRun(
    runId: string,
    error: { code: string; message: string }
  ): Promise<Result<RunRecord>> {
    return this.transition(runId, 'failed', { error })
  }

  async cancelRun(runId: string): Promise<Result<RunRecord>> {
    return this.transition(runId, 'cancelled')
  }

  // ── 查询 ──────────────────────────────────────────────────

  async getRun(runId: string): Promise<Result<RunRecord>> {
    const record = await this.ctx.store.getRun(runId)
    if (!record) return fail('RUN_NOT_FOUND', `运行不存在: ${runId}`)
    return ok(record)
  }

  async listRuns(projectId: string, filter?: { status?: RunStatus }): Promise<Result<RunRecord[]>> {
    const records = await this.ctx.store.listRuns(projectId, filter)
    return ok(records)
  }

  // ── 重试 ──────────────────────────────────────────────────

  /**
   * 用同一 scope 创建一条新的 queued Run。
   * 原 Run 必须处于终态（succeeded / failed / cancelled）。
   */
  async retryRun(runId: string): Promise<Result<RunRecord>> {
    const original = await this.ctx.store.getRun(runId)
    if (!original) return fail('RUN_NOT_FOUND', `运行不存在: ${runId}`)

    if (original.status === 'queued' || original.status === 'running') {
      return fail('RUN_STILL_ACTIVE', `运行 ${runId} 仍在进行中（${original.status}），无法重试`)
    }

    return this.createRun({
      projectId: original.projectId,
      scope: original.scope
    })
  }

  // ── Artifact ──────────────────────────────────────────────

  async registerArtifact(params: {
    runId: string
    projectId: string
    nodeId: string
    artifactType: RunArtifactRecord['artifactType']
    mediaId?: string
    portId?: string
    mimeType?: string
    label?: string
    inputSummary?: Record<string, unknown>
    modelKey?: string
  }): Promise<Result<RunArtifactRecord>> {
    const run = await this.ctx.store.getRun(params.runId)
    if (!run) return fail('RUN_NOT_FOUND', `运行不存在: ${params.runId}`)

    const record = await this.ctx.store.createRunArtifact({
      runId: params.runId,
      projectId: params.projectId,
      nodeId: params.nodeId,
      artifactType: params.artifactType,
      mediaId: params.mediaId,
      portId: params.portId,
      mimeType: params.mimeType,
      label: params.label,
      inputSummary: params.inputSummary,
      modelKey: params.modelKey
    })

    return ok(record)
  }

  async listArtifacts(runId: string): Promise<Result<RunArtifactRecord[]>> {
    const run = await this.ctx.store.getRun(runId)
    if (!run) return fail('RUN_NOT_FOUND', `运行不存在: ${runId}`)
    return ok(await this.ctx.store.listRunArtifacts(runId))
  }
}
