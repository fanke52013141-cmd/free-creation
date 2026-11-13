import { describe, expect, it } from 'vitest'
import {
  CoordinationDecisionSchema,
  dispatchInputsSatisfied,
  type CoordinationContext
} from '../src/shared/agent-flow/coordination'
import { NodeCardUtil } from '../src/renderer/src/canvas/NodeCardShape'
import type { NodeCardShape } from '../src/renderer/src/canvas/NodeCardShape'

const REF = {
  assetId: 'asset-1',
  versionId: 'version-1',
  sourceNodeId: 'shape:src',
  sourcePortId: 'out-text'
}

function available(inputs: typeof REF[]): CoordinationContext['available'] {
  return [{ nodeId: 'shape:s1', goal: '写作', inputs }]
}

describe('二-1：无输入专家可分派（条件化最小输入）', () => {
  it('schema 允许空 inputs 的 dispatch 决策', () => {
    const parsed = CoordinationDecisionSchema.safeParse({
      kind: 'dispatch',
      nodeId: 'shape:s1',
      goal: '写初稿',
      completion: '产出初稿',
      inputs: []
    })
    expect(parsed.success).toBe(true)
  })

  it('候选无固定输入 + 空 inputs → 满足（无输入专家可分派）', () => {
    const decision = CoordinationDecisionSchema.parse({
      kind: 'dispatch',
      nodeId: 'shape:s1',
      goal: '写初稿',
      completion: '产出初稿',
      inputs: []
    })
    expect(dispatchInputsSatisfied(decision, available([]))).toBe(true)
  })

  it('候选有固定输入 + 空 inputs → 不满足（有输入不能空手分派）', () => {
    const decision = CoordinationDecisionSchema.parse({
      kind: 'dispatch',
      nodeId: 'shape:s1',
      goal: '写初稿',
      completion: '产出初稿',
      inputs: []
    })
    expect(dispatchInputsSatisfied(decision, available([REF]))).toBe(false)
  })

  it('候选有固定输入 + 携带引用 → 满足', () => {
    const decision = CoordinationDecisionSchema.parse({
      kind: 'dispatch',
      nodeId: 'shape:s1',
      goal: '写初稿',
      completion: '产出初稿',
      inputs: [REF]
    })
    expect(dispatchInputsSatisfied(decision, available([REF]))).toBe(true)
  })

  it('dispatch-many 逐路校验：一路有输入却空手 → 整体不满足', () => {
    const decision = CoordinationDecisionSchema.parse({
      kind: 'dispatch-many',
      assignments: [
        { nodeId: 'shape:s1', goal: 'a', completion: 'a', inputs: [] },
        { nodeId: 'shape:s2', goal: 'b', completion: 'b', inputs: [] }
      ]
    })
    const avail: CoordinationContext['available'] = [
      { nodeId: 'shape:s1', goal: 'a', inputs: [] },
      { nodeId: 'shape:s2', goal: 'b', inputs: [REF] }
    ]
    expect(dispatchInputsSatisfied(decision, avail)).toBe(false)
  })

  it('dispatch-many 全空输入候选 → 满足', () => {
    const decision = CoordinationDecisionSchema.parse({
      kind: 'dispatch-many',
      assignments: [
        { nodeId: 'shape:s1', goal: 'a', completion: 'a', inputs: [] },
        { nodeId: 'shape:s2', goal: 'b', completion: 'b', inputs: [] }
      ]
    })
    const avail: CoordinationContext['available'] = [
      { nodeId: 'shape:s1', goal: 'a', inputs: [] },
      { nodeId: 'shape:s2', goal: 'b', inputs: [] }
    ]
    expect(dispatchInputsSatisfied(decision, avail)).toBe(true)
  })

  it('finish/wait 决策恒满足', () => {
    const finish = CoordinationDecisionSchema.parse({ kind: 'finish', outputs: [REF] })
    const wait = CoordinationDecisionSchema.parse({ kind: 'wait' })
    expect(dispatchInputsSatisfied(finish, available([REF]))).toBe(true)
    expect(dispatchInputsSatisfied(wait, available([REF]))).toBe(true)
  })
})

describe('二-2：processor 新建默认透传（pass）', () => {
  const baseShape = {
    type: 'node-card',
    props: { nodeType: 'processor', config: '' }
  } as unknown as NodeCardShape

  it('空配置 processor 新建默认 operation=pass', () => {
    const created = NodeCardUtil.prototype.onBeforeCreate(baseShape)
    const config = JSON.parse(created.props.config) as { operation: string }
    expect(config.operation).toBe('pass')
  })

  it('已有配置的 processor 不被覆盖（用户显式 pick 保留）', () => {
    const explicit = {
      type: 'node-card',
      props: { nodeType: 'processor', config: '{"operation":"pick","path":"shots"}' }
    } as unknown as NodeCardShape
    const created = NodeCardUtil.prototype.onBeforeCreate(explicit)
    expect(JSON.parse(created.props.config).operation).toBe('pick')
  })

  it('非 processor 节点不受影响', () => {
    const text = {
      type: 'node-card',
      props: { nodeType: 'text', config: '' }
    } as unknown as NodeCardShape
    expect(NodeCardUtil.prototype.onBeforeCreate(text)).toBe(text)
  })
})