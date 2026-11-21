// @vitest-environment jsdom
// 同源节点 → 同一目标输入端口只保留一条连线（2026-11-21 用户裁决）：
// AI 处理切换输出类型后旧端口连线成了永远没有数据的死线（用户「测试」项目复现）；
// AI 对话 text/markdown 双端口输出同一回复，重复连线会把同一内容合并注入两次。
// 修复语义：createEdge 把「换输出端口重连同一输入口」定义为原子替换；
// migrateNodeOutputPortEdges 供输出类型切换迁移下游连线；
// gatherUpstreamText 对历史遗留重复线按「源节点 + 内容」兜底去重。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import {
  createEdge,
  gatherUpstreamText,
  migrateNodeOutputPortEdges,
  tryConnect
} from '../src/renderer/src/canvas/graph'
import type { NodeCardShape } from '../src/renderer/src/canvas/NodeCardShape'
import { registerNodeType, unregisterNodeType } from '../src/renderer/src/nodes/registry'
import { registerAllNodeTypes } from './helpers/registerNodes'

beforeAll(() => {
  registerAllNodeTypes()
  registerOneTextTarget()
  registerJsonTarget()
})

interface FakeBinding {
  props: { terminal: 'start' | 'end' }
  toId: TLShapeId
}

/** 记录型伪 editor：只实现连线创建/替换/迁移用到的最小 API。 */
function fakeEditor(shapes: Record<string, unknown>[]) {
  const bindings = new Map<TLShapeId, FakeBinding[]>()
  const editor = {
    getShape: (id: TLShapeId) =>
      shapes.find((shape) => (shape as { id?: TLShapeId }).id === id),
    getCurrentPageShapes: () => shapes,
    getBindingsFromShape: (id: TLShapeId) => bindings.get(id) ?? [],
    getShapePageBounds: (id: TLShapeId) => {
      const shape = editor.getShape(id) as { x: number; y: number } | undefined
      return shape ? { x: shape.x, y: shape.y, maxX: shape.x + 340, height: 260 } : null
    },
    createShape: (input: Record<string, unknown>) => {
      shapes.push(input)
    },
    createBinding: (input: { fromId: TLShapeId; toId: TLShapeId; props: { terminal: 'start' | 'end' } }) => {
      const list = bindings.get(input.fromId) ?? []
      list.push({ props: input.props, toId: input.toId })
      bindings.set(input.fromId, list)
    },
    deleteShape: (id: TLShapeId) => {
      const index = shapes.findIndex((shape) => (shape as { id?: TLShapeId }).id === id)
      if (index >= 0) shapes.splice(index, 1)
      bindings.delete(id)
    },
    deleteShapes: (ids: TLShapeId[]) => {
      for (const id of ids) editor.deleteShape(id)
    },
    run: (fn: () => void) => fn(),
    markHistoryStoppingPoint: () => undefined
  }
  return { editor: editor as unknown as Editor, bindings, shapes }
}

function card(id: TLShapeId, nodeType: string, title: string, extra: Partial<NodeCardShape['props']> = {}): NodeCardShape {
  return {
    id,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: `a${id}`,
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: 340,
      h: 260,
      nodeType,
      title,
      config: '',
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      ...extra
    }
  }
}

function arrow(
  id: TLShapeId,
  from: { node: TLShapeId; port: string },
  to: { node: TLShapeId; port: string }
): Record<string, unknown> {
  return {
    id,
    type: 'arrow',
    index: 'a1',
    x: 0,
    y: 0,
    meta: { fromPort: from.port, toPort: to.port }
  }
}

function seedBinding(
  bindings: Map<TLShapeId, FakeBinding[]>,
  arrowId: TLShapeId,
  from: TLShapeId,
  to: TLShapeId
): void {
  bindings.set(arrowId, [
    { props: { terminal: 'start' }, toId: from },
    { props: { terminal: 'end' }, toId: to }
  ])
}

function arrowsOnCanvas(shapes: Record<string, unknown>[]): Array<{ id: TLShapeId; meta: Record<string, unknown> }> {
  return shapes.filter((shape) => shape.type === 'arrow') as Array<{
    id: TLShapeId
    meta: Record<string, unknown>
  }>
}

/** 单值文本输入目标：验证 one 端口的占用与替换边界。 */
function registerOneTextTarget(): void {
  registerNodeType({
    type: 'test-one-text-target',
    contractVersion: 1,
    label: '单值文本目标',
    icon: 'text',
    color: '#888',
    defaultSize: { w: 340, h: 260 },
    description: '测试专用。',
    category: 'data',
    creatable: false,
    ports: {
      in: [
        {
          id: 'in-text',
          name: '文本',
          dir: 'in' as const,
          type: 'text',
          required: false,
          cardinality: 'one',
          description: '单值文本输入'
        }
      ],
      out: []
    },
    projectOutputs: () => ({}),
    Body: () => null as never
  })
}

/** JSON 输入目标：验证迁移遇到不兼容目标时保留旧线。 */
function registerJsonTarget(): void {
  registerNodeType({
    type: 'test-json-target',
    contractVersion: 1,
    label: 'JSON 目标',
    icon: 'text',
    color: '#888',
    defaultSize: { w: 340, h: 260 },
    description: '测试专用。',
    category: 'data',
    creatable: false,
    ports: {
      in: [
        {
          id: 'in-json',
          name: 'JSON',
          dir: 'in' as const,
          type: 'json',
          required: false,
          cardinality: 'many',
          description: '结构化输入',
          schema: { id: 'json.any', version: 1 }
        }
      ],
      out: []
    },
    projectOutputs: () => ({}),
    Body: () => null as never
  })
}

afterAll(() => {
  unregisterNodeType('test-one-text-target')
  unregisterNodeType('test-json-target')
})

describe('createEdge：同源节点换输出端口重连同一输入口按替换处理', () => {
  it('many 输入口：旧端口的死线被移除，只保留新端口的连线', () => {
    const ai = card(createShapeId('ai'), 'ai-process', 'AI 处理')
    const gen = card(createShapeId('gen'), 'image-gen', '生图')
    const oldArrow = arrow(createShapeId('old'), { node: ai.id, port: 'out-text' }, { node: gen.id, port: 'in-text' })
    const shapes = [ai, gen, oldArrow]
    const { editor, bindings } = fakeEditor(shapes)
    seedBinding(bindings, oldArrow.id as TLShapeId, ai.id, gen.id)

    const created = createEdge(
      editor,
      { shapeId: ai.id, portId: 'out-markdown' },
      { shapeId: gen.id, portId: 'in-text' }
    )

    expect(created).toBe(true)
    const arrows = arrowsOnCanvas(shapes)
    expect(arrows).toHaveLength(1)
    expect(arrows[0].meta.fromPort).toBe('out-markdown')
    expect(arrows[0].meta.toPort).toBe('in-text')
  })

  it('不同目标端口不受影响：同一源节点的两条连线可以各自存在', () => {
    const ai = card(createShapeId('ai'), 'ai-process', 'AI 处理')
    const genA = card(createShapeId('gen-a'), 'image-gen', '生图 A')
    const genB = card(createShapeId('gen-b'), 'image-gen', '生图 B')
    const oldArrow = arrow(createShapeId('old'), { node: ai.id, port: 'out-text' }, { node: genA.id, port: 'in-text' })
    const shapes = [ai, genA, genB, oldArrow]
    const { editor, bindings } = fakeEditor(shapes)
    seedBinding(bindings, oldArrow.id as TLShapeId, ai.id, genA.id)

    const created = createEdge(
      editor,
      { shapeId: ai.id, portId: 'out-markdown' },
      { shapeId: genB.id, portId: 'in-text' }
    )

    expect(created).toBe(true)
    expect(arrowsOnCanvas(shapes)).toHaveLength(2)
  })

  it('完全相同的连线仍然拒绝，不会重复创建', () => {
    const ai = card(createShapeId('ai'), 'ai-process', 'AI 处理')
    const gen = card(createShapeId('gen'), 'image-gen', '生图')
    const oldArrow = arrow(createShapeId('old'), { node: ai.id, port: 'out-text' }, { node: gen.id, port: 'in-text' })
    const shapes = [ai, gen, oldArrow]
    const { editor, bindings } = fakeEditor(shapes)
    seedBinding(bindings, oldArrow.id as TLShapeId, ai.id, gen.id)

    const created = createEdge(
      editor,
      { shapeId: ai.id, portId: 'out-text' },
      { shapeId: gen.id, portId: 'in-text' }
    )

    expect(created).toBe(false)
    expect(arrowsOnCanvas(shapes)).toHaveLength(1)
  })

  it('one 输入口：其他源节点的占用仍然拒绝，同源换端口则替换', () => {
    const text = card(createShapeId('text'), 'text', '文本来源')
    const ai = card(createShapeId('ai'), 'ai-process', 'AI 处理')
    const target = card(createShapeId('target'), 'test-one-text-target', '单值目标')
    const otherArrow = arrow(createShapeId('other'), { node: text.id, port: 'out-text' }, { node: target.id, port: 'in-text' })
    const shapes = [text, ai, target, otherArrow]
    const { editor, bindings } = fakeEditor(shapes)
    seedBinding(bindings, otherArrow.id as TLShapeId, text.id, target.id)

    const blocked = createEdge(
      editor,
      { shapeId: ai.id, portId: 'out-text' },
      { shapeId: target.id, portId: 'in-text' }
    )
    expect(blocked).toBe(false)
    expect(arrowsOnCanvas(shapes)).toHaveLength(1)

    // 用户断开其他来源后，同一源节点（AI 处理）换 out-text 重连 → 替换成功。
    editor.deleteShapes([otherArrow.id as TLShapeId])
    expect(arrowsOnCanvas(shapes)).toHaveLength(0)
    const mine = arrow(createShapeId('mine'), { node: ai.id, port: 'out-markdown' }, { node: target.id, port: 'in-text' })
    shapes.push(mine)
    seedBinding(bindings, mine.id as TLShapeId, ai.id, target.id)

    const replaced = createEdge(
      editor,
      { shapeId: ai.id, portId: 'out-text' },
      { shapeId: target.id, portId: 'in-text' }
    )
    expect(replaced).toBe(true)
    const arrows = arrowsOnCanvas(shapes)
    expect(arrows).toHaveLength(1)
    expect(arrows[0].meta.fromPort).toBe('out-text')
  })
})

/** 判断箭头是否从指定源节点出发（通过 bindings）。 */
function arrowsFrom(
  arrowId: TLShapeId,
  bindings: Map<TLShapeId, FakeBinding[]>,
  sourceId: TLShapeId
): boolean {
  return (bindings.get(arrowId) ?? []).some(
    (binding) => binding.props.terminal === 'start' && binding.toId === sourceId
  )
}

describe('tryConnect：拖线路径同样走替换语义', () => {
  it('换输出端口拖到已连接的目标节点，旧线被替换而不是叠加', () => {
    const ai = card(createShapeId('ai'), 'ai-process', 'AI 处理')
    const gen = card(createShapeId('gen'), 'image-gen', '生图')
    const oldArrow = arrow(createShapeId('old'), { node: ai.id, port: 'out-text' }, { node: gen.id, port: 'in-text' })
    const shapes = [ai, gen, oldArrow]
    const { editor, bindings } = fakeEditor(shapes)
    seedBinding(bindings, oldArrow.id as TLShapeId, ai.id, gen.id)

    const error = tryConnect(
      editor,
      { shapeId: ai.id, portId: 'out-markdown', portType: 'markdown' },
      gen.id,
      { x: 500, y: 130 }
    )

    expect(error).toBeNull()
    const arrows = arrowsOnCanvas(shapes)
    expect(arrows).toHaveLength(1)
    expect(arrows[0].meta.fromPort).toBe('out-markdown')
  })
})

describe('受控例外：代码/组合节点的具名动态输出不受替换影响', () => {
  function registerDynamicOutSource(): void {
    registerNodeType({
      type: 'test-dynamic-out-source',
      contractVersion: 1,
      label: '动态输出来源',
      icon: 'text',
      color: '#888',
      defaultSize: { w: 340, h: 260 },
      description: '测试专用：resolvePorts 生成两个具名输出。',
      category: 'data',
      creatable: false,
      ports: { in: [], out: [] },
      resolvePorts: () => ({
        in: [],
        out: [
          { id: 'out-a', name: '输出 A', dir: 'out' as const, type: 'text', required: false, cardinality: 'one', description: 'A' },
          { id: 'out-b', name: '输出 B', dir: 'out' as const, type: 'markdown', required: false, cardinality: 'one', description: 'B' }
        ]
      }),
      projectOutputs: () => ({}),
      Body: () => null as never
    })
  }

  it('同一节点的两个具名动态输出可以各连一条线到同一多值输入', () => {
    registerDynamicOutSource()
    const src = card(createShapeId('dyn'), 'test-dynamic-out-source', '动态来源')
    const gen = card(createShapeId('gen'), 'image-gen', '生图')

    const shapes: Record<string, unknown>[] = [src, gen]
    const { editor } = fakeEditor(shapes)

    expect(createEdge(editor, { shapeId: src.id, portId: 'out-a' }, { shapeId: gen.id, portId: 'in-text' })).toBe(true)
    expect(createEdge(editor, { shapeId: src.id, portId: 'out-b' }, { shapeId: gen.id, portId: 'in-text' })).toBe(true)
    expect(arrowsOnCanvas(shapes)).toHaveLength(2)
    unregisterNodeType('test-dynamic-out-source')
  })
})

describe('migrateNodeOutputPortEdges：输出类型切换的连线迁移', () => {
  it('text→markdown：旧端口连线迁移到新端口', () => {
    const ai = card(createShapeId('ai'), 'ai-process', 'AI 处理')
    const gen = card(createShapeId('gen'), 'image-gen', '生图')
    const oldArrow = arrow(createShapeId('old'), { node: ai.id, port: 'out-text' }, { node: gen.id, port: 'in-text' })
    const shapes = [ai, gen, oldArrow]
    const { editor, bindings } = fakeEditor(shapes)
    seedBinding(bindings, oldArrow.id as TLShapeId, ai.id, gen.id)

    const migrated = migrateNodeOutputPortEdges(editor, ai.id, 'out-text', 'out-markdown')

    expect(migrated).toBe(1)
    const arrows = arrowsOnCanvas(shapes)
    expect(arrows).toHaveLength(1)
    expect(arrows[0].meta.fromPort).toBe('out-markdown')
    expect(arrows[0].meta.toPort).toBe('in-text')
  })

  it('重复画布（新旧端口各一条线）：迁移后去重成一条', () => {
    const ai = card(createShapeId('ai'), 'ai-process', 'AI 处理')
    const gen = card(createShapeId('gen'), 'image-gen', '生图')
    const textArrow = arrow(createShapeId('a'), { node: ai.id, port: 'out-text' }, { node: gen.id, port: 'in-text' })
    const markdownArrow = arrow(createShapeId('b'), { node: ai.id, port: 'out-markdown' }, { node: gen.id, port: 'in-text' })
    const shapes = [ai, gen, textArrow, markdownArrow]
    const { editor, bindings } = fakeEditor(shapes)
    seedBinding(bindings, textArrow.id as TLShapeId, ai.id, gen.id)
    seedBinding(bindings, markdownArrow.id as TLShapeId, ai.id, gen.id)

    const migrated = migrateNodeOutputPortEdges(editor, ai.id, 'out-text', 'out-markdown')

    expect(migrated).toBe(1)
    const arrows = arrowsOnCanvas(shapes)
    expect(arrows).toHaveLength(1)
    expect(arrows[0].meta.fromPort).toBe('out-markdown')
  })

  it('目标端口不兼容新输出：保留旧线，不静默丢弃用户连线', () => {
    const ai = card(createShapeId('ai'), 'ai-process', 'AI 处理')
    const jsonTarget = card(createShapeId('json-target'), 'test-json-target', 'JSON 目标')
    const oldArrow = arrow(createShapeId('old'), { node: ai.id, port: 'out-json' }, { node: jsonTarget.id, port: 'in-json' })
    const shapes = [ai, jsonTarget, oldArrow]
    const { editor, bindings } = fakeEditor(shapes)
    seedBinding(bindings, oldArrow.id as TLShapeId, ai.id, jsonTarget.id)

    const migrated = migrateNodeOutputPortEdges(editor, ai.id, 'out-json', 'out-text')

    expect(migrated).toBe(0)
    const arrows = arrowsOnCanvas(shapes)
    expect(arrows).toHaveLength(1)
    expect(arrows[0].meta.fromPort).toBe('out-json')
  })
})

describe('gatherUpstreamText：历史遗留重复线按源节点内容去重', () => {
  it('AI 对话 text/markdown 双端口输出同一回复时只注入一次', () => {
    const chat = card(createShapeId('chat'), 'chat', 'AI 对话', {
      text: JSON.stringify({ messages: [{ role: 'assistant', content: '同一回复内容' }] })
    })
    const gen = card(createShapeId('gen'), 'image-gen', '生图')
    const textArrow = arrow(createShapeId('a'), { node: chat.id, port: 'out-text' }, { node: gen.id, port: 'in-text' })
    const markdownArrow = arrow(createShapeId('b'), { node: chat.id, port: 'out-markdown' }, { node: gen.id, port: 'in-text' })
    const shapes = [chat, gen, textArrow, markdownArrow]
    const { editor, bindings } = fakeEditor(shapes)
    seedBinding(bindings, textArrow.id as TLShapeId, chat.id, gen.id)
    seedBinding(bindings, markdownArrow.id as TLShapeId, chat.id, gen.id)

    const merged = gatherUpstreamText(editor, gen.id, 'in-text')

    expect(merged).toBe('同一回复内容')
  })

  it('不同源节点的相同文本仍然各自注入', () => {
    const chatA = card(createShapeId('chat-a'), 'chat', '对话 A', {
      text: JSON.stringify({ messages: [{ role: 'assistant', content: '相同文本' }] })
    })
    const chatB = card(createShapeId('chat-b'), 'chat', '对话 B', {
      text: JSON.stringify({ messages: [{ role: 'assistant', content: '相同文本' }] })
    })
    const gen = card(createShapeId('gen'), 'image-gen', '生图')
    const arrowA = arrow(createShapeId('a'), { node: chatA.id, port: 'out-text' }, { node: gen.id, port: 'in-text' })
    const arrowB = arrow(createShapeId('b'), { node: chatB.id, port: 'out-text' }, { node: gen.id, port: 'in-text' })
    const shapes = [chatA, chatB, gen, arrowA, arrowB]
    const { editor, bindings } = fakeEditor(shapes)
    seedBinding(bindings, arrowA.id as TLShapeId, chatA.id, gen.id)
    seedBinding(bindings, arrowB.id as TLShapeId, chatB.id, gen.id)

    const merged = gatherUpstreamText(editor, gen.id, 'in-text')

    expect(merged).toBe('相同文本\n$$$\n相同文本')
  })
})

describe('AI 处理设置面板：输出类型切换触发迁移', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/nodes/specs/bodies/aiProcess.tsx'), 'utf8')

  it('save 在模式变化时调用 migrateNodeOutputPortEdges，并把配置与迁移放进同一撤销步', () => {
    expect(source).toContain('migrateNodeOutputPortEdges(editor, shape.id, previousPort, nextPort)')
    expect(source).toContain("editor.markHistoryStoppingPoint('ai-process-config')")
  })
})
