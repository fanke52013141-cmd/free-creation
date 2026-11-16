// 运行记录值快照：完整正文可复制、媒体只留引用、超大正文显式截断。
import { describe, expect, it } from 'vitest'
import {
  RUN_VALUE_TEXT_LIMIT,
  snapshotRunInputs,
  snapshotRunOutputs,
  snapshotRunValue
} from '@renderer/engine/runRecord'

describe('运行记录输入输出值快照', () => {
  it('文本正文完整保留', () => {
    const prompt = '霓虹雨夜，角色全身镜头，冷色调'
    expect(snapshotRunValue({ kind: 'text', text: prompt })).toEqual({ kind: 'text', text: prompt })
  })

  it('JSON 保留结构化数据', () => {
    const data = { shots: [{ id: 's1', scene: '雨夜' }] }
    expect(snapshotRunValue({ kind: 'json', data })).toEqual({ kind: 'json', data })
  })

  it('媒体只存引用不存二进制', () => {
    const snapshot = snapshotRunValue({
      kind: 'image',
      mediaId: 'm1',
      mediaPath: 'projects/p/media/m1.png',
      mime: 'image/png',
      name: '分镜1'
    }) as Record<string, unknown>
    expect(snapshot.mediaId).toBe('m1')
    expect(snapshot.mediaPath).toBe('projects/p/media/m1.png')
    expect(snapshot.name).toBe('分镜1')
    expect(Object.keys(snapshot).sort()).toEqual(['kind', 'mediaId', 'mediaPath', 'mime', 'name'])
  })

  it('超大正文截断并显式标记', () => {
    const snapshot = snapshotRunValue({
      kind: 'text',
      text: 'x'.repeat(RUN_VALUE_TEXT_LIMIT + 10)
    }) as { truncated?: boolean; text: string }
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.text.length).toBeLessThan(RUN_VALUE_TEXT_LIMIT + 100)
    expect(snapshot.text).toContain('已截断')
  })

  it('按端口聚合输入与输出', () => {
    const inputs = new Map([
      ['in-text', [{ value: { kind: 'text' as const, text: 'a' }, source: { nodeId: 'n', portId: 'p' } }]]
    ])
    expect(snapshotRunInputs(inputs as never)).toEqual({ 'in-text': [{ kind: 'text', text: 'a' }] })
    expect(
      snapshotRunOutputs({ 'out-text': { value: { kind: 'text', text: 'b' } }, 'out-x': undefined })
    ).toEqual({ 'out-text': [{ kind: 'text', text: 'b' }] })
  })
})