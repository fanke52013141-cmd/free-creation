// @vitest-environment jsdom
import { beforeAll, expect, it } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { storyboardBatchTemplate } from '@renderer/canvas/storyboard-batch-flow'
import { getNodePorts, getNodeType } from '@renderer/nodes/registry'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { portPairCompatible } from '@renderer/canvas/graph'
import { processorExecutor } from '@shared/engine/executors/processor'
import { structuredExecutor } from '@shared/engine/executors/structured'
import type { NodeExecutionContext } from '@shared/engine/executor-types'
import { readShotSelections, shotInputRevision } from '@renderer/nodes/storyboard-selections'
import { remapMediaReferences } from '@shared/media-reference-remap'
beforeAll(registerAllNodeTypes)
it('explicit conversion validates list schema and preserves stable shot IDs', () => {
  const shots = [
    { id: 'shot-a', scene: 'a' },
    { id: 'shot-b', scene: 'b' }
  ]
  let output = ''
  const input = (data: unknown) => [
    { value: { kind: 'json', data }, source: { nodeId: 'upstream', portId: 'out-json' } }
  ]
  const processor = {
    shape: { props: { config: storyboardBatchTemplate.nodes[0].config } },
    inputs: new Map([['in-value', input({ shots })]]),
    updateResult: (value: string) => {
      output = value
    }
  } as unknown as NodeExecutionContext
  expect(processorExecutor(processor).status).toBe('done')
  const data = JSON.parse(output).data
  const structured = {
    shape: {
      props: {
        config: storyboardBatchTemplate.nodes[1].config,
        text: storyboardBatchTemplate.nodes[1].text
      }
    },
    inputs: new Map([['in-context', input(data)]]),
    updateResult: (value: string) => {
      output = value
    }
  } as unknown as NodeExecutionContext
  expect(structuredExecutor(structured).status).toBe('done')
  expect(JSON.parse(output).data).toEqual(shots)
  for (const edge of storyboardBatchTemplate.edges) {
    const from = storyboardBatchTemplate.nodes[edge.fromIdx],
      to = storyboardBatchTemplate.nodes[edge.toIdx]
    const fromPorts = getNodePorts(getNodeType(from.nodeType)!, {
      props: from
    } as unknown as NodeCardShape)
    const toPorts = getNodePorts(getNodeType(to.nodeType)!, {
      props: to
    } as unknown as NodeCardShape)
    expect(
      portPairCompatible(
        fromPorts.out.find((p) => p.id === edge.fromPort)!,
        toPorts.in.find((p) => p.id === edge.toPort)!
      )
    ).toBe(true)
  }
  processor.inputs = new Map([
    ['in-value', input({ notShots: [] })]
  ]) as NodeExecutionContext['inputs']
  expect(processorExecutor(processor).status).toBe('failed')
})
it('selection survives reorder and media remapping; changing a shot invalidates its selection revision', () => {
  const shot = { id: 's1', scene: 'a', dialogue: '', duration: '3s' }
  const record = {
    s1: {
      shotId: 's1',
      inputRevision: shotInputRevision(shot),
      selectedAssetId: 'shape:asset',
      mediaId: 'm'
    }
  }
  const reopened = readShotSelections(JSON.stringify(record))
  expect(reopened.s1.shotId).toBe(shot.id)
  expect(shotInputRevision({ ...shot, scene: 'b' })).not.toBe(reopened.s1.inputRevision)
  const imported = remapMediaReferences(JSON.stringify(record), {
    ids: new Map([['m', 'new-m']]),
    paths: new Map()
  })
  expect(readShotSelections(imported).s1.mediaId).toBe('new-m')
})
