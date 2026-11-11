// W3 逐类验收：图片 / JSON / 多值 / 多输出 / 媒体资产的规划、收集、发布校验、
// 执行器写回与下游投影。类型/基数错误必须有确定结果；媒体产物可被下游消费。
import { describe, expect, it, vi } from 'vitest'
import type { CompositeManifest } from '../src/shared/composite/manifest'
import {
  collectCompositeOutputs,
  planCompositeInputBindings
} from '../src/shared/composite/runtime'
import { projectCompositeOutputs } from '../src/shared/composite/outputs'
import { validateCompositeManifest } from '../src/shared/composite/validate'
import { compositeExecutor } from '../src/shared/engine/executors/composite'
import type { NodeExecutionContext } from '../src/shared/engine/executor-types'
import type { NodeValue } from '../src/shared/engine/values'
import type { ContractInputMap, NodeValuePacket } from '../src/shared/engine/inputs'

type PortType = 'text' | 'json' | 'image' | 'video' | 'audio' | 'file'

function mediaValue(kind: 'image' | 'video' | 'audio' | 'file', id: string): NodeValue {
  const mime =
    kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'application/pdf'
  return { kind, mediaId: id, mediaPath: `projects/${id}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'pdf'}`, mime } as NodeValue
}

function packets(portId: string, values: NodeValue[]): [string, NodeValuePacket[]] {
  return [
    portId,
    values.map((value, index) => ({
      type: value.kind,
      value,
      source: { nodeId: 'shape:outer', portId: `out-${index}`, runId: 'run-1' },
      createdAt: index + 1
    })) as NodeValuePacket[]
  ]
}

/** 多类型节点流：图片输入 → 内部图片节点；公开 text/json/image 三个输出。 */
function multiManifest(patch: Partial<CompositeManifest> = {}): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'poster-kit',
    version: '1.0',
    name: '海报套件',
    inputs: [
      {
        id: 'ref',
        label: '参考图',
        type: 'image',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'n1', portId: 'in-image' }]
      }
    ],
    outputs: [
      {
        id: 'caption',
        label: '文案',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n2', portId: 'out-text' }
      },
      {
        id: 'meta',
        label: '参数',
        type: 'json',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n3', portId: 'out-json' }
      },
      {
        id: 'poster',
        label: '海报图',
        type: 'image',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n1', portId: 'out-image' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'n1',
          nodeType: 'image-gen',
          contractVersion: 1,
          title: '出图',
          dx: 0,
          dy: 0,
          w: 340,
          h: 260,
          ports: [
            { id: 'in-image', name: '参考图', dir: 'in', type: 'image', required: true, cardinality: 'one' },
            { id: 'out-image', name: '图', dir: 'out', type: 'image', required: true, cardinality: 'one' }
          ]
        },
        {
          id: 'n2',
          nodeType: 'text',
          contractVersion: 3,
          title: '文案',
          dx: 380,
          dy: 0,
          w: 340,
          h: 260,
          text: '内部文案',
          ports: [
            { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: true, cardinality: 'many' },
            { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }
          ]
        },
        {
          id: 'n3',
          nodeType: 'json',
          contractVersion: 1,
          title: '参数',
          dx: 760,
          dy: 0,
          w: 340,
          h: 260,
          ports: [
            { id: 'out-json', name: 'JSON', dir: 'out', type: 'json', required: true, cardinality: 'one' }
          ]
        }
      ],
      edges: []
    },
    dependencies: [
      { kind: 'node', id: 'image-gen', contractVersion: 1 },
      { kind: 'node', id: 'text', contractVersion: 3 },
      { kind: 'node', id: 'json', contractVersion: 1 }
    ],
    ...patch
  }
}

describe('W3 输入规划 · 图片/JSON/视频/音频/文件', () => {
  it.each([
    ['image', mediaValue('image', 'm-img'), 'image', 'out-image'],
    ['json', { kind: 'json', data: { size: 'A4' } } as NodeValue, 'json', 'out-json'],
    ['video', mediaValue('video', 'm-vid'), 'video', 'out-video'],
    ['audio', mediaValue('audio', 'm-aud'), 'audio', 'out-audio'],
    ['file', mediaValue('file', 'm-file'), 'file', 'out-file']
  ] as Array<[PortType, NodeValue, string, string]>)(
    '%s 输入映射为同类型虚拟上游并保留原值',
    (type, value, sourceNodeType, sourcePortId) => {
      const base = multiManifest()
      const manifest = multiManifest({
        inputs: [{ ...base.inputs[0], type, targets: [{ nodeId: 'n1', portId: `in-${type}` }] }]
      })
      const plan = planCompositeInputBindings(manifest, new Map([packets('in-ref', [value])]))
      expect(plan.issues).toEqual([])
      expect(plan.bindings).toHaveLength(1)
      expect(plan.bindings[0]).toMatchObject({
        inputId: 'ref',
        target: { nodeId: 'n1', portId: `in-${type}` },
        sourceNodeType,
        sourcePortId,
        order: 1,
        value
      })
    }
  )

  it('多值图片端口按调用顺序保留（many 基数）', () => {
    const base = multiManifest()
    const manifest = multiManifest({
      inputs: [{ ...base.inputs[0], cardinality: 'many' }]
    })
    const values = [mediaValue('image', 'm-1'), mediaValue('image', 'm-2'), mediaValue('image', 'm-3')]
    const plan = planCompositeInputBindings(manifest, new Map([packets('in-ref', values)]))
    expect(plan.issues).toEqual([])
    expect(plan.bindings.map((binding) => binding.order)).toEqual([1, 2, 3])
    expect(plan.bindings.map((binding) => (binding.value as { mediaId: string }).mediaId)).toEqual([
      'm-1',
      'm-2',
      'm-3'
    ])
  })

  it('类型错误确定拒绝：图片端口收到文本', () => {
    const plan = planCompositeInputBindings(
      multiManifest(),
      new Map([packets('in-ref', [{ kind: 'text', text: '不是图片' }])])
    )
    expect(plan.bindings).toEqual([])
    expect(plan.issues).toEqual([
      expect.objectContaining({ code: 'INPUT_TYPE_UNSUPPORTED', phase: 'input', publicPortId: 'ref' })
    ])
  })

  it('基数错误确定拒绝：单值端口收到两份值', () => {
    const plan = planCompositeInputBindings(
      multiManifest(),
      new Map([packets('in-ref', [mediaValue('image', 'm-1'), mediaValue('image', 'm-2')])])
    )
    expect(plan.bindings).toEqual([])
    expect(plan.issues).toEqual([
      expect.objectContaining({ code: 'INPUT_VALUE_INVALID', phase: 'input', publicPortId: 'ref' })
    ])
  })

  it('必需媒体输入缺失给出可定位失败', () => {
    const plan = planCompositeInputBindings(multiManifest(), new Map() as ContractInputMap)
    expect(plan.issues).toEqual([
      expect.objectContaining({ code: 'INPUT_REQUIRED', publicPortId: 'ref' })
    ])
  })
})

describe('W3 输出收集 · 多输出与媒体产物', () => {
  const runValues = new Map<string, NodeValue>([
    ['n2.out-text', { kind: 'text', text: '本次文案' }],
    ['n3.out-json', { kind: 'json', data: { size: 'A4', dpi: 300 } }],
    ['n1.out-image', mediaValue('image', 'm-poster')]
  ])
  const read = (nodeId: string, portId: string): NodeValue | undefined =>
    runValues.get(`${nodeId}.${portId}`)

  it('一次运行同时收集 text/json/image 三个公开输出；媒体兼容取首个媒体', () => {
    const plan = collectCompositeOutputs(multiManifest(), read)
    expect(plan.issues).toEqual([])
    expect(plan.outputs.caption).toEqual({ kind: 'text', text: '本次文案' })
    expect(plan.outputs.meta).toEqual({ kind: 'json', data: { size: 'A4', dpi: 300 } })
    expect(plan.outputs.poster).toMatchObject({ kind: 'image', mediaId: 'm-poster' })
    expect(plan.media).toEqual({
      mediaId: 'm-poster',
      mediaPath: 'projects/m-poster.png',
      mime: 'image/png'
    })
  })

  it('输出类型不匹配确定拒绝并定位内部节点/端口', () => {
    const mismatched = new Map(runValues)
    mismatched.set('n1.out-image', { kind: 'text', text: '不是图片' })
    const plan = collectCompositeOutputs(
      multiManifest(),
      (nodeId, portId) => mismatched.get(`${nodeId}.${portId}`)
    )
    expect(plan.outputs.poster).toBeUndefined()
    expect(plan.issues).toEqual([
      expect.objectContaining({
        code: 'OUTPUT_TYPE_MISMATCH',
        phase: 'output',
        publicPortId: 'poster',
        nodeId: 'n1',
        portId: 'out-image'
      })
    ])
  })

  it('必需输出缺失确定拒绝；可选输出缺失是正常结果', () => {
    const partial = new Map(runValues)
    partial.delete('n3.out-json')
    const required = collectCompositeOutputs(
      multiManifest(),
      (nodeId, portId) => partial.get(`${nodeId}.${portId}`)
    )
    expect(required.issues).toEqual([
      expect.objectContaining({ code: 'REQUIRED_OUTPUT_MISSING', publicPortId: 'meta', nodeId: 'n3' })
    ])
    const optional = multiManifest({
      outputs: multiManifest().outputs.map((output) =>
        output.id === 'meta' ? { ...output, required: false } : output
      )
    })
    const plan = collectCompositeOutputs(optional, (nodeId, portId) => partial.get(`${nodeId}.${portId}`))
    expect(plan.issues).toEqual([])
    expect(plan.outputs.meta).toBeUndefined()
    expect(plan.outputs.caption).toBeDefined()
  })
})

describe('W3 发布校验 · 媒体资产固定输入', () => {
  it('资产节点 mediaRefs 可满足必填媒体输入：无公开输入也可发布', () => {
    const base = multiManifest()
    const manifest = multiManifest({
      inputs: [],
      graph: {
        nodes: base.graph.nodes.map((node) =>
          node.id === 'n1'
            ? {
                ...node,
                mediaRefs: [{ mediaId: 'm-asset', mediaPath: 'projects/asset.png', mime: 'image/png' }]
              }
            : node
        ),
        edges: []
      }
    })
    const result = validateCompositeManifest(manifest)
    expect(result.issues.filter((issue) => issue.code === 'REQUIRED_INPUT_UNBOUND')).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('无 mediaRefs 的必填媒体输入仍被拒绝（不豁免未知来源）', () => {
    const manifest = multiManifest({ inputs: [] })
    const result = validateCompositeManifest(manifest)
    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain('REQUIRED_INPUT_UNBOUND')
  })

  it('公开图片输入映射到文本端口被类型校验拒绝', () => {
    const base = multiManifest()
    const manifest = multiManifest({
      inputs: [{ ...base.inputs[0], targets: [{ nodeId: 'n2', portId: 'in-text' }] }]
    })
    const result = validateCompositeManifest(manifest)
    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain('PORT_TYPE_MISMATCH')
  })
})

describe('W3 执行器写回与下游投影 · 媒体可消费', () => {
  function executorContext(outcome: {
    outputs?: Record<string, NodeValue>
    media?: { mediaId: string; mediaPath: string; mime: string } | null
  }): NodeExecutionContext {
    const manifest = multiManifest()
    return {
      node: { id: 'shape:composite' } as never,
      shape: { props: { config: JSON.stringify({ manifest }) }, meta: {} } as never,
      inputs: new Map(),
      runId: 'r1',
      updateMeta: vi.fn(),
      updateResult: vi.fn(),
      runComposite: vi.fn(async () => ({ status: 'done', stepCount: 3, ...outcome }))
    } as unknown as NodeExecutionContext
  }

  it('媒体公开输出同时写 nodeResult 与 nodeExtra；文本/JSON 写 nodeExtra', async () => {
    const ctx = executorContext({
      outputs: {
        caption: { kind: 'text', text: '本次文案' },
        meta: { kind: 'json', data: { size: 'A4' } },
        poster: mediaValue('image', 'm-poster')
      }
    })
    const result = await compositeExecutor(ctx)
    expect(result.status).toBe('done')
    const extra = JSON.parse(String(vi.mocked(ctx.updateMeta).mock.calls[0][0].nodeExtra)) as Record<string, NodeValue>
    expect(extra['out-caption']).toEqual({ kind: 'text', text: '本次文案' })
    expect(extra['out-meta']).toEqual({ kind: 'json', data: { size: 'A4' } })
    expect(extra['out-poster']).toMatchObject({ kind: 'image', mediaId: 'm-poster' })
    expect(String(vi.mocked(ctx.updateResult).mock.calls[0][0])).toContain('m-poster')
  })

  it('成功运行后下游按公开端口消费 text/json/image 三种产物', async () => {
    const manifest = multiManifest()
    const ctx = executorContext({
      outputs: {
        caption: { kind: 'text', text: '本次文案' },
        meta: { kind: 'json', data: { size: 'A4' } },
        poster: mediaValue('image', 'm-poster')
      }
    })
    await compositeExecutor(ctx)
    const extra = String(vi.mocked(ctx.updateMeta).mock.calls[0][0].nodeExtra)
    const result = String(vi.mocked(ctx.updateResult).mock.calls[0][0])
    const shape = {
      props: { nodeType: 'composite', config: JSON.stringify({ manifest }) },
      meta: {
        nodeRun: { runId: 'r1', status: 'success', startedAt: 1, inputs: {} },
        nodeExtra: extra,
        nodeResult: result
      }
    }
    const projected = projectCompositeOutputs(shape)
    expect(projected['out-caption']).toEqual({ kind: 'text', text: '本次文案' })
    expect(projected['out-meta']).toEqual({ kind: 'json', data: { size: 'A4' } })
    expect(projected['out-poster']).toMatchObject({
      kind: 'image',
      mediaId: 'm-poster',
      mediaPath: 'projects/m-poster.png',
      mime: 'image/png'
    })
  })

  it('本次只有媒体输出时清空旧 nodeExtra 中的文本，不冒充本轮结果', async () => {
    const ctx = executorContext({ outputs: { poster: mediaValue('image', 'm-poster') } })
    await compositeExecutor(ctx)
    const extra = JSON.parse(String(vi.mocked(ctx.updateMeta).mock.calls[0][0].nodeExtra)) as Record<string, NodeValue>
    expect(Object.keys(extra)).toEqual(['out-poster'])
  })

  it('本次无任何公开输出时清空 nodeExtra', async () => {
    const ctx = executorContext({ outputs: {} })
    await compositeExecutor(ctx)
    expect(vi.mocked(ctx.updateMeta).mock.calls[0][0].nodeExtra).toBeUndefined()
  })
})