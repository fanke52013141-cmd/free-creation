import { describe, expect, it } from 'vitest'
import type { CanvasEdge, CanvasNode } from '../src/shared/types'
import { topoSort } from '../src/renderer/src/engine/topology'

function node(id: string): CanvasNode {
  return {
    id,
    type: 'text',
    contractVersion: 1,
    title: id,
    x: 0,
    y: 0,
    w: 340,
    h: 200,
    ports: [],
    params: {},
    content: { kind: 'text', text: id },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 0 }
  }
}

function edge(from: string, to: string): CanvasEdge {
  return {
    id: `${from}->${to}`,
    from: { nodeId: from, portId: 'out-text' },
    to: { nodeId: to, portId: 'in-text' }
  }
}

describe('topoSort', () => {
  it('returns a stable dependency-first order', () => {
    const result = topoSort({
      nodes: ['a', 'b', 'c'].map(node),
      edges: [edge('a', 'c'), edge('b', 'c')]
    })
    expect(result?.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns null when the graph contains a cycle', () => {
    expect(
      topoSort({
        nodes: ['a', 'b'].map(node),
        edges: [edge('a', 'b'), edge('b', 'a')]
      })
    ).toBeNull()
  })

  it('ignores stale edge references without invalidating the graph', () => {
    const result = topoSort({ nodes: [node('a')], edges: [edge('missing', 'a')] })
    expect(result?.map((item) => item.id)).toEqual(['a'])
  })
})
