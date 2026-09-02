/**
 * ProjectFileWatcher — 监听 project.json 的外部修改并通知渲染进程。
 *
 * 当 CLI 或 MCP（独立进程）写入 project.json 时，Electron 主进程通过
 * fs.watch 检测到文件变化，比较 graphVersion 判定是否为外部修改，
 * 然后向渲染进程发送 external-change 事件触发实时刷新。
 *
 * 自写忽略：渲染进程通过 IPC 保存后，本模块记录最新的 graphVersion；
 * 如果 fs.watch 触发时版本号与自写后的一致，说明是自己触发的文件事件。
 */
import { watch, type FSWatcher } from 'fs'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../shared/contracts'
import type { ProjectFile } from '../../shared/types'
import { getProjectsDir } from '../store/db'

const DEBOUNCE_MS = 300

export interface ExternalChangePayload {
  projectId: string
  graphVersion: number
}

export class ProjectFileWatcher {
  private watcher: FSWatcher | null = null
  private watchedProjectId: string | null = null
  private lastKnownGraphVersion = -1
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private getWindow: () => BrowserWindow | null) {}

  /** 开始监听指定项目的 project.json。 */
  startWatching(projectId: string): void {
    this.stopWatching()
    this.watchedProjectId = projectId

    const filePath = this.projectJsonPath(projectId)
    if (!existsSync(filePath)) return

    // 记录当前版本号作为基准
    const file = this.readProjectFile(projectId)
    this.lastKnownGraphVersion = file?.meta.graphVersion ?? -1

    try {
      this.watcher = watch(filePath, { persistent: false }, () => {
        this.scheduleCheck()
      })
      this.watcher.on('error', () => {
        // 文件被删除/移动时 watcher 自动失效，静默停止
        this.stopWatching()
      })
    } catch {
      // fs.watch 在某些环境下不可用，静默跳过
    }
  }

  /**
   * 渲染进程保存成功后调用，更新已知版本号。
   * 这样 fs.watch 因自身写入触发时不会误报为外部修改。
   */
  notifySelfSave(graphVersion: number): void {
    this.lastKnownGraphVersion = graphVersion
  }

  /** 停止监听并清理资源。 */
  stopWatching(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    this.watchedProjectId = null
    this.lastKnownGraphVersion = -1
  }

  /** 当前是否正在监听某个项目。 */
  get isWatching(): boolean {
    return this.watcher !== null
  }

  private scheduleCheck(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.checkForExternalChange(), DEBOUNCE_MS)
  }

  private checkForExternalChange(): void {
    if (!this.watchedProjectId) return

    const file = this.readProjectFile(this.watchedProjectId)
    if (!file) return

    const currentVersion = file.meta.graphVersion ?? -1
    if (currentVersion === this.lastKnownGraphVersion) return

    // 版本号变化 → 外部写入
    this.lastKnownGraphVersion = currentVersion

    const win = this.getWindow()
    if (win && !win.isDestroyed()) {
      const payload: ExternalChangePayload = {
        projectId: this.watchedProjectId,
        graphVersion: currentVersion
      }
      win.webContents.send(IPC.project.externalChange, payload)
    }
  }

  private projectJsonPath(projectId: string): string {
    return join(getProjectsDir(), projectId, 'project.json')
  }

  private readProjectFile(projectId: string): ProjectFile | null {
    const path = this.projectJsonPath(projectId)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as ProjectFile
    } catch {
      return null
    }
  }
}
