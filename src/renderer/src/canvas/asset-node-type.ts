// 媒体资产落在画布上的节点类型：kind 与 nodeType 不是一一对应的。
//
// nodeType 'video' 是「生视频」节点——要选模型、能发起计费请求；导入/产出的视频本身
// 属于「视频资产」节点。这个映射以前在 createMediaNodes（拖拽导入）里漏了一层，
// 结果拖进画布的 MP4 变成了一张等着生成视频的卡。
import type { ActiveNodeTypeId, MediaAsset } from '@shared/types'

export function assetNodeTypeFor(kind: MediaAsset['kind']): ActiveNodeTypeId {
  switch (kind) {
    case 'video':
      return 'video-asset'
    case 'image':
      return 'image'
    case 'audio':
      return 'audio'
    default:
      return 'file'
  }
}
