// 画布历史版本快照存储：手动快照 + localStorage 持久化，按项目隔离
// 遵循 workflow.ts 同款模式（手动 localStorage 读写，避免 zustand persist 序列化大对象的开销）
import { create } from 'zustand'

export interface HistorySnapshot {
  id: string
  label: string
  timestamp: number
  nodeCount: number
  /** tldraw store 快照（序列化后的完整画布状态） */
  snapshot: unknown
}

interface HistorySnapshotsState {
  projectId: string | null
  snapshots: HistorySnapshot[]
  loaded: boolean
  load: (projectId: string) => void
  add: (projectId: string, snapshot: unknown, nodeCount: number, label: string) => void
  remove: (projectId: string, id: string) => void
}

const MAX_SNAPSHOTS = 30

function storageKey(projectId: string): string {
  return `canvas-studio:history:${projectId}`
}

function readStore(projectId: string): HistorySnapshot[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return []
    const arr = JSON.parse(raw) as HistorySnapshot[]
    if (!Array.isArray(arr)) return []
    return arr
  } catch {
    return []
  }
}

function writeStore(projectId: string, snapshots: HistorySnapshot[]): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(snapshots))
  } catch {
    // localStorage 满或被禁用时静默失败
  }
}

export const useHistorySnapshots = create<HistorySnapshotsState>((set, get) => ({
  projectId: null,
  snapshots: [],
  loaded: false,

  load: (projectId) => {
    if (get().loaded && get().projectId === projectId) return
    set({ projectId, snapshots: readStore(projectId), loaded: true })
  },

  add: (projectId, snapshot, nodeCount, label) => {
    const entry: HistorySnapshot = {
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label:
        label.trim() ||
        `版本 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
      timestamp: Date.now(),
      nodeCount,
      snapshot
    }
    const next = [entry, ...get().snapshots].slice(0, MAX_SNAPSHOTS)
    writeStore(projectId, next)
    set({ projectId, snapshots: next, loaded: true })
  },

  remove: (projectId, id) => {
    const next = get().snapshots.filter((s) => s.id !== id)
    writeStore(projectId, next)
    set({ snapshots: next })
  }
}))
