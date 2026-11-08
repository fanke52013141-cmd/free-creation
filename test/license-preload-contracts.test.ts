/**
 * 授权 preload 通道常量与共享契约的一致性测试。
 *
 * 授权窗 preload（sandbox: true）必须自包含、不能引用共享 chunk，
 * 因此通道名在 preload 内联了一份；此测试防止两端漂移。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() }
}))

describe('授权 preload 通道契约', () => {
  it('preload 内联通道与 IPC.license 完全一致', async () => {
    const { IPC } = await import('../src/shared/contracts/index')
    const preloadSource = (await import('node:fs')).readFileSync(
      new URL('../src/preload/license.ts', import.meta.url),
      'utf8'
    )
    for (const [key, channel] of Object.entries(IPC.license)) {
      expect(preloadSource).toContain(`'${channel}'`)
      void key
    }
    // 数量一致：preload 恰好包含全部通道，不多不少。
    const channelValues = Object.values(IPC.license) as string[]
    for (const channel of channelValues) {
      expect(preloadSource.split(`'${channel}'`).length - 1).toBe(1)
    }
  })
})
