// 事件注册表（LOGGING_SPEC.md §5/§6）：事件名 → 必填上下文与允许的 attributes。
// 这是字段白名单的单一事实来源：注册表之外的键一律丢弃并计数；
// 新增事件必须同步登记类型、允许属性、负责模块与测试。
import type { DiagnosticsLevel } from './context'

/** attributes 值的受限类型：id（短标识）/int（正整数）/flag（布尔）/short（≤80 字符枚举或标识）。 */
export type DiagnosticsAttributeKind = 'id' | 'int' | 'flag' | 'short'

export interface DiagnosticsEventDefinition {
  /** 稳定事件名，程序按它判断；人读文案在 message。 */
  name: string
  family: string
  defaultLevel: DiagnosticsLevel
  /** 负责层（哪个模块拥有开始/终态，避免双写）。 */
  owner: string
  /** 允许写入的 attribute 键 → 类型。 */
  attributes: Record<string, DiagnosticsAttributeKind>
}

function def(
  name: string,
  defaultLevel: DiagnosticsLevel,
  owner: string,
  attributes: Record<string, DiagnosticsAttributeKind> = {}
): DiagnosticsEventDefinition {
  const familyName = name.split('.').slice(0, -1).join('.')
  return { name, family: familyName, defaultLevel, owner, attributes }
}

const MODEL_ATTRS = {
  operation: 'short',
  providerId: 'id',
  modelId: 'id',
  featureKey: 'short',
  toolCallCount: 'int',
  finishReason: 'short'
} as const

export const DIAGNOSTICS_EVENTS: Record<string, DiagnosticsEventDefinition> = Object.fromEntries(
  [
    def('agent.desktop.inspect_failed', 'error', 'main/ipc/flow-agents.ipc', {
      phase: 'short',
      code: 'short'
    }),
    ...['started', 'completed', 'failed'].map((stage) =>
      def(
        `agent.coordination.${stage}`,
        stage === 'failed' ? 'error' : 'info',
        'main/agent-flow/coordinator-host',
        { phase: 'short', code: 'short' }
      )
    ),
    def('agent.publication.failed', 'error', 'renderer/engine/flow-command-bridge', {
      phase: 'short'
    }),
    ...['started', 'completed', 'failed'].map((stage) =>
      def(
        `agent.desktop.${stage}`,
        stage === 'failed' ? 'error' : 'info',
        'main/ipc/flow-agents.ipc',
        { phase: 'short', code: 'short', action: 'short' }
      )
    ),
    ...['started', 'completed', 'failed'].map((stage) =>
      def(
        `skill.library.${stage}`,
        stage === 'failed' ? 'error' : 'info',
        'main/agent-flow/skill-store',
        { phase: 'short', code: 'short' }
      )
    ),
    ...[
      'started',
      'resumed',
      'waiting',
      'completed',
      'failed',
      'cancelled',
      'blocked',
      'checkpoint_saved',
      'skill_loaded',
      'admission_started',
      'admission_completed',
      'admission_failed',
      'resume_check_started',
      'resume_check_completed',
      'resume_check_failed'
    ].map((stage) =>
      def(
        `agent.runtime.${stage}`,
        stage === 'failed' || stage === 'blocked' || stage.endsWith('_failed') ? 'error' : 'info',
        'main/agent-flow/runtime',
        { phase: 'short', code: 'short', resumesTraceId: 'id' }
      )
    ),
    def('canvas.flow_config.started', 'info', 'renderer/nodes/specs/agentFlow', { phase: 'short' }),
    def('canvas.flow_config.applied', 'info', 'renderer/nodes/specs/agentFlow', { phase: 'short' }),
    def('canvas.flow_config.failed', 'error', 'renderer/nodes/specs/agentFlow', {
      phase: 'short',
      code: 'short'
    }),
    def('asset.operation.started', 'info', 'main/ipc/flow-assets.ipc', {
      phase: 'short',
      submissionId: 'id'
    }),
    def('command.operation.started', 'info', 'main/ipc/flow-commands.ipc', {
      commandId: 'id',
      phase: 'short'
    }),
    def('command.operation.completed', 'info', 'main/ipc/flow-commands.ipc', {
      commandId: 'id',
      phase: 'short',
      state: 'short',
      versionId: 'id'
    }),
    def('command.operation.failed', 'error', 'main/ipc/flow-commands.ipc', {
      commandId: 'id',
      phase: 'short',
      code: 'short'
    }),
    def('command.recovered', 'warn', 'main/ipc/flow-commands.ipc', {
      commandId: 'id',
      phase: 'short',
      state: 'short',
      resumesTraceId: 'id'
    }),
    def('command.recovery.started', 'info', 'main/ipc/flow-commands.ipc', { phase: 'short' }),
    def('command.recovery.completed', 'info', 'main/ipc/flow-commands.ipc', {
      phase: 'short',
      commandCount: 'int'
    }),
    def('command.bridge.failed', 'error', 'renderer/engine/flow-command-bridge', {
      commandId: 'id',
      phase: 'short'
    }),
    def('command.canvas_binding_failed', 'error', 'renderer/engine/flow-command-bridge', {
      phase: 'short'
    }),
    def('command.recovery_failed', 'error', 'main/ipc/flow-commands.ipc', {
      commandId: 'id',
      phase: 'short',
      code: 'short'
    }),
    def('asset.placement.started', 'info', 'renderer/canvas/flow-asset-actions', {
      phase: 'short'
    }),
    def('asset.placement.applied', 'info', 'renderer/canvas/flow-asset-actions', {
      phase: 'short'
    }),
    def('asset.placement.failed', 'error', 'renderer/canvas/flow-asset-actions', {
      phase: 'short'
    }),
    def('asset.operation.completed', 'info', 'main/ipc/flow-assets.ipc', {
      phase: 'short',
      submissionId: 'id',
      assetId: 'id',
      versionId: 'id'
    }),
    def('asset.operation.failed', 'error', 'main/ipc/flow-assets.ipc', {
      phase: 'short',
      code: 'short',
      submissionId: 'id'
    }),
    def('agent.probe.started', 'info', 'main/agent-flow/model-probe-electron', { phase: 'short' }),
    def('agent.probe.completed', 'info', 'main/agent-flow/model-probe-electron', {
      phase: 'short'
    }),
    def('agent.probe.failed', 'error', 'main/agent-flow/model-probe-electron', { phase: 'short' }),
    ...[
      'started',
      'resumed',
      'waiting',
      'completed',
      'failed',
      'command_replayed',
      'command_blocked',
      'command_completed',
      'command_unknown',
      'bridge_dispatch',
      'checkpoint_saved',
      'storage_failed'
    ].map((stage) =>
      def(
        `agent.c0.${stage}`,
        stage === 'failed' || stage === 'storage_failed' ? 'error' : 'info',
        'main/agent-flow/c0',
        { phase: 'short', code: 'short', commandId: 'id', targetNodeId: 'id' }
      )
    ),
    def('project.undelete.started', 'info', 'main/ipc/project.ipc.ts'),
    def('project.undelete.completed', 'info', 'main/ipc/project.ipc.ts'),
    def('project.undelete.failed', 'error', 'main/ipc/project.ipc.ts'),
    def('canvas.batch_flow.created', 'info', 'renderer/canvas/storyboard-batch-flow.ts', {
      itemCount: 'int'
    }),
    def('canvas.batch_flow.failed', 'error', 'renderer/canvas/storyboard-batch-flow.ts'),
    def('media.files_preflight', 'info', 'main/ipc/media.ipc.ts', { missingCount: 'int' }),
    def('media.files_preflight_failed', 'error', 'main/ipc/media.ipc.ts'),
    // app.*：main 生命周期
    def('app.session_started', 'info', 'main/index.ts'),
    def('app.session_ended', 'info', 'main/index.ts'),
    def('app.previous_session_unclean', 'warn', 'main/index.ts'),
    def('app.process_exited', 'error', 'main/index.ts', { reason: 'short', exitCode: 'int' }),
    // workflow.*：流程调度器（公共执行器入口拥有，唯一终态）
    def('workflow.task_queued', 'info', 'renderer/engine/executor.ts'),
    def('workflow.task_admitted', 'info', 'renderer/engine/executor.ts'),
    def('workflow.task_cancelled', 'info', 'renderer/engine/executor.ts'),
    def('workflow.started', 'info', 'renderer/engine/executor.ts', { itemCount: 'int' }),
    def('workflow.completed', 'info', 'renderer/engine/executor.ts', { itemCount: 'int' }),
    def('workflow.failed', 'error', 'renderer/engine/executor.ts', { failedCount: 'int' }),
    def('workflow.cancelled', 'info', 'renderer/engine/executor.ts'),
    // node.*：公共执行器（node.stage 是旧 ctx.trace 的通用适配事件）
    def('node.started', 'info', 'renderer/engine/executor.ts', { portCount: 'int' }),
    def('node.document_materialized', 'info', 'renderer/engine/executor.ts'),
    def('node.input_validated', 'info', 'renderer/engine/executor.ts', { portCount: 'int' }),
    def('node.capability_resolved', 'info', 'shared/engine/executors/*', MODEL_ATTRS),
    def('node.output_validated', 'info', 'renderer/engine/executor.ts', { portCount: 'int' }),
    def('node.output_pinned', 'info', 'renderer/canvas/NodeCardView.tsx', { portCount: 'int' }),
    def('node.output_unpinned', 'info', 'renderer/canvas/NodeCardView.tsx'),
    def('artifact.recipe_saved', 'info', 'main/ipc/media.ipc.ts'),
    def('artifact.recipe_started', 'info', 'main/ipc/media.ipc.ts'),
    def('artifact.recipe_read_failed', 'error', 'main/ipc/media.ipc.ts'),
    def('artifact.recipe_failed', 'error', 'main/ipc/media.ipc.ts'),
    def('library.reuse_preview', 'info', 'main/ipc/library.ipc.ts', { missingCount: 'int' }),
    def('node.completed', 'info', 'renderer/engine/executor.ts', { portCount: 'int' }),
    def('node.failed', 'error', 'renderer/engine/executor.ts'),
    def('node.cancelled', 'info', 'renderer/engine/executor.ts'),
    def('node.skipped', 'warn', 'renderer/engine/executor.ts', { reason: 'short' }),
    def('node.stage', 'info', 'shared/engine/executors/*', MODEL_ATTRS),
    def('skill.execution.started', 'info', 'main/gateway/chat-image-skill.ts', {
      ...MODEL_ATTRS,
      skillId: 'id'
    }),
    def('skill.execution.completed', 'info', 'main/gateway/chat-image-skill.ts', {
      ...MODEL_ATTRS,
      skillId: 'id',
      mediaId: 'id'
    }),
    def('skill.execution.failed', 'error', 'main/gateway/chat-image-skill.ts', {
      ...MODEL_ATTRS,
      skillId: 'id'
    }),
    def('media.export_started', 'info', 'main/ipc/media.ipc.ts', { projectId: 'id', count: 'int' }),
    def('media.export_completed', 'info', 'main/ipc/media.ipc.ts', {
      projectId: 'id',
      exported: 'int',
      failed: 'int'
    }),
    def('media.export_failed', 'error', 'main/ipc/media.ipc.ts', { projectId: 'id' }),
    def('media.export_cancelled', 'info', 'main/ipc/media.ipc.ts', { projectId: 'id' }),
    // model.request.*：网关调用边界（main 拥有 attempt/终态）
    def('model.request.started', 'info', 'main/gateway/*', MODEL_ATTRS),
    def('model.request.attempt_started', 'info', 'main/gateway/*', MODEL_ATTRS),
    def('model.request.accepted', 'info', 'main/gateway/*', MODEL_ATTRS),
    def('model.request.first_chunk', 'info', 'main/gateway/*', MODEL_ATTRS),
    def('model.request.attempt_failed', 'warn', 'main/gateway/*', MODEL_ATTRS),
    def('model.request.retry_scheduled', 'warn', 'main/gateway/*', {
      ...MODEL_ATTRS,
      waitMs: 'int'
    }),
    def('model.request.completed', 'info', 'main/gateway/*', {
      ...MODEL_ATTRS,
      outputChars: 'int'
    }),
    def('model.request.failed', 'error', 'main/gateway/*', MODEL_ATTRS),
    def('model.request.cancelled', 'info', 'main/gateway/*', MODEL_ATTRS),
    // task.*：持久任务调度器（视频任务库等）
    def('task.state_changed', 'info', 'main/gateway/video.ts', { state: 'short' }),
    def('task.poll_summary', 'info', 'main/gateway/video.ts', {
      state: 'short',
      pollCount: 'int',
      transientErrors: 'int'
    }),
    def('task.resume_started', 'info', 'main/gateway/video.ts', { pendingCount: 'int' }),
    def('task.resume_blocked', 'warn', 'main/gateway/video.ts', { reason: 'short' }),
    def('task.completed', 'info', 'main/gateway/video.ts', { state: 'short' }),
    def('task.failed', 'error', 'main/gateway/video.ts', { state: 'short' }),
    // media.*：媒体下载/落盘
    def('media.download_started', 'info', 'main/gateway/*', { mediaId: 'id', byteSize: 'int' }),
    def('media.download_completed', 'info', 'main/gateway/*', { mediaId: 'id', byteSize: 'int' }),
    def('media.download_failed', 'error', 'main/gateway/*', { mediaId: 'id' }),
    def('media.persist_started', 'info', 'main/gateway/*', { mediaId: 'id', mime: 'short' }),
    def('media.persist_completed', 'info', 'main/gateway/*', { mediaId: 'id', mime: 'short' }),
    def('media.persist_failed', 'error', 'main/gateway/*', { mediaId: 'id' }),
    def('project.canvas_failed', 'error', 'renderer/canvas/CanvasEditor.tsx'),
    def('application.preload_failed', 'error', 'preload/index.ts'),
    def('application.render_failed', 'error', 'renderer/App.tsx'),
    def('media.document_extract_failed', 'warn', 'main/media/document-text.ts'),
    def('media.read_failed', 'warn', 'main/store/media.repo.ts'),
    // project.save / restore / transfer
    def('project.save.started', 'info', 'main/ipc/project.ipc.ts'),
    def('project.save.completed', 'info', 'main/ipc/project.ipc.ts'),
    def('project.save.conflict', 'warn', 'main/ipc/project.ipc.ts'),
    def('project.save.failed', 'error', 'main/ipc/project.ipc.ts'),
    def('project.restore.started', 'info', 'renderer/canvas/snapshot-restore.ts'),
    def('project.restore.checkpoint_created', 'info', 'renderer/canvas/snapshot-restore.ts'),
    def('project.restore.completed', 'info', 'renderer/canvas/snapshot-restore.ts'),
    def('project.restore.cancelled', 'info', 'renderer/canvas/snapshot-restore.ts'),
    def('project.restore.failed', 'error', 'renderer/canvas/snapshot-restore.ts'),
    def('project.restore.rollback_completed', 'warn', 'renderer/canvas/snapshot-restore.ts'),
    def('project.restore.rollback_failed', 'error', 'renderer/canvas/snapshot-restore.ts'),
    def('project.transfer.started', 'info', 'main/ipc/project.ipc.ts', { itemCount: 'int' }),
    def('project.transfer.validated', 'info', 'main/ipc/project.ipc.ts', { itemCount: 'int' }),
    def('project.transfer.committed', 'info', 'main/ipc/project.ipc.ts', { itemCount: 'int' }),
    def('project.transfer.rolled_back', 'warn', 'main/ipc/project.ipc.ts'),
    def('project.transfer.failed', 'error', 'main/ipc/project.ipc.ts'),
    // library.*
    def('library.revision_published', 'info', 'main/ipc/library.ipc.ts'),
    def('library.materialization_completed', 'info', 'main/ipc/library.ipc.ts'),
    def('library.materialization_failed', 'error', 'main/ipc/library.ipc.ts'),
    def('library.mutation_failed', 'error', 'main/ipc/library.ipc.ts'),
    // configuration.*：模型连接/能力验证/迁移
    def('configuration.changed', 'info', 'main/ipc/models.ipc.ts', { connectionId: 'id' }),
    def('configuration.validation_completed', 'info', 'main/ipc/models.ipc.ts', {
      connectionId: 'id',
      modelId: 'id'
    }),
    def('configuration.validation_failed', 'warn', 'main/ipc/models.ipc.ts', {
      connectionId: 'id',
      modelId: 'id'
    }),
    def('configuration.migration_completed', 'info', 'main/ipc/models.ipc.ts', {
      migratedCount: 'int'
    }),
    def('configuration.migration_failed', 'error', 'main/ipc/models.ipc.ts', {
      migratedCount: 'int'
    }),
    // diagnostics.*：日志底座自诊断
    def('diagnostics.queue_dropped', 'warn', 'main/diagnostics/*', {
      droppedCount: 'int',
      reason: 'short'
    }),
    def('diagnostics.write_failed', 'error', 'main/diagnostics/*'),
    def('diagnostics.recovered', 'info', 'main/diagnostics/*'),
    def('diagnostics.export_completed', 'info', 'main/diagnostics/*', {
      byteSize: 'int',
      itemCount: 'int'
    }),
    def('diagnostics.export_failed', 'error', 'main/diagnostics/*')
  ].map((event) => [event.name, event])
)

export function isRegisteredEvent(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(DIAGNOSTICS_EVENTS, name)
}
