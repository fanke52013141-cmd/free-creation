import { computed, type Editor, type Computed } from 'tldraw'
import { readNodeRunHistory, readNodeRunRecord } from '../engine/runRecord'

export interface NodeRunDurationSample {
  durationMs: number
  providerId?: string
  modelId?: string
  recordedAt: number
}

interface NodeRunDurationIndex {
  signature: string
  /** nodeType → 同类节点全部成功运行样本（口径与原逐卡扫描一致） */
  samples: Map<string, NodeRunDurationSample[]>
}

const indexes = new WeakMap<Editor, Computed<NodeRunDurationIndex>>()

/**
 * 每编辑器修订一次的全页运行历史扫描，供所有节点卡共享。
 * 此前每张卡各自扫描全页并解析所有节点的运行历史（O(N²)），
 * 任何节点运行状态写入都会让所有卡重算；现在只在运行记录真正变化时重算一次。
 */
export function nodeRunDurationIndex(editor: Editor): NodeRunDurationIndex {
  let index = indexes.get(editor)
  if (!index) {
    index = computed(
      'node run duration index',
      () => {
        const samples = new Map<string, NodeRunDurationSample[]>()
        for (const candidate of editor.getCurrentPageShapes()) {
          if (candidate.type !== 'node-card') continue
          const nodeType = String(candidate.props.nodeType)
          const history = readNodeRunHistory(candidate.meta?.nodeRunHistory)
          const latest = readNodeRunRecord(candidate.meta?.nodeRun)
          const uniqueRuns = new Map(history.map((run) => [run.runId, run]))
          if (latest && latest.status !== 'running') uniqueRuns.set(latest.runId, latest)
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
          samples.set(nodeType, list)
        }
        return { signature: JSON.stringify([...samples]), samples }
      },
      { isEqual: (a: NodeRunDurationIndex, b: NodeRunDurationIndex) => a.signature === b.signature }
    )
    indexes.set(editor, index)
  }
  return index.get()
}
