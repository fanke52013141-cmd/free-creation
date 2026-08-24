// 图片生成链路：generateImage（OpenAI Images 兼容端点，中转站直接可用）
// → 产物 Buffer 走 media 管线入库，节点侧拿到 MediaAsset 即可展示
// P1: 支持 referenceMediaId 参考图（图生图），通过 providerOptions 传递 data URL
import { generateImage } from 'ai'
import type { ImageGenerateInput } from '../../shared/contracts'
import type { MediaAsset } from '../../shared/types'
import { readMediaBuffer, saveBufferAsset } from '../store/media.repo'
import { createImageModel, GatewayError } from './factory'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

/** 将图库 media 转为 data URL（供图生图场景使用） */
async function mediaToDataUrl(mediaId: string): Promise<string> {
  const m = await readMediaBuffer(mediaId)
  if (!m) throw new GatewayError('MEDIA_NOT_FOUND', `参考图不存在：${mediaId}`)
  return `data:${m.mime};base64,${m.buf.toString('base64')}`
}

export async function generateImageToAsset(input: ImageGenerateInput): Promise<MediaAsset> {
  if (!input.prompt?.trim()) throw new GatewayError('INVALID_INPUT', '提示词不能为空')

  // 参考图处理：读取图库 media → data URL → 通过 providerOptions 传递
  let referenceImageUrl: string | undefined
  if (input.referenceMediaId) {
    referenceImageUrl = await mediaToDataUrl(input.referenceMediaId)
  }

  const { images } = await generateImage({
    model: createImageModel(input.providerId, input.modelId),
    prompt: input.prompt.trim(),
    ...(input.size && input.size !== 'auto' ? { size: input.size as `${number}x${number}` } : {}),
    ...(referenceImageUrl
      ? {
          providerOptions: {
            // OpenAI Images API 的 image 参数（图生图），兼容多数中转站
            image: referenceImageUrl
          }
        }
      : {})
  })
  if (!images?.length) throw new GatewayError('EMPTY_RESULT', '模型未返回图片')

  const img = images[0]
  const ext = EXT_BY_MIME[img.mediaType] ?? '.png'
  return saveBufferAsset(
    input.projectId,
    Buffer.from(img.uint8Array),
    ext,
    input.prompt.trim().slice(0, 24)
  )
}
