import type Database from 'better-sqlite3'
import type { NodeExecuteCommand } from '../../shared/agent-flow/commands'
import {
  AgentRuntimeError,
  AgentTaskSnapshotSchema
} from '../../shared/agent-flow/runtime-contracts'
import { ReviewDecisionSchema } from '../../shared/agent-flow/node-contracts'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { assertVideoReviewEvidence } from './video-review'

/** Main-only prompt amendment from an immutable, authorized rework task. No renderer-provided feedback. */
export function videoReworkPrompt(
  db: Database.Database,
  command: NodeExecuteCommand,
  base: string
): string {
  if (!command.videoRework) return base
  try {
    const row = db
      .prepare('SELECT snapshot_json,state FROM flow_agent_tasks WHERE project_id=? AND task_id=?')
      .get(command.projectId, command.taskId) as
      { snapshot_json: string; state: string } | undefined
    if (!row || row.state !== 'running') throw new Error()
    const task = AgentTaskSnapshotSchema.parse(JSON.parse(row.snapshot_json))
    const rework = task.rework
    if (
      !rework ||
      !task.coordinatorTaskId ||
      !task.parentTaskId ||
      task.agentNodeId !== command.agentNodeId ||
      task.semanticRevision !== command.expectedSemanticRevision ||
      rework.videoTargetNodeId !== command.targetNodeId ||
      command.contractVersion !== 7 ||
      rework.reviewId !== command.videoRework.reviewId ||
      rework.round !== command.videoRework.round ||
      !task.targets.some(
        (target) => target.nodeId === command.targetNodeId && target.contractVersion === 7
      )
    )
      throw new Error()
    const owner = db
      .prepare('SELECT body_json FROM flow_coordination_runs WHERE project_id=? AND task_id=?')
      .get(command.projectId, task.coordinatorTaskId) as { body_json: string } | undefined
    const run = owner && JSON.parse(owner.body_json)
    if (
      !run ||
      !['running', 'waiting'].includes(run.state) ||
      !run.reviews?.some(
        (cycle: { reworkTaskId?: string; responsibleNodeId?: string }) =>
          cycle.reworkTaskId === task.taskId && cycle.responsibleNodeId === task.agentNodeId
      )
    )
      throw new Error()
    const saved = db
      .prepare(
        "SELECT body_json FROM flow_reviews WHERE project_id=? AND node_id=? AND json_extract(body_json,'$.decision.reviewId')=?"
      )
      .get(command.projectId, rework.reviewNodeId, rework.reviewId) as
      { body_json: string } | undefined
    if (!saved) throw new Error()
    const report = ReviewDecisionSchema.parse(JSON.parse(saved.body_json).decision)
    if (
      report.passed ||
      report.rulesVersion !== rework.rulesVersion ||
      report.feedback !== rework.feedback ||
      canonicalFlowJson(report.subjects) !== canonicalFlowJson(rework.rejectedOutputs) ||
      report.subjects.length !== 1 ||
      report.subjects[0].sourceNodeId !== command.targetNodeId ||
      report.subjects[0].sourcePortId !== 'out-video'
    )
      throw new Error()
    assertVideoReviewEvidence(db, command.projectId, report)
    const revision = command.videoRework.prompt
      ? `\n本次生成修订指令：\n${command.videoRework.prompt}`
      : ''
    const prompt = `${base.trim()}${revision}\n\n本次为第 ${rework.round} 轮视频返工。以下反馈仅来自四张抽样画面，不代表音轨或完整时序。保持原目标和参考素材，针对审核标准与反馈重新生成。\n审核标准：\n${rework.criteria}\n修改反馈：\n${rework.feedback}`
    if (Buffer.byteLength(prompt) > 32768) throw new Error()
    return prompt
  } catch {
    throw new AgentRuntimeError('FLOW_VIDEO_REWORK_INVALID', 'video-rework')
  }
}
