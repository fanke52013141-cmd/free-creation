// 音频三族（语音合成 speech / 音色克隆 tts / 音色设计 voice-design）的**零成本门禁测试**。
//
// 为什么是"门禁"而不是"产出验收"：这三个节点的真实产出来自付费供应商（MiniMax 等），
// 验收阶段不做真实克隆/设计（会花钱）。本文件证明的是另一半同样重要的事实：
//   **在缺少已验证模型/凭据时，三个执行器在任何网络/付费调用之前就如实跳过或失败，
//   并给出与 GUI 同一句可读原因；它们绝不会发出计费请求，也不会伪造产物。**
//
// 手法：注入一个"凡是付费方法被调用就记录并抛错"的 gateway 代理，跑完后断言
// spendCalls 为空；同时断言 status/reason 精确匹配执行器源码里的门禁文案。
import { describe, expect, it } from 'vitest'
import { speechExecutor } from '../src/shared/engine/executors/speech'
import { ttsExecutor } from '../src/shared/engine/executors/tts'
import { voiceDesignExecutor } from '../src/shared/engine/executors/voiceDesign'
import type { NodeExecutionContext, NodeShape } from '../src/shared/engine/executor-types'
import type { NodeValuePacket } from '../src/shared/engine/inputs'

/** 一旦被调用就会计费/联网的方法：验收证明它们一次都没被调用。 */
const SPEND_METHODS = ['speechGenerate', 'ttsGenerate', 'voiceDesign', 'indexttsSynthesize'] as const

function shapeFor(nodeType: string, config: Record<string, unknown>, text = ''): NodeShape {
  return {
    props: {
      nodeType,
      title: nodeType,
      config: JSON.stringify(config),
      text,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      w: 340,
      h: 260
    }
  }
}

function audioPacket(mediaId: string): NodeValuePacket {
  return {
    type: 'audio',
    value: { kind: 'audio', mediaId, mediaPath: `projects/p1/media/${mediaId}.wav`, mime: 'audio/wav' },
    source: { nodeId: 'shape:ref', portId: 'out-audio', runId: 'run-1' },
    createdAt: 1
  }
}

function context(options: {
  nodeType: string
  config: Record<string, unknown>
  text?: string
  inputs?: Record<string, readonly NodeValuePacket[]>
  /** undefined = 环境没有 resolveModelFeature 通道；null = 有通道但没有已验证绑定。 */
  featureOption?: null | { provider: { id: string; specId: string }; model: { id: string } }
  hasFeatureChannel?: boolean
  spend: string[]
  hasIndexTtsChannel?: boolean
}): NodeExecutionContext {
  const spend = options.spend
  // 只有声明可用的通道才会存在；其余一律 undefined，模拟"本机没有该能力"。
  const gateway: Record<string, unknown> = {
    // 与真实网关同一形状：{ ok:false } 表示"功能未绑定已验证模型"（不是网络失败）。
    resolveModelFeature:
      options.hasFeatureChannel === false
        ? undefined
        : async () =>
            options.featureOption
              ? {
                  ok: true,
                  data: {
                    providerId: options.featureOption.provider.id,
                    modelId: options.featureOption.model.id
                  }
                }
              : { ok: false },
    indexttsSynthesize: options.hasIndexTtsChannel ? async () => undefined : undefined
  }
  for (const method of SPEND_METHODS) {
    gateway[method] = async () => {
      spend.push(method)
      throw new Error(`UNEXPECTED_SPEND_CALL:${method}`)
    }
  }
  if (!options.hasIndexTtsChannel) gateway.indexttsSynthesize = undefined
  return {
    node: { id: 'shape:audio', type: options.nodeType } as never,
    shape: shapeFor(options.nodeType, options.config, options.text ?? ''),
    inputs: new Map(Object.entries(options.inputs ?? {})),
    projectId: 'p1',
    runId: 'run-1',
    providers: [],
    signal: { cancelled: false },
    gateway: gateway as never,
    updateProps: () => undefined,
    updateResult: () => undefined,
    updateMeta: () => undefined
  } as NodeExecutionContext
}

describe('语音合成 speech（零成本门禁）', () => {
  it('无朗读文本 → skipped，不发任何请求', async () => {
    const spend: string[] = []
    const result = await speechExecutor(
      context({ nodeType: 'speech', config: { backend: 'minimax' }, text: '', spend })
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('无朗读文本')
    expect(spend).toEqual([])
  })

  it('MiniMax 后端但功能未绑定已验证语音模型 → skipped，不发任何请求', async () => {
    const spend: string[] = []
    const result = await speechExecutor(
      context({
        nodeType: 'speech',
        config: { backend: 'minimax' },
        text: '待合成的一段中文文本',
        spend,
        featureOption: null
      })
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('功能 speech.synthesize 尚未绑定已验证语音模型')
    expect(spend).toEqual([])
  })

  it('本地 IndexTTS 后端缺参考音频 → skipped（不会退化成付费通道）', async () => {
    const spend: string[] = []
    const result = await speechExecutor(
      context({
        nodeType: 'speech',
        config: { backend: 'indextts' },
        text: '本地合成文本',
        spend,
        hasIndexTtsChannel: true
      })
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('本地 IndexTTS 需要一段参考音频')
    expect(spend).toEqual([])
  })

  it('本地 IndexTTS 缺本机合成通道 → failed 并说明原因，仍不发付费请求', async () => {
    const spend: string[] = []
    const result = await speechExecutor(
      context({
        nodeType: 'speech',
        config: {
          backend: 'indextts',
          referenceAudioId: 'media-ref-1',
          referenceAudioPath: 'projects/p1/media/media-ref-1.wav'
        },
        text: '本地合成文本',
        spend,
        hasIndexTtsChannel: false
      })
    )
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('当前运行环境不支持本地 IndexTTS')
    expect(spend).toEqual([])
  })
})

describe('音色克隆 tts（零成本门禁）', () => {
  it('缺参考语音 → skipped（输入阶段拦下）', async () => {
    const spend: string[] = []
    const result = await ttsExecutor(
      context({ nodeType: 'tts', config: {}, text: '要克隆的内容', spend })
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('缺少参考语音')
    expect(result.diagnosticPhase).toBe('input')
    expect(spend).toEqual([])
  })

  it('有参考语音但没有可用的 MiniMax 语音模型 → skipped（能力阶段拦下），不发任何请求', async () => {
    const spend: string[] = []
    const result = await ttsExecutor(
      context({
        nodeType: 'tts',
        config: {},
        text: '要克隆的内容',
        inputs: { 'in-audio': [audioPacket('media-ref-1')] },
        spend,
        hasFeatureChannel: false
      })
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('当前 MiniMax 语音模型不可用')
    expect(result.diagnosticPhase).toBe('capability')
    expect(spend).toEqual([])
  })
})

describe('音色设计 voice-design（零成本门禁）', () => {
  it('无音色描述 → skipped', async () => {
    const spend: string[] = []
    const result = await voiceDesignExecutor(
      context({ nodeType: 'voice-design', config: {}, text: '', spend })
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('无音色描述')
    expect(spend).toEqual([])
  })

  it('有描述但功能未绑定已验证音色设计模型 → skipped，不发任何请求', async () => {
    const spend: string[] = []
    const result = await voiceDesignExecutor(
      context({
        nodeType: 'voice-design',
        config: {},
        text: '低沉、语速偏慢的中年男声，略带沙哑',
        spend,
        featureOption: null
      })
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('功能 voice.design 尚未绑定已验证音色设计模型')
    expect(spend).toEqual([])
  })

  it('没有功能解析通道且未选择供应商 → skipped（不猜测供应商）', async () => {
    const spend: string[] = []
    const result = await voiceDesignExecutor(
      context({
        nodeType: 'voice-design',
        config: {},
        text: '清亮的女声，语速轻快',
        spend,
        hasFeatureChannel: false
      })
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('未选择 MiniMax 供应商')
    expect(spend).toEqual([])
  })
})
