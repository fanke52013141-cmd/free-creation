// 画布历史版本快照：通过主进程 SQLite 按项目隔离保存。
import { create } from 'zustand'
import type { HistorySnapshotRecord } from '@shared/contracts'

export interface HistorySnapshot extends HistorySnapshotRecord {
  /** tldraw store 快照（序列化后的完整画布状态） */
  snapshot: unknown
}

interface HistorySnapshotsState {
  projectId: string | null
  snapshots: HistorySnapshot[]
  loaded: boolean
  load: (projectId: string) => Promise<void>
  add: (
    projectId: string,
    snapshot: unknown,
    nodeCount: number,
    label: string
  ) => Promise<HistorySnapshot>
  remove: (projectId: string, id: string) => Promise<void>
}

export const useHistorySnapshots = create<HistorySnapshotsState>((set, get) => ({
  projectId: null,
  snapshots: [],
  loaded: false,

  load: async (projectId) => {
    if (get().loaded && get().projectId === projectId) return
    const result = await window.api.workspace.listSnapshots(projectId)
    if (!result.ok) throw new Error(result.error.message)
    set({ projectId, snapshots: result.data, loaded: true })
  },

  add: async (projectId, snapshot, nodeCount, label) => {
    const result = await window.api.workspace.saveSnapshot({
      projectId,
      snapshot,
      nodeCount,
      label
    })
    if (!result.ok) throw new Error(result.error.message)
    const entry = result.data
    set({ projectId, snapshots: [entry, ...get().snapshots].slice(0, 30), loaded: true })
    return entry
  },

  remove: async (projectId, id) => {
    const result = await window.api.workspace.deleteSnapshot({ projectId, id })
    if (!result.ok) throw new Error(result.error.message)
    set({ snapshots: get().snapshots.filter((snapshot) => snapshot.id !== id) })
  }
}))
