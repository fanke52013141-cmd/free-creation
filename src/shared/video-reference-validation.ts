import { canonicalVideoModelId } from './video-capabilities'

export type VideoReferenceKind = 'image' | 'video' | 'audio'

export interface VideoReferenceAsset {
  id: string
  kind: VideoReferenceKind | string
  sizeBytes: number
}

export interface VideoReferenceAssetInput {
  id: string
  expectedKind: VideoReferenceKind
}

const MIB = 1024 * 1024

/**
 * MiniMax H3 V2 allows 30MB images, 50MB videos, 15MB audio and a 64MB request.
 * The application submits data URLs, therefore the raw-media aggregate reserves
 * envelope/base64 headroom instead of letting a nominal 64MB binary payload exceed
 * the upstream HTTP request limit after encoding.
 */
const H3_MAX_BYTES: Record<VideoReferenceKind, number> = {
  image: 30 * MIB,
  video: 50 * MIB,
  audio: 15 * MIB
}
const H3_RAW_TOTAL_BUDGET_BYTES = 46 * MIB

function supportsH3ReferenceLimits(specId: string, modelId: string): boolean {
  const model = canonicalVideoModelId(modelId)
  return specId === 'minimax' && (model === 'minimax-h3' || model === 'minimax-h3-max')
}

export function videoReferenceAssetIssues(
  specId: string,
  modelId: string,
  inputs: VideoReferenceAssetInput[],
  assetsById: ReadonlyMap<string, VideoReferenceAsset>
): string[] {
  if (!supportsH3ReferenceLimits(specId, modelId)) return []

  const issues: string[] = []
  let totalBytes = 0
  const seen = new Set<string>()
  for (const input of inputs) {
    const asset = assetsById.get(input.id)
    if (!asset) {
      issues.push(
        `参考${input.expectedKind === 'image' ? '图片' : input.expectedKind === 'video' ? '视频' : '音频'}不存在`
      )
      continue
    }
    if (asset.kind !== input.expectedKind) {
      issues.push(`参考素材 ${asset.id} 的类型不是${input.expectedKind}`)
      continue
    }
    if (seen.has(asset.id)) continue
    seen.add(asset.id)
    const maxBytes = H3_MAX_BYTES[input.expectedKind]
    if (asset.sizeBytes > maxBytes) {
      issues.push(
        `参考${input.expectedKind === 'image' ? '图片' : input.expectedKind === 'video' ? '视频' : '音频'} ${asset.id} 超过 ${maxBytes / MIB}MB 上限`
      )
    }
    totalBytes += asset.sizeBytes
  }
  if (totalBytes > H3_RAW_TOTAL_BUDGET_BYTES) {
    issues.push('MiniMax H3 的参考素材合计不能超过 46MB，以预留 Data URL 编码后的 64MB 请求体空间')
  }
  return issues
}
