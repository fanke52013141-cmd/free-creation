import { z } from 'zod'
import { identifier } from './common'

/**
 * 诊断查询族（F9，diagnostics 族）。
 *
 * 目标：把 GUI「诊断」页的查询/导出动作开放给外部，输出必须与 GUI 同一套脱敏规则：
 * 不返回提示词、模型回复正文、密钥、原始请求响应；分页有界；导出只写受控目录。
 *
 * 新增操作的方法：在本文件的 `DIAGNOSTICS_OPERATIONS` 里登记
 * { effect, description, input }，并在 `DIAGNOSTICS_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对），
 * 再到 src/main/agent-access/service.ts 的 dispatch 给实现。
 * 共享字段请从 ./common 引入；不要用 .refine()（registry 会对输入 Schema 跑 z.toJSONSchema）。
 *
 * 本包只开放**查询**（GUI 运行中心/RunTimeline 的读动作，复用 main DiagnosticsService.query）。
 * 导出类动作（诊断包 / 单节点运行报告）本轮不开放：GUI 的导出走原生保存对话框 + renderer
 * 内存运行记录，外部等价物（受控导出目录 + 稳定运行事实来源）需要单列契约与授权，
 * 见交付台账 37 号。
 */

/** 单页上限：与 GUI 时间线的 200 条同量级，避免一次拉爆客户端与 MCP 报文。 */
export const DIAGNOSTICS_QUERY_MAX_LIMIT = 200
/** 分页偏移上限：诊断存储按分片顺序读取，过深偏移没有意义且成本高。 */
export const DIAGNOSTICS_QUERY_MAX_OFFSET = 5000
/** 主进程内部一次读取上限（DiagnosticsService.query 自身也会截到 2000）。 */
export const DIAGNOSTICS_QUERY_MAX_READ = 2000

const associationId = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/)
const level = z.enum(['debug', 'info', 'warn', 'error', 'fatal'])
const epochMs = z.number().int().min(0).max(4102444800000)

const diagnosticEventDto = z
  .object({
    eventId: z.string().max(160),
    event: z.string().max(120),
    level,
    phase: z.string().max(40).optional(),
    /** 已脱敏 + 截断的安全摘要；不含提示词、模型回复、密钥或原始报文。 */
    message: z.string().max(500),
    timestamp: z.string().max(40).optional(),
    receivedAt: z.string().max(40),
    process: z.enum(['main', 'renderer', 'worker']),
    sessionId: z.string().max(160),
    traceId: z.string().max(128).optional(),
    spanId: z.string().max(128).optional(),
    parentSpanId: z.string().max(128).optional(),
    runId: z.string().max(128).optional(),
    nodeExecutionId: z.string().max(128).optional(),
    requestId: z.string().max(128).optional(),
    taskId: z.string().max(128).optional(),
    projectId: z.string().max(128).optional(),
    nodeId: z.string().max(128).optional(),
    nodeType: z.string().max(80).optional(),
    status: z
      .enum(['success', 'failed', 'cancelled', 'skipped', 'interrupted', 'unknown'])
      .optional(),
    durationMs: z.number().nonnegative().optional(),
    correlationMissing: z.boolean().optional(),
    /** 事件注册表白名单内的属性（未知键在入库时已丢弃并计数）。 */
    attributes: z
      .record(z.string(), z.union([z.string().max(256), z.number(), z.boolean()]))
      .optional(),
    /** 归一化错误；不含 safeStack 与原始异常正文。 */
    error: z
      .object({
        code: z.string().max(64),
        category: z.string().max(32),
        retryable: z.boolean(),
        httpStatus: z.number().int().optional(),
        sourceCode: z.string().max(64).optional(),
        causeCode: z.string().max(64).optional()
      })
      .strict()
      .optional()
  })
  .strict()

export const DIAGNOSTICS_OPERATIONS = {
  'diagnostics.query': {
    effect: 'read',
    description:
      '按 trace/run/request/节点/级别/时间窗分页查询已落盘的结构化诊断事件；复用 GUI 同一诊断存储与脱敏（不返回提示词、模型回复正文、密钥或原始请求响应），服务不可用时如实报错而不是空结果',
    input: z
      .object({
        traceId: associationId.optional(),
        runId: associationId.optional(),
        requestId: associationId.optional(),
        nodeId: associationId.optional(),
        level: level.optional(),
        /** epoch ms 时间窗（可只给一侧），按事件发生时间过滤。 */
        since: epochMs.optional(),
        until: epochMs.optional(),
        offset: z.number().int().min(0).max(DIAGNOSTICS_QUERY_MAX_OFFSET).default(0),
        limit: z.number().int().min(1).max(DIAGNOSTICS_QUERY_MAX_LIMIT).default(50)
      })
      .strict()
  },
  'diagnostics.exportBundle': {
    effect: 'export',
    description:
      '把指定范围的诊断事件导出为诊断包（zip）到**受控导出目录**（复用 GUI 同一 exportBundle 与脱敏规则）；范围可为一次流程(traceId)、一次运行(runId)或时间窗，可组合；回执给文件名/sha256/字节数/事件数，不接受任意输出路径也不覆盖已有文件',
    input: z
      .object({
        traceId: associationId.optional(),
        runId: associationId.optional(),
        since: epochMs.optional(),
        until: epochMs.optional(),
        /** 写入包内 manifest 的可读标注（不含正文）。 */
        label: z.string().trim().max(120).optional()
      })
      .strict()
  },
  'diagnostics.exportNodeRun': {
    effect: 'export',
    description:
      '把某个节点最近一次运行与历史运行（≤13 条）导出为节点诊断 JSON 到**受控导出目录**：记录由权威宿主提供（与 GUI 面板"导出诊断信息"同一来源），节点正文/密钥/媒体内容在导出前被脱敏；回执给文件名/sha256/字节数/运行条数，不接受任意输出路径',
    input: z.object({ projectId: identifier, nodeId: z.string().min(1).max(180) }).strict()
  }
} as const

export const DIAGNOSTICS_OUTPUTS = {
  'diagnostics.query': z
    .object({
      events: z.array(diagnosticEventDto).max(DIAGNOSTICS_QUERY_MAX_LIMIT),
      returned: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      /** 存储侧因达到读取上限而截断（范围内还有更多事件）。 */
      truncated: z.boolean(),
      /** 下一页偏移；null 表示当前页之后没有更多匹配事件。 */
      nextOffset: z.number().int().nonnegative().nullable(),
      /** 读取时跳过的损坏行（非正常退出的残留行）。 */
      badLines: z.number().int().nonnegative(),
      scannedShards: z.number().int().nonnegative(),
      source: z.literal('diagnostics-store'),
      redaction: z.literal('event-whitelist@1')
    })
    .strict(),
  'diagnostics.exportBundle': z
    .object({
      /** 受控导出目录内的文件名；不返回绝对路径。 */
      fileName: z.string().max(160),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      byteSize: z.number().int().positive(),
      totalEvents: z.number().int().nonnegative(),
      scope: z
        .object({
          traceId: associationId.optional(),
          runId: associationId.optional(),
          since: epochMs.optional(),
          until: epochMs.optional()
        })
        .strict()
    })
    .strict(),
  'diagnostics.exportNodeRun': z
    .object({
      /** 受控导出目录内的文件名；不返回绝对路径。 */
      fileName: z.string().max(200),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      byteSize: z.number().int().positive(),
      runCount: z.number().int().nonnegative(),
      nodeType: z.string().max(80)
    })
    .strict()
} as const
