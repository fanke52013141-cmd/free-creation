import { describe, expect, it } from 'vitest'
import {
  canonicalCompositeJson,
  compositeContentHash,
  parseCompositeManifest,
  validateCompositeManifestStructure,
  type CompositeManifest
} from '../src/shared/composite/manifest'
import { validateCompositeManifest, validateCompositePublication } from '../src/shared/composite/validate'
import { COMPOSITE_PORT_TYPES } from '../src/shared/composite/manifest'
import { portPairCompatible } from '../src/renderer/src/canvas/graph'

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
  it('H10：发布明确拒绝直接或间接嵌套人工门，顶层人工门仍可声明', () => {
    const outer = characterDesign({ capabilityId: 'outer', version: '1.2' })
    const inner = characterDesign({ capabilityId: 'inner', version: '1.2' })
    const leaf = characterDesign({ capabilityId: 'leaf', version: '1.2' })
    leaf.executionPolicy = { requiresManualGate: true }
    outer.dependencies.push({ kind: 'capability', id: 'inner', version: '1.2' })
    inner.dependencies.push({ kind: 'capability', id: 'leaf', version: '1.2' })
    const deps = {
      getCapability: (id: string, version: string) =>
        [inner, leaf].find((item) => item.capabilityId === id && item.version === version) ?? null
    }
    for (const executionPolicy of [undefined, { requiresManualGate: true }]) {
      outer.executionPolicy = executionPolicy
      const issues = validateCompositePublication(outer, deps).issues
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'NESTED_MANUAL_GATE_UNSUPPORTED',
        path: 'dependencies'
      }))
      if (executionPolicy)
        expect(issues).not.toContainEqual(expect.objectContaining({ code: 'MANUAL_GATE_UNDECLARED' }))
    }
    // 旧快照没有传播标记时，递归 graph 事实仍必须命中同一发布拒绝。
    leaf.executionPolicy = undefined
    leaf.graph.nodes.push({
      id: 'legacy-human', nodeType: 'human-task', contractVersion: 1, title: '旧人工门',
      dx: 0, dy: 0, w: 340, h: 260
    })
    outer.executionPolicy = { requiresManualGate: true }
    expect(validateCompositePublication(outer, deps).issues).toContainEqual(expect.objectContaining({
      code: 'NESTED_MANUAL_GATE_UNSUPPORTED'
    }))
    // 非嵌套的顶层人工门保持原有声明式支持；非发布校验不影响历史快照读取。
    leaf.executionPolicy = { requiresManualGate: true }
    expect(validateCompositePublication(leaf).issues).not.toContainEqual(expect.objectContaining({
      code: 'NESTED_MANUAL_GATE_UNSUPPORTED'
    }))
    expect(validateCompositeManifest(outer, deps).issues).not.toContainEqual(expect.objectContaining({
      code: 'NESTED_MANUAL_GATE_UNSUPPORTED'
    }))
  })
  it.each(['human-task', 'ai-review', 'director'])('发布要求 %s 声明人工门，历史读取兼容', (nodeType) => {
    const manifest = characterDesign({ version: '1.2' })
    manifest.graph.nodes.push({
      id: 'manual-gate', nodeType, contractVersion: 1, title: '人工门',
      dx: 0, dy: 0, w: 340, h: 260
    })
    expect(parseCompositeManifest(manifest).ok).toBe(true)
    expect(validateCompositePublication(manifest).issues).toContainEqual(expect.objectContaining({
      code: 'MANUAL_GATE_UNDECLARED'
    }))
    manifest.executionPolicy = { requiresManualGate: true }
    expect(validateCompositePublication(manifest).issues).not.toContainEqual(expect.objectContaining({
      code: 'MANUAL_GATE_UNDECLARED'
    }))
  })
  it('接受 minor 版本，并保留旧三段版本的读兼容', () => {
    expect(parseCompositeManifest(characterDesign({ version: '1.2' })).ok).toBe(true)
    expect(parseCompositeManifest(characterDesign({ version: '1.0.0' })).ok).toBe(true)
    expect(validateCompositePublication(characterDesign({ version: '1.0.0' })).issues)
      .toContainEqual(expect.objectContaining({ code: 'VERSION_FORMAT_INVALID' }))
  })
  it('历史内联 Schema 保留在快照中，新发布要求使用引用', () => {
    const manifest = characterDesign()
    manifest.inputs[0].schema = { type: 'string' }
    const parsed = parseCompositeManifest(manifest)
    expect(parsed.ok && parsed.manifest.inputs[0].schema).toEqual({ type: 'string' })
    expect(validateCompositePublication(manifest).issues).toContainEqual(expect.objectContaining({
      code: 'INLINE_SCHEMA_REMOVED',
      path: 'inputs[0].schema'
    }))
  })
  it('节点流内部边与画布使用相同的端口方向和 Schema 兼容矩阵', () => {
    const schemaRef = { id: 'json.any', version: 1 }
    for (const sourceType of COMPOSITE_PORT_TYPES) {
      for (const targetType of COMPOSITE_PORT_TYPES) {
        const manifest = characterDesign()
        manifest.graph.nodes[0].ports = [{
          id: 'out-text', name: '输出', dir: 'out', type: sourceType,
          required: false, cardinality: 'one', schemaRef
        }]
        manifest.graph.nodes[1].ports = [{
          id: 'in-text', name: '输入', dir: 'in', type: targetType,
          required: false, cardinality: 'one', schemaRef
        }]
        const rejected = validateCompositeManifest(manifest).issues.some((entry) =>
          entry.path === 'graph.edges[0]'
        )
        expect(!rejected, `${sourceType} -> ${targetType}`).toBe(portPairCompatible(
          { type: sourceType, schema: schemaRef },
          { type: targetType, schema: schemaRef }
        ))
      }
    }
  })

  it('检查公开 JSON 输出绑定的 Schema 版本', () => {
    const manifest = characterDesign()
    const output = manifest.outputs[0]
    const schemaRef = { id: 'storyboard.shots', version: 1 }
    manifest.graph.nodes[2].ports = [{
      id: output.source.portId, name: '结果', dir: 'out', type: 'json',
      required: true, cardinality: 'one', schemaRef
    }]
    Object.assign(output, { type: 'json', schemaRef })
    const issues = () => validateCompositeManifest(manifest).issues.filter(({ path }) =>
      path === 'outputs[0]'
    )
    expect(issues()).toEqual([])
    output.schemaRef = { ...schemaRef, version: 2 }
    expect(issues()).toEqual([expect.objectContaining({ code: 'SCHEMA_INCOMPATIBLE' })])
  })

  it('按媒体 MIME 判断固定输入能否满足必填端口', () => {
    const manifest = characterDesign()
    const node = manifest.graph.nodes[2]
    node.ports = [{
      id: 'in-audio', name: '音频', dir: 'in', type: 'audio',
      required: true, cardinality: 'one'
    }]
    node.mediaRefs = [{ mediaId: 'asset-1', mediaPath: 'assets/asset-1', mime: 'audio/wav' }]
    const missing = () => validateCompositeManifest(manifest).issues.some(({ code }) =>
      code === 'REQUIRED_INPUT_UNBOUND'
    )
    expect(missing()).toBe(false)
    node.mediaRefs[0].mime = 'image/png'
    expect(missing()).toBe(true)
  })
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
      expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('至少要保留一个「对外输出」') })])
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
