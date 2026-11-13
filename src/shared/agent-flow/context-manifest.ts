import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalFlowJson } from './semantic-revision'
import {
  ContextManifestSchema,
  ContextMissingSchema,
  type ContextManifest,
  type ContextManifestEntry,
  type StageDeliveryFact,
  type StageInputs
} from './stage-contracts'

export {
  ContextManifestSchema,
  ContextManifestEntrySchema,
  ContextMissingSchema,
  type ContextManifest,
  type ContextManifestEntry
} from './stage-contracts'

/**
 * AF-02 输入编制（ContextManifest）：一次任务固定一份 manifest。
 * 纯函数编制器：按声明选择器从已交付事实取字段/片段，去重保序、预算校验、缺项报告。
 * 不读取"最新版本"可变指针；只消费调用方传入的固定交付事实。正文不入日志（宿主仅记计数/hash）。
 */
const sha256 = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

function resolvePath(root: unknown, path: string): { found: boolean; value?: unknown } {
  if (!path) return { found: true, value: root }
  let current: unknown = root
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return { found: false }
    const record = current as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return { found: false }
    current = record[segment]
  }
  return { found: true, value: current }
}

/** 把交付输出值规范化为可编制根：json→data；text/markdown→{ text }；媒体→引用对象。 */
function outputRoot(output: StageDeliveryFact['outputs'][number]): {
  kind: ContextManifestEntry['kind']
  root: unknown
} {
  if (output.kind === 'json') return { kind: 'json', root: output.data }
  if (output.kind === 'text' || output.kind === 'markdown')
    return { kind: output.kind, root: { text: output.text ?? '' } }
  return { kind: output.kind as ContextManifestEntry['kind'], root: output }
}

export interface ContextBuildOptions {
  /** 模型容量扣除输出/框架预留后的可用字节；与声明预算取较小值。 */
  modelCapacityBytes?: number
}

/**
 * 编制一份 ContextManifest。缺项与超预算都给出稳定原因，不静默放行或截断必需内容。
 * 必需内容超预算 → exceeded=true（宿主据此停止并显示原因）；可选内容超预算 → 丢弃并记 dropped。
 */
export function buildContextManifest(
  stageKey: string,
  inputs: StageInputs,
  deliveries: StageDeliveryFact[],
  options: ContextBuildOptions = {}
): ContextManifest {
  const limitBytes = Math.min(inputs.budgetBytes, options.modelCapacityBytes ?? inputs.budgetBytes)
  const entries: ContextManifestEntry[] = []
  const missing: z.infer<typeof ContextMissingSchema>[] = []
  const dropped: z.infer<typeof ContextMissingSchema>[] = []
  const seen = new Set<string>()
  let usedBytes = 0
  let requiredBytes = 0
  for (const selector of inputs.selectors) {
    const fact = deliveries.find((delivery) => delivery.stageKey === selector.sourceStageKey)
    if (!fact) {
      missing.push({
        sourceStageKey: selector.sourceStageKey,
        path: selector.path,
        required: selector.required,
        code: 'DELIVERY_MISSING'
      })
      continue
    }
    let resolvedAny = false
    for (const output of fact.outputs) {
      const { kind, root } = outputRoot(output)
      const resolved = resolvePath(root, selector.path)
      if (!resolved.found) continue
      resolvedAny = true
      const value = resolved.value
      const contentHash = sha256(canonicalFlowJson(value))
      // 内容级去重保序：同一内容（不论来源路径）只保留一份，首次出现的元数据为准。
      if (seen.has(contentHash)) continue
      seen.add(contentHash)
      const bytes = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
      const entry: ContextManifestEntry = {
        sourceStageKey: selector.sourceStageKey,
        path: selector.path,
        kind,
        value,
        bytes,
        required: selector.required,
        ...(selector.purpose ? { purpose: selector.purpose } : {}),
        contentHash
      }
      if (selector.required) {
        // 必需内容不静默截断：先纳入，超限标记 exceeded 由宿主停止。
        entries.push(entry)
        usedBytes += bytes
        requiredBytes += bytes
      } else if (usedBytes + bytes <= limitBytes) {
        entries.push(entry)
        usedBytes += bytes
      } else {
        dropped.push({
          sourceStageKey: selector.sourceStageKey,
          path: selector.path,
          required: false,
          code: 'FIELD_MISSING'
        })
      }
    }
    if (!resolvedAny)
      missing.push({
        sourceStageKey: selector.sourceStageKey,
        path: selector.path,
        required: selector.required,
        code: 'FIELD_MISSING'
      })
  }
  const exceeded = requiredBytes > limitBytes
  const manifestHash = sha256(
    canonicalFlowJson({
      stageKey,
      entries: entries.map((entry) => ({
        sourceStageKey: entry.sourceStageKey,
        path: entry.path,
        contentHash: entry.contentHash,
        required: entry.required
      })),
      missing,
      dropped,
      limitBytes
    })
  )
  return ContextManifestSchema.parse({
    schemaVersion: 1,
    stageKey,
    entries,
    missing,
    dropped,
    budget: { limitBytes, usedBytes, exceeded },
    manifestHash
  })
}

/** 必需缺项/超预算是否阻断分派（宿主与预览共用口径）。 */
export function contextManifestBlocking(manifest: ContextManifest): boolean {
  return manifest.budget.exceeded || manifest.missing.some((item) => item.required)
}
