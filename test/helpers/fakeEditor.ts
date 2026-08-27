// 测试用最小 fake tldraw Editor（R0 测试计划 T5/T6）。
//
// 只实现 deriveGraph / runWorkflow / runNodeManually 路径上实际触达的接口，
// 让图派生与运行编排可以在 Node 测试进程跑通，不依赖真实 tldraw 运行时。
import type { Editor, TLShapeId } from 'tldraw'

interface FakeBinding {
  fromId: string
  toId: string
  props: { terminal: 'start' | 'end' }
}

interface FakeShape {
  id: string
  type: string
  x: number
  y: number
  props: Record<string, unknown>
  meta?: Record<string, unknown>
}

export class FakeEditor {
  shapes = new Map<string, FakeShape>()
  bindings: FakeBinding[] = []

  addNode(id: string, props: Record<string, unknown>, x = 0, y = 0): FakeShape {
    const shape: FakeShape = { id, type: 'node-card', x, y, props, meta: {} }
    this.shapes.set(id, shape)
    return shape
  }

  addArrow(
    id: string,
    fromPort: string,
    toPort: string,
    fromId: string,
    toId: string,
    meta?: Record<string, unknown>
  ): void {
    this.shapes.set(id, {
      id,
      type: 'arrow',
      x: 0,
      y: 0,
      props: {},
      meta: { fromPort, toPort, ...meta }
    })
    this.bindings.push({ fromId: id, toId: fromId, props: { terminal: 'start' } })
    this.bindings.push({ fromId: id, toId, props: { terminal: 'end' } })
  }

  getCurrentPageShapes(): FakeShape[] {
    return [...this.shapes.values()]
  }

  getShape(id: string | TLShapeId): FakeShape | undefined {
    return this.shapes.get(id as string)
  }

  getBindingsFromShape(id: string | TLShapeId): FakeBinding[] {
    return this.bindings.filter((b) => b.fromId === (id as string))
  }

  getSortedChildIdsForParent(): string[] {
    return []
  }

  updateShape(patch: {
    id: string
    props?: Record<string, unknown>
    meta?: Record<string, unknown>
  }): void {
    const shape = this.shapes.get(patch.id)
    if (!shape) return
    if (patch.props) shape.props = { ...shape.props, ...patch.props }
    if (patch.meta) shape.meta = { ...shape.meta, ...patch.meta }
  }

  markHistoryStoppingPoint(): void {
    // 撤销分段点在 fake 中不生效
  }

  asEditor(): Editor {
    return this as unknown as Editor
  }
}

/** 标准节点卡片 props（与 NodeCardUtil.getDefaultProps 对齐的测试便捷构造） */
export function nodeProps(
  over: Partial<Record<string, unknown>> & { nodeType: string }
): Record<string, unknown> {
  return {
    w: 340,
    h: 260,
    title: over.nodeType,
    text: '',
    mediaId: '',
    mediaPath: '',
    mediaMime: '',
    exec: 'idle',
    ...over
  }
}
