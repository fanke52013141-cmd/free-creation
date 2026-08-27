/**
 * 运行日志 IPC 处理器：接收渲染进程上报的错误条目，脱敏后写入 electron-log。
 *
 * electron-log 默认输出到：
 *   Windows: %APPDATA%/<appName>/logs/main.log（按天滚动）
 *
 * 此通道为 fire-and-forget：渲染进程用 ipcRenderer.send，不等待返回。
 */
import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { IPC } from '../../shared/contracts'
import type { RunLogEntry } from '../../shared/contracts'
import { sanitizeRunError } from '../../shared/sanitize'

export function registerLogIpc(): void {
  ipcMain.on(IPC.log.write, (_event, entry: RunLogEntry) => {
    try {
      const safe = sanitizeRunError({ ...entry, timestamp: entry.timestamp ?? Date.now() })
      const parts: string[] = [
        `[${new Date(safe.timestamp).toISOString()}]`,
        safe.phase ? `(${safe.phase})` : '(error)',
        safe.label
      ]
      if (safe.nodeType) parts.push(`type=${safe.nodeType}`)
      if (safe.nodeId) parts.push(`node=${safe.nodeId}`)
      if (safe.portId) parts.push(`port=${safe.portId}`)
      if (safe.contractVersion !== undefined) parts.push(`contract=v${safe.contractVersion}`)
      if (safe.runId) parts.push(`run=${safe.runId}`)
      parts.push(`— ${safe.reason}`)
      log.warn(parts.join(' '))
    } catch {
      // 脱敏或写盘失败不应影响渲染进程；吞掉异常
    }
  })
}
