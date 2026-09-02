// Headless 代码节点运行时（契约规范 P3）
//
// 在 Node.js vm 沙箱中执行用户编写的同步/异步转换函数，行为等价于 renderer 的
// Web Worker 实现（src/renderer/src/engine/codeRuntime.ts）：
//   - 禁用网络、模块加载和动态执行
//   - 注入确定性运行时（种子随机数、固定时钟）
//   - 提供离线工具库 _（lodash 子集）和 dayjs（dayjs 子集）
//   - 支持 Coze 风格 async function main(args) 和旧版纯代码片段
//   - 超时保护
import vm from 'node:vm'
import {
  assertCodeSourcePolicy,
  deterministicCodeSeed,
  validateCodeOutput,
  type CodeOutput
} from '@shared/engine/code-runtime'

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * vm 沙箱初始化源码。在隔离上下文中设置确定性运行时、离线工具库和 API 封锁。
 * 用户源码和参数通过沙箱变量 __source / __args / __seed 传入，不嵌入源码字符串。
 */
const SANDBOX_BOOTSTRAP = `
(async () => {
  "use strict";
  const NativeDate = Date;
  const compileUserFunction = Function;
  const blockedRuntimeApi = () => { throw new Error('代码节点已禁用网络、模块加载与动态执行；请将数据通过输入端口传入'); };

  // ── 确定性运行时 ──
  let state = (__seed >>> 0) || 0x6d2b79f5;
  Math.random = () => {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [0])); }
    static now() { return 0; }
  }
  globalThis.Date = FixedDate;

  // ── 离线工具库 ──
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
    has(object, path) { return _.get(object, path, Symbol.for('missing')) !== Symbol.for('missing'); },
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
    const date = input === undefined ? new NativeDate() : new NativeDate(input);
    const pad = (value) => String(value).padStart(2, '0');
    const api = {
      isValid: () => !Number.isNaN(date.getTime()),
      valueOf: () => date.getTime(),
      toDate: () => new NativeDate(date.getTime()),
      toISOString: () => date.toISOString(),
      format: (pattern = 'YYYY-MM-DD HH:mm:ss') => pattern
        .replace('YYYY', String(date.getFullYear()))
        .replace('MM', pad(date.getMonth() + 1))
        .replace('DD', pad(date.getDate()))
        .replace('HH', pad(date.getHours()))
        .replace('mm', pad(date.getMinutes()))
        .replace('ss', pad(date.getSeconds())),
      add: (amount, unit = 'millisecond') => { const next = new NativeDate(date.getTime()); const ms = { millisecond: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000 }[unit] || 1; next.setTime(next.getTime() + amount * ms); return dayjs(next); },
      subtract: (amount, unit) => api.add(-amount, unit)
    };
    return Object.freeze(api);
  };

  // ── API 封锁 ──
  globalThis.fetch = blockedRuntimeApi;
  globalThis.Function = blockedRuntimeApi;
  globalThis.eval = blockedRuntimeApi;
  globalThis.setTimeout = blockedRuntimeApi;
  globalThis.setInterval = blockedRuntimeApi;
  globalThis.setImmediate = blockedRuntimeApi;
  globalThis.process = undefined;
  globalThis.require = undefined;
  globalThis.global = undefined;
  globalThis.Buffer = undefined;

  // ── 编译并执行用户代码 ──
  const isMain = /^(async\\s+)?function\\s+main\\b/.test(__source.trim());
  const fn = isMain
    ? compileUserFunction('args', '_', 'dayjs', '"use strict";\\n' + __source + '\\n; return typeof main === "function" ? main(args) : undefined')
    : compileUserFunction('input', '_', 'dayjs', '"use strict";\\n' + __source);
  return isMain ? fn(__args, _, dayjs) : fn(__args, _, dayjs);
})()
`

/**
 * Headless 代码执行入口。在 Node.js vm 沙箱中运行用户代码，等价于 renderer 的
 * runCodeTransform（Web Worker 实现）。
 */
export async function runCodeHeadless(
  source: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CodeOutput> {
  if (!source.trim()) throw new Error('请输入要执行的代码')
  assertCodeSourcePolicy(source)

  const seed = deterministicCodeSeed(source, args)
  const sandbox = { __source: source, __args: args, __seed: seed }

  const promise = vm.runInNewContext(SANDBOX_BOOTSTRAP, sandbox, {
    timeout: timeoutMs,
    displayErrors: true,
    filename: 'code-node.vm'
  }) as Promise<unknown>

  const value = await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`代码执行超时（${timeoutMs / 1000} 秒）`)),
        timeoutMs
      )
      timer.unref?.()
    })
  ])

  if (value === undefined) throw new Error('代码必须 return 一个文本或 JSON 值')
  return validateCodeOutput(value)
}
