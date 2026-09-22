import type { PaletteCategoryId } from '@shared/palette-preferences'
import type { IconName } from '../components/Icon'
import type { NodeTypeSpec } from '../nodes/registry'

export const PALETTE_CATEGORY_META: Record<
  PaletteCategoryId,
  { label: string; shortLabel: string; icon: IconName; description: string }
> = {
  favorites: { label: '常用', shortLabel: '常用', icon: 'spark', description: '常用创作节点' },
  input: { label: '素材与导入', shortLabel: '素材', icon: 'upload', description: '导入文字、文件和媒体素材' },
  image: { label: '图片创作', shortLabel: '图片', icon: 'image-gen', description: '生成、修改和整理图片' },
  video: { label: '视频创作', shortLabel: '视频', icon: 'video', description: '生成、截取和处理视频' },
  audio: { label: '声音创作', shortLabel: '声音', icon: 'audio', description: '配音、音色与声音处理' },
  logic: { label: '流程与高级', shortLabel: '流程', icon: 'workflow', description: '组织数据、批量任务和高级工作流' }
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
