/**
 * 运行记录 IPC 处理器：接收渲染进程上报的运行记录，追加写入项目的 runs.json。
 *
 * 存储路径：<projectsDir>/<projectId>/runs.json
 * 格式：JSON 数组（RunRecordEntry[]），最新在前（unshift），最多 50 条（FIFO 淘汰）。
 *
 * 容错策略：
 *   - 文件不存在 → 创建新数组 [record]
 *   - JSON 解析失败 / 非数组 → 重建为 [record]（不阻断，降级保留最新一条）
 *
 * 此通道为 fire-and-forget：渲染进程用 ipcRenderer.send，不等待返回。
 */
import { ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { IPC } from '../../shared/contracts'
import type { AppendRunInput, RunRecordEntry } from '../../shared/contracts'
import { getProjectsDir } from '../store/db'

/** runs.json 最大保留条数（FIFO 淘汰最旧记录） */
const MAX_RUNS = 50

function runsJsonPath(projectId: string): string {
  return join(getProjectsDir(), projectId, 'runs.json')
}

/**
 * 追加一条运行记录到项目的 runs.json。
 * 纯文件操作，不依赖 IPC——可供测试或主进程其他模块直接调用。
 */
export function appendRunRecord(projectId: string, record: RunRecordEntry): void {
  const dir = join(getProjectsDir(), projectId)
  mkdirSync(dir, { recursive: true })

  const path = runsJsonPath(projectId)

  // 读取已有记录（容错：损坏 → 重建为仅含当前记录）
  let records: RunRecordEntry[] = []
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        records = parsed as RunRecordEntry[]
      }
      // 非数组（如旧格式对象）→ 忽略，降级为空数组
    } catch {
      // JSON 解析失败 → 降级为空数组，不阻断写入
    }
  }

  // FIFO：最新在前，超出 MAX_RUNS 截断尾部
  records.unshift(record)
  if (records.length > MAX_RUNS) {
    records = records.slice(0, MAX_RUNS)
  }

  // 原子写：先临时文件再替换；旧版留 .bak
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8')
  if (existsSync(path)) {
    renameSync(path, path + '.bak')
  }
  renameSync(tmp, path)
}

/**
 * 读取项目的运行记录（最新在前）。文件不存在或损坏时返回空数组。
 * 供 UI 加载运行历史使用。
 */
export function readRunRecords(projectId: string): RunRecordEntry[] {
  const path = runsJsonPath(projectId)
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as RunRecordEntry[]
    return []
  } catch {
    return []
  }
}

export function registerRunIpc(): void {
  ipcMain.on(IPC.run.append, (_event, input: AppendRunInput) => {
    try {
      appendRunRecord(input.projectId, input.record)
    } catch {
      // 写盘失败不应影响渲染进程；吞掉异常
    }
  })

  ipcMain.handle(IPC.run.list, (_event, projectId: string): RunRecordEntry[] => {
    try {
      return readRunRecords(projectId)
    } catch {
      return []
    }
  })
}
