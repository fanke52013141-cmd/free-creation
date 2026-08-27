// @vitest-environment jsdom
// T6 · deriveGraph 未知端口标记测试（R0/WP2）
//
// 验证：未知端口的边保留在数据中并标记 meta.flagged='unknown-port'；
// 未知 nodeType 节点的边同样被标记；合法端口不标记；shapes 顺序不影响判定。
import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { FakeEditor, nodeProps } from './helpers/fakeEditor'
import { deriveGraph } from '@renderer/canvas/graph'

beforeAll(() => {
  registerAllNodeTypes()
})

describe('deriveGraph · 未知端口标记', () => {
  it('边引用当前版本不存在的端口时标记 flagged', () => {
    const ed = new FakeEditor()
    ed.addNode('shape:a', nodeProps({ nodeType: 'text', text: 'hi' }))
    ed.addNode(
      'shape:b',
      nodeProps({ nodeType: 'image-gen', text: JSON.stringify({ prompt: 'cat' }) })
    )
    // text 的输出端口是 out-text，这里故意写成不存在的 out-gone
    ed.addArrow('shape:e1', 'out-gone', 'in-text', 'shape:a', 'shape:b')
    ed.addArrow('shape:e2', 'out-text', 'in-nowhere', 'shape:a', 'shape:b')

    const graph = deriveGraph(ed.asEditor())
    expect(graph.edges).toHaveLength(2)
    expect(graph.edges.every((e) => e.meta?.flagged === 'unknown-port')).toBe(true)
  })

  it('合法端口引用不标记', () => {
    const ed = new FakeEditor()
    ed.addNode('shape:a', nodeProps({ nodeType: 'text', text: 'hi' }))
    ed.addNode(
      'shape:b',
      nodeProps({ nodeType: 'image-gen', text: JSON.stringify({ prompt: 'cat' }) })
    )
    ed.addArrow('shape:e', 'out-text', 'in-text', 'shape:a', 'shape:b')

    const graph = deriveGraph(ed.asEditor())
    expect(graph.edges[0].meta).toBeUndefined()
  })

  it('未知 nodeType 节点（端口集为空）的边自然被标记', () => {
    const ed = new FakeEditor()
    ed.addNode('shape:f', nodeProps({ nodeType: 'future-node' }))
    ed.addNode('shape:b', nodeProps({ nodeType: 'text' }))
    ed.addArrow('shape:e', 'out-text', 'in-text', 'shape:f', 'shape:b')

    const graph = deriveGraph(ed.asEditor())
    expect(graph.edges[0].meta?.flagged).toBe('unknown-port')
    // 节点本身保留（冻结占位由渲染层负责），契约版本回退 1
    expect(graph.nodes.find((n) => n.id === 'shape:f')?.contractVersion).toBe(1)
  })

  it('shapes 顺序不影响判定（arrow 先于 node-card 也不误标记）', () => {
    const ed = new FakeEditor()
    ed.addNode('shape:a', nodeProps({ nodeType: 'text', text: 'hi' }))
    ed.addNode(
      'shape:b',
      nodeProps({ nodeType: 'image-gen', text: JSON.stringify({ prompt: 'cat' }) })
    )
    ed.addArrow('shape:e', 'out-text', 'in-text', 'shape:a', 'shape:b')
    // 交换内部顺序：arrow 排最前
    const arrow = ed.shapes.get('shape:e')!
    ed.shapes.delete('shape:e')
    ed.shapes.set('shape:e', arrow)
    const ordered = new Map([
      ['shape:e', arrow],
      ...[...ed.shapes.entries()].filter(([k]) => k !== 'shape:e')
    ])
    ed.shapes = ordered

    const graph = deriveGraph(ed.asEditor())
    expect(graph.edges[0].meta).toBeUndefined()
  })
})

describe('collectContractInputs · flagged 边端口级错误（运行期拦截）', () => {
  it('flagged 边产出明确错误且不参与输入收集', async () => {
    const { collectContractInputs } = await import('@renderer/engine/contracts')
    const ed = new FakeEditor()
    ed.addNode('shape:a', nodeProps({ nodeType: 'text', text: 'hi' }))
    ed.addNode(
      'shape:b',
      nodeProps({ nodeType: 'image-gen', text: JSON.stringify({ prompt: 'cat' }) })
    )
    ed.addArrow('shape:e', 'out-gone', 'in-text', 'shape:a', 'shape:b')

    const graph = deriveGraph(ed.asEditor())
    const node = graph.nodes.find((n) => n.id === 'shape:b')!
    const result = collectContractInputs(node, graph.edges, new Map())
    expect(result.errors.join()).toContain('不存在')
    expect(result.errors.join()).toContain('冻结')
  })
})
