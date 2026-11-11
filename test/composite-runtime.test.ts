import { describe, expect, it } from 'vitest'
import type { CompositeManifest } from '../src/shared/composite/manifest'
import {
  collectCompositeOutputs,
  compositeValueMatchesPort,
  planCompositeInputBindings
} from '../src/shared/composite/runtime'
import { projectCompositeOutputs } from '../src/shared/composite/outputs'
import { compositeRuntimeVersion } from '../src/shared/composite/manifest'
import { textExecutor } from '../src/shared/engine/executors/text'
import { TEXT_MERGE_SEPARATOR } from '../src/shared/engine/helpers'
import type { ContractInputMap } from '../src/shared/engine/inputs'
import type { NodeValuePacket } from '../src/shared/engine/inputs'
import type { NodeExecutionContext } from '../src/shared/engine/executor-types'

function textPort(id: string, dir: 'in' | 'out', required = true) {
  return {
    id,
    name: id,
    dir,
    type: 'text' as const,
    required,
    cardinality: (dir === 'in' ? 'many' : 'one') as 'one' | 'many'
  }
}

function copyManifest(patch: Partial<CompositeManifest> = {}): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'copy-polish',
    version: '1.0',
    name: '文案整理',
    inputs: [
      {
        id: 'copy',
        label: '文案',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'n1', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'polished',
        label: '整理结果',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n1', portId: 'out-text' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'n1',
          nodeType: 'text',
          contractVersion: 3,
          title: '文案',
          dx: 0,
          dy: 0,
          w: 340,
          h: 300,
          text: '内部说明',
          ports: [textPort('in-text', 'in'), textPort('out-text', 'out')]
        }
      ],
      edges: []
    },
    dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }],
    ...patch
  }
}

function packet(value: NodeValuePacket['value'], portId = 'in-copy'): [string, NodeValuePacket[]] {
  return [
    portId,
    [
      {
        type: value.kind === 'markdown' ? 'markdown' : value.kind,
        value,
        source: { nodeId: 'shape:outer', portId: 'out-text', runId: 'run-1' },
        createdAt: 1
      } as NodeValuePacket
    ]
  ]
}

describe('节点流 W1 运行时（文本闭环）', () => {
  it('历史 manifest 缺省运行语义 1，新 manifest 为 2', () => {
    expect(compositeRuntimeVersion({ runtimeVersion: undefined })).toBe(1)
    expect(compositeRuntimeVersion({ runtimeVersion: 2 })).toBe(2)
  })

  it('外部文本映射到契约声明的 in-text，作为虚拟上游而不是直接写正文', () => {
    const inputs = new Map([packet({ kind: 'text', text: '外部文案' })])
    const plan = planCompositeInputBindings(copyManifest(), inputs)
    expect(plan.issues).toEqual([])
    expect(plan.bindings).toHaveLength(1)
    expect(plan.bindings[0]).toMatchObject({
      inputId: 'copy',
      target: { nodeId: 'n1', portId: 'in-text' },
      sourceNodeType: 'text',
      sourcePortId: 'out-text',
      order: 1
    })
  })

  it('可选空值不注入、不报错；多值按调用顺序保留', () => {
    const optional = copyManifest({
      inputs: [{ ...copyManifest().inputs[0], required: false }]
    })
    expect(planCompositeInputBindings(optional, new Map()).issues).toEqual([])

    const many = copyManifest({
      inputs: [{ ...copyManifest().inputs[0], cardinality: 'many' }]
    })
    const inputs = new Map([
      [
        'in-copy',
        [
          { type: 'text', value: { kind: 'text', text: '第一份' }, source: { nodeId: 'a', portId: 'out-text', runId: 'r' }, createdAt: 1 },
          { type: 'text', value: { kind: 'text', text: '第二份' }, source: { nodeId: 'b', portId: 'out-text', runId: 'r' }, createdAt: 2 }
        ] as NodeValuePacket[]
      ]
    ])
    const plan = planCompositeInputBindings(many, inputs)
    expect(plan.issues).toEqual([])
    expect(plan.bindings.map((binding) => [binding.order, binding.value])).toEqual([
      [1, { kind: 'text', text: '第一份' }],
      [2, { kind: 'text', text: '第二份' }]
    ])
  })

  it('必需缺失与未验证类型给出可定位失败', () => {
    const missing = planCompositeInputBindings(copyManifest(), new Map())
    expect(missing.issues[0]).toMatchObject({ code: 'INPUT_REQUIRED', phase: 'input', publicPortId: 'copy' })

    const imageInput = copyManifest({
      inputs: [
        {
          id: 'copy',
          label: '参考图',
          type: 'image',
          required: true,
          cardinality: 'one',
          targets: [{ nodeId: 'n1', portId: 'in-text' }]
        }
      ]
    })
    const wrong = planCompositeInputBindings(
      imageInput,
      new Map([packet({ kind: 'text', text: '不是图片' })])
    )
    expect(wrong.issues[0]).toMatchObject({
      code: 'INPUT_TYPE_UNSUPPORTED',
      phase: 'input',
      publicPortId: 'copy'
    })
  })

  it('文本节点仍按普通合并规则把上游文本并入正文', () => {
    const inputs: ContractInputMap = new Map([
      packet({ kind: 'text', text: '外部文案' }, 'in-text')
    ])
    const updated: string[] = []
    const ctx = {
      node: { id: 'shape:n1', type: 'text', title: '文案', contractVersion: 3 },
      shape: {
        id: 'shape:n1',
        type: 'node-card',
        props: { nodeType: 'text', title: '文案', config: '', text: '内部说明', mediaId: '', mediaPath: '', mediaMime: '', exec: 'idle', w: 340, h: 300 },
        meta: {}
      },
      inputs,
      projectId: 'p',
      providers: [],
      signal: { cancelled: false, paused: false, onCancel: () => () => undefined },
      gateway: {},
      updateProps: (patch: { text?: string }) => {
        if (patch.text !== undefined) updated.push(patch.text)
      },
      updateResult: () => undefined
    } as unknown as NodeExecutionContext
    const result = textExecutor(ctx)
    expect(result.status).toBe('done')
    expect(updated[0]).toBe(`外部文案${TEXT_MERGE_SEPARATOR}内部说明`)
  })

  it('正式输出只取本次映射结果；必需输出缺失带节点与端口', () => {
    const manifest = copyManifest()
    const ok = collectCompositeOutputs(manifest, () => ({ kind: 'text', text: '整理后' }))
    expect(ok.issues).toEqual([])
    expect(ok.outputs.polished).toEqual({ kind: 'text', text: '整理后' })

    const missing = collectCompositeOutputs(manifest, () => undefined)
    expect(missing.issues[0]).toMatchObject({
      code: 'REQUIRED_OUTPUT_MISSING',
      phase: 'output',
      publicPortId: 'polished',
      nodeId: 'n1',
      portId: 'out-text'
    })

    const wrongType = collectCompositeOutputs(manifest, () => ({ kind: 'json', data: {} }))
    expect(wrongType.issues[0]).toMatchObject({
      code: 'OUTPUT_TYPE_MISMATCH',
      publicPortId: 'polished'
    })
  })

  it('输出投影只读成功运行写入的 nodeExtra，失败运行不暴露旧值', () => {
    const config = JSON.stringify({ manifest: copyManifest() })
    const success = {
      props: { nodeType: 'composite', config },
      meta: {
        nodeRun: { runId: 'r', status: 'success', startedAt: 1, inputs: {} },
        nodeExtra: JSON.stringify({ 'out-polished': { kind: 'text', text: '本次结果' } })
      }
    }
    expect(projectCompositeOutputs(success)).toEqual({
      'out-polished': { kind: 'text', text: '本次结果' }
    })
    const failed = {
      ...success,
      meta: { ...success.meta, nodeRun: { runId: 'r', status: 'failed', startedAt: 1, inputs: {} } }
    }
    expect(projectCompositeOutputs(failed)).toEqual({})
  })

  it('历史运行语义继续按媒体结果兼容，不要求 nodeExtra', () => {
    const legacy = copyManifest({
      runtimeVersion: undefined,
      outputs: [
        {
          id: 'image',
          label: '图',
          type: 'image',
          required: true,
          cardinality: 'one',
          source: { nodeId: 'n1', portId: 'out-image' }
        }
      ]
    })
    const shape = {
      props: { nodeType: 'composite', config: JSON.stringify({ manifest: legacy }) },
      meta: {
        nodeRun: { runId: 'r', status: 'success', startedAt: 1, inputs: {} },
        nodeResult: JSON.stringify({
          kind: 'media-source',
          version: 1,
          at: 1,
          selectedMediaId: 'm1',
          results: [{ mediaId: 'm1', mediaPath: 'projects/m1.png', mime: 'image/png', createdAt: 1 }]
        })
      }
    }
    expect(projectCompositeOutputs(shape)).toMatchObject({
      'out-image': { kind: 'image', mediaId: 'm1', mediaPath: 'projects/m1.png', mime: 'image/png' }
    })
  })

  it('端口值类型规则与普通节点一致（text/markdown 互认、any 接收）', () => {
    expect(compositeValueMatchesPort({ kind: 'markdown', text: '# x' }, 'text')).toBe(true)
    expect(compositeValueMatchesPort({ kind: 'text', text: 'x' }, 'markdown')).toBe(true)
    expect(compositeValueMatchesPort({ kind: 'json', data: 1 }, 'any')).toBe(true)
    expect(compositeValueMatchesPort({ kind: 'text', text: 'x' }, 'image')).toBe(false)
  })
})
