// 图片生成链路：generateImage（OpenAI Images 兼容端点，中转站直接可用）
// → 产物 Buffer 走 media 管线入库，节点侧拿到 MediaAsset 即可展示
// P1: 支持 referenceMediaId 参考图（图生图），通过 providerOptions 传递 data URL
import { generateImage } from 'ai'
import type { ImageEditInput, ImageGenerateInput } from '../../shared/contracts'
import { IMAGE_EDIT_SIZES } from '../../shared/image-edit'
import type { MediaAsset } from '../../shared/types'
import { readMediaBuffer, saveBufferAsset } from '../store/media.repo'
import { createImageModel, GatewayError } from './factory'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

/** 读取图库原始文件，交给 AI SDK 走 /images/edits 图生图请求。 */
async function mediaToBuffer(mediaId: string): Promise<Buffer> {
  const m = await readMediaBuffer(mediaId)
  if (!m) throw new GatewayError('MEDIA_NOT_FOUND', `参考图不存在：${mediaId}`)
  return m.buf
}

export async function generateImageToAsset(input: ImageGenerateInput): Promise<MediaAsset> {
  if (!input.prompt?.trim()) throw new GatewayError('INVALID_INPUT', '提示词不能为空')

  // OpenAI-compatible provider 对含参考图的请求会自动改走 /images/edits。
  let referenceImage: Buffer | undefined
  if (input.referenceMediaId) {
    referenceImage = await mediaToBuffer(input.referenceMediaId)
  }

  return generateImageWithReference(input, referenceImage, {
    ...(typeof input.seed === 'number' && input.seed > 0 ? { seed: input.seed } : {}),
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {})
  })
}

async function generateImageWithReference(
  input: Pick<ImageGenerateInput, 'projectId' | 'providerId' | 'modelId' | 'prompt' | 'size'>,
  referenceImage?: Buffer,
  providerOptions?: Record<string, string | number | boolean>
): Promise<MediaAsset> {
  const prompt = input.prompt.trim()
  const { images } = await generateImage({
    model: createImageModel(input.providerId, input.modelId),
    prompt: referenceImage ? { text: prompt, images: [referenceImage] } : prompt,
    ...(input.size && input.size !== 'auto' ? { size: input.size as `${number}x${number}` } : {}),
    ...(providerOptions && Object.keys(providerOptions).length > 0
      ? { providerOptions: { [input.providerId]: providerOptions } }
      : {})
  })
  if (!images?.length) throw new GatewayError('EMPTY_RESULT', '模型未返回图片')
  const img = images[0]
  return saveBufferAsset(
    input.projectId,
    Buffer.from(img.uint8Array),
    EXT_BY_MIME[img.mediaType] ?? '.png',
    prompt.slice(0, 24)
  )
}

/** 图片修改使用已渲染的标注参考图，原始图片不会被覆写。 */
export async function generateImageEditToAsset(
  input: ImageEditInput,
  referenceImage: Buffer
): Promise<MediaAsset> {
  if (!input.prompt?.trim()) throw new GatewayError('INVALID_INPUT', '修改说明不能为空')
  if (input.prompt.length > 8000) throw new GatewayError('INVALID_INPUT', '修改说明超过 8000 字')
  if (input.size && !IMAGE_EDIT_SIZES.includes(input.size as (typeof IMAGE_EDIT_SIZES)[number])) {
    throw new GatewayError('INVALID_INPUT', '图片修改尺寸不受支持')
  }
  return generateImageWithReference(input, referenceImage)
}
