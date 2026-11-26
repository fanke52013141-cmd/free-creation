import { describe, expect, it, vi } from 'vitest'
import {
  FlowGraphSchema,
  validateFlowGraph,
  type FlowGraph,
  type FlowNode
} from '../src/shared/agent-flow/flow-graph'
import {
  compileFlowGraph,
  FlowGraphCompileError
} from '../src/shared/agent-flow/flow-graph-compiler'
import { validateNodeParams } from '../src/shared/agent-flow/node-params'
import { parseProcessor, processorExecutor } from '../src/shared/engine/executors/processor'
import { parseSpeechConfig } from '../src/shared/speech'
import { speechExecutor } from '../src/shared/engine/executors/speech'
import { parseTtsConfig } from '../src/shared/tts'
import { ttsExecutor } from '../src/shared/engine/executors/tts'
import { imageGenExecutor, parseImageGen } from '../src/shared/engine/executors/imageGen'
import { parseVideoGen } from '../src/shared/engine/helpers'
import { videoExecutor } from '../src/shared/engine/executors/video'
import { imageEditExecutor } from '../src/shared/engine/executors/imageEdit'
import { parseImageEditConfig } from '../src/shared/image-edit'
import type { NodeExecutionContext, NodeShape } from '../src/shared/engine/executor-types'
import type { GatewayClient } from '../src/shared/engine/gateway-client'
import type { ProviderSummary } from '../src/shared/types'

// 仅测试进程注入一个支持 seed 的能力组合，生产模型能力表不变。
vi.mock('../src/shared/video-capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/video-capabilities')>()
  const videoCapabilitiesFor: typeof actual.videoCapabilitiesFor = (specId, modelId, context) => {
    const base = actual.videoCapabilitiesFor(specId, modelId, context)
    if (modelId !== 'seed-supported-test') return base
    return {
      ...base,
      ratios: ['16:9'],
      durations: [4],
      resolutions: ['1080p'],
      defaultRatio: '16:9',
      defaultDuration: 4,
      defaultResolution: '1080p',
      modes: ['text'],
      supportsSeed: true
    }
  }
  return { ...actual, videoCapabilitiesFor }
})

const outputTargets: Record<string, string> = {
  'text-pass': 'in-text',
  'text-template': 'in-text',
  'image-gen': 'in-image',
  'image-edit': 'in-image',
  video: 'in-video',
  speech: 'in-audio',
  tts: 'in-json'
}
const outputPorts: Record<string, string> = {
  'text-pass': 'out-value',
  'text-template': 'out-value',
  'image-gen': 'out-image',
  'image-edit': 'out-image',
  video: 'out-video',
  speech: 'out-audio',
  tts: 'out-json'
}

function graphFor(
  capabilityId: string,
  version: string,
  params?: Record<string, unknown>
): FlowGraph {
  const capability: FlowNode = {
    nodeId: 'cap',
    title: 'cap',
    participation: 'autonomous',
    kind: 'capability',
    capabilityRef: { kind: 'node', id: capabilityId, version },
    goal: capabilityId === 'image-edit' ? '修改图片' : '生成结果',
    completion: '交付',
    ...(params !== undefined ? { params } : {})
  }
  return FlowGraphSchema.parse({
    schemaVersion: 1,
    graphId: 'params',
    name: 'params',
    goal: '验证公开参数',
    nodes: [
      capability,
      {
        nodeId: 'downstream',
        title: 'downstream',
        participation: 'autonomous',
        kind: 'agent',
        modelDefinitionId: 'fixture-model',
        allowedNodeIds: ['cap'],
        goal: '处理',
        completion: '交付'
      }
    ],
    edges: [
      {
        from: { nodeId: 'cap', portId: outputPorts[capabilityId] },
        to: { nodeId: 'downstream', portId: outputTargets[capabilityId] }
      }
    ],
    entry: 'cap',
    exits: ['downstream']
  })
}

function compileParams(
  capabilityId: string,
  version: string,
  params: Record<string, unknown>
): Record<string, unknown> {
  const graph = graphFor(capabilityId, version, params)
  expect(validateFlowGraph(graph)).toEqual({ ok: true })
  const compiled = compileFlowGraph(graph)
  const node = compiled.nodes.find((item) => item.id === 'shape:cap')
  expect(node).toBeTruthy()
  return JSON.parse(node!.config) as Record<string, unknown>
}

function compileError(graph: FlowGraph): FlowGraphCompileError {
  let caught: unknown
  try {
    compileFlowGraph(graph)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(FlowGraphCompileError)
  return caught as FlowGraphCompileError
}

function expectRejected(
  capabilityId: string,
  version: string,
  params: Record<string, unknown>,
  code: 'CAPABILITY_PARAMS_INVALID' | 'CAPABILITY_PARAMS_UNSUPPORTED'
): void {
  const graph = graphFor(capabilityId, version, params)
  const validation = validateFlowGraph(graph)
  expect(validation).toMatchObject({
    ok: false,
    errors: [{ code, nodeId: 'cap' }]
  })
  expect(compileError(graph).errors).toMatchObject([{ code, nodeId: 'cap' }])
}

function provider(
  id: string,
  specId: ProviderSummary['specId'],
  modelId: string,
  modality: 'image' | 'audio' | 'video',
  operations: string[]
): ProviderSummary {
  return {
    id,
    name: id,
    specId,
    baseURL: '',
    models: [{ id: modelId, name: modelId, modality, operations }],
    createdAt: 1,
    hasApiKey: true
  } as ProviderSummary
}

interface TestContext {
  ctx: NodeExecutionContext
  results: Array<string | null>
  meta: Array<unknown>
}

function contextFor(options: {
  nodeType: string
  config: Record<string, unknown>
  text?: string
  gateway?: GatewayClient
  providers?: ProviderSummary[]
  inputs?: NodeExecutionContext['inputs']
}): TestContext {
  const results: Array<string | null> = []
  const meta: Array<unknown> = []
  const shape: NodeShape = {
    props: {
      nodeType: options.nodeType,
      title: options.nodeType,
      config: JSON.stringify(options.config),
      text: options.text ?? '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      w: 340,
      h: 300
    },
    meta: {}
  }
  return {
    results,
    meta,
    ctx: {
      node: { id: 'shape:cap', type: options.nodeType, projectId: 'p1' } as never,
      shape,
      inputs: options.inputs ?? new Map(),
      projectId: 'p1',
      runId: 'run-1',
      providers: options.providers ?? [],
      signal: { cancelled: false },
      gateway: options.gateway ?? ({} as GatewayClient),
      updateProps: () => undefined,
      updateResult: (value) => results.push(value),
      updateMeta: (patch) => meta.push(patch),
      emitArtifact: () => undefined
    }
  }
}

function valueInput(
  portId: string,
  value:
    | { kind: 'json'; data: unknown }
    | { kind: 'text'; text: string }
    | { kind: 'audio' | 'image'; mediaId: string; mediaPath: string; mime: string }
): NodeExecutionContext['inputs'] {
  return new Map([
    [
      portId,
      [
        {
          type: value.kind,
          value,
          source: { nodeId: 'shape:source', portId: `out-${value.kind}`, runId: 'source-run' },
          createdAt: 1
        }
      ]
    ]
  ]) as NodeExecutionContext['inputs']
}

describe('FlowGraph capability params：validate → compile → 真实 parser/executor', () => {
  it('processor field 无损映射为 pick/path，并由真实 executor 提取字段', () => {
    const config = compileParams('text-pass', '1', {
      operation: 'field',
      field: 'scene.name'
    })
    expect(parseProcessor(JSON.stringify(config))).toMatchObject({
      operation: 'pick',
      path: 'scene.name'
    })
    expect(config.modelKey).toBeUndefined()
    expect(config.operation).toBe('pick')
    expect(config.path).toBe('scene.name')

    const { ctx, results } = contextFor({
      nodeType: 'processor',
      config,
      inputs: valueInput('in-value', { kind: 'json', data: { scene: { name: '雨巷' } } })
    })
    expect(processorExecutor(ctx)).toEqual({ status: 'done' })
    expect(JSON.parse(results[0]!)).toEqual({ kind: 'text', text: '雨巷' })
  })

  it('processor pass/template 保持真实语义，merge 与无对应操作的字段被拒绝', () => {
    // 载体默认 operation=template 时，单独覆盖 template 是既有兼容路径。
    const config = compileParams('text-template', '1', {
      template: '镜头：{{value}}'
    })
    const explicit = compileParams('text-pass', '1', {
      operation: 'template',
      template: '显式：{{value}}'
    })
    expect(parseProcessor(JSON.stringify(explicit))).toMatchObject({
      operation: 'template',
      template: '显式：{{value}}'
    })
    const { ctx, results } = contextFor({
      nodeType: 'processor',
      config,
      inputs: valueInput('in-value', { kind: 'text', text: '主角回头' })
    })
    expect(processorExecutor(ctx)).toEqual({ status: 'done' })
    expect(JSON.parse(results[0]!)).toEqual({ kind: 'text', text: '镜头：主角回头' })

    expectRejected('text-pass', '1', { operation: 'merge' }, 'CAPABILITY_PARAMS_UNSUPPORTED')
    expectRejected('text-pass', '1', { field: 'title' }, 'CAPABILITY_PARAMS_INVALID')
    expectRejected('text-pass', '1', { template: '{{value}}' }, 'CAPABILITY_PARAMS_INVALID')
    expectRejected('text-pass', '1', { operation: 'field' }, 'CAPABILITY_PARAMS_INVALID')
  })

  it('speech 的 modelKey/voice 兼容映射经 parser 与 gateway 保持同一身份和音色', async () => {
    const config = compileParams('speech', '4', {
      featureKey: 'speech.custom',
      modelKey: 'mm-1::speech-2.8-hd',
      backend: 'minimax',
      voice: 'voice-x',
      speed: 1.25
    })
    expect(config).toMatchObject({
      featureKey: 'speech.custom',
      providerId: 'mm-1',
      modelId: 'speech-2.8-hd',
      voiceId: 'voice-x',
      speed: 1.25
    })
    expect(config.modelKey).toBeUndefined()
    expect(config.voice).toBeUndefined()
    expect(parseSpeechConfig(JSON.stringify(config))).toMatchObject({
      featureKey: 'speech.custom',
      backend: 'minimax',
      providerId: 'mm-1',
      modelId: 'speech-2.8-hd',
      voiceId: 'voice-x',
      speed: 1.25
    })

    const speechGenerate = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        asset: { id: 'audio-1', path: 'audio-1.mp3', mime: 'audio/mpeg', name: 'audio-1' },
        voiceId: 'voice-x'
      }
    })
    const resolveModelFeature = vi.fn()
    const { ctx } = contextFor({
      nodeType: 'speech',
      config,
      text: '旁白',
      providers: [provider('mm-1', 'minimax', 'speech-2.8-hd', 'audio', ['speech.synthesize'])],
      gateway: { speechGenerate, resolveModelFeature } as unknown as GatewayClient
    })
    expect(await speechExecutor(ctx)).toEqual({ status: 'done' })
    // 明确的 modelKey 直接命中所选模型，不回落到其他功能绑定。
    expect(resolveModelFeature).not.toHaveBeenCalled()
    expect(speechGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'mm-1',
        modelId: 'speech-2.8-hd',
        voiceId: 'voice-x',
        config: expect.objectContaining({ featureKey: 'speech.custom', speed: 1.25 })
      })
    )
  })

  it('tts modelKey 映射到真实克隆身份；不支持的 backend/featureKey 不会落入 MiniMax', async () => {
    const config = compileParams('tts', '4', {
      modelKey: 'mm-1::speech-2.8-turbo',
      backend: 'minimax'
    })
    expect(parseTtsConfig(JSON.stringify(config))).toMatchObject({
      backend: 'minimax',
      providerId: 'mm-1',
      modelId: 'speech-2.8-turbo'
    })

    const ttsGenerate = vi.fn().mockResolvedValue({ ok: true, data: { voiceId: 'cloned-1' } })
    const { ctx, meta } = contextFor({
      nodeType: 'tts',
      config,
      providers: [provider('mm-1', 'minimax', 'speech-2.8-turbo', 'audio', ['voice.clone'])],
      gateway: { ttsGenerate } as unknown as GatewayClient,
      inputs: valueInput('in-audio', {
        kind: 'audio',
        mediaId: 'reference-1',
        mediaPath: 'reference-1.wav',
        mime: 'audio/wav'
      })
    })
    expect(await ttsExecutor(ctx)).toEqual({ status: 'done' })
    expect(ttsGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceAudioId: 'reference-1',
        config: expect.objectContaining({ providerId: 'mm-1', modelId: 'speech-2.8-turbo' })
      })
    )
    expect(meta.at(-1)).toMatchObject({ nodeExtra: expect.stringContaining('cloned-1') })

    expectRejected('tts', '4', { backend: 'openai' }, 'CAPABILITY_PARAMS_UNSUPPORTED')
    expectRejected('tts', '4', { featureKey: 'voice.clone' }, 'CAPABILITY_PARAMS_UNSUPPORTED')
  })

  it('image-gen 支持字段逐张到达 gateway；provider/seed/retry 等未兑现字段明确拒绝', async () => {
    const config = compileParams('image-gen', '3', {
      featureKey: 'image.custom',
      modelKey: 'toapis-1::gpt-image-2-vip',
      size: '1024x1024',
      aspectRatio: '1:1',
      resolution: '2k',
      background: 'transparent',
      count: 2
    })
    expect(parseImageGen(JSON.stringify(config))).toMatchObject({
      featureKey: 'image.custom',
      modelKey: 'toapis-1::gpt-image-2-vip',
      aspectRatio: '1:1',
      resolution: '2k',
      background: 'transparent',
      count: 2
    })

    const imageGenerate = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: { id: 'image-1', path: 'image-1.png', mime: 'image/png', name: 'image-1' }
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { id: 'image-2', path: 'image-2.png', mime: 'image/png', name: 'image-2' }
      })
    const { ctx } = contextFor({
      nodeType: 'image-gen',
      config,
      text: '一张测试图',
      providers: [provider('toapis-1', 'toapis', 'gpt-image-2-vip', 'image', ['image.generate'])],
      gateway: { imageGenerate } as unknown as GatewayClient
    })
    expect(await imageGenExecutor(ctx)).toEqual({ status: 'done' })
    expect(imageGenerate).toHaveBeenCalledTimes(2)
    for (const [call] of imageGenerate.mock.calls)
      expect(call).toMatchObject({
        providerId: 'toapis-1',
        modelId: 'gpt-image-2-vip',
        size: '1:1',
        resolution: '2k',
        background: 'transparent'
      })

    for (const params of [
      { providerKey: 'toapis-1' },
      { seed: 42 },
      { retry: { maxRetries: 1, backoffMs: 100 } },
      { retry: { maxRetries: 0 } }
    ])
      expectRejected('image-gen', '3', params, 'CAPABILITY_PARAMS_UNSUPPORTED')
  })

  it('image-gen featureKey 经 parser 保留，并到达真实模型功能解析入口', async () => {
    const config = compileParams('image-gen', '3', { featureKey: 'image.custom' })
    expect(parseImageGen(JSON.stringify(config)).featureKey).toBe('image.custom')
    const imageGenerate = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'image-feature', path: 'image-feature.png', mime: 'image/png', name: 'image' }
    })
    const resolveModelFeature = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        featureKey: 'image.custom',
        providerId: 'toapis-1',
        modelId: 'gpt-image-2-vip',
        operation: 'image.generate',
        modelKey: 'toapis-1::gpt-image-2-vip'
      }
    })
    const { ctx } = contextFor({
      nodeType: 'image-gen',
      config,
      text: '功能绑定测试',
      providers: [provider('toapis-1', 'toapis', 'gpt-image-2-vip', 'image', ['image.generate'])],
      gateway: { imageGenerate, resolveModelFeature } as unknown as GatewayClient
    })
    expect(await imageGenExecutor(ctx)).toEqual({ status: 'done' })
    expect(resolveModelFeature).toHaveBeenCalledWith({
      featureKey: 'image.custom',
      operation: 'image.generate'
    })
    expect(imageGenerate).toHaveBeenCalledOnce()
  })

  it('video 与 image-edit 的保留字段经真实 parser 读取，image-edit 同时到达 gateway', async () => {
    const video = compileParams('video', '7', {
      featureKey: 'video.custom',
      modelKey: 'mm-1::minimax-h3',
      mode: 'text',
      params: {
        ratio: '16:9',
        duration: 4,
        resolution: '1080p',
        generateAudio: true,
        seed: 7,
        watermark: true
      }
    })
    expect(parseVideoGen(JSON.stringify(video))).toMatchObject({
      featureKey: 'video.custom',
      modelKey: 'mm-1::minimax-h3',
      mode: 'text',
      params: {
        ratio: '16:9',
        duration: 4,
        resolution: '1080p',
        generateAudio: true,
        seed: 7,
        watermark: true
      }
    })
    expectRejected('video', '7', { providerKey: 'mm-1' }, 'CAPABILITY_PARAMS_UNSUPPORTED')

    const edit = compileParams('image-edit', '2', {
      featureKey: 'image.custom',
      modelKey: 'mm-1::image-editor',
      size: '1024x1024',
      aspectRatio: '16:9',
      instruction: '替换背景'
    })
    expect(parseImageEditConfig(JSON.stringify(edit))).toMatchObject({
      featureKey: 'image.custom',
      modelKey: 'mm-1::image-editor',
      size: '1024x1024',
      aspectRatio: '16:9',
      instruction: '替换背景'
    })
    const imageEdit = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'edited-1', path: 'edited-1.png', mime: 'image/png' }
    })
    const { ctx } = contextFor({
      nodeType: 'image-edit',
      config: edit,
      providers: [provider('mm-1', 'toapis', 'image-editor', 'image', ['image.edit'])],
      gateway: { imageEdit } as unknown as GatewayClient,
      inputs: valueInput('in-image', {
        kind: 'image',
        mediaId: 'source-image',
        mediaPath: 'source.png',
        mime: 'image/png'
      })
    })
    expect(await imageEditExecutor(ctx)).toEqual({ status: 'done' })
    expect(imageEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMediaId: 'source-image',
        providerId: 'mm-1',
        modelId: 'image-editor',
        prompt: '替换背景',
        config: expect.objectContaining({
          featureKey: 'image.custom',
          size: '1024x1024',
          aspectRatio: '16:9'
        })
      })
    )
    expectRejected('image-edit', '2', { providerKey: 'mm-1' }, 'CAPABILITY_PARAMS_UNSUPPORTED')
  })

  it('video featureKey 经公共 parser 到达真实模型功能解析入口', async () => {
    const config = compileParams('video', '7', { featureKey: 'video.custom', mode: 'text' })
    expect(parseVideoGen(JSON.stringify(config)).featureKey).toBe('video.custom')
    const resolveModelFeature = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        featureKey: 'video.custom',
        providerId: 'mm-1',
        modelId: 'minimax-h3',
        operation: 'video.generate',
        modelKey: 'mm-1::minimax-h3'
      }
    })
    const videoSubmit = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'UPSTREAM_DENIED', message: '测试拒绝' }
    })
    const { ctx } = contextFor({
      nodeType: 'video',
      config,
      text: '视频提示词',
      providers: [provider('mm-1', 'minimax', 'minimax-h3', 'video', ['video.generate'])],
      gateway: { resolveModelFeature, videoSubmit } as unknown as GatewayClient
    })
    const result = await videoExecutor(ctx)
    expect(result).toMatchObject({ status: 'failed' })
    expect(resolveModelFeature).toHaveBeenCalledWith({
      featureKey: 'video.custom',
      operation: 'video.generate'
    })
    expect(videoSubmit).toHaveBeenCalledOnce()
  })

  it('视频保留的嵌套参数由支持它们的模型身份传到 videoSubmit', async () => {
    const config = compileParams('video', '7', {
      modelKey: 'sd-1::seedance-2-5',
      mode: 'text',
      params: {
        ratio: '16:9',
        duration: 4,
        resolution: '1080p',
        generateAudio: true,
        watermark: false
      }
    })
    const videoSubmit = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'UPSTREAM_DENIED', message: '测试拒绝' }
    })
    const { ctx } = contextFor({
      nodeType: 'video',
      config,
      text: '视频参数测试',
      providers: [provider('sd-1', 'seedance', 'seedance-2-5', 'video', ['video.generate'])],
      gateway: { videoSubmit } as unknown as GatewayClient
    })
    expect(await videoExecutor(ctx)).toMatchObject({ status: 'failed' })
    expect(videoSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'sd-1',
        modelId: 'seedance-2-5',
        mode: 'text',
        params: {
          ratio: '16:9',
          duration: 4,
          resolution: '1080p',
          generateAudio: true,
          watermark: false
        }
      })
    )
  })

  it('video seed 按能力条件生效：支持时到 gateway，不支持时在提交前明确拒绝', async () => {
    const supportedConfig = compileParams('video', '7', {
      modelKey: 'sd-1::seed-supported-test',
      mode: 'text',
      params: { seed: 17 }
    })
    const videoSubmit = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'UPSTREAM_DENIED', message: '测试拒绝' }
    })
    const supported = contextFor({
      nodeType: 'video',
      config: supportedConfig,
      text: '支持种子的测试模型',
      providers: [provider('sd-1', 'seedance', 'seed-supported-test', 'video', ['video.generate'])],
      gateway: { videoSubmit } as unknown as GatewayClient
    })
    expect(await videoExecutor(supported.ctx)).toMatchObject({ status: 'failed' })
    expect(videoSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'seed-supported-test',
        params: expect.objectContaining({ seed: 17 })
      })
    )

    const rejectedSubmit = vi.fn()
    const rejectedConfig = compileParams('video', '7', {
      modelKey: 'sd-1::seedance-2-5',
      mode: 'text',
      params: { seed: 17 }
    })
    const rejected = contextFor({
      nodeType: 'video',
      config: rejectedConfig,
      text: '不支持种子的现有模型',
      providers: [provider('sd-1', 'seedance', 'seedance-2-5', 'video', ['video.generate'])],
      gateway: { videoSubmit: rejectedSubmit } as unknown as GatewayClient
    })
    expect(await videoExecutor(rejected.ctx)).toEqual({
      status: 'skipped',
      reason: '当前模型不支持种子参数'
    })
    expect(rejectedSubmit).not.toHaveBeenCalled()
  })

  it('值格式/范围仍为 INVALID；未知类型/字段和不支持枚举为 UNSUPPORTED', () => {
    expectRejected('image-gen', '3', { count: 99 }, 'CAPABILITY_PARAMS_INVALID')
    expectRejected('image-gen', '3', { count: '2' }, 'CAPABILITY_PARAMS_INVALID')
    expectRejected('speech', '4', { speed: 3 }, 'CAPABILITY_PARAMS_INVALID')
    expectRejected('speech', '4', { modelKey: 'missing-separator' }, 'CAPABILITY_PARAMS_INVALID')
    expectRejected('speech', '4', { backend: 'openai' }, 'CAPABILITY_PARAMS_UNSUPPORTED')
    expectRejected('image-gen', '3', { unknown: true }, 'CAPABILITY_PARAMS_UNSUPPORTED')
    expect(validateNodeParams('not-a-carrier', {})).toMatchObject({
      ok: false,
      code: 'CAPABILITY_PARAMS_UNSUPPORTED'
    })
  })
})
