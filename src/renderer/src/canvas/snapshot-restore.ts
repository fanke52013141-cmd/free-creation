// T05（F02）：快照恢复前的媒体完整性预检。纯函数，供 CanvasSidePanel 的
// 恢复流程与单元测试共用；不做任何 IO。
/** 从 tldraw store 快照中提取全部节点卡片引用的媒体 ID（按出现顺序去重）。 */
export function extractSnapshotMediaIds(snapshot: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const store = (snapshot as { store?: Record<string, unknown> } | null)?.store
  if (!store) return out
  for (const record of Object.values(store)) {
    const props = (record as { props?: { mediaId?: unknown; mediaPath?: unknown } }).props
    const mediaId = props?.mediaId
    if (typeof mediaId === 'string' && mediaId && !seen.has(mediaId)) {
      seen.add(mediaId)
      out.push(mediaId)
    }
  }
  return out
}

export interface SnapshotMediaDiff {
  /** 快照引用且当前项目媒体库中存在的 ID。 */
  available: string[]
  /** 快照引用但媒体库缺失的 ID——恢复后这些预览将无法显示。 */
  missing: string[]
}

/** 对照当前项目媒体库，划分快照引用的媒体为可用/缺失。 */
export function diffSnapshotMedia(
  snapshotMediaIds: string[],
  availableMediaIds: ReadonlySet<string>
): SnapshotMediaDiff {
  const available: string[] = []
  const missing: string[] = []
  for (const id of snapshotMediaIds) {
    ;(availableMediaIds.has(id) ? available : missing).push(id)
  }
  return { available, missing }
}

/** 便利封装：一步完成提取+对照。 */
export function checkSnapshotMedia(snapshot: unknown, availableMediaIds: ReadonlySet<string>): SnapshotMediaDiff {
  return diffSnapshotMedia(extractSnapshotMediaIds(snapshot), availableMediaIds)
}
