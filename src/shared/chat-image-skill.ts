import { imageCapabilitiesFor } from './image-capabilities'
import type { ProviderSpecId } from './types'

export interface ChatImageSkillSettings {
  enabled: boolean
  modelKey: string
  resolution: '1k' | '4k'
}

export interface ChatImageSkillTarget {
  projectId: string
  providerId: string
  modelId: string
  resolution: '1k' | '4k'
}

export function parseChatImageSkill(value: unknown): ChatImageSkillSettings {
  const item = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    enabled: item.enabled !== false,
    modelKey: typeof item.modelKey === 'string' ? item.modelKey : '',
    resolution: item.resolution === '4k' ? '4k' : '1k'
  }
}

/** Closed parameters: the model may supply a prompt, never credentials, target or quality. */
export function chatImageParameters(
  specId: ProviderSpecId,
  modelId: string,
  resolution: '1k' | '4k'
): {
  size: string
  resolution?: '1k' | '4k'
} {
  const caps = imageCapabilitiesFor(specId, modelId)
  const lowQuality =
    caps.supportsQuality ||
    (caps.driver === 'toapis-task' &&
      (modelId === 'gpt-image-2-vip' || modelId === 'gpt-image-2-official'))
  if (!lowQuality) throw new Error('此图片模型尚未验证最低质量设置，请选择支持 low 质量的模型')
  if (caps.resolutions.includes(resolution)) return { size: '1:1', resolution }
  if (resolution === '1k' && caps.sizeOptions.some((item) => item.value === '1024x1024')) {
    return { size: '1024x1024' }
  }
  throw new Error(`此图片模型不支持 ${resolution.toUpperCase()}，请更换模型或分辨率`)
}
