import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { tool, type Tool } from 'ai'
import { z } from 'zod'
import type { ChatImageSkillTarget } from '../../shared/chat-image-skill'
import { chatImageParameters } from '../../shared/chat-image-skill'
import type { ChatImageAttachment } from '../../shared/types'
import type { GatewayDiagnosticsContext } from '../../shared/contracts'
import { generateImageToAsset } from './image'
import { requireProvider, GatewayError } from './factory'
import { nanoid } from 'nanoid'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { redactDiagnosticText } from '../../shared/diagnostics'

export function loadImageSkillInstructions(): string {
  // Built-in only: no arbitrary paths, scripts, environment variables or API keys in skills.
  return readFileSync(join(app.getAppPath(), 'resources/skills/image-generation/SKILL.md'), 'utf8')
}

export function createChatImageTool(
  target: ChatImageSkillTarget,
  diagnostics: GatewayDiagnosticsContext | undefined,
  signal: AbortSignal,
  onImage: (image: ChatImageAttachment) => void
): Tool<
  { prompt: string },
  { generated: boolean; name: string; resolution: '1k' | '4k'; quality: string }
> {
  let submitted = false
  return tool({
    description: '按用户明确的绘图要求生成一张图片，结果直接显示在对话中。',
    inputSchema: z.object({ prompt: z.string().trim().min(1).max(32000) }),
    execute: async ({ prompt }) => {
      signal.throwIfAborted()
      if (submitted) throw new GatewayError('SKILL_LIMIT', '本轮已调用生图，请发送新消息后再生成')
      const provider = requireProvider(target.providerId)
      const model = provider.models.find(
        (item) => item.id === target.modelId && item.modality === 'image'
      )
      if (!model || (model.operations && !model.operations.includes('image.generate'))) {
        throw new GatewayError('INVALID_INPUT', '图片模型不可用或未验证生图能力')
      }
      if (!target.projectId || !['1k', '4k'].includes(target.resolution)) {
        throw new GatewayError('INVALID_INPUT', '生图项目或分辨率不合法')
      }
      const parameters = chatImageParameters(provider.specId, model.id, target.resolution)
      submitted = true
      const context = {
        ...diagnostics,
        requestId: undefined,
        spanId: nanoid(10),
        parentSpanId: diagnostics?.spanId
      }
      const attributes = {
        skillId: 'image-generation',
        operation: 'image.generate',
        providerId: target.providerId,
        modelId: target.modelId
      }
      emitGatewayEvent('skill.execution.started', '对话生图技能开始', context, { attributes })
      try {
        const asset = await generateImageToAsset({
          ...target,
          ...parameters,
          prompt,
          diagnostics: context
        })
        const image = {
          mediaId: asset.id,
          mediaPath: asset.path,
          name: asset.name || '生成图片',
          mime: asset.mime
        }
        onImage(image)
        emitGatewayEvent('skill.execution.completed', '对话生图技能完成，图片已保存', context, {
          status: 'success',
          attributes: { ...attributes, mediaId: image.mediaId }
        })
        return { generated: true, name: image.name, resolution: target.resolution, quality: 'low' }
      } catch (error) {
        emitGatewayEvent('skill.execution.failed', '对话生图技能失败', context, {
          status: 'failed',
          error,
          attributes,
          privateValues: [prompt]
        })
        throw new GatewayError(
          error instanceof GatewayError ? error.code : 'SKILL_FAILED',
          redactDiagnosticText(error instanceof Error ? error.message : String(error), 500, [
            prompt
          ])
        )
      }
    }
  })
}
