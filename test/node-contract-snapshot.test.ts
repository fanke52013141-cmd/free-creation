// 节点契约快照测试（路线图 R2 / 契约规范 P0-P3）
// @vitest-environment jsdom
//
// 这是 R2 的核心门禁：把每个已注册节点的端口契约固化为快照。任何端口 ID、类型、
// 必填性、数量或 Schema 的破坏性变化都必须在这里被捕获——这正是 R2 的完成标准
// 「破坏端口 ID 而不提升契约版本时测试失败」。
import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { allNodeTypes, getNodeType } from '@renderer/nodes/registry'
import type { NodeTypeId, PortDecl } from '@shared/types'

beforeAll(() => {
  registerAllNodeTypes()
})

/** 把端口契约投影成可快照、可断言的纯数据结构（剥离 Body 等非契约字段）。 */
function snapshotPorts(ports: PortDecl[]): Array<Record<string, unknown>> {
  return ports
    .map((p) => ({
      id: p.id,
      dir: p.dir,
      type: p.type,
      required: p.required,
      cardinality: p.cardinality,
      ...(p.schema ? { schema: `${p.schema.id}@${p.schema.version}` } : {})
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

describe('全部标准节点都已注册', () => {
  const expected: NodeTypeId[] = [
    'text',
    'image',
    'image-gen',
    'video',
    'audio',
    'chat',
    'processor',
    'json',
    'code',
    'storyboard',
    'ai-process',
    'iterate',
    'director'
  ]

  it.each(expected)('节点 %s 可通过 allNodeTypes 暴露（可创建）', (type) => {
    expect(allNodeTypes().some((s) => s.type === type)).toBe(true)
  })

  it('script 节点仍保留兼容但不可新建（creatable=false）', () => {
    const spec = getNodeType('script')
    expect(spec).toBeDefined()
    expect(spec?.creatable).toBe(false)
    expect(allNodeTypes().some((s) => s.type === 'script')).toBe(false)
  })

  it('退役的 group / compose 节点不在注册表中', () => {
    expect(getNodeType('group')).toBeUndefined()
    expect(getNodeType('compose')).toBeUndefined()
  })
})

describe('端口契约快照 · 每个端口 ID 稳定且符合命名规范', () => {
  beforeAll(() => registerAllNodeTypes())

  const types = [
    'text',
    'image',
    'image-gen',
    'video',
    'audio',
    'chat',
    'processor',
    'json',
    'code',
    'storyboard',
    'script',
    'ai-process',
    'iterate',
    'director'
  ] as NodeTypeId[]

  it.each(types)('节点 %s 的端口 ID 命名合规', (type) => {
    const spec = getNodeType(type)
    expect(spec).toBeDefined()
    for (const port of [...spec!.ports.in, ...spec!.ports.out]) {
      expect(port.id).toMatch(new RegExp(`^${port.dir}-[a-z0-9]+(-[a-z0-9]+)*$`))
    }
  })

  it.each(types)('节点 %s 无重复端口 ID', (type) => {
    const spec = getNodeType(type)
    const ids = [...spec!.ports.in, ...spec!.ports.out].map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(types)('节点 %s 的契约版本为正整数', (type) => {
    const spec = getNodeType(type)
    expect(spec!.contractVersion).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(spec!.contractVersion)).toBe(true)
  })

  it.each(types)('节点 %s 每个 JSON 端口都声明了已注册 Schema', (type) => {
    const spec = getNodeType(type)
    for (const port of [...spec!.ports.in, ...spec!.ports.out]) {
      if (port.type === 'json') {
        expect(port.schema, `${port.id} 缺少 schema`).toBeDefined()
      } else {
        expect(port.schema, `${port.id} 非 JSON 端口不应有 schema`).toBeUndefined()
      }
    }
  })
})

describe('关键端口契约快照（防回归）', () => {
  beforeAll(() => registerAllNodeTypes())

  it('文本节点：in-text(many) → out-text', () => {
    const spec = getNodeType('text')!
    expect(snapshotPorts(spec.ports.in)).toEqual([
      { id: 'in-text', dir: 'in', type: 'text', required: false, cardinality: 'many' }
    ])
    expect(snapshotPorts(spec.ports.out)).toEqual([
      { id: 'out-text', dir: 'out', type: 'text', required: true, cardinality: 'one' }
    ])
  })

  it('生图节点：in-image(one) + in-text(many) → out-image', () => {
    const spec = getNodeType('image-gen')!
    const ins = snapshotPorts(spec.ports.in)
    expect(ins.find((p) => p.id === 'in-image')).toEqual({
      id: 'in-image',
      dir: 'in',
      type: 'image',
      required: false,
      cardinality: 'one'
    })
    expect(ins.find((p) => p.id === 'in-text')?.cardinality).toBe('many')
    expect(snapshotPorts(spec.ports.out)[0].type).toBe('image')
  })

  it('JSON 节点端口带 storyboard-independent 的 json.any Schema', () => {
    const spec = getNodeType('json')!
    const jsonOut = spec.ports.out.find((p) => p.id === 'out-json')!
    expect(jsonOut.schema).toEqual({ id: 'json.any', version: 1 })
  })

  it('分镜板输入/输出都绑定 storyboard.shots@1 Schema', () => {
    const spec = getNodeType('storyboard')!
    const inJson = spec.ports.in.find((p) => p.id === 'in-json')!
    const outJson = spec.ports.out.find((p) => p.id === 'out-json')!
    expect(inJson.schema).toEqual({ id: 'storyboard.shots', version: 1 })
    expect(outJson.schema).toEqual({ id: 'storyboard.shots', version: 1 })
  })

  it('对话节点输出为 markdown 类型', () => {
    const spec = getNodeType('chat')!
    expect(spec.ports.out[0].type).toBe('markdown')
    expect(spec.ports.out[0].id).toBe('out-markdown')
  })

  it('代码节点以默认 out-output 作为静态契约，实例可解析为命名输出端口', () => {
    const spec = getNodeType('code')!
    expect(spec.contractVersion).toBe(2)
    expect(snapshotPorts(spec.ports.out)).toEqual([
      { id: 'out-output', dir: 'out', type: 'any', required: true, cardinality: 'one' }
    ])
  })

  it('处理节点使用 any 类型端口（仅通用处理类允许）', () => {
    const spec = getNodeType('processor')!
    expect(spec.ports.in[0].type).toBe('any')
    expect(spec.ports.out[0].type).toBe('any')
  })

  it('AI 处理节点：in-text(many) + in-json(one) → out-text/out-markdown/out-json(均可选)', () => {
    const spec = getNodeType('ai-process')!
    // 输入
    const inText = spec.ports.in.find((p) => p.id === 'in-text')!
    expect(inText.type).toBe('text')
    expect(inText.cardinality).toBe('many')
    const inJson = spec.ports.in.find((p) => p.id === 'in-json')!
    expect(inJson.type).toBe('json')
    expect(inJson.schema).toEqual({ id: 'json.any', version: 1 })
    // 输出：三个互斥输出均非必填
    for (const port of spec.ports.out) {
      expect(port.required).toBe(false)
    }
    const ids = spec.ports.out.map((p) => p.id).sort()
    expect(ids).toEqual(['out-json', 'out-markdown', 'out-text'])
  })

  it('迭代节点：in-list(list.items@1) → out-items(list.items@1)', () => {
    const spec = getNodeType('iterate')!
    const inList = spec.ports.in.find((p) => p.id === 'in-list')!
    expect(inList.type).toBe('json')
    expect(inList.schema).toEqual({ id: 'list.items', version: 1 })
    const outItems = spec.ports.out.find((p) => p.id === 'out-items')!
    expect(outItems.type).toBe('json')
    expect(outItems.schema).toEqual({ id: 'list.items', version: 1 })
  })

  it('导演台：分镜/参考图/机位输入，发布帧/视频/机位/工程摘要输出', () => {
    const spec = getNodeType('director')!
    expect(spec.executionMode).toBe('manual-publish')
    expect(spec.ports.in.map((port) => port.id).sort()).toEqual([
      'in-camera-preset',
      'in-reference-images',
      'in-storyboard'
    ])
    expect(spec.ports.out.map((port) => port.id).sort()).toEqual([
      'out-camera',
      'out-frame',
      'out-preview-video',
      'out-project'
    ])
    expect(spec.ports.in.find((port) => port.id === 'in-reference-images')?.cardinality).toBe(
      'many'
    )
    expect(spec.ports.out.find((port) => port.id === 'out-camera')?.schema).toEqual({
      id: 'previs.camera',
      version: 1
    })
  })
})
