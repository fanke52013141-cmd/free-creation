// 代码节点运行时：在浏览器 Worker 中执行用户编写的同步/异步转换函数。
// Worker 没有 Electron/Node API，输入仅通过结构化克隆传入；超时后会立即终止。
// 注入 lodash(_) 和 dayjs，支持 Coze 风格 async function main(args) 写法。

export type CodeOutput = { kind: 'text'; text: string } | { kind: 'json'; data: unknown }

const DEFAULT_TIMEOUT_MS = 10_000

const WORKER_SOURCE = `
// 尝试从 CDN 加载 lodash 和 dayjs（离线时静默失败，不影响基础执行）
try { importScripts('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js'); } catch(e) {}
try { importScripts('https://cdn.jsdelivr.net/npm/dayjs@1.11.13/dayjs.min.js'); } catch(e) {}

self.onmessage = async ({ data }) => {
  try {
    let value;
    const trimmedSource = data.source.trim();

    if (/^(async\\s+)?function\\s+main\\b/.test(trimmedSource)) {
      // Coze 风格：用户定义 async function main(args) { ... }
      const runner = new Function(
        'args',
        '"use strict";\\n' + data.source + '\\n; return typeof main === "function" ? main(args) : undefined'
      );
      value = await runner(data.input);
    } else {
      // 向后兼容：纯代码片段，用 input 作为参数名执行
      const fn = new Function('input', '"use strict";\\n' + data.source);
      value = await fn(data.input);
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
      worker.postMessage({ source, input })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  })
}
