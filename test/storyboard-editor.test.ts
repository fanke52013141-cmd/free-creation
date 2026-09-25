import { describe, expect, it } from 'vitest'
import { parseStoryboardData, readStoryboardText } from '@shared/engine/helpers'
import {
  createStoryboardShot,
  moveStoryboardShot,
  removeStoryboardShot,
  updateStoryboardShot,
  updateStoryboardField,
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

  // 剧本和批量生图模板会往镜头上写 scene/dialogue/duration 之外的字段。卡片的读与写必须
  // 走共享解析出口，否则编辑任意一格就把其他镜头的 sound、camera 静默写丢。
  it('逐镜编辑往返保留镜头上的额外字段', () => {
    const board = parseStoryboardData({
      shots: [
        { id: 'a', scene: '雨夜', sound: '细雨', camera: '中近景' },
        { id: 'b', scene: '巷口', sound: '脚步声', camera: '广角' }
      ],
      imageModelKey: 'image-model'
    })
    if (!board) throw new Error('分镜解析失败')
    const edited = updateStoryboardShot(board, 'a', {
      scene: '雨夜街头',
      dialogue: '别回头',
      duration: '5s'
    })
    const reread = readStoryboardText(JSON.stringify(edited))
    expect(reread.kind).toBe('ok')
    if (reread.kind !== 'ok') return
    expect(reread.data).toEqual(edited)
    expect(reread.data.shots[1]).toMatchObject({ sound: '脚步声', camera: '广角' })
    expect(reread.data.imageModelKey).toBe('image-model')
  })

  it('表格字段编辑可更新任意扩展字段并保留分镜其它数据', () => {
    const board = {
      imageModelKey: 'model-a',
      shots: [{ id: 'a', scene: '夜景', dialogue: '', duration: '3s', camera: { lens: 35 } }]
    }
    const next = updateStoryboardField(board, 'a', 'camera', { lens: 50 })
    expect(next.shots[0]).toEqual({
      id: 'a',
      scene: '夜景',
      dialogue: '',
      duration: '3s',
      camera: { lens: 50 }
    })
    expect(next.imageModelKey).toBe('model-a')
    expect(updateStoryboardField(next, 'a', 'id', 'changed')).toBe(next)
  })
})
