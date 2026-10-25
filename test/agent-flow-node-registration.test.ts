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
it('P2-A：状态机独立执行初始化权威实例，不访问网关，投影 flow.state', async () => {
  const spec = getNodeType('state-machine')!
  expect(spec.executionDisabledReason).toBeUndefined()
  // 网关一旦被访问立即抛错：状态机执行器不允许任何网关调用。
  const gateway = new Proxy(
    {},
    {
      get: () => {
        throw new Error('状态机执行器不得访问网关')
      }
    }
  )
  const props = {
    nodeType: 'state-machine',
    title: '状态机',
    config: spec.initialConfig!,
    text: '',
    mediaId: '',
    mediaPath: '',
    mediaMime: '',
    exec: 'idle',
    w: 340,
    h: 260
  }
  const meta: Record<string, unknown> = {}
  const result = await getExecutor('state-machine')!({
    node: { id: 'shape:state-machine', type: 'state-machine' },
    shape: { id: 'shape:state-machine', type: 'node-card', props, meta },
    projectId: 'project-a',
    runId: 'run-sm',
    providers: [],
    signal: { cancelled: false },
    gateway,
    updateMeta: (patch) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null) delete meta[key]
        else meta[key] = value
      }
    },
    updateResult: () => undefined
  } as unknown as NodeExecutionContext)
  expect(result).toEqual({ status: 'done' })
  const instance = JSON.parse(String(meta.stateMachine))
  expect(instance).toMatchObject({
    schemaVersion: 1,
    revision: 1,
    state: 'draft',
    stateNodeId: 'shape:state-machine'
  })
  // 投影只认真实运行结果；旧结果/空结果不产生输出。
  expect(
    spec.projectOutputs!({ meta: { nodeResult: 'old result' } } as unknown as NodeCardShape)
  ).toEqual({})
})
it('review uses the public executor and cannot fabricate a verdict without its trusted host', async () => {
  const spec = getNodeType('ai-review')!
  expect(getExecutor('ai-review')).toBe(spec.executor)
  expect(spec.executionDisabledReason).toBeUndefined()
  expect(await getExecutor('ai-review')!({ gateway: {} } as NodeExecutionContext)).toMatchObject({
    status: 'failed'
  })
  expect(
    spec.projectOutputs!({ meta: { nodeResult: 'old result' } } as unknown as NodeCardShape)
  ).toEqual({})
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
