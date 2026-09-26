import { app } from 'electron'
import { createHash } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { getDataDir, getDb } from '../store/db'
import { deleteMedia, getMediaAbsPath, saveFileAsset } from '../store/media.repo'
import type { MediaAsset } from '../../shared/types'
import type { VideoConversionInput, VideoEngineStatus } from '../../shared/contracts'
import {
  parseVideoClayConfig,
  parseVideoDepthConfig,
  type VideoClayConfig,
  type VideoDepthConfig
} from '../../shared/video-conversion'

const PYTHON_VERSION = '3.12'
const TORCH = '2.7.1'
const TORCHVISION = '0.22.1'
const MODEL_BYTES = 116_440_756
const MODEL_SHA256 = '13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609'
const MODEL_URL =
  'https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/a396fdd839642f9bb4d08d54cae9fbf43ca13388/video_depth_anything_vits.pth?download=true'

type Mode = 'depth' | 'clay'

const dataRoot = (): string => join(getDataDir(), 'video-conversion')
const venvRoot = (): string => join(dataRoot(), 'python-env')
const venvPython = (): string =>
  process.platform === 'win32'
    ? join(venvRoot(), 'Scripts', 'python.exe')
    : join(venvRoot(), 'bin', 'python')
const checkpointPath = (): string => join(dataRoot(), 'models', 'video_depth_anything_vits.pth')
const readyPath = (): string => join(dataRoot(), 'ready.json')
const workerPath = (): string => join(app.getAppPath(), 'resources', 'video-conversion', 'runner.py')
const vendorPath = (): string => join(app.getAppPath(), 'resources', 'video-conversion', 'vendor')

let installStatus: VideoEngineStatus = {
  pythonAvailable: false,
  ready: false,
  installing: false,
  progress: '',
  message: '尚未安装本地推理环境'
}
let installPromise: Promise<void> | null = null
let installStarting = false
const activeJobs = new Map<string, ChildProcess>()
const jobStates = new Map<string, { cancelled: boolean }>()
type PendingConversion = {
  jobId: string
  resolve: (release: () => void) => void
  reject: (error: Error) => void
}
const pendingConversions: PendingConversion[] = []
let activeConversionId: string | null = null

function startNextConversion(): void {
  while (pendingConversions.length) {
    const next = pendingConversions.shift()!
    if (jobStates.get(next.jobId)?.cancelled) {
      next.reject(new Error('已取消'))
      continue
    }
    activeConversionId = next.jobId
    next.resolve(() => releaseConversionSlot(next.jobId))
    return
  }
}

function releaseConversionSlot(jobId: string): void {
  if (activeConversionId !== jobId) return
  activeConversionId = null
  startNextConversion()
}

function acquireConversionSlot(jobId: string): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (!activeConversionId) {
      activeConversionId = jobId
      resolve(() => releaseConversionSlot(jobId))
      return
    }
    pendingConversions.push({ jobId, resolve, reject })
  })
}

function updateInstallStatus(patch: Partial<VideoEngineStatus>): void {
  installStatus = { ...installStatus, ...patch }
}

function runProcess(
  command: string,
  args: string[],
  onText?: (text: string) => void,
  onProcess?: (child: ChildProcess) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PIP_NO_CACHE_DIR: '1' }
    })
    onProcess?.(child)
    let output = ''
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      output = `${output}${text}`.slice(-12_000)
      onText?.(text)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`${command} 退出码 ${String(code)}：${output.trim().slice(-3000)}`))
    })
  })
}

type PythonLauncher = { command: string; args: string[] }

async function resolvePythonLauncher(): Promise<PythonLauncher | null> {
  if (process.platform === 'win32') {
    try {
      await runProcess('py', [`-${PYTHON_VERSION}`, '--version'])
      return { command: 'py', args: [`-${PYTHON_VERSION}`] }
    } catch {
      // uv-managed Python installations are not necessarily registered with py.exe.
    }

    const candidates: string[] = []
    if (process.env.LOCALAPPDATA) {
      candidates.push(
        join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe')
      )
    }
    if (process.env.APPDATA) {
      const uvPythonRoot = join(process.env.APPDATA, 'uv', 'python')
      const uvVersions = await readdir(uvPythonRoot).catch(() => [])
      candidates.push(
        ...uvVersions
          .filter((entry) => /^cpython-3\.12\./.test(entry))
          .sort()
          .reverse()
          .map((entry) => join(uvPythonRoot, entry, 'python.exe'))
      )
    }
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      try {
        await runProcess(candidate, [
          '-c',
          'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)'
        ])
        return { command: candidate, args: [] }
      } catch {
        // Try the next installed Python 3.12 runtime.
      }
    }
    return null
  }
  if (process.platform === 'darwin') return null
  const command = `python${PYTHON_VERSION}`
  try {
    await runProcess(command, ['--version'])
    return { command, args: [] }
  } catch {
    return null
  }
}

async function runtimeReady(): Promise<boolean> {
  if (!existsSync(readyPath()) || !existsSync(venvPython()) || !existsSync(checkpointPath()))
    return false
  const weight = await stat(checkpointPath()).catch(() => null)
  if (!weight || weight.size !== MODEL_BYTES) return false
  try {
    const record = JSON.parse(await readFile(readyPath(), 'utf8')) as { modelSha256?: unknown }
    return record.modelSha256 === MODEL_SHA256
  } catch {
    return false
  }
}

export async function getVideoEngineStatus(): Promise<VideoEngineStatus> {
  const ready = await runtimeReady()
  const pythonAvailable = ready || existsSync(venvPython()) || Boolean(await resolvePythonLauncher())
  if (!installStatus.installing && ready) {
    try {
      const marker = JSON.parse(await readFile(readyPath(), 'utf8')) as { gpuName?: string }
      installStatus = {
        ...installStatus,
        pythonAvailable: true,
        ready: true,
        message: '本地推理环境已就绪',
        progress: '',
        ...(marker.gpuName ? { gpuName: marker.gpuName } : {})
      }
    } catch {
      installStatus = { ...installStatus, pythonAvailable, ready: false }
    }
  } else if (!installStatus.installing) {
    installStatus = {
      ...installStatus,
      pythonAvailable,
      ready: false,
      message: pythonAvailable
        ? installStatus.message === '本地推理环境已就绪'
          ? '本地推理环境需要修复或重新安装'
          : installStatus.message
      : process.platform === 'darwin'
        ? '首版本地 CUDA 推理环境支持 Windows/Linux NVIDIA 显卡'
        : `需要先安装 Python ${PYTHON_VERSION}，然后再安装本地推理环境`
    }
  }
  return { ...installStatus }
}

export async function installVideoEngine(): Promise<{ started: boolean }> {
  if (installPromise || installStarting) return { started: true }
  installStarting = true
  try {
    if (await runtimeReady()) {
      updateInstallStatus({
        pythonAvailable: true,
        ready: true,
        installing: false,
        progress: '',
        message: '本地推理环境已就绪'
      })
      return { started: false }
    }
    const launcher = await resolvePythonLauncher()
    if (!launcher) {
      updateInstallStatus({
        pythonAvailable: false,
        ready: false,
        installing: false,
        message: `未找到 Python ${PYTHON_VERSION}；请先安装 Python ${PYTHON_VERSION}（64 位）后重试`
      })
      throw new Error(installStatus.message)
    }

    updateInstallStatus({
      pythonAvailable: true,
      ready: false,
      installing: true,
      progress: '创建隔离 Python 环境',
      message: '正在安装；首次下载可能需要一些时间'
    })
    installPromise = (async () => {
    const root = dataRoot()
    const modelDir = join(root, 'models')
    await mkdir(modelDir, { recursive: true })
    await rm(readyPath(), { force: true })
    if (!existsSync(venvPython())) {
      await runProcess(launcher.command, [...launcher.args, '-m', 'venv', venvRoot()])
    }

    const python = venvPython()
    const report = (progress: string) => (chunk: string): void => {
      const trimmed = chunk.trim().split(/\r?\n/).filter(Boolean).at(-1)
      if (trimmed) updateInstallStatus({ progress: `${progress} · ${trimmed.slice(-140)}` })
    }
    updateInstallStatus({ progress: '更新 pip' })
    await runProcess(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], report('更新 pip'))
    updateInstallStatus({ progress: '安装 CUDA 版 PyTorch（约 3.3 GB）' })
    await runProcess(
      python,
      [
        '-m',
        'pip',
        'install',
        `torch==${TORCH}`,
        `torchvision==${TORCHVISION}`,
        '--index-url',
        'https://download.pytorch.org/whl/cu128'
      ],
      report('安装 PyTorch')
    )
    updateInstallStatus({ progress: '安装视频推理依赖' })
    await runProcess(
      python,
      [
        '-m',
        'pip',
        'install',
        'numpy==2.2.6',
        'opencv-python-headless==4.11.0.86',
        'einops==0.8.1',
        'easydict==1.13',
        'tqdm==4.67.1'
      ],
      report('安装推理依赖')
    )
    updateInstallStatus({ progress: '检查 CUDA 显卡' })
    const gpuOutput = await runProcess(python, [
      '-c',
      'import torch; print("CANVAS_GPU=" + (torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""))'
    ])
    const gpuName = gpuOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('CANVAS_GPU='))
      ?.slice('CANVAS_GPU='.length) ?? ''
    if (!gpuName) throw new Error('PyTorch 未检测到可用 CUDA 显卡，无法启用本地视频推理')

    updateInstallStatus({ progress: '下载并校验 Video Depth Anything Small 权重' })
    const response = await fetch(MODEL_URL)
    if (!response.ok) throw new Error(`模型下载失败：HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== MODEL_BYTES) throw new Error('模型文件大小校验失败，请重新安装')
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== MODEL_SHA256) throw new Error('模型 SHA-256 校验失败，请重新安装')
    const temporaryWeight = `${checkpointPath()}.download`
    await writeFile(temporaryWeight, bytes)
    await rename(temporaryWeight, checkpointPath())
    await writeFile(
      readyPath(),
      JSON.stringify({ modelSha256: MODEL_SHA256, gpuName, installedAt: Date.now() })
    )
    updateInstallStatus({
      pythonAvailable: true,
      ready: true,
      installing: false,
      progress: '',
      message: `本地推理环境已就绪 · ${gpuName}`,
      gpuName
    })
    })()
      .catch((error: unknown) => {
        updateInstallStatus({
          ready: false,
          installing: false,
          progress: '',
          message: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        installPromise = null
      })
    return { started: true }
  } finally {
    installStarting = false
  }
}

function resolveSource(projectId: string, mediaId: string): { path: string; name: string } {
  const prefix = `projects/${projectId}/media/`
  const row = getDb()
    .prepare(
      'SELECT path, mime, kind, name FROM media WHERE id = ? AND substr(path, 1, length(?)) = ? LIMIT 1'
    )
    .get(mediaId, prefix, prefix) as
    | { path: string; mime: string; kind: string; name?: string }
    | undefined
  if (!row || row.kind !== 'video' || !row.mime.startsWith('video/')) {
    throw new Error('输入视频不存在，或不属于当前项目')
  }
  const source = getMediaAbsPath(row.path)
  if (!source) throw new Error('输入视频路径无效')
  return { path: source, name: row.name?.trim() || basename(source).replace(/\.[^.]+$/, '') }
}

function runTracked(
  command: string,
  args: string[],
  jobId: string,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  if (jobStates.get(jobId)?.cancelled) return Promise.reject(new Error('已取消'))
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        PIP_NO_CACHE_DIR: '1'
      }
    })
    activeJobs.set(jobId, child)
    let output = ''
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-8000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', (error) => {
      activeJobs.delete(jobId)
      reject(error)
    })
    child.once('close', (code, signal) => {
      activeJobs.delete(jobId)
      if (code === 0) resolve(output)
      else reject(new Error(signal ? '已取消' : output.trim().slice(-2500) || `子进程退出码 ${code}`))
    })
  })
}

async function runConversion(mode: Mode, input: {
  projectId: string
  sourceMediaId: string
  jobId: string
  config: VideoDepthConfig | VideoClayConfig
}): Promise<MediaAsset> {
  if (!/^[\w:-]{1,180}$/.test(input.jobId)) throw new Error('视频任务 ID 无效')
  if (!/^[\w-]{1,120}$/.test(input.projectId)) throw new Error('项目 ID 无效')
  if (jobStates.has(input.jobId)) throw new Error('相同的视频转换任务 ID 已在使用')
  jobStates.set(input.jobId, { cancelled: false })
  let releaseSlot: (() => void) | null = null
  let dir: string | null = null
  try {
    releaseSlot = await acquireConversionSlot(input.jobId)
    if (!(await runtimeReady())) throw new Error('本地推理环境尚未安装，请在节点设置中完成安装')
    const source = resolveSource(input.projectId, input.sourceMediaId)
    const config = mode === 'depth' ? parseVideoDepthConfig(input.config) : parseVideoClayConfig(input.config)
    dir = await mkdtemp(join(dataRoot(), 'job-'))
    const raw = join(dir, 'frames.rgb')
    const metadataPath = join(dir, 'frames.json')
    const output = join(dir, 'converted.mp4')
    const pythonEnv = { PYTHONPATH: vendorPath() }
    const python = venvPython()
    await runTracked(
      python,
      [
        workerPath(),
        '--input',
        source.path,
        '--checkpoint',
        checkpointPath(),
        '--output-raw',
        raw,
        '--output-meta',
        metadataPath,
        '--mode',
        mode,
        '--config',
        JSON.stringify(config)
      ],
      input.jobId,
      pythonEnv
    )
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      width: number
      height: number
      fps: number
      frames: number
    }
    if (
      !Number.isInteger(metadata.width) ||
      !Number.isInteger(metadata.height) ||
      !Number.isFinite(metadata.fps) ||
      metadata.frames < 1
    ) {
      throw new Error('视频推理器返回了无效的视频信息')
    }
    const ffmpeg = process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim() || 'ffmpeg'
    const args = [
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgb24',
      '-video_size',
      `${metadata.width}x${metadata.height}`,
      '-framerate',
      String(metadata.fps),
      '-i',
      raw
    ]
    if (config.preserveAudio) args.push('-i', source.path)
    args.push('-map', '0:v:0')
    if (config.preserveAudio) args.push('-map', '1:a?')
    args.push(
      '-frames:v',
      String(metadata.frames),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p'
    )
    if (config.preserveAudio) args.push('-c:a', 'aac', '-b:a', '192k')
    args.push('-t', (metadata.frames / metadata.fps).toFixed(3), '-movflags', '+faststart', '-y', output)
    await runTracked(ffmpeg, args, input.jobId)
    const created = await stat(output).catch(() => null)
    if (!created?.isFile() || created.size === 0) throw new Error('视频编码器未生成有效文件')
    if (jobStates.get(input.jobId)?.cancelled) throw new Error('已取消')
    const label = mode === 'depth' ? '深度视频' : '白模视频'
    const asset = await saveFileAsset(input.projectId, output, '.mp4', `${source.name}-${label}`)
    if (jobStates.get(input.jobId)?.cancelled) {
      await deleteMedia(asset.id).catch(() => undefined)
      throw new Error('已取消')
    }
    return asset
  } finally {
    releaseSlot?.()
    jobStates.delete(input.jobId)
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export const convertVideoDepth = (
  input: Omit<VideoConversionInput, 'config'> & { config: VideoDepthConfig }
): Promise<MediaAsset> => runConversion('depth', input)

export const convertVideoClay = (
  input: Omit<VideoConversionInput, 'config'> & { config: VideoClayConfig }
): Promise<MediaAsset> => runConversion('clay', input)

export function cancelVideoConversion(jobId: string): boolean {
  const state = jobStates.get(jobId)
  if (!state) return false
  state.cancelled = true
  const child = activeJobs.get(jobId)
  child?.kill()
  if (activeConversionId !== jobId) {
    const index = pendingConversions.findIndex((pending) => pending.jobId === jobId)
    if (index >= 0) pendingConversions.splice(index, 1)[0].reject(new Error('已取消'))
  }
  return true
}
