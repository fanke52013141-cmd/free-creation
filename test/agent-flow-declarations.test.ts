import { describe, expect, it } from 'vitest'
import {
  resolveFlowDeclaration,
  type FlowDeclarationNode
} from '../src/shared/agent-flow/declarations'
import {
  DEFAULT_AGENT_NODE_CONFIG,
  DEFAULT_REVIEW_NODE_CONFIG,
  DEFAULT_STATE_NODE_CONFIG
} from '../src/shared/agent-flow/node-contracts'

const make = (id: string, type: string, config: unknown): FlowDeclarationNode => ({
  id,
  type,
  config: JSON.stringify(config),
  outputPortIds: ['out-text']
})
const producer = make('producer', 'text', {})
const next = make('next', 'text', {})
describe('C1 control declarations', () => {
  it('derives controls from authorized scope without adding any data edges or changing config', () => {
    const owner = make('agent', 'agent', {
      ...DEFAULT_AGENT_NODE_CONFIG,
      allowedNodeIds: ['producer']
    })
    const before = owner.config
    const edges: never[] = []
    expect(resolveFlowDeclaration(owner, [owner, producer], edges)).toMatchObject({
      issues: [],
      relations: [{ sourceNodeId: 'agent', targetNodeId: 'producer', kind: 'controls' }]
    })
    expect(owner.config).toBe(before)
    expect(edges).toEqual([])
  })
  it('allows a rework control return while the data graph remains acyclic and unchanged', () => {
    const owner = make('review', 'ai-review', {
      ...DEFAULT_REVIEW_NODE_CONFIG,
      responsibleNodeId: 'producer',
      gatedNodeIds: ['next'],
      subjectSources: [{ nodeId: 'producer', portId: 'out-text' }]
    })
    const edges = [
      {
        from: { nodeId: 'producer', portId: 'out-text' },
        to: { nodeId: 'review', portId: 'in-text' }
      }
    ]
    const before = JSON.stringify(edges)
    const result = resolveFlowDeclaration(owner, [owner, producer, next], edges)
    expect(result.issues).toEqual([])
    expect(result.relations.map((relation) => relation.kind)).toEqual(['review-gate', 'rework'])
    expect(JSON.stringify(edges)).toBe(before)
    expect(
      resolveFlowDeclaration(
        {
          ...owner,
          config: JSON.stringify({
            ...DEFAULT_REVIEW_NODE_CONFIG,
            rejectPolicy: 'stop',
            responsibleNodeId: 'producer'
          })
        },
        [owner, producer]
      ).relations
    ).toEqual([])
  })
  it('rejects fabricated source permissions, duplicate IDs and unconnected review evidence', () => {
    const owner = make('agent', 'agent', {
      ...DEFAULT_AGENT_NODE_CONFIG,
      relations: [
        { relationId: 'r', sourceNodeId: 'producer', targetNodeId: 'next', kind: 'controls' }
      ]
    })
    expect(resolveFlowDeclaration(owner, [owner, producer, next]).relations).toEqual([])
    expect(resolveFlowDeclaration(owner, [owner, producer, next]).issues).not.toEqual([])
    const review = make('review', 'ai-review', {
      ...DEFAULT_REVIEW_NODE_CONFIG,
      subjectSources: [{ nodeId: 'producer', portId: 'out-text' }]
    })
    expect(resolveFlowDeclaration(review, [review, producer]).issues).toContain(
      '审核对象未通过真实数据连接接入'
    )
    const duplicate = make('state', 'state-machine', {
      ...DEFAULT_STATE_NODE_CONFIG,
      relations: [
        { relationId: 'r', sourceNodeId: 'state', targetNodeId: 'producer', kind: 'observes' },
        { relationId: 'r', sourceNodeId: 'state', targetNodeId: 'next', kind: 'observes' }
      ]
    })
    expect(resolveFlowDeclaration(duplicate, [duplicate, producer, next]).issues).toContain(
      '关系标识重复'
    )
  })
  it('preserves missing references and surfaces them instead of retargeting or silently deleting', () => {
    const owner = make('agent', 'agent', {
      ...DEFAULT_AGENT_NODE_CONFIG,
      allowedNodeIds: ['deleted']
    })
    const before = owner.config
    const result = resolveFlowDeclaration(owner, [owner, producer])
    expect(result.relations).toEqual([])
    expect(result.issues).toContain('关系目标已删除或指向自身')
    expect(owner.config).toBe(before)
  })
  it('rejects malformed configs and deduplicates identical declarations', () => {
    expect(
      resolveFlowDeclaration({ ...producer, type: 'agent', config: 'invalid' }, [producer]).issues
    ).not.toEqual([])
    const owner = make('agent', 'agent', {
      ...DEFAULT_AGENT_NODE_CONFIG,
      allowedNodeIds: ['producer'],
      relations: [
        { relationId: 'r', sourceNodeId: 'agent', targetNodeId: 'producer', kind: 'controls' }
      ]
    })
    expect(resolveFlowDeclaration(owner, [owner, producer]).relations).toHaveLength(1)
  })
})
