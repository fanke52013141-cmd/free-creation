// 诊断事件 schema v1（LOGGING_SPEC.md §5）。
// wire 输入（DiagnosticsEventInput）由生产者构造，main 入口用 zod 重新校验；
// 存储态（DiagnosticsEvent）在接收后被 main 补齐 sessionId/receivedAt。
import { z } from 'zod'
import { DIAGNOSTICS_SCHEMA_VERSION } from './limits'

export const DIAGNOSTICS_EVENT_INPUT_SCHEMA = z.object({
  event: z.string().min(1).max(120),
  level: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).optional(),
  phase: z.string().max(40).optional(),
  message: z.string().max(2000).optional(),
  timestamp: z.string().max(40).optional(),
  traceId: z.string().max(128).optional(),
  spanId: z.string().max(128).optional(),
  parentSpanId: z.string().max(128).optional(),
  runId: z.string().max(128).optional(),
  nodeExecutionId: z.string().max(128).optional(),
  requestId: z.string().max(128).optional(),
  attempt: z.number().int().positive().max(1000).optional(),
  taskId: z.string().max(128).optional(),
  upstreamTaskId: z.string().max(256).optional(),
  upstreamRequestId: z.string().max(256).optional(),
  batchId: z.string().max(128).optional(),
  itemId: z.string().max(128).optional(),
  projectId: z.string().max(128).optional(),
  nodeId: z.string().max(128).optional(),
  nodeType: z.string().max(80).optional(),
  status: z.enum(['success', 'failed', 'cancelled', 'skipped', 'interrupted', 'unknown']).optional(),
  durationMs: z.number().nonnegative().finite().optional(),
  error: z
    .object({
      code: z.string().min(1).max(64),
      category: z.string().max(32),
      retryable: z.boolean(),
      httpStatus: z.number().int().optional(),
      sourceCode: z.string().max(64).optional(),
      causeCode: z.string().max(64).optional(),
      safeStack: z.string().max(4200).optional()
    })
    .optional(),
  attributes: z.record(z.string(), z.union([z.string().max(256), z.number(), z.boolean()])).optional(),
  linkedTraceIds: z.array(z.string().max(128)).max(50).optional(),
  resumesTraceId: z.string().max(128).optional(),
  retryOfTraceId: z.string().max(128).optional(),
  retryOfNodeExecutionId: z.string().max(128).optional(),
  correlationMissing: z.boolean().optional(),
  /** 生产者内部字段：main 校验时提升为 process/producerId/sequence。 */
  producerMeta: z
    .object({
      process: z.enum(['main', 'renderer', 'worker']),
      producerId: z.string().min(1).max(128),
      sequence: z.number().int().nonnegative(),
      droppedKeys: z.number().int().nonnegative().default(0),
      truncatedFields: z.array(z.string().max(64)).max(16).optional()
    })
    .optional()
})

export type DiagnosticsEventInput = z.infer<typeof DIAGNOSTICS_EVENT_INPUT_SCHEMA>

/** main 落盘前补齐的完整存储态事件。DiagnosticsProcess 类型以 context.ts 为权威。 */
export interface DiagnosticsEvent extends Omit<DiagnosticsEventInput, 'producerMeta'> {
  schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION
  eventId: string
  sessionId: string
  producerId: string
  sequence: number
  process: import('./context').DiagnosticsProcess
  receivedAt: string
  /** main 校验时丢弃的未知 attribute 键数量。 */
  droppedKeys?: number
  truncatedFields?: string[]
}

export const DIAGNOSTICS_EVENT_SCHEMA = DIAGNOSTICS_EVENT_INPUT_SCHEMA.omit({
  producerMeta: true
}).extend({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  producerId: z.string().min(1).max(128),
  sequence: z.number().int().nonnegative(),
  process: z.enum(['main', 'renderer', 'worker']),
  receivedAt: z.string().max(40)
})

/** 解析一条存储态 JSONL 行；坏行返回 null（由读取方计数，不抛错）。 */
export function parseDiagnosticsEventLine(line: string): DiagnosticsEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = DIAGNOSTICS_EVENT_SCHEMA.safeParse(value)
  if (!parsed.success) return null
  return parsed.data
}
