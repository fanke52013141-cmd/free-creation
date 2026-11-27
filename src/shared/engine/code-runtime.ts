// 代码节点运行时公共逻辑（契约规范 P3）
//
// 提取 renderer（Web Worker）和 headless（Node.js vm）共用的纯函数：
// 源码策略检查、确定性种子、输出验证。环境特定的执行实现在各自的模块中。
//
// renderer 运行时：src/renderer/src/engine/codeRuntime.ts（Web Worker）
// headless 运行时：src/main/headless/run-code.ts（Node.js vm 沙箱）

/** 代码节点的统一输出类型。 */
export type CodeOutput = { kind: 'text'; text: string } | { kind: 'json'; data: unknown }

export const CODE_RUNTIME_POLICY = {
  network: 'disabled',
  modules: 'disabled',
  clock: 'fixed-epoch',
  random: 'seeded-from-source-and-input'
} as const

const BLOCKED_SOURCE_FEATURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bimport\s*(?:\(|['"`])/u, '动态或外部模块加载'],
  [/\bimportScripts\b/u, 'Worker 模块加载'],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/u, '网络访问'],
  [/\b(?:navigator\s*\.\s*sendBeacon|sendBeacon)\b/u, '网络访问'],
  [/\b(?:crypto|performance)\b/u, '非确定性运行时 API']
]

/**
 * 代码节点不是通用脚本入口。在执行前阻止常见的网络、模块和非确定性 API。
 * Worker / vm 内还会再次封锁运行时入口；这是第一层防御。
 */
export function assertCodeSourcePolicy(source: string): void {
  for (const [pattern, label] of BLOCKED_SOURCE_FEATURES) {
    if (pattern.test(source))
      throw new Error(`代码节点不支持${label}；请通过声明的输入端口传入数据`)
  }
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`
}

/** 相同源码与输入始终得到相同随机序列；它不是加密随机数。 */
export function deterministicCodeSeed(source: string, input: Record<string, unknown>): number {
  let hash = 0x811c9dc5
  for (const char of `${source}\n${stableSerialize(input)}`) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 代码节点单次输出最大 JSON/文本字节数（2 MiB），防止内存 DoS 或撑爆快照落盘。 */
export const CODE_OUTPUT_MAX_BYTES = 2 * 1024 * 1024

/** 验证代码返回值可 JSON 序列化且在安全体积上限内，并归类为文本或 JSON。 */
export function validateCodeOutput(value: unknown): CodeOutput {
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).length > CODE_OUTPUT_MAX_BYTES) {
      throw new Error('代码输出超过 2 MiB 上限；请精简返回结果或拆分为多个步骤')
    }
    return { kind: 'text', text: value }
  }
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('不可序列化')
  } catch {
    throw new Error('代码返回值必须是可序列化的文本或 JSON 数据')
  }
  if (new TextEncoder().encode(encoded).length > CODE_OUTPUT_MAX_BYTES) {
    throw new Error('代码输出超过 2 MiB 上限；请精简返回结果或拆分为多个步骤')
  }
  return { kind: 'json', data: value }
}
