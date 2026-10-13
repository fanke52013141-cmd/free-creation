// @vitest-environment jsdom
import { beforeAll, expect, it } from 'vitest'
import type { Editor, TLShape } from 'tldraw'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { getNodeType } from '../src/renderer/src/nodes/registry'
import { deriveGraph, portPairCompatible } from '../src/renderer/src/canvas/graph'
import type { NodeCardShape } from '../src/renderer/src/canvas/NodeCardShape'
import type { NodeExecutionContext } from '../src/shared/engine/executor-types'
import { getExecutor } from '../src/shared/engine/executors'
import { deriveNodeReadiness } from '../src/renderer/src/canvas/node-readiness'

beforeAll(registerAllNodeTypes)
it('C1 configuration is retained in the graph and control relations never become data edges', () => {
  const shapes = ['agent', 'state-machine', 'ai-review'].map((type, index) => {
    const spec = getNodeType(type as 'agent')!
    const config = {
      ...JSON.parse(spec.initialConfig!),
      relations: [
        {
          relationId: 'relation',
          kind: 'observes',
          sourceNodeId: 'shape:agent',
          targetNodeId: 'shape:ai-review'
        }
      ]
    }
    return {
      id: `shape:${type}`,
      type: 'node-card',
      index: `a${index + 1}`,
      x: index * 420,
      y: 0,
      props: {
        nodeType: type,
        title: spec.label,
        w: 340,
        h: 260,
        text: 'Goal or standard',
        config: JSON.stringify(config),
        mediaId: '',
        mediaPath: '',
        mediaMime: '',
        exec: 'idle'
      },
      meta: {}
    }
  })
  const restored = JSON.parse(JSON.stringify(shapes)) as TLShape[]
  const editor = {
    getCurrentPageShapes: () => restored,
    getShape: (id: string) => restored.find((shape) => shape.id === id)
  } as unknown as Editor
  const graph = deriveGraph(editor)
  expect(graph.edges).toEqual([])
  for (const node of graph.nodes) {
    const source = shapes.find((shape) => shape.id === node.id)!
    expect(node.params.config).toBe(source.props.config)
    expect(node.content).toEqual({ kind: 'text', text: source.props.text })
  }
})
it('state/review configuration-only nodes cannot call gateways or mutate state and show blocked readiness', async () => {
  for (const type of ['state-machine', 'ai-review'] as const) {
    const spec = getNodeType(type)!
    const context = new Proxy(
      {},
      {
        get: () => {
          throw new Error('C1 must not access execution context')
        }
      }
    ) as NodeExecutionContext
    expect(await getExecutor(type)!(context)).toEqual({
      status: 'skipped',
      reason: spec.executionDisabledReason
    })
    expect(
      spec.projectOutputs!({ meta: { nodeResult: 'old result' } } as unknown as NodeCardShape)
    ).toEqual({})
    expect(
      deriveNodeReadiness({
        executionMode: 'auto',
        exec: 'idle',
        inputs: spec.ports.in,
        incomingCounts: new Map(),
        outputs: {},
        configIssue: spec.executionDisabledReason
      }).kind
    ).toBe('blocked')
  }
})
it('Agent uses the same public/shared executor and cannot fabricate outputs without its desktop host', async () => {
  const spec = getNodeType('agent')!
  expect(getExecutor('agent')).toBe(spec.executor)
  expect(spec.executionDisabledReason).toBeUndefined()
  expect(await getExecutor('agent')!({ gateway: {} } as NodeExecutionContext)).toMatchObject({
    status: 'failed'
  })
  expect(
    spec.projectOutputs!({ meta: { nodeResult: 'old result' } } as unknown as NodeCardShape)
  ).toEqual({})
})
it('review JSON and feedback connect through declared compatible ports', () => {
  const review = getNodeType('ai-review')!
  const agent = getNodeType('agent')!
  expect(
    portPairCompatible(
      review.ports.out.find((port) => port.id === 'out-review')!,
      agent.ports.in.find((port) => port.id === 'in-json')!
    )
  ).toBe(true)
  expect(
    portPairCompatible(
      review.ports.out.find((port) => port.id === 'out-feedback')!,
      agent.ports.in.find((port) => port.id === 'in-text')!
    )
  ).toBe(true)
})
