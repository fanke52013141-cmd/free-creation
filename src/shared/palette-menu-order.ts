import type { PaletteCategoryId } from './palette-preferences'

/** 默认按常见创作流程的使用频率估计排序；修改数组位置即可调整菜单。 */
export const DEFAULT_PALETTE_CATEGORY_ORDER: readonly PaletteCategoryId[] = [
  'image',
  'input',
  'video',
  'audio',
  'logic'
]

/** 每个分类内从常用到进阶排列；左侧菜单和拖线菜单共用。 */
export const PALETTE_NODE_GROUPS = {
  input: ['text', 'ai-process', 'chat', 'file', 'website'],
  image: ['image-gen', 'image', 'image-edit', 'image-crop', 'image-split'],
  video: ['video', 'video-asset', 'video-clip', 'video-frame', 'video-depth', 'video-clay'],
  audio: ['speech', 'audio', 'tts', 'voice-design', 'sound-adjust'],
  logic: ['storyboard', 'processor', 'json', 'structured', 'iterate', 'director', 'code']
} as const satisfies Record<PaletteCategoryId, readonly string[]>

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
