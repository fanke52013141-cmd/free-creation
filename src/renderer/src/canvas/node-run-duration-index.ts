import { atom, computed, type Atom, type Computed, type Editor } from 'tldraw'
import { readNodeRunHistory, readNodeRunRecord } from '../engine/runRecord'

export interface NodeRunDurationSample {
  durationMs: number
  providerId?: string
  modelId?: string
  recordedAt: number
}

interface NodeRunDurationIndex {
  signature: string
  /** nodeType → 同类节点全部成功运行样本（已按 recordedAt 降序预排并冻结，禁止调用方原地 sort） */
  samples: Map<string, readonly NodeRunDurationSample[]>
}

function buildRunDurationIndex(editor: Editor, version: number, computeSignature: boolean): NodeRunDurationIndex {
  const samples = new Map<string, NodeRunDurationSample[]>()
  for (const candidate of editor.getCurrentPageShapes()) {
    if (candidate.type !== 'node-card') continue
    const nodeType = String(candidate.props.nodeType)
    const history = readNodeRunHistory(candidate.meta?.nodeRunHistory)
    const latest = readNodeRunRecord(candidate.meta?.nodeRun)
    const uniqueRuns = new Map(history.map((run) => [run.runId, run]))
    if (latest && latest.status !== 'running') uniqueRuns.set(latest.runId, latest)
    if (uniqueRuns.size === 0) continue
    const list = samples.get(nodeType) ?? []
    for (const run of uniqueRuns.values()) {
      if (run.status !== 'success' || typeof run.durationMs !== 'number') continue
      list.push({
        durationMs: run.durationMs,
        providerId: run.target?.providerId,
        modelId: run.target?.modelId,
        recordedAt: run.finishedAt ?? run.startedAt
      })
    }
    if (list.length > 0) samples.set(nodeType, list)
  }
  const frozen = new Map<string, readonly NodeRunDurationSample[]>()
  for (const [nodeType, list] of samples) {
    list.sort((left, right) => right.recordedAt - left.recordedAt)
    frozen.set(nodeType, Object.freeze(list))
  }
  return {
    signature: computeSignature ? JSON.stringify([...frozen]) : `v:${version}`,
    samples: frozen
  }
}

interface RunChangeRecord {
  typeName?: string
  type?: string
  meta?: Record<string, unknown>
}

function changesAffectRunDurations(changes: {
  added: Record<string, unknown>
  updated: Record<string, [unknown, unknown]>
  removed: Record<string, unknown>
}): boolean {
  for (const key in changes.added) {
    const rec = changes.added[key] as RunChangeRecord | undefined
    if (rec?.typeName === 'shape' && rec.type === 'node-card') return true
  }
  for (const key in changes.removed) {
    const rec = changes.removed[key] as RunChangeRecord | undefined
    if (rec?.typeName === 'shape' && rec.type === 'node-card') return true
  }
  for (const key in changes.updated) {
    const [before, after] = changes.updated[key] as [RunChangeRecord, RunChangeRecord]
    if (after?.typeName === 'shape' && after.type === 'node-card') {
      if (
        before?.meta?.nodeRun !== after.meta?.nodeRun ||
        before?.meta?.nodeRunHistory !== after.meta?.nodeRunHistory
      ) {
        return true
      }
    }
  }
  return false
}

const incrementalIndexes = new WeakMap<Editor, { state: Atom<NodeRunDurationIndex>; dispose: () => void }>()
const fallbackIndexes = new WeakMap<Editor, Computed<NodeRunDurationIndex>>()

/**
 * 编辑器级运行历史耗时索引（增量监听版）。
 *
 * 仅在节点增删或 meta.nodeRun / meta.nodeRunHistory 变更时重建；
 * 拖动节点、编辑正文、修改配置期间 O(1) 跳过。
 */
export function nodeRunDurationIndex(editor: Editor): NodeRunDurationIndex {
  if (typeof editor.store?.listen === 'function') {
    let entry = incrementalIndexes.get(editor)
    if (!entry) {
      let version = 1
      const state = atom<NodeRunDurationIndex>(
        'node run duration index',
        buildRunDurationIndex(editor, version, false)
      )
      const dispose = editor.store.listen(
        (change) => {
          if (!changesAffectRunDurations(change.changes)) return
          version += 1
          state.set(buildRunDurationIndex(editor, version, false))
        },
        { scope: 'document' }
      )
      entry = { state, dispose }
      incrementalIndexes.set(editor, entry)
    }
    return entry.state.get()
  }

  let index = fallbackIndexes.get(editor)
  if (!index) {
    let version = 0
    index = computed(
      'node run duration index',
      () => {
        version += 1
        return buildRunDurationIndex(editor, version, true)
      },
      { isEqual: (a: NodeRunDurationIndex, b: NodeRunDurationIndex) => a.signature === b.signature }
    )
    fallbackIndexes.set(editor, index)
  }
  return index.get()
}

export function disposeNodeRunDurationIndex(editor: Editor): void {
  const entry = incrementalIndexes.get(editor)
  if (!entry) return
  entry.dispose()
  incrementalIndexes.delete(editor)
}
