import type { LocalMediaCapabilities } from '../contracts'
import type { GatewayClient } from './gateway-client'

export type LocalCapabilityKey = keyof LocalMediaCapabilities

/**
 * 执行前检查本机媒体能力。
 *
 * 旧版 headless/单元测试 Gateway 可能没有能力探测方法，视为“由实际调用负责报错”；
 * 生产 renderer/main 实现必须提供该方法，缺失工具时在真正启动 FFmpeg 前给出稳定提示。
 */
export async function unavailableLocalCapability(
  gateway: GatewayClient,
  key: LocalCapabilityKey
): Promise<string | null> {
  if (!gateway.getLocalMediaCapabilities) return null
  try {
    const result = await gateway.getLocalMediaCapabilities()
    if (!result.ok) return result.error.message
    const capability = result.data[key]
    return capability.available ? null : capability.message || `${key} 不可用`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function capabilityFailure(key: LocalCapabilityKey, reason: string): string {
  const labels: Record<LocalCapabilityKey, string> = {
    ffmpeg: 'FFmpeg',
    ffprobe: 'FFprobe',
    audioSeparator: '人声分离工具'
  }
  return `${labels[key]}能力不可用：${reason}`
}
