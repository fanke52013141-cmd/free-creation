// 诊断事件尺寸与数量上限（LOGGING_SPEC.md §5）。
// 限制必须写入共享常量并由测试覆盖；超出按 safe.ts 规则截断并记入 truncatedFields。
export const DIAGNOSTICS_SCHEMA_VERSION = 1

/** 单条事件序列化后的最大字节数。 */
export const DIAGNOSTICS_EVENT_MAX_BYTES = 16 * 1024
/** message 安全摘要的最大字符数。 */
export const DIAGNOSTICS_MESSAGE_MAX_CHARS = 500
/** 安全 stack 的最大字符数。 */
export const DIAGNOSTICS_STACK_MAX_CHARS = 4 * 1024
/** attributes 允许的最大已注册键数。 */
export const DIAGNOSTICS_ATTRIBUTES_MAX_KEYS = 32
/** 事件内数组字段的最大项数（超出保留总数说明）。 */
export const DIAGNOSTICS_ARRAY_MAX_ITEMS = 50
/** ID 类字段的最大字符数；不用标题等长文本冒充 ID。 */
export const DIAGNOSTICS_ID_MAX_CHARS = 128

// —— 独立事件存储默认值（LOGGING_SPEC.md §9，实施计划 L02）——
/** 队列最大条数（与字节数先到为准）。 */
export const DIAGNOSTICS_QUEUE_MAX_ITEMS = 2048
/** 队列最大字节。 */
export const DIAGNOSTICS_QUEUE_MAX_BYTES = 8 * 1024 * 1024
/** 关键事件（error/fatal 与终态）在队列中的预留容量。 */
export const DIAGNOSTICS_QUEUE_CRITICAL_RESERVED = 128
/** 批量写触发间隔。 */
export const DIAGNOSTICS_FLUSH_INTERVAL_MS = 500
/** 批量写触发条数。 */
export const DIAGNOSTICS_FLUSH_BATCH_ITEMS = 64
/** 单个 JSONL 分片按大小轮转的阈值。 */
export const DIAGNOSTICS_SHARD_MAX_BYTES = 10 * 1024 * 1024
/** 普通事件保留天数。 */
export const DIAGNOSTICS_RETENTION_DAYS = 14
/** 事件总量上限（含错误配额）。 */
export const DIAGNOSTICS_RETENTION_MAX_BYTES = 200 * 1024 * 1024
/** 错误/关键终态保留配额。 */
export const DIAGNOSTICS_RETENTION_ERROR_BYTES = 20 * 1024 * 1024
/** 诊断底座管理的文件硬上限（含临时与索引）。 */
export const DIAGNOSTICS_TOTAL_HARD_LIMIT_BYTES = 256 * 1024 * 1024
/** 正常退出等待 flush 的上限。 */
export const DIAGNOSTICS_QUIT_FLUSH_TIMEOUT_MS = 2000
/** 健康状态环中保留的关键丢失摘要条数。 */
export const DIAGNOSTICS_HEALTH_RING_ITEMS = 32
