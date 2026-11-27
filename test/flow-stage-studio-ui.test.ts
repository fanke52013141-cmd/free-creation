import { describe, expect, it, beforeEach } from 'vitest'
import {
  collectDownstreamNodeIds,
  readArchivedDeliveries
} from '../src/renderer/src/canvas/flow-rework-reset'
import { useFlowFocusStore } from '../src/renderer/src/stores/flowFocus'
import type { NodeCardShape } from '../src/renderer/src/canvas/NodeCardShape'

describe('flow-rework-reset DAG dependency & soft archive', () => {
  it('collects only paths reachable downstream and preserves unrelated parallel branches', () => {
    const edges = [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
      { from: 'n3', to: 'n5' },
      // Parallel branch n1 -> n4 -> n5 (n4 does NOT depend on n2)
      { from: 'n1', to: 'n4' },
      { from: 'n4', to: 'n5' }
    ]

    const fromN2 = collectDownstreamNodeIds(edges, 'n2')
    expect(fromN2).toEqual(['n3', 'n5'])
    expect(fromN2).not.toContain('n1')
    expect(fromN2).not.toContain('n4')
  })

  it('handles cycles safely without infinite recursion', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' }
    ]
    expect(collectDownstreamNodeIds(edges, 'a')).toEqual(['b', 'c'])
  })

  it('reads valid archived delivery snapshots safely and ignores malformed meta', () => {
    const fakeShape = {
      meta: {
        archivedDeliveries: JSON.stringify([
          {
            archiveId: 'arch-1',
            archivedAt: 1700000000000,
            reason: 'upstream-rework',
            sourceNodeId: 'n1',
            nodeResult: '{"ok":true}'
          }
        ])
      }
    } as unknown as NodeCardShape
    const list = readArchivedDeliveries(fakeShape)
    expect(list).toHaveLength(1)
    expect(list[0].archiveId).toBe('arch-1')

    const broken = { meta: { archivedDeliveries: '{bad-json' } } as unknown as NodeCardShape
    expect(readArchivedDeliveries(broken)).toEqual([])
  })
})

describe('useFlowFocusStore UI spotlight & relation state', () => {
  beforeEach(() => {
    useFlowFocusStore.getState().reset()
  })

  it('defaults to spotlight enabled and control relations quieted', () => {
    const state = useFlowFocusStore.getState()
    expect(state.spotlightEnabled).toBe(true)
    expect(state.showControlRelations).toBe(false)
    expect(state.focusedNodeId).toBeNull()
  })

  it('tracks focused stage, upstream input sources, controlled nodes, and attention node', () => {
    const store = useFlowFocusStore.getState()
    store.setFocusedNode('shape:s2', new Set(['shape:s1']))
    store.setFlowContext({
      attentionNodeId: 'shape:s2',
      controlledNodeIds: new Set(['shape:s2', 'shape:s3'])
    })

    const updated = useFlowFocusStore.getState()
    expect(updated.focusedNodeId).toBe('shape:s2')
    expect(updated.inputSourceIds.has('shape:s1')).toBe(true)
    expect(updated.attentionNodeId).toBe('shape:s2')
    expect(updated.controlledNodeIds.has('shape:s3')).toBe(true)

    store.toggleControlRelations()
    expect(useFlowFocusStore.getState().showControlRelations).toBe(true)
    store.toggleSpotlight()
    expect(useFlowFocusStore.getState().spotlightEnabled).toBe(false)
  })
})
