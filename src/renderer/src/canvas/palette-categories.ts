import type { PaletteCategoryId } from '@shared/palette-preferences'
import type { IconName } from '../components/Icon'
import type { NodeTypeSpec } from '../nodes/registry'

/**
 * 节点在画布入口的展示分类。它刻意不复用 NodeTypeSpec.category：后者是早期创建菜单
 * 的技术分类（例如生视频曾被放在 input），不应该决定用户看到的创作任务分类。
 */
export const PALETTE_NODE_GROUPS = {
  input: ['text', 'file', 'chat', 'ai-process'],
  image: ['image', 'image-gen', 'image-edit', 'image-crop', 'image-split'],
  video: ['video-asset', 'video', 'video-frame', 'video-clip'],
  audio: ['audio', 'speech', 'tts', 'voice-design', 'vocal-separate'],
  logic: ['storyboard', 'structured', 'json', 'processor', 'iterate', 'code', 'director']
} as const

export const PALETTE_CATEGORY_META: Record<
  PaletteCategoryId,
  { label: string; shortLabel: string; icon: IconName; description: string }
> = {
  input: {
    label: '文本与 AI',
    shortLabel: '文本',
    icon: 'text',
    description: '写作、对话与文本处理'
  },
  image: {
    label: '图片创作',
    shortLabel: '图片',
    icon: 'image',
    description: '生成、修改和整理图片'
  },
  video: {
    label: '视频创作',
    shortLabel: '视频',
    icon: 'video',
    description: '生成、截取和处理视频'
  },
  audio: {
    label: '声音创作',
    shortLabel: '声音',
    icon: 'audio',
    description: '配音、音色与声音处理'
  },
  logic: {
    label: '流程与高级',
    shortLabel: '流程',
    icon: 'workflow',
    description: '组织数据、批量任务和高级工作流'
  }
}

export function nodesForPaletteCategory(
  nodeTypes: readonly NodeTypeSpec[],
  category: PaletteCategoryId
): NodeTypeSpec[] {
  return nodeTypes.filter((node) => PALETTE_NODE_GROUPS[category].includes(node.type as never))
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
