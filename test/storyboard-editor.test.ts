import { describe, expect, it } from 'vitest'
import {
  createStoryboardShot,
  moveStoryboardShot,
  removeStoryboardShot,
  updateStoryboardShot,
  type StoryboardData
} from '@renderer/nodes/storyboard-editor'

const original: StoryboardData = {
  imageModelKey: 'image-model',
  shots: [
    { id: 'a', scene: '开场', dialogue: '你好', duration: '3s' },
    { id: 'b', scene: '转场', dialogue: '', duration: '2s' }
  ]
}

describe('storyboard-editor · 逐镜编辑数据模型', () => {
  it('创建镜头有可编辑的安全默认值', () => {
    expect(createStoryboardShot('new-shot')).toEqual({
      id: 'new-shot',
      scene: '',
      dialogue: '',
      duration: '3s'
    })
  })

  it('编辑只更新目标镜头且不就地修改旧数据', () => {
    const next = updateStoryboardShot(original, 'b', {
      scene: '室内特写',
      dialogue: '继续',
      duration: '4s'
    })
    expect(next.shots[1]).toMatchObject({ scene: '室内特写', dialogue: '继续', duration: '4s' })
    expect(next.imageModelKey).toBe('image-model')
    expect(original.shots[1].scene).toBe('转场')
  })

  it('排序、边界保护和删除都保持分镜数据可序列化', () => {
    const moved = moveStoryboardShot(original, 1, -1)
    expect(moved.shots.map((shot) => shot.id)).toEqual(['b', 'a'])
    expect(moveStoryboardShot(original, 0, -1)).toBe(original)

    const removed = removeStoryboardShot(moved, 'a')
    expect(removed.shots.map((shot) => shot.id)).toEqual(['b'])
    expect(JSON.parse(JSON.stringify(removed))).toEqual(removed)
    expect(original.shots.map((shot) => shot.id)).toEqual(['a', 'b'])
  })
})
