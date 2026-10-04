// T05（F02）：快照恢复前的媒体完整性预检。纯函数，供 CanvasSidePanel 的
// 恢复流程与单元测试共用；不做任何 IO。
/** 从 tldraw store 快照中提取全部节点卡片引用的媒体 ID（按出现顺序去重）。 */
export function extractSnapshotMediaIds(snapshot: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const store = (snapshot as { store?: Record<string, unknown> } | null)?.store
  if (!store) return out
  const add = (id: unknown): void => {
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  // Only inspect declared persistence containers and media reference fields.
  // Never parse user text, prompts, chat documents or run diagnostic messages.
  const referenceKeys = new Set([
    'mediaId',
    'selectedMediaId',
    'referenceMediaId',
    'refMediaId',
    'backgroundMediaId',
    'depthMediaId'
  ])
  const referenceLists = new Set(['referenceMediaIds', 'sourceMediaIds'])
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (referenceKeys.has(key)) add(child)
      else if (referenceLists.has(key) && Array.isArray(child)) child.forEach(add)
      else if (!['text', 'prompt', 'system', 'content', 'documents'].includes(key)) visit(child)
    }
  }
  const parseContainer = (value: unknown): void => {
    if (typeof value !== 'string') return visit(value)
    try {
      visit(JSON.parse(value))
    } catch {
      /* Legacy invalid JSON is not a media reference. */
    }
  }
  for (const record of Object.values(store)) {
    if (!record || typeof record !== 'object') continue
    const shape = record as {
      type?: string
      props?: { mediaId?: unknown; config?: unknown }
      meta?: { nodeResult?: unknown; nodeExtra?: unknown; pinnedOutput?: unknown }
    }
    if (shape.type !== 'node-card') continue
    add(shape.props?.mediaId)
    parseContainer(shape.props?.config)
    parseContainer(shape.meta?.nodeResult)
    parseContainer(shape.meta?.nodeExtra)
    parseContainer(shape.meta?.pinnedOutput)
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
export function checkSnapshotMedia(
  snapshot: unknown,
  availableMediaIds: ReadonlySet<string>
): SnapshotMediaDiff {
  return diffSnapshotMedia(extractSnapshotMediaIds(snapshot), availableMediaIds)
}

export function snapshotNodeCount(snapshot: unknown): number {
  const store = (snapshot as { store?: Record<string, unknown> } | null)?.store
  return store
    ? Object.values(store).filter(
        (record) =>
          record &&
          typeof record === 'object' &&
          (record as { type?: unknown }).type === 'node-card'
      ).length
    : 0
}

/** Node identities must survive migration/loading, including a deliberately empty canvas. */
export function verifyRestoredSnapshot(expected: unknown, actual: unknown): void {
  const ids = (snapshot: unknown): string[] => {
    const store = (snapshot as { store?: Record<string, unknown> } | null)?.store
    if (!store) throw new Error('快照缺少画布数据')
    return Object.entries(store)
      .filter(
        ([, record]) =>
          record &&
          typeof record === 'object' &&
          (record as { type?: unknown }).type === 'node-card'
      )
      .map(([id]) => id)
      .sort()
  }
  if (JSON.stringify(ids(expected)) !== JSON.stringify(ids(actual))) {
    throw new Error('恢复后的节点与版本内容不一致')
  }
}

export type RestoreStage = 'validation' | 'media-precheck' | 'confirmation' | 'checkpoint' | 'apply'
export type RestoreOutcome =
  | { kind: 'restored' }
  | { kind: 'cancelled'; reason: 'user' | 'context-changed' | 'content-changed' }
  | { kind: 'failed'; stage: RestoreStage; rollback: 'not-needed' | 'succeeded' | 'failed' }

export interface SnapshotRestoreSteps {
  target: unknown
  current: unknown
  prepare: (snapshot: unknown) => unknown
  listAvailableMedia: () => Promise<ReadonlySet<string>>
  confirm: (preview: {
    currentNodes: number
    targetNodes: number
    media: SnapshotMediaDiff
  }) => Promise<boolean>
  saveCheckpoint: () => Promise<void>
  isCurrent: () => boolean
  isUnchanged: () => boolean
  apply: (snapshot: unknown) => void
  verify: (snapshot: unknown) => void
  observe?: (
    event:
      | 'started'
      | 'checkpoint_created'
      | 'completed'
      | 'cancelled'
      | 'failed'
      | 'rollback_completed'
      | 'rollback_failed',
    stage: RestoreStage
  ) => void
}

/** Restoring is a transaction: preview/precheck first, backup before mutation, rollback on failure. */
export async function restoreSnapshotSafely(steps: SnapshotRestoreSteps): Promise<RestoreOutcome> {
  let stage: RestoreStage = 'validation'
  let mutationStarted = false
  const observe = (event: Parameters<NonNullable<SnapshotRestoreSteps['observe']>>[0]): void => {
    try {
      steps.observe?.(event, stage)
    } catch {
      /* Logging cannot alter restoration. */
    }
  }
  const interruption = (): RestoreOutcome | null => {
    const reason = !steps.isCurrent()
      ? 'context-changed'
      : !steps.isUnchanged()
        ? 'content-changed'
        : null
    if (!reason) return null
    observe('cancelled')
    return { kind: 'cancelled', reason }
  }
  observe('started')
  try {
    const prepared = steps.prepare(steps.target)
    stage = 'media-precheck'
    const media = checkSnapshotMedia(prepared, await steps.listAvailableMedia())
    let cancelled = interruption()
    if (cancelled) return cancelled
    stage = 'confirmation'
    const accepted = await steps.confirm({
      currentNodes: snapshotNodeCount(steps.current),
      targetNodes: snapshotNodeCount(prepared),
      media
    })
    cancelled = interruption()
    if (cancelled) return cancelled
    if (!accepted) {
      observe('cancelled')
      return { kind: 'cancelled', reason: 'user' }
    }
    stage = 'checkpoint'
    await steps.saveCheckpoint()
    observe('checkpoint_created')
    cancelled = interruption()
    if (cancelled) return cancelled
    stage = 'apply'
    mutationStarted = true
    steps.apply(prepared)
    steps.verify(prepared)
    observe('completed')
    return { kind: 'restored' }
  } catch {
    observe('failed')
    if (!mutationStarted) return { kind: 'failed', stage, rollback: 'not-needed' }
    try {
      const rollback = steps.prepare(steps.current)
      steps.apply(rollback)
      steps.verify(rollback)
      observe('rollback_completed')
      return { kind: 'failed', stage, rollback: 'succeeded' }
    } catch {
      observe('rollback_failed')
      return { kind: 'failed', stage, rollback: 'failed' }
    }
  }
}
