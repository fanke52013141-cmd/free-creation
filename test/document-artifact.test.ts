import { beforeAll, expect, it } from 'vitest'
import type { Editor } from 'tldraw'
import { materializeDocumentArtifact } from '@renderer/canvas/artifact-materializer'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { projectNodeOutputs } from '@renderer/nodes/nodeValues'
import { registerAllNodeTypes } from './helpers/registerNodes'

beforeAll(() => registerAllNodeTypes())

it('document artifacts contain complete content, survive snapshots and retain provenance per run', () => {
  const shapes: NodeCardShape[] = []
  const producer = {
    id: 'shape:producer',
    x: 0,
    y: 0,
    props: { nodeType: 'ai-process', title: '处理', w: 340, h: 260 }
  } as NodeCardShape
  const editor = {
    getCurrentPageShapes: () => shapes,
    createShape: (shape: NodeCardShape) => shapes.push(shape)
  } as unknown as Editor
  materializeDocumentArtifact(
    editor,
    producer,
    'out-text',
    { kind: 'text', text: '第一段\n第二段' },
    'run-1'
  )
  materializeDocumentArtifact(
    editor,
    producer,
    'out-markdown',
    { kind: 'markdown', text: '# 标题\n完整正文' },
    'run-2'
  )
  materializeDocumentArtifact(
    editor,
    producer,
    'out-json',
    { kind: 'json', data: { shots: [{ scene: '城堡' }] } },
    'run-3'
  )
  const restored = JSON.parse(JSON.stringify(shapes)) as NodeCardShape[]
  expect(restored.map((shape) => shape.props.nodeType)).toEqual(['text', 'text', 'json'])
  expect(restored[0].props.text).toBe('第一段\n第二段')
  expect(restored[1].props.text).toBe('# 标题\n完整正文')
  expect(projectNodeOutputs(restored[2])['out-json']).toEqual({
    kind: 'json',
    data: { shots: [{ scene: '城堡' }] }
  })
  expect(restored.map((shape) => shape.meta.artifactRunId)).toEqual(['run-1', 'run-2', 'run-3'])
  expect(new Set(restored.map((shape) => shape.x)).size).toBe(3)
  expect(restored.every((shape) => shape.meta.artifactProducerId === producer.id)).toBe(true)
})
