// 即梦（Dreamina）本机 CLI 通道 —— 进程与落盘层。
//
// 纯协议（子命令组装、stdout 归一化）在 @shared/dreamina-cli，这一层只负责：
//   - 找到并调用本机二进制；
//   - 登录态 / 版本 / 余额探测；
//   - 把项目相对媒体路径还原成本地绝对路径；
//   - 单机串行队列。
//
// 与 HTTP 供应商的根本差别决定了这些约束：
//   1. 凭据是本机 OAuth 登录态（~/.dreamina_cli），没有 Base URL / API Key；
//   2. stdout 的 JSON 是唯一协议（无版本契约），必须严格解析；
//   3. 提交即扣会员额度且没有幂等键——提交阶段绝不能重试（见 video.ts W1 特例）；
//   4. 产物是带 x-expires 签名的 CDN URL，必须立刻下载落盘，不能存进运行记录。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildImageArgs,
  buildVideoArgs,
  classifyDreaminaTask,
  DreaminaCliError,
  type DreaminaImageArgs,
  type DreaminaTaskState
} from '../../shared/dreamina-cli'
import type { VideoSubmitInput } from '../../shared/contracts'
import { getDb } from '../store/db'
import { getMediaAbsPath } from '../store/media.repo'
import { GatewayError } from './factory'

const VERSION_TIMEOUT_MS = 20_000
const RUN_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 15 * 60_000

/** 安装提示只在这里写一次，避免各处错误文案漂移。 */
const INSTALL_HINT =
  '未找到即梦 CLI。请先安装：curl -s https://jimeng.jianying.com/cli | bash（Windows 需在 Git Bash 中执行），' +
  '或设置环境变量 CANVAS_STUDIO_DREAMINA_PATH 指向 dreamina 可执行文件。'

const LOGIN_HINT =
  '即梦尚未登录：请先执行 dreamina login 完成 OAuth 授权，再回到画布重试。'

interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

/**
 * 二进制探测顺序：环境变量 → PATH → 安装脚本的默认落点。
 * 不打包二进制（31MB 闭源 beta、会自更新），与 FFmpeg 保持同一套约定。
 */
function binaryCandidates(): string[] {
  const candidates: string[] = []
  const override = process.env.CANVAS_STUDIO_DREAMINA_PATH?.trim()
  if (override) candidates.push(override)
  const exe = process.platform === 'win32' ? 'dreamina.exe' : 'dreamina'
  candidates.push('dreamina')
  const home = process.env.USERPROFILE?.trim() || process.env.HOME?.trim()
  if (home) {
    candidates.push(join(home, 'bin', exe))
    candidates.push(join(home, '.local', 'bin', exe))
  }
  return [...new Set(candidates)]
}

let cachedBinary: string | undefined
let cachedVersion: string | undefined

function spawnDreamina(
  binary: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = RUN_TIMEOUT_MS
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(
        new GatewayError(
          'DREAMINA_CLI_FAILED',
          error instanceof Error ? error.message : String(error)
        )
      )
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, result?: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result as RunResult)
    }
    const onAbort = (): void => {
      child.kill()
      finish(new GatewayError('CANCELLED', '已取消'))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(
        new GatewayError('DREAMINA_TIMEOUT', `即梦 CLI 调用超过 ${Math.round(timeoutMs / 1000)} 秒`)
      )
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        new GatewayError(
          error.code === 'ENOENT' ? 'DREAMINA_CLI_MISSING' : 'DREAMINA_CLI_FAILED',
          error.code === 'ENOENT' ? INSTALL_HINT : error.message
        )
      )
    })
    child.on('close', (code) => finish(null, { stdout, stderr, code }))
  })
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  const text = stdout.trim()
  if (!text) return {}
  const parse = (candidate: string): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(candidate) as unknown
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  const direct = parse(text)
  if (direct) return direct
  // CLI 偶尔会在 JSON 之外打印一句提示；只截取最外层对象，不做宽松猜测。
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const nested = parse(text.slice(start, end + 1))
    if (nested) return nested
  }
  throw new GatewayError('DREAMINA_BAD_OUTPUT', `即梦 CLI 返回无法解析：${text.slice(0, 200)}`)
}

function failureFrom(result: RunResult): GatewayError {
  const text = `${result.stderr}\n${result.stdout}`.trim()
  if (text.includes('AigcComplianceConfirmationRequired'))
    return new GatewayError(
      'DREAMINA_COMPLIANCE_REQUIRED',
      '该模型首次使用需要在即梦 Web 端先用它生成一次，然后回到画布重试'
    )
  if (text.includes('未检测到有效登录态') || /please\s+log\s*in|not\s+logged/i.test(text))
    return new GatewayError('DREAMINA_AUTH_REQUIRED', LOGIN_HINT)
  return new GatewayError(
    'DREAMINA_CLI_FAILED',
    `即梦 CLI 执行失败（exit ${result.code ?? '?'}）：${text.slice(-300) || '无输出'}`
  )
}

async function resolveBinary(): Promise<string> {
  if (cachedBinary) return cachedBinary
  let lastError: unknown
  for (const candidate of binaryCandidates()) {
    try {
      const result = await spawnDreamina(candidate, ['--version'], undefined, VERSION_TIMEOUT_MS)
      if (result.code === 0) {
        cachedBinary = candidate
        return candidate
      }
    } catch (error) {
      lastError = error
    }
  }
  if (lastError instanceof GatewayError && lastError.code !== 'DREAMINA_CLI_MISSING')
    throw lastError
  throw new GatewayError('DREAMINA_CLI_MISSING', INSTALL_HINT)
}

async function runJson(
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<Record<string, unknown>> {
  const binary = await resolveBinary()
  const result = await spawnDreamina(binary, args, options.signal, options.timeoutMs)
  if (result.code !== 0) throw failureFrom(result)
  return parseJsonOutput(result.stdout)
}

/** 纯协议层抛的是 DreaminaCliError；在 main 边界统一收敛成网关错误码。 */
function toGatewayError(error: unknown): never {
  if (error instanceof DreaminaCliError) throw new GatewayError(error.code, error.message)
  throw error
}

/**
 * 刚提交后的一小段时间里，CLI 的 query_result 会返回 `get_history_by_ids failed: ret=1015`，
 * 稍后同一 submit_id 又能正常查出——这是记录尚未可查的瞬时错误，不能当成任务失败。
 */
export function isTransientQueryError(error: unknown): boolean {
  if (!(error instanceof GatewayError)) return false
  if (error.code === 'CANCELLED' || error.code === 'DREAMINA_AUTH_REQUIRED') return false
  return /ret=1015|get_history_by_ids failed|ECONNRESET|ETIMEDOUT|timeout|EOF|502|503|504/i.test(
    `${error.code} ${error.message}`
  )
}

export interface DreaminaProbe {
  binary: string
  version: string
  loggedIn: boolean
  userId?: number
  vipLevel?: string
  credit?: number
  message: string
}

/**
 * 只读探测：版本 + 登录态 + 余额。不发起任何生成，不消耗额度。
 * 设置面板的"检测"按钮与运行前校验共用这一份实现。
 */
export async function probeDreamina(): Promise<DreaminaProbe> {
  const binary = await resolveBinary()
  const versionInfo = await runJson(['--version'], { timeoutMs: VERSION_TIMEOUT_MS })
  const version = typeof versionInfo.version === 'string' ? versionInfo.version : 'unknown'
  cachedVersion = version
  let loggedIn = false
  let userId: number | undefined
  let vipLevel: string | undefined
  let credit: number | undefined
  try {
    const creditInfo = await runJson(['user_credit'], { timeoutMs: VERSION_TIMEOUT_MS })
    loggedIn = true
    if (typeof creditInfo.user_id === 'number') userId = creditInfo.user_id
    if (typeof creditInfo.vip_level === 'string') vipLevel = creditInfo.vip_level
    if (typeof creditInfo.total_credit === 'number') credit = creditInfo.total_credit
  } catch (error) {
    if (!(error instanceof GatewayError) || error.code !== 'DREAMINA_AUTH_REQUIRED') throw error
  }
  const message = loggedIn
    ? `即梦 CLI ${version} · 已登录${vipLevel ? `（${vipLevel}）` : ''}${credit !== undefined ? `，额度 ${credit}` : ''}`
    : `即梦 CLI ${version} · 未登录，请先执行 dreamina login 完成授权`
  return { binary, version, loggedIn, userId, vipLevel, credit, message }
}

/**
 * 本机媒体相对路径 → CLI 可用的绝对路径。
 * 媒体库只登记项目相对路径，CLI 只收本地路径，转换点必须唯一。
 */
export function dreaminaMediaPath(mediaId: string | undefined, label: string): string {
  if (!mediaId) throw new GatewayError('INVALID_INPUT', `${label}缺失`)
  const row = getDb().prepare('SELECT path FROM media WHERE id = ?').get(mediaId) as
    | { path: string }
    | undefined
  if (!row?.path) throw new GatewayError('MEDIA_NOT_FOUND', `${label}媒体不存在：${mediaId}`)
  const absolute = getMediaAbsPath(row.path)
  if (!absolute || !existsSync(absolute))
    throw new GatewayError('MEDIA_NOT_FOUND', `${label}的本地文件不存在：${row.path}`)
  return absolute
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function queryTask(submitId: string): Promise<Record<string, unknown>> {
  return runJson([`query_result`, `--submit_id=${submitId}`], { timeoutMs: RUN_TIMEOUT_MS })
}

async function waitForMediaUrl(submitId: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  // 刚提交的一瞬间记录可能还没进可查范围，先让一跳再开始轮询。
  await sleep(POLL_INTERVAL_MS)
  for (;;) {
    let data: Record<string, unknown>
    try {
      data = await queryTask(submitId)
    } catch (error) {
      if (!isTransientQueryError(error)) throw error
      if (Date.now() > deadline) throw error
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    const state = classifyDreaminaTask(data)
    if (state.status === 'succeeded' && state.url) return state.url
    if (state.status === 'failed')
      throw new GatewayError('DREAMINA_TASK_FAILED', state.error ?? '即梦生成失败')
    if (state.status === 'cancelled') throw new GatewayError('CANCELLED', '已取消')
    if (Date.now() > deadline)
      throw new GatewayError(
        'DREAMINA_TIMEOUT',
        `即梦任务等待超时（submit_id: ${submitId}），可稍后用该 ID 复查，不要重复提交以免重复计费`
      )
    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * CLI 是单机单登录态的进程：画布多选运行与循环并发都会打到这里，
 * 用一个串行队列兜住，避免两个子进程同时操作同一份登录态。
 */
let slot: Promise<unknown> = Promise.resolve()
export function withDreaminaSlot<T>(task: () => Promise<T>): Promise<T> {
  const result = slot.then(task, task)
  slot = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/**
 * 文生图 / 图生图。返回远端图片地址，由调用方立刻下载落盘（URL 带签名会过期）。
 */
export async function generateImageWithDreamina(req: DreaminaImageArgs): Promise<string> {
  return withDreaminaSlot(async () => {
    let args: string[]
    try {
      args = buildImageArgs(req)
    } catch (error) {
      toGatewayError(error)
    }
    const submitted = await runJson(args)
    const submitId = typeof submitted.submit_id === 'string' ? submitted.submit_id : ''
    if (!submitId) throw new GatewayError('DREAMINA_BAD_OUTPUT', '即梦生图未返回 submit_id')
    const immediate = classifyDreaminaTask(submitted)
    if (immediate.status === 'succeeded' && immediate.url) return immediate.url
    if (immediate.status === 'failed')
      throw new GatewayError('DREAMINA_TASK_FAILED', immediate.error ?? '即梦生图失败')
    return waitForMediaUrl(submitId)
  })
}

/**
 * 视频提交：解析本地媒体路径后交给纯函数组装命令。
 * 不重试——CLI 没有幂等键，超时后重发等于同一支视频扣两次额度。
 */
export async function submitVideoWithDreamina(input: VideoSubmitInput): Promise<string> {
  return withDreaminaSlot(async () => {
    const mode = input.mode ?? 'text'
    const params = input.params ?? {}
    if (!params.resolution)
      throw new GatewayError('INVALID_INPUT', '即梦视频必须指定清晰度（video_resolution）')
    if (mode !== 'text' && mode !== 'first-frame' && mode !== 'first-last-frame' && mode !== 'reference')
      throw new GatewayError('INVALID_INPUT', '即梦不支持该视频生成模式')
    let args: string[]
    try {
      args = buildVideoArgs({
        modelId: input.modelId,
        mode,
        prompt: input.prompt.trim(),
        resolution: params.resolution,
        ...(params.ratio ? { ratio: params.ratio } : {}),
        ...(typeof params.duration === 'number' ? { duration: params.duration } : {}),
        ...(input.firstFrameMediaId
          ? { firstFramePath: dreaminaMediaPath(input.firstFrameMediaId, '首帧') }
          : {}),
        ...(input.lastFrameMediaId
          ? { lastFramePath: dreaminaMediaPath(input.lastFrameMediaId, '尾帧') }
          : {}),
        ...(input.referenceImageMediaIds?.length
          ? {
              referenceImagePaths: input.referenceImageMediaIds.map((id) =>
                dreaminaMediaPath(id, '参考图')
              )
            }
          : {}),
        ...(input.referenceVideoMediaIds?.length
          ? {
              referenceVideoPaths: input.referenceVideoMediaIds.map((id) =>
                dreaminaMediaPath(id, '参考视频')
              )
            }
          : {}),
        ...(input.referenceAudioMediaIds?.length
          ? {
              referenceAudioPaths: input.referenceAudioMediaIds.map((id) =>
                dreaminaMediaPath(id, '参考音频')
              )
            }
          : {})
      })
    } catch (error) {
      toGatewayError(error)
    }
    const submitted = await runJson(args)
    const submitId = typeof submitted.submit_id === 'string' ? submitted.submit_id : ''
    if (!submitId) throw new GatewayError('DREAMINA_BAD_OUTPUT', '即梦视频提交未返回 submit_id')
    return submitId
  })
}

/** 轮询即梦远端任务，归一化为既有 UpstreamState，复用 video.ts 的下载与恢复链路。 */
export async function pollVideoWithDreamina(upstreamId: string): Promise<DreaminaTaskState> {
  return withDreaminaSlot(async () => {
    try {
      const data = await queryTask(upstreamId)
      return classifyDreaminaTask(data)
    } catch (error) {
      // 远端还在排队或刚提交时记录可能暂不可查：按"仍在运行"交给外层继续轮询，
      // 而不是把排队中的任务误判为失败（视频排队可能长达数十分钟）。
      if (isTransientQueryError(error)) return { status: 'running' }
      throw error
    }
  })
}

/** 供诊断/设置面板展示当前 CLI 版本；未探测过时为 undefined。 */
export function currentDreaminaVersion(): string | undefined {
  return cachedVersion
}
