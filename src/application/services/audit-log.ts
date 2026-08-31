/**
 * AuditLog — 审计日志实现
 *
 * 记录所有操作的完整审计轨迹：
 * - 是用户操作还是 Agent 操作
 * - 调用了什么能力
 * - 修改前后差异
 * - 使用了什么模型
 * - 花费和运行时间
 */

import type { AuditEntry, AuditLog as IAuditLog } from '../types'

export class InMemoryAuditLog implements IAuditLog {
  entries: AuditEntry[] = []
  private maxEntries: number

  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries
  }

  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    const full: AuditEntry = {
      ...entry,
      timestamp: Date.now()
    }
    this.entries.push(full)

    // 保持上限
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries)
    }
  }

  query(filter?: Partial<Pick<AuditEntry, 'actor' | 'action' | 'projectId'>>): AuditEntry[] {
    if (!filter) return [...this.entries]

    return this.entries.filter((e) => {
      if (filter.actor && e.actor !== filter.actor) return false
      if (filter.action && e.action !== filter.action) return false
      if (filter.projectId && e.projectId !== filter.projectId) return false
      return true
    })
  }

  clear(): void {
    this.entries = []
  }

  /** 导出为 JSON 字符串 */
  toJSON(): string {
    return JSON.stringify(this.entries, null, 2)
  }

  /** 按项目过滤 */
  byProject(projectId: string): AuditEntry[] {
    return this.entries.filter((e) => e.projectId === projectId)
  }

  /** 按 Agent 过滤 */
  byAgent(): AuditEntry[] {
    return this.entries.filter((e) => e.actor === 'agent')
  }
}
