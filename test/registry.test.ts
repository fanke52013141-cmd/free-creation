// 注册表纯函数测试（路线图 R2 / 契约规范 P0）
//
// 覆盖 registry.tsx 的端口兼容、端口落点、历史尺寸迁移判断。
// 这些是连线类型校验与旧快照兼容的底层规则，注册表会基于它们拒绝非法连线。
import { describe, it, expect } from 'vitest'
import {
  portCompatible,
  portOffsets,
  needsNodeSizeMigration,
  registerNodeType,
  getNodeType,
  unregisterNodeType,
  PORT_COLORS,
  type NodeTypeSpec
} from '@renderer/nodes/registry'

describe('portCompatible · 类型兼容矩阵', () => {
  it('相同类型可直连', () => {
    expect(portCompatible('text', 'text')).toBe(true)
    expect(portCompatible('image', 'image')).toBe(true)
    expect(portCompatible('json', 'json')).toBe(true)
    expect(portCompatible('video', 'video')).toBe(true)
  })

  it('text 与 markdown 可互连（保留语义类型）', () => {
    expect(portCompatible('text', 'markdown')).toBe(true)
    expect(portCompatible('markdown', 'text')).toBe(true)
    expect(portCompatible('markdown', 'markdown')).toBe(true)
  })

  it('any 与所有类型可连（目标节点仍需运行时验证）', () => {
    for (const t of ['text', 'markdown', 'json', 'image', 'video', 'audio', 'file'] as const) {
      expect(portCompatible('any', t)).toBe(true)
      expect(portCompatible(t, 'any')).toBe(true)
    }
  })

  it('不兼容的类型禁止直连（不得依赖执行器隐式转换）', () => {
    expect(portCompatible('json', 'text')).toBe(false)
    expect(portCompatible('text', 'json')).toBe(false)
    expect(portCompatible('image', 'video')).toBe(false)
    expect(portCompatible('image', 'text')).toBe(false)
    expect(portCompatible('audio', 'image')).toBe(false)
    expect(portCompatible('file', 'image')).toBe(false)
  })
})

describe('portOffsets · 端口纵向落点', () => {
  it('0 个端口返回空数组', () => {
    expect(portOffsets(0, 260)).toEqual([])
  })

  it('1 个端口居中', () => {
    expect(portOffsets(1, 260)).toEqual([130])
  })

  it('2 个端口落在 1/4 与 3/4', () => {
    expect(portOffsets(2, 260)).toEqual([65, 195])
  })

  it('3 个及以上按 n+1 等分', () => {
    const offsets = portOffsets(3, 240)
    expect(offsets).toHaveLength(3)
    expect(offsets).toEqual([60, 120, 180])
  })

  it('左右端口与连线锚点使用同一坐标公式', () => {
    // 同侧多端口时，连线锚点也用 portOffsets，保证视觉对齐。
    const left = portOffsets(2, 260)
    const right = portOffsets(2, 260)
    expect(left).toEqual(right)
  })
})

describe('needsNodeSizeMigration · 旧快照尺寸迁移', () => {
  it('识别误把画布坐标当缩略图的超大历史尺寸', () => {
    expect(needsNodeSizeMigration('image', 2880, 480)).toBe(true)
    expect(needsNodeSizeMigration('text', 520, 300)).toBe(true)
    expect(needsNodeSizeMigration('script', 3240, 640)).toBe(true)
  })

  it('识别规范化前的非统一默认尺寸', () => {
    expect(needsNodeSizeMigration('text', 320, 190)).toBe(true)
    expect(needsNodeSizeMigration('chat', 320, 210)).toBe(true)
  })

  it('识别统一 340×260 规范之前的旧默认值', () => {
    expect(needsNodeSizeMigration('text', 340, 200)).toBe(true)
    expect(needsNodeSizeMigration('json', 340, 230)).toBe(true)
  })

  it('不覆盖用户手动调整后的尺寸', () => {
    expect(needsNodeSizeMigration('text', 360, 280)).toBe(false)
    expect(needsNodeSizeMigration('image', 300, 220)).toBe(false)
  })

  it('对未知节点类型的超大尺寸仍兜底迁移', () => {
    expect(needsNodeSizeMigration('unknown', 1000, 500)).toBe(true)
    expect(needsNodeSizeMigration('unknown', 500, 800)).toBe(true)
  })
})

describe('PORT_COLORS · 每个端口类型都有配色', () => {
  it('覆盖全部 PortType', () => {
    for (const t of [
      'text',
      'markdown',
      'json',
      'image',
      'video',
      'audio',
      'file',
      'any'
    ] as const) {
      expect(PORT_COLORS[t]).toBeTruthy()
    }
  })
})

describe('registerNodeType · 注册时硬校验门禁', () => {
  // 构造一个最小合法 Spec 用于校验通过基线
  function validSpec(over: Partial<NodeTypeSpec> = {}): NodeTypeSpec {
    return {
      type: 'test-custom',
      contractVersion: 1,
      label: '测试',
      icon: 'text',
      color: '#fff',
      defaultSize: { w: 340, h: 260 },
      description: '测试用最小合法节点。',
      ports: {
        in: [
          {
            id: 'in-text',
            name: '文本',
            dir: 'in',
            type: 'text',
            required: false,
            cardinality: 'one',
            description: '输入文本'
          }
        ],
        out: [
          {
            id: 'out-text',
            name: '文本',
            dir: 'out',
            type: 'text',
            required: true,
            cardinality: 'one',
            description: '输出文本'
          }
        ]
      },
      Body: () => null as never,
      ...over
    }
  }

  afterEach(() => unregisterNodeType('test-custom'))

  it('合法 Spec 可注册并可查询', () => {
    registerNodeType(validSpec())
    expect(getNodeType('test-custom')?.type).toBe('test-custom')
  })

  it('拒绝契约版本小于 1', () => {
    expect(() => registerNodeType(validSpec({ contractVersion: 0 }))).toThrow(/contractVersion/)
  })

  it('拒绝错误的端口 ID 前缀（输入必须 in- 开头）', () => {
    expect(() =>
      registerNodeType(
        validSpec({
          ports: {
            in: [
              {
                id: 'input1',
                name: '文本',
                dir: 'in',
                type: 'text',
                required: false,
                cardinality: 'one',
                description: '错误前缀'
              }
            ],
            out: []
          }
        })
      )
    ).toThrow(/in-/)
  })

  it('拒绝 JSON 端口缺少 Schema', () => {
    expect(() =>
      registerNodeType(
        validSpec({
          ports: {
            in: [
              {
                id: 'in-data',
                name: '数据',
                dir: 'in',
                type: 'json',
                required: true,
                cardinality: 'one',
                description: 'JSON 无 schema'
              }
            ],
            out: []
          }
        })
      )
    ).toThrow(/schema/)
  })

  it('拒绝引用未注册 Schema 的 JSON 端口', () => {
    expect(() =>
      registerNodeType(
        validSpec({
          ports: {
            in: [
              {
                id: 'in-data',
                name: '数据',
                dir: 'in',
                type: 'json',
                required: true,
                cardinality: 'one',
                description: '未注册 schema',
                schema: { id: 'totally.unknown', version: 9 }
              }
            ],
            out: []
          }
        })
      )
    ).toThrow(/未注册/)
  })

  it('拒绝端口缺少业务说明', () => {
    expect(() =>
      registerNodeType(
        validSpec({
          ports: {
            in: [
              {
                id: 'in-text',
                name: '文本',
                dir: 'in',
                type: 'text',
                required: false,
                cardinality: 'one',
                description: ''
              }
            ],
            out: []
          }
        })
      )
    ).toThrow(/业务说明/)
  })

  it('拒绝重复端口 ID', () => {
    expect(() =>
      registerNodeType(
        validSpec({
          ports: {
            in: [
              {
                id: 'in-shared',
                name: 'A',
                dir: 'in',
                type: 'text',
                required: false,
                cardinality: 'one',
                description: 'a'
              }
            ],
            out: [
              {
                id: 'in-shared',
                name: 'B',
                dir: 'out',
                type: 'text',
                required: true,
                cardinality: 'one',
                description: 'b'
              }
            ]
          }
        })
      )
    ).toThrow(/重复/)
  })
})
