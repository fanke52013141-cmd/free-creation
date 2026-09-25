import { describe, expect, it } from 'vitest'
import { codeExecutor } from '@shared/engine/executors/code'
import type { NodeExecutionContext } from '@shared/engine/executor-types'
import type { NodeValuePacket } from '@shared/engine/inputs'
import type { NodeValue } from '@shared/engine/values'

function packet(portId: string, value: NodeValue, index = 0): NodeValuePacket {
  return {
    type: value.kind,
    value,
    source: { nodeId: `source-${index}`, portId: `out-${index}`, runId: `run-${index}` },
    createdAt: index
  }
}

function context(
  config: unknown,
  inputs: NodeExecutionContext['inputs'],
  runCode: NonNullable<NodeExecutionContext['runCode']>
): { ctx: NodeExecutionContext; result: { value: string | null } } {
  const result = { value: null as string | null }
  const ctx = {
    shape: {
      props: {
        nodeType: 'code',
        title: '代码',
        config: JSON.stringify(config),
        text: '',
        mediaId: '',
        mediaPath: '',
        mediaMime: '',
        exec: 'idle',
        w: 340,
        h: 260
      }
    },
    inputs,
    runCode,
    updateResult: (value: string | null) => {
      result.value = value
    }
  } as unknown as NodeExecutionContext
  return { ctx, result }
}

describe('代码执行器的输入输出映射', () => {
  it('many 输入按连线值组成数组，单个 JSON 数组保持为一个值', async () => {
    const inputs = new Map<string, readonly NodeValuePacket[]>([
      ['in-param-onelist', [packet('in-param-onelist', { kind: 'json', data: [1, 2] })]],
      [
        'in-param-manylists',
        [
          packet('in-param-manylists', { kind: 'json', data: [3] }, 1),
          packet('in-param-manylists', { kind: 'json', data: [4, 5] }, 2)
        ]
      ]
    ])
    let seenArgs: Record<string, unknown> = {}
    const { ctx, result } = context(
      {
        source: '',
        params: [
          { name: 'oneList', type: 'array', cardinality: 'one' },
          { name: 'manyLists', type: 'array', cardinality: 'many' }
        ],
        outputMode: 'fields',
        outputs: [{ name: 'combined', type: 'array' }]
      },
      inputs,
      async (_source, args) => {
        seenArgs = args
        return { kind: 'json', data: { combined: [args.oneList, args.manyLists] } }
      }
    )

    expect(await codeExecutor(ctx)).toEqual({ status: 'done' })
    expect(seenArgs.oneList).toEqual([1, 2])
    expect(seenArgs.manyLists).toEqual([[3], [4, 5]])
    expect(JSON.parse(result.value ?? '{}')).toEqual({
      kind: 'code-outputs',
      values: {
        'out-combined': {
          kind: 'json',
          data: [
            [1, 2],
            [[3], [4, 5]]
          ]
        }
      }
    })
  })

  it('媒体参数传资产引用，并将多字段结果投影为独立类型的值', async () => {
    const imageA = {
      kind: 'image' as const,
      mediaId: 'image-a',
      mediaPath: 'assets/a.png',
      mime: 'image/png'
    }
    const imageB = {
      kind: 'image' as const,
      mediaId: 'image-b',
      mediaPath: 'assets/b.png',
      mime: 'image/png'
    }
    const inputs = new Map<string, readonly NodeValuePacket[]>([
      [
        'in-param-references',
        [packet('in-param-references', imageA), packet('in-param-references', imageB, 1)]
      ]
    ])
    let seenArgs: Record<string, unknown> = {}
    const { ctx, result } = context(
      {
        source: '',
        params: [{ name: 'references', type: 'image', cardinality: 'many' }],
        outputMode: 'fields',
        outputs: [
          { name: 'caption', type: 'string' },
          { name: 'sourceImage', type: 'any' }
        ]
      },
      inputs,
      async (_source, args) => {
        seenArgs = args
        return {
          kind: 'json',
          data: {
            caption: '两张参考图',
            sourceImage: args.references instanceof Array ? args.references[0] : null
          }
        }
      }
    )

    expect(await codeExecutor(ctx)).toEqual({ status: 'done' })
    expect(seenArgs.references).toEqual([imageA, imageB])
    expect(seenArgs.images).toEqual([imageA, imageB])
    expect(JSON.parse(result.value ?? '{}')).toEqual({
      kind: 'code-outputs',
      values: {
        'out-caption': { kind: 'text', text: '两张参考图' },
        'out-sourceimage': imageA
      }
    })
  })

  it('机位参数按 camera 类型输入和输出，并执行 Schema 校验', async () => {
    const camera = {
      id: 'camera-1',
      name: '主镜头',
      x: 0,
      y: 1.6,
      z: 5,
      heading: 0,
      pitch: 0,
      focalLengthMm: 35,
      aspectRatio: '16:9',
      durationSec: 5,
      fps: 25
    }
    let seenArgs: Record<string, unknown> = {}
    const { ctx, result } = context(
      {
        source: '',
        params: [{ name: 'camera', type: 'camera' }],
        outputMode: 'fields',
        outputs: [{ name: 'preset', type: 'camera' }]
      },
      new Map([['in-param-camera', [packet('in-param-camera', { kind: 'camera', data: camera })]]]),
      async (_source, args) => {
        seenArgs = args
        return { kind: 'json', data: { preset: args.camera } }
      }
    )

    expect(await codeExecutor(ctx)).toEqual({ status: 'done' })
    expect(seenArgs.camera).toEqual(camera)
    expect(JSON.parse(result.value ?? '{}')).toEqual({
      kind: 'code-outputs',
      values: { 'out-preset': { kind: 'camera', data: camera } }
    })
  })
})
