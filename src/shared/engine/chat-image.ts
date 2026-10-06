import {
  chatImageParameters,
  parseChatImageSkill,
  type ChatImageSkillTarget
} from '../chat-image-skill'
import type { ChatData } from './chat-data'
import type { NodeExecutionContext } from './executor-types'
import type { ModelOption } from './models'
import { resolveFeatureOption } from './models'

export async function resolveChatImageTarget(
  ctx: NodeExecutionContext,
  data: ChatData
): Promise<{
  target: ChatImageSkillTarget
  option: ModelOption
} | null> {
  const settings = parseChatImageSkill(data.imageSkill)
  if (!settings.enabled) return null
  if (
    !ctx.providers.some((provider) => provider.models.some((model) => model.modality === 'image'))
  )
    return null
  if (
    settings.modelKey &&
    !ctx.providers.some((provider) =>
      provider.models.some(
        (model) => `${provider.id}::${model.id}` === settings.modelKey && model.modality === 'image'
      )
    )
  ) {
    return null
  }
  const option = await resolveFeatureOption(
    ctx.gateway,
    ctx.providers,
    'image.generate',
    'image.generate',
    settings.modelKey
  )
  if (!option || option.model.modality !== 'image') return null
  return {
    option,
    target: {
      projectId: ctx.projectId,
      providerId: option.provider.id,
      modelId: option.model.id,
      resolution: settings.resolution
    }
  }
}

export function chatImageInput(
  target: ChatImageSkillTarget,
  option: ModelOption,
  prompt: string
): import('../contracts').ImageGenerateInput {
  return {
    projectId: target.projectId,
    providerId: target.providerId,
    modelId: target.modelId,
    prompt,
    ...chatImageParameters(option.provider.specId, target.modelId, target.resolution)
  }
}
