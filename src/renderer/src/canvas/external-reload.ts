// 外部修改重载的三方合并（Canvas Studio 本地数据安全）。
//
// 竞态背景：渲染进程的自动保存有 800ms 防抖。外部写入（Agent/CLI/MCP）触发
// external-change 重载时，最近 800ms 内创建的节点/连线尚未落盘——直接加载磁盘
// 快照会把这些新增工作流元素整个吞掉（2026-09-06 桌面审查实锤）。
//
// 合并策略（保守且可预期）：
//   - 以磁盘快照为基准（外部修改胜出，同一形状的本地改动被外部版本覆盖）；
//   - 仅补回「本地存在、磁盘上没有」的 document 记录（shape/binding/asset）——
//     这正是未落盘的新增元素，补回不会与外部改动冲突；
//   - 本地删除了旧元素但未保存的场景会被「复活」，属于可接受代价：
//     相比丢掉用户刚画的内容，多留一个待删元素危害更小。
//
// camera/selection 等 session 记录不在 document 快照内，由调用方在重载后自行恢复。
export interface StoreSnapshotLike {
  store: Record<string, unknown>
}

export function isDocumentRecordKey(key: string): boolean {
  return key.startsWith('shape:') || key.startsWith('binding:') || key.startsWith('asset:')
}

/**
 * 把本地 document 快照中「磁盘上没有」的记录并入磁盘快照，返回合并结果。
 * 两个入参都不会被修改；任一快照缺 store 字段时原样返回磁盘快照。
 */
export function mergeUnsavedLocalRecords(
  diskSnapshot: StoreSnapshotLike,
  localSnapshot: StoreSnapshotLike
): StoreSnapshotLike {
  const diskStore = diskSnapshot.store
  const localStore = localSnapshot.store
  if (!diskStore || !localStore) return diskSnapshot

  const merged: Record<string, unknown> = { ...diskStore }
  for (const [key, value] of Object.entries(localStore)) {
    if (!isDocumentRecordKey(key)) continue
    if (key in merged) continue
    merged[key] = value
  }
  return { ...diskSnapshot, store: merged }
}

/** 统计本地快照中会被补回的 document 记录数（供 toast 提示与测试）。 */
export function countRestorableRecords(
  diskSnapshot: StoreSnapshotLike,
  localSnapshot: StoreSnapshotLike
): number {
  const diskStore = diskSnapshot.store
  const localStore = localSnapshot.store
  if (!diskStore || !localStore) return 0
  return Object.keys(localStore).filter((key) => isDocumentRecordKey(key) && !(key in diskStore))
    .length
}
