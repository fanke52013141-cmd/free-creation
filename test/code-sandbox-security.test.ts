import { describe, expect, it } from 'vitest'
import vm from 'node:vm'
import { WORKER_SOURCE } from '../src/renderer/src/engine/codeRuntime'
import {
  CODE_OUTPUT_MAX_BYTES,
  assertCodeSourcePolicy,
  validateCodeOutput
} from '../src/shared/engine/code-runtime'

async function runInSimulatedWorker(
  source: string,
  input: Record<string, unknown> = {}
): Promise<{ ok: boolean; value?: unknown; error?: string; logs?: string[] }> {
  let reply: { ok: boolean; value?: unknown; error?: string; logs?: string[] } | null = null
  const proto = {
    fetch: () => 'LEAKED_FETCH',
    importScripts: () => 'LEAKED_IMPORT',
    XMLHttpRequest: class {},
    WebSocket: class {},
    EventSource: class {},
    BroadcastChannel: class {},
    indexedDB: { open: () => 'LEAKED_IDB' },
    caches: { open: () => 'LEAKED_CACHE' },
    Worker: class {},
    SharedWorker: class {},
    MessageChannel: class {},
    navigator: { sendBeacon: () => 'LEAKED_BEACON' },
    crypto: { randomUUID: () => 'LEAKED_CRYPTO' },
    performance: { now: () => 12345 },
    close: () => {}
  }
  const selfObj: Record<string, unknown> = Object.create(proto)
  selfObj.postMessage = (msg: { ok: boolean; value?: unknown; error?: string; logs?: string[] }) => {
    reply = msg
  }
  selfObj.self = selfObj
  const context = vm.createContext(selfObj)
  vm.runInContext(WORKER_SOURCE, context, { timeout: 2000 })
  const onmessage = selfObj.onmessage as (ev: { data: unknown }) => Promise<void>
  await onmessage({ data: { source, input, seed: 42 } })
  if (!reply) throw new Error('WORKER_DID_NOT_REPLY')
  return reply
}

describe('code node sandbox security hardening', () => {
  it('blocks constructor.constructor and async/generator constructor escape attempts', async () => {
    const r1 = await runInSimulatedWorker('const F = (() => {})["con" + "structor"]; return F("return 1")()')
    expect(r1.ok).toBe(false)
    expect(r1.error).toContain('已禁用')

    const r2 = await runInSimulatedWorker(
      'async function main() { const AF = (async () => {})["con" + "structor"]; return await AF("return 1")(); }'
    )
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('已禁用')

    const r3 = await runInSimulatedWorker(
      'const GF = (function* () {})["con" + "structor"]; return GF("yield 1")().next().value'
    )
    expect(r3.ok).toBe(false)
    expect(r3.error).toContain('已禁用')

    const r4 = await runInSimulatedWorker(
      'async function main() { const AGF = (async function* () {})["con" + "structor"]; return AGF("yield 1")(); }'
    )
    expect(r4.ok).toBe(false)
    expect(r4.error).toContain('已禁用')
  })

  it('blocks prototype deletion bypass for fetch/WebSocket/BroadcastChannel/indexedDB/caches/Worker/postMessage', async () => {
    const rFetch = await runInSimulatedWorker(
      'try { delete self.fetch } catch {}; return self["fe" + "tch"]("https://example.invalid")'
    )
    expect(rFetch.ok).toBe(false)

    const rStorage = await runInSimulatedWorker(
      'return { idb: typeof self.indexedDB, bc: typeof self.BroadcastChannel, cache: typeof self.caches, worker: typeof self.Worker, nav: typeof self.navigator }'
    )
    expect(rStorage.ok).toBe(true)
    expect(rStorage.value).toEqual({
      idb: 'undefined',
      bc: 'undefined',
      cache: 'undefined',
      worker: 'undefined',
      nav: 'undefined'
    })

    const rSpoofPost = await runInSimulatedWorker('self.postMessage({ ok: true, value: "spoofed" }); return "real"')
    expect(rSpoofPost.ok).toBe(false)
    expect(rSpoofPost.error).toContain('已禁用')
  })

  it('enforces 2 MiB output ceiling in both Worker and validateCodeOutput', async () => {
    const oversized = 'x'.repeat(CODE_OUTPUT_MAX_BYTES + 64)
    expect(() => validateCodeOutput(oversized)).toThrow('2 MiB')

    const rBig = await runInSimulatedWorker('return "x".repeat(2 * 1024 * 1024 + 10)')
    expect(rBig.ok).toBe(false)
    expect(rBig.error).toContain('2 MiB')
  })

  it('preserves normal Coze-style main(args), lodash subset, dayjs, and deterministic Math.random', async () => {
    const src = `
      async function main(args) {
        console.log('hi', args.name);
        return {
          picked: _.pick(args, ['name']),
          day: dayjs(0).format('YYYY-MM-DD'),
          rand: Math.random()
        };
      }
    `
    expect(() => assertCodeSourcePolicy(src)).not.toThrow()
    const a = await runInSimulatedWorker(src, { name: 'canvas', extra: 1 })
    const b = await runInSimulatedWorker(src, { name: 'canvas', extra: 1 })
    expect(a.ok).toBe(true)
    expect(a.value).toEqual(b.value)
    expect(a.logs).toEqual(['hi canvas'])
  })
})
