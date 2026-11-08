import type { PaletteCategoryId } from './palette-preferences'
import { DISTRIBUTION_EDITION } from './edition'

/** 默认按常见创作流程的使用频率估计排序；修改数组位置即可调整菜单。 */
const FULL_CATEGORY_ORDER: readonly PaletteCategoryId[] = [
  'image',
  'input',
  'video',
  'audio',
  'ai',
  'data'
]

const FULL_NODE_GROUPS = {
  input: ['text', 'file', 'website'],
  image: ['image-gen', 'image', 'image-edit', 'image-crop', 'image-split'],
  video: [
    'video',
    'video-asset',
    'video-clip',
    'video-frame',
    'video-depth',
    'video-clay',
    'timeline',
    'storyboard',
    'director'
  ],
  audio: ['speech', 'audio', 'tts', 'voice-design', 'sound-adjust'],
  ai: ['agent', 'ai-process', 'chat', 'ai-review', 'state-machine'],
  data: ['processor', 'json', 'structured', 'iterate', 'code']
} as const satisfies Record<PaletteCategoryId, readonly string[]>

/** 发行版（CANVAS_DISTRIBUTION=1）：按功能删减清单过滤调色板。 */
const DISTRIBUTION_CATEGORY_ORDER: readonly PaletteCategoryId[] = FULL_CATEGORY_ORDER.filter(
  (category) => category !== 'data'
)
const DISTRIBUTION_NODE_GROUPS = {
  input: ['text', 'file', 'website'],
  image: ['image-gen', 'image', 'image-edit', 'image-crop', 'image-split'],
  video: ['video', 'video-asset', 'video-clip', 'video-frame', 'timeline', 'storyboard'],
  audio: ['speech', 'audio', 'sound-adjust'],
  ai: ['ai-process', 'chat'],
  data: [] as readonly string[]
} satisfies Record<PaletteCategoryId, readonly string[]>

export const DEFAULT_PALETTE_CATEGORY_ORDER: readonly PaletteCategoryId[] =
  DISTRIBUTION_EDITION ? DISTRIBUTION_CATEGORY_ORDER : FULL_CATEGORY_ORDER

/** 每个分类内从常用到进阶排列；左侧菜单和拖线菜单共用。 */
export const PALETTE_NODE_GROUPS: Record<PaletteCategoryId, readonly string[]> =
  DISTRIBUTION_EDITION ? DISTRIBUTION_NODE_GROUPS : FULL_NODE_GROUPS

/** 保留同类型不同端口的候选项，以及未来尚未配置排序的节点。 */
export function sortPaletteNodes<T extends { type: string }>(nodes: readonly T[]): T[] {
  const orderedTypes: readonly string[] = DEFAULT_PALETTE_CATEGORY_ORDER.flatMap((category) => [
    ...PALETTE_NODE_GROUPS[category]
  ])
  const ranks = new Map(orderedTypes.map((type, index) => [type, index]))
  return [...nodes].sort(
    (a, b) =>
      (ranks.get(a.type) ?? orderedTypes.length) - (ranks.get(b.type) ?? orderedTypes.length)
  )
}
