// 供应商协议自检：把「视频/原生语音供应商能不能跑通」从只能靠付费生成来验证，
// 变成两层明确的动作。
//
// 背景：testProvider 对 openai-compatible 驱动会 GET /models，但 MiniMax / Seedance /
// 火山 1.0 语音没有 /models，此前直接回一句「配置已保存（首次生成时验证）」——也就是设置
// 面板对这几家完全不校验，用户唯一能验证的方式就是真的点一次计费的生成。
//
//   免费层：用真实请求构造器（video.ts / audio.ts / voice.ts 里那批纯函数）拼出即将
//           发送的 method + URL + 请求体（密钥掩码），并列出仍然缺失的必填项；再对
//           有只读查询端点的协议做一次零计费的 GET 探测（查一个不存在的任务号），
//           用来区分「密钥被拒绝」与「端点可达」。
//   计费层：面板逐条点「真实调用一次」并回填 allowCost 才提交。视频时长取能力表里
//           该模型允许的最短时长，文本取一句自检用语，绝不在这里写死秒数。
import { randomUUID } from 'node:crypto'
import type {
  ProbeProviderInput,
  ProbeProviderResult,
  ProviderProbeItem,
  ProviderProbeOutcome,
  SaveProviderInput
} from '../../shared/contracts'
import type { GatewayModelInfo, ProviderConfig } from '../../shared/types'
import {
  DEFAULT_SPEECH_CONFIG,
  MINIMAX_ASYNC_SPEECH_MODELS,
  type SpeechConfig
} from '../../shared/speech'
import {
  canonicalVideoModelId,
  normalizeVideoGenParams,
  videoCapabilitiesFor
} from '../../shared/video-capabilities'
import { describeUpstreamHttpError, extractUpstreamMessage } from '../../shared/upstream-error'
import { GatewayError } from './factory'
import { getProvider } from './providers.repo'
import { buildMiniMaxAsyncTtsBody, buildVolcSpeechBody } from './audio'
import {
  buildMiniMaxH3RequestBody,
  buildSeedanceRequestBody,
  minimaxApiUrl,
  seedanceTasksUrl
} from './video'
import { buildVoiceDesignBody } from './voice'

/** 只读查询探测用的假任务号：查不到才是预期结果，且一定不产生费用。 */
export const PROBE_UPSTREAM_TASK_ID = 'canvas-studio-connection-probe'
/**
 * MiniMax 的 t2a 查询只接受数字 task_id：非数字会被参数校验直接挡在「查任务」之前
 * （实测回执 `invalid params`），探测就退化成「参数写错了」而不是「密钥可用但任务不存在」。
 * 取一个必然不存在的数字号段，真实密钥下返回 `invalid params, task not found`。
 */
const PROBE_MINIMAX_TTS_TASK_ID = '999999999999'
const PROBE_PROMPT = '连通性自检：一列蓝色火车缓缓驶入雨夜中的车站'
const PROBE_TEXT = '这是一次连通性自检。'
const PROBE_VOICE_PROMPT = '沉稳的中年男声，语速平缓'
const PROBE_TIMEOUT_MS = 30_000

export interface ProbeSpec {
  item: ProviderProbeItem
  /** 计费执行时复用同一个请求体，避免「预览的」和「发出去的」是两份数据。 */
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

const BASE_SPEECH_CONFIG: SpeechConfig = {
  ...DEFAULT_SPEECH_CONFIG,
  providerId: '',
  modelId: ''
}

function pickModel(
  models: GatewayModelInfo[],
  modality: GatewayModelInfo['modality'],
  pattern: RegExp
): string {
  // 模态是用户在面板里声明的事实，优先级高于按名字猜；名字正则只是兜底。
  return (
    models.find((m) => m.modality === modality)?.id.trim() ??
    models.find((m) => pattern.test(m.id))?.id.trim() ??
    ''
  )
}

/** 请求体里的密钥一律掩码；预览要给用户看的是字段结构，不是凭证。 */
function maskSecret(text: string, apiKey: string): string {
  const key = apiKey.trim()
  if (key.length < 6) return text
  return text.split(key).join('***已掩码***')
}

function probeItem(item: ProviderProbeItem): ProviderProbeItem {
  return { ...item, missing: [...item.missing] }
}

/** 只读探测项没有请求体，但仍是同一个 ProbeSpec 形态，避免调用方分支处理。 */
function itemSpec(item: ProviderProbeItem): ProbeSpec {
  return { item: probeItem(item) }
}

/** 该模型 ID 是否命中视频能力表；未命中要明说，否则用户以为在跑 MiniMax H3。 */
function videoModelIssues(specId: ProviderConfig['specId'], modelId: string): string[] {
  if (!modelId) return ['未配置视频模型 ID，无法构造请求']
  const canonical = canonicalVideoModelId(modelId)
  const known =
    specId === 'minimax'
      ? canonical === 'minimax-h3' || canonical === 'minimax-h3-max'
      : /seedance-2-(0|5)|seedance-2\.(0|5)/.test(canonical)
  return known ? [] : [`模型 ID「${modelId}」未命中能力表，自检会按最保守的默认参数发送`]
}

async function probeVideoBody(
  p: ProviderConfig,
  modelId: string
): Promise<Record<string, unknown>> {
  // 不连接任何参考素材：resolveMedia 因此永远不会被调用，也就不会碰媒体库。
  const input = {
    projectId: '',
    nodeId: '',
    providerId: p.id,
    modelId,
    prompt: PROBE_PROMPT,
    mode: 'text' as const,
    params: normalizeVideoGenParams(videoCapabilitiesFor(p.specId, modelId))
  }
  const resolve = async (): Promise<string | undefined> => undefined
  return p.specId === 'minimax'
    ? buildMiniMaxH3RequestBody(input, resolve)
    : buildSeedanceRequestBody(p, input, resolve)
}

/** 按 specId 列出该供应商协议会发出的全部请求。纯构造，不发网络。 */
export async function buildProbeSpecs(p: ProviderConfig): Promise<ProbeSpec[]> {
  const base = p.baseURL.replace(/\/+$/, '')
  const specs: ProbeSpec[] = []

  if (p.specId === 'minimax' || p.specId === 'seedance') {
    const modelId = pickModel(p.models, 'video', /h3|seedance|video/i)
    const body = await probeVideoBody(p, modelId)
    const submitUrl =
      p.specId === 'minimax' ? minimaxApiUrl(p, '/v2/video_generation') : seedanceTasksUrl(p)
    specs.push({
      item: probeItem({
        id: 'video-submit',
        label: `提交视频任务（${modelId || '未选模型'}）`,
        method: 'POST',
        url: submitUrl,
        body: maskSecret(JSON.stringify(body, null, 2), p.apiKey),
        missing: videoModelIssues(p.specId, modelId),
        cost: 'paid'
      }),
      body,
      headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' }
    })
    specs.push(
      itemSpec({
        id: 'video-query',
        label: '查询视频任务（只读，零计费）',
        method: 'GET',
        url:
          p.specId === 'minimax'
            ? minimaxApiUrl(p, `/v2/query/video_generation/${PROBE_UPSTREAM_TASK_ID}`)
            : seedanceTasksUrl(p, PROBE_UPSTREAM_TASK_ID),
        missing: [],
        cost: 'free'
      })
    )
  }

  if (p.specId === 'minimax') {
    const configuredTtsModel = p.models.find(
      (model) =>
        model.modality === 'audio' && MINIMAX_ASYNC_SPEECH_MODELS.includes(model.id.trim())
    )?.id.trim()
    const ttsModel = configuredTtsModel || DEFAULT_SPEECH_CONFIG.modelId
    const config: SpeechConfig = { ...BASE_SPEECH_CONFIG, backend: 'minimax', modelId: ttsModel }
    const ttsBody = buildMiniMaxAsyncTtsBody(
      { modelId: ttsModel, text: PROBE_TEXT, voiceId: '' },
      config
    )
    specs.push({
      item: probeItem({
        id: 'minimax-tts',
        label: `异步语音合成（${configuredTtsModel || '未选模型'}）`,
        method: 'POST',
        url: `${base}/v1/t2a_async_v2`,
        body: maskSecret(JSON.stringify(ttsBody, null, 2), p.apiKey),
        missing: configuredTtsModel ? [] : ['未配置 MiniMax 异步语音合成模型'],
        cost: 'paid'
      }),
      body: ttsBody,
      headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' }
    })
    specs.push(
      itemSpec({
        id: 'minimax-tts-query',
        label: '查询语音任务（只读，零计费）',
        method: 'GET',
        url: `${base}/v1/query/t2a_async_query_v2?task_id=${PROBE_MINIMAX_TTS_TASK_ID}`,
        missing: [],
        cost: 'free'
      })
    )
    const designBody = buildVoiceDesignBody(
      PROBE_VOICE_PROMPT,
      PROBE_TEXT,
      `canvas-probe-${randomUUID().slice(0, 8)}`,
      false
    )
    specs.push({
      item: probeItem({
        id: 'minimax-voice-design',
        label: '音色设计（会登记一个 voice_id）',
        method: 'POST',
        url: `${base}/v1/voice_design`,
        body: maskSecret(JSON.stringify(designBody, null, 2), p.apiKey),
        missing: [],
        cost: 'paid'
      }),
      body: designBody,
      headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' }
    })
    specs.push(
      itemSpec({
        id: 'minimax-voice-clone',
        label: '语音克隆',
        method: 'POST',
        url: `${base}/v1/voice_clone`,
        missing: ['需要先在「语音克隆」节点上传参考音频拿到 file_id，供应商面板不代为上传素材'],
        cost: 'paid'
      })
    )
  }

  if (p.specId === 'volc-speech') {
    const seedAudio = 'seed-audio-1.0'
    const modelConfigured = p.models.some(
      (model) => model.modality === 'audio' && model.id === seedAudio
    )
    const volcConfig: SpeechConfig = {
      ...BASE_SPEECH_CONFIG,
      backend: 'volc',
      modelId: seedAudio
    }
    const volcBody = buildVolcSpeechBody(
      { modelId: seedAudio, text: PROBE_TEXT, voiceId: '' },
      volcConfig
    )
    specs.push({
      item: probeItem({
        id: 'volc-tts',
        label: `火山语音合成 1.0（${seedAudio || '未选模型'}）`,
        method: 'POST',
        url: `${base}/api/v3/tts/create`,
        body: maskSecret(JSON.stringify(volcBody, null, 2), p.apiKey),
        missing: modelConfigured ? [] : ['未配置语音模型 ID（seed-audio-1.0）'],
        cost: 'paid'
      }),
      body: volcBody,
      // 火山语音合成 1.0 使用 X-Api-Key。
      headers: { 'X-Api-Key': p.apiKey, 'Content-Type': 'application/json' }
    })
  }

  return specs
}

function authFlavored(text: string): boolean {
  // 「login fail」「API secret key」是 MiniMax 在 HTTP 200 的 base_resp 里说密钥不可用的原话
  // （实测假密钥回执 status_code 1004），漏掉它们会把坏密钥报成「无法判定」。
  return /(api[ _-]?key|secret key|login fail|invalid key|token|鉴权|认证|unauthoriz|forbidden|permission|密钥|签名)/i.test(
    text
  )
}

/**
 * 上游回执说「这个任务查不到」= 请求已经通过鉴权、进到业务层才查不到记录。
 *
 * MiniMax 对不存在的任务号不给 404：视频查询是 HTTP 500 + `record not found (1000)`，
 * 语音查询是 HTTP 200 + `2013 invalid params, task not found`。按状态码判会落到
 * 「上游服务异常 / 无法判定」，用户据此会去怀疑自己刚填对的密钥。
 * 只匹配这两句原话，`404 page not found`（Base URL 填错）不在其中。
 */
function taskLookupAccepted(message: string): boolean {
  return /(record|task) not found/i.test(message)
}

function taskNotFoundOutcome(httpStatus: number, message: string): ProviderProbeOutcome {
  return {
    status: 'pass',
    httpStatus,
    detail: `端点可达且密钥被接受：上游按预期查不到探测任务（${message}）`
  }
}

/** 上游回执的判定刻意保守：只有明确不是鉴权问题才说「可达且密钥被接受」。 */
function classifyProbe(status: number, payloadText: string): ProviderProbeOutcome {
  if (status === 401 || status === 403) {
    return {
      status: 'fail',
      httpStatus: status,
      detail: '密钥或模型权限被上游拒绝'
    }
  }
  if (status === 404) {
    return {
      status: 'unknown',
      httpStatus: status,
      detail: '查询端点不存在，无法据此判断密钥；请核对 Base URL'
    }
  }
  if (status === 429) {
    return { status: 'unknown', httpStatus: status, detail: '上游限流，本次无法判定连通性' }
  }
  if (status >= 500) {
    return { status: 'unknown', httpStatus: status, detail: '上游服务异常' }
  }
  const message = extractUpstreamMessage(safeJson(payloadText))
  if (message && authFlavored(message)) {
    return { status: 'fail', httpStatus: status, detail: `密钥被拒绝：${message}` }
  }
  if (status >= 400) {
    return {
      status: 'unknown',
      httpStatus: status,
      detail: `上游回执（HTTP ${status}）：${message || '无原因字段'}`
    }
  }
  return {
    status: 'pass',
    httpStatus: status,
    detail: `端点可达且密钥被接受${message ? `（上游回执：${message}）` : ''}`
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function requestProbe(
  url: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>
): Promise<{ outcome: ProviderProbeOutcome; payload?: Record<string, unknown> }> {
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      const message = extractUpstreamMessage(safeJson(text))
      // 鉴权状态优先：401/403 一律算密钥被拒，只有非鉴权失败才允许按「查不到任务」判通过。
      if (res.status !== 401 && res.status !== 403 && taskLookupAccepted(message)) {
        return { outcome: taskNotFoundOutcome(res.status, message) }
      }
      const error = describeUpstreamHttpError(res.status, text, '上游回执')
      return {
        outcome: {
          status: res.status === 401 || res.status === 403 ? 'fail' : 'unknown',
          httpStatus: res.status,
          detail: error.message
        }
      }
    }
    const payload = (safeJson(text) ?? {}) as Record<string, unknown>
    const envelope = payload as {
      base_resp?: { status_code?: number; status_msg?: string }
      code?: number
      message?: string
    }
    const innerCode = envelope.base_resp?.status_code ?? envelope.code
    if (typeof innerCode === 'number' && innerCode !== 0 && innerCode !== 3000) {
      const msg = envelope.base_resp?.status_msg ?? envelope.message ?? `错误码 ${innerCode}`
      if (!authFlavored(msg) && taskLookupAccepted(msg)) {
        return { outcome: taskNotFoundOutcome(res.status, msg), payload }
      }
      return {
        outcome: {
          status: authFlavored(msg) ? 'fail' : 'unknown',
          httpStatus: res.status,
          detail: `上游业务码 ${innerCode}：${msg}`
        },
        payload
      }
    }
    return { outcome: classifyProbe(res.status, text), payload }
  } catch (e) {
    return {
      outcome: {
        status: 'unknown',
        detail: `请求未发出或未收到回执：${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
}

/** 计费项的真实调用：只在用户逐条确认后进入，回执原样投影给用户。 */
async function runPaidProbe(
  p: ProviderConfig,
  spec: ProbeSpec,
  url: string
): Promise<ProviderProbeOutcome> {
  const { outcome, payload } = await requestProbe(
    url,
    spec.headers ?? { Authorization: `Bearer ${p.apiKey}` },
    spec.body
  )
  if (outcome.status !== 'pass') return outcome
  const taskLike = payload?.task_id ?? payload?.id ?? payload?.file_id ?? payload?.voice_id
  const audioLike = payload?.data ?? payload?.audio
  const detail =
    typeof taskLike === 'string' || typeof taskLike === 'number'
      ? `${outcome.detail}；上游受理号 ${taskLike}。注意：这次提交已在服务商侧真实创建任务并计费，产物不在本项目里，成片请在视频节点生成。`
      : typeof audioLike === 'string'
        ? `${outcome.detail}；返回音频 ${Math.round(audioLike.length * 0.75)} 字节（自检不落盘）`
        : outcome.detail
  return { ...outcome, detail }
}

export async function probeProvider(input: ProbeProviderInput): Promise<ProbeProviderResult> {
  const p = draftToConfig(input)
  const specs = await buildProbeSpecs(p)
  const items: ProviderProbeItem[] = []

  for (const spec of specs) {
    const item = { ...spec.item }
    if (item.cost === 'free') {
      item.probe = (await requestProbe(item.url, { Authorization: authHeaderFor(p) })).outcome
    }
    if (input.runItemId === item.id && item.cost === 'paid') {
      if (input.allowCost !== true) {
        throw new GatewayError(
          'COST_CONFIRM_REQUIRED',
          `「${item.label}」会产生真实费用，必须显式确认后才能调用`
        )
      }
      if (item.missing.length) {
        throw new GatewayError('INVALID_INPUT', `还不能真实调用：${item.missing[0]}`)
      }
      item.probe = await runPaidProbe(p, spec, item.url)
    }
    items.push(item)
  }

  const free = items.filter((item) => item.cost === 'free')
  const failed = items.filter((item) => item.probe?.status === 'fail')
  const passed = items.filter((item) => item.probe?.status === 'pass')
  const paidReady = items.filter((item) => item.cost === 'paid' && !item.missing.length)
  const summary = failed.length
    ? `自检失败：${failed.map((item) => `${item.label}——${item.probe?.detail}`).join('；')}`
    : free.length && passed.length === free.length
      ? `免费自检通过（${free.length} 项只读探测）。另有 ${paidReady.length} 项可按需真实调用，点击后会向服务商真实提交并计费。`
      : `请求构造完成，但只读探测未能全部判定；请核对 Base URL 与密钥。可真实调用项 ${paidReady.length} 个。`
  return { items, summary }
}

/** 供 testProvider 复用的一句话结论：不新增按钮也能知道密钥是否被接受。 */
export async function freeConnectionMessage(p: ProviderConfig): Promise<string> {
  const specs = await buildProbeSpecs(p)
  const free = specs.filter((spec) => spec.item.cost === 'free')
  if (!free.length) {
    return '该协议没有只读端点可探测；请求构造已就绪，请在节点里首次生成验证'
  }
  const results = await Promise.all(
    free.map((spec) => requestProbe(spec.item.url, { Authorization: authHeaderFor(p) }))
  )
  const first = results.find((r) => r.outcome.status !== 'unknown') ?? results[0]
  const paidCount = specs.filter((spec) => spec.item.cost === 'paid').length
  return `${first.outcome.detail}。${paidCount} 项能力可在「协议自检」里逐条真实调用（会计费）`
}

function authHeaderFor(p: ProviderConfig): string {
  return `Bearer ${p.apiKey}`
}

/** 面板里未保存的草稿也要能自检，因此密钥解析规则与 testProvider 完全一致。 */
export function draftToConfig(input: SaveProviderInput): ProviderConfig {
  const baseURL = input.baseURL.trim().replace(/\/+$/, '')
  if (!baseURL) throw new GatewayError('PROVIDER_NO_URL', 'Base URL 不能为空')
  const apiKey = input.apiKey?.trim() || (input.id ? (getProvider(input.id)?.apiKey ?? '') : '')
  if (!apiKey) throw new GatewayError('PROVIDER_NO_KEY', 'API Key 不能为空')
  return {
    id: input.id ?? 'draft',
    name: input.name,
    specId: input.specId,
    baseURL,
    apiKey,
    models: input.models,
    createdAt: 0
  }
}
