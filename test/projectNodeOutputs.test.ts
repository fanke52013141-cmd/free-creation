// 输出投影测试（路线图 R2 / 契约规范 P2）
// @vitest-environment jsdom
//
// projectNodeOutputs 是「节点持久化状态 → 端口输出」的唯一投影入口，全局运行
// 与卡片内手动触发共用。固化每种节点在各种持久化状态下产出哪些端口、什么类型，
// 防止输出投影与端口契约脱节。
import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import {
  appendMediaResult,
  clearMediaResultHistory,
  MEDIA_RESULT_LIMIT,
  parseMediaResultCollection,
  projectNodeOutputs,
  removeMediaResult,
  serializeMediaResultCollection
} from '@renderer/nodes/nodeValues'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { createDirectorProject } from '@renderer/nodes/director-data'

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
      config: '',
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

describe('媒体结果集合', () => {
  it('追加结果并保留当前选中项', () => {
    const first = appendMediaResult(
      '',
      { mediaId: 'm1', mediaPath: '/one.png', mime: 'image/png' },
      { runId: 'run-1' }
    )
    const second = appendMediaResult(serializeMediaResultCollection(first), {
      mediaId: 'm2',
      mediaPath: '/two.png',
      mime: 'image/png'
    })
    expect(second.results.map((item) => item.mediaId)).toEqual(['m1', 'm2'])
    expect(second.results[0].runId).toBe('run-1')
    expect(second.selectedMediaId).toBe('m2')
    expect(parseMediaResultCollection(serializeMediaResultCollection(second))).toEqual(second)
  })

  it('兼容旧的单结果 media-source 记录', () => {
    const parsed = parseMediaResultCollection(
      JSON.stringify({ kind: 'media-source', modelKey: 'demo', prompt: 'x', at: 1 })
    )
    expect(parsed?.results).toEqual([])
    expect(parsed?.modelKey).toBe('demo')
  })

  it('限制历史数量并保留最新结果', () => {
    let stored = ''
    for (let i = 0; i < MEDIA_RESULT_LIMIT + 3; i += 1) {
      stored = serializeMediaResultCollection(
        appendMediaResult(
          stored,
          { mediaId: `m${i}`, mediaPath: `/m${i}.png`, mime: 'image/png' },
          { nodeId: 'n1' }
        )
      )
    }
    const parsed = parseMediaResultCollection(stored)
    expect(parsed?.results).toHaveLength(MEDIA_RESULT_LIMIT)
    expect(parsed?.results[0].mediaId).toBe('m3')
    expect(parsed?.selectedMediaId).toBe(`m${MEDIA_RESULT_LIMIT + 2}`)
  })

  it('删除结果并在当前结果被删除时回退到最后一项', () => {
    const stored = serializeMediaResultCollection({
      kind: 'media-source',
      version: 1,
      selectedMediaId: 'm2',
      results: [
        { mediaId: 'm1', mediaPath: '/1', mime: 'image/png', createdAt: 1 },
        { mediaId: 'm2', mediaPath: '/2', mime: 'image/png', createdAt: 2 }
      ]
    })
    const next = removeMediaResult(stored, 'm2')
    expect(next?.results.map((item) => item.mediaId)).toEqual(['m1'])
    expect(next?.selectedMediaId).toBe('m1')
  })

  it('清空历史时保留当前输出', () => {
    const stored = serializeMediaResultCollection({
      kind: 'media-source',
      version: 1,
      selectedMediaId: 'm1',
      results: [
        { mediaId: 'm1', mediaPath: '/1', mime: 'image/png', createdAt: 1 },
        { mediaId: 'm2', mediaPath: '/2', mime: 'image/png', createdAt: 2 }
      ]
    })
    const next = clearMediaResultHistory(stored)
    expect(next?.results.map((item) => item.mediaId)).toEqual(['m1'])
    expect(next?.selectedMediaId).toBe('m1')
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
    expect(out['out-markdown']).toEqual({ kind: 'markdown', text: '最新回复' })
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

describe('projectNodeOutputs · 结构数据节点', () => {
  it('只输出符合当前 Schema 的 JSON，避免将未校验配置交给下游', () => {
    const config = JSON.stringify({ schema: { id: 'character.profile', version: 1 } })
    const valid = projectNodeOutputs(
      shape('structured', {
        config,
        text: JSON.stringify({ id: 'c1', name: '主角', description: '寻找真相的人' })
      })
    )
    expect(valid['out-json']).toEqual({
      kind: 'json',
      data: { id: 'c1', name: '主角', description: '寻找真相的人' }
    })
    expect(projectNodeOutputs(shape('structured', { config, text: '{"id":"c1"}' }))).toEqual({})
  })

  it('成功运行后投影运行态结果，失败时不复用旧结果', () => {
    const config = JSON.stringify({ schema: { id: 'scene.definition', version: 1 } })
    const nodeResult = JSON.stringify({
      kind: 'structured-result',
      schema: { id: 'scene.definition', version: 1 },
      data: { id: 'scene-1', name: '雨巷', description: '主角穿过雨夜街头' }
    })
    const successful = shape(
      'structured',
      { config, text: JSON.stringify({ id: 'scene-1', name: '雨巷', description: '{{text}}' }) },
      {
        nodeResult,
        nodeRun: { runId: 'run-1', status: 'success', startedAt: 1, inputs: {} }
      }
    )
    expect(projectNodeOutputs(successful)['out-json']).toEqual({
      kind: 'json',
      data: { id: 'scene-1', name: '雨巷', description: '主角穿过雨夜街头' }
    })
    const failed = {
      ...successful,
      meta: {
        ...successful.meta,
        nodeRun: { runId: 'run-2', status: 'failed', startedAt: 2, inputs: {} }
      }
    }
    expect(projectNodeOutputs(failed)).toEqual({})
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
  it('文本运行结果输出实例定义的命名端口', () => {
    const result = JSON.stringify({ kind: 'text', text: '转换结果', variableName: 'output' })
    const out = projectNodeOutputs(
      shape(
        'code',
        { config: JSON.stringify({ source: '', outputName: 'caption', outputType: 'string' }) },
        { nodeResult: result }
      )
    )
    expect(out['out-caption']).toEqual({ kind: 'text', text: '转换结果' })
  })

  it('JSON 运行结果输出实例定义的命名端口', () => {
    const result = JSON.stringify({ kind: 'json', data: { x: 1 }, variableName: 'output' })
    const out = projectNodeOutputs(
      shape(
        'code',
        { config: JSON.stringify({ source: '', outputName: 'payload', outputType: 'object' }) },
        { nodeResult: result }
      )
    )
    expect(out['out-payload']).toEqual({ kind: 'json', data: { x: 1 } })
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
  // 配置/结果分离后，运行结果从 meta.nodeResult 读取
  it('text 结果输出 out-text', () => {
    const nodeResult = JSON.stringify({ kind: 'text', text: '转换结果' })
    const out = projectNodeOutputs(shape('ai-process', {}, { nodeResult }))
    expect(out['out-text']).toEqual({ kind: 'text', text: '转换结果' })
  })

  it('markdown 结果输出 out-markdown，并保留 Markdown 语义类型', () => {
    const nodeResult = JSON.stringify({ kind: 'markdown', text: '# 标题' })
    const out = projectNodeOutputs(shape('ai-process', {}, { nodeResult }))
    expect(out['out-markdown']).toEqual({ kind: 'markdown', text: '# 标题' })
  })

  it('json 结果输出 out-json', () => {
    const nodeResult = JSON.stringify({ kind: 'json', data: { a: 1 } })
    const out = projectNodeOutputs(shape('ai-process', {}, { nodeResult }))
    expect(out['out-json']).toEqual({ kind: 'json', data: { a: 1 } })
  })

  it('无结果时不输出任何端口', () => {
    expect(projectNodeOutputs(shape('ai-process', { text: '{}' }))).toEqual({})
    expect(projectNodeOutputs(shape('ai-process'))).toEqual({})
  })

  it('text 结果为空白时不输出', () => {
    const nodeResult = JSON.stringify({ kind: 'text', text: '   ' })
    expect(projectNodeOutputs(shape('ai-process', {}, { nodeResult }))).toEqual({})
  })

  it('损坏的 nodeResult 不产出输出', () => {
    expect(projectNodeOutputs(shape('ai-process', {}, { nodeResult: '{bad' }))).toEqual({})
  })
})

describe('projectNodeOutputs · 循环节点', () => {
  it('从 meta.nodeResult 读取 items 并输出 out-items 裸数组（list.items@1 Schema）', () => {
    const nodeResult = JSON.stringify({
      items: [{ status: 'done', source: { index: 0 } }]
    })
    const out = projectNodeOutputs(shape('iterate', {}, { nodeResult }))
    expect(out['out-items']?.kind).toBe('json')
    expect((out['out-items'] as { data: unknown }).data).toEqual([
      { status: 'done', source: { index: 0 } }
    ])
  })

  it('无 items 时无输出', () => {
    expect(projectNodeOutputs(shape('iterate', {}, { nodeResult: JSON.stringify({}) }))).toEqual({})
    expect(projectNodeOutputs(shape('iterate'))).toEqual({})
  })

  it('损坏的 nodeResult 不产出输出', () => {
    expect(projectNodeOutputs(shape('iterate', {}, { nodeResult: 'not-json' }))).toEqual({})
  })
})

describe('projectNodeOutputs · 导演台节点', () => {
  const baseProject = createDirectorProject()
  const project = {
    ...baseProject,
    revision: 2,
    shots: baseProject.shots.map((shot) => ({ ...shot, id: 'shot-1', scene: '雨夜街口' })),
    activeShotId: 'shot-1'
  }

  it('未发布时只输出工程摘要，不伪造媒体输出', () => {
    const out = projectNodeOutputs(shape('director', { config: JSON.stringify(project) }))
    expect(out['out-project']?.kind).toBe('json')
    expect(out['out-frame']).toBeUndefined()
    expect(out['out-preview-video']).toBeUndefined()
    expect(out['out-camera']).toBeUndefined()
  })

  it('发布记录同时投影为帧、视频和机位参数', () => {
    const record = {
      kind: 'director-publish',
      version: 1,
      publishedAt: 1,
      projectRevision: 2,
      shotId: 'shot-1',
      frame: { mediaId: 'img-1', mediaPath: 'projects/a/frame.png', mime: 'image/png' },
      video: { mediaId: 'vid-1', mediaPath: 'projects/a/preview.webm', mime: 'video/webm' },
      camera: project.shots[0].camera
    }
    const out = projectNodeOutputs(
      shape('director', { config: JSON.stringify(project) }, { nodeResult: JSON.stringify(record) })
    )
    expect(out['out-frame']).toEqual({ kind: 'image', ...record.frame })
    expect(out['out-preview-video']).toEqual({ kind: 'video', ...record.video })
    expect(out['out-camera']).toEqual({ kind: 'json', data: record.camera })
  })

  it('工程编辑后不再把旧发布媒体投影为当前下游输出', () => {
    const stale = {
      kind: 'director-publish',
      version: 1,
      publishedAt: 1,
      projectRevision: 1,
      shotId: 'shot-1',
      frame: { mediaId: 'img-1', mediaPath: 'projects/a/frame.png', mime: 'image/png' },
      camera: project.shots[0].camera
    }
    const out = projectNodeOutputs(
      shape('director', { config: JSON.stringify(project) }, { nodeResult: JSON.stringify(stale) })
    )
    expect(out['out-project']?.kind).toBe('json')
    expect(out['out-frame']).toBeUndefined()
    expect(out['out-camera']).toBeUndefined()
  })
})
