// 连线兼容矩阵测试（路线图 R2 / 契约规范 §5 连线规则）
// @vitest-environment jsdom
//
// 连线的七重校验里，「类型兼容」与「Schema 兼容」是纯函数判断，是 createEdge /
// tryConnect 接受或拒绝连线的核心依据。这里把所有节点的实际输出→输入组合枚举，
// 固化允许与拒绝的连线矩阵，防止端口类型或 Schema 变化悄悄改变连线行为。
import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { getNodeType, portCompatible, allNodeTypes } from '@renderer/nodes/registry'
import { portPairCompatible } from '@renderer/canvas/graph'
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
  return portPairCompatible(fromPort, toPort)
}

describe('标准连线 · 允许的组合', () => {
  it('导演台发布机位只连接到 camera 输入，不混入工程 JSON', () => {
    expect(canConnect('director', 'out-camera', 'director', 'in-camera-preset')).toBe(true)
    expect(canConnect('director', 'out-project', 'director', 'in-camera-preset')).toBe(false)
  })

  it('文本 → 文本类节点（生图/视频/对话/配音/脚本/代码）', () => {
    const textOut = [
      'image-gen',
      'video',
      'chat',
      'speech',
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

  it('生图/图片 → 生图参考图 / 视频统一图片输入', () => {
    expect(canConnect('image', 'out-image', 'image-gen', 'in-images')).toBe(true)
    expect(canConnect('image', 'out-image', 'video', 'in-images')).toBe(true)
    expect(canConnect('image-gen', 'out-image', 'image-gen', 'in-images')).toBe(true)
    expect(canConnect('image-gen', 'out-image', 'video', 'in-images')).toBe(true)
    expect(canConnect('image', 'out-image', 'image-edit', 'in-image')).toBe(true)
    expect(canConnect('image-gen', 'out-image', 'image-edit', 'in-image')).toBe(true)
    expect(canConnect('image-crop', 'out-image', 'image-edit', 'in-image')).toBe(true)
    expect(canConnect('image', 'out-image', 'image-crop', 'in-image')).toBe(true)
    expect(canConnect('image-gen', 'out-image', 'image-crop', 'in-image')).toBe(true)
    expect(canConnect('image-crop', 'out-image', 'video', 'in-images')).toBe(true)
    expect(canConnect('image-split', 'out-image', 'video', 'in-images')).toBe(true)
    expect(canConnect('audio', 'out-audio', 'video', 'in-reference-audio')).toBe(true)
    expect(canConnect('image-split', 'out-images', 'iterate', 'in-list')).toBe(true)
    expect(canConnect('iterate', 'out-item', 'image-gen', 'in-images')).toBe(true)
  })

  it('视频 → 取帧 / 截取 / 提音（同一源视频生成新的类型明确资产）', () => {
    for (const target of ['video-frame', 'video-clip', 'video-audio'] as const) {
      expect(canConnect('video', 'out-video', target, 'in-video')).toBe(true)
    }
    expect(canConnect('video-clip', 'out-video', 'video-frame', 'in-video')).toBe(true)
  })

  it('预演视频 → 视频运动参考（真实 video 端口连接）', () => {
    expect(canConnect('director', 'out-preview-video', 'video', 'in-reference-video')).toBe(true)
  })

  it('对话 markdown 输出 → 文本输入（text 与 markdown 互连）', () => {
    expect(canConnect('chat', 'out-markdown', 'text', 'in-text')).toBe(true)
    expect(canConnect('chat', 'out-markdown', 'image-gen', 'in-text')).toBe(true)
    expect(canConnect('chat', 'out-markdown', 'image-edit', 'in-text')).toBe(true)
  })

  it('音频 / TTS → TTS 参考语音（audio 端口互连）', () => {
    expect(canConnect('audio', 'out-audio', 'tts', 'in-audio')).toBe(true)
    expect(canConnect('video-audio', 'out-audio', 'tts', 'in-audio')).toBe(true)
    expect(canConnect('tts', 'out-audio', 'tts', 'in-audio')).toBe(true)
  })

  it('文本 → TTS 合成文字（text 端口连接）', () => {
    expect(canConnect('text', 'out-text', 'tts', 'in-text')).toBe(true)
    expect(canConnect('text', 'out-text', 'speech', 'in-text')).toBe(true)
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
    expect(canConnect('processor', 'out-value', 'image-gen', 'in-images')).toBe(true)
    expect(canConnect('processor', 'out-value', 'json', 'in-json')).toBe(true)
  })
})

describe('标准连线 · 拒绝的组合', () => {
  it('图片/音频资产是纯源节点，不能将资产再连接到同类资产节点', () => {
    // 两个资产节点均没有输入端口；不存在“看起来连上、实际不消费”的中转关系。
    expect(canConnect('image', 'out-image', 'image', 'in-image')).toBe(false)
    expect(canConnect('audio', 'out-audio', 'audio', 'in-audio')).toBe(false)
  })

  it('图片 → 文本输入（image 不能进 text）', () => {
    expect(canConnect('image', 'out-image', 'text', 'in-text')).toBe(false)
    expect(canConnect('image', 'out-image', 'chat', 'in-text')).toBe(false)
  })

  it('文本 → 图片输入（text 不能进 image）', () => {
    expect(canConnect('text', 'out-text', 'image-gen', 'in-images')).toBe(false)
    expect(canConnect('text', 'out-text', 'video', 'in-images')).toBe(false)
  })

  it('视频 → 图片输入（video 不能进 image，严格匹配）', () => {
    expect(canConnect('video', 'out-video', 'image-gen', 'in-images')).toBe(false)
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
    expect(canConnect('audio', 'out-audio', 'image-gen', 'in-images')).toBe(false)
    expect(canConnect('audio', 'out-audio', 'video', 'in-images')).toBe(false)
    expect(canConnect('video', 'out-video', 'image-edit', 'in-image')).toBe(false)
  })
})

describe('端口类型兼容矩阵完整性', () => {
  // 枚举所有 PortType 两两组合，固化兼容规则（防 portCompatible 被误改）
  const types: PortType[] = [
    'text',
    'markdown',
    'json',
    'iteration',
    'camera',
    'image',
    'video',
    'audio',
    'file',
    'any'
  ]

  // 期望兼容的真值表：同行=兼容；text<->markdown；any 与全部
  function expected(a: PortType, b: PortType): boolean {
    if (a === b) return true
    if (a === 'any' || b === 'any') return true
    if (
      a === 'iteration' &&
      (b === 'json' || b === 'camera' || b === 'image' || b === 'video' || b === 'audio' || b === 'file')
    )
      return true
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

describe('端口对兼容 portPairCompatible（方向固定 out→in）', () => {
  // 回归：历史上 resolveTargetInputPort 曾把参数写反（(in, out)），导致
  // iterate.out-item（iteration）拖到兼容输入时高亮/菜单允许但实际建线被拒。
  // 当前项可作为普通 JSON，也可在列表项携带完整资产引用时作为媒体输入；反向不存在。
  it('iteration 输出 → JSON/媒体输入允许；json 输出 → iteration 输入拒绝', () => {
    expect(portPairCompatible({ type: 'iteration' }, { type: 'json' })).toBe(true)
    for (const type of ['image', 'video', 'audio', 'file'] as const) {
      expect(portPairCompatible({ type: 'iteration' }, { type })).toBe(true)
    }
    expect(portPairCompatible({ type: 'json' }, { type: 'iteration' })).toBe(false)
  })

  it('json↔json 需要同 Schema（json.any 除外）；缺 Schema 视为不兼容', () => {
    expect(
      portPairCompatible(
        { type: 'json', schema: { id: 'list.items', version: 1 } },
        { type: 'json', schema: { id: 'list.items', version: 1 } }
      )
    ).toBe(true)
    expect(
      portPairCompatible(
        { type: 'json', schema: { id: 'list.items', version: 1 } },
        { type: 'json', schema: { id: 'storyboard.shots', version: 1 } }
      )
    ).toBe(false)
    expect(
      portPairCompatible(
        { type: 'json', schema: { id: 'json.any', version: 1 } },
        { type: 'json', schema: { id: 'list.items', version: 1 } }
      )
    ).toBe(true)
    expect(
      portPairCompatible(
        { type: 'json' },
        { type: 'json', schema: { id: 'list.items', version: 1 } }
      )
    ).toBe(false)
  })

  it('camera↔camera 要求明确且相同的机位 Schema', () => {
    expect(
      portPairCompatible(
        { type: 'camera', schema: { id: 'previs.camera', version: 1 } },
        { type: 'camera', schema: { id: 'previs.camera', version: 1 } }
      )
    ).toBe(true)
    expect(
      portPairCompatible(
        { type: 'camera', schema: { id: 'previs.camera', version: 1 } },
        { type: 'camera', schema: { id: 'json.any', version: 1 } }
      )
    ).toBe(false)
    expect(portPairCompatible({ type: 'camera' }, { type: 'camera' })).toBe(false)
  })

  it('真实契约：iterate.out-item 可接入所有 json 类型输入（回归 bug 的完整链条）', () => {
    const iterate = getNodeType('iterate')
    const itemPort = iterate?.ports.out.find((port) => port.id === 'out-item')
    expect(itemPort?.type).toBe('iteration')
    // iteration 不是 json，schema 双重校验不参与；类型层必须对全部 JSON 输入放行。
    const jsonInputs = allNodeTypes().flatMap((spec) =>
      spec.ports.in.filter((port) => port.type === 'json').map((port) => ({ spec, port }))
    )
    expect(jsonInputs.length).toBeGreaterThan(0)
    for (const { spec, port } of jsonInputs) {
      expect(portPairCompatible({ type: 'iteration' }, port)).toBe(true)
      expect(spec.type).toBeTruthy()
    }
  })

  it('真实契约：iterate.out-item 可接入媒体端口，当前项类型在运行时校验', () => {
    const iterate = getNodeType('iterate')
    const itemPort = iterate?.ports.out.find((port) => port.id === 'out-item')
    expect(itemPort?.type).toBe('iteration')
    for (const type of ['image', 'video', 'audio', 'file'] as const) {
      expect(portPairCompatible({ type: 'iteration' }, { type })).toBe(true)
    }
  })
})
