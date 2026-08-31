// 契约收集与校验测试（路线图 R2 / 契约规范 §6 统一执行协议）
// @vitest-environment jsdom
//
// 覆盖 contracts.ts 的 collectContractInputs 与 buildOutputPackets：
// 已连接上游未产生输出、类型不匹配、Schema 不兼容、单值端口被占用、
// 必填输入缺失等都必须产出端口级错误，而不是静默使用旧值或固定值。
import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { registerNodeType, unregisterNodeType } from '@renderer/nodes/registry'
import {
  collectContractInputs,
  buildOutputPackets,
  inputText,
  inputJson,
  inputValue,
  inputMedia,
  type ContractOutputs,
  type NodeValuePacket
} from '@renderer/engine/contracts'
import type { CanvasNode, CanvasEdge } from '@shared/types'
import type { NodeValue } from '@renderer/nodes/nodeValues'

beforeAll(() => {
  registerAllNodeTypes()
})

/** 构造最小 CanvasNode（端口来自注册表，确保与真实节点一致）。 */
function makeNode(
  id: string,
  type: CanvasNode['type'],
  over: Partial<CanvasNode> = {}
): CanvasNode {
  return {
    id,
    type,
    contractVersion: 1,
    title: id,
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [],
    params: {},
    content: { kind: 'empty' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 0 },
    ...over
  }
}

function makeEdge(
  id: string,
  from: string,
  fromPort: string,
  to: string,
  toPort: string
): CanvasEdge {
  return { id, from: { nodeId: from, portId: fromPort }, to: { nodeId: to, portId: toPort } }
}

/** 构造一个输出数据包（模拟上游节点已成功执行的输出）。 */
function makePacket(
  portType: NodeValuePacket['type'],
  value: NodeValue,
  schema?: NodeValuePacket['schema']
): NodeValuePacket {
  return {
    type: portType,
    value,
    ...(schema ? { schema } : {}),
    source: { nodeId: 'upstream', portId: 'out-x', runId: 'run-1' },
    createdAt: 0
  }
}

function outputsMap(nodeId: string, outs: ContractOutputs): Map<string, ContractOutputs> {
  return new Map([[nodeId, outs]])
}

describe('collectContractInputs · 缺失与无效输入', () => {
  it('已连接但上游未产生输出 → 报错（不静默使用旧值）', () => {
    const target = makeNode('t', 'text')
    const edge = makeEdge('e1', 'upstream', 'out-text', 't', 'in-text')
    // 上游 outputs 为空：没有产生 out-text
    const result = collectContractInputs(target, [edge], new Map())
    expect(result.errors.some((e) => e.includes('未产生'))).toBe(true)
  })

  it('连线指向不存在的输入端口 → 报错', () => {
    const target = makeNode('t', 'text')
    const edge = makeEdge('e1', 'u', 'out-text', 't', 'in-nonexistent')
    const outs = outputsMap('u', { 'out-text': makePacket('text', { kind: 'text', text: 'hi' }) })
    const result = collectContractInputs(target, [edge], outs)
    expect(result.errors.some((e) => e.includes('in-nonexistent'))).toBe(true)
  })

  it('必填输入未连线 → 报错（用临时注册的必填输入节点验证）', () => {
    // 标准节点的输入均默认非必填（节点用固定值兜底），因此这里临时注册一个
    // 带必填输入的自定义节点，专门验证必填校验逻辑本身。
    registerNodeType({
      type: 'test-required',
      contractVersion: 1,
      label: '必填测试',
      icon: 'text',
      color: '#fff',
      defaultSize: { w: 340, h: 260 },
      description: '测试必填输入校验。',
      category: 'input',
      ports: {
        in: [
          {
            id: 'in-required',
            name: '必填',
            dir: 'in',
            type: 'text',
            required: true,
            cardinality: 'one',
            description: '必填输入'
          }
        ],
        out: []
      },
      Body: () => null as never
    })
    try {
      const target = makeNode('t', 'test-required')
      const result = collectContractInputs(target, [], new Map())
      expect(result.errors.some((e) => e.includes('in-required') && e.includes('必需'))).toBe(true)
    } finally {
      unregisterNodeType('test-required')
    }
  })

  it('非必填输入未连线 → 不报错（标准节点输入默认可选）', () => {
    const target = makeNode('t', 'json')
    const result = collectContractInputs(target, [], new Map())
    expect(result.errors).toHaveLength(0)
  })
})

describe('collectContractInputs · 类型不匹配', () => {
  it('image 输出接入 text 输入 → 报错', () => {
    const target = makeNode('t', 'text')
    const edge = makeEdge('e1', 'u', 'out-image', 't', 'in-text')
    const outs = outputsMap('u', {
      'out-image': makePacket('image', {
        kind: 'image',
        mediaId: 'm',
        mediaPath: 'p',
        mime: 'image/png'
      })
    })
    const result = collectContractInputs(target, [edge], outs)
    expect(result.errors.some((e) => e.includes('text') && e.includes('image'))).toBe(true)
  })

  it('text 输出接入 image 输入 → 报错', () => {
    const target = makeNode('t', 'image-gen')
    const edge = makeEdge('e1', 'u', 'out-text', 't', 'in-image')
    const outs = outputsMap('u', { 'out-text': makePacket('text', { kind: 'text', text: 'x' }) })
    const result = collectContractInputs(target, [edge], outs)
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

describe('collectContractInputs · Schema 不兼容', () => {
  it('storyboard.shots 数据进入 json.any 输入 → 兼容（通用 JSON 放行，运行时再校验）', () => {
    const target = makeNode('t', 'json')
    const edge = makeEdge('e1', 'u', 'out-json', 't', 'in-json')
    const outs = outputsMap('u', {
      'out-json': makePacket(
        'json',
        { kind: 'json', data: { shots: [] } },
        {
          id: 'storyboard.shots',
          version: 1
        }
      )
    })
    const result = collectContractInputs(target, [edge], outs)
    expect(result.errors).toHaveLength(0)
  })

  it('json.any 数据进入 storyboard.shots 必填输入 → 兼容但运行时按目标 Schema 校验', () => {
    const target = makeNode('t', 'storyboard')
    const edge = makeEdge('e1', 'u', 'out-json', 't', 'in-json')
    const validShots = { kind: 'json', data: { shots: [{ id: 's1', scene: 'a' }] } } as NodeValue
    const outs = outputsMap('u', {
      'out-json': makePacket('json', validShots, { id: 'json.any', version: 1 })
    })
    const result = collectContractInputs(target, [edge], outs)
    expect(result.errors).toHaveLength(0)
  })

  it('错误分镜结构进入 storyboard 输入 → 运行时校验拦截', () => {
    const target = makeNode('t', 'storyboard')
    const edge = makeEdge('e1', 'u', 'out-json', 't', 'in-json')
    const badShots = { kind: 'json', data: { shots: '不是数组' } } as NodeValue
    const outs = outputsMap('u', {
      'out-json': makePacket('json', badShots, { id: 'json.any', version: 1 })
    })
    const result = collectContractInputs(target, [edge], outs)
    expect(result.errors.some((e) => e.includes('校验失败') || e.includes('shots'))).toBe(true)
  })
})

describe('collectContractInputs · 单值端口占用规则', () => {
  it('单值输入连接两条上游 → 报错', () => {
    const target = makeNode('t', 'image-gen')
    const edge1 = makeEdge('e1', 'u1', 'out-image', 't', 'in-image')
    const edge2 = makeEdge('e2', 'u2', 'out-image', 't', 'in-image')
    const imgVal = { kind: 'image', mediaId: 'm', mediaPath: 'p', mime: 'image/png' } as NodeValue
    const outs = new Map<string, ContractOutputs>([
      ['u1', { 'out-image': makePacket('image', imgVal) }],
      ['u2', { 'out-image': makePacket('image', imgVal) }]
    ])
    const result = collectContractInputs(target, [edge1, edge2], outs)
    expect(result.errors.some((e) => e.includes('单值') && e.includes('2'))).toBe(true)
  })

  it('多值文本输入接受多条上游并按稳定顺序合并', () => {
    const target = makeNode('t', 'text')
    const edge1 = makeEdge('e1', 'u1', 'out-text', 't', 'in-text')
    const edge2 = makeEdge('e2', 'u2', 'out-text', 't', 'in-text')
    const outs = new Map<string, ContractOutputs>([
      ['u1', { 'out-text': makePacket('text', { kind: 'text', text: '第一段' }) }],
      ['u2', { 'out-text': makePacket('text', { kind: 'text', text: '第二段' }) }]
    ])
    const result = collectContractInputs(target, [edge1, edge2], outs)
    expect(result.errors).toHaveLength(0)
    expect(inputText(result.value, 'in-text')).toBe('第一段\n\n---\n\n第二段')
  })
})

describe('collectContractInputs · 成功路径', () => {
  it('动态注入遵循目标端口和 Schema，且可忽略其控制连线', () => {
    const target = makeNode('t', 'json')
    const control = makeEdge('control', 'iterate', 'out-item', 't', 'in-json')
    const result = collectContractInputs(target, [control], new Map(), {
      ignoreEdgeIds: ['control'],
      injections: [
        {
          portId: 'in-json',
          packet: {
            type: 'json',
            value: { kind: 'json', data: { shot: 's1' } },
            schema: { id: 'json.any', version: 1 },
            source: { nodeId: 'iterate', portId: 'out-item', runId: 'run-1' },
            createdAt: 0
          }
        }
      ]
    })
    expect(result.errors).toHaveLength(0)
    expect(inputJson(result.value, 'in-json')).toEqual([{ shot: 's1' }])
  })

  it('兼容输入正确填充到目标 portId', () => {
    const target = makeNode('t', 'json')
    const edge = makeEdge('e1', 'u', 'out-json', 't', 'in-json')
    const outs = outputsMap('u', {
      'out-json': makePacket(
        'json',
        { kind: 'json', data: { a: 1 } },
        {
          id: 'json.any',
          version: 1
        }
      )
    })
    const result = collectContractInputs(target, [edge], outs)
    expect(result.errors).toHaveLength(0)
    expect(inputJson(result.value, 'in-json')).toEqual([{ a: 1 }])
  })

  it('any 端口接收任意类型值（inputValue 还原实际类型）', () => {
    const target = makeNode('t', 'processor')
    const edge = makeEdge('e1', 'u', 'out-json', 't', 'in-value')
    const outs = outputsMap('u', {
      'out-json': makePacket(
        'json',
        { kind: 'json', data: { x: 1 } },
        {
          id: 'json.any',
          version: 1
        }
      )
    })
    const result = collectContractInputs(target, [edge], outs)
    expect(result.errors).toHaveLength(0)
    const v = inputValue(result.value, 'in-value')
    expect(v?.kind).toBe('json')
  })

  it('media 输入按 kind 过滤（inputMedia 只返回匹配媒体类型）', () => {
    const target = makeNode('t', 'image-gen')
    const edge = makeEdge('e1', 'u', 'out-image', 't', 'in-image')
    const outs = outputsMap('u', {
      'out-image': makePacket('image', {
        kind: 'image',
        mediaId: 'm1',
        mediaPath: 'p1',
        mime: 'image/png'
      })
    })
    const result = collectContractInputs(target, [edge], outs)
    const media = inputMedia(result.value, 'in-image', 'image')
    expect(media).toHaveLength(1)
    expect(media[0].mediaId).toBe('m1')
  })
})

describe('buildOutputPackets · 输出契约校验', () => {
  it('产生了未声明的输出端口 → 报错', () => {
    const node = makeNode('n', 'text')
    const result = buildOutputPackets(node, { 'out-unknown': { kind: 'text', text: 'x' } }, 'r1')
    expect(result.errors.some((e) => e.includes('out-unknown'))).toBe(true)
  })

  it('输出类型与端口声明不匹配 → 报错', () => {
    const node = makeNode('n', 'image')
    const result = buildOutputPackets(
      node,
      {
        'out-image': { kind: 'text', text: '不是图片' }
      } as never,
      'r1'
    )
    expect(result.errors.some((e) => e.includes('image') && e.includes('text'))).toBe(true)
  })

  it('缺必填输出 → 报错', () => {
    const node = makeNode('n', 'text')
    const result = buildOutputPackets(node, {}, 'r1')
    expect(result.errors.some((e) => e.includes('out-text') && e.includes('必需'))).toBe(true)
  })

  it('JSON 输出不符合声明的 Schema → 报错', () => {
    const node = makeNode('n', 'storyboard')
    const result = buildOutputPackets(
      node,
      {
        'out-json': { kind: 'json', data: { shots: 'bad' } } as never
      },
      'r1'
    )
    expect(result.errors.some((e) => e.includes('storyboard.shots'))).toBe(true)
  })

  it('合法输出产生带来源的数据包', () => {
    const node = makeNode('n', 'text')
    const result = buildOutputPackets(node, { 'out-text': { kind: 'text', text: 'hi' } }, 'r1')
    expect(result.errors).toHaveLength(0)
    expect(result.value['out-text']?.value.kind).toBe('text')
    expect(result.value['out-text']?.source.runId).toBe('r1')
  })
})
