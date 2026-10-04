import { describe, expect, it } from 'vitest'
import { deriveInputPortReadiness, deriveNodeReadiness } from '@renderer/canvas/node-readiness'
import type { PortDecl } from '@shared/types'

const requiredText: PortDecl = {
  id: 'in-text',
  name: '正文',
  dir: 'in',
  type: 'text',
  required: true,
  cardinality: 'one',
  description: '待处理正文。'
}

describe('节点就绪状态', () => {
  it('端口级状态区分缺失必填、可选未连和多输入连接数量', () => {
    const many = {
      ...requiredText,
      id: 'in-context',
      required: false,
      cardinality: 'many' as const
    }
    const states = deriveInputPortReadiness([requiredText, many], new Map([['in-context', 2]]))
    expect(states.get('in-text')).toMatchObject({ kind: 'missing', label: '缺少必填输入' })
    expect(states.get('in-context')).toMatchObject({ kind: 'connected', label: '2 条连接' })
  })
  it('必填端口未连接时明确说明缺失输入', () => {
    expect(
      deriveNodeReadiness({
        executionMode: 'auto',
        exec: 'idle',
        inputs: [requiredText],
        incomingCounts: new Map(),
        outputs: {}
      })
    ).toMatchObject({ kind: 'blocked', label: '缺少输入：正文' })
  })

  it('手动发布节点仅工程摘要时仍提示等待发布', () => {
    expect(
      deriveNodeReadiness({
        executionMode: 'manual-publish',
        exec: 'idle',
        inputs: [],
        incomingCounts: new Map(),
        outputs: { 'out-project': { kind: 'json', data: {} } }
      })
    ).toMatchObject({ kind: 'manual-publish', label: '等待发布' })
  })

  it('发布媒体后表示为可供下游使用', () => {
    expect(
      deriveNodeReadiness({
        executionMode: 'manual-publish',
        exec: 'success',
        inputs: [],
        incomingCounts: new Map(),
        outputs: {
          'out-frame': {
            kind: 'image',
            mediaId: 'frame',
            mediaPath: 'p/frame.png',
            mime: 'image/png'
          }
        }
      })
    ).toMatchObject({ kind: 'ready', label: '已发布' })
  })
})

// T06（F06）：正文必需节点的配置预检——空正文不再显示「可运行」。
describe('deriveNodeReadiness · 配置预检（T06）', () => {
  const base = (nodeType: string, text: string) => ({
    executionMode: 'auto' as const,
    exec: 'idle',
    nodeType,
    text,
    inputs: [],
    incomingCounts: new Map(),
    outputs: {}
  })

  it('生图无提示词时显示待补充而非可运行，并给出结构化原因', () => {
    const r = deriveNodeReadiness(base('image-gen', ''))
    expect(r.kind).toBe('blocked')
    expect(r).toMatchObject({
      label: '待补充：提示词',
      reason: 'config-missing'
    })
  })

  it('生图提示词填写后回到可运行', () => {
    expect(deriveNodeReadiness(base('image-gen', '蓝色立方体')).kind).toBe('ready')
  })

  it('正文必需清单：speech/ai-process/text 与 image-gen 行为一致', () => {
    for (const nodeType of ['speech', 'ai-process', 'text']) {
      expect(deriveNodeReadiness(base(nodeType, '  ')).label).toContain('待补充')
      expect(deriveNodeReadiness(base(nodeType, '内容')).kind).toBe('ready')
    }
  })

  it('非正文必需节点（chat）空正文仍是可运行', () => {
    expect(deriveNodeReadiness(base('chat', '')).kind).toBe('ready')
  })

  it('未传 nodeType 时保持旧行为（可运行），兼容既有调用方', () => {
    const { nodeType: _nodeType, text: _text, ...legacy } = base('image-gen', '')
    expect(deriveNodeReadiness(legacy).kind).toBe('ready')
  })
})
