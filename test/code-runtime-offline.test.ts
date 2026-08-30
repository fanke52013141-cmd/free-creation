import { describe, expect, it } from 'vitest'
import {
  assertCodeSourcePolicy,
  CODE_RUNTIME_OFFLINE,
  CODE_RUNTIME_POLICY,
  deterministicCodeSeed,
  WORKER_SOURCE
} from '@renderer/engine/codeRuntime'

describe('代码节点离线运行时', () => {
  it('不再从 CDN 下载 lodash/dayjs，且在策略和 Worker 两层关闭网络/模块入口', () => {
    expect(CODE_RUNTIME_OFFLINE).toBe(true)
    expect(WORKER_SOURCE).not.toMatch(/https?:\/\//)
    expect(CODE_RUNTIME_POLICY).toMatchObject({
      network: 'disabled',
      modules: 'disabled',
      clock: 'fixed-epoch',
      random: 'seeded-from-source-and-input'
    })
    expect(WORKER_SOURCE).toContain('self.fetch = blockedRuntimeApi')
    expect(WORKER_SOURCE).toContain('self.importScripts = blockedRuntimeApi')
    expect(WORKER_SOURCE).toContain('self.EventSource = undefined')
    expect(WORKER_SOURCE).toContain('self.Function = blockedRuntimeApi')
  })

  it('保留固定的本地集合与日期帮助入口，代码无需依赖在线环境', () => {
    expect(WORKER_SOURCE).toContain('const _ = Object.freeze')
    expect(WORKER_SOURCE).toContain('groupBy')
    expect(WORKER_SOURCE).toContain('const dayjs =')
  })

  it('拒绝外部能力，且相同代码与输入的随机种子稳定', () => {
    expect(() => assertCodeSourcePolicy('return await import("https://example.com/x.js")')).toThrow(
      '模块加载'
    )
    expect(() => assertCodeSourcePolicy('return fetch("https://example.com")')).toThrow('网络访问')
    expect(() => assertCodeSourcePolicy('return performance.now()')).toThrow('非确定性')
    expect(deterministicCodeSeed('return Math.random()', { a: 1, b: 2 })).toBe(
      deterministicCodeSeed('return Math.random()', { b: 2, a: 1 })
    )
    expect(deterministicCodeSeed('return Math.random()', { a: 1 })).not.toBe(
      deterministicCodeSeed('return Math.random()', { a: 2 })
    )
  })
})
