// 付费生成族的**接线级**验收：证明"外部/节点配置 → 共享执行器 → ctx.gateway.<method>() 入参"
// 这一段的逐字段正确性，**不产生任何真实模型请求**。
//
// 为什么这样验收：语音克隆、音色设计、视频生成按用户要求只做代码层接通，真实生成由用户自测；
// 图片生成可测但保持最小。所以本文件用"间谍 gateway"在调用边界拦截并记录入参、返回可预期的
// 假结果；同时用 fetch spy 断言全程 0 次联网。它证明的是**接线**，不是供应商受理/产物质量。
//
// 覆盖六类：image-gen、image-edit、video、speech（minimax / volc / 本地 indextts）、
// tts（音色克隆）、voice-design。每类断言：
//   入参归一化（单位/默认值/上限）、多参考顺序、缺失依赖时的拦截（执行器边界没有错误码字段，
//   稳定语义=status + 固定原因文案 + diagnosticPhase）、取消信号路径。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { imageGenExecutor } from '../src/shared/engine/executors/imageGen'
import { imageEditExecutor } from '../src/shared/engine/executors/imageEdit'
import { videoExecutor } from '../src/shared/engine/executors/video'
import { speechExecutor } from '../src/shared/engine/executors/speech'
import { ttsExecutor } from '../src/shared/engine/executors/tts'
import { voiceDesignExecutor } from '../src/shared/engine/executors/voiceDesign'
import { TEXT_MERGE_SEPARATOR } from '../src/shared/engine/helpers'
import type { NodeExecutionContext, NodeShape } from '../src/shared/engine/executor-types'
import type { NodeValuePacket } from '../src/shared/engine/inputs'
import type { GatewayClient } from '../src/shared/engine/gateway-client'
import type { MediaAsset, ProviderSummary } from '../src/shared/types'

// ── 联网兜底：任何真实网络请求都会让测试失败（并说明是哪个用例） ──
const realFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = ((..._args: unknown[]) => {
    throw new Error('NETWORK_FORBIDDEN: 接线级验收不得联网')
  }) as typeof globalThis.fetch
})

afterEach(() => {
  const stub = globalThis.fetch as unknown as { mock?: { calls: unknown[] } }
  // 明确证明：整轮用例里既有实现没有走 fetch（没有"顺手"发出去的请求）。
  expect(stub.mock?.calls ?? []).toHaveLength(0)
  globalThis.fetch = realFetch
})

// ── 间谍 gateway ──
interface RecordedCall {
  method: string
  args: unknown[]
  /** 第一个参数（绝大多数网关方法是单入参；videoCancel/videoTask 用 args 断言）。 */
  input: any
}

interface SpyHarness {
  gateway: GatewayClient
  calls: RecordedCall[]
  countOf(method: string): number
  inputOf(method: string): any
  argsOf(method: string): unknown[]
}

type Handler = (...args: any[]) => unknown

/**
 * 只声明被用到的网关方法：未声明的方法在对象上不存在（执行器按"本机没有该能力"分支处理），
 * 声明了但没有 handler 的方法被调用时直接失败——这样"多调了一次付费方法"不会静默通过。
 */
function spyGateway(handlers: Record<string, Handler | undefined>): SpyHarness {
  const calls: RecordedCall[] = []
  const gateway: Record<string, unknown> = {}
  for (const [method, handler] of Object.entries(handlers)) {
    if (!handler) continue
    gateway[method] = async (...args: unknown[]) => {
      calls.push({ method, args, input: args[0] })
      return await handler(...args)
    }
  }
  return {
    gateway: gateway as unknown as GatewayClient,
    calls,
    countOf: (method) => calls.filter((call) => call.method === method).length,
    inputOf: (method) => calls.find((call) => call.method === method)?.input,
    argsOf: (method) => calls.find((call) => call.method === method)?.args ?? []
  }
}

function mediaAsset(id: string, kind: 'image' | 'video' | 'audio'): MediaAsset {
  const mime = kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mp3'
  return {
    id,
    kind,
    mime,
    path: `projects/p1/media/${id}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'}`,
    sizeBytes: 1234,
    createdAt: 1,
    name: id
  }
}

function provider(
  id: string,
  specId: ProviderSummary['specId'],
  models: ProviderSummary['models'],
  hasApiKey = true
): ProviderSummary {
  return { id, name: id, specId, baseURL: '', models, createdAt: 1, hasApiKey }
}

function packet(
  type: NodeValuePacket['type'],
  value: NodeValuePacket['value'],
  portId: string
): NodeValuePacket {
  return {
    type,
    value,
    source: { nodeId: 'shape:upstream', portId, runId: 'run-upstream' },
    createdAt: 1
  }
}

const imagePacket = (mediaId: string, name = mediaId): NodeValuePacket =>
  packet(
    'image',
    { kind: 'image', mediaId, mediaPath: `projects/p1/media/${mediaId}.png`, mime: 'image/png', name },
    'out-image'
  )
const videoPacket = (mediaId: string): NodeValuePacket =>
  packet(
    'video',
    { kind: 'video', mediaId, mediaPath: `projects/p1/media/${mediaId}.mp4`, mime: 'video/mp4' },
    'out-video'
  )
const audioPacket = (mediaId: string): NodeValuePacket =>
  packet(
    'audio',
    { kind: 'audio', mediaId, mediaPath: `projects/p1/media/${mediaId}.wav`, mime: 'audio/wav' },
    'out-audio'
  )
const textPacket = (text: string): NodeValuePacket =>
  packet('text', { kind: 'text', text }, 'out-text')
const jsonPacket = (data: unknown): NodeValuePacket => packet('json', { kind: 'json', data }, 'out-json')

interface ContextOptions {
  nodeType: string
  config: Record<string, unknown>
  text?: string
  inputs?: Record<string, NodeValuePacket[]>
  providers?: ProviderSummary[]
  gateway: GatewayClient
  signal?: { cancelled: boolean; onCancel?: (listener: () => void) => () => void }
  traceId?: string
  nodeResult?: string
}

interface RecordedContext extends NodeExecutionContext {
  results: Array<string | null>
  metaPatches: Array<unknown>
  artifacts: Array<unknown>
  propPatches: Array<unknown>
  traces: Array<{ phase: string; level: string; message: string }>
}

function shapeFor(options: ContextOptions): NodeShape {
  return {
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
      h: 260
    },
    ...(options.nodeResult !== undefined ? { meta: { nodeResult: options.nodeResult } } : {})
  }
}

function contextFor(options: ContextOptions): RecordedContext {
  const results: Array<string | null> = []
  const metaPatches: Array<unknown> = []
  const artifacts: Array<unknown> = []
  const propPatches: Array<unknown> = []
  const traces: Array<{ phase: string; level: string; message: string }> = []
  const context: RecordedContext = {
    node: { id: 'shape:paid', type: options.nodeType, projectId: 'p1' } as never,
    shape: shapeFor(options),
    inputs: new Map(Object.entries(options.inputs ?? {})),
    projectId: 'p1',
    runId: 'run-1',
    providers: options.providers ?? [],
    signal: options.signal ?? { cancelled: false },
    gateway: options.gateway,
    trace: (phase, level, message) => traces.push({ phase, level, message }),
    ...(options.traceId
      ? {
          diagnostics: {
            traceId: options.traceId,
            nodeExecutionId: 'nexec-1',
            spanId: 'span-1'
          }
        }
      : {}),
    updateProps: (patch) => propPatches.push(patch),
    updateResult: (result) => results.push(result),
    updateMeta: (patch) => metaPatches.push(patch),
    emitArtifact: (artifact) => artifacts.push(artifact),
    results,
    metaPatches,
    artifacts,
    propPatches,
    traces
  }
  return context
}

const IMAGE_MODEL = {
  id: 'gpt-image-2-vip',
  name: 'GPT Image 2 VIP',
  modality: 'image' as const,
  operations: ['image.generate', 'image.edit']
}
const VIDEO_MODEL = {
  id: 'minimax-h3',
  name: 'MiniMax H3',
  modality: 'video' as const,
  operations: ['video.generate']
}
const SPEECH_MODEL = {
  id: 'speech-2.8-hd',
  name: 'MiniMax Speech 2.8 HD',
  modality: 'audio' as const,
  operations: ['speech.synthesize', 'voice.clone', 'voice.design']
}
/** 只有 2.6 系列声明了 emotional 参数，用它验证情绪下发（2.8 会被配置层收敛掉）。 */
const SPEECH_EMOTION_MODEL = {
  id: 'speech-2.6-hd',
  name: 'MiniMax Speech 2.6 HD',
  modality: 'audio' as const,
  operations: ['speech.synthesize', 'voice.design']
}
const CLONE_MODEL = {
  id: 'speech-2.8-turbo',
  name: 'MiniMax Speech 2.8 Turbo',
  modality: 'audio' as const,
  operations: ['voice.clone']
}
const VOLC_MODEL = {
  id: 'seed-audio-1.0',
  name: '火山语音合成 1.0',
  modality: 'audio' as const,
  operations: ['speech.synthesize']
}

/** 统一解析结果：与 main 的 resolveModelFeature 同形（只含脱敏后的执行目标）。 */
function featureBinding(providerId: string, modelId: string) {
  return { featureKey: 'x', providerId, modelId, operation: 'image.generate', modelKey: `${providerId}::${modelId}` }
}

describe('image-gen 接线（不产生真实请求）', () => {
  it('归一化旧像素尺寸/画幅/分辨率、逐张提交、按连接顺序去重参考图', async () => {
    let generated = 0
    const spy = spyGateway({
      imageGenerate: () => {
        generated += 1
        return { ok: true, data: mediaAsset(`gen-${generated}`, 'image') }
      }
    })
    const ctx = contextFor({
      nodeType: 'image-gen',
      config: {
        modelKey: 'toapis-1::gpt-image-2-vip',
        size: '1536x1024',
        count: 2,
        resolution: '2k',
        background: 'transparent'
      },
      text: '节点正文提示词',
      providers: [provider('toapis-1', 'toapis', [IMAGE_MODEL])],
      gateway: spy.gateway,
      traceId: 'trace-image-gen',
      inputs: {
        'in-text': [textPacket('上游文本')],
        'in-prompt': [jsonPacket({ prompt: '正向提示', style: '写实' })],
        // 顺序即语义：r2 先连接，r1 后连接；重复的 r2 只保留第一次出现的位置。
        'in-images': [imagePacket('r2'), imagePacket('r1'), imagePacket('r2')]
      }
    })
    const result = await imageGenExecutor(ctx)

    expect(result).toEqual({ status: 'done' })
    // 两张 = 两次独立请求（不折叠成供应商私有 n 参数）
    expect(spy.countOf('imageGenerate')).toBe(2)
    const first = spy.inputOf('imageGenerate')
    // 提示词顺序：prompt.bundle（prompt+style）→ 上游文本 → 节点正文
    const expectedPrompt = `正向提示\n写实\n上游文本${TEXT_MERGE_SEPARATOR}节点正文提示词`
    expect(first).toMatchObject({
      projectId: 'p1',
      providerId: 'toapis-1',
      modelId: 'gpt-image-2-vip',
      prompt: expectedPrompt,
      // 旧像素尺寸被迁移成等比画幅：TOAPIS 用 size 承载比例串，不额外发 aspectRatio。
      size: '16:9',
      resolution: '2k',
      background: 'transparent',
      referenceMediaIds: ['r2', 'r1']
    })
    expect(first.aspectRatio).toBeUndefined()
    // 每张图都有独立的诊断子项身份（batchId + itemId#序号）
    expect(first.diagnostics).toMatchObject({
      traceId: expect.any(String),
      batchId: expect.stringContaining('img-shape:paid')
    })
    expect(first.diagnostics.itemId).toContain('#1')
    expect(spy.calls[1].input.diagnostics.itemId).toContain('#2')
    expect(spy.calls[1].input.prompt).toBe(expectedPrompt)
    // 逐张持久化并产出资产（两次结果、两个 out-image 资产）
    expect(ctx.results).toHaveLength(2)
    expect(ctx.artifacts).toHaveLength(2)
    expect(ctx.artifacts[0]).toMatchObject({ kind: 'image', portId: 'out-image' })
  })

  it('上限夹紧、无提示词/取消/超量参考图都在请求前拦下', async () => {
    // count 0 → 至少 1 张
    const spyOnce = spyGateway({
      imageGenerate: () => ({ ok: true, data: mediaAsset('gen-1', 'image') })
    })
    expect(
      await imageGenExecutor(
        contextFor({
          nodeType: 'image-gen',
          config: { modelKey: 'toapis-1::gpt-image-2-vip', count: 0 },
          text: '提示词',
          providers: [provider('toapis-1', 'toapis', [IMAGE_MODEL])],
          gateway: spyOnce.gateway
        })
      )
    ).toEqual({ status: 'done' })
    expect(spyOnce.countOf('imageGenerate')).toBe(1)

    const spyNever = spyGateway({ imageGenerate: () => ({ ok: true, data: mediaAsset('x', 'image') }) })
    const base = {
      nodeType: 'image-gen',
      config: { modelKey: 'toapis-1::gpt-image-2-vip' },
      providers: [provider('toapis-1', 'toapis', [IMAGE_MODEL])],
      gateway: spyNever.gateway
    }
    // 无提示词
    expect(await imageGenExecutor(contextFor({ ...base, text: '' }))).toEqual({
      status: 'skipped',
      reason: '无提示词'
    })
    // 取消信号先于请求
    expect(
      await imageGenExecutor(contextFor({ ...base, text: '提示词', signal: { cancelled: true } }))
    ).toEqual({ status: 'skipped', reason: '已取消' })
    // 参考图超过模型上限（TOAPIS 6 张）
    const tooMany = Array.from({ length: 7 }, (_, index) => imagePacket(`ref-${index}`))
    const overLimit = await imageGenExecutor(
      contextFor({ ...base, text: '提示词', inputs: { 'in-images': tooMany } })
    )
    expect(overLimit.status).toBe('failed')
    expect(overLimit.reason).toContain('最多支持 6 张参考图')
    expect(spyNever.calls).toHaveLength(0)
  })

  it('模型专属分辨率档位不跨供应商外溢（即梦 1.5k 不发给 TOAPIS）', async () => {
    // 复现的真实接线缺口：normalizeImageGenerationConfig 会保留"用户意图档位"（1.5k），
    // 旧执行器只看 capabilities.resolutions 非空就原样下发，于是把即梦 5.0Pro 独有的
    // 档位发给了只支持 1k/2k/4k 的 TOAPIS。修复后：不支持就不发送，并留安全诊断。
    const spy = spyGateway({
      imageGenerate: () => ({ ok: true, data: mediaAsset('gen-resolution', 'image') })
    })
    const ctx = contextFor({
      nodeType: 'image-gen',
      config: {
        modelKey: 'toapis-1::gpt-image-2-vip',
        resolution: '1.5k',
        aspectRatio: '1:1'
      },
      text: '提示词',
      providers: [provider('toapis-1', 'toapis', [IMAGE_MODEL])],
      gateway: spy.gateway
    })
    expect(await imageGenExecutor(ctx)).toEqual({ status: 'done' })
    const input = spy.inputOf('imageGenerate')
    expect(input.resolution).toBeUndefined()
    expect(input.size).toBe('1:1')
    expect(ctx.traces.some((trace) => trace.message.includes('1.5k'))).toBe(true)
  })
})

describe('image-edit 接线（不产生真实请求）', () => {
  it('标注迁移/编号提示词、遮罩语义与 TOAPIS 不发 mask 的能力门控', async () => {
    const spy = spyGateway({
      imageEdit: () => ({ ok: true, data: mediaAsset('edited-1', 'image') })
    })
    const ctx = contextFor({
      nodeType: 'image-edit',
      config: {
        modelKey: 'toapis-1::gpt-image-2-vip',
        instruction: '把天空换成晚霞',
        aspectRatio: '16:9',
        resolution: '2k',
        annotations: [
          {
            id: 'a1',
            type: 'rect',
            // orange 是旧项目写法，读回时必须迁移成 blue（语义=替换/调整）
            color: 'orange',
            points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            text: '把天空换成晚霞'
          }
        ],
        mask: { enabled: true, strokes: [[{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }]], brushSize: 0.2, invert: false }
      },
      providers: [provider('toapis-1', 'toapis', [IMAGE_MODEL])],
      gateway: spy.gateway,
      inputs: {
        'in-image': [imagePacket('source-1', '原图')],
        'in-text': [textPacket('上游补充说明')]
      }
    })
    const result = await imageEditExecutor(ctx)

    expect(result).toEqual({ status: 'done' })
    expect(spy.countOf('imageEdit')).toBe(1)
    const input = spy.inputOf('imageEdit')
    expect(input).toMatchObject({
      projectId: 'p1',
      sourceMediaId: 'source-1',
      providerId: 'toapis-1',
      modelId: 'gpt-image-2-vip',
      size: 'auto'
    })
    // 提示词包含：说明 + 上游文本 + 两张参考的约定 + 编号标注说明
    expect(input.prompt).toContain('把天空换成晚霞')
    expect(input.prompt).toContain('上游补充说明')
    expect(input.prompt).toContain('第 1 张是原图，第 2 张是带标注的原图')
    expect(input.prompt).toContain('标注 1（矩形框选·替换或调整）：把天空换成晚霞')
    // TOAPIS 异步通道没有 mask 字段：遮罩配置保留在 config，但不得在提示词里承诺"只改遮罩区域"
    expect(input.prompt).not.toContain('请仅修改遮罩指定区域')
    expect(input.config).toMatchObject({
      aspectRatio: '16:9',
      resolution: '2k',
      mask: { enabled: true }
    })
    expect(input.config.annotations[0]).toMatchObject({ color: 'blue', type: 'rect', strokeWidth: 3 })
    // 产物命名沿用"（改）原名"
    expect(ctx.artifacts[0]).toMatchObject({ kind: 'image', portId: 'out-image' })
  })

  it('缺原图/取消/标注不完整都在请求前拦下', async () => {
    const spy = spyGateway({ imageEdit: () => ({ ok: true, data: mediaAsset('x', 'image') }) })
    const providers = [provider('toapis-1', 'toapis', [IMAGE_MODEL])]
    expect(
      await imageEditExecutor(
        contextFor({
          nodeType: 'image-edit',
          config: { modelKey: 'toapis-1::gpt-image-2-vip', instruction: '改' },
          providers,
          gateway: spy.gateway
        })
      )
    ).toEqual({ status: 'skipped', reason: '请连接一张图片到“原图”输入' })
    expect(
      await imageEditExecutor(
        contextFor({
          nodeType: 'image-edit',
          config: { modelKey: 'toapis-1::gpt-image-2-vip', instruction: '改' },
          providers,
          gateway: spy.gateway,
          signal: { cancelled: true },
          inputs: { 'in-image': [imagePacket('source-1')] }
        })
      )
    ).toEqual({ status: 'skipped', reason: '已取消' })
    const invalid = await imageEditExecutor(
      contextFor({
        nodeType: 'image-edit',
        config: {
          modelKey: 'toapis-1::gpt-image-2-vip',
          instruction: '改',
          annotations: [{ id: 'bad', type: 'rect', color: 'red', points: [{ x: 0, y: 0 }] }]
        },
        providers,
        gateway: spy.gateway,
        inputs: { 'in-image': [imagePacket('source-1')] }
      })
    )
    expect(invalid.status).toBe('skipped')
    expect(invalid.reason).toContain('矩形标注不完整')
    expect(spy.calls).toHaveLength(0)
  })
})

describe('video 接线（不产生真实请求）', () => {
  it('参考模式：多参考顺序、时长/画幅/清晰度归一化、@图片编号、轮询与终态', async () => {
    const spy = spyGateway({
      videoSubmit: () => ({ ok: true, data: { taskId: 'task-1' } }),
      videoTask: () => ({
        ok: true,
        data: {
          id: 'task-1',
          projectId: 'p1',
          nodeId: 'shape:paid',
          providerId: 'mm-1',
          modelId: 'minimax-h3',
          status: 'success',
          mediaId: 'video-1',
          mediaPath: 'projects/p1/media/video-1.mp4'
        }
      })
    })
    const ctx = contextFor({
      nodeType: 'video',
      config: {
        modelKey: 'mm-1::minimax-h3',
        mode: 'reference',
        // duration 99 超出模型档位 → 收敛到最短档 4s（按秒计费，默认不加长）
        params: { ratio: '9:16', duration: 99, resolution: '2K' }
      },
      text: '@图片1 里的角色在走路',
      providers: [provider('mm-1', 'minimax', [VIDEO_MODEL])],
      gateway: spy.gateway,
      traceId: 'trace-video-1',
      inputs: {
        'in-images': [imagePacket('img-1'), imagePacket('img-2')],
        'in-reference-video': [videoPacket('vid-1')],
        'in-reference-audio': [audioPacket('aud-1')]
      }
    })
    const result = await videoExecutor(ctx)

    expect(result).toEqual({ status: 'done' })
    expect(spy.countOf('videoSubmit')).toBe(1)
    const submitted = spy.inputOf('videoSubmit')
    expect(submitted).toMatchObject({
      projectId: 'p1',
      nodeId: 'shape:paid',
      providerId: 'mm-1',
      modelId: 'minimax-h3',
      mode: 'reference',
      // 编号解析：@图片1 → 第1张参考图（连接顺序稳定）
      prompt: '第1张参考图 里的角色在走路',
      referenceImageMediaIds: ['img-1', 'img-2'],
      referenceVideoMediaIds: ['vid-1'],
      referenceAudioMediaIds: ['aud-1']
    })
    expect(submitted.firstFrameMediaId).toBeUndefined()
    expect(submitted.lastFrameMediaId).toBeUndefined()
    // 单位归一化：非法时长回落最短档；合法画幅/清晰度原样进入 params
    expect(submitted.params).toEqual({ ratio: '9:16', duration: 4, resolution: '2K' })
    expect(submitted.diagnostics).toMatchObject({ traceId: 'trace-video-1' })
    // 终态轮询携带运行根 trace（诊断关联不缺失）
    expect(spy.argsOf('videoTask')).toEqual(['task-1', 'trace-video-1'])
    // 主进程轮询返回的正式媒体被持久化并产出资产
    expect(ctx.results).toHaveLength(1)
    expect(ctx.artifacts).toHaveLength(1)
    expect(ctx.artifacts[0]).toMatchObject({ kind: 'video', portId: 'out-video', mediaId: 'video-1' })
  })

  it('首帧模式：画幅由帧决定（不发送 ratio），提交失败如实返回', async () => {
    const spy = spyGateway({
      // 提交阶段失败：非可重试文案 → 立即失败，仍能断言入参
      videoSubmit: () => ({ ok: false, error: { code: 'UPSTREAM_DENIED', message: '供应商拒绝' } })
    })
    const result = await videoExecutor(
      contextFor({
        nodeType: 'video',
        config: { modelKey: 'mm-1::minimax-h3', mode: 'first-frame', params: { ratio: '9:16' } },
        text: '镜头推进',
        providers: [provider('mm-1', 'minimax', [VIDEO_MODEL])],
        gateway: spy.gateway,
        inputs: { 'in-images': [imagePacket('img-1')] }
      })
    )
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('供应商拒绝')
    const submitted = spy.inputOf('videoSubmit')
    expect(submitted.mode).toBe('first-frame')
    expect(submitted.firstFrameMediaId).toBe('img-1')
    // 首帧模式画幅跟帧走：minimax 明确不发送 ratio
    expect(submitted.params.ratio).toBeUndefined()
    expect(submitted.params.duration).toBe(4)
    expect(spy.countOf('videoTask')).toBe(0)
  })

  it('提交成功后收到取消：补偿取消远端任务，不进入轮询', async () => {
    const signal: { cancelled: boolean } = { cancelled: false }
    const spy = spyGateway({
      videoSubmit: () => {
        // 模拟"提交请求在途时用户点了停止"：结果回来时信号已置位
        signal.cancelled = true
        return { ok: true, data: { taskId: 'task-cancel' } }
      },
      videoCancel: () => ({ ok: true, data: true })
    })
    const result = await videoExecutor(
      contextFor({
        nodeType: 'video',
        config: { modelKey: 'mm-1::minimax-h3', mode: 'text' },
        text: '一段文本',
        providers: [provider('mm-1', 'minimax', [VIDEO_MODEL])],
        gateway: spy.gateway,
        signal,
        traceId: 'trace-cancel'
      })
    )
    expect(result).toEqual({ status: 'skipped', reason: '已取消' })
    // R-01：提交已成功而取消先到 → 必须补偿取消远端任务，否则远端会继续计费
    expect(spy.countOf('videoCancel')).toBe(1)
    expect(spy.argsOf('videoCancel')).toEqual(['task-cancel', 'trace-cancel'])
    expect(spy.countOf('videoTask')).toBe(0)
  })
})

describe('speech 接线（不产生真实请求）', () => {
  it('MiniMax 后端：模型绑定来自能力解析、音色档案优先于手填 voiceId、正文合并', async () => {
    const spy = spyGateway({
      resolveModelFeature: () => ({
        ok: true,
        data: { ...featureBinding('mm-1', 'speech-2.6-hd'), featureKey: 'speech.synthesize' }
      }),
      speechGenerate: () => ({
        ok: true,
        data: { asset: mediaAsset('speech-1', 'audio'), voiceId: 'designed-voice-1' }
      })
    })
    const ctx = contextFor({
      nodeType: 'speech',
      config: {
        backend: 'minimax',
        providerId: '',
        modelId: '',
        voiceId: 'manual-voice-id',
        speed: 1.2,
        volume: 0.8,
        pitch: 2,
        emotion: 'fluent'
      },
      text: '节点正文',
      providers: [provider('mm-1', 'minimax', [SPEECH_EMOTION_MODEL])],
      gateway: spy.gateway,
      traceId: 'trace-speech',
      inputs: {
        'in-text': [textPacket('上游旁白')],
        'in-voice': [jsonPacket({ voice_id: 'designed-voice-1', provider: 'minimax' })]
      }
    })
    const result = await speechExecutor(ctx)

    expect(result).toEqual({ status: 'done' })
    const input = spy.inputOf('speechGenerate')
    expect(input).toMatchObject({
      projectId: 'p1',
      // 供应商/模型来自能力解析（外部配置 providerId/modelId 为空）
      providerId: 'mm-1',
      modelId: 'speech-2.6-hd',
      // 上游音色档案优先于节点手填 voiceId
      voiceId: 'designed-voice-1',
      text: `上游旁白${TEXT_MERGE_SEPARATOR}节点正文`
    })
    // minimax 不接收参考音频数组（参考音频只属于火山协议）
    expect(input.referenceAudioIds).toBeUndefined()
    // 情绪参数在"按功能绑定解析模型"（config.modelId 为空）时必须按解析到的真实模型判断：
    // 修复前 parseSpeechConfig 用默认模型 speech-2.8-hd 猜测，把 2.6 系列才支持的 fluent 丢掉。
    expect(input.config).toMatchObject({
      backend: 'minimax',
      speed: 1.2,
      volume: 0.8,
      pitch: 2,
      emotion: 'fluent',
      // 格式由后端默认值决定（节点 UI 不暴露自定义采样率/格式）
      format: 'mp3'
    })
    // 网关确认的实际音色写进产物溯源
    expect(ctx.results[0]).toContain('designed-voice-1')
    expect(ctx.artifacts[0]).toMatchObject({ kind: 'audio', portId: 'out-audio' })
  })

  it('火山后端：连线音频按顺序 + 节点上传音频追加在末尾，超过 3 段在请求前拒绝', async () => {
    const spy = spyGateway({
      resolveModelFeature: () => ({
        ok: true,
        data: { ...featureBinding('volc-1', 'seed-audio-1.0'), featureKey: 'speech.synthesize' }
      }),
      speechGenerate: () => ({ ok: true, data: { asset: mediaAsset('speech-volc', 'audio') } })
    })
    const ctx = contextFor({
      nodeType: 'speech',
      config: {
        backend: 'volc',
        voiceId: 'speaker-abc',
        referenceAudioId: 'uploaded-3',
        referenceAudioPath: 'projects/p1/media/uploaded-3.wav'
      },
      text: '火山朗读文本',
      providers: [provider('volc-1', 'volc-speech', [VOLC_MODEL])],
      gateway: spy.gateway,
      inputs: { 'in-audio': [audioPacket('conn-1'), audioPacket('conn-2')] }
    })
    expect(await speechExecutor(ctx)).toEqual({ status: 'done' })
    const input = spy.inputOf('speechGenerate')
    expect(input.providerId).toBe('volc-1')
    expect(input.modelId).toBe('seed-audio-1.0')
    // 顺序 = 连线顺序，节点上传项在末尾
    expect(input.referenceAudioIds).toEqual(['conn-1', 'conn-2', 'uploaded-3'])
    expect(input.voiceId).toBe('speaker-abc')
    expect(input.config).toMatchObject({ backend: 'volc', format: 'wav' })

    // 3 段连线 + 1 段上传 = 4 段 → 超过火山上限，在任何请求之前失败
    const spyNever = spyGateway({
      resolveModelFeature: () => ({
        ok: true,
        data: { ...featureBinding('volc-1', 'seed-audio-1.0'), featureKey: 'speech.synthesize' }
      }),
      speechGenerate: () => ({ ok: true, data: {} })
    })
    const tooMany = await speechExecutor(
      contextFor({
        nodeType: 'speech',
        config: { backend: 'volc', voiceId: 'speaker-abc', referenceAudioId: 'u-4', referenceAudioPath: 'x' },
        text: '火山朗读文本',
        providers: [provider('volc-1', 'volc-speech', [VOLC_MODEL])],
        gateway: spyNever.gateway,
        inputs: {
          'in-audio': [audioPacket('c-1'), audioPacket('c-2'), audioPacket('c-3')]
        }
      })
    )
    expect(tooMany.status).toBe('failed')
    expect(tooMany.reason).toContain('最多支持 3 段参考音频')
    // 只发生了能力解析，没有发出任何合成请求
    expect(spyNever.countOf('speechGenerate')).toBe(0)
  })

  it('本地 IndexTTS：走本机通道并逐字段传递运行时参数，绝不落到付费方法', async () => {
    const signal: { cancelled: boolean } = { cancelled: false }
    const spy = spyGateway({
      indexttsSynthesize: () => {
        signal.cancelled = true
        return { ok: true, data: mediaAsset('local-tts', 'audio') }
      },
      // 即使声明了付费方法，本地后端也不得调用它
      speechGenerate: () => ({ ok: true, data: { asset: mediaAsset('paid', 'audio') } })
    })
    const ctx = contextFor({
      nodeType: 'speech',
      config: {
        backend: 'indextts',
        localPythonPath: 'C:\\python\\python.exe',
        localModelDir: 'D:\\models\\indextts-2.5',
        localDevice: 'cpu',
        localFp16: false,
        durationFactor: 1.15,
        localLang: 'ZH'
      },
      text: '本地合成文本',
      gateway: spy.gateway,
      signal,
      inputs: { 'in-audio': [audioPacket('ref-local')] }
    })
    const result = await speechExecutor(ctx)

    // 取消在合成返回后到达 → 按取消处理（迟到资产由执行器清理）
    expect(result).toEqual({ status: 'skipped', reason: '已取消' })
    expect(spy.countOf('speechGenerate')).toBe(0)
    expect(spy.countOf('indexttsSynthesize')).toBe(1)
    expect(spy.inputOf('indexttsSynthesize')).toEqual({
      projectId: 'p1',
      nodeId: 'shape:paid',
      text: '本地合成文本',
      referenceAudioId: 'ref-local',
      pythonPath: 'C:\\python\\python.exe',
      modelDir: 'D:\\models\\indextts-2.5',
      device: 'cpu',
      fp16: false,
      durationFactor: 1.15,
      lang: 'ZH'
    })
  })
})

describe('tts 音色克隆接线（不产生真实请求）', () => {
  it('参考音频来自连线时优先于节点上传，并把克隆参数与运行关联原样交给主进程', async () => {
    const spy = spyGateway({
      ttsGenerate: () => ({ ok: true, data: { voiceId: 'cloned-voice-1' } })
    })
    const ctx = contextFor({
      nodeType: 'tts',
      config: {
        providerId: 'mm-1',
        modelId: 'speech-2.8-turbo',
        voiceId: '',
        needNoiseReduction: true,
        needVolumeNormalization: true,
        aigcWatermark: true,
        textValidation: '参考音频原文',
        accuracy: 0.9,
        languageBoost: 'Chinese',
        promptMediaId: 'prompt-media-1',
        promptText: '克隆提示音原文',
        refMediaId: 'config-ref',
        refMediaPath: 'projects/p1/media/config-ref.mp3',
        format: 'wav'
      },
      text: '要克隆的内容',
      providers: [provider('mm-1', 'minimax', [CLONE_MODEL])],
      gateway: spy.gateway,
      traceId: 'trace-tts',
      inputs: { 'in-audio': [audioPacket('conn-ref-1')] }
    })
    const result = await ttsExecutor(ctx)

    expect(result).toEqual({ status: 'done' })
    const input = spy.inputOf('ttsGenerate')
    expect(input).toMatchObject({
      projectId: 'p1',
      runId: 'run-1',
      nodeId: 'shape:paid',
      traceId: 'trace-tts',
      // 连线参考音频优先于节点里配置的 refMediaId
      referenceAudioId: 'conn-ref-1'
    })
    expect(input.config).toMatchObject({
      providerId: 'mm-1',
      modelId: 'speech-2.8-turbo',
      needNoiseReduction: true,
      needVolumeNormalization: true,
      aigcWatermark: true,
      textValidation: '参考音频原文',
      accuracy: 0.9,
      languageBoost: 'Chinese',
      promptMediaId: 'prompt-media-1',
      promptText: '克隆提示音原文',
      format: 'wav'
    })
    // 复刻出的音色以结构化档案暴露给下游配音节点
    expect(ctx.metaPatches.at(-1)).toMatchObject({
      nodeExtra: expect.stringContaining('cloned-voice-1')
    })
  })

  it('节点上传参考音频时沿用 refMediaId，并在不可用/取消时拦截', async () => {
    const spy = spyGateway({ ttsGenerate: () => ({ ok: true, data: { voiceId: 'v-2' } }) })
    const ctx = contextFor({
      nodeType: 'tts',
      config: {
        providerId: 'mm-1',
        modelId: 'speech-2.8-turbo',
        refMediaId: 'config-ref',
        refMediaPath: 'projects/p1/media/config-ref.mp3'
      },
      providers: [provider('mm-1', 'minimax', [CLONE_MODEL])],
      gateway: spy.gateway
    })
    expect(await ttsExecutor(ctx)).toEqual({ status: 'done' })
    expect(spy.inputOf('ttsGenerate').referenceAudioId).toBe('config-ref')

    // 取消先于请求
    const spyCancel = spyGateway({ ttsGenerate: () => ({ ok: true, data: { voiceId: 'x' } }) })
    expect(
      await ttsExecutor(
        contextFor({
          nodeType: 'tts',
          config: { providerId: 'mm-1', modelId: 'speech-2.8-turbo', refMediaId: 'config-ref' },
          providers: [provider('mm-1', 'minimax', [CLONE_MODEL])],
          gateway: spyCancel.gateway,
          signal: { cancelled: true }
        })
      )
    ).toEqual({ status: 'skipped', reason: '已取消' })
    // 没有可用的克隆模型（供应商里只有不在复刻白名单里的音频模型）
    const spyNever = spyGateway({ ttsGenerate: () => ({ ok: true, data: { voiceId: 'x' } }) })
    const unavailable = await ttsExecutor(
      contextFor({
        nodeType: 'tts',
        config: { refMediaId: 'config-ref' },
        providers: [
          provider('mm-1', 'minimax', [
            { id: 'music-01-preview', name: '音乐模型', modality: 'audio' as const }
          ])
        ],
        gateway: spyNever.gateway
      })
    )
    expect(unavailable).toMatchObject({ status: 'skipped', diagnosticPhase: 'capability' })
    expect(unavailable.reason).toContain('当前 MiniMax 语音模型不可用')
    // API Key 未保存也不能发请求
    const noKey = await ttsExecutor(
      contextFor({
        nodeType: 'tts',
        config: { providerId: 'mm-1', modelId: 'speech-2.8-turbo', refMediaId: 'config-ref' },
        providers: [provider('mm-1', 'minimax', [CLONE_MODEL], false)],
        gateway: spyNever.gateway
      })
    )
    expect(noKey.reason).toContain('API Key 未保存')
    expect(spyCancel.calls).toHaveLength(0)
    expect(spyNever.calls).toHaveLength(0)
  })
})

describe('voice-design 接线（不产生真实请求）', () => {
  it('描述与上游文本合并、试听文本/水印参数原样下发，音色档案回写', async () => {
    const spy = spyGateway({
      resolveModelFeature: () => ({
        ok: true,
        data: { ...featureBinding('mm-1', 'speech-2.8-hd'), featureKey: 'voice.design' }
      }),
      voiceDesign: () => ({
        ok: true,
        data: { asset: mediaAsset('preview-1', 'audio'), voiceId: 'designed-voice-9' }
      })
    })
    const ctx = contextFor({
      nodeType: 'voice-design',
      config: {
        providerId: '',
        modelId: 'speech-2.8-hd',
        previewText: '试听一句话。',
        voiceId: '',
        aigcWatermark: true
      },
      text: '低沉沙哑的中年男声',
      providers: [provider('mm-1', 'minimax', [SPEECH_MODEL])],
      gateway: spy.gateway,
      inputs: { 'in-text': [textPacket('语速偏慢')] }
    })
    const result = await voiceDesignExecutor(ctx)

    expect(result).toEqual({ status: 'done' })
    const input = spy.inputOf('voiceDesign')
    expect(input).toMatchObject({
      projectId: 'p1',
      providerId: 'mm-1',
      prompt: `语速偏慢${TEXT_MERGE_SEPARATOR}低沉沙哑的中年男声`,
      config: { previewText: '试听一句话。', aigcWatermark: true, voiceId: '' }
    })
    // VoiceDesignInput 只接受 prompt/试听文本/水印等字段：不得凭空造一个 modelId 直发供应商
    expect('modelId' in input).toBe(false)
    expect(ctx.metaPatches.at(-1)).toMatchObject({
      nodeExtra: expect.stringContaining('designed-voice-9')
    })
    expect(ctx.artifacts[0]).toMatchObject({ kind: 'audio', portId: 'out-audio' })
  })

  it('非 MiniMax 绑定/取消/无描述都在请求前拦下', async () => {
    const nonMinimax = spyGateway({
      resolveModelFeature: () => ({
        ok: true,
        data: { ...featureBinding('relay-1', 'relay-voice-model'), featureKey: 'voice.design' }
      }),
      voiceDesign: () => ({ ok: true, data: {} })
    })
    const rejected = await voiceDesignExecutor(
      contextFor({
        nodeType: 'voice-design',
        config: { modelId: '', previewText: '试听' },
        text: '清亮女声',
        providers: [
          provider('relay-1', 'relay', [
            {
              id: 'relay-voice-model',
              name: '兼容语音模型',
              modality: 'audio' as const,
              operations: ['voice.design']
            }
          ])
        ],
        gateway: nonMinimax.gateway
      })
    )
    expect(rejected).toEqual({ status: 'failed', reason: '音色设计功能必须绑定 MiniMax 模型' })
    expect(nonMinimax.countOf('voiceDesign')).toBe(0)

    const spyNever = spyGateway({
      resolveModelFeature: () => ({
        ok: true,
        data: { ...featureBinding('mm-1', 'speech-2.8-hd'), featureKey: 'voice.design' }
      }),
      voiceDesign: () => ({ ok: true, data: {} })
    })
    expect(
      await voiceDesignExecutor(
        contextFor({
          nodeType: 'voice-design',
          config: { modelId: 'speech-2.8-hd' },
          text: '',
          providers: [provider('mm-1', 'minimax', [SPEECH_MODEL])],
          gateway: spyNever.gateway
        })
      )
    ).toEqual({ status: 'skipped', reason: '无音色描述' })
    expect(
      await voiceDesignExecutor(
        contextFor({
          nodeType: 'voice-design',
          config: { modelId: 'speech-2.8-hd' },
          text: '清亮女声',
          providers: [provider('mm-1', 'minimax', [SPEECH_MODEL])],
          gateway: spyNever.gateway,
          signal: { cancelled: true }
        })
      )
    ).toEqual({ status: 'skipped', reason: '已取消' })
    // 只发生了能力解析，没有发出任何设计请求
    expect(spyNever.countOf('voiceDesign')).toBe(0)
  })
})
