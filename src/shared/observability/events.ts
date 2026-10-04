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
  featureKey: 'short'
} as const

export const DIAGNOSTICS_EVENTS: Record<string, DiagnosticsEventDefinition> = Object.fromEntries(
  [
    // app.*：main 生命周期
    def('app.session_started', 'info', 'main/index.ts'),
    def('app.session_ended', 'info', 'main/index.ts'),
    def('app.previous_session_unclean', 'warn', 'main/index.ts'),
    def('app.process_exited', 'error', 'main/index.ts', { reason: 'short', exitCode: 'int' }),
    // workflow.*：流程调度器（公共执行器入口拥有，唯一终态）
    def('workflow.started', 'info', 'renderer/engine/executor.ts', { itemCount: 'int' }),
    def('workflow.completed', 'info', 'renderer/engine/executor.ts', { itemCount: 'int' }),
    def('workflow.failed', 'error', 'renderer/engine/executor.ts', { failedCount: 'int' }),
    def('workflow.cancelled', 'info', 'renderer/engine/executor.ts'),
    // node.*：公共执行器（node.stage 是旧 ctx.trace 的通用适配事件）
    def('node.started', 'info', 'renderer/engine/executor.ts', { portCount: 'int' }),
    def('node.input_validated', 'info', 'renderer/engine/executor.ts', { portCount: 'int' }),
    def('node.capability_resolved', 'info', 'shared/engine/executors/*', MODEL_ATTRS),
    def('node.output_validated', 'info', 'renderer/engine/executor.ts', { portCount: 'int' }),
    def('node.output_pinned', 'info', 'renderer/canvas/NodeCardView.tsx', { portCount: 'int' }),
    def('node.output_unpinned', 'info', 'renderer/canvas/NodeCardView.tsx'),
    def('node.completed', 'info', 'renderer/engine/executor.ts', { portCount: 'int' }),
    def('node.failed', 'error', 'renderer/engine/executor.ts'),
    def('node.cancelled', 'info', 'renderer/engine/executor.ts'),
    def('node.skipped', 'warn', 'renderer/engine/executor.ts', { reason: 'short' }),
    def('node.stage', 'info', 'shared/engine/executors/*', MODEL_ATTRS),
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
