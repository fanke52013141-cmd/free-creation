// 本地 IndexTTS 2.5 主进程引擎回归（探测 / 参数拼装 / 进程编排 / 失败分类）。
//
// 不碰真实 GPU：用一个「真实 Python 解释器 + 临时 stub indextts 包」代替本机 10GB
// 权重。stub 包同时提供 cli_v2（CLI 路径）与 infer_v2_5（2.5 API 回退路径），通过
// INDEXTTS_TEST_MODE / INDEXTTS_TEST_CLI 控制成功、失败、取消三种行为；通过
// INDEXTTS_TEST_LOG 记录真实收到的参数，断言引擎拼装的 --text-file/--voice/--device/
// --fp16/lang/duration_factor 与临时文本内容。
//
// 落库走真实 media.repo.saveFileAsset：mock 掉 store/db，用 node:sqlite 内存库建真实
// media 表（与 media-probe.test.ts 同一套做法），验证产物确实进入项目媒体目录。
//
// 运行时探测的默认扫盘范围用 CANVAS_STUDIO_INDEXTTS_SCAN_ROOTS 收敛到临时目录，
// 避免测试误命中本机真实安装，也避免把整块磁盘扫一遍。
import { spawnSync } from 'child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateDatabase } from '../src/main/store/db-migrations'

const h = vi.hoisted(() => ({ dataDir: '', database: null as unknown }))

vi.mock('../src/main/store/db', () => ({
  getDataDir: () => h.dataDir,
  getDb: () => {
    const database = h.database as DatabaseSync
    return { prepare: (sql: string) => database.prepare(sql) }
  }
}))

import {
  buildIndexTtsArgs,
  detectIndexTts,
  synthesizeWithIndexTts,
  type IndexTtsSynthesizeInput
} from '../src/main/media/indextts-engine'
import { cancelMediaJobs, runWithMediaScope } from '../src/main/media/cancellation'

const ENGINE_TEMP_PREFIX = 'canvas-studio-indextts-'

interface StubLogEntry {
  kind: 'cli' | 'direct'
  payload: Record<string, unknown>
  argv?: string[]
}

let root = ''
let dataDir = ''
let stubRoot = ''
let scanRoot = ''
let logPath = ''
let database: DatabaseSync
let modelCliDir = ''
let modelV25Dir = ''
const savedEnv = new Map<string, string | undefined>()

const ENV_KEYS = [
  'PYTHONPATH',
  'INDEXTTS_TEST_LOG',
  'INDEXTTS_TEST_MODE',
  'INDEXTTS_TEST_CLI',
  'CANVAS_STUDIO_INDEXTTS_SCAN_ROOTS',
  'CANVAS_STUDIO_INDEXTTS_PYTHON',
  'CANVAS_STUDIO_INDEXTTS_MODEL_DIR'
]

/** 系统 Python 只用来执行 stub 包，不加载任何模型；没有 Python 的机器整组跳过。 */
function resolveSystemPython(): string | null {
  for (const command of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const probe = spawnSync(
      command,
      command === 'py'
        ? ['-3', '-c', 'import sys; print(sys.executable)']
        : ['-c', 'import sys; print(sys.executable)'],
      { encoding: 'utf8' }
    )
    if (probe.status === 0) {
      const path = probe.stdout.trim().split(/\r?\n/).pop()?.trim()
      if (path) return path
    }
  }
  return null
}

// 描述块是否执行必须在模块加载时决定，因此这里同步解析一次（约 100ms，只执行 --version）。
const pythonPath = resolveSystemPython()

const STUB_CLI = String.raw`import json
import os
import sys
import wave


def _arg(argv, name):
    try:
        return argv[argv.index(name) + 1]
    except (ValueError, IndexError):
        return None


def _log(payload):
    path = os.environ.get("INDEXTTS_TEST_LOG")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"kind": "cli", "payload": payload, "argv": sys.argv}, ensure_ascii=False) + "\n")


def _wav(path, seconds):
    if not path:
        return
    frames = int(22050 * seconds)
    with wave.open(path, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(22050)
        audio.writeframes(b"\x00\x00" * frames)


def main():
    text_file = _arg(sys.argv, "--text-file")
    text = ""
    if text_file:
        with open(text_file, "r", encoding="utf-8") as handle:
            text = handle.read()
    _log(
        {
            "text": text,
            "voice": _arg(sys.argv, "--voice"),
            "output": _arg(sys.argv, "--output"),
            "modelDir": _arg(sys.argv, "--model-dir"),
            "device": _arg(sys.argv, "--device"),
            "fp16": "--fp16" in sys.argv,
        }
    )
    if os.environ.get("INDEXTTS_TEST_CLI") == "missing-bpe":
        print("ERROR: missing required model files: bpe.model", file=sys.stderr)
        return 2
    mode = os.environ.get("INDEXTTS_TEST_MODE", "success")
    if mode == "fail":
        print("ERROR: simulated cli failure", file=sys.stderr)
        return 1
    if mode == "cancel":
        import time

        time.sleep(60)
        return 0
    _wav(_arg(sys.argv, "--output"), 0.5)
    return 0


if __name__ == "__main__":
    sys.exit(main())
`

const STUB_INFER = String.raw`import json
import os
import time
import wave


def _log(payload):
    path = os.environ.get("INDEXTTS_TEST_LOG")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"kind": "direct", "payload": payload}, ensure_ascii=False) + "\n")


class IndexTTS2:
    def __init__(self, cfg_path=None, model_dir=None, use_bf16=False, device=None, use_cuda_kernel=None, **kwargs):
        self.cfg_path = cfg_path
        self.model_dir = model_dir
        self.use_bf16 = use_bf16
        self.device = device

    def infer(self, spk_audio_prompt=None, text=None, output_path=None, lang="ZH", duration_factor=1.0, verbose=False, **kwargs):
        mode = os.environ.get("INDEXTTS_TEST_MODE", "success")
        if mode == "fail":
            raise RuntimeError("simulated inference failure")
        if mode == "cancel":
            time.sleep(60)
        _log(
            {
                "cfgPath": self.cfg_path,
                "modelDir": self.model_dir,
                "useBf16": self.use_bf16,
                "device": self.device,
                "lang": lang,
                "durationFactor": duration_factor,
                "text": text,
                "voice": spk_audio_prompt,
                "output": output_path,
            }
        )
        frames = int(22050 * 1.0)
        with wave.open(output_path, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(22050)
            audio.writeframes(b"\x00\x00" * frames)
`

async function writeStubPackage(): Promise<void> {
  stubRoot = join(root, 'stub')
  const packageDir = join(stubRoot, 'indextts')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, '__init__.py'), '__version__ = "2.0.0-stub"\n', 'utf8')
  await writeFile(join(packageDir, 'cli_v2.py'), STUB_CLI, 'utf8')
  await writeFile(join(packageDir, 'infer_v2_5.py'), STUB_INFER, 'utf8')
}

async function writeFakeModelDir(name: string, version: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config.yaml'), `version: ${version}\n`, 'utf8')
  await writeFile(join(dir, 'gpt.pth'), '', 'utf8')
  return dir
}

async function readStubLog(): Promise<StubLogEntry[]> {
  try {
    const raw = await readFile(logPath, 'utf8')
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StubLogEntry)
  } catch {
    return []
  }
}

async function waitForStubLog(
  predicate: (entries: StubLogEntry[]) => boolean,
  timeoutMs = 10_000
): Promise<StubLogEntry[]> {
  const startedAt = Date.now()
  for (;;) {
    const entries = await readStubLog()
    if (predicate(entries)) return entries
    if (Date.now() - startedAt > timeoutMs) return entries
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function engineTempDirs(): Promise<Set<string>> {
  const entries = await readdir(tmpdir())
  return new Set(entries.filter((name) => name.startsWith(ENGINE_TEMP_PREFIX)))
}

function inputFor(overrides: Partial<IndexTtsSynthesizeInput>): IndexTtsSynthesizeInput {
  return {
    projectId: 'p1',
    nodeId: 'n1',
    text: '你好，这是本地语音合成回归文本。',
    referenceAudioPath: join(root, 'reference.wav'),
    pythonPath,
    ...overrides
  }
}

const describeWithPython = pythonPath ? describe : describe.skip

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  root = await mkdtemp(join(tmpdir(), 'indextts-engine-test-'))
  dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  h.dataDir = dataDir
  database = new DatabaseSync(':memory:')
  h.database = database
  migrateDatabase({
    exec: (sql) => database.exec(sql),
    pragma: (statement, options) =>
      options?.simple
        ? Number(
            (database.prepare(`PRAGMA ${statement}`).get() as { user_version: number }).user_version
          )
        : database.exec(`PRAGMA ${statement}`)
  })

  await writeStubPackage()
  scanRoot = join(root, 'scan')
  await mkdir(scanRoot, { recursive: true })
  logPath = join(root, 'stub-log.jsonl')
  modelCliDir = await writeFakeModelDir('model-cli', '2.0')
  modelV25Dir = await writeFakeModelDir('model-2.5', '2.5')
  await writeFile(inputFor({}).referenceAudioPath, 'RIFF-fake-reference', 'utf8')
})

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  database?.close()
  if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

beforeEach(async () => {
  process.env.PYTHONPATH = stubRoot
  process.env.INDEXTTS_TEST_LOG = logPath
  process.env.INDEXTTS_TEST_MODE = 'success'
  process.env.INDEXTTS_TEST_CLI = 'success'
  process.env.CANVAS_STUDIO_INDEXTTS_SCAN_ROOTS = scanRoot
  delete process.env.CANVAS_STUDIO_INDEXTTS_PYTHON
  delete process.env.CANVAS_STUDIO_INDEXTTS_MODEL_DIR
  await writeFile(logPath, '', 'utf8')
})

describe('buildIndexTtsArgs', () => {
  const runtime = {
    pythonPath: '/python',
    modelDir: '/model',
    textFilePath: '/t.txt',
    outputPath: '/o.wav'
  }

  it('默认 cuda + fp16：文本走 --text-file，参考音频直接传，--force 覆盖输出', () => {
    const args = buildIndexTtsArgs(inputFor({}), runtime)
    expect(args).toEqual([
      '-m',
      'indextts.cli_v2',
      'synth',
      '--text-file',
      '/t.txt',
      '--voice',
      inputFor({}).referenceAudioPath,
      '--output',
      '/o.wav',
      '--model-dir',
      '/model',
      '--device',
      'cuda',
      '--force',
      '--fp16'
    ])
  })

  it('显式 cpu 去掉 --fp16；显式 fp16=false 也不传', () => {
    const cpuArgs = buildIndexTtsArgs(inputFor({ device: 'cpu', fp16: true }), runtime)
    expect(cpuArgs).toContain('cpu')
    expect(cpuArgs).not.toContain('--fp16')
    expect(buildIndexTtsArgs(inputFor({ fp16: false }), runtime)).not.toContain('--fp16')
  })
})

describeWithPython('detectIndexTts 运行时探测', () => {
  it('显式解释器 + 有效模型目录：ready 且路径原样返回（不依赖真实权重）', async () => {
    const runtime = await detectIndexTts({ pythonPath, modelDir: modelV25Dir })
    expect(runtime).toEqual({
      ready: true,
      pythonPath,
      modelDir: modelV25Dir,
      reason: null
    })
  })

  it('显式解释器不存在：返回可操作的中文原因，不抛错', async () => {
    delete process.env.PYTHONPATH
    const missing = join(root, 'missing-python.exe')
    const runtime = await detectIndexTts({ pythonPath: missing })
    expect(runtime.ready).toBe(false)
    expect(runtime.modelDir).toBeNull()
    expect(runtime.reason).toMatch(/IndexTTS|indextts/)
  })

  it('解释器可用但没有模型目录：reason 指向模型目录', async () => {
    const emptyModel = join(root, 'model-empty')
    await mkdir(emptyModel, { recursive: true })
    const runtime = await detectIndexTts({ pythonPath, modelDir: emptyModel })
    expect(runtime.ready).toBe(false)
    expect(runtime.pythonPath).toBe(pythonPath)
    expect(runtime.modelDir).toBeNull()
    expect(runtime.reason).toContain('模型目录')
  })

  it('扫描候选目录能找到 ComfyUI/models/IndexTTS2.5（不依赖真实安装）', async () => {
    delete process.env.PYTHONPATH
    const scanModel = join(scanRoot, 'ComfyUI', 'models', 'IndexTTS2.5')
    await mkdir(scanModel, { recursive: true })
    await writeFile(join(scanModel, 'config.yaml'), 'version: 2.5\n', 'utf8')
    await writeFile(join(scanModel, 's2mel.pth'), '', 'utf8')
    process.env.CANVAS_STUDIO_INDEXTTS_SCAN_ROOTS = scanRoot
    const runtime = await detectIndexTts()
    expect(runtime.modelDir).toBe(scanModel)
    if (!runtime.ready) expect(runtime.reason).toBeTruthy()
  })

  // 真机自检：本机确实装了 IndexTTS 时（例如开发机）才跑，不进入常规 CI。
  // 运行：CANVAS_INDEXTTS_REAL=1 node scripts/run-vitest.cjs run test/indextts-engine.test.ts
  it.runIf(process.env.CANVAS_INDEXTTS_REAL === '1')(
    '本机真实环境：能探测到解释器与 IndexTTS 2.5 模型目录',
    async () => {
      delete process.env.CANVAS_STUDIO_INDEXTTS_SCAN_ROOTS
      delete process.env.PYTHONPATH
      const runtime = await detectIndexTts()
      console.log('[real] IndexTTS runtime =', JSON.stringify(runtime))
      expect(runtime.ready, runtime.reason ?? '').toBe(true)
      expect(runtime.pythonPath).toBeTruthy()
      expect(runtime.modelDir).toBeTruthy()
    },
    180_000
  )
})

describeWithPython('synthesizeWithIndexTts', () => {
  it('CLI 路径成功：文本写入临时文件、产物登记进项目媒体目录、时长从 wav 头解析', async () => {
    const before = await engineTempDirs()
    const input = inputFor({ modelDir: modelCliDir })
    const result = await synthesizeWithIndexTts(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.asset.kind).toBe('audio')
    expect(result.asset.mime).toBe('audio/wav')
    expect(result.asset.path.startsWith('projects/p1/media/')).toBe(true)
    expect(result.asset.name?.startsWith('本地TTS-')).toBe(true)
    expect(result.durationMs).toBe(500)
    // 产物已落项目媒体目录（saveFileAsset 的 rename 目标）。
    const saved = await readFile(join(dataDir, result.asset.path))
    expect(saved.length).toBeGreaterThan(0)

    const entries = await readStubLog()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('cli')
    expect(entries[0].payload.text).toBe(input.text)
    expect(entries[0].payload.voice).toBe(input.referenceAudioPath)
    expect(entries[0].payload.modelDir).toBe(modelCliDir)
    expect(entries[0].payload.device).toBe('cuda')
    expect(entries[0].payload.fp16).toBe(true)
    expect(entries[0].argv).toContain('--force')

    const after = await engineTempDirs()
    expect([...after].filter((name) => !before.has(name))).toEqual([])
  })

  it('2.5 模型：CLI 被旧 bpe 清单误杀后自动回退 infer_v2_5，传 lang/duration_factor', async () => {
    process.env.INDEXTTS_TEST_CLI = 'missing-bpe'
    const input = inputFor({
      modelDir: modelV25Dir,
      lang: 'EN',
      durationFactor: 1.4,
      device: 'cuda'
    })
    const result = await synthesizeWithIndexTts(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.durationMs).toBe(1000)

    const entries = await readStubLog()
    expect(entries.map((entry) => entry.kind)).toEqual(['cli', 'direct'])
    const direct = entries[1].payload
    expect(direct.lang).toBe('EN')
    expect(direct.durationFactor).toBe(1.4)
    expect(direct.useBf16).toBe(true)
    expect(direct.device).toBe('cuda')
    expect(direct.modelDir).toBe(modelV25Dir)
    expect(direct.text).toBe(input.text)
  })

  it('2.0 模型 CLI 失败：分类为普通失败，reason 不含用户正文', async () => {
    process.env.INDEXTTS_TEST_MODE = 'fail'
    const privateText = '私密正文ABC这段内容绝不能出现在失败原因里'
    const result = await synthesizeWithIndexTts(
      inputFor({ modelDir: modelCliDir, text: privateText })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missingRuntime).toBe(false)
    expect(result.reason).toContain('indextts')
    expect(result.reason).not.toContain(privateText)
  })

  it('2.5 回退也失败：返回 infer 失败分类，missingRuntime=false', async () => {
    process.env.INDEXTTS_TEST_CLI = 'missing-bpe'
    process.env.INDEXTTS_TEST_MODE = 'fail'
    const result = await synthesizeWithIndexTts(inputFor({ modelDir: modelV25Dir }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missingRuntime).toBe(false)
    expect(result.reason).toContain('indextts')
    expect(result.reason).toContain('simulated inference failure')
  })

  it('取消：子进程被 kill，返回「已取消」且临时目录清理', async () => {
    process.env.INDEXTTS_TEST_MODE = 'cancel'
    const before = await engineTempDirs()
    const key = 'cancel-project/cancel-node'
    const pending = runWithMediaScope(key, () =>
      synthesizeWithIndexTts(
        inputFor({ projectId: 'cancel-project', nodeId: 'cancel-node', modelDir: modelCliDir })
      )
    )
    const started = await waitForStubLog((entries) => entries.length > 0)
    expect(started.length).toBeGreaterThan(0)
    expect(cancelMediaJobs(key)).toBeGreaterThan(0)
    const result = await pending
    expect(result).toEqual({ ok: false, reason: '已取消', missingRuntime: false })

    const after = await engineTempDirs()
    expect([...after].filter((name) => !before.has(name))).toEqual([])
  })

  it('空文本 / 参考音频不存在：直接返回可操作原因，不启动进程', async () => {
    const empty = await synthesizeWithIndexTts(inputFor({ text: '   ' }))
    expect(empty).toEqual({
      ok: false,
      reason: expect.stringContaining('朗读文本为空'),
      missingRuntime: false
    })
    const missingRef = await synthesizeWithIndexTts(
      inputFor({ referenceAudioPath: join(root, 'no-such.wav') })
    )
    expect(missingRef.ok).toBe(false)
    if (missingRef.ok) return
    expect(missingRef.reason).toContain('参考音频')
    expect(await readStubLog()).toHaveLength(0)
  })
})
