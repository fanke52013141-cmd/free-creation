// 统一超时协议测试（R8 / WP3）
//
// 覆盖三个层面：
// 1. resolveTimeoutMs 分级默认 / 兜底 / 用户覆盖 / 钳制
// 2. formatTimeoutLabel 秒/分钟格式化
// 3. Promise.race 超时包裹行为（fake timers）：正常完成、超时触发、超时清理、
//    CancelSignal 联动、错误信息携带超时标签
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { resolveTimeoutMs, formatTimeoutLabel } from '../src/renderer/src/engine/timeouts'

// ─── resolveTimeoutMs ───────────────────────────────────────────

describe('resolveTimeoutMs 分级默认值', () => {
  it('短任务（chat/text/ai-process）默认 120s', () => {
    expect(resolveTimeoutMs('chat')).toBe(120_000)
    expect(resolveTimeoutMs('text')).toBe(120_000)
    expect(resolveTimeoutMs('ai-process')).toBe(120_000)
  })

  it('中等任务（image-gen/audio）默认 300s', () => {
    expect(resolveTimeoutMs('image-gen')).toBe(300_000)
    expect(resolveTimeoutMs('audio')).toBe(300_000)
  })

  it('长任务（video）默认 1800s', () => {
    expect(resolveTimeoutMs('video')).toBe(1_800_000)
  })

  it('未登记节点类型使用 120s 兜底', () => {
    expect(resolveTimeoutMs('unknown-type')).toBe(120_000)
    expect(resolveTimeoutMs('custom-node')).toBe(120_000)
    expect(resolveTimeoutMs('')).toBe(120_000)
  })
})

describe('resolveTimeoutMs 用户覆盖', () => {
  it('config.timeoutMs 优先于默认值', () => {
    expect(resolveTimeoutMs('chat', { timeoutMs: 5000 })).toBe(5000)
    expect(resolveTimeoutMs('video', { timeoutMs: 10_000 })).toBe(10_000)
  })

  it('忽略非正数的 timeoutMs，回退到默认', () => {
    expect(resolveTimeoutMs('chat', { timeoutMs: 0 })).toBe(120_000)
    expect(resolveTimeoutMs('chat', { timeoutMs: -100 })).toBe(120_000)
  })

  it('忽略非数字的 timeoutMs', () => {
    expect(resolveTimeoutMs('chat', { timeoutMs: '120' })).toBe(120_000)
    expect(resolveTimeoutMs('chat', { timeoutMs: null })).toBe(120_000)
    expect(resolveTimeoutMs('chat', { timeoutMs: undefined })).toBe(120_000)
  })

  it('config 为空或 null 时使用默认值', () => {
    expect(resolveTimeoutMs('chat', null)).toBe(120_000)
    expect(resolveTimeoutMs('chat', undefined)).toBe(120_000)
    expect(resolveTimeoutMs('chat', {})).toBe(120_000)
  })

  it('钳制到下限 1s（忽略 <1000ms 的值）', () => {
    expect(resolveTimeoutMs('chat', { timeoutMs: 500 })).toBe(1_000)
    expect(resolveTimeoutMs('chat', { timeoutMs: 1 })).toBe(1_000)
  })

  it('钳制到上限 1h（忽略 >3600000ms 的值）', () => {
    expect(resolveTimeoutMs('chat', { timeoutMs: 3_600_000 })).toBe(3_600_000)
    expect(resolveTimeoutMs('chat', { timeoutMs: 7_200_000 })).toBe(3_600_000)
  })

  it('合理范围内的值原样返回', () => {
    expect(resolveTimeoutMs('image-gen', { timeoutMs: 42_000 })).toBe(42_000)
    expect(resolveTimeoutMs('audio', { timeoutMs: 180_000 })).toBe(180_000)
  })
})

// ─── formatTimeoutLabel ─────────────────────────────────────────

describe('formatTimeoutLabel 格式化', () => {
  it('小于 60s 显示秒数（四舍五入）', () => {
    expect(formatTimeoutLabel(5_000)).toBe('5s')
    expect(formatTimeoutLabel(30_000)).toBe('30s')
    expect(formatTimeoutLabel(59_500)).toBe('60s')
  })

  it('60s 以上显示分钟+秒', () => {
    expect(formatTimeoutLabel(60_000)).toBe('1m0s')
    expect(formatTimeoutLabel(120_000)).toBe('2m0s')
    expect(formatTimeoutLabel(150_000)).toBe('2m30s')
  })

  it('整分钟不显示多余秒数', () => {
    expect(formatTimeoutLabel(300_000)).toBe('5m0s')
    expect(formatTimeoutLabel(1_800_000)).toBe('30m0s')
  })

  it('分级默认值的格式化结果符合预期', () => {
    expect(formatTimeoutLabel(resolveTimeoutMs('chat'))).toBe('2m0s')
    expect(formatTimeoutLabel(resolveTimeoutMs('image-gen'))).toBe('5m0s')
    expect(formatTimeoutLabel(resolveTimeoutMs('video'))).toBe('30m0s')
  })
})

// ─── Promise.race 超时包裹行为（fake timers） ──────────────────

/**
 * 模拟 invokeExecutor 中的超时包裹逻辑，验证：
 * - 执行器在超时前完成 → 正常返回，不触发超时
 * - 执行器超时 → reject 带超时标签的错误，并触发 CancelSignal
 * - 超时定时器在正常完成后被清理
 */
describe('超时包裹行为（Promise.race 模拟）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('执行器在超时前完成 → 正常返回结果', async () => {
    const timeoutMs = 10_000
    const token = { cancelled: false }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const slowExecutor = new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 3_000)
    })
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        token.cancelled = true
        reject(new Error(`超时（${formatTimeoutLabel(timeoutMs)}）`))
      }, timeoutMs)
    })

    const resultPromise = (async () => {
      try {
        const result = await Promise.race([slowExecutor, timeoutPromise])
        return { ok: true as const, value: result }
      } catch (error) {
        return { ok: false as const, error: (error as Error).message }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }
    })()

    // 快进 3s → 执行器先完成
    vi.advanceTimersByTime(3_000)
    const result = await resultPromise

    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toBe('done')
    expect(token.cancelled).toBe(false)
  })

  it('执行器超时 → reject 超时错误 + CancelSignal 被触发', async () => {
    const timeoutMs = 5_000
    const token = { cancelled: false }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const slowExecutor = new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 30_000) // 远超超时
    })
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        token.cancelled = true
        reject(new Error(`超时（${formatTimeoutLabel(timeoutMs)}）`))
      }, timeoutMs)
    })

    const resultPromise = (async () => {
      try {
        const result = await Promise.race([slowExecutor, timeoutPromise])
        return { ok: true as const, value: result }
      } catch (error) {
        return { ok: false as const, error: (error as Error).message }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }
    })()

    // 快进到超时点
    vi.advanceTimersByTime(5_000)
    const result = await resultPromise

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toBe('超时（5s）')
    expect(token.cancelled).toBe(true)
  })

  it('超时错误消息格式与 formatTimeoutLabel 一致', async () => {
    const testCases = [
      { ms: 120_000, expected: '超时（2m0s）' },
      { ms: 300_000, expected: '超时（5m0s）' },
      { ms: 15_000, expected: '超时（15s）' }
    ]

    for (const { ms, expected } of testCases) {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`超时（${formatTimeoutLabel(ms)}）`))
        }, ms)
      })

      const resultPromise = Promise.race([
        // 执行器永远挂起
        new Promise<string>(() => {}),
        timeoutPromise
      ]).catch((e) => (e as Error).message)

      // 快进到超时触发点
      vi.advanceTimersByTime(ms + 1)
      const msg = await resultPromise
      expect(msg).toBe(expected)

      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  })

  it('正常完成后定时器被清理（不残留回调）', async () => {
    const timeoutMs = 10_000
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let callbackFired = false

    const fastExecutor = new Promise<string>((resolve) => {
      setTimeout(() => resolve('fast'), 100)
    })
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        callbackFired = true
        reject(new Error('超时'))
      }, timeoutMs)
    })

    const resultPromise = (async () => {
      try {
        return await Promise.race([fastExecutor, timeoutPromise])
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }
    })()

    vi.advanceTimersByTime(100)
    await resultPromise

    // 快进到超时点后，回调不应触发
    vi.advanceTimersByTime(20_000)
    expect(callbackFired).toBe(false)
  })

  it('执行器内部 reject（非超时）时正确传播错误', async () => {
    const timeoutMs = 30_000
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const failingExecutor = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error('执行器内部错误')), 500)
    })
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('超时')), timeoutMs)
    })

    const resultPromise = (async () => {
      try {
        return await Promise.race([failingExecutor, timeoutPromise])
      } catch (error) {
        return (error as Error).message
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }
    })()

    vi.advanceTimersByTime(500)
    const result = await resultPromise

    expect(result).toBe('执行器内部错误')
  })
})

// ─── 错误分类验证（phase='timeout'） ────────────────────────────

describe('超时错误分类', () => {
  it('超时错误消息以"超时"开头，可被 catch 块识别为 phase=timeout', () => {
    const timeoutError = `超时（${formatTimeoutLabel(120_000)}）`
    expect(timeoutError.startsWith('超时')).toBe(true)

    const phase = timeoutError.startsWith('超时') ? 'timeout' : 'execution'
    expect(phase).toBe('timeout')
  })

  it('非超时错误不被误判为 timeout', () => {
    const inputError = '输入契约校验失败：缺少必填端口'
    expect(inputError.startsWith('超时')).toBe(false)

    const phase = inputError.startsWith('超时')
      ? 'timeout'
      : inputError.includes('输入契约')
        ? 'input'
        : 'execution'
    expect(phase).toBe('input')
  })

  it('普通执行错误归类为 execution', () => {
    const execError = '网关返回 500：服务内部错误'
    const phase = execError.startsWith('超时')
      ? 'timeout'
      : execError.includes('输入契约')
        ? 'input'
        : 'execution'
    expect(phase).toBe('execution')
  })
})
