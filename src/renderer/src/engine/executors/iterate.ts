// 循环节点执行器（原迭代节点）
//
// 把 `in-list`（list.items@1）里的每个元素作为一次「循环体」执行：
// 对每一项，经 runSubflow 把当前项注入由 out-item 明确标记的循环体执行一次，
// 收集每项结果并输出结构化的 `{ items: [...] }` 列表（out-items）。
//
// 多产物收集：每项执行后收集循环体中所有节点的所有输出端口值，
// 按 { nodeId: { portId: value } } 结构化聚合，不再只取首个非空值。
//
// 完成标准：20 个镜头可受控批量执行、单项失败不丢其它成功结果、中止后可恢复未完成项。
// 每项结果带 source（index / itemId）与 status，失败的项保留原因；中止后续跑时，
// 已成功的项可作为已完成项跳过（由下游节点「已生成则复用」兜底）。
import { inputJson } from '../contracts'
import { readNodeConfig } from '../../canvas/node-persistence'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'

export interface IterateConfig {
  /** 单项失败策略：skip 跳过继续 / fail 立即中止 / retry 重试后仍失败则跳过。 */
  onFailure: 'skip' | 'fail' | 'retry'
  /** retry 模式每项最多重试次数（不含首次）。 */
  maxRetries: number
  /** 最大处理条数；0 表示不限。 */
  limit: number
  /** 全部重跑 / 复用已成功项继续 / 只重跑上轮失败项。 */
  runMode: 'all' | 'resume' | 'failed'
}

export type IterateItemStatus = 'pending' | 'done' | 'reused' | 'failed' | 'skipped'

export interface IterateItemSource {
  index: number
  itemId?: string
  /** 基于内容的稳定指纹；只和 itemId 一起用于恢复校验。 */
  fingerprint?: string
}

export interface IterateItemResult {
  /** 原始列表元素（作为子流程输入）。 */
  item: Record<string, unknown>
  /** 处理状态。 */
  status: IterateItemStatus
  /** 循环体所有节点所有输出端口的结构化聚合：{ nodeId: { portId: value } }。 */
  outputs?: Record<string, Record<string, unknown>>
  /** 失败 / 跳过原因。 */
  error?: string
  /** 来源追踪：序号 + 可选稳定 id（如镜头 id）。 */
  source: IterateItemSource
}

export interface IterateProgress {
  total: number
  completed: number
  pending: number
  done: number
  reused: number
  failed: number
  skipped: number
  mode: IterateConfig['runMode']
}

export interface IterateResult {
  items: IterateItemResult[]
  progress?: IterateProgress
}

export function parseIterate(text: string): IterateConfig {
  if (!text) {
    return { onFailure: 'skip', maxRetries: 0, limit: 0, runMode: 'all' }
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    return {
      onFailure:
        value.onFailure === 'fail' || value.onFailure === 'retry' ? value.onFailure : 'skip',
      maxRetries: typeof value.maxRetries === 'number' ? Math.max(0, value.maxRetries) : 0,
      limit: typeof value.limit === 'number' ? Math.max(0, value.limit) : 0,
      runMode: value.runMode === 'resume' || value.runMode === 'failed' ? value.runMode : 'all'
    }
  } catch {
    return { onFailure: 'skip', maxRetries: 0, limit: 0, runMode: 'all' }
  }
}

/** 把对象序列化为键顺序稳定的字符串，确保恢复判定不受 JSON 字段顺序影响。 */
function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`
}

/** FNV-1a：足够用于本地运行记录的变更检测，不承担安全或加密用途。 */
function contentFingerprint(item: Record<string, unknown>): string {
  let hash = 0x811c9dc5
  for (const char of stableSerialize(item)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function sourceFor(item: Record<string, unknown>, index: number): IterateItemSource {
  const itemId = typeof item.id === 'string' && item.id.trim() ? item.id : undefined
  return {
    index,
    ...(itemId ? { itemId, fingerprint: contentFingerprint(item) } : {})
  }
}

function progressFor(
  entries: Array<IterateItemResult | undefined>,
  config: IterateConfig
): IterateProgress {
  const counts: Record<IterateItemStatus, number> = {
    pending: 0,
    done: 0,
    reused: 0,
    failed: 0,
    skipped: 0
  }
  for (const entry of entries) counts[entry?.status ?? 'pending'] += 1
  return {
    total: entries.length,
    completed: entries.length - counts.pending,
    ...counts,
    mode: config.runMode
  }
}

function isSameItem(
  previous: IterateItemResult | undefined,
  item: Record<string, unknown>,
  source: IterateItemSource
): previous is IterateItemResult {
  const previousSource = previous?.source
  if (!previous || !previousSource?.itemId || !previousSource.fingerprint) return false
  return (
    previousSource.itemId === source.itemId &&
    previousSource.fingerprint === source.fingerprint &&
    stableSerialize(previous.item) === stableSerialize(item)
  )
}

/** 损坏或旧版运行记录不得参与恢复；返回 null 表示该项没有可安全复用的身份。 */
function resultIdentity(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null
  const source = (entry as { source?: unknown }).source
  if (!source || typeof source !== 'object') return null
  const { itemId, fingerprint } = source as { itemId?: unknown; fingerprint?: unknown }
  return typeof itemId === 'string' && typeof fingerprint === 'string'
    ? `${itemId}:${fingerprint}`
    : null
}

export function parseIterateResult(text: string): IterateResult | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as { items?: unknown }
    if (Array.isArray(value.items)) return { items: value.items as IterateItemResult[] }
  } catch {
    // 忽略
  }
  return null
}

/**
 * 从循环体输出里收集所有节点所有输出端口的结构化值。
 * 输入格式：{ nodeId: { portId: [{ value: ... }, ...] } }
 * 输出格式：{ nodeId: { portId: value } }（每个端口取首个值，多值端口取数组）
 */
function collectAllOutputs(
  output: Record<string, unknown>
): Record<string, Record<string, unknown>> | undefined {
  const result: Record<string, Record<string, unknown>> = {}
  let hasAny = false
  for (const [nodeId, portMap] of Object.entries(output)) {
    if (!portMap || typeof portMap !== 'object') continue
    const ports = portMap as Record<string, unknown>
    const portValues: Record<string, unknown> = {}
    for (const [portId, packets] of Object.entries(ports)) {
      if (Array.isArray(packets) && packets.length > 0) {
        const packetArr = packets as Array<{ value?: unknown }>
        const values = packetArr.map((p) => p?.value).filter((v) => v !== undefined)
        if (values.length > 0) {
          portValues[portId] = values.length === 1 ? values[0] : values
          hasAny = true
        }
      }
    }
    if (Object.keys(portValues).length > 0) {
      result[nodeId] = portValues
    }
  }
  return hasAny ? result : undefined
}

/** 循环体是否产生了任何可见输出。 */
function outputEmpty(output: Record<string, unknown>): boolean {
  for (const packets of Object.values(output)) {
    const packetsRecord = packets as Record<string, unknown>
    if (Object.keys(packetsRecord).length > 0) return false
  }
  return true
}

/** 对单个列表项执行一次循环体（含失败 / 重试语义）。 */
async function runItem(
  ctx: NodeExecutionContext,
  config: IterateConfig,
  item: Record<string, unknown>,
  index: number
): Promise<IterateItemResult> {
  const source = sourceFor(item, index)
  const base = { source }
  if (ctx.signal.cancelled) return { item, status: 'skipped', error: '已取消', ...base }

  let retries = 0
  for (;;) {
    if (ctx.signal.cancelled) return { item, status: 'skipped', error: '已取消', ...base }
    // 子流程执行可能抛错（如迭代体节点输出契约失败）。这里统一捕获并按失败策略
    // 处理，避免错误冒泡成未处理 rejection，也与「迭代体未产生输出」走同一通路。
    let output: Record<string, unknown> | undefined
    try {
      const targets = (ctx.outgoing ?? []).filter((edge) => edge.fromPortId === 'out-item')
      output = (await ctx.runSubflow?.({
        nodeIds: targets.map((edge) => edge.nodeId),
        item,
        index,
        itemId: source.itemId,
        iterationNodeId: ctx.node.id,
        itemTargets: targets.map((edge) => ({ nodeId: edge.nodeId, portId: edge.toPortId }))
      })) as Record<string, unknown> | undefined
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (config.onFailure === 'retry' && retries < config.maxRetries) {
        retries += 1
        continue
      }
      return { item, status: 'failed', error: msg, ...base }
    }
    if (!output) {
      return { item, status: 'skipped', error: '未配置子流程', ...base }
    }
    if (!outputEmpty(output)) {
      return { item, status: 'done', outputs: collectAllOutputs(output), ...base }
    }
    // 下游未产生输出：按失败策略处理
    if (config.onFailure === 'retry' && retries < config.maxRetries) {
      retries += 1
      continue
    }
    return { item, status: 'failed', error: '循环体未产生输出', ...base }
  }
}

export const iterateExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const config = parseIterate(readNodeConfig(ctx.shape))
  const list = inputJson(ctx.inputs, 'in-list')[0]
  if (!Array.isArray(list)) return { status: 'skipped', reason: '没有可循环的列表输入' }
  const bodyTargets = (ctx.outgoing ?? []).filter((edge) => edge.fromPortId === 'out-item')
  if (!ctx.runSubflow || bodyTargets.length === 0) {
    return {
      status: 'skipped',
      reason: '未配置循环体（请从“当前项”端口连接要批量执行的第一个节点）'
    }
  }

  const items = config.limit > 0 ? list.slice(0, config.limit) : list
  const results: Array<IterateItemResult | undefined> = new Array(items.length)
  const previous = parseIterateResult(
    typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : ''
  )
  const previousById = new Map<string, IterateItemResult | null>()
  for (const entry of previous?.items ?? []) {
    const identity = resultIdentity(entry)
    if (!identity) continue
    // 重复身份没有可靠的一一映射关系，后续一律不复用。
    previousById.set(identity, previousById.has(identity) ? null : entry)
  }
  const currentIdentities = items.map((item) => {
    const source = sourceFor(item as Record<string, unknown>, 0)
    return source.itemId && source.fingerprint ? `${source.itemId}:${source.fingerprint}` : null
  })
  const duplicateCurrentIdentities = new Set(
    currentIdentities.filter(
      (identity, index, all): identity is string =>
        Boolean(identity) && all.indexOf(identity) !== index
    )
  )
  let failedAny = false

  const publishProgress = (): void => {
    const data: IterateResult = {
      items: results.map(
        (entry, index) =>
          entry ?? {
            item: items[index] as Record<string, unknown>,
            status: 'pending',
            source: sourceFor(items[index] as Record<string, unknown>, index)
          }
      ),
      progress: progressFor(results, config)
    }
    ctx.updateResult(JSON.stringify(data))
  }
  publishProgress()

  // 严格串行：迭代体的下游节点在画布上是单例，其持久状态（mediaPath 等）与
  // 运行输出登记是共享可变的；并行跑多项会互相覆盖、产出错乱数据。要支持并行，
  // 必须先引入每项独立的运行态，而不是暴露一个无法兑现的并发配置。
  for (let idx = 0; idx < items.length; idx += 1) {
    await ctx.waitForResume?.()
    if (ctx.signal.cancelled) break
    const item = items[idx] as Record<string, unknown>
    const source = sourceFor(item, idx)
    const identity =
      source.itemId && source.fingerprint ? `${source.itemId}:${source.fingerprint}` : ''
    const prior =
      (identity && !duplicateCurrentIdentities.has(identity)
        ? previousById.get(identity)
        : undefined) ?? undefined
    if (
      config.runMode === 'resume' &&
      isSameItem(prior, item, source) &&
      (prior.status === 'done' || prior.status === 'reused')
    ) {
      results[idx] = { ...prior, item, status: 'reused', source }
      publishProgress()
      continue
    }
    if (config.runMode === 'failed') {
      if (!isSameItem(prior, item, source) || prior.status !== 'failed') {
        results[idx] = {
          item,
          status: 'skipped',
          error: prior ? '不属于上轮失败项' : '没有可重跑的失败项',
          source
        }
        publishProgress()
        continue
      }
    }
    const result = await runItem(ctx, config, item, idx)
    results[idx] = result
    publishProgress()
    if (result.status === 'failed') {
      failedAny = true
      if (config.onFailure === 'fail') {
        // 立即中止：剩余未处理项标记 skipped
        for (let i = idx + 1; i < items.length; i += 1) {
          results[i] = {
            item: items[i] as Record<string, unknown>,
            status: 'skipped',
            source: sourceFor(items[i] as Record<string, unknown>, i)
          }
        }
        publishProgress()
        break
      }
    }
  }

  // 未处理项（取消 / 中止）标记 skipped
  for (let i = 0; i < results.length; i += 1) {
    if (!results[i]) {
      results[i] = {
        item: items[i] as Record<string, unknown>,
        status: 'skipped',
        error: ctx.signal.cancelled ? '已取消' : '未执行',
        source: sourceFor(items[i] as Record<string, unknown>, i)
      }
    }
  }
  const data: IterateResult = { items: results as IterateItemResult[] }
  // 配置/结果分离：props.config 存配置，运行结果 { items } 走 meta（updateResult）。
  // 输出投影（nodeValues.ts）从 meta.nodeResult 读取 items。
  ctx.updateProps({ config: JSON.stringify(config) })
  data.progress = progressFor(results, config)
  ctx.updateResult(JSON.stringify(data))
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  if (failedAny && config.onFailure === 'fail')
    return { status: 'failed', reason: '迭代中存在失败项' }
  return { status: 'done' }
}
