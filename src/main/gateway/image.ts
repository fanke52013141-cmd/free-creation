// 图片生成链路：generateImage（OpenAI Images 兼容端点，中转站直接可用）
// → 产物 Buffer 走 media 管线入库，节点侧拿到 MediaAsset 即可展示
import { generateImage } from 'ai'
import type { ImageGenerateInput } from '../../shared/contracts'
import type { MediaAsset } from '../../shared/types'
import { saveBufferAsset } from '../store/media.repo'
import { createImageModel, GatewayError } from './factory'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

export async function generateImageToAsset(input: ImageGenerateInput): Promise<MediaAsset> {
  if (!input.prompt?.trim()) throw new GatewayError('INVALID_INPUT', '提示词不能为空')

  const { images } = await generateImage({
    model: createImageModel(input.providerId, input.modelId),
    prompt: input.prompt.trim(),
    ...(input.size && input.size !== 'auto' ? { size: input.size as `${number}x${number}` } : {})
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
