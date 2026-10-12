import { describe, expect, it } from 'vitest'
import type { CanvasNode, ProjectFile } from '../src/shared/types'
import {
  NodeExecuteCommandSchema,
  type NodeExecuteCommand
} from '../src/shared/agent-flow/commands'
import {
  nodeCommandIntentSignature,
  projectSemanticRevision
} from '../src/main/agent-flow/command-intent'

function project(): ProjectFile {
  const node: CanvasNode = {
    id: 'shape:target',
    type: 'processor',
    contractVersion: 1,
    title: '处理',
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [
      {
        id: 'in-value',
        name: '输入',
        dir: 'in',
        type: 'any',
        required: false,
        cardinality: 'one',
        description: 'fixture'
      }
    ],
    params: { config: '{"operation":"pass"}' },
    content: { kind: 'text', text: '正文' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 0 }
  }
  return {
    version: 1,
    meta: { id: 'project-a', name: 'fixture', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes: [node],
    edges: [],
    groups: [],
    tldrawSnapshot: {
      store: {
        [node.id]: {
          id: node.id,
          type: 'node-card',
          x: 0,
          y: 0,
          props: {
            nodeType: node.type,
            title: node.title,
            config: node.params.config,
            text: '正文',
            w: 340,
            h: 260,
            mediaId: '',
            mediaPath: '',
            mediaMime: '',
            exec: 'idle'
          },
          meta: {}
        },
        'camera:page': { id: 'camera:page', typeName: 'camera', x: 0, y: 0, z: 1 }
      }
    }
  }
}
function command(): NodeExecuteCommand {
  return {
    schemaVersion: 1,
    kind: 'node.execute',
    commandId: 'command-a',
    projectId: 'project-a',
    taskId: 'task-a',
    agentNodeId: 'shape:agent',
    targetNodeId: 'shape:target',
    expectedSemanticRevision: projectSemanticRevision(project()),
    contractVersion: 1,
    inputs: [
      {
        targetPortId: 'in-value',
        assets: [
          {
            assetId: 'asset-a',
            versionId: 'version-a',
            sourceNodeId: 'shape:source',
            sourcePortId: 'out-text'
          }
        ]
      }
    ],
    traceId: 'trace-a',
    spanId: 'span-a'
  }
}
function shape(file: ProjectFile): {
  props: Record<string, unknown>
  meta: Record<string, unknown>
  x: number
} {
  return (file.tldrawSnapshot as { store: Record<string, ReturnType<typeof shape>> }).store[
    'shape:target'
  ]
}

describe('C2.2 command intent foundation (not dispatch authorization)', () => {
  it('ignores graph save counters, camera, position, card size and runtime results', () => {
    const file = project()
    const revision = projectSemanticRevision(file)
    file.meta.graphVersion++
    file.meta.updatedAt++
    file.nodes[0].x = 100
    file.nodes[0].w = 400
    file.nodes[0].exec = { status: 'success' }
    file.nodes[0].meta.createdAt = 100
    shape(file).x = 100
    shape(file).props.w = 400
    shape(file).props.exec = 'success'
    shape(file).meta.nodeRun = { status: 'success', runId: 'run-a' }
    shape(file).meta.nodeResult = 'private result'
    const snapshot = file.tldrawSnapshot as { store: Record<string, unknown> }
    snapshot.store['camera:page'] = { x: 12, y: 20, z: 0.5 }
    expect(projectSemanticRevision(file)).toBe(revision)
  })
  it('changes for body, configuration, contract, fixed output, relation or input edge edits', () => {
    const original = projectSemanticRevision(project())
    const mutations: Array<(file: ProjectFile) => void> = [
      (file) => {
        shape(file).props.text = '新正文'
      },
      (file) => {
        shape(file).props.config = '{"operation":"template"}'
      },
      (file) => {
        file.nodes[0].contractVersion = 2
      },
      (file) => {
        shape(file).meta.pinnedOutput = '{"version":1,"ports":{"out-value":1}}'
      },
      (file) => {
        shape(file).meta.flowAssetRef = '{"versionId":"v2"}'
      },
      (file) => {
        shape(file).props.config = '{"gatedNodeIds":["shape:new"]}'
      },
      (file) => {
        file.edges.push({
          id: 'edge-a',
          from: { nodeId: 'shape:source', portId: 'out-text' },
          to: { nodeId: 'shape:target', portId: 'in-value' }
        })
      },
      (file) => {
        file.nodes[0].ports[0].cardinality = 'many'
      }
    ]
    for (const mutate of mutations) {
      const file = project()
      mutate(file)
      expect(projectSemanticRevision(file)).not.toBe(original)
    }
  })
  it('retains many-input edge order while ignoring cosmetic arrow identities', () => {
    const file = project()
    file.edges = ['a', 'b'].map((id) => ({
      id,
      from: { nodeId: `shape:${id}`, portId: 'out-text' },
      to: { nodeId: 'shape:target', portId: 'in-value' }
    }))
    const revision = projectSemanticRevision(file)
    file.edges[0].id = 'new-arrow-id'
    expect(projectSemanticRevision(file)).toBe(revision)
    file.edges.reverse()
    expect(projectSemanticRevision(file)).not.toBe(revision)
  })
  it('normalizes object key order and rejects absent/mismatched snapshot nodes', () => {
    const file = project()
    file.nodes[0].params = { a: 1, b: 2 }
    const revision = projectSemanticRevision(file)
    file.nodes[0].params = { b: 2, a: 1 }
    expect(projectSemanticRevision(file)).toBe(revision)
    const snapshot = file.tldrawSnapshot as { store: Record<string, unknown> }
    delete snapshot.store['shape:target']
    expect(() => projectSemanticRevision(file)).toThrow('FLOW_SNAPSHOT_MISMATCH')
    delete file.tldrawSnapshot
    expect(() => projectSemanticRevision(file)).toThrow('FLOW_SNAPSHOT_MISSING')
  })
  it('separates command intent from retry diagnostics and rejects different pinned intent', () => {
    const original = command()
    const signature = nodeCommandIntentSignature(original)
    expect(
      nodeCommandIntentSignature({ ...original, traceId: 'retry', spanId: 'retry-span' })
    ).toBe(signature)
    const changed = structuredClone(original)
    changed.inputs[0].assets[0].versionId = 'version-b'
    expect(nodeCommandIntentSignature(changed)).not.toBe(signature)
    for (const override of [
      { taskId: 'new-task' },
      { targetNodeId: 'shape:other' },
      { contractVersion: 2 }
    ]) {
      expect(nodeCommandIntentSignature({ ...original, ...override })).not.toBe(signature)
    }
    expect(JSON.stringify({ signature })).not.toContain('正文')
  })
  it('requires explicit ports, bounded complete refs and no body/extra fields', () => {
    const original = command()
    expect(NodeExecuteCommandSchema.safeParse(original).success).toBe(true)
    const invalid: unknown[] = [
      { ...original, body: 'private prompt' },
      { ...original, expectedSemanticRevision: '1' },
      { ...original, agentNodeId: original.targetNodeId },
      { ...original, inputs: [original.inputs[0], original.inputs[0]] },
      { ...original, inputs: [{ ...original.inputs[0], assets: [] }] },
      { ...original, inputs: [{ targetPortId: 'in-value', assets: [{ versionId: 'version-a' }] }] },
      {
        ...original,
        inputs: [
          { targetPortId: 'in-a', assets: Array(100).fill(original.inputs[0].assets[0]) },
          { targetPortId: 'in-b', assets: Array(100).fill(original.inputs[0].assets[0]) }
        ]
      }
    ]
    for (const input of invalid)
      expect(NodeExecuteCommandSchema.safeParse(input).success).toBe(false)
  })
  it('normalizes port map order but preserves asset order within a port', () => {
    const original = command()
    original.inputs.push({ targetPortId: 'in-other', assets: [original.inputs[0].assets[0]] })
    const signature = nodeCommandIntentSignature(original)
    original.inputs.reverse()
    expect(nodeCommandIntentSignature(original)).toBe(signature)
    original.inputs[0].assets.push({ ...original.inputs[0].assets[0], versionId: 'version-b' })
    const ordered = nodeCommandIntentSignature(original)
    original.inputs[0].assets.reverse()
    expect(nodeCommandIntentSignature(original)).not.toBe(ordered)
  })
})
