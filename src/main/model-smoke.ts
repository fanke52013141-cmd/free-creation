/**
 * 真实模型验收器。
 *
 * 它运行在 Electron 主进程中，因此和桌面端共用同一份 safeStorage、SQLite 配置和
 * 网关实现；不会把 API Key 交给 shell、报告文件或渲染进程。用于在无法自动化桌面 UI
 * 时，仍能对用户已保存的模型配置做一次真正的、可追溯的最小调用。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { streamText } from 'ai'
import { createCanvas } from '@napi-rs/canvas'
import type { GatewayModelInfo, ProviderConfig, ProviderSummary } from '../shared/types'
import { DEFAULT_SPEECH_CONFIG, type SpeechBackend, type SpeechConfig } from '../shared/speech'
import { DEFAULT_TTS_CONFIG } from '../shared/tts'
import { DEFAULT_VOICE_DESIGN_CONFIG } from '../shared/voice-design'
import { DEFAULT_IMAGE_EDIT_CONFIG } from '../shared/image-edit'
import { getDataDir } from './store/db'
import { generateSpeechToAsset } from './gateway/audio'
import { createChatModel } from './gateway/factory'
import { startChat } from './gateway/chat'
import { generateImageEditToAsset, generateImageToAsset } from './gateway/image'
import { bootstrapLegacyProvidersToCatalog, getProvider, listProviders, type LegacyCatalogEntry } from './gateway/providers.repo'
import { designMiniMaxVoice } from './gateway/voice'
import { transformTts } from './media/tts-transform'
import { getDb } from './store/db'
import { SqliteModelHost } from './model-host/sqlite-model-host'
import type { ModelOperation } from '@free-creation/model-contracts'

export type SmokeKind =
  'configuration' | 'text' | 'chat' | 'image' | 'image-edit' | 'speech' | 'voice-design' | 'voice-clone'
export type SmokeStatus = 'pass' | 'fail' | 'skipped'

export interface SmokeTarget {
  kind: Exclude<SmokeKind, 'voice-design' | 'voice-clone' | 'configuration' | 'image-edit'>
  provider: ProviderSummary
  model: GatewayModelInfo
}

export interface SmokeResult {
  id: string
  kind: SmokeKind
  status: SmokeStatus
  provider: { id: string; name: string; specId: string }
  modelId?: string
  durationMs: number
  detail: string
  asset?: { id: string; path: string; mime: string }
}

export interface ModelSmokeReport {
  version: 1
  runId: string
  startedAt: string
  finishedAt: string
  projectId: string
  scope: 'text-image-audio-no-video'
  totals: { pass: number; fail: number; skipped: number }
  results: SmokeResult[]
}

export interface ModelSmokeOptions {
  /** 未传时按完整范围验收；传入后只执行指定模态，适合修复后的低成本复测。 */
  kinds?: ReadonlyArray<Exclude<SmokeKind, 'voice-design' | 'voice-clone' | 'configuration'>>
  includeVoiceDesign?: boolean
  /** 使用本轮生成的非真人参考音频，验证 MiniMax 克隆及用新音色再合成的完整链路。 */
  includeVoiceClone?: boolean
  /** 验证对话节点实际使用的主进程流式事件通道（不是仅探测模型）。 */
  includeChatNode?: boolean
}

const DEFAULT_FEATURE_KEYS: Partial<Record<ModelOperation, string[]>> = {
  'text.generate': ['chat.generate', 'text.process', 'script.breakdown'],
  'image.generate': ['image.generate'],
  'image.edit': ['image.edit'],
  'speech.synthesize': ['speech.synthesize'],
  'voice.design': ['voice.design'],
  'voice.clone': ['voice.clone']
}

const SMOKE_TIMEOUT_MS: Record<SmokeKind, number> = {
  configuration: 0,
  // 对话最小请求不该长期无回执；中转站卡住时继续下一项并留下失败证据。
  text: 90_000,
  chat: 90_000,
  // 图片任务与 MiniMax 异步语音本身允许更长的服务端轮询时间。
  image: 12 * 60_000,
  'image-edit': 12 * 60_000,
  speech: 12 * 60_000,
  'voice-design': 90_000,
  'voice-clone': 12 * 60_000
}

async function withTimeout<T>(kind: SmokeKind, task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${kind} 验收超过 ${SMOKE_TIMEOUT_MS[kind] / 1000} 秒仍未完成`)),
          SMOKE_TIMEOUT_MS[kind]
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 只取明确标为三个本次验收模态的模型；视频永远不在这个入口调用。 */
export function collectSmokeTargets(providers: ProviderSummary[]): SmokeTarget[] {
  const seen = new Set<string>()
  const targets: SmokeTarget[] = []
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.modality !== 'text' && model.modality !== 'image' && model.modality !== 'audio')
        continue
      const key = `${provider.id}:${model.id}:${model.modality}`
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({
        kind: model.modality === 'audio' ? 'speech' : model.modality,
        provider,
        model
      })
    }
  }
  return targets
}

function publicProvider(provider: ProviderSummary | ProviderConfig): SmokeResult['provider'] {
  return { id: provider.id, name: provider.name, specId: provider.specId }
}

function assetSummary(asset: { id: string; path: string; mime: string }): SmokeResult['asset'] {
  return { id: asset.id, path: asset.path, mime: asset.mime }
}

function errorDetail(error: unknown, provider: ProviderConfig): string {
  const raw = error instanceof Error ? error.message : String(error)
  // 防御性脱敏：上游错误和 SDK 堆栈不应有机会把已保存密钥写进报告。
  return raw.replaceAll(provider.apiKey, '***').replace(/\s+/g, ' ').slice(0, 600)
}

function speechBackendFor(provider: ProviderConfig): SpeechBackend {
  if (provider.specId === 'minimax') return 'minimax'
  if (provider.specId === 'doubao-speech') return 'doubao'
  return 'openai'
}

function speechConfigFor(provider: ProviderConfig, modelId: string): SpeechConfig {
  return {
    ...DEFAULT_SPEECH_CONFIG,
    backend: speechBackendFor(provider),
    providerId: provider.id,
    modelId
  }
}

async function runText(target: SmokeTarget): Promise<Omit<SmokeResult, 'id'>> {
  const started = Date.now()
  const provider = getProvider(target.provider.id)
  if (!provider) {
    return {
      kind: 'text',
      status: 'fail',
      provider: publicProvider(target.provider),
      modelId: target.model.id,
      durationMs: Date.now() - started,
      detail: '供应商记录不存在'
    }
  }
  try {
    const result = streamText({
      model: createChatModel(provider.id, target.model.id),
      prompt: '这是连通性验收。请只回复 OK。',
      // 推理型模型可能先耗掉一小段输出预算再给正文；16 会造成“请求成功但正文为空”的假失败。
      maxOutputTokens: 96,
      temperature: 0
    })
    let text = ''
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') text += part.text
    }
    // AI SDK 会在流消费完后汇总最终文本。少数兼容服务只填最终值、不发 text-delta，
    // 两个来源合并后才判断为空，避免把协议差异误报成模型不可用。
    text ||= await result.text
    if (!text.trim())
      throw new Error('模型未返回可用正文（可能只返回推理内容或该模型不支持当前流式协议）')
    return {
      kind: 'text',
      status: 'pass',
      provider: publicProvider(provider),
      modelId: target.model.id,
      durationMs: Date.now() - started,
      detail: `真实对话成功，收到 ${text.trim().slice(0, 80)}`
    }
  } catch (error) {
    return {
      kind: 'text',
      status: 'fail',
      provider: publicProvider(provider),
      modelId: target.model.id,
      durationMs: Date.now() - started,
      detail: errorDetail(error, provider)
    }
  }
}

/**
 * 对话节点不直接 await 模型，而是通过 gateway/chat 的流式事件写回渲染器。此验收刻意
 * 走同一个 startChat 入口，确认真实供应商能返回 text-delta 且以 chat-done 正常收尾。
 */
async function runChatNodeTransport(target: SmokeTarget): Promise<Omit<SmokeResult, 'id'>> {
  const started = Date.now()
  const provider = getProvider(target.provider.id)
  if (!provider) {
    return { kind: 'chat', status: 'fail', provider: publicProvider(target.provider), modelId: target.model.id, durationMs: Date.now() - started, detail: '供应商记录不存在' }
  }
  try {
    const response = await new Promise<string>((resolve, reject) => {
      let taskId = ''
      let text = ''
      const timer = setTimeout(() => reject(new Error('对话流式事件未在期限内完成')), SMOKE_TIMEOUT_MS.chat)
      taskId = startChat(
        (event) => {
          if (event.taskId !== taskId) return
          if (event.kind === 'chat-delta') text += event.text
          if (event.kind === 'chat-error') {
            clearTimeout(timer)
            reject(new Error(event.error))
          }
          if (event.kind === 'chat-done') {
            clearTimeout(timer)
            resolve(text)
          }
        },
        {
          providerId: provider.id,
          modelId: target.model.id,
          // 与文本模型验收使用同一条最小指令，排除具体措辞触发上游内容策略的干扰。
          messages: [{ role: 'user', content: '这是连通性验收。请只回复 OK。' }],
          temperature: 0,
          maxTokens: 96
        }
      )
    })
    if (!response.trim()) throw new Error('对话流式通道完成但未收到正文分片')
    return { kind: 'chat', status: 'pass', provider: publicProvider(provider), modelId: target.model.id, durationMs: Date.now() - started, detail: `对话节点流式通道成功，收到 ${response.trim().slice(0, 80)}` }
  } catch (error) {
    return { kind: 'chat', status: 'fail', provider: publicProvider(provider), modelId: target.model.id, durationMs: Date.now() - started, detail: errorDetail(error, provider) }
  }
}

async function runImage(target: SmokeTarget, projectId: string): Promise<Omit<SmokeResult, 'id'>> {
  const started = Date.now()
  const provider = getProvider(target.provider.id)
  if (!provider)
    return {
      kind: 'image',
      status: 'fail',
      provider: publicProvider(target.provider),
      modelId: target.model.id,
      durationMs: Date.now() - started,
      detail: '供应商记录不存在'
    }
  try {
    const asset = await generateImageToAsset({
      projectId,
      providerId: provider.id,
      modelId: target.model.id,
      prompt: '极简测试图：白色背景中央一枚纯蓝色圆点，无文字，无水印。',
      size: 'auto'
    })
    return {
      kind: 'image',
      status: 'pass',
      provider: publicProvider(provider),
      modelId: target.model.id,
      durationMs: Date.now() - started,
      detail: '真实生图成功，结果已落入测试媒体库',
      asset: assetSummary(asset)
    }
  } catch (error) {
    return {
      kind: 'image',
      status: 'fail',
      provider: publicProvider(provider),
      modelId: target.model.id,
      durationMs: Date.now() - started,
      detail: errorDetail(error, provider)
    }
  }
}

/** 生成标准 PNG：只为确认图生图请求真正携带了参考图片，不读取用户素材。 */
function smokeReferencePng(): Buffer {
  const canvas = createCanvas(64, 64)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, 64, 64)
  context.fillStyle = '#1976d2'
  context.beginPath()
  context.arc(32, 32, 14, 0, Math.PI * 2)
  context.fill()
  return canvas.toBuffer('image/png')
}

async function runImageEdit(target: SmokeTarget, projectId: string): Promise<Omit<SmokeResult, 'id'>> {
  const started = Date.now()
  const provider = getProvider(target.provider.id)
  if (!provider) {
    return { kind: 'image-edit', status: 'fail', provider: publicProvider(target.provider), modelId: target.model.id, durationMs: Date.now() - started, detail: '供应商记录不存在' }
  }
  try {
    const asset = await generateImageEditToAsset(
      {
        projectId,
        sourceMediaId: 'model-smoke-reference-image',
        providerId: provider.id,
        modelId: target.model.id,
        prompt: '将参考图中的蓝色圆点改为绿色圆点，保持白色背景且不要添加文字。',
        size: 'auto',
        config: { ...DEFAULT_IMAGE_EDIT_CONFIG, instruction: '将蓝色圆点改为绿色圆点。' }
      },
      [smokeReferencePng()]
    )
    return {
      kind: 'image-edit', status: 'pass', provider: publicProvider(provider), modelId: target.model.id,
      durationMs: Date.now() - started, detail: '真实图片编辑成功，参考图片已上传并返回编辑结果', asset: assetSummary(asset)
    }
  } catch (error) {
    return { kind: 'image-edit', status: 'fail', provider: publicProvider(provider), modelId: target.model.id, durationMs: Date.now() - started, detail: errorDetail(error, provider) }
  }
}

async function runSpeech(target: SmokeTarget, projectId: string): Promise<Omit<SmokeResult, 'id'>> {
  const started = Date.now()
  const provider = getProvider(target.provider.id)
  if (!provider)
    return {
      kind: 'speech',
      status: 'fail',
      provider: publicProvider(target.provider),
      modelId: target.model.id,
      durationMs: Date.now() - started,
      detail: '供应商记录不存在'
    }
  try {
    const result = await generateSpeechToAsset({
      projectId,
      providerId: provider.id,
      modelId: target.model.id,
      text: '模型连通性测试成功。',
      voiceId: '',
      config: speechConfigFor(provider, target.model.id)
    })
    return {
      kind: 'speech',
      status: 'pass',
      provider: publicProvider(provider),
      modelId: target.model.id,
      durationMs: Date.now() - started,
      detail: '真实语音合成成功，结果已落入测试媒体库',
      asset: assetSummary(result.asset)
    }
  } catch (error) {
    return {
      kind: 'speech',
      status: 'fail',
      provider: publicProvider(provider),
      modelId: target.model.id,
      durationMs: Date.now() - started,
      detail: errorDetail(error, provider)
    }
  }
}

async function runVoiceDesign(
  providerSummary: ProviderSummary,
  projectId: string
): Promise<Omit<SmokeResult, 'id'>> {
  const started = Date.now()
  const provider = getProvider(providerSummary.id)
  if (!provider)
    return {
      kind: 'voice-design',
      status: 'fail',
      provider: publicProvider(providerSummary),
      durationMs: Date.now() - started,
      detail: '供应商记录不存在'
    }
  try {
    const result = await designMiniMaxVoice({
      projectId,
      providerId: provider.id,
      prompt: '清晰、温和、自然的中文旁白声线，语速平稳。',
      config: { ...DEFAULT_VOICE_DESIGN_CONFIG, providerId: provider.id }
    })
    return {
      kind: 'voice-design',
      status: 'pass',
      provider: publicProvider(provider),
      durationMs: Date.now() - started,
      detail: `真实音色设计成功，已获得可引用的 voice_id：${result.voiceId}`,
      asset: assetSummary(result.asset)
    }
  } catch (error) {
    return {
      kind: 'voice-design',
      status: 'fail',
      provider: publicProvider(provider),
      durationMs: Date.now() - started,
      detail: errorDetail(error, provider)
    }
  }
}

/**
 * 不读取用户素材：先合成一段足够长的机器语音，再将这段本地产物作为参考音频。
 * 这会覆盖上传、voice_clone、返回 voice_id 以及用新音色再合成的完整生产链路。
 */
async function runVoiceClone(
  providerSummary: ProviderSummary,
  modelId: string,
  projectId: string
): Promise<Omit<SmokeResult, 'id'>> {
  const started = Date.now()
  const provider = getProvider(providerSummary.id)
  if (!provider) {
    return {
      kind: 'voice-clone',
      status: 'fail',
      provider: publicProvider(providerSummary),
      modelId,
      durationMs: Date.now() - started,
      detail: '供应商记录不存在'
    }
  }
  try {
    const reference = await generateSpeechToAsset({
      projectId,
      providerId: provider.id,
      modelId,
      // 约 20 秒，满足 MiniMax 参考音频至少 10 秒的限制。
      text: '这是用于模型连通性验收的合成参考语音，不包含任何真人录音或个人信息。它以平稳清晰的普通话朗读一段足够长的测试内容，用于验证上传、音色复刻和后续语音合成的完整流程。',
      voiceId: '',
      config: speechConfigFor(provider, modelId)
    })
    const cloned = await transformTts({
      projectId,
      referenceAudioId: reference.asset.id,
      text: '语音克隆链路验证成功。',
      config: {
        ...DEFAULT_TTS_CONFIG,
        providerId: provider.id,
        modelId,
        text: '语音克隆链路验证成功。'
      }
    })
    return {
      kind: 'voice-clone',
      status: 'pass',
      provider: publicProvider(provider),
      modelId,
      durationMs: Date.now() - started,
      detail: `真实语音克隆与新音色合成成功，已获得 voice_id：${cloned.voiceId}`,
      asset: assetSummary(cloned.asset)
    }
  } catch (error) {
    return {
      kind: 'voice-clone',
      status: 'fail',
      provider: publicProvider(provider),
      modelId,
      durationMs: Date.now() - started,
      detail: errorDetail(error, provider)
    }
  }
}

function skippedResult(target: SmokeTarget, reason: string): SmokeResult {
  return {
    id: randomUUID(),
    kind: target.kind,
    status: 'skipped',
    provider: publicProvider(target.provider),
    modelId: target.model.id,
    durationMs: 0,
    detail: reason
  }
}

/**
 * 逐个真实调用已配置的文本、图片和音频模型。每次运行使用独立 projectId，产物保留为
 * 可复核证据；克隆验收只使用本轮生成的机器语音，不上传用户录音。
 */
export async function runModelSmokeTest(
  options: ModelSmokeOptions = {}
): Promise<{ report: ModelSmokeReport; reportPath: string }> {
  const runId = randomUUID()
  const startedAt = new Date().toISOString()
  const projectId = `model-smoke-${runId}`
  const catalogHost = new SqliteModelHost(getDb())
  const importedEntries = bootstrapLegacyProvidersToCatalog(catalogHost)
  // 旧配置导入后，仍用导入前读取到的 legacy provider 做本轮真实调用；新目录只有
  // 在以下实际调用成功后才会出现 verified 记录并成为节点的唯一可选来源。
  const importedByLegacyModel = new Map(
    importedEntries.map((entry) => [`${entry.legacyProviderId}::${entry.modelId}`, entry])
  )
  const providers = listProviders()
  const allowedKinds = new Set(options.kinds ?? ['text', 'image', 'speech'])
  const targets = collectSmokeTargets(providers).filter((target) => allowedKinds.has(target.kind))
  const results: SmokeResult[] = []
  const reportsDir = join(getDataDir(), 'model-smoke-reports')
  await mkdir(reportsDir, { recursive: true })
  const reportPath = join(
    reportsDir,
    `${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${runId}.json`
  )
  const report: ModelSmokeReport = {
    version: 1,
    runId,
    startedAt,
    finishedAt: startedAt,
    projectId,
    scope: 'text-image-audio-no-video',
    totals: { pass: 0, fail: 0, skipped: 0 },
    results
  }
  // 每完成一项立即覆盖同一份报告；故障/超时不会让之前已经完成的真跑证据丢失。
  const persist = async (): Promise<void> => {
    report.finishedAt = new Date().toISOString()
    report.totals = {
      pass: results.filter((result) => result.status === 'pass').length,
      fail: results.filter((result) => result.status === 'fail').length,
      skipped: results.filter((result) => result.status === 'skipped').length
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }

  const recordCatalogPass = async (
    kind: SmokeKind,
    providerId: string,
    modelId: string | undefined,
    detail: string
  ): Promise<void> => {
    if (!modelId) return
    // 首次导入的同一轮可直接用内存映射；之后的低成本单项复测也必须能回写
    // 既有目录，不能因为“不是第一轮”而只显示成功却没有真正激活功能键。
    const entry: LegacyCatalogEntry | undefined =
      importedByLegacyModel.get(`${providerId}::${modelId}`) ?? (() => {
        // 已接管的 providerId 本身就是 legacy-<oldId>；不可再加一次前缀，
        // 否则“真实验收通过”会找不到同一条目录连接，验证记录无法回写。
        const connectionId = providerId.startsWith('legacy-') ? providerId : `legacy-${providerId}`
        const model = catalogHost.listModels(connectionId).find((item) => item.modelId === modelId)
        return model
          ? {
              legacyProviderId: providerId,
              modelId,
              connectionId,
              modelDefinitionId: model.id,
              capabilities: model.capabilities
            }
          : undefined
      })()
    if (!entry) return
    const operation: ModelOperation | null =
      kind === 'text' ? 'text.generate'
        : kind === 'image' ? 'image.generate'
          : kind === 'image-edit' ? 'image.edit'
          : kind === 'speech' ? 'speech.synthesize'
            : kind === 'voice-design' ? 'voice.design'
              : kind === 'voice-clone' ? 'voice.clone'
                : null
    if (!operation || !entry.capabilities.some((capability) => capability.operation === operation)) return
    const checkedAt = new Date().toISOString()
    await catalogHost.saveValidation({
      connectionId: entry.connectionId,
      modelDefinitionId: entry.modelDefinitionId,
      operation,
      status: 'verified',
      message: `真实端到端验收通过：${detail}`,
      checkedAt,
      verifiedAt: checkedAt
    })
    for (const featureKey of DEFAULT_FEATURE_KEYS[operation] ?? []) {
      catalogHost.saveBinding({
        featureKey,
        connectionId: entry.connectionId,
        modelDefinitionId: entry.modelDefinitionId,
        operation
      })
    }
  }
  await persist()

  if (!targets.length) {
    results.push({
      id: randomUUID(),
      kind: 'configuration',
      status: 'fail',
      provider: { id: '', name: '模型目录', specId: 'system' },
      durationMs: 0,
      detail: '未发现可执行的文本、图片或音频模型。请确认模型已保存、已验证并绑定对应功能键。'
    })
    await persist()
  }

  for (const target of targets) {
    if (!target.provider.hasApiKey) {
      results.push(skippedResult(target, '未保存可用 API Key，未发起真实调用'))
      await persist()
      continue
    }
    const task =
      target.kind === 'text'
        ? runText(target)
        : target.kind === 'image'
          ? runImage(target, projectId)
          : runSpeech(target, projectId)
    let result: Omit<SmokeResult, 'id'>
    try {
      result = await withTimeout(target.kind, task)
    } catch (error) {
      const provider = getProvider(target.provider.id)
      result = {
        kind: target.kind,
        status: 'fail',
        provider: publicProvider(provider ?? target.provider),
        modelId: target.model.id,
        durationMs: SMOKE_TIMEOUT_MS[target.kind],
        detail: provider ? errorDetail(error, provider) : String(error)
      }
    }
    results.push({ id: randomUUID(), ...result })
    if (result.status === 'pass') {
      await recordCatalogPass(result.kind, target.provider.id, target.model.id, result.detail)
    }
    await persist()
    // 只有明确支持参考图编辑的 ToAPIS 图片模型才会进入这一项；不能把纯文生图
    // 的 2xx 当成 image.edit 已通过。
    if (target.kind === 'image' && target.provider.specId === 'toapis') {
      let editResult: Omit<SmokeResult, 'id'>
      try {
        editResult = await withTimeout('image-edit', runImageEdit(target, projectId))
      } catch (error) {
        const provider = getProvider(target.provider.id)
        editResult = {
          kind: 'image-edit', status: 'fail', provider: publicProvider(provider ?? target.provider), modelId: target.model.id,
          durationMs: SMOKE_TIMEOUT_MS['image-edit'], detail: provider ? errorDetail(error, provider) : String(error)
        }
      }
      results.push({ id: randomUUID(), ...editResult })
      if (editResult.status === 'pass') await recordCatalogPass(editResult.kind, target.provider.id, target.model.id, editResult.detail)
      await persist()
    }
    if (target.kind === 'text' && options.includeChatNode) {
      let chatResult: Omit<SmokeResult, 'id'>
      try {
        chatResult = await withTimeout('chat', runChatNodeTransport(target))
      } catch (error) {
        const provider = getProvider(target.provider.id)
        chatResult = { kind: 'chat', status: 'fail', provider: publicProvider(provider ?? target.provider), modelId: target.model.id, durationMs: SMOKE_TIMEOUT_MS.chat, detail: provider ? errorDetail(error, provider) : String(error) }
      }
      results.push({ id: randomUUID(), ...chatResult })
      await persist()
    }
  }

  // 音色设计是 MiniMax 的供应商级能力，做一次即可。没有 MiniMax 时明确记录为跳过。
  const minimax = providers.find((provider) => provider.specId === 'minimax')
  if (options.includeVoiceDesign !== false && minimax?.hasApiKey) {
    const task = runVoiceDesign(minimax, projectId)
    try {
      const result = await withTimeout('voice-design', task)
      results.push({ id: randomUUID(), ...result })
      if (result.status === 'pass') {
        const modelId = minimax.models.find((model) => model.modality === 'audio')?.id
        await recordCatalogPass(result.kind, minimax.id, modelId, result.detail)
      }
    } catch (error) {
      const provider = getProvider(minimax.id)
      results.push({
        id: randomUUID(),
        kind: 'voice-design',
        status: 'fail',
        provider: publicProvider(provider ?? minimax),
        durationMs: SMOKE_TIMEOUT_MS['voice-design'],
        detail: provider ? errorDetail(error, provider) : String(error)
      })
    }
  } else if (options.includeVoiceDesign !== false && minimax) {
    results.push({
      id: randomUUID(),
      kind: 'voice-design',
      status: 'skipped',
      provider: publicProvider(minimax),
      durationMs: 0,
      detail: 'MiniMax 未保存可用 API Key，未发起真实调用'
    })
  }
  const minimaxAudioModel = minimax?.models.find((model) => model.modality === 'audio')
  if (options.includeVoiceClone !== false && minimax?.hasApiKey && minimaxAudioModel) {
    const task = runVoiceClone(minimax, minimaxAudioModel.id, projectId)
    try {
      const result = await withTimeout('voice-clone', task)
      results.push({ id: randomUUID(), ...result })
      if (result.status === 'pass') {
        await recordCatalogPass(result.kind, minimax.id, minimaxAudioModel.id, result.detail)
      }
    } catch (error) {
      const provider = getProvider(minimax.id)
      results.push({
        id: randomUUID(),
        kind: 'voice-clone',
        status: 'fail',
        provider: publicProvider(provider ?? minimax),
        modelId: minimaxAudioModel.id,
        durationMs: SMOKE_TIMEOUT_MS['voice-clone'],
        detail: provider ? errorDetail(error, provider) : String(error)
      })
    }
  } else if (options.includeVoiceClone !== false) {
    results.push({
      id: randomUUID(),
      kind: 'voice-clone',
      status: 'skipped',
      provider: minimax ? publicProvider(minimax) : { id: '', name: 'MiniMax', specId: 'minimax' },
      durationMs: 0,
      detail: '未找到保存了可用 API Key 与音频模型的 MiniMax 供应商，未发起克隆调用'
    })
  }
  await persist()
  return { report, reportPath }
}
