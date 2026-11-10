import { describe, expect, it } from 'vitest'
import {
  canonicalCompositeJson,
  compositeContentHash,
  parseCompositeManifest,
  validateCompositeManifestStructure,
  type CompositeManifest
} from '../src/shared/composite/manifest'
import { validateCompositeManifest } from '../src/shared/composite/validate'

function characterDesign(patch: Partial<CompositeManifest> = {}): CompositeManifest {
  return {
    schemaVersion: 1,
    capabilityId: 'character-design',
    version: '1.0',
    name: '人物设计',
    description: '输入人物要求，输出人物设计图',
    tags: ['人物', '设计'],
    inputs: [
      {
        id: 'requirements',
        label: '人物要求',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'requirements', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'portrait',
        label: '人物设计图',
        type: 'image',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'generate-image', portId: 'out-image' }
      }
    ],
    graph: {
      nodes: [
        { id: 'requirements', nodeType: 'text', contractVersion: 1, title: '人物要求', dx: 0, dy: 0, w: 340, h: 260 },
        {
          id: 'polish',
          nodeType: 'ai-process',
          contractVersion: 1,
          title: '整理描述',
          dx: 380,
          dy: 0,
          w: 340,
          h: 260,
          config: '{}'
        },
        {
          id: 'generate-image',
          nodeType: 'image-gen',
          contractVersion: 1,
          title: '生成人物图',
          dx: 760,
          dy: 0,
          w: 340,
          h: 260,
          config: '{}'
        }
      ],
      edges: [
        {
          from: { nodeId: 'requirements', portId: 'out-text' },
          to: { nodeId: 'polish', portId: 'in-text' }
        },
        {
          from: { nodeId: 'polish', portId: 'out-text' },
          to: { nodeId: 'generate-image', portId: 'in-prompt' }
        }
      ]
    },
    dependencies: [
      { kind: 'node', id: 'text', contractVersion: 1 },
      { kind: 'node', id: 'ai-process', contractVersion: 1 },
      { kind: 'node', id: 'image-gen', contractVersion: 1 }
    ],
    executionPolicy: { timeoutMs: 600000, maxDepth: 5, maxExpandedNodes: 40, waitForInput: true },
    ...patch
  }
}

describe('组合能力 manifest（P1 契约）', () => {
  it('人物设计示例可解析，结构校验通过', () => {
    const result = parseCompositeManifest(characterDesign())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.capabilityId).toBe('character-design')
      expect(result.manifest.outputs[0].source).toEqual({
        nodeId: 'generate-image',
        portId: 'out-image'
      })
    }
  })

  it('重复内部节点 ID、悬空映射、无公开输出都会被拒绝', () => {
    const duplicate = characterDesign()
    duplicate.graph.nodes.push({ ...duplicate.graph.nodes[0] })
    expect(validateCompositeManifestStructure(duplicate)).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: '内部节点 ID 重复' })])
    )

    const orphan = characterDesign()
    orphan.outputs[0].source = { nodeId: 'missing-node', portId: 'out-image' }
    expect(validateCompositeManifestStructure(orphan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('不存在的内部节点') })
      ])
    )

    const noOutput = characterDesign()
    noOutput.outputs = []
    expect(validateCompositeManifestStructure(noOutput)).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: '至少需要一个公开输出' })])
    )
  })

  it('公开输入/输出 ID 与重复连线有结构校验', () => {
    const duplicatePorts = characterDesign()
    duplicatePorts.inputs.push({ ...duplicatePorts.inputs[0] })
    duplicatePorts.outputs.push({ ...duplicatePorts.outputs[0] })
    duplicatePorts.graph.edges.push({ ...duplicatePorts.graph.edges[0] })
    const messages = validateCompositeManifestStructure(duplicatePorts).map((issue) => issue.message)
    expect(messages).toEqual(
      expect.arrayContaining(['公开输入 ID 重复', '公开输出 ID 重复', '重复连线'])
    )
  })

  it('内容摘要稳定且忽略 contentHash', async () => {
    const left = characterDesign()
    const right = characterDesign({ tags: ['人物', '设计'], contentHash: 'a'.repeat(64) })
    expect(canonicalCompositeJson(left)).toBe(canonicalCompositeJson(right))
    await expect(compositeContentHash(left)).resolves.toMatch(/^[a-f0-9]{64}$/)
    await expect(compositeContentHash(left)).resolves.toBe(await compositeContentHash(right))
  })

  it('缺少节点依赖或嵌套依赖成环时发布校验拒绝', () => {
    const missing = characterDesign()
    missing.dependencies = []
    expect(validateCompositeManifest(missing).issues.map((issue) => issue.code)).toContain(
      'DEPENDENCY_MISSING'
    )

    const a = characterDesign()
    a.capabilityId = 'a'
    a.dependencies = [
      ...(a.dependencies ?? []),
      { kind: 'capability', id: 'b', version: '1.0' }
    ]
    const b = characterDesign()
    b.capabilityId = 'b'
    b.dependencies = [
      ...(b.dependencies ?? []),
      { kind: 'capability', id: 'a', version: '1.0' }
    ]
    const result = validateCompositeManifest(a, {
      getCapability: (id) => (id === 'a' ? a : id === 'b' ? b : null)
    })
    expect(result.issues.map((issue) => issue.code)).toContain('DEPENDENCY_CYCLE')
  })
})
