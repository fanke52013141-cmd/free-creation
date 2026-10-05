import { afterEach, expect, it, vi } from 'vitest'
const resolveFeatureOption = vi.hoisted(() => vi.fn())
vi.mock('../src/shared/engine/models', () => ({ resolveFeatureOption }))
vi.mock('../src/renderer/src/engine/rendererGateway', () => ({ rendererGateway: {} }))
import {
  checkModelAvailability,
  providerAvailabilityKey
} from '../src/renderer/src/canvas/model-availability'
import type { ProviderSummary } from '../src/shared/types'
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})
it('相同供应商内容共享在途检查，完成后允许刷新功能绑定', async () => {
  const providers = [
    { id: 'p', baseURL: 'https://example.invalid', specId: 'relay', hasApiKey: true, models: [] }
  ] as unknown as ProviderSummary[]
  const copy = JSON.parse(JSON.stringify(providers)) as ProviderSummary[]
  expect(providerAvailabilityKey(providers)).toBe(providerAvailabilityKey(copy))
  let finish!: (value: unknown) => void
  resolveFeatureOption.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const first = checkModelAvailability(providers, 'review.feature', 'text.generate')
  const second = checkModelAvailability(copy, 'review.feature', 'text.generate')
  expect(resolveFeatureOption).toHaveBeenCalledTimes(1)
  finish({ key: 'available' })
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  resolveFeatureOption.mockResolvedValue(null)
  expect(await checkModelAvailability(copy, 'review.feature', 'text.generate')).toBe(false)
  expect(resolveFeatureOption).toHaveBeenCalledTimes(2)
})
it('挂起的模型检查十秒结束并可重试', async () => {
  vi.useFakeTimers()
  resolveFeatureOption.mockImplementation(() => new Promise(() => {}))
  const pending = checkModelAvailability([], 'review.timeout', 'text.generate')
  await vi.advanceTimersByTimeAsync(10000)
  expect(await pending).toBe(false)
})
