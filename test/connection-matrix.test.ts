// 连线兼容矩阵测试（路线图 R2 / 契约规范 §5 连线规则）
// @vitest-environment jsdom
//
// 连线的七重校验里，「类型兼容」与「Schema 兼容」是纯函数判断，是 createEdge /
// tryConnect 接受或拒绝连线的核心依据。这里把所有节点的实际输出→输入组合枚举，
// 固化允许与拒绝的连线矩阵，防止端口类型或 Schema 变化悄悄改变连线行为。
import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { getNodeType, portCompatible } from '@renderer/nodes/registry'
import { nodeSchemasCompatible } from '@shared/node-schemas'
import type { NodeTypeId, PortType } from '@shared/types'

beforeAll(() => {
  registerAllNodeTypes()
})

/** 判断从 fromType 的某输出端口到 toType 的某输入端口是否允许连线（类型+Schema）。 */
function canConnect(
  fromType: NodeTypeId,
  fromPortId: string,
  toType: NodeTypeId,
  toPortId: string
): boolean {
  const fromSpec = getNodeType(fromType)
  const toSpec = getNodeType(toType)
  const fromPort = fromSpec?.ports.out.find((p) => p.id === fromPortId)
  const toPort = toSpec?.ports.in.find((p) => p.id === toPortId)
  if (!fromPort || !toPort) return false
  if (!portCompatible(fromPort.type, toPort.type)) return false
  if (fromPort.type === 'json' && toPort.type === 'json') {
    if (!nodeSchemasCompatible(fromPort.schema, toPort.schema)) return false
  }
  return true
}

describe('标准连线 · 允许的组合', () => {
  it('文本 → 文本类节点（生图/视频/对话/音频/脚本/代码）', () => {
    const textOut = [
      'image-gen',
      'video',
      'chat',
      'audio',
      'script',
      'code',
      'text',
      'json',
      'storyboard'
    ]
    for (const target of textOut) {
      // 这些节点的 in-text 都是 text 类型，与 text 输出兼容
      const toSpec = getNodeType(target as NodeTypeId)
      const hasTextInput = toSpec?.ports.in.some((p) => p.type === 'text')
      if (hasTextInput) {
        expect(canConnect('text', 'out-text', target as NodeTypeId, 'in-text')).toBe(true)
      }
    }
  })

  it('生图/图片 → 生图参考图 / 视频首帧', () => {
    expect(canConnect('image', 'out-image', 'image-gen', 'in-image')).toBe(true)
    expect(canConnect('image', 'out-image', 'video', 'in-image')).toBe(true)
    expect(canConnect('image-gen', 'out-image', 'image-gen', 'in-image')).toBe(true)
    expect(canConnect('image-gen', 'out-image', 'video', 'in-image')).toBe(true)
  })

  it('对话 markdown 输出 → 文本输入（text 与 markdown 互连）', () => {
    expect(canConnect('chat', 'out-markdown', 'text', 'in-text')).toBe(true)
    expect(canConnect('chat', 'out-markdown', 'image-gen', 'in-text')).toBe(true)
  })

  it('JSON → JSON（json.any 通用互通）', () => {
    expect(canConnect('json', 'out-json', 'json', 'in-json')).toBe(true)
    expect(canConnect('json', 'out-json', 'code', 'in-json')).toBe(true)
  })

  it('结构数据的提示词包 → 图片/视频的明确提示词包端口', () => {
    expect(canConnect('structured', 'out-json', 'image-gen', 'in-prompt')).toBe(true)
    expect(canConnect('structured', 'out-json', 'video', 'in-prompt')).toBe(true)
  })

  it('分镜板 storyboard.shots → 分镜板（同 Schema 完全匹配）', () => {
    expect(canConnect('storyboard', 'out-json', 'storyboard', 'in-json')).toBe(true)
  })

  it('分镜板 storyboard.shots → JSON 节点（json.any 放行具体 Schema）', () => {
    expect(canConnect('storyboard', 'out-json', 'json', 'in-json')).toBe(true)
  })

  it('JSON json.any → 分镜板（通用进具体，运行时再校验）', () => {
    expect(canConnect('json', 'out-json', 'storyboard', 'in-json')).toBe(true)
  })

  it('处理节点 any 输出 → 任意类型输入', () => {
    expect(canConnect('processor', 'out-value', 'text', 'in-text')).toBe(true)
    expect(canConnect('processor', 'out-value', 'image-gen', 'in-image')).toBe(true)
    expect(canConnect('processor', 'out-value', 'json', 'in-json')).toBe(true)
  })
})

describe('标准连线 · 拒绝的组合', () => {
  it('图片 → 文本输入（image 不能进 text）', () => {
    expect(canConnect('image', 'out-image', 'text', 'in-text')).toBe(false)
    expect(canConnect('image', 'out-image', 'chat', 'in-text')).toBe(false)
  })

  it('文本 → 图片输入（text 不能进 image）', () => {
    expect(canConnect('text', 'out-text', 'image-gen', 'in-image')).toBe(false)
    expect(canConnect('text', 'out-text', 'video', 'in-image')).toBe(false)
  })

  it('视频 → 图片输入（video 不能进 image，严格匹配）', () => {
    expect(canConnect('video', 'out-video', 'image-gen', 'in-image')).toBe(false)
  })

  it('图片 → 视频输入（image 不能进 video）', () => {
    expect(canConnect('image', 'out-image', 'video', 'in-video')).toBe(false)
  })

  it('文本 → JSON 输入（text 不能直接进 json，需经解析节点）', () => {
    expect(canConnect('text', 'out-text', 'json', 'in-json')).toBe(false)
  })

  it('JSON → 文本输入（json 不能直接进 text，需经格式化节点）', () => {
    expect(canConnect('json', 'out-json', 'text', 'in-text')).toBe(false)
  })

  it('音频 → 图片/视频输入（媒体类型严格匹配）', () => {
    expect(canConnect('audio', 'out-audio', 'image-gen', 'in-image')).toBe(false)
    expect(canConnect('audio', 'out-audio', 'video', 'in-image')).toBe(false)
  })
})

describe('端口类型兼容矩阵完整性', () => {
  // 枚举所有 PortType 两两组合，固化兼容规则（防 portCompatible 被误改）
  const types: PortType[] = ['text', 'markdown', 'json', 'image', 'video', 'audio', 'file', 'any']

  // 期望兼容的真值表：同行=兼容；text<->markdown；any 与全部
  function expected(a: PortType, b: PortType): boolean {
    if (a === b) return true
    if (a === 'any' || b === 'any') return true
    const textual = (t: PortType): boolean => t === 'text' || t === 'markdown'
    return textual(a) && textual(b)
  }

  it.each(types.flatMap((a) => types.map((b) => [a, b] as const)))(
    '%s ↔ %s 兼容性与真值表一致',
    (a, b) => {
      expect(portCompatible(a, b)).toBe(expected(a, b))
    }
  )
})
