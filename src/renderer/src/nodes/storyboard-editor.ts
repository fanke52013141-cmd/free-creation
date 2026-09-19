/**
 * 分镜板的逐镜编辑数据模型。
 *
 * 这里刻意不依赖 React / tldraw：UI 仅负责将返回值写回节点 text，
 * 所以新增、编辑、排序、删除的语义可以独立回归，且不会就地修改旧数据。
 *
 * 镜头结构不复定义：它直接是共享层的 ShotShape。执行器与卡片必须看到同一份字段口径，
 * 否则剧本产出的 sound、批量生图模板用到的 camera 会在某一层被静默丢掉。
 */
import type { ShotShape, StoryboardData } from '@shared/engine/helpers'

export type StoryboardShot = ShotShape
export type { StoryboardData }

export type StoryboardShotDraft = Pick<StoryboardShot, 'scene' | 'dialogue' | 'duration'>

export function createStoryboardShot(id: string): StoryboardShot {
  return { id, scene: '', dialogue: '', duration: '3s' }
}

export function updateStoryboardShot(
  data: StoryboardData,
  shotId: string,
  patch: StoryboardShotDraft
): StoryboardData {
  return {
    ...data,
    shots: data.shots.map((shot) => (shot.id === shotId ? { ...shot, ...patch } : shot))
  }
}

/** 超出边界时保持原顺序；调用方无需额外处理第一/最后一张镜头。 */
export function moveStoryboardShot(
  data: StoryboardData,
  index: number,
  direction: -1 | 1
): StoryboardData {
  const target = index + direction
  if (index < 0 || target < 0 || index >= data.shots.length || target >= data.shots.length)
    return data
  const shots = [...data.shots]
  ;[shots[index], shots[target]] = [shots[target], shots[index]]
  return { ...data, shots }
}

export function removeStoryboardShot(data: StoryboardData, shotId: string): StoryboardData {
  return { ...data, shots: data.shots.filter((shot) => shot.id !== shotId) }
}
