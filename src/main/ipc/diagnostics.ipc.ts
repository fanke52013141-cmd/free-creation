import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import log from 'electron-log/main'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { redactDiagnosticText } from '../../shared/diagnostics'
import { IPC } from '../../shared/contracts'
import type {
  DiagnosticsQueryInput,
  DiagnosticsHealthSnapshot,
  DiagnosticsQueryResult,
  ExportDiagnosticsBundleInput,
  ExportDiagnosticsBundleResult,
  ExportNodeRunDiagnosticsInput,
  IpcEnvelope,
  NodeRunLogEventInput,
  ReportDiagnosticsEventsInput
} from '../../shared/contracts'
import type { DiagnosticsService } from '../diagnostics/service'
import { buildNodeRunDiagnosticsReport } from '../diagnostics/node-run-export'

let diagnosticsService: DiagnosticsService | null = null

/** main/diagnostics 服务注入（L02）；测试或降级路径可为 null。 */
export function setDiagnosticsService(service: DiagnosticsService | null): void {
  diagnosticsService = service
}

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function err(code: string, message: string): IpcEnvelope<never> {
  return { ok: false, error: { code, message } }
}

function bounded(value: unknown, maxLength = 160, privateValues: readonly string[] = []): string {
  return redactDiagnosticText(typeof value === 'string' ? value : '', maxLength, privateValues)
}

function safeFilename(value: string): string {
  return (
    Array.from(value, (char) =>
      (char.codePointAt(0) ?? 0) < 32 || '<>:"/\\|?*'.includes(char) ? '-' : char
    )
      .join('')
      .slice(0, 80) || 'node'
  )
}

function reportRendererEvent(input: NodeRunLogEventInput): IpcEnvelope<boolean> {
  if (
    !input ||
    typeof input.projectId !== 'string' ||
    typeof input.nodeId !== 'string' ||
    typeof input.nodeType !== 'string' ||
    typeof input.runId !== 'string' ||
    !['info', 'error'].includes(input.level)
  ) {
    return err('INVALID_INPUT', '节点日志事件参数不完整')
  }
  const event = {
    event: 'node-run',
    at: new Date().toISOString(),
    projectId: bounded(input.projectId),
    nodeId: bounded(input.nodeId),
    nodeType: bounded(input.nodeType, 80),
    runId: bounded(input.runId),
    phase: bounded(input.phase, 40),
    level: input.level,
    message: bounded(input.message, 500)
  }
  if (input.level === 'error') log.error(JSON.stringify(event))
  else log.info(JSON.stringify(event))
  return ok(true)
}

export function registerDiagnosticsIpc(): void {
  ipcMain.handle(IPC.diagnostics.nodeRunEvent, (_event, input: NodeRunLogEventInput) =>
    reportRendererEvent(input)
  )

  // L01/L02：统一结构化诊断事件。回执=已接收/已入队，不代表已落盘；
  // 持久化状态经 diagnostics:health 查询。服务未就绪时明确返回 unavailable。
  ipcMain.handle(
    IPC.diagnostics.event,
    async (_event, input: ReportDiagnosticsEventsInput): Promise<IpcEnvelope<{ accepted: number }>> => {
      if (!input || !Array.isArray(input.events)) {
        return err('INVALID_INPUT', '诊断事件批次不完整')
      }
      if (!diagnosticsService) return err('DIAGNOSTICS_UNAVAILABLE', '诊断存储未就绪')
      try {
        const result = await diagnosticsService.ingest(input.events)
        return ok({ accepted: result.accepted })
      } catch (error) {
        // 日志失败不改变业务：吞掉异常，给受控错误码。
        const message = redactDiagnosticText(error instanceof Error ? error.message : String(error), 160)
        log.warn('[diagnostics] ingest failed', message)
        return err('DIAGNOSTICS_UNAVAILABLE', '诊断存储暂不可用')
      }
    }
  )

  ipcMain.handle(
    IPC.diagnostics.query,
    async (_event, input: DiagnosticsQueryInput): Promise<IpcEnvelope<DiagnosticsQueryResult>> => {
      if (!diagnosticsService) return err('DIAGNOSTICS_UNAVAILABLE', '诊断存储未就绪')
      try {
        return ok(await diagnosticsService.query(input ?? {}))
      } catch (error) {
        return err('QUERY_FAILED', redactDiagnosticText(error instanceof Error ? error.message : String(error), 200))
      }
    }
  )

  ipcMain.handle(IPC.diagnostics.health, (): IpcEnvelope<DiagnosticsHealthSnapshot> => {
    if (!diagnosticsService) return err('DIAGNOSTICS_UNAVAILABLE', '诊断存储未就绪')
    return ok(diagnosticsService.health())
  })

  // L05：诊断包导出。zip 内含 manifest.json / events.jsonl / summary.txt / coverage.json；
  // 25MiB 上限、原子落盘、二次脱敏；不打包数据库/项目/媒体/main.log 全文。
  ipcMain.handle(
    IPC.diagnostics.exportBundle,
    async (
      event,
      input: ExportDiagnosticsBundleInput
    ): Promise<IpcEnvelope<ExportDiagnosticsBundleResult>> => {
      if (!diagnosticsService) return err('DIAGNOSTICS_UNAVAILABLE', '诊断存储未就绪')
      if (!input?.scope || typeof input.scope !== 'object') {
        return err('INVALID_INPUT', '导出范围不完整')
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
      const options = {
        title: '导出诊断包',
        defaultPath: join(app.getPath('downloads'), `canvas-studio-diagnostics-${stamp}.zip`),
        filters: [{ name: 'Canvas Studio 诊断包', extensions: ['zip'] }]
      }
      const selection = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (selection.canceled || !selection.filePath) return err('CANCELLED', '已取消导出')
      try {
        const result = await diagnosticsService.exportBundle(input, selection.filePath)
        log.info('[diagnostics] bundle exported', {
          events: result.totalEvents,
          truncated: result.truncated,
          bytes: result.bytes
        })
        return ok({ ...result, path: selection.filePath })
      } catch (error) {
        const message = redactDiagnosticText(error instanceof Error ? error.message : String(error), 200)
        log.error('[diagnostics] bundle export failed', message)
        return err('EXPORT_FAILED', message)
      }
    }
  )

  ipcMain.handle(
    IPC.diagnostics.exportNodeRun,
    async (
      event,
      input: ExportNodeRunDiagnosticsInput
    ): Promise<IpcEnvelope<{ path: string }>> => {
      if (
        !input?.projectId ||
        !input.nodeId ||
        !input.nodeType ||
        !Array.isArray(input.runs) ||
        input.runs.length > 13
      ) {
        return err('INVALID_INPUT', '节点诊断数据不完整或超出范围')
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      const filename = `${safeFilename(input.nodeType)}-${safeFilename(input.nodeId)}-diagnostics.json`
      const options = {
        title: '导出节点诊断信息',
        defaultPath: join(app.getPath('downloads'), filename),
        filters: [{ name: 'JSON 诊断文件', extensions: ['json'] }]
      }
      const selection = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (selection.canceled || !selection.filePath) return err('CANCELLED', '已取消导出')

      // 报告构造与外部导出**共用同一份实现**（src/main/diagnostics/node-run-export.ts），
      // 保证 GUI 导出与 MCP 导出的脱敏与结构完全一致。
      const report = buildNodeRunDiagnosticsReport({
        projectId: input.projectId,
        nodeId: input.nodeId,
        nodeType: input.nodeType,
        ...(input.nodeTitle ? { nodeTitle: input.nodeTitle } : {}),
        runs: input.runs,
        ...(Array.isArray(input.redactValues) ? { redactValues: input.redactValues } : {}),
        app: {
          version: app.getVersion(),
          packaged: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          node: process.versions.node
        }
      })

      try {
        await writeFile(selection.filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
        const exported = report as { node: { type: string }; runs: unknown[] }
        log.info('[diagnostics] node run report exported', {
          nodeType: exported.node.type,
          runCount: exported.runs.length
        })
        return ok({ path: selection.filePath })
      } catch (error) {
        const message = redactDiagnosticText(error instanceof Error ? error.message : String(error))
        log.error('[diagnostics] node run report export failed', message)
        return err('EXPORT_FAILED', message)
      }
    }
  )
}
