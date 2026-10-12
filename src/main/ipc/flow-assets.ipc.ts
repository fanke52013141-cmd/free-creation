import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC, type IpcEnvelope } from '../../shared/contracts'
import {
  AssetSubmitSchema,
  AssetQuerySchema,
  AssetReadSchema,
  FlowAssetError
} from '../../shared/agent-flow/assets'
import { newSpanId, newTraceId } from '../../shared/observability'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { FlowAssetStore } from '../agent-flow/asset-store'
import { getDb } from '../store/db'
import { openProject } from '../store/projects.repo'

const messages: Record<string, string> = {
  ASSET_PROJECT_MISSING: '找不到原项目，请重新打开项目。',
  ASSET_SOURCE_OCCUPIED: '节点有未确认的命令，请先核对运行记录。',
  ASSET_NODE_MISSING: '节点已删除，请重新选择来源。',
  ASSET_REVISION_CONFLICT: '画布已发生变化，请保存后重新提交。',
  ASSET_SUBMISSION_CONFLICT: '上次提交的范围发生变化，请核对历史版本后重新提交。',
  ASSET_OUTPUT_UNAVAILABLE: '当前节点没有有效输出，请先填写内容或成功运行。',
  ASSET_OUTPUT_INVALID: '输出与端口类型不一致，请检查节点结果。',
  ASSET_PORT_INVALID: '当前输出端口不可用，请重新打开节点详情。',
  ASSET_TYPE_UNSUPPORTED: '此节点暂不支持资产版本提交。',
  ASSET_VALUE_UNSUPPORTED: '此类型的结果暂不支持资产版本提交。',
  ASSET_VALUE_TOO_LARGE: '输出超过 1 MiB 的版本上限，请拆分后提交。',
  ASSET_VERSION_MISSING: '找不到该资产版本。',
  ASSET_INTEGRITY_FAILED: '资产版本校验失败，请保留数据并核对备份。',
  ASSET_SENDER_REJECTED: '此窗口无法进行资产操作。',
  ASSET_INPUT_INVALID: '提交信息无效，请重新打开节点详情。',
  ASSET_STORAGE_FAILED: '资产存储操作失败，请检查磁盘空间后重试。'
}

export function registerFlowAssetsIpc(window: () => BrowserWindow | null): void {
  const store = new FlowAssetStore(getDb(), openProject)
  function handle<T extends { projectId: string }, R>(
    channel: string,
    phase: string,
    schema: z.ZodType<T>,
    run: (input: T) => R,
    outputRefs?: (output: R) => { assetId: string; versionId: string }
  ): void {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, raw: unknown): IpcEnvelope<R> => {
      const parsed = schema.safeParse(raw)
      const submission = phase === 'submit' ? AssetSubmitSchema.safeParse(raw) : null
      const source = AssetQuerySchema.safeParse(raw)
      const startedAt = performance.now()
      const operation = submission?.success ? { submissionId: submission.data.submissionId } : {}
      const context = {
        traceId: submission?.success ? submission.data.traceId : newTraceId(),
        spanId: submission?.success ? submission.data.spanId : newSpanId(),
        ...(parsed.success ? { projectId: parsed.data.projectId } : {}),
        ...(submission?.success
          ? { nodeId: submission.data.nodeId }
          : source.success
            ? { nodeId: source.data.nodeId }
            : {})
      }
      emitGatewayEvent('asset.operation.started', '资产版本操作开始', context, {
        attributes: { phase, ...operation }
      })
      try {
        const active = window()
        if (
          !active ||
          active.isDestroyed() ||
          event.sender !== active.webContents ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new FlowAssetError('ASSET_SENDER_REJECTED', 'authorize')
        if (!parsed.success) throw new FlowAssetError('ASSET_INPUT_INVALID', 'validation')
        const data = run(parsed.data)
        emitGatewayEvent('asset.operation.completed', '资产版本操作已完成', context, {
          status: 'success',
          durationMs: Math.round(performance.now() - startedAt),
          attributes: { phase, ...operation, ...(outputRefs ? outputRefs(data) : {}) }
        })
        return { ok: true, data }
      } catch (error) {
        const code = error instanceof FlowAssetError ? error.code : 'ASSET_STORAGE_FAILED'
        emitGatewayEvent('asset.operation.failed', '资产版本操作失败', context, {
          status: 'failed',
          durationMs: Math.round(performance.now() - startedAt),
          attributes: {
            phase: error instanceof FlowAssetError ? (error.phase ?? phase) : phase,
            code,
            ...operation
          }
        })
        return { ok: false, error: { code, message: messages[code] ?? '资产操作失败，请重试。' } }
      }
    })
  }
  handle(
    IPC.flowAssets.submit,
    'submit',
    AssetSubmitSchema,
    (input) => store.submit(input),
    (output) => ({ assetId: output.ref.assetId, versionId: output.ref.versionId })
  )
  handle(IPC.flowAssets.list, 'list', AssetQuerySchema, (input) =>
    store.list(input.projectId, input.nodeId, input.portId)
  )
  handle(IPC.flowAssets.read, 'read', AssetReadSchema, (input) =>
    store.read(input.projectId, input.versionId)
  )
}
