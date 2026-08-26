// 输出投影测试（路线图 R2 / 契约规范 P2）
// @vitest-environment jsdom
//
// projectNodeOutputs 是「节点持久化状态 → 端口输出」的唯一投影入口，全局运行
// 与卡片内手动触发共用。固化每种节点在各种持久化状态下产出哪些端口、什么类型，
// 防止输出投影与端口契约脱节。
import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { projectNodeOutputs } from '@renderer/nodes/nodeValues'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'

beforeAll(() => {
  registerAllNodeTypes()
})

/** 构造一个 NodeCardShape，只填与投影相关的字段。 */
function shape(
  nodeType: string,
  props: Partial<NodeCardShape['props']> = {},
  meta: Record<string, unknown> = {}
): NodeCardShape {
  return {
    id: 'shape:1' as never,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1' as never,
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType,
      title: nodeType,
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      ...props
    },
    meta
  }
}

describe('projectNodeOutputs · 文本节点', () => {
  it('有文本时输出 out-text', () => {
    const out = projectNodeOutputs(shape('text', { text: '  hello  ' }))
    expect(out['out-text']).toEqual({ kind: 'text', text: 'hello' })
  })

  it('空白文本不产出输出', () => {
    expect(projectNodeOutputs(shape('text', { text: '   ' }))).toEqual({})
    expect(projectNodeOutputs(shape('text', { text: '' }))).toEqual({})
  })
})

describe('projectNodeOutputs · 媒体节点（图片/生图/视频/音频）', () => {
  it('有媒体路径时产出对应类型输出', () => {
    const img = projectNodeOutputs(
      shape('image', { mediaId: 'm1', mediaPath: '/p.png', mediaMime: 'image/png' })
    )
    expect(img['out-image']?.kind).toBe('image')

    const gen = projectNodeOutputs(
      shape('image-gen', { mediaId: 'm2', mediaPath: '/g.png', mediaMime: 'image/png' })
    )
    expect(gen['out-image']?.kind).toBe('image')

    const vid = projectNodeOutputs(
      shape('video', { mediaId: 'm3', mediaPath: '/v.mp4', mediaMime: 'video/mp4' })
    )
    expect(vid['out-video']?.kind).toBe('video')

    const aud = projectNodeOutputs(
      shape('audio', { mediaId: 'm4', mediaPath: '/a.mp3', mediaMime: 'audio/mpeg' })
    )
    expect(aud['out-audio']?.kind).toBe('audio')
  })

  it('无媒体路径时不产出输出', () => {
    expect(projectNodeOutputs(shape('image'))).toEqual({})
    expect(projectNodeOutputs(shape('video'))).toEqual({})
    expect(projectNodeOutputs(shape('audio'))).toEqual({})
  })
})

describe('projectNodeOutputs · 对话节点（取最后一条助手回复）', () => {
  it('输出最后一条 assistant 消息为 markdown', () => {
    const data = {
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '上一条回复' },
        { role: 'user', content: '再问' },
        { role: 'assistant', content: '最新回复' }
      ]
    }
    const out = projectNodeOutputs(shape('chat', { text: JSON.stringify(data) }))
    expect(out['out-markdown']).toEqual({ kind: 'text', text: '最新回复' })
  })

  it('无助手消息时不产出输出', () => {
    const data = { messages: [{ role: 'user', content: '你好' }] }
    expect(projectNodeOutputs(shape('chat', { text: JSON.stringify(data) }))).toEqual({})
  })

  it('损坏的持久化文本安全返回空（不抛错）', () => {
    expect(projectNodeOutputs(shape('chat', { text: '不是 json' }))).toEqual({})
  })
})

describe('projectNodeOutputs · JSON 节点', () => {
  it('合法 JSON 文本输出 out-json', () => {
    const out = projectNodeOutputs(shape('json', { text: '{"a":1}' }))
    expect(out['out-json']).toEqual({ kind: 'json', data: { a: 1 } })
  })

  it('无效 JSON 文本返回空', () => {
    expect(projectNodeOutputs(shape('json', { text: '{bad' }))).toEqual({})
    expect(projectNodeOutputs(shape('json', { text: '' }))).toEqual({})
  })
})

describe('projectNodeOutputs · 分镜板节点', () => {
  it('输出分镜 JSON 与可读摘要文本', () => {
    const data = {
      shots: [
        { id: 's1', scene: '街道', dialogue: '你好', duration: '3s' },
        { id: 's2', scene: '室内', dialogue: '', duration: '' }
      ]
    }
    const out = projectNodeOutputs(shape('storyboard', { text: JSON.stringify(data) }))
    expect(out['out-json']?.kind).toBe('json')
    expect((out['out-json'] as { data: unknown }).data).toEqual(data)
    expect(out['out-text']?.kind).toBe('text')
    expect((out['out-text'] as { text: string }).text).toContain('街道')
    expect((out['out-text'] as { text: string }).text).toContain('你好')
  })

  it('无 shots 数组的文本返回空', () => {
    expect(projectNodeOutputs(shape('storyboard', { text: '{"foo":1}' }))).toEqual({})
  })
})

describe('projectNodeOutputs · 代码节点（读 meta.nodeResult）', () => {
  it('文本运行结果输出 out-text', () => {
    const result = JSON.stringify({ kind: 'text', text: '转换结果', variableName: 'output' })
    const out = projectNodeOutputs(shape('code', {}, { nodeResult: result }))
    expect(out['out-text']).toEqual({ kind: 'text', text: '转换结果' })
  })

  it('JSON 运行结果输出 out-json', () => {
    const result = JSON.stringify({ kind: 'json', data: { x: 1 }, variableName: 'output' })
    const out = projectNodeOutputs(shape('code', {}, { nodeResult: result }))
    expect(out['out-json']).toEqual({ kind: 'json', data: { x: 1 } })
  })

  it('无运行结果返回空', () => {
    expect(projectNodeOutputs(shape('code'))).toEqual({})
  })
})

describe('projectNodeOutputs · 处理节点（读 meta.nodeResult）', () => {
  it('运行结果原样输出到 out-value', () => {
    const result = JSON.stringify({ kind: 'text', text: '透传', variableName: 'output' })
    const out = projectNodeOutputs(shape('processor', {}, { nodeResult: result }))
    expect(out['out-value']).toEqual({ kind: 'text', text: '透传' })
  })

  it('JSON 类型的运行结果也输出到 out-value', () => {
    const result = JSON.stringify({ kind: 'json', data: [1, 2, 3], variableName: 'output' })
    const out = projectNodeOutputs(shape('processor', {}, { nodeResult: result }))
    expect(out['out-value']?.kind).toBe('json')
  })
})

describe('projectNodeOutputs · 脚本节点（旧版兼容）', () => {
  it('同时输出分镜 JSON 与剧本文本', () => {
    const data = { source: '剧本原文', shots: [{ id: 's1', scene: 'a' }] }
    const out = projectNodeOutputs(shape('script', { text: JSON.stringify(data) }))
    expect(out['out-json']?.kind).toBe('json')
    expect(out['out-text']?.kind).toBe('text')
    expect((out['out-text'] as { text: string }).text).toBe('剧本原文')
  })
})

describe('projectNodeOutputs · AI 处理节点', () => {
  it('text 结果输出 out-text', () => {
    const text = JSON.stringify({ result: { kind: 'text', text: '转换结果' } })
    const out = projectNodeOutputs(shape('ai-process', { text }))
    expect(out['out-text']).toEqual({ kind: 'text', text: '转换结果' })
  })

  it('markdown 结果输出 out-markdown（kind 为 text 但端口语义为 markdown）', () => {
    const text = JSON.stringify({ result: { kind: 'markdown', text: '# 标题' } })
    const out = projectNodeOutputs(shape('ai-process', { text }))
    expect(out['out-markdown']).toEqual({ kind: 'text', text: '# 标题' })
  })

  it('json 结果输出 out-json', () => {
    const text = JSON.stringify({ result: { kind: 'json', data: { a: 1 } } })
    const out = projectNodeOutputs(shape('ai-process', { text }))
    expect(out['out-json']).toEqual({ kind: 'json', data: { a: 1 } })
  })

  it('无结果时不输出任何端口', () => {
    expect(projectNodeOutputs(shape('ai-process', { text: '{}' }))).toEqual({})
    expect(projectNodeOutputs(shape('ai-process'))).toEqual({})
  })

  it('text 结果为空白时不输出', () => {
    const text = JSON.stringify({ result: { kind: 'text', text: '   ' } })
    expect(projectNodeOutputs(shape('ai-process', { text }))).toEqual({})
  })
})

describe('projectNodeOutputs · 循环节点', () => {
  it('有 items 时输出 out-items 裸数组（list.items@1 Schema）', () => {
    const text = JSON.stringify({
      items: [{ status: 'done', source: { index: 0 } }]
    })
    const out = projectNodeOutputs(shape('iterate', { text }))
    expect(out['out-items']?.kind).toBe('json')
    expect((out['out-items'] as { data: unknown }).data).toEqual([
      { status: 'done', source: { index: 0 } }
    ])
  })

  it('无 items 时无输出', () => {
    expect(projectNodeOutputs(shape('iterate', { text: '{}' }))).toEqual({})
    expect(projectNodeOutputs(shape('iterate'))).toEqual({})
  })
})
