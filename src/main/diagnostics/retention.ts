// 保留与限额清理（LOGGING_SPEC.md §9）：
// 普通事件 14 天 / 总量 200 MiB，错误配额 20 MiB，硬上限 256 MiB（含临时与索引）。
// 清理只作用于诊断根目录内的分片文件；绝不读取/删除项目、媒体或业务任务文件。
// 容量优先于天数：不承诺一定保存满 14 天。
import { join } from 'path'
import type { DiagnosticsFileStore } from './fs-types'
import {
  DIAGNOSTICS_RETENTION_DAYS,
  DIAGNOSTICS_RETENTION_ERROR_BYTES,
  DIAGNOSTICS_RETENTION_MAX_BYTES,
  DIAGNOSTICS_TOTAL_HARD_LIMIT_BYTES
} from '@shared/observability'

export interface RetentionResult {
  removed: string[]
  freedBytes: number
  remainingBytes: number
  /** 当日活跃分片；清理绝不触碰。 */
  keptCurrent: string | null
}

interface ShardInfo {
  name: string
  path: string
  size: number
  mtimeMs: number
  hasErrors: boolean | null
}

async function shardHasErrors(store: DiagnosticsFileStore, path: string): Promise<boolean> {
  try {
    const raw = await store.readFile(path)
    return raw.includes('"level":"error"') || raw.includes('"level":"fatal"')
  } catch {
    return true // 不可读的文件按“可能有错误内容”保守处理，优先保留。
  }
}

async function listShardInfos(
  store: DiagnosticsFileStore,
  dir: string,
  keepName: string | null
): Promise<ShardInfo[]> {
  let names: string[] = []
  try {
    names = await store.readdir(dir)
  } catch {
    return []
  }
  const infos: ShardInfo[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl') && !name.endsWith('.tmp')) continue
    if (keepName && name === keepName) continue
    const path = join(dir, name)
    const stat = await store.stat(path)
    if (!stat) continue
    infos.push({ name, path, size: stat.size, mtimeMs: stat.mtimeMs, hasErrors: null })
  }
  infos.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return infos
}

/**
 * 执行保留清理。流程：
 * 1) 删除超过保留期的分片（错误配额内的除外，见 3）。
 * 2) 总量超过 200 MiB 时先删最旧的“零错误”分片；不足再删最旧分片。
 * 3) 始终保证包含错误的分片合计不超过配额地被优先保留——即零错误分片先死。
 * 4) 硬上限（含 tmp）：超过时无条件删最旧，直到回到硬上限内。
 */
export async function enforceRetention(
  store: DiagnosticsFileStore,
  dir: string,
  options: {
    nowMs: number
    currentShard?: string | null
    retentionDays?: number
    maxBytes?: number
    errorBytes?: number
    hardLimitBytes?: number
  }
): Promise<RetentionResult> {
  const retentionDays = options.retentionDays ?? DIAGNOSTICS_RETENTION_DAYS
  const maxBytes = options.maxBytes ?? DIAGNOSTICS_RETENTION_MAX_BYTES
  const errorBytes = options.errorBytes ?? DIAGNOSTICS_RETENTION_ERROR_BYTES
  const hardLimitBytes = options.hardLimitBytes ?? DIAGNOSTICS_TOTAL_HARD_LIMIT_BYTES

  const removed: string[] = []
  let freedBytes = 0

  const remove = async (shard: ShardInfo): Promise<void> => {
    try {
      await store.unlink(shard.path)
      removed.push(shard.name)
      freedBytes += shard.size
    } catch {
      // 删除失败保持沉默：下次清理重试；不影响业务。
    }
  }

  let shards = await listShardInfos(store, dir, options.currentShard ?? null)
  let total = shards.reduce((sum, shard) => sum + shard.size, 0)

  // 1) 超期清理（错误分片延后到第 3 步判断后再决定，先把过期零错误分片删掉）。
  const retentionCutoff = options.nowMs - retentionDays * 24 * 60 * 60 * 1000
  for (const shard of shards.filter((item) => item.mtimeMs > 0 && item.mtimeMs < retentionCutoff)) {
    if (total - freedBytes <= maxBytes && shard.size <= errorBytes) {
      const hasErrors = shard.hasErrors ?? (await shardHasErrors(store, shard.path))
      shard.hasErrors = hasErrors
      if (hasErrors) continue
    }
    await remove(shard)
  }
  shards = shards.filter((shard) => !removed.includes(shard.name))
  total = shards.reduce((sum, shard) => sum + shard.size, 0)

  // 2) 容量清理：先删零错误分片（旧→新），不够再删全部（旧→新）。
  if (total > maxBytes) {
    const zeroError: ShardInfo[] = []
    for (const shard of shards) {
      const hasErrors = shard.hasErrors ?? (await shardHasErrors(store, shard.path))
      shard.hasErrors = hasErrors
      if (!hasErrors) zeroError.push(shard)
    }
    for (const shard of zeroError) {
      if (total - freedBytes <= maxBytes) break
      await remove(shard)
    }
    for (const shard of shards) {
      if (total - freedBytes <= maxBytes) break
      if (removed.includes(shard.name)) continue
      await remove(shard)
    }
  }

  // 4) 硬上限（含 tmp 与索引）：无条件删最旧。
  const hard = await listShardInfos(store, dir, options.currentShard ?? null)
  let hardTotal = hard.reduce((sum, shard) => sum + shard.size, 0)
  for (const shard of hard) {
    if (hardTotal <= hardLimitBytes) break
    await remove(shard)
    hardTotal -= shard.size
  }

  const remaining = await listShardInfos(store, dir, options.currentShard ?? null)
  return {
    removed,
    freedBytes,
    remainingBytes: remaining.reduce((sum, shard) => sum + shard.size, 0),
    keptCurrent: options.currentShard ?? null
  }
}
