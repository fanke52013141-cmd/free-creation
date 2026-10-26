import type { PaletteCategoryId } from '@shared/palette-preferences'
import type { IconName } from '../components/Icon'
import type { NodeTypeSpec } from '../nodes/registry'
import { PALETTE_NODE_GROUPS, sortPaletteNodes } from '@shared/palette-menu-order'
export { PALETTE_NODE_GROUPS } from '@shared/palette-menu-order'

/**
 * 节点在画布入口的展示分类。它刻意不复用 NodeTypeSpec.category：后者是早期创建菜单
 * 的技术分类（例如生视频曾被放在 input），不应该决定用户看到的创作任务分类。
 */

export const PALETTE_CATEGORY_META: Record<
  PaletteCategoryId,
  { label: string; shortLabel: string; icon: IconName; color: string; description: string }
> = {
  input: {
    label: '输入与素材',
    shortLabel: '素材',
    icon: 'upload',
    color: '#F472B6',
    description: '文本、文件与网址素材'
  },
  image: {
    label: '图片创作',
    shortLabel: '图片',
    icon: 'image',
    color: '#4ADE80',
    description: '生成、修改和整理图片'
  },
  video: {
    label: '视频创作',
    shortLabel: '视频',
    icon: 'video',
    color: '#60A5FA',
    description: '生成、截取视频与分镜预演'
  },
  audio: {
    label: '声音创作',
    shortLabel: '声音',
    icon: 'audio',
    color: '#C084FC',
    description: '语音合成、音色与声音处理'
  },
  ai: {
    label: 'AI 与自动化',
    shortLabel: 'AI',
    icon: 'spark',
    color: '#42B9F5',
    description: '智能体编排与模型能力'
  },
  data: {
    label: '数据与代码',
    shortLabel: '数据',
    icon: 'code',
    color: '#FB923C',
    description: '数据处理、JSON 与本地脚本'
  }
}

export function nodesForPaletteCategory(
  nodeTypes: readonly NodeTypeSpec[],
  category: PaletteCategoryId
): NodeTypeSpec[] {
  return sortPaletteNodes(
    nodeTypes.filter((node) => PALETTE_NODE_GROUPS[category].includes(node.type as never))
  )
}

export function paletteCategoryForNode(type: string): PaletteCategoryId | null {
  for (const [category, nodeTypes] of Object.entries(PALETTE_NODE_GROUPS)) {
    if ((nodeTypes as readonly string[]).includes(type)) {
      return category as PaletteCategoryId
    }
  }
  return null
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
