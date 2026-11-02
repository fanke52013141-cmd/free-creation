// 本地 IndexTTS 2.5 主进程引擎（本机推理，不经过模型网关）。
//
// 背景：配音节点新增 backend=indextts 后，主进程需要「探测本机运行时 + 用一段参考音频
// 克隆音色合成 wav + 登记为项目媒体资产」。解释器（通常藏在 ComfyUI 的内置 Python 里）
// 与 2.5 权重都由用户自行安装，不随应用打包，因此这里只做探测与调用，不做安装。
//
// 与既有本地媒体链路的关系：
// - 子进程执行/取消登记一律复用 media/ffmpeg-runner 的 runProcess：停止工作流时由主进程
//   统一 kill，不形成第二套取消链；
// - 临时目录走 os.tmpdir() + mkdtemp，成功落盘后由 finally 清理；
// - 产物落库复用 store/media.repo 的 saveFileAsset，与 AI 生成媒体共用目录与索引规则；
// - 本模块不打印 console、不发诊断终态：节点执行器与 IPC 已记录阶段，重复记同一终态会
//   造成日志噪声，失败原因只保留阶段与工具摘要，绝不回显用户正文。
//
// 2.5 与 CLI 的兼容坑（2026-11-02 本机实测）：
// 本机 indextts 2.0.0 自带的 `indextts.cli_v2 synth` 在加载权重前会按 2.0 文件清单校验
// bpe.model，而 2.5 权重改用 tiktoken、目录里没有 bpe.model，因此 CLI 会以退出码 2 在
// 100ms 内直接失败（`check` 子命令同样误报，所以探测不能依赖它的退出码）。这里仍把 CLI
// 作为首选调用方式（2.0 权重与将来修好的 CLI 直接可用）；当模型属于 2.5（config.yaml
// version>=2.5，或带 tiktoken 词表且没有 bpe.model）且 CLI 失败时，自动回退到官方 Python
// API `indextts.infer_v2_5.IndexTTS2.infer`，用临时 runner 脚本执行。参数名以本机
// `infer_v2_5.py` 为准：`lang` 与 `duration_factor`（CLI 没有这两个开关）。
import { existsSync, readdirSync, realpathSync, statSync } from 'fs'
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { basename, delimiter as pathDelimiter, dirname, isAbsolute, join } from 'path'
import type { MediaAsset } from '../../shared/types'
import { isMediaCancelled } from './cancellation'
import { runProcess } from './ffmpeg-runner'
import { saveFileAsset } from '../store/media.repo'

/** 解释器路径环境变量：与显式配置同义，供不方便改节点配置的场景使用。 */
const PYTHON_ENV = 'CANVAS_STUDIO_INDEXTTS_PYTHON'
/** 模型目录环境变量。 */
const MODEL_ENV = 'CANVAS_STUDIO_INDEXTTS_MODEL_DIR'
/**
 * 扫描根目录覆盖（可选，多个用系统路径分隔符分隔）。默认扫系统盘符 + 用户目录；
 * 无法接受默认扫描范围的环境可以用它收敛，测试也用它隔离真实安装。
 */
const SCAN_ROOTS_ENV = 'CANVAS_STUDIO_INDEXTTS_SCAN_ROOTS'

/** 运行时不存在（解释器不可用/ENOENT）时的可操作提示。 */
export const INDEXTTS_MISSING_HINT =
  '未找到本地 IndexTTS 运行时。请安装 indextts 包并在本地设置里填写解释器路径，或设置 CANVAS_STUDIO_INDEXTTS_PYTHON。'

/** 解释器 `import indextts` 探测超时。首次导入可能拉起不少依赖，给足 20 秒。 */
const PROBE_TIMEOUT_MS = 20_000
/** 单次合成（含模型加载）超时。2.5 权重约 10GB，冷启动要十几秒。 */
const SYNTH_TIMEOUT_MS = 10 * 60 * 1000
/** 扫描深度：ComfyUI 常见装在 <盘符>/.../ComfyUI，模型在 <ComfyUI>/models/IndexTTS2.5。 */
const SCAN_DEPTH = 5
/** 扫描时间与条目预算：探测不缓存，不能让一次面板打开卡住主进程太久。 */
const SCAN_BUDGET_MS = 3_500
const SCAN_MAX_ENTRIES = 200_000

/** 2.5 模型的最小文件清单：config.yaml + 任一主干权重（CLI 的 bpe.model 清单不适用）。 */
const MODEL_WEIGHT_FILES = [
  'gpt.pth',
  's2mel.pth',
  'codec.pth',
  'gpt.safetensors',
  's2mel.safetensors',
  'codec.safetensors'
]
const MODEL_DIR_NAMES = ['IndexTTS2.5', 'IndexTTS2', 'IndexTTS2.0', 'IndexTTS-2']
/** 目录名匹配 IndexTTS2 / IndexTTS2.5 / IndexTTS-2 这一族。 */
const MODEL_DIR_PATTERN = /^indextts[\s_-]?2(?:\.\d+)?$/
/** 扫描时直接剪枝的大目录，避免把用户整块磁盘翻一遍。 */
const SCAN_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.npm',
  '.gradle',
  '.m2',
  '.vscode',
  '.idea',
  'appdata',
  'windows',
  'program files',
  'program files (x86)',
  '$recycle.bin',
  'system volume information',
  'site-packages',
  '__pycache__',
  '.venv',
  'venv',
  '.conda',
  'dist',
  'out',
  'build',
  'driverstore',
  'winsxs'
])
const INDEX_TTS_LANGS = new Set(['ZH', 'EN', 'JA', 'ES', 'AR'])

export interface IndexTtsRuntime {
  ready: boolean
  pythonPath: string | null
  modelDir: string | null
  /** ready=false 时给用户看的原因（中文、可操作）。 */
  reason: string | null
}

export interface IndexTtsSynthesizeInput {
  projectId: string
  nodeId: string
  text: string
  /** 参考音频绝对路径 */
  referenceAudioPath: string
  pythonPath?: string | null
  modelDir?: string | null
  device?: 'cuda' | 'cpu'
  fp16?: boolean
  /** 0.5–2.0，>1 语速更慢（IndexTTS duration_factor） */
  durationFactor?: number
  /** IndexTTS 语言码：ZH/EN/JA/ES/AR，缺省 ZH */
  lang?: string
}

export type IndexTtsSynthesizeResult =
  | { ok: true; asset: MediaAsset; durationMs: number | null }
  | { ok: false; reason: string; missingRuntime: boolean }

interface PythonCommand {
  command: string
  args: string[]
}

interface LocationScan {
  comfyDirs: string[]
  modelDirs: string[]
}

/** 子进程失败的归类结果；cancelled 与普通失败分开，调用方按产品语义收尾。 */
interface ProcessFailure {
  message: string
  cancelled: boolean
  timedOut: boolean
  missingRuntime: boolean
}

type PythonProbe = 'ok' | 'missing-package' | 'unusable'

function clean(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed : null
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function uniquePaths(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const path = clean(value)
    if (!path) continue
    const key = pathKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

async function isFile(absPath: string): Promise<boolean> {
  try {
    return (await stat(absPath)).isFile()
  } catch {
    return false
  }
}

/** 模型目录最小校验：config.yaml 存在，且至少一个主干权重文件存在。 */
async function validateModelDir(modelDir: string): Promise<boolean> {
  if (!(await isFile(join(modelDir, 'config.yaml')))) return false
  for (const name of MODEL_WEIGHT_FILES) {
    if (await isFile(join(modelDir, name))) return true
  }
  return false
}

/**
 * 校验解释器能否 `import indextts`。
 * - ok：可导入；missing-package：解释器能跑但缺包；unusable：路径不存在/无法启动。
 */
async function probePython(candidate: PythonCommand): Promise<PythonProbe> {
  if (isAbsolute(candidate.command) && !(await isFile(candidate.command))) return 'unusable'
  try {
    await runProcess(
      candidate.command,
      [...candidate.args, '-c', 'import indextts'],
      INDEXTTS_MISSING_HINT,
      {
        timeoutMs: PROBE_TIMEOUT_MS
      }
    )
    return 'ok'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 解释器存在但没装包：runProcess 把 stderr 原样带回（ModuleNotFoundError）。
    if (/ModuleNotFoundError|No module named/i.test(message)) return 'missing-package'
    return 'unusable'
  }
}

function driveRoots(): string[] {
  if (process.platform !== 'win32') return []
  const roots: string[] = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    if (existsSync(root)) roots.push(root)
  }
  return roots
}

/** 常见 ComfyUI 安装位置（不扫盘即可命中的标准布局）。 */
function knownComfyDirs(): string[] {
  const home = homedir()
  const dirs: Array<string | null | undefined> = [
    join(home, 'ComfyUI'),
    join(home, 'ComfyUI_windows_portable', 'ComfyUI'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'ComfyUI') : null,
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'ComfyUI_windows_portable', 'ComfyUI')
      : null
  ]
  for (const root of driveRoots()) {
    dirs.push(join(root, 'ComfyUI'), join(root, 'ComfyUI_windows_portable', 'ComfyUI'))
  }
  return uniquePaths(dirs).filter((dir) => existsSync(dir))
}

/** 从 ComfyUI 目录推导内置 Python 与便携版 Python。 */
function comfyPythonCandidates(comfyDir: string): string[] {
  const win = process.platform === 'win32'
  const executableNames = win ? ['python.exe'] : ['python3', 'python']
  const scriptDir = win ? 'Scripts' : 'bin'
  const roots = [comfyDir, dirname(comfyDir)]
  const dirs = ['python', 'python_embeded', 'python_embedded', 'venv', '.venv']
  const out: string[] = []
  for (const root of roots) {
    for (const dirName of dirs) {
      const base = join(root, dirName)
      const runnable = dirName === 'venv' || dirName === '.venv' ? join(base, scriptDir) : base
      for (const name of executableNames) out.push(join(runnable, name))
    }
  }
  return uniquePaths(out)
}

function knownComfyModelDirs(comfyDir: string): string[] {
  const modelsDir = join(comfyDir, 'models')
  return MODEL_DIR_NAMES.map((name) => join(modelsDir, name))
}

/** 解释器路径 → 同一 ComfyUI 下的模型目录（最多向上找 5 层）。 */
function modelDirsNearBinary(binary: string): string[] {
  if (!isAbsolute(binary)) return []
  const out: string[] = []
  let dir = dirname(binary)
  for (let depth = 0; depth < 5; depth += 1) {
    for (const name of MODEL_DIR_NAMES) out.push(join(dir, 'models', name))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

/** 模型目录位于 <ComfyUI>/models 下时，反推同一套 ComfyUI 的内置 Python。 */
function pythonCandidatesNearModelDir(modelDir: string): string[] {
  const parent = dirname(modelDir)
  if (basename(parent).toLowerCase() !== 'models') return []
  return comfyPythonCandidates(dirname(parent))
}

function resolveScanRoots(): string[] {
  const configured = process.env[SCAN_ROOTS_ENV]?.trim()
  if (configured) {
    return configured
      .split(pathDelimiter)
      .map((value) => value.trim())
      .filter(Boolean)
  }
  const roots = [homedir(), ...driveRoots()]
  const seen = new Set<string>()
  const out: string[] = []
  for (const root of roots) {
    const key = pathKey(root)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

/**
 * 有界扫描：只找 ComfyUI 目录与 IndexTTS 模型目录，深度/时间/条目都有上限。
 * 比喻成 10GB 模型加载，这里宁可漏判后续再探测，也不把主进程卡十几秒。
 */
function scanKnownLocations(): LocationScan {
  const startedAt = Date.now()
  const comfyDirs: string[] = []
  const modelDirs: string[] = []
  const visited = new Set<string>()
  const queue: Array<{ dir: string; depth: number }> = []
  for (const root of resolveScanRoots()) {
    try {
      const real = realpathSync(root)
      const key = pathKey(real)
      if (visited.has(key)) continue
      visited.add(key)
    } catch {
      continue
    }
    queue.push({ dir: root, depth: 0 })
  }

  let entries = 0
  while (queue.length > 0) {
    if (Date.now() - startedAt > SCAN_BUDGET_MS || entries >= SCAN_MAX_ENTRIES) break
    const current = queue.shift()
    if (!current) break
    let dirents
    try {
      dirents = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of dirents) {
      entries += 1
      if (entries >= SCAN_MAX_ENTRIES) break
      let isDirectory = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        // Windows 目录联接（junction）在 Dirent 上不是目录；跟随前用 realpath 防环。
        try {
          const target = join(current.dir, entry.name)
          if (!statSync(target).isDirectory()) continue
          const real = realpathSync(target)
          const key = pathKey(real)
          if (visited.has(key)) continue
          visited.add(key)
          isDirectory = true
        } catch {
          continue
        }
      }
      if (!isDirectory) continue

      const name = entry.name.toLowerCase()
      const full = join(current.dir, entry.name)
      if (name === 'comfyui') {
        comfyDirs.push(full)
        continue
      }
      if (MODEL_DIR_PATTERN.test(name)) {
        modelDirs.push(full)
        continue
      }
      if (SCAN_IGNORED_DIRS.has(name) || name.startsWith('.')) continue
      if (current.depth >= SCAN_DEPTH) continue
      queue.push({ dir: full, depth: current.depth + 1 })
    }
  }

  return {
    comfyDirs: uniquePaths(comfyDirs),
    modelDirs: uniquePaths(modelDirs)
  }
}

function launcherCandidates(): PythonCommand[] {
  const list: PythonCommand[] = []
  if (process.platform === 'win32') {
    list.push({ command: 'py', args: ['-3.12'] })
    list.push({ command: 'py', args: ['-3'] })
  }
  list.push({ command: 'python', args: [] })
  list.push({ command: 'python3', args: [] })
  return list
}

function pythonCandidates(
  explicit: string | null,
  env: string | null,
  explicitModel: string | null
): PythonCommand[] {
  const list: PythonCommand[] = []
  const seen = new Set<string>()
  const add = (command: string, args: string[] = []): void => {
    const key = pathKey(`${command}\u0000${args.join('\u0000')}`)
    if (seen.has(key)) return
    seen.add(key)
    list.push({ command, args })
  }
  if (explicit) add(explicit)
  if (env && env !== explicit) add(env)
  for (const candidate of launcherCandidates()) add(candidate.command, candidate.args)
  for (const comfyDir of knownComfyDirs()) {
    for (const path of comfyPythonCandidates(comfyDir)) add(path)
  }
  if (explicitModel) {
    for (const path of pythonCandidatesNearModelDir(explicitModel)) add(path)
  }
  return list
}

/**
 * 探测解释器与模型：配置路径优先 → 环境变量 → 已知候选目录/`python`/`py`。
 * 结果不缓存：用户装好或改配置后重新调用即生效。
 */
export async function detectIndexTts(
  options: {
    pythonPath?: string | null
    modelDir?: string | null
  } = {}
): Promise<IndexTtsRuntime> {
  try {
    const explicitPython = clean(options.pythonPath)
    const explicitModel = clean(options.modelDir)
    const envPython = clean(process.env[PYTHON_ENV])
    const envModel = clean(process.env[MODEL_ENV])

    // 快速路径：显式配置齐全且都可用时不再扫盘，节点每次执行都不会付扫描成本。
    if (explicitPython && explicitModel && (await validateModelDir(explicitModel))) {
      if ((await probePython({ command: explicitPython, args: [] })) === 'ok') {
        return { ready: true, pythonPath: explicitPython, modelDir: explicitModel, reason: null }
      }
    }

    const candidates = pythonCandidates(explicitPython, envPython, explicitModel)
    let scan: LocationScan | null = null
    const ensureScan = (): LocationScan => {
      scan ??= scanKnownLocations()
      return scan
    }

    let missingPackagePython: string | null = null
    let validPython: string | null = null
    const tryPythonRange = async (from: number): Promise<void> => {
      for (let index = from; index < candidates.length; index += 1) {
        const candidate = candidates[index]
        if (!candidate) continue
        const probe = await probePython(candidate)
        if (probe === 'ok') {
          validPython = candidate.command
          return
        }
        if (probe === 'missing-package' && !missingPackagePython && isAbsolute(candidate.command)) {
          missingPackagePython = candidate.command
        }
      }
    }
    await tryPythonRange(0)

    if (!validPython) {
      // 扫描到的 ComfyUI 往往是非标准安装（本机就是 D:\软件\<套件>\ComfyUI）。
      const found = ensureScan()
      const scanned = pythonCandidates.length
      for (const comfyDir of found.comfyDirs) {
        for (const path of comfyPythonCandidates(comfyDir)) {
          candidates.push({ command: path, args: [] })
        }
      }
      for (const modelDir of found.modelDirs) {
        for (const path of pythonCandidatesNearModelDir(modelDir)) {
          candidates.push({ command: path, args: [] })
        }
      }
      await tryPythonRange(scanned)
    }

    const modelCandidates: string[] = uniquePaths([
      explicitModel,
      envModel,
      ...(validPython ? modelDirsNearBinary(validPython) : []),
      ...knownComfyDirs().flatMap(knownComfyModelDirs)
    ])
    let validModel: string | null = null
    for (const modelDir of modelCandidates) {
      if (await validateModelDir(modelDir)) {
        validModel = modelDir
        break
      }
    }
    if (!validModel) {
      const found = ensureScan()
      const extra = uniquePaths([
        ...found.modelDirs,
        ...found.comfyDirs.flatMap(knownComfyModelDirs)
      ])
      for (const modelDir of extra) {
        if (await validateModelDir(modelDir)) {
          validModel = modelDir
          break
        }
      }
    }

    if (validPython && validModel) {
      return { ready: true, pythonPath: validPython, modelDir: validModel, reason: null }
    }
    if (validPython) {
      return {
        ready: false,
        pythonPath: validPython,
        modelDir: null,
        reason: `已找到 IndexTTS 解释器（${validPython}），但没有找到模型目录。请选择包含 config.yaml 与 gpt.pth/s2mel.pth/codec.pth 的 IndexTTS 2.5 目录，或设置 CANVAS_STUDIO_INDEXTTS_MODEL_DIR。`
      }
    }
    if (validModel) {
      return {
        ready: false,
        pythonPath: missingPackagePython,
        modelDir: validModel,
        reason: missingPackagePython
          ? `已找到模型目录（${validModel}），但解释器（${missingPackagePython}）没有安装 indextts 包。请在该环境执行 pip install indextts，或设置 CANVAS_STUDIO_INDEXTTS_PYTHON。`
          : `已找到模型目录（${validModel}），但没有找到能 import indextts 的 Python 解释器。请安装 indextts，或在本地设置里填写解释器路径。`
      }
    }
    if (missingPackagePython) {
      return {
        ready: false,
        pythonPath: missingPackagePython,
        modelDir: null,
        reason: `本机 Python（${missingPackagePython}）没有安装 indextts 包。请在该环境执行 pip install indextts，或设置 CANVAS_STUDIO_INDEXTTS_PYTHON 指向已安装 indextts 的解释器。`
      }
    }
    return {
      ready: false,
      pythonPath: null,
      modelDir: null,
      reason:
        '未找到本地 IndexTTS 运行时：已检查配置路径、环境变量、PATH 中的 python/py 与常见 ComfyUI 安装位置。请安装 indextts 包，或把解释器与模型目录填入本地设置。'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ready: false,
      pythonPath: null,
      modelDir: null,
      reason: `本地 IndexTTS 运行时探测失败：${message}`
    }
  }
}

/**
 * CLI 参数拼装（纯函数，便于单测与排障）。
 * 注意：本机 indextts 2.0.0 的 `cli_v2 synth` 没有 duration-factor / lang 开关，
 * 因此这里不拼这两个参数；2.5 模型的语言与语速由回退的 infer_v2_5 API 承担。
 */
export function buildIndexTtsArgs(
  input: IndexTtsSynthesizeInput,
  runtime: {
    pythonPath: string
    modelDir: string
    textFilePath: string
    outputPath: string
  }
): string[] {
  const device = input.device === 'cpu' ? 'cpu' : 'cuda'
  const args = [
    '-m',
    'indextts.cli_v2',
    'synth',
    '--text-file',
    runtime.textFilePath,
    '--voice',
    input.referenceAudioPath,
    '--output',
    runtime.outputPath,
    '--model-dir',
    runtime.modelDir,
    '--device',
    device,
    '--force'
  ]
  // 显式 CPU 推理时去掉 --fp16：IndexTTS 在 CPU 上不支持半精度。
  if (device !== 'cpu' && input.fp16 !== false) args.push('--fp16')
  return args
}

interface DirectRunnerConfig {
  cfgPath: string
  modelDir: string
  device: 'cuda' | 'cpu'
  useBf16: boolean
  referenceAudioPath: string
  textPath: string
  outputPath: string
  lang: string
  durationFactor: number
}

/** 2.5 的官方 Python API 没有 CLI 的 bpe 旧清单问题；参数名按本机 infer_v2_5.py。 */
const DIRECT_RUNNER_SOURCE = `import json
import os
import sys


def fail(message):
    print("ERROR: " + message, file=sys.stderr)
    return 4


def main():
    if len(sys.argv) != 2:
        return fail("runner expected exactly one config path")
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as handle:
            config = json.load(handle)
        with open(config["textPath"], "r", encoding="utf-8") as handle:
            text = handle.read()
    except Exception as exc:
        return fail("read input failed: " + str(exc))
    if not text.strip():
        return fail("text is empty")
    try:
        from indextts.infer_v2_5 import IndexTTS2
    except Exception as exc:
        return fail("import indextts.infer_v2_5 failed: " + str(exc))
    try:
        model = IndexTTS2(
            cfg_path=config["cfgPath"],
            model_dir=config["modelDir"],
            use_bf16=bool(config.get("useBf16")),
            device=config["device"],
            use_cuda_kernel=False,
        )
        model.infer(
            spk_audio_prompt=config["referenceAudioPath"],
            text=text,
            output_path=config["outputPath"],
            lang=config["lang"],
            duration_factor=float(config.get("durationFactor", 1.0)),
            verbose=False,
        )
    except Exception as exc:
        return fail("inference failed: " + str(exc))
    if not os.path.isfile(config["outputPath"]) or os.path.getsize(config["outputPath"]) == 0:
        return fail("output audio was not created")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`

/** 2.5 权重：config.yaml version>=2.5，或带 tiktoken 词表且没有 2.0 的 bpe.model。 */
async function isIndexTts25Model(modelDir: string): Promise<boolean> {
  const config = await readFile(join(modelDir, 'config.yaml'), 'utf8').catch(() => '')
  const match = /^\s*version\s*:\s*["']?([0-9][0-9.]*)/m.exec(config)
  if (match) {
    const version = Number.parseFloat(match[1] ?? '')
    if (Number.isFinite(version) && version >= 2.5) return true
  }
  if (await isFile(join(modelDir, 'bpe.model'))) return false
  const entries = await readdir(modelDir).catch(() => [] as string[])
  return entries.some((name) => /\.tiktoken$/i.test(name))
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, parsed))
}

function normalizeIndexTtsLang(lang: unknown): string {
  if (typeof lang !== 'string') return 'ZH'
  const value = lang.trim().toUpperCase()
  return INDEX_TTS_LANGS.has(value) ? value : 'ZH'
}

function localTimestamp(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * 执行一次合成子进程；取消/超时/ENOENT 都归一到 ProcessFailure。
 * 正常退出返回 null。
 */
async function runSynthesisProcess(
  binary: string,
  args: string[],
  startedAt: number
): Promise<ProcessFailure | null> {
  try {
    await runProcess(binary, args, INDEXTTS_MISSING_HINT, { timeoutMs: SYNTH_TIMEOUT_MS })
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isMediaCancelled()) {
      return { message: '已取消', cancelled: true, timedOut: false, missingRuntime: false }
    }
    // runProcess 把 ENOENT 逐字翻译成 missingHint，可直接比对。
    if (message === INDEXTTS_MISSING_HINT) {
      return { message, cancelled: false, timedOut: false, missingRuntime: true }
    }
    return {
      message,
      cancelled: false,
      timedOut: Date.now() - startedAt >= SYNTH_TIMEOUT_MS - 1_000,
      missingRuntime: /No module named 'indextts'|No module named "indextts"/.test(message)
    }
  }
}

/** 失败摘要只保留工具与阶段信息，并剥掉可能被 CLI 拼进异常的用户正文。 */
function sanitizeToolDetail(raw: string, privateText: string): string {
  const text = raw.trim()
  if (!text) return '未返回错误详情'
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const errorLine =
    [...lines].reverse().find((line) => /^ERROR[:：]/i.test(line)) ??
    lines[lines.length - 1] ??
    text
  let detail = errorLine.replace(/^ERROR[:：]\s*/i, '')
  const privatePieces = [privateText, privateText.slice(0, Math.min(40, privateText.length))]
  for (const piece of privatePieces) {
    if (piece.length >= 4) detail = detail.split(piece).join('<text>')
  }
  return detail.slice(0, 240)
}

function classifySynthesisFailure(
  failure: ProcessFailure,
  privateText: string
): IndexTtsSynthesizeResult {
  if (failure.cancelled) return { ok: false, reason: '已取消', missingRuntime: false }
  if (failure.missingRuntime)
    return { ok: false, reason: INDEXTTS_MISSING_HINT, missingRuntime: true }
  if (failure.timedOut) {
    return {
      ok: false,
      reason:
        '本地语音合成超时（已等待 10 分钟）：indextts 推理没有完成。请缩短文本、改用 CPU 以外的设备，或检查显卡驱动。',
      missingRuntime: false
    }
  }
  if (
    /missing required model files/i.test(failure.message) &&
    /bpe\.model/i.test(failure.message)
  ) {
    return {
      ok: false,
      reason:
        '本地 IndexTTS 模型目录被旧版 CLI 判定为缺文件（它仍按 2.0 清单要求 bpe.model，2.5 已改用 tiktoken）。自动回退到 2.5 Python API 也失败，请确认模型目录包含 config.yaml、gpt.pth、s2mel.pth 与 tiktoken 词表。',
      missingRuntime: false
    }
  }
  if (
    /out of memory|OutOfMemory|Not enough memory|CUDA error: out of memory/i.test(failure.message)
  ) {
    return {
      ok: false,
      reason:
        '显存不足：加载 IndexTTS 2.5 权重失败。请关闭占用显存的程序后重试，或在节点设置里把设备切到 CPU。',
      missingRuntime: false
    }
  }
  if (/No module named|ModuleNotFoundError/i.test(failure.message)) {
    return {
      ok: false,
      reason:
        '本地 IndexTTS 解释器缺少所需模块（indextts / infer_v2_5）。请在该 Python 环境重新安装 indextts 后重试。',
      missingRuntime: true
    }
  }
  return {
    ok: false,
    reason: `本地语音合成失败（indextts）：${sanitizeToolDetail(failure.message, privateText)}`,
    missingRuntime: false
  }
}

/** 从 wav 头解析时长；22050Hz/16bit 由 IndexTTS 固定，但这里按 RIFF 通用解析。 */
async function readWavDurationMs(absPath: string): Promise<number | null> {
  try {
    const handle = await open(absPath, 'r')
    try {
      const buffer = Buffer.alloc(8192)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const header = buffer.subarray(0, bytesRead)
      if (
        header.length < 12 ||
        header.toString('ascii', 0, 4) !== 'RIFF' ||
        header.toString('ascii', 8, 12) !== 'WAVE'
      ) {
        return null
      }
      let byteRate = 0
      let dataSize = 0
      let dataOffset = 0
      let offset = 12
      while (offset + 8 <= header.length) {
        const id = header.toString('ascii', offset, offset + 4)
        const size = header.readUInt32LE(offset + 4)
        if (id === 'fmt ' && offset + 20 <= header.length) {
          byteRate = header.readUInt32LE(offset + 16)
        } else if (id === 'data') {
          dataOffset = offset + 8
          dataSize = size
          break
        }
        offset += 8 + size + (size % 2)
      }
      if (!dataSize || dataSize === 0xffffffff) {
        const info = await stat(absPath)
        dataSize = Math.max(0, info.size - dataOffset)
      }
      if (byteRate <= 0 || dataSize <= 0) return null
      return Math.round((dataSize / byteRate) * 1000)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** 合成失败时的统一收尾：不泄漏正文，不伪造成功。 */
function failed(reason: string, missingRuntime = false): IndexTtsSynthesizeResult {
  return { ok: false, reason, missingRuntime }
}

/**
 * 用参考音频克隆音色并合成文本，成功后登记为项目媒体资产。
 *
 * 调用顺序：CLI（2.0 权重/兼容 CLI）→ 2.5 模型时回退 infer_v2_5 API。
 * 临时目录在 finally 清理；取消返回 reason='已取消'（执行器据此归为 skipped）。
 */
export async function synthesizeWithIndexTts(
  input: IndexTtsSynthesizeInput
): Promise<IndexTtsSynthesizeResult> {
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!text) return failed('朗读文本为空，请输入要合成的内容。')
  if (!clean(input.projectId)) return failed('缺少项目 ID，无法登记本地合成结果。')
  const referencePath =
    typeof input.referenceAudioPath === 'string' ? input.referenceAudioPath.trim() : ''
  if (!referencePath || !isAbsolute(referencePath)) {
    return failed('参考音频路径无效：需要本机绝对路径。')
  }
  if (!(await isFile(referencePath))) return failed('参考音频文件不存在或无法读取。')

  const runtime = await detectIndexTts({ pythonPath: input.pythonPath, modelDir: input.modelDir })
  if (!runtime.ready || !runtime.pythonPath || !runtime.modelDir) {
    return failed(runtime.reason ?? INDEXTTS_MISSING_HINT, true)
  }
  const pythonPath = runtime.pythonPath
  const modelDir = runtime.modelDir
  const device: 'cuda' | 'cpu' = input.device === 'cpu' ? 'cpu' : 'cuda'
  const fp16 = device !== 'cpu' && input.fp16 !== false
  const durationFactor = clampNumber(input.durationFactor, 0.5, 2, 1)
  const lang = normalizeIndexTtsLang(input.lang)
  const startedAt = Date.now()

  let tempDir: string | null = null
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'canvas-studio-indextts-'))
    const textPath = join(tempDir, 'text.txt')
    const outputPath = join(tempDir, 'tts.wav')
    await writeFile(textPath, text, 'utf8')

    const cliFailure = await runSynthesisProcess(
      pythonPath,
      buildIndexTtsArgs(input, { pythonPath, modelDir, textFilePath: textPath, outputPath }),
      startedAt
    )
    if (cliFailure?.cancelled) return failed('已取消')

    let failure = cliFailure
    if (cliFailure && (await isIndexTts25Model(modelDir))) {
      // 2.5 走官方 API：CLI 的 2.0 文件清单会在加载前误杀 2.5 权重。
      const configPath = join(tempDir, 'runner.json')
      const runnerPath = join(tempDir, 'runner.py')
      const runnerConfig: DirectRunnerConfig = {
        cfgPath: join(modelDir, 'config.yaml'),
        modelDir,
        device,
        useBf16: fp16,
        referenceAudioPath: referencePath,
        textPath,
        outputPath,
        lang,
        durationFactor
      }
      await writeFile(configPath, JSON.stringify(runnerConfig), 'utf8')
      await writeFile(runnerPath, DIRECT_RUNNER_SOURCE, 'utf8')
      failure = await runSynthesisProcess(
        pythonPath,
        ['-X', 'utf8', runnerPath, configPath],
        startedAt
      )
      if (failure?.cancelled) return failed('已取消')
    }

    if (failure) return classifySynthesisFailure(failure, text)
    if (!(await isFile(outputPath))) {
      return failed(
        '本地语音合成没有生成音频文件（indextts 进程正常退出但未写出 wav），请检查模型目录与参考音频。'
      )
    }

    const durationMs = await readWavDurationMs(outputPath)
    const asset = await saveFileAsset(
      input.projectId,
      outputPath,
      '.wav',
      `本地TTS-${localTimestamp()}`
    )
    return { ok: true, asset, durationMs }
  } catch (error) {
    if (isMediaCancelled()) return failed('已取消')
    if (error instanceof Error && error.message === INDEXTTS_MISSING_HINT) {
      return failed(INDEXTTS_MISSING_HINT, true)
    }
    const message = sanitizeToolDetail(error instanceof Error ? error.message : String(error), text)
    return failed(`本地语音合成失败（indextts）：${message}`)
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
