import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { buildViduVideoArgs, classifyViduTask, parseViduOutput, ViduCliError } from '../../shared/vidu-cli'
import type { ProviderConfig } from '../../shared/types'
import type { VideoSubmitInput } from '../../shared/contracts'
import { getDb } from '../store/db'
import { getMediaAbsPath } from '../store/media.repo'
import { GatewayError } from './factory'

type ViduCredentials = Pick<ProviderConfig, 'baseURL' | 'apiKey'>

export function validateViduBaseURL(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  if (!['https://service.vidu.cn', 'https://service.vidu.com'].includes(normalized))
    throw new ViduCliError('INVALID_INPUT', 'Vidu 地址必须为 https://service.vidu.cn 或 https://service.vidu.com')
  return normalized
}

/** Launch the native binary directly: never shell/.cmd, and never put the token in argv. */
export function viduBinaryCandidates(): string[] {
  const exe = process.platform === 'win32' ? 'vidu-cli.exe' : 'vidu-cli'
  const roots = [process.env.APPDATA && join(process.env.APPDATA, 'npm'), ...((process.env.PATH || '').split(delimiter))].filter(Boolean) as string[]
  const candidates = [process.env.CANVAS_STUDIO_VIDU_PATH, ...roots.flatMap((root) => [join(root, exe), join(root, 'node_modules', 'vidu-cli', 'bin', exe), join(dirname(root), 'lib', 'node_modules', 'vidu-cli', 'bin', exe)]), exe]
  return [...new Set(candidates.filter((path): path is string => Boolean(path?.trim()))) ]
}

let binary: string | undefined
async function resolveViduBinary(): Promise<string> {
  if (binary) return binary
  const selected = viduBinaryCandidates().find((candidate) => existsSync(candidate)) || 'vidu-cli'
  await new Promise<void>((resolve, reject) => {
    const child = spawn(selected, ['--version'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new ViduCliError('TIMEOUT', 'Vidu CLI 版本检查超时')) }, 20_000)
    child.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(0, 200) })
    child.stderr.on('data', () => {})
    child.on('error', () => { clearTimeout(timer); reject(new ViduCliError('VIDU_CLI_MISSING', '请先安装 npm install -g vidu-cli@0.2.33，或设置 CANVAS_STUDIO_VIDU_PATH 指向原生可执行文件')) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const version = /vidu-cli\s+v?(\d+)\.(\d+)\.(\d+)/.exec(output)
      if (code !== 0 || !version || !(Number(version[1]) > 0 || Number(version[2]) > 2 || (Number(version[2]) === 2 && Number(version[3]) >= 33))) {
        reject(new ViduCliError('VIDU_CLI_VERSION', 'Vidu Q4 需要 CLI v0.2.33 或更新版本，请升级后重试'))
      } else resolve()
    })
  })
  binary = selected
  return selected
}

export async function runViduJson(
  credentials: ViduCredentials,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 120_000
): Promise<Record<string, unknown>> {
  const baseURL = validateViduBaseURL(credentials.baseURL)
  if (!credentials.apiKey.trim()) throw new ViduCliError('PROVIDER_NO_KEY', '请配置 Vidu Token')
  if (signal?.aborted) throw new ViduCliError('CANCELLED', '已停止本地 Vidu 调用；远端任务状态需核对')
  const selected = await resolveViduBinary()
  if (signal?.aborted) throw new ViduCliError('CANCELLED', '已停止本地 Vidu 调用；远端任务状态需核对')
  return new Promise((resolve, reject) => {
    const child = spawn(selected, args, {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VIDU_TOKEN: credentials.apiKey, VIDU_BASE_URL: baseURL }
    })
    let stdout = ''
    let settled = false
    const finish = (error?: Error, data?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(data!)
    }
    const abort = (): void => {
      child.kill()
      finish(new ViduCliError('CANCELLED', '已停止本地 Vidu 调用；远端任务状态需核对'))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new ViduCliError('TIMEOUT', 'Vidu CLI 调用超时，请核对原任务，避免重复提交'))
    }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        child.kill()
        finish(new ViduCliError('VIDU_BAD_OUTPUT', 'Vidu CLI 输出超过限制，请核对原任务'))
      }
    })
    // Drain stderr without retaining or forwarding private provider output.
    child.stderr.on('data', () => {})
    child.on('error', () => finish(new ViduCliError('VIDU_CLI_MISSING', 'Vidu CLI 不可用，请安装 npm install -g vidu-cli@0.2.33，或设置 CANVAS_STUDIO_VIDU_PATH 指向原生可执行文件')))
    child.on('close', (code) => {
      if (settled) return
      try {
        if (code !== 0) throw new ViduCliError('VIDU_CLI_FAILED', 'Vidu CLI 调用失败，请检查 Token、额度、网络和 CLI 版本；已提交任务请先核对，避免重复计费')
        const data = parseViduOutput(stdout)
        if (data.ok === false || data.error) {
          const error = data.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : {}
          const httpStatus = Number(error.http_status)
          if (httpStatus === 429) throw new ViduCliError('UPSTREAM_RATE_LIMIT', 'Vidu 查询触发限流，请稍后继续核对原任务')
          if (httpStatus >= 500 && args[0] === 'task' && args[1] === 'get')
            throw new ViduCliError('TIMEOUT', 'Vidu 暂时无法查询任务，请稍后继续核对原任务')
          if (httpStatus >= 500 && args[0] === 'task' && args[1] === 'submit')
            throw new ViduCliError('TASK_OUTCOME_UNKNOWN', 'Vidu 提交状态未知，请核对原任务，避免重复计费')
          throw new ViduCliError('VIDU_CLI_FAILED', `Vidu 服务拒绝请求（HTTP ${httpStatus || '未知'}），请检查 Token、额度和模型参数`)
        }
        binary = selected
        finish(undefined, data)
      } catch (error) { finish(error as Error) }
    })
    if (signal?.aborted) abort()
  })
}

export async function submitViduWithPaths(credentials: ViduCredentials, input: Parameters<typeof buildViduVideoArgs>[0], signal?: AbortSignal): Promise<string> {
  // Exactly one submission. Upstream CLI v0.2.33 also disables retries for writes.
  const data = await runViduJson(credentials, buildViduVideoArgs(input), signal)
  if (typeof data.task_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.task_id))
    throw new ViduCliError('VIDU_BAD_OUTPUT', 'Vidu 未返回有效任务 ID，请核对原任务，避免重复提交')
  return data.task_id
}

export async function pollVidu(credentials: ViduCredentials, taskId: string, signal?: AbortSignal): Promise<ReturnType<typeof classifyViduTask>> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(taskId)) throw new ViduCliError('INVALID_INPUT', 'Vidu 任务 ID 无效')
  // --details is required: plain `task get` omits creations and cannot yield a video URL.
  const data = await runViduJson(credentials, ['task', 'get', taskId, '--details'], signal, 45_000)
  if (data.task_id !== taskId) throw new ViduCliError('VIDU_BAD_OUTPUT', 'Vidu 返回的任务 ID 不匹配')
  return classifyViduTask(data)
}

export async function submitVideoWithVidu(provider: ProviderConfig, input: VideoSubmitInput): Promise<string> {
  try {
    if (input.referenceVideoMediaIds?.length || input.referenceVideoMediaId || input.referenceAudioMediaIds?.length)
      throw new ViduCliError('INVALID_INPUT', '当前 Vidu 仅开放图片参考生视频')
    const imageIds = input.mode === 'first-last-frame'
      ? [input.firstFrameMediaId, input.lastFrameMediaId]
      : input.referenceImageMediaIds ?? []
    const imagePaths = imageIds.map((id) => {
      if (!id) throw new ViduCliError('INVALID_INPUT', 'Vidu 首尾帧图片缺失')
      const row = getDb().prepare('SELECT path, kind FROM media WHERE id = ?').get(id) as { path: string; kind: string } | undefined
      const path = row?.kind === 'image' ? getMediaAbsPath(row.path) : null
      if (!path || !existsSync(path)) throw new ViduCliError('MEDIA_NOT_FOUND', 'Vidu 参考图片不存在')
      return path
    })
    return await submitViduWithPaths(provider, {
      modelId: input.modelId, mode: input.mode ?? 'text', prompt: input.prompt,
      duration: input.params?.duration ?? 1, resolution: input.params?.resolution ?? (input.modelId === '3.2' ? '1080p' : '540p'),
      ratio: input.params?.ratio, imagePaths
    })
  } catch (error) {
    if (error instanceof ViduCliError) throw new GatewayError(error.code, error.message)
    throw new GatewayError('VIDU_LOCAL_MEDIA_FAILED', 'Vidu 本地素材解析失败')
  }
}

export async function pollVideoWithVidu(provider: ProviderConfig, taskId: string): Promise<ReturnType<typeof classifyViduTask>> {
  try { return await pollVidu(provider, taskId) }
  catch (error) {
    if (error instanceof ViduCliError) throw new GatewayError(error.code, error.message)
    throw new GatewayError('VIDU_CLI_FAILED', 'Vidu 任务查询失败')
  }
}
