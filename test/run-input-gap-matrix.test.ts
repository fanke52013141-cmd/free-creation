// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { missingWorkflowPorts } from '@renderer/engine/workflow-inputs'
import { getNodeType } from '@renderer/nodes/registry'
import type { CanvasNode } from '@shared/types'
import { registerAllNodeTypes } from './helpers/registerNodes'

beforeAll(() => registerAllNodeTypes())

function bareNode(type: string): CanvasNode {
  return {
    id: `shape:gap-${type}`,
    type,
    title: type,
    ports: [],
    text: '',
    params: { config: '' },
    meta: {}
  } as unknown as CanvasNode
}

function gaps(type: string, body = '', inputs = new Map()): string[] {
  return missingWorkflowPorts(bareNode(type), body, [], inputs as never, []).map((p) => p.id)
}

describe('T1 缺口判定矩阵 · 空正文无连线', () => {
  // 应弹窗：required 端口 或 nodeNeedsContentInput 覆盖
  const shouldPrompt: Array<[string, string[]]> = [
    ['text', ['in-text']],
    ['ai-process', ['in-text']],
    ['image-gen', ['in-text']],
    ['speech', ['in-text']],
    ['chat', ['in-text']],
    ['video', ['in-text']],
    ['voice-design', ['in-text']],
    ['json', ['in-text']],
    ['structured', ['in-text']],
    ['storyboard', ['in-text']],
    ['image-crop', ['in-image']],
    ['image-split', ['in-image']],
    ['image-edit', ['in-image']],
    ['video-frame', ['in-video']],
    ['video-clip', ['in-video']],
    ['video-depth', ['in-video']],
    ['video-clay', ['in-video']],
    ['iterate', ['in-list']],
    ['sound-adjust', ['in-audio']]
  ]
  it.each(shouldPrompt)('%s 缺输入时列出缺口 %j', (type, expected) => {
    expect(getNodeType(type)).toBeDefined()
    expect(gaps(type)).toEqual(expected)
  })

  // 不应弹窗：资产/配置/特殊宿主节点（无内容缺口或另有产出路径）
  const shouldNotPrompt: string[] = [
    'tts',
    'processor',
    'audio',
    'file',
    'video-asset',
    'website',
    'image',
    'code',
    'state-machine',
    'agent',
    'ai-review',
    'director'
  ]
  it.each(shouldNotPrompt)('%s 空输入时不列缺口（覆盖现状）', (type) => {
    expect(getNodeType(type)).toBeDefined()
    expect(gaps(type)).toEqual([])
  })
})

describe('T1.3 输入已满足时不列缺口', () => {
  it('text 有正文 → 无缺口', () => {
    expect(gaps('text', '已有正文')).toEqual([])
  })
  it('image-gen 有正文 → 无缺口', () => {
    expect(gaps('image-gen', '一只猫')).toEqual([])
  })
  it('speech 有正文 → 无缺口', () => {
    expect(gaps('speech', '朗读文本')).toEqual([])
  })
  it('ai-process 有 in-json 来源 → 无缺口', () => {
    const inputs = new Map([['in-json', [{ type: 'json', value: { kind: 'json', data: {} } }]]])
    expect(gaps('ai-process', '', inputs)).toEqual([])
  })
  it('chat 有 in-text 来源 → 无缺口', () => {
    const inputs = new Map([['in-text', [{ type: 'text', value: { kind: 'text', text: 'hi' } }]]])
    expect(gaps('chat', '', inputs)).toEqual([])
  })
  it('video 有正文 → 无缺口', () => {
    expect(gaps('video', '一只猫在跑')).toEqual([])
  })
  it('video 有 in-prompt 来源 → 无缺口', () => {
    const inputs = new Map([['in-prompt', [{ type: 'json', value: { kind: 'json', data: {} } }]]])
    expect(gaps('video', '', inputs)).toEqual([])
  })
  it('voice-design 有正文 → 无缺口', () => {
    expect(gaps('voice-design', '温柔女声')).toEqual([])
  })
  it('json 有正文 → 无缺口', () => {
    expect(gaps('json', '{"a":1}')).toEqual([])
  })
  it('json 有 in-json 来源 → 无缺口', () => {
    const inputs = new Map([['in-json', [{ type: 'json', value: { kind: 'json', data: {} } }]]])
    expect(gaps('json', '', inputs)).toEqual([])
  })
  it('structured 有正文模板 → 无缺口', () => {
    expect(gaps('structured', '{"name":"{{text}}"}')).toEqual([])
  })
  it('storyboard 有正文 → 无缺口', () => {
    expect(gaps('storyboard', '{"shots":[]}')).toEqual([])
  })
})

describe('T1.4 节点流公开输入缺口（2026-11-13 单主输入必填裁决）', () => {
  function compositeNode(defaultValue?: string): CanvasNode {
    const manifest = {
      schemaVersion: 1,
      runtimeVersion: 2,
      capabilityId: 'role-design',
      version: '1.0',
      name: '角色设计',
      inputs: [
        {
          id: 'n1-in-text',
          label: '文本',
          type: 'text',
          required: true,
          cardinality: 'many',
          targets: [{ nodeId: 'n1', portId: 'in-text' }],
          ...(defaultValue !== undefined ? { defaultValue } : {})
        }
      ],
      outputs: [
        {
          id: 'n1-out-text',
          label: '文本',
          type: 'text',
          required: true,
          cardinality: 'one',
          source: { nodeId: 'n1', portId: 'out-text' }
        }
      ],
      graph: {
        nodes: [
          {
            id: 'n1',
            nodeType: 'text',
            contractVersion: 3,
            title: '文本',
            dx: 0,
            dy: 0,
            w: 340,
            h: 300,
            ports: [
              {
                id: 'in-text',
                name: '文本',
                dir: 'in',
                type: 'text',
                required: false,
                cardinality: 'many'
              },
              {
                id: 'out-text',
                name: '文本',
                dir: 'out',
                type: 'text',
                required: true,
                cardinality: 'one'
              }
            ]
          }
        ],
        edges: []
      },
      dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }]
    }
    return {
      id: 'shape:composite',
      type: 'composite',
      title: '角色设计',
      ports: [
        {
          id: 'in-n1-in-text',
          name: '文本',
          dir: 'in',
          type: 'text',
          required: true,
          cardinality: 'many'
        }
      ],
      text: '',
      params: { config: JSON.stringify({ manifest }) },
      meta: {}
    } as unknown as CanvasNode
  }

  it('组合必填公开输入缺值时列出缺口 → 触发补输入弹窗', () => {
    const gaps = missingWorkflowPorts(compositeNode(), '', [], new Map() as never, [])
    expect(gaps.map((p) => p.id)).toEqual(['in-n1-in-text'])
  })

  it('组合公开输入带 defaultValue（内部固定正文）时不列缺口', () => {
    const gaps = missingWorkflowPorts(compositeNode('默认正文'), '', [], new Map() as never, [])
    expect(gaps).toEqual([])
  })

  it('组合公开输入已连线时不列缺口', () => {
    const edges = [
      {
        id: 'e1',
        from: { nodeId: 'shape:up', portId: 'out-text' },
        to: { nodeId: 'shape:composite', portId: 'in-n1-in-text' }
      }
    ]
    const gaps = missingWorkflowPorts(compositeNode(), '', edges as never, new Map() as never, [])
    expect(gaps).toEqual([])
  })
})
