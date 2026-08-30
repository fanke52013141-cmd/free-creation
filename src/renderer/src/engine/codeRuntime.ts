// 代码节点运行时：在浏览器 Worker 中执行用户编写的同步/异步转换函数。
// Worker 没有 Electron/Node API，输入仅通过结构化克隆传入；超时后会立即终止。
// 注入本地、固定版本的轻量工具库，支持 Coze 风格 async function main(args) 写法。

export type CodeOutput = { kind: 'text'; text: string } | { kind: 'json'; data: unknown }

const DEFAULT_TIMEOUT_MS = 10_000

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
 * 代码节点不是通用浏览器脚本入口。先在 UI 侧阻止常见的网络、模块和非确定性 API，
 * Worker 内还会再次封锁运行时入口；CSP 是最后一层，不依赖单个正则的侥幸。
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

/**
 * 代码节点必须是本地可复跑的：不从 CDN 下载依赖，也不允许用户代码在运行期发网络请求。
 * 这里保留常用的集合/对象/日期帮助方法，名称仍为 `_` 与 `dayjs`，避免用户被迫记住
 * 一套画布私有 API；它们是轻量子集，不假装等同完整 lodash/dayjs。
 */
export const CODE_RUNTIME_OFFLINE = true

export const WORKER_SOURCE = `
const NativeDate = Date;
const compileUserFunction = Function;
const blockedRuntimeApi = () => { throw new Error('代码节点已禁用网络、模块加载与动态执行；请将数据通过输入端口传入'); };
const installDeterministicRuntime = (rawSeed) => {
  let state = (Number(rawSeed) >>> 0) || 0x6d2b79f5;
  Math.random = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [0])); }
    static now() { return 0; }
  }
  self.Date = FixedDate;
};
const _ = Object.freeze({
  get(object, path, fallback) {
    const keys = Array.isArray(path) ? path : String(path || '').replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean);
    let value = object;
    for (const key of keys) {
      if (value == null || !Object.prototype.hasOwnProperty.call(Object(value), key)) return fallback;
      value = value[key];
    }
    return value === undefined ? fallback : value;
  },
  has(object, path) { return this.get(object, path, Symbol.for('missing')) !== Symbol.for('missing'); },
  pick(object, keys) { return Object.fromEntries((keys || []).filter((key) => Object.prototype.hasOwnProperty.call(object || {}, key)).map((key) => [key, object[key]])); },
  omit(object, keys) { const blocked = new Set(keys || []); return Object.fromEntries(Object.entries(object || {}).filter(([key]) => !blocked.has(key))); },
  map(collection, mapper) { return Array.from(collection || []).map(mapper); },
  filter(collection, predicate) { return Array.from(collection || []).filter(predicate); },
  find(collection, predicate) { return Array.from(collection || []).find(predicate); },
  groupBy(collection, keyer) { return Array.from(collection || []).reduce((groups, value, index) => { const key = String(keyer(value, index)); (groups[key] ||= []).push(value); return groups; }, {}); },
  uniq(collection) { return [...new Set(collection || [])]; },
  chunk(collection, size = 1) { const result = []; for (let i = 0; i < (collection || []).length; i += Math.max(1, size)) result.push(collection.slice(i, i + Math.max(1, size))); return result; },
  cloneDeep(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
});
const dayjs = (input) => {
  const date = input === undefined ? new Date() : new Date(input);
  const pad = (value) => String(value).padStart(2, '0');
  const api = {
    isValid: () => !Number.isNaN(date.getTime()),
    valueOf: () => date.getTime(),
    toDate: () => new Date(date.getTime()),
    toISOString: () => date.toISOString(),
    format: (pattern = 'YYYY-MM-DD HH:mm:ss') => pattern
      .replace('YYYY', String(date.getFullYear()))
      .replace('MM', pad(date.getMonth() + 1))
      .replace('DD', pad(date.getDate()))
      .replace('HH', pad(date.getHours()))
      .replace('mm', pad(date.getMinutes()))
      .replace('ss', pad(date.getSeconds())),
    add: (amount, unit = 'millisecond') => { const next = new Date(date.getTime()); const ms = { millisecond: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000 }[unit] || 1; next.setTime(next.getTime() + amount * ms); return dayjs(next); },
    subtract: (amount, unit) => api.add(-amount, unit)
  };
  return Object.freeze(api);
};
self.fetch = blockedRuntimeApi;
self.importScripts = blockedRuntimeApi;
self.XMLHttpRequest = undefined;
self.WebSocket = undefined;
self.EventSource = undefined;
self.Function = blockedRuntimeApi;
self.eval = blockedRuntimeApi;

self.onmessage = async ({ data }) => {
  try {
    let value;
    const trimmedSource = data.source.trim();
    installDeterministicRuntime(data.seed);

    if (/^(async\\s+)?function\\s+main\\b/.test(trimmedSource)) {
      // Coze 风格：用户定义 async function main(args) { ... }
      const runner = compileUserFunction(
        'args',
        '_',
        'dayjs',
        '"use strict";\\n' + data.source + '\\n; return typeof main === "function" ? main(args) : undefined'
      );
      value = await runner(data.input, _, dayjs);
    } else {
      // 向后兼容：纯代码片段，用 input 作为参数名执行
      const fn = compileUserFunction('input', '_', 'dayjs', '"use strict";\\n' + data.source);
      value = await fn(data.input, _, dayjs);
    }

    if (value === undefined) throw new Error('代码必须 return 一个文本或 JSON 值');
    self.postMessage({ ok: true, value });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
`

function toOutput(value: unknown): CodeOutput {
  if (typeof value === 'string') return { kind: 'text', text: value }
  // 同时校验结果可 JSON 序列化，避免把函数、循环引用等不可传递值伪装为工作流输出。
  try {
    if (JSON.stringify(value) === undefined) throw new Error('不可序列化')
  } catch {
    throw new Error('代码返回值必须是可序列化的文本或 JSON 数据')
  }
  return { kind: 'json', data: value }
}

export function runCodeTransform(
  source: string,
  input: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CodeOutput> {
  if (!source.trim()) return Promise.reject(new Error('请输入要执行的代码'))
  try {
    assertCodeSourcePolicy(source)
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise((resolve, reject) => {
    const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    const worker = new Worker(url)
    let settled = false

    const cleanup = (): void => {
      worker.terminate()
      URL.revokeObjectURL(url)
    }
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(message))
    }
    const timer = window.setTimeout(() => fail(`代码执行超时（${timeoutMs / 1000} 秒）`), timeoutMs)

    worker.onmessage = (event: MessageEvent<{ ok: boolean; value?: unknown; error?: string }>) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      cleanup()
      if (!event.data.ok) {
        reject(new Error(event.data.error || '代码执行失败'))
        return
      }
      try {
        resolve(toOutput(event.data.value))
      } catch (error) {
        reject(error)
      }
    }
    worker.onerror = (event) => fail(event.message || '代码 Worker 运行失败')

    try {
      worker.postMessage({ source, input, seed: deterministicCodeSeed(source, input) })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  })
}
