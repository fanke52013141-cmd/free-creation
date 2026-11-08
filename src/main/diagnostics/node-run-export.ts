// 节点运行诊断报告的**共享构造器**（GUI 导出与外部导出共用一份逻辑）。
//
// 为什么抽出来：原来这段构造内联在 diagnostics.ipc.ts 里（走原生保存对话框），
// 外部接入需要同一份脱敏与结构，但落位方式不同（受控导出目录）。抽成纯函数后：
// IPC 负责"选路径 + 写"，外部负责"写受控目录 + 回执指纹"，报告内容只有一份实现。
import type {
  ExportNodeRunDiagnosticsInput,
  NodeRunDiagnosticRecord
} from '../../shared/contracts'
import { redactDiagnosticText } from '../../shared/diagnostics'

export interface NodeRunDiagnosticsReportInput {
  projectId: string
  nodeId: string
  nodeType: string
  nodeTitle?: string
  runs: ExportNodeRunDiagnosticsInput['runs']
  redactValues?: readonly string[]
  app: {
    version: string
    packaged: boolean
    platform: string
    arch: string
    electron?: string
    chromium?: string
    node?: string
  }
}

/** 截断 + 去敏的字符串投影（不含具体值泄漏：只做 redact 与截断）。 */
export function boundedRunText(
  value: unknown,
  maxLength = 160,
  privateValues: readonly string[] = []
): string {
  return redactDiagnosticText(typeof value === 'string' ? value : '', maxLength, privateValues)
}

/** 文件名安全化：控制字符与 Windows 保留字符替换成 '-'，并截断。 */
export function safeRunFilename(value: string): string {
  return (
    Array.from(value, (char) =>
      (char.codePointAt(0) ?? 0) < 32 || '<>:"/\\|?*'.includes(char) ? '-' : char
    )
      .join('')
      .slice(0, 80) || 'node'
  )
}

/** 单条运行记录 → 诊断记录（字段白名单 + 二次脱敏）。 */
export function sanitizeRunRecord(
  run: ExportNodeRunDiagnosticsInput['runs'][number],
  privateValues: readonly string[]
): NodeRunDiagnosticRecord {
  const trace = Array.isArray(run.trace)
    ? run.trace.slice(-80).map((entry) => ({
        at: Number.isFinite(entry.at) ? entry.at : 0,
        phase: boundedRunText(entry.phase, 40),
        level: entry.level === 'error' ? ('error' as const) : ('info' as const),
        message: boundedRunText(entry.message, 500, privateValues)
      }))
    : []
  const inputs = Object.fromEntries(
    Object.entries(run.inputs ?? {})
      .slice(0, 100)
      .map(([portId, sources]) => [
        boundedRunText(portId, 80),
        (Array.isArray(sources) ? sources : []).slice(0, 50).map((source) => ({
          nodeId: boundedRunText(source.nodeId),
          portId: boundedRunText(source.portId, 80)
        }))
      ])
  )
  return {
    runId: boundedRunText(run.runId),
    status: boundedRunText(run.status, 24),
    startedAt: Number.isFinite(run.startedAt) ? run.startedAt : 0,
    ...(Number.isFinite(run.finishedAt) ? { finishedAt: run.finishedAt } : {}),
    ...(Number.isFinite(run.durationMs) ? { durationMs: run.durationMs } : {}),
    inputs,
    ...(Array.isArray(run.outputPorts)
      ? { outputPorts: run.outputPorts.slice(0, 50).map((value) => boundedRunText(value, 80)) }
      : {}),
    ...(run.error
      ? {
          error: {
            phase: boundedRunText(run.error.phase, 40),
            reason: boundedRunText(run.error.reason, 500, privateValues)
          }
        }
      : {}),
    ...(run.target
      ? {
          target: {
            operation: boundedRunText(run.target.operation, 80),
            ...(run.target.featureKey
              ? { featureKey: boundedRunText(run.target.featureKey, 120) }
              : {}),
            ...(run.target.providerId ? { providerId: boundedRunText(run.target.providerId) } : {}),
            ...(run.target.providerName
              ? { providerName: boundedRunText(run.target.providerName) }
              : {}),
            ...(run.target.modelId ? { modelId: boundedRunText(run.target.modelId) } : {}),
            ...(run.target.modelName ? { modelName: boundedRunText(run.target.modelName) } : {})
          }
        }
      : {}),
    trace
  }
}

/** 构造完整报告对象（GUI 与外部共用）。 */
export function buildNodeRunDiagnosticsReport(
  input: NodeRunDiagnosticsReportInput
): Record<string, unknown> {
  const privateValues = (input.redactValues ?? [])
    .filter((value): value is string => typeof value === 'string' && value.length >= 3)
    .slice(0, 100)
  return {
    format: 'canvas-studio-node-diagnostics-v1',
    exportedAt: new Date().toISOString(),
    app: { ...input.app },
    projectId: boundedRunText(input.projectId),
    node: {
      id: boundedRunText(input.nodeId),
      type: boundedRunText(input.nodeType, 80),
      title: boundedRunText(input.nodeTitle, 160)
    },
    privacy: {
      promptOrTextLogging: 'not intentional; current node text is redacted before export',
      includesMediaContent: false,
      includesApiKeys: false
    },
    runs: input.runs.map((run) => sanitizeRunRecord(run, privateValues))
  }
}
