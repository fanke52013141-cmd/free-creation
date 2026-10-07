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
// 已成功项的复用只发生在本节点的 nodeResult 记录内（resume 模式按 identity 跳过），
// 不存在下游节点「已生成则复用」机制，跨运行复用不被假设。
import { inputJson } from '../inputs'
import { readNodeConfig } from '../node-config'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'

export interface IterateConfig {
  /** 单项失败策略：skip 跳过继续 / fail 立即中止 / retry 重试后仍失败则跳过。 */
  onFailure: 'skip' | 'fail' | 'retry'
  /** retry 模式每项最多重试次数（不含首次）。 */
  maxRetries: number
  /** 最大处理条数；0 表示不限。 */
  limit: number
  /** 全部重跑 / 复用已成功项继续 / 只重跑上轮失败项。 */
  runMode: 'all' | 'resume' | 'failed' | 'changed'
  /**
   * 并行处理条数 1–4（W2）。只有宿主声明支持并行循环项（ctx.parallelItems）时才
   * 真正并行；否则自动降级为 1（顺序执行）——renderer 的循环体卡片是逐项复用的
   * 共享状态，并行会互相覆盖，必须先做循环体虚拟化才能放开。
   */
  concurrency: number
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
  /** 本项实际执行时使用的独立运行 ID；复用旧产物时保留原 ID 以便追溯。 */
  runId?: string
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
  /**
   * 循环体指纹：renderer 运行器对循环体节点 type+config+text 的稳定哈希，经
   * NodeExecutionContext 注入（shared 侧拿不到循环体节点，headless / 单测路径可能缺省）。
   * 每轮写入结果头部；resume 时与上轮记录比对，不一致即拒绝续跑。旧记录无此字段时行为不变。
   */
  bodyFingerprint?: string
}

export function parseIterate(text: string): IterateConfig {
  if (!text) {
    return { onFailure: 'skip', maxRetries: 0, limit: 0, runMode: 'all', concurrency: 1 }
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    return {
      onFailure:
        value.onFailure === 'fail' || value.onFailure === 'retry' ? value.onFailure : 'skip',
      maxRetries:
        typeof value.maxRetries === 'number' ? Math.min(10, Math.max(0, value.maxRetries)) : 0,
      limit: typeof value.limit === 'number' ? Math.max(0, value.limit) : 0,
      runMode:
        value.runMode === 'resume' || value.runMode === 'failed' || value.runMode === 'changed'
          ? value.runMode
          : 'all',
      // W2：并行数钳制 1–4；缺省 / 非法值回退 1（与历史行为一致）。
      concurrency:
        typeof value.concurrency === 'number' && Number.isFinite(value.concurrency)
          ? Math.min(4, Math.max(1, Math.round(value.concurrency)))
          : 1
    }
  } catch {
    return { onFailure: 'skip', maxRetries: 0, limit: 0, runMode: 'all', concurrency: 1 }
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
    const value = JSON.parse(text) as {
      items?: unknown
      progress?: unknown
      bodyFingerprint?: unknown
    }
    if (Array.isArray(value.items))
      return {
        items: value.items as IterateItemResult[],
        // progress 必须跟着回来：卡片上的进度条与「续跑 · 4/4 · 成功 4」文案都读它，
        // 以前只回填 items，进度条因此永远渲染不出来。
        ...(value.progress && typeof value.progress === 'object'
          ? { progress: value.progress as IterateProgress }
          : {}),
        ...(typeof value.bodyFingerprint === 'string'
          ? { bodyFingerprint: value.bodyFingerprint }
          : {})
      }
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
      } else if (packets && typeof packets === 'object' && 'value' in packets) {
        const value = (packets as { value?: unknown }).value
        if (value !== undefined) {
          portValues[portId] = value
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
  index: number,
  itemRunId: string
): Promise<IterateItemResult> {
  const source = sourceFor(item, index)
  const base = { source }
  if (ctx.signal.cancelled) return { item, status: 'skipped', error: '已取消', ...base }

  let retries = 0
  for (;;) {
    if (ctx.signal.cancelled) return { item, status: 'skipped', error: '已取消', ...base }
    let output: Record<string, unknown> | undefined
    try {
      const targets = (ctx.outgoing ?? []).filter((edge) => edge.fromPortId === 'out-item')
      output = (await ctx.runSubflow?.({
        nodeIds: targets.map((edge) => edge.nodeId),
        item,
        index,
        itemId: source.itemId,
        itemRunId,
        iterationNodeId: ctx.node.id,
        itemTargets: targets.map((edge) => ({ nodeId: edge.nodeId, portId: edge.toPortId }))
      })) as Record<string, unknown> | undefined
    } catch (e) {
      // 中途取消不是失败：runSubflowForIterate 在取消时抛错而非返回部分输出。
      // 该项必须标记为已取消（不参与 onFailure 重试），resume 模式才不会把
      // 残缺产物当 done 复用（F08）。
      if (ctx.signal.cancelled) return { item, status: 'skipped', error: '已取消', ...base }
      const msg = e instanceof Error ? e.message : String(e)
      if (config.onFailure === 'retry' && retries < config.maxRetries) {
        retries += 1
        continue
      }
      return { item, status: 'failed', error: msg, runId: itemRunId, ...base }
    }
    if (!output) {
      return { item, status: 'skipped', error: '未配置子流程', ...base }
    }
    if (!outputEmpty(output)) {
      return { item, status: 'done', outputs: collectAllOutputs(output), runId: itemRunId, ...base }
    }
    if (config.onFailure === 'retry' && retries < config.maxRetries) {
      retries += 1
      continue
    }
    return { item, status: 'failed', error: '循环体未产生输出', runId: itemRunId, ...base }
  }
}

function itemRunIdFor(ctx: NodeExecutionContext, source: IterateItemSource): string {
  const workflowRunId = ctx.runId || 'workflow'
  const identity = source.itemId
    ? `${source.itemId}:${source.fingerprint ?? 'unknown'}`
    : `index:${source.index}`
  return `${workflowRunId}:item:${source.index}:${contentFingerprint({ identity })}`
}

export const iterateExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const config = parseIterate(readNodeConfig(ctx.shape))
  // 循环体指纹由 renderer 运行器算好注入；shared 侧拿不到循环体节点数据，
  // headless / 单测路径未注入时为 undefined，恢复校验退化为旧行为（R-08）。
  const bodyFingerprint = (ctx as NodeExecutionContext & { bodyFingerprint?: string })
    .bodyFingerprint
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
  // resume 前置校验：上轮记录了循环体指纹而本轮指纹不同，说明循环体已被修改，
  // 续跑会把旧产物静默标成 reused——必须拒绝并要求完整重跑（R-08）。
  if (
    (config.runMode === 'resume' || config.runMode === 'changed') &&
    previous?.bodyFingerprint &&
    bodyFingerprint &&
    previous.bodyFingerprint !== bodyFingerprint
  ) {
    return { status: 'failed', reason: '循环体已修改，不能续跑，请完整重跑' }
  }
  const previousById = new Map<string, IterateItemResult | null>()
  for (const entry of previous?.items ?? []) {
    const identity = resultIdentity(entry)
    if (!identity) continue
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
      progress: progressFor(results, config),
      // 头部带上本轮循环体指纹：即使中途取消，resume 也有比对基准（R-08）。
      ...(bodyFingerprint ? { bodyFingerprint } : {})
    }
    ctx.updateResult(JSON.stringify(data))
  }
  publishProgress()

  // W2：并行数只在宿主声明 parallelItems 时生效；renderer 循环体卡片是逐项复用
  // 的共享状态，未虚拟化前必须降级为顺序执行，并留痕说明。
  const effectiveConcurrency =
    config.concurrency > 1 && ctx.parallelItems === true ? config.concurrency : 1
  if (config.concurrency > 1 && effectiveConcurrency === 1) {
    ctx.trace?.(
      'execution',
      'info',
      `并行数 ${config.concurrency} 需要宿主支持并行循环项（parallelItems），当前按顺序执行`
    )
  }

  /** 单个下标的预处理：resume / failed 模式可能直接产出 entry 而无需执行。 */
  const prepareItem = (
    idx: number
  ): { action: 'run' } | { action: 'entry'; entry: IterateItemResult } => {
    const item = items[idx] as Record<string, unknown>
    const source = sourceFor(item, idx)
    const identity =
      source.itemId && source.fingerprint ? `${source.itemId}:${source.fingerprint}` : ''
    const prior =
      (identity && !duplicateCurrentIdentities.has(identity)
        ? previousById.get(identity)
        : undefined) ?? undefined
    if (
      (config.runMode === 'resume' || config.runMode === 'changed') &&
      isSameItem(prior, item, source) &&
      (prior.status === 'done' || prior.status === 'reused')
    ) {
      return { action: 'entry', entry: { ...prior, item, status: 'reused', source } }
    }
    if (config.runMode === 'failed') {
      if (!isSameItem(prior, item, source) || prior.status !== 'failed') {
        return {
          action: 'entry',
          entry: {
            item,
            status: 'skipped',
            error: prior ? '不属于上轮失败项' : '没有可重跑的失败项',
            source
          }
        }
      }
    }
    return { action: 'run' }
  }

  const executeItem = async (idx: number): Promise<void> => {
    const item = items[idx] as Record<string, unknown>
    const source = sourceFor(item, idx)
    const itemRunId = itemRunIdFor(ctx, source)
    const result = await runItem(ctx, config, item, idx, itemRunId)
    results[idx] = result
    publishProgress()
    if (result.status === 'failed') failedAny = true
  }

  if (effectiveConcurrency <= 1) {
    // 顺序路径（默认）：与历史行为逐字对齐——含 fail 策略的「就地标记剩余项」。
    for (let idx = 0; idx < items.length; idx += 1) {
      await ctx.waitForResume?.()
      if (ctx.signal.cancelled) break
      const plan = prepareItem(idx)
      if (plan.action === 'entry') {
        results[idx] = plan.entry
        publishProgress()
        continue
      }
      await executeItem(idx)
      if (failedAny && config.onFailure === 'fail') {
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
  } else {
    // 并行池：有界并发 claim；out-items 始终按原始下标聚合，与完成顺序无关。
    // fail 策略下停止认领新项，在途项自然完成（结果仍写入各自下标）。
    let cursor = 0
    const claimNext = (): number | null => {
      if (ctx.signal.cancelled) return null
      if (config.onFailure === 'fail' && failedAny) return null
      if (cursor >= items.length) return null
      const idx = cursor
      cursor += 1
      return idx
    }
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = claimNext()
        if (idx === null) return
        await ctx.waitForResume?.()
        if (ctx.signal.cancelled) return
        const plan = prepareItem(idx)
        if (plan.action === 'entry') {
          results[idx] = plan.entry
          publishProgress()
          continue
        }
        await executeItem(idx)
      }
    }
    await Promise.all(Array.from({ length: effectiveConcurrency }, () => worker()))
  }

  // 循环因取消 / 失败提前结束后：未到达项若在上轮已有 done/reused 记录则保留
  // （刷新 item/source、状态标为 reused），仅当无 prior 时才写 skipped。否则取消
  // 会把上轮已完成记录抹成 skipped，resume 时 previousById 查不到，全部重新付费
  // 执行（R-07）。in-flight 项不在本列：它已被 runItem 明确标为 skipped，不得把
  // 半途产物当完整结果复用（F08）。
  for (let i = 0; i < results.length; i += 1) {
    if (results[i]) continue
    const item = items[i] as Record<string, unknown>
    const source = sourceFor(item, i)
    const identity =
      source.itemId && source.fingerprint ? `${source.itemId}:${source.fingerprint}` : ''
    const prior =
      (identity && !duplicateCurrentIdentities.has(identity)
        ? previousById.get(identity)
        : undefined) ?? undefined
    if (
      prior &&
      (prior.status === 'done' || prior.status === 'reused') &&
      isSameItem(prior, item, source)
    ) {
      results[i] = { ...prior, item, status: 'reused', source }
    } else {
      results[i] = {
        item,
        status: 'skipped',
        error: ctx.signal.cancelled ? '已取消' : '未执行',
        source
      }
    }
  }
  const data: IterateResult = {
    items: results as IterateItemResult[],
    ...(bodyFingerprint ? { bodyFingerprint } : {})
  }
  ctx.restoreSubflowInputs?.({
    nodeIds: bodyTargets.map((edge) => edge.nodeId),
    iterationNodeId: ctx.node.id
  })
  ctx.updateProps({ config: JSON.stringify(config) })
  data.progress = progressFor(results, config)
  ctx.updateResult(JSON.stringify(data))
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  if (failedAny && config.onFailure === 'fail')
    return { status: 'failed', reason: '迭代中存在失败项' }
  return { status: 'done' }
}
