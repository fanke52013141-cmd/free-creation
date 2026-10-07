// W1 自动重试助手单元测试。
// 覆盖 parseRetryConfig 钳制、isRetryableError 分类、withRetry 的成功/耗尽/取消/
// 聚合语义。退避用 backoffMs: 1（助手本身不钳制，钳制发生在 parseRetryConfig），
// 每次重试的真实等待约 100ms（backoffDelay 的 100ms 轮询粒度），保持测试快速。
import { describe, it, expect } from 'vitest'
import {
  parseRetryConfig,
  isRetryableError,
  withRetry,
  backoffDelay
} from '@shared/engine/retry'

describe('parseRetryConfig · 解析与钳制', () => {
  it('缺省 / 非对象输入 → 关闭重试（maxRetries 0）', () => {
    expect(parseRetryConfig(undefined)).toEqual({ maxRetries: 0, backoffMs: 2000 })
    expect(parseRetryConfig('string')).toEqual({ maxRetries: 0, backoffMs: 2000 })
    expect(parseRetryConfig({})).toEqual({ maxRetries: 0, backoffMs: 2000 })
  })

  it('maxRetries 钳制 0–5，backoffMs 钳制 500–30000', () => {
    expect(parseRetryConfig({ retry: { maxRetries: 99, backoffMs: 1 } })).toEqual({
      maxRetries: 5,
      backoffMs: 500
    })
    expect(parseRetryConfig({ retry: { maxRetries: -3, backoffMs: 999999 } })).toEqual({
      maxRetries: 0,
      backoffMs: 30000
    })
    expect(parseRetryConfig({ retry: { maxRetries: 3, backoffMs: 'x' } })).toEqual({
      maxRetries: 3,
      backoffMs: 2000
    })
  })
})

describe('isRetryableError · 分类', () => {
  it('模型随机性输出 → 可重试', () => {
    expect(isRetryableError('模型返回为空')).toBe(true)
    expect(isRetryableError('模型返回的不是合法 JSON')).toBe(true)
    expect(isRetryableError('JSON 不符合 json.any@1：根值必须是对象')).toBe(true)
  })

  it('供应商 / 网络瞬时故障 → 可重试', () => {
    expect(isRetryableError('Generation failed: task processing failed')).toBe(true)
    expect(isRetryableError('request timeout after 30s')).toBe(true)
    expect(isRetryableError('fetch failed')).toBe(true)
    expect(isRetryableError('HTTP 502 Bad Gateway')).toBe(true)
    expect(isRetryableError('rate limit exceeded, retry later')).toBe(true)
  })

  it('配置 / 契约 / 取消类 → 不可重试（即使文本看起来像失败）', () => {
    expect(isRetryableError('JSON 输出模式必须选择输出 Schema')).toBe(false)
    expect(isRetryableError('功能 image.generate 尚未绑定已验证图片模型')).toBe(false)
    expect(isRetryableError('已取消')).toBe(false)
    expect(isRetryableError('无提示词')).toBe(false)
    expect(isRetryableError('输入契约校验失败：连线 x 的上游未产生 out-json 输出')).toBe(false)
    expect(isRetryableError('当前模型不支持已连接的参考素材组合')).toBe(false)
  })

  it('未知错误 → 默认不重试（可预期性优先）', () => {
    expect(isRetryableError('Something completely unexpected')).toBe(false)
  })
})

describe('withRetry · 重试语义', () => {
  it('首次成功 → 只调用一次', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls += 1
        return 'ok'
      },
      { retry: { maxRetries: 3, backoffMs: 1 }, signal: { cancelled: false } }
    )
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  it('失败后重试成功 → 调用次数 = 失败次数 + 1', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls += 1
        if (calls < 3) throw new Error('模型返回为空')
        return 'ok'
      },
      { retry: { maxRetries: 3, backoffMs: 1 }, signal: { cancelled: false } }
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('重试耗尽 → 抛最后一次错误并聚合此前原因', async () => {
    let calls = 0
    const promise = withRetry(
      async () => {
        calls += 1
        throw new Error(calls === 1 ? 'fetch failed' : '模型返回为空')
      },
      { retry: { maxRetries: 1, backoffMs: 1 }, signal: { cancelled: false } }
    )
    await expect(promise).rejects.toThrow(/模型返回为空/)
    expect(calls).toBe(2)
  })

  it('不可重试错误 → 立即失败且只调用一次', async () => {
    let calls = 0
    const promise = withRetry(
      async () => {
        calls += 1
        throw new Error('JSON 输出模式必须选择输出 Schema')
      },
      { retry: { maxRetries: 5, backoffMs: 1 }, signal: { cancelled: false } }
    )
    await expect(promise).rejects.toThrow('JSON 输出模式必须选择输出 Schema')
    expect(calls).toBe(1)
  })

  it('退避等待中取消 → 以「已取消」抛出，不再发起下一轮', async () => {
    let calls = 0
    const signal = { cancelled: false }
    const promise = withRetry(
      async () => {
        calls += 1
        throw new Error('模型返回为空')
      },
      {
        retry: { maxRetries: 5, backoffMs: 10000 },
        signal,
        onRetry: () => {
          // 首次重试进入退避后立刻取消
          signal.cancelled = true
        }
      }
    )
    await expect(promise).rejects.toThrow('已取消')
    expect(calls).toBe(1)
  })

  it('调用前已取消 → 直接以「已取消」抛出', async () => {
    let calls = 0
    const promise = withRetry(
      async () => {
        calls += 1
        return 'ok'
      },
      { retry: { maxRetries: 3, backoffMs: 1 }, signal: { cancelled: true } }
    )
    await expect(promise).rejects.toThrow('已取消')
    expect(calls).toBe(0)
  })

  it('backoffDelay 在取消信号置位后立即拒绝', async () => {
    const signal = { cancelled: false }
    const promise = backoffDelay(10000, signal)
    setTimeout(() => {
      signal.cancelled = true
    }, 20)
    await expect(promise).rejects.toThrow('已取消')
  })
})
