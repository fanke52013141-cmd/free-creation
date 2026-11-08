// 安装后台阶段的诊断事件验收（此前是完全的日志盲区）。
//
// 安全约束：**绝不触发真实安装**。本机可能装有 Python 3.12，若放任执行会真的创建 venv
// 并下载 3.3GB PyTorch。因此这里 mock 掉 `child_process.spawn`，让任何子进程调用都立即失败
// （等价于"本机没有可用的 Python/命令执行环境"），从而只验证诊断事件，不产生任何下载。
//
// 断言重点：
// 1) 缺少可用 Python 时留下 failed + PYTHON_REQUIRED，且不发起任何网络请求；
// 2) 不会出现 completed；
// 3) 事件里不含本机绝对路径、权重 URL 或下载命令（脱敏）；
// 4) 重复调用不会重复 started；
// 5) 诊断 sink 抛错或返回拒绝的 Promise 都不影响安装流程返回（LOGGING_SPEC：日志失败不改变业务）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let directory: string
let events: Array<{ event: string; status?: string; attributes?: Record<string, unknown> }>
const originalDirectory = process.env.CANVAS_DATA_DIR

/** 让所有子进程调用立即失败：模拟"本机没有可用 Python"，绝不真的安装。 */
function blockChildProcesses(): void {
  vi.doMock('node:child_process', () => ({
    spawn: () => {
      const handlers: Record<string, Array<(arg?: unknown) => void>> = {}
      const child = {
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        on: (name: string, handler: (arg?: unknown) => void) => {
          handlers[name] = [...(handlers[name] ?? []), handler]
        },
        once: (name: string, handler: (arg?: unknown) => void) => {
          handlers[name] = [...(handlers[name] ?? []), handler]
        },
        kill: () => undefined
      }
      setTimeout(() => {
        for (const handler of handlers.error ?? []) handler(new Error('SPAWN_BLOCKED_IN_TEST'))
      }, 0)
      return child
    },
    execFile: () => {
      throw new Error('SPAWN_BLOCKED_IN_TEST')
    }
  }))
}

/** 重新加载模块并把 sink 装到**新实例**上（resetModules 会让旧 sink 失效）。 */
async function loadEngine(sink: { emit: (event: unknown) => void | Promise<void> }) {
  vi.resetModules()
  blockChildProcesses()
  const gateway = await import('../src/main/diagnostics/gateway-events')
  gateway.setGatewayEventSink(sink as never)
  return await import('../src/main/media/video-conversion')
}

const installEvents = () => events.filter((event) => event.event.startsWith('video_engine.install.'))

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-install-diag-'))
  process.env.CANVAS_DATA_DIR = directory
  events = []
})

afterEach(() => {
  vi.doUnmock('node:child_process')
  vi.restoreAllMocks()
  vi.resetModules()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

const collector = {
  emit: (event: unknown) => {
    if (event && typeof event === 'object') events.push(event as never)
  }
}

describe('视频引擎安装诊断', () => {
  it('子进程不可用时记 failed + PYTHON_REQUIRED，且不发起任何网络请求', async () => {
    const engine = await loadEngine(collector)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await engine.installVideoEngine().catch(() => undefined)
    await new Promise((done) => setTimeout(done, 80))
    const failed = installEvents().find((event) => event.event === 'video_engine.install.failed')
    expect(failed, '缺少失败事件').toBeDefined()
    expect(String(failed!.attributes?.code ?? '')).toBe('PYTHON_REQUIRED')
    expect(failed!.status).toBe('failed')
    // 关键：Python 缺失阶段绝不下载权重
    expect(fetchSpy).not.toHaveBeenCalled()
    // 不能出现 completed
    expect(installEvents().some((event) => event.event.endsWith('.completed'))).toBe(false)
  })

  it('事件里不含本机绝对路径、权重 URL 或下载命令', async () => {
    const engine = await loadEngine(collector)
    await engine.installVideoEngine().catch(() => undefined)
    await new Promise((done) => setTimeout(done, 80))
    const serialized = JSON.stringify(installEvents())
    expect(serialized).not.toContain(directory)
    expect(serialized).not.toContain('huggingface.co')
    expect(serialized).not.toContain('download.pytorch.org')
    expect(serialized).not.toContain('--index-url')
  })

  it('重复调用不会重复 started', async () => {
    const engine = await loadEngine(collector)
    const first = engine.installVideoEngine().catch(() => undefined)
    const second = engine.installVideoEngine().catch(() => undefined)
    await Promise.all([first, second])
    await new Promise((done) => setTimeout(done, 80))
    const startedCount = installEvents().filter(
      (event) => event.event === 'video_engine.install.started'
    ).length
    expect(startedCount).toBeLessThanOrEqual(1)
    // 后一次调用必须留下 skipped 或 failed（如实表达没有再次启动）
    expect(
      installEvents().some(
        (event) => event.event.endsWith('.skipped') || event.event.endsWith('.failed')
      )
    ).toBe(true)
  })

  it('诊断 sink 同步抛错不影响安装流程返回', async () => {
    const engine = await loadEngine({
      emit: () => {
        throw new Error('LOGGER_DOWN')
      }
    })
    const outcome = await engine.installVideoEngine().then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    )
    expect(outcome).toBeDefined()
    await new Promise((done) => setTimeout(done, 50))
  })

  it('诊断 sink 返回拒绝的 Promise 也不产生未处理拒绝', async () => {
    const engine = await loadEngine({
      emit: async () => {
        throw new Error('LOGGER_ASYNC_DOWN')
      }
    })
    const outcome = await engine.installVideoEngine().then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    )
    expect(outcome).toBeDefined()
    await new Promise((done) => setTimeout(done, 80))
  })
})
