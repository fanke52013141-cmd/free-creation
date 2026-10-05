import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { waitForVideo } from '../src/shared/engine/helpers'
import type { GatewayClient } from '../src/shared/engine/gateway-client'
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
it('慢查询不重入，取消后忽略迟到成功且捕获取消失败', async () => {
  let finish!: (value: unknown) => void
  const videoTask = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const videoCancel = vi.fn().mockRejectedValue(new Error('IPC disconnected'))
  const signal = { cancelled: false }
  const pending = waitForVideo(
    { videoTask, videoCancel } as unknown as GatewayClient,
    'task',
    signal
  )
  const rejected = expect(pending).rejects.toThrow('已取消')
  await vi.advanceTimersByTimeAsync(12000)
  expect(videoTask).toHaveBeenCalledTimes(1)
  signal.cancelled = true
  await vi.advanceTimersByTimeAsync(3000)
  await rejected
  finish({ ok: true, data: { status: 'success', mediaPath: 'late' } })
  await vi.advanceTimersByTimeAsync(3000)
  expect(videoTask).toHaveBeenCalledTimes(1)
  expect(videoCancel).toHaveBeenCalledTimes(1)
})
it('连续三次查询 rejection 有界失败，无悬挂计时器', async () => {
  const videoTask = vi.fn().mockRejectedValue(new Error('IPC unavailable'))
  const videoCancel = vi.fn().mockResolvedValue({ ok: true })
  const pending = waitForVideo({ videoTask, videoCancel } as unknown as GatewayClient, 'task', {
    cancelled: false
  })
  const rejected = expect(pending).rejects.toThrow('连续查询失败')
  await vi.advanceTimersByTimeAsync(9000)
  await rejected
  expect(videoTask).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)
})
