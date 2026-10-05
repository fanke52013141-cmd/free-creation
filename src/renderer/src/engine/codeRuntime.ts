// 代码节点运行时（renderer / Web Worker 实现）：在浏览器 Worker 中执行用户编写的
// 同步/异步转换函数。Worker 没有 Electron/Node API，输入仅通过结构化克隆传入；
// 超时后会立即终止。注入本地、固定版本的轻量工具库，支持 Coze 风格
// async function main(args) 写法。
//
// 公共逻辑（策略检查、确定性种子、输出验证）已提取到 @shared/engine/code-runtime。
// 当前仅提供 renderer Worker 实现；headless 对接已下线。

export type { CodeOutput } from '@shared/engine/code-runtime'
export {
  CODE_RUNTIME_POLICY,
  assertCodeSourcePolicy,
  deterministicCodeSeed
} from '@shared/engine/code-runtime'
export { validateCodeOutput } from '@shared/engine/code-runtime'

import {
  assertCodeSourcePolicy,
  deterministicCodeSeed,
  validateCodeOutput
} from '@shared/engine/code-runtime'

const DEFAULT_TIMEOUT_MS = 10_000

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
      .replace('YYYY', String(date.getUTCFullYear()))
      .replace('MM', pad(date.getUTCMonth() + 1))
      .replace('DD', pad(date.getUTCDate()))
      .replace('HH', pad(date.getUTCHours()))
      .replace('mm', pad(date.getUTCMinutes()))
      .replace('ss', pad(date.getUTCSeconds())),
    add: (amount, unit = 'millisecond') => {
      if (!Number.isFinite(amount)) throw new Error('日期增量必须是有限数字');
      const next = new Date(date.getTime());
      const aliases = { ms: 'millisecond', s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week', M: 'month', Q: 'quarter', y: 'year' };
      const normalized = aliases[unit] || String(unit).toLowerCase().replace(/s$/, '');
      const units = { millisecond: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };
      if (Object.prototype.hasOwnProperty.call(units, normalized)) next.setTime(next.getTime() + amount * units[normalized]);
      else if (['month', 'quarter', 'year'].includes(normalized)) {
        const originalDay = next.getUTCDate();
        next.setUTCDate(1);
        next.setUTCMonth(next.getUTCMonth() + amount * (normalized === 'year' ? 12 : normalized === 'quarter' ? 3 : 1));
        const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
        next.setUTCDate(Math.min(originalDay, last));
      } else throw new Error('不支持的日期单位：' + unit);
      return dayjs(next);
    },
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

// console 输出捕获：桌面端没有可打开的开发者工具，用户在代码里 console.log 的内容
// 必须带回界面，否则唯一的调试手段就断了。上限防止死循环日志撑爆结构化克隆。
const capturedLogs = [];
const formatLogArg = (value) => {
  if (typeof value === 'string') return value;
  try { const text = JSON.stringify(value); return text === undefined ? String(value) : text; }
  catch { return String(value); }
};
const captureConsole = (level) => (...args) => {
  if (capturedLogs.length >= 50) return;
  const line = args.map(formatLogArg).join(' ').slice(0, 500);
  capturedLogs.push(level === 'log' ? line : '[' + level + '] ' + line);
};
self.console = {
  log: captureConsole('log'),
  info: captureConsole('info'),
  warn: captureConsole('warn'),
  error: captureConsole('error'),
  debug: captureConsole('log')
};

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
    self.postMessage({ ok: true, value, logs: capturedLogs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 用户函数体第 1 行是 "use strict"; 前缀，堆栈行号比源码大 1。
    // 折算出行号让用户直接定位出错代码；解析失败就不加，不误导。
    let lineHint = '';
    if (error instanceof Error && error.stack) {
      const match = /<anonymous>:(\\d+):\\d+/.exec(error.stack);
      if (match) {
        const line = Number(match[1]) - 1;
        if (line >= 1) lineHint = '（第 ' + line + ' 行附近）';
      }
    }
    self.postMessage({
      ok: false,
      error: message + lineHint,
      logs: capturedLogs
    });
  }
}
`

/** 一次代码运行的完整结果：返回值归类 + 捕获的 console 输出（供界面显示调试信息）。 */
export type CodeRunResult =
  | { kind: 'text'; text: string; logs: string[] }
  | { kind: 'json'; data: unknown; logs: string[] }

/** 错误也带上已捕获的 console 输出：失败代码的调试信息同样有价值。 */
export class CodeRunError extends Error {
  logs: string[]
  constructor(message: string, logs: string[] = []) {
    super(message)
    this.logs = logs
  }
}

export function runCodeTransform(
  source: string,
  input: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CodeRunResult> {
  if (!source.trim()) return Promise.reject(new CodeRunError('请输入要执行的代码'))
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
    const fail = (message: string, logs: string[] = []): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new CodeRunError(message, logs))
    }
    const timer = window.setTimeout(() => fail(`代码执行超时（${timeoutMs / 1000} 秒）`), timeoutMs)

    worker.onmessage = (event: MessageEvent<{
      ok: boolean
      value?: unknown
      error?: string
      logs?: string[]
    }>) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      cleanup()
      const logs = Array.isArray(event.data.logs) ? event.data.logs : []
      if (!event.data.ok) {
        reject(new CodeRunError(event.data.error || '代码执行失败', logs))
        return
      }
      try {
        const output = validateCodeOutput(event.data.value)
        resolve(
          output.kind === 'text'
            ? { kind: 'text', text: output.text, logs }
            : { kind: 'json', data: output.data, logs }
        )
      } catch (error) {
        reject(new CodeRunError(error instanceof Error ? error.message : String(error), logs))
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
