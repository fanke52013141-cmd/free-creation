/**
 * F02/F03 回归测试：关窗同步保存保留乐观锁并透传结果信封
 * （HANDOFF_2026_09_15_CODE_REVIEW）
 *
 * 缺陷背景：
 *  - F02（CanvasEditor.beforeunload）：关窗保存剥离 expectedGraphVersion，
 *    Agent 在关窗前一刻写入的数据会被当前视图静默覆盖。
 *  - F03（preload.saveProjectSync）：sendSync 的返回值被丢弃，主进程的失败
 *    信封（冲突/写锁/磁盘错误）被静默吞掉，调用方无法感知落盘失败。
 *  - 配套（project.ipc saveSync）：主进程曾把成功结果固化为 { ok:true, data:null }、
 *    失败统一编码为 FLUSH_FAILED，与异步 save 的信封语义不一致。
 *
 * 修复语义：
 *  - 主进程 saveSync 原样透传 expectedGraphVersion，冲突返回 REVISION_CONFLICT，
 *    成功返回 { ok:true, data:{ graphVersion } }。
 *  - preload.saveProjectSync 返回 IpcEnvelope。
 *  - 渲染层 beforeunload 携带乐观锁；冲突时降级为一次无锁强制保存（关窗场景
 *    无法重载，最后视图胜出），其他失败记录 console.error。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ── 指示器与 electron mock ─────────────────────────────────

const ipcState = vi.hoisted(() => ({
  handler: null as ((e: unknown, input: unknown) => void) | null,
  sendSyncPayload: null as unknown,
  projectsDir: ''
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: (_channel: string, handler: (e: unknown, input: unknown) => void) => {
      ipcState.handler = handler
    },
    handle: () => undefined
  },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }
}))

vi.mock('../src/main/ipc/project-watcher', () => ({
  ProjectFileWatcher: class {
    notifySelfSave(): void {
      /* 测试桩：记录由断言接管 */
    }
    startWatching(): void {
      /* 测试桩 */
    }
    stopWatching(): void {
      /* 测试桩 */
    }
  }
}))

vi.mock('../src/main/store/db', () => ({
  getSetting: () => null,
  setSetting: () => undefined,
  getProjectsDir: () => ipcState.projectsDir,
  getDb: () => ({
    prepare: () => ({ run: () => ({ changes: 1 }), get: () => undefined, all: () => [] })
  })
}))

// saveProject 用真实 fs 模拟（读文件→校验版本→写回），聚焦 IPC 信封语义；
// repo 内部事务细节已由 save-transaction-rollback.test.ts 与 F01 覆盖。
vi.mock('../src/main/store/projects.repo', async () => {
  const { GraphVersionConflictError } = await import('../src/shared/graph-snapshot-sync')
  return {
    saveProject: (input: { id: string; expectedGraphVersion?: number }) => {
      const path = join(ipcState.projectsDir, input.id, 'project.json')
      const file = JSON.parse(readFileSync(path, 'utf-8')) as {
        meta: { graphVersion: number }
      }
      if (
        input.expectedGraphVersion !== undefined &&
        file.meta.graphVersion !== input.expectedGraphVersion
      ) {
        throw new GraphVersionConflictError(input.expectedGraphVersion, file.meta.graphVersion)
      }
      const next = file.meta.graphVersion + 1
      file.meta.graphVersion = next
      writeFileSync(path, JSON.stringify(file, null, 2), 'utf-8')
      return { graphVersion: next }
    }
  }
})

vi.mock('../src/main/store/transfer', () => ({
  exportProject: () => '',
  importProject: () => ({})
}))

import { registerProjectIpc } from '../src/main/ipc/project.ipc'
import { GraphVersionConflictError } from '../src/shared/graph-snapshot-sync'

let root = ''

function makeEvent(): { returnValue: unknown } {
  return { returnValue: undefined }
}

/** 在临时目录写一个 graphVersion=version 的项目文件 */
function seedProject(id: string, version: number): void {
  const dir = join(ipcState.projectsDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify(
      {
        version: 1,
        meta: { id, name: 't', createdAt: 0, updatedAt: 0, graphVersion: version },
        nodes: [],
        edges: [],
        groups: []
      },
      null,
      2
    )
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canvas-save-sync-'))
  ipcState.projectsDir = join(root, 'projects')
  mkdirSync(ipcState.projectsDir, { recursive: true })
  ipcState.handler = null
  ipcState.sendSyncPayload = null
  registerProjectIpc()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ── 主进程 saveSync 信封语义（F03 主进程侧） ───────────────

describe('project.ipc saveSync 信封语义', () => {
  it('成功时返回 { ok:true, data:{ graphVersion } } 而非 data:null', () => {
    seedProject('p1', 1)
    const e = makeEvent()
    ipcState.handler!(e, { id: 'p1', expectedGraphVersion: 1 })
    expect(e.returnValue).toEqual({ ok: true, data: { graphVersion: 2 } })
  })

  it('expectedGraphVersion 冲突时返回 REVISION_CONFLICT（原先统一为 FLUSH_FAILED）', () => {
    seedProject('p1', 5)
    const e = makeEvent()
    ipcState.handler!(e, { id: 'p1', expectedGraphVersion: 1 })
    expect(e.returnValue).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })
  })

  it('expectedGraphVersion 为 undefined 时不做乐观锁校验（兼容降级保存）', () => {
    seedProject('p1', 5)
    const e = makeEvent()
    ipcState.handler!(e, { id: 'p1', expectedGraphVersion: undefined })
    expect(e.returnValue).toEqual({ ok: true, data: { graphVersion: 6 } })
  })

  it('通用错误返回 SAVE_FAILED 且消息可读', () => {
    // 项目文件不存在 → readFileSync 抛错 → SAVE_FAILED
    const e = makeEvent()
    ipcState.handler!(e, { id: 'missing' })
    expect(e.returnValue).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } })
    expect((e.returnValue as { error: { message: string } }).error.message).toBeTruthy()
  })
})

// ── preload.saveProjectSync 透传（F03 preload 侧 + F02 参数保真） ──

describe('preload.saveProjectSync 透传', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('sendSync 的返回值原样返回，expectedGraphVersion 不被剥离', async () => {
    const reply = { ok: true, data: { graphVersion: 7 } }
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: () => undefined },
      ipcRenderer: {
        sendSync: (_channel: string, input: unknown) => {
          ipcState.sendSyncPayload = input
          return reply
        },
        invoke: vi.fn(),
        on: () => undefined,
        off: () => undefined
      },
      webUtils: { getPathForFile: () => '' }
    }))
    vi.doMock('@electron-toolkit/preload', () => ({ electronAPI: {} }))
    // preload 顶层访问 process.contextIsolated / window，Node 环境补齐；
    // contextIsolated=false 时走 window.api = api 分支，可从全局拿 api。
    const g = globalThis as unknown as Record<string, unknown>
    const savedProcess = g.process
    const savedWindow = g.window
    g.process = { contextIsolated: false, env: { NODE_ENV: 'test' } }
    g.window = {}
    try {
      await import('../src/preload/index')
      const api = (g.window as { api: { saveProjectSync: (i: unknown) => unknown } }).api
      const result = api.saveProjectSync({ id: 'p1', expectedGraphVersion: 6 })
      expect(result).toEqual(reply)
      // F02 回归：渲染层传入的 expectedGraphVersion 必须原样到达主进程通道
      expect(ipcState.sendSyncPayload).toMatchObject({ id: 'p1', expectedGraphVersion: 6 })
    } finally {
      g.process = savedProcess
      g.window = savedWindow
    }
  })
})

// ── 冲突错误类型（主进程 instanceof 映射依赖） ─────────────

describe('冲突错误类型', () => {
  it('GraphVersionConflictError 实例可被 instanceof 识别', () => {
    const e = new GraphVersionConflictError(1, 2)
    expect(e instanceof GraphVersionConflictError).toBe(true)
    expect(e.message).toContain('1')
    expect(e.message).toContain('2')
  })
})
