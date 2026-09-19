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

function operationResult(
  mediaId: string,
  mediaPath: string,
  mime: string
): Record<string, unknown> {
  return {
    nodeResult: JSON.stringify({
      kind: 'media-source',
      version: 1,
      selectedMediaId: mediaId,
      results: [{ mediaId, mediaPath, mime, createdAt: 1 }]
    })
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

describe('projectNodeOutputs · 文档真值节点不被运行状态静音（§16.30）', () => {
  const skipped = { nodeRun: { runId: 'r1', status: 'skipped', startedAt: 1, inputs: {} } }
  const failed = { nodeRun: { runId: 'r2', status: 'failed', startedAt: 2, inputs: {} } }
  const media = { mediaId: 'm1', mediaPath: '/a.png', mediaMime: 'image/png' }

  it('文本节点：空正文点过一次运行后，再填入正文下游立刻可读', () => {
    // 旧语义下 skipped 会把整张卡片静音：用户照常用双击填好正文，下游却永远拿不到字，
    // 卡片状态点还显示「未运行」，看不出任何原因。
    expect(projectNodeOutputs(shape('text', { text: '正文已填' }, skipped))['out-text']).toEqual({
      kind: 'text',
      text: '正文已填'
    })
    expect(
      projectNodeOutputs(shape('text', { text: '正文已填' }, failed))['out-text']
    ).toBeDefined()
    // 正文仍为空时不该凭空造输出。
    expect(projectNodeOutputs(shape('text', { text: '  ' }, skipped))).toEqual({})
  })

  it('图片 / 视频 / 音频 / 文件资产：导入即向下游输出，与运行记录无关', () => {
    expect(projectNodeOutputs(shape('image', media, skipped))['out-image']?.kind).toBe('image')
    expect(
      projectNodeOutputs(
        shape(
          'video-asset',
          { mediaId: 'v1', mediaPath: '/a.mp4', mediaMime: 'video/mp4' },
          skipped
        )
      )['out-video']?.kind
    ).toBe('video')
    expect(
      projectNodeOutputs(
        shape('audio', { mediaId: 'a1', mediaPath: '/a.mp3', mediaMime: 'audio/mpeg' }, failed)
      )['out-audio']?.kind
    ).toBe('audio')
    expect(
      projectNodeOutputs(
        shape('file', { mediaId: 'f1', mediaPath: '/a.pdf', mediaMime: 'application/pdf' }, skipped)
      )['out-file']?.kind
    ).toBe('file')
  })

  it('操作节点的旧语义保留：运行没成功时不得把上一次产物投影成当前输出', () => {
    expect(
      projectNodeOutputs(
        shape('image-crop', {}, { ...operationResult('m', '/c.png', 'image/png'), ...skipped })
      )
    ).toEqual({})
    expect(
      projectNodeOutputs(
        shape('image-gen', {}, { ...operationResult('m', '/g.png', 'image/png'), ...failed })
      )
    ).toEqual({})
  })
})

describe('projectNodeOutputs · 媒体节点（资产 / 操作节点）', () => {
  it('资产从自身媒体投影；操作节点从运行结果投影对应类型输出', () => {
    const img = projectNodeOutputs(
      shape('image', { mediaId: 'm1', mediaPath: '/p.png', mediaMime: 'image/png' })
    )
    expect(img['out-image']?.kind).toBe('image')

    const gen = projectNodeOutputs(
      shape('image-gen', {}, operationResult('m2', '/g.png', 'image/png'))
    )
    expect(gen['out-image']?.kind).toBe('image')

    const crop = projectNodeOutputs(
      shape('image-crop', {}, operationResult('m-crop', '/crop.png', 'image/png'))
    )
    expect(crop['out-image']).toEqual({
      kind: 'image',
      mediaId: 'm-crop',
      mediaPath: '/crop.png',
      mime: 'image/png',
      name: 'image-crop'
    })
    const split = projectNodeOutputs(
      shape(
        'image-split',
        { mediaId: 'm-split-1', mediaPath: '/split-1.png', mediaMime: 'image/png' },
        {
          nodeResult: JSON.stringify({
            kind: 'media-source',
            version: 1,
            selectedMediaId: 'm-split-1',
            results: [
              {
                mediaId: 'm-split-1',
                mediaPath: '/split-1.png',
                mime: 'image/png',
                createdAt: 1
              },
              {
                mediaId: 'm-split-2',
                mediaPath: '/split-2.png',
                mime: 'image/png',
                createdAt: 1
              }
            ]
          })
        }
      )
    )
    expect(split['out-image']?.kind).toBe('image')
    expect(split['out-images']).toMatchObject({
      kind: 'json',
      data: [
        { index: 1, mediaId: 'm-split-1' },
        { index: 2, mediaId: 'm-split-2' }
      ]
    })
    const edit = projectNodeOutputs(
      shape('image-edit', {}, operationResult('m-edit', '/edit.png', 'image/png'))
    )
    expect(edit['out-image']?.kind).toBe('image')

    const vid = projectNodeOutputs(shape('video', {}, operationResult('m3', '/v.mp4', 'video/mp4')))
    expect(vid['out-video']?.kind).toBe('video')

    const frame = projectNodeOutputs(
      shape('video-frame', {}, operationResult('m-frame', '/frame.png', 'image/png'))
    )
    expect(frame['out-image']?.kind).toBe('image')

    const clip = projectNodeOutputs(
      shape('video-clip', {}, operationResult('m-clip', '/clip.mp4', 'video/mp4'))
    )
    expect(clip['out-video']?.kind).toBe('video')

    const extractedAudio = projectNodeOutputs(
      shape('video-audio', {}, operationResult('m-audio', '/audio.m4a', 'audio/mp4'))
    )
    expect(extractedAudio['out-audio']?.kind).toBe('audio')

    const aud = projectNodeOutputs(
      shape('audio', { mediaId: 'm4', mediaPath: '/a.mp3', mediaMime: 'audio/mpeg' })
    )
    expect(aud['out-audio']?.kind).toBe('audio')
  })

  it('无媒体路径时不产出输出', () => {
    expect(projectNodeOutputs(shape('image'))).toEqual({})
    expect(projectNodeOutputs(shape('image-crop'))).toEqual({})
    expect(projectNodeOutputs(shape('image-split'))).toEqual({})
    expect(projectNodeOutputs(shape('image-edit'))).toEqual({})
    expect(projectNodeOutputs(shape('video'))).toEqual({})
    expect(projectNodeOutputs(shape('video-frame'))).toEqual({})
    expect(projectNodeOutputs(shape('video-clip'))).toEqual({})
    expect(projectNodeOutputs(shape('video-audio'))).toEqual({})
    expect(projectNodeOutputs(shape('audio'))).toEqual({})
  })

  it('失败运行不会继续暴露上一次的媒体输出', () => {
    expect(
      projectNodeOutputs(
        shape(
          'image-edit',
          { mediaId: 'old', mediaPath: '/old.png', mediaMime: 'image/png' },
          { nodeRun: { runId: 'run-failed', status: 'failed', startedAt: 1, inputs: {} } }
        )
      )
    ).toEqual({})
  })

  it('历史项目：产物直接写在 props 且没有运行记录时仍投影输出', () => {
    // 早期版本把成片写在 video 节点的 props 上，没有结果集合。若不兼容，
    // 下游「抽帧 / 截视频 / 截音频」会全部读不到源视频（用户 2026-09-18 反馈）。
    expect(
      projectNodeOutputs(
        shape('video', { mediaId: 'legacy', mediaPath: '/legacy.mp4', mediaMime: 'video/mp4' })
      )['out-video']
    ).toEqual({
      kind: 'video',
      mediaId: 'legacy',
      mediaPath: '/legacy.mp4',
      mime: 'video/mp4',
      name: 'video'
    })
  })
})

describe('projectNodeOutputs · 语音节点（Batch C：配音 / 复刻 / 音色设计）', () => {
  const audioResult = operationResult('a1', '/voice.mp3', 'audio/mpeg')

  it('配音节点：成功运行后同时投影音频与非媒体字幕输出', () => {
    const out = projectNodeOutputs(
      shape(
        'speech',
        {},
        {
          ...audioResult,
          nodeExtra: JSON.stringify({
            'out-subtitle': {
              text: '你好世界',
              sentences: [{ start_time: 0, end_time: 1200, text: '你好世界' }]
            }
          })
        }
      )
    )
    expect(out['out-audio']).toMatchObject({ kind: 'audio', mediaId: 'a1' })
    expect(out['out-subtitle']).toEqual({
      kind: 'json',
      data: {
        text: '你好世界',
        sentences: [{ start_time: 0, end_time: 1200, text: '你好世界' }]
      }
    })
  })

  it('配音节点：没有字幕时不产出 out-subtitle，而不是给一个空结构', () => {
    const out = projectNodeOutputs(shape('speech', {}, { ...audioResult }))
    expect(out['out-audio']).toMatchObject({ kind: 'audio' })
    expect(out).not.toHaveProperty('out-subtitle')
  })

  it('音色设计节点：试听音频与音色档案同时可用', () => {
    const out = projectNodeOutputs(
      shape(
        'voice-design',
        {},
        {
          ...audioResult,
          nodeExtra: JSON.stringify({
            'out-json': { voice_id: 'CanvasVoice_2026', provider: 'minimax' }
          })
        }
      )
    )
    expect(out['out-audio']).toMatchObject({ kind: 'audio', mediaId: 'a1' })
    expect(out['out-json']).toEqual({
      kind: 'json',
      data: { voice_id: 'CanvasVoice_2026', provider: 'minimax' }
    })
  })

  it('语音克隆节点：MiniMax 登记出音色时暴露音色档案', () => {
    const out = projectNodeOutputs(
      shape(
        'tts',
        {},
        {
          ...audioResult,
          nodeExtra: JSON.stringify({ 'out-json': { voice_id: 'CanvasVoice_2026' } })
        }
      )
    )
    expect(out['out-json']).toEqual({
      kind: 'json',
      data: { voice_id: 'CanvasVoice_2026' }
    })
  })

  it('运行失败时不暴露上一次的音色档案或字幕（陈旧结果必须清空）', () => {
    const failed = {
      ...audioResult,
      nodeExtra: JSON.stringify({ 'out-json': { voice_id: 'CanvasVoice_2026' } }),
      nodeRun: { runId: 'run-2', status: 'failed', startedAt: 2, inputs: {} }
    }
    expect(projectNodeOutputs(shape('voice-design', {}, failed))).toEqual({})
  })

  it('损坏的 nodeExtra 不抛异常，只是不产出该端口', () => {
    const out = projectNodeOutputs(
      shape('voice-design', {}, { ...audioResult, nodeExtra: '{not json' })
    )
    expect(out).not.toHaveProperty('out-json')
    expect(out['out-audio']).toMatchObject({ kind: 'audio' })
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

  it('发布记录投影为帧与视频；机位端口不投影，以免拖垮同节点输出', () => {
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
    // out-camera 声明为专用 camera 通道，而 NodeValue 没有 camera 这一类值：投影它会让
    // 整节点被判为契约违规，手动运行的上游预填因此连 out-frame 一起丢掉（§7.9 第 5 条）。
    expect(out['out-camera']).toBeUndefined()
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
