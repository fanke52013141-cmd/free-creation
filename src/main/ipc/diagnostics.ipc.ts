import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import log from 'electron-log/main'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { redactDiagnosticText } from '../../shared/diagnostics'
import { IPC } from '../../shared/contracts'
import type {
  ExportNodeRunDiagnosticsInput,
  IpcEnvelope,
  NodeRunDiagnosticRecord,
  NodeRunLogEventInput
} from '../../shared/contracts'

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

function sanitizeRun(
  run: ExportNodeRunDiagnosticsInput['runs'][number],
  privateValues: readonly string[]
): NodeRunDiagnosticRecord {
  const trace = Array.isArray(run.trace)
    ? run.trace.slice(-80).map((entry) => ({
        at: Number.isFinite(entry.at) ? entry.at : 0,
        phase: bounded(entry.phase, 40),
        level: entry.level === 'error' ? ('error' as const) : ('info' as const),
        message: bounded(entry.message, 500, privateValues)
      }))
    : []
  const inputs = Object.fromEntries(
    Object.entries(run.inputs ?? {}).slice(0, 100).map(([portId, sources]) => [
      bounded(portId, 80),
      (Array.isArray(sources) ? sources : []).slice(0, 50).map((source) => ({
        nodeId: bounded(source.nodeId),
        portId: bounded(source.portId, 80)
      }))
    ])
  )
  return {
    runId: bounded(run.runId),
    status: bounded(run.status, 24),
    startedAt: Number.isFinite(run.startedAt) ? run.startedAt : 0,
    ...(Number.isFinite(run.finishedAt) ? { finishedAt: run.finishedAt } : {}),
    ...(Number.isFinite(run.durationMs) ? { durationMs: run.durationMs } : {}),
    inputs,
    ...(Array.isArray(run.outputPorts)
      ? { outputPorts: run.outputPorts.slice(0, 50).map((value) => bounded(value, 80)) }
      : {}),
    ...(run.error
      ? {
          error: {
            phase: bounded(run.error.phase, 40),
            reason: bounded(run.error.reason, 500, privateValues)
          }
        }
      : {}),
    ...(run.target
      ? {
          target: {
            operation: bounded(run.target.operation, 80),
            ...(run.target.featureKey ? { featureKey: bounded(run.target.featureKey, 120) } : {}),
            ...(run.target.providerId ? { providerId: bounded(run.target.providerId) } : {}),
            ...(run.target.providerName ? { providerName: bounded(run.target.providerName) } : {}),
            ...(run.target.modelId ? { modelId: bounded(run.target.modelId) } : {}),
            ...(run.target.modelName ? { modelName: bounded(run.target.modelName) } : {})
          }
        }
      : {}),
    trace
  }
}

export function registerDiagnosticsIpc(): void {
  ipcMain.handle(IPC.diagnostics.nodeRunEvent, (_event, input: NodeRunLogEventInput) =>
    reportRendererEvent(input)
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
      const privateValues = (Array.isArray(input.redactValues) ? input.redactValues : [])
        .filter((value): value is string => typeof value === 'string' && value.length >= 3)
        .slice(0, 100)
      const options = {
        title: '导出节点诊断信息',
        defaultPath: join(app.getPath('downloads'), filename),
        filters: [{ name: 'JSON 诊断文件', extensions: ['json'] }]
      }
      const selection = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (selection.canceled || !selection.filePath) return err('CANCELLED', '已取消导出')

      const report = {
        format: 'canvas-studio-node-diagnostics-v1',
        exportedAt: new Date().toISOString(),
        app: {
          version: app.getVersion(),
          packaged: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          node: process.versions.node
        },
        projectId: bounded(input.projectId),
        node: {
          id: bounded(input.nodeId),
          type: bounded(input.nodeType, 80),
          title: bounded(input.nodeTitle, 160)
        },
        privacy: {
          promptOrTextLogging: 'not intentional; current node text is redacted before export',
          includesMediaContent: false,
          includesApiKeys: false
        },
        runs: input.runs.map((run) => sanitizeRun(run, privateValues))
      }

      try {
        await writeFile(selection.filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
        log.info('[diagnostics] node run report exported', {
          nodeType: report.node.type,
          runCount: report.runs.length
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
