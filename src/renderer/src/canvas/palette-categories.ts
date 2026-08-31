import type { PaletteCategoryId } from '@shared/palette-preferences'
import type { IconName } from '../components/Icon'
import type { NodeTypeSpec } from '../nodes/registry'

export const PALETTE_CATEGORY_META: Record<
  PaletteCategoryId,
  { label: string; icon: IconName; description: string }
> = {
  favorites: { label: '常用', icon: 'spark', description: '常用创作节点' },
  input: { label: '输入', icon: 'upload', description: '素材与内容输入' },
  image: { label: '图像', icon: 'image-gen', description: '图像生成与处理' },
  video: { label: '视频', icon: 'video', description: '视频生成与编辑' },
  audio: { label: '音频', icon: 'audio', description: '声音、语音与对话' },
  logic: { label: '流程', icon: 'workflow', description: '结构、处理与编排' }
}

const FAVORITE_NODE_TYPES = new Set([
  'text',
  'image',
  'image-gen',
  'video',
  'audio',
  'storyboard',
  'ai-process'
])

export function nodesForPaletteCategory(
  nodeTypes: readonly NodeTypeSpec[],
  category: PaletteCategoryId
): NodeTypeSpec[] {
  if (category === 'favorites') {
    return nodeTypes.filter((node) => FAVORITE_NODE_TYPES.has(node.type))
  }
  return nodeTypes.filter((node) => node.category === category)
}

export function movePaletteCategory<T extends string>(order: readonly T[], from: T, to: T): T[] {
  const fromIndex = order.indexOf(from)
  const toIndex = order.indexOf(to)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return [...order]
  const next = [...order]
  next.splice(fromIndex, 1)
  next.splice(toIndex, 0, from)
  return next
}
