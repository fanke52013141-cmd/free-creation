// F8：多画布按项目锁并发。
//
// 目标语义：
// 1) 同一项目的写入仍严格串行（RESOURCE_BUSY）；
// 2) 不同项目的写入不再互相阻塞（改造前是全局单 mutating 标志）；
// 3) 没有 projectId 的写入（技能安装/包导入导出/资源库全局写）保持全局独占；
// 4) project.open 这类改变"应用级活动画布"的操作仍用全局锁；
// 5) 异常路径必须释放锁，不能把该项目后续写入永久堵死。
//
// 测试手法：用一个可控桌面宿主把 project.save / project.open 的握手悬住，
// 在"写操作确实在飞"的时刻发起其他写操作，从而确定性地观察锁行为（不依赖时间竞态）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDataDir } from '../src/main/store/db'
import { createProject, getProject, openProject } from '../src/main/store/projects.repo'
import { listMedia } from '../src/main/store/media.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { DesktopAccessError, type AccessDesktop } from '../src/main/agent-access/desktop'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory: string
let service: LocalAccessService
let active: string | null
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gAB3x0dAAAAAElFTkSuQmCC',
  'base64'
)

function call(operationId: string, input: unknown = {}, idempotencyKey?: string) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    ...(idempotencyKey ? { idempotencyKey } : {})
  })
}

/** 可在"写操作在飞"时卡住、由测试决定何时放行的桌面宿主替身。 */
function heldDesktop(holdActions: string[], options: { failWith?: string } = {}) {
  const state: {
    held: Map<string, { waiters: Array<() => void> }>
    entered: Set<string>
    calls: string[]
    fail: boolean
  } = { held: new Map(), entered: new Set(), calls: [], fail: false }
  let enteredWaiter: (() => void) | null = null
  const desktop: AccessDesktop = {
    async run(request, commit) {
      state.calls.push(request.action)
      const shouldHold = holdActions.includes(request.action)
      if (shouldHold) {
        state.entered.add(request.action)
        enteredWaiter?.()
        await new Promise<void>((resolve) => {
          state.held.set(request.action, { waiters: [...(state.held.get(request.action)?.waiters ?? []), resolve] })
        })
      }
      if (state.fail) throw new DesktopAccessError(options.failWith ?? 'DESKTOP_REJECTED', false)
      const file = openProject(String(request.projectId))
      if (commit && file) commit(file.meta.graphVersion)
      // 与真实桌面一致：open 握手成功后应用的活动画布才切换。
      if (request.action === 'open') active = String(request.projectId)
      return { graphVersion: file?.meta.graphVersion ?? 0 }
    },
    async ask() {
      return { authorized: false, code: 'NOT_USED_IN_TEST' }
    }
  }
  return {
    desktop,
    state,
    waitEntered(action: string): Promise<void> {
      if (state.entered.has(action)) return Promise.resolve()
      return new Promise<void>((resolve) => {
        enteredWaiter = () => {
          if (state.entered.has(action)) resolve()
        }
      })
    },
    release(action: string): void {
      const entry = state.held.get(action)
      state.held.delete(action)
      for (const waiter of entry?.waiters ?? []) waiter()
    }
  }
}

function withDesktop(desktop: AccessDesktop | undefined): void {
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active,
    desktop
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-concurrency-test-'))
  process.env.CANVAS_DATA_DIR = directory
  writeFileSync(join(directory, 'import-a.png'), PNG_1X1)
  writeFileSync(join(directory, 'import-b.png'), PNG_1X1)
  active = null
  setGatewayEventSink({ emit: () => undefined })
})

afterEach(() => {
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('按项目写入锁', () => {
  it('同一项目写入仍串行；不同项目不再互相阻塞；无项目写入保持全局独占', async () => {
    const projectA = createProject('并发-A')
    const projectB = createProject('并发-B')
    active = projectA.id
    const harness = heldDesktop(['flush'])
    withDesktop(harness.desktop)

    // 让 A 的保存卡在桌面 flush 上：此时 A 项目的写入锁在飞。
    const savingA = call(
      'project.save',
      { projectId: projectA.id, expectedGraphVersion: getProject(projectA.id)!.graphVersion },
      key()
    )
    await harness.waitEntered('flush')

    // 同一项目：仍必须 RESOURCE_BUSY（串行语义不变）。
    const sameProject = await call(
      'media.import',
      { projectId: projectA.id, filePath: join(directory, 'import-a.png') },
      key()
    )
    expect(sameProject.status).toBe('failed')
    expect(sameProject.error?.code).toBe('RESOURCE_BUSY')

    // 没有 projectId 的写入：全局独占语义不变。
    const globalWrite = await call(
      'skill.install',
      { sourcePath: join(directory, 'skill.md'), name: '并发测试技能' },
      key()
    )
    expect(globalWrite.status).toBe('failed')
    expect(globalWrite.error?.code).toBe('RESOURCE_BUSY')

    // 不同项目：不再被 A 的保存挡住，必须真正完成。
    const otherProject = await call(
      'media.import',
      { projectId: projectB.id, filePath: join(directory, 'import-b.png') },
      key()
    )
    expect(otherProject.status, JSON.stringify(otherProject.error)).toBe('completed')
    expect(listMedia(projectB.id)).toHaveLength(1)
    expect(listMedia(projectA.id)).toHaveLength(0)

    harness.release('flush')
    const saved = await savingA
    expect(saved.status, JSON.stringify(saved.error)).toBe('completed')
  })

  it('全局锁操作（project.open）在飞时，项目写入被挡住', async () => {
    const projectA = createProject('并发-打开A')
    const projectB = createProject('并发-打开B')
    active = projectA.id
    const harness = heldDesktop(['open'])
    withDesktop(harness.desktop)
    const opening = call('project.open', { projectId: projectB.id }, key())
    await harness.waitEntered('open')
    const blocked = await call(
      'media.import',
      { projectId: projectA.id, filePath: join(directory, 'import-a.png') },
      key()
    )
    expect(blocked.status).toBe('failed')
    expect(blocked.error?.code).toBe('RESOURCE_BUSY')
    harness.release('open')
    const opened = await opening
    expect(opened.status, JSON.stringify(opened.error)).toBe('completed')
    const after = await call(
      'media.import',
      { projectId: projectA.id, filePath: join(directory, 'import-a.png') },
      key()
    )
    expect(after.status, JSON.stringify(after.error)).toBe('completed')
  })

  it('写操作失败后锁必须释放，同一项目可以再次写入', async () => {
    const projectA = createProject('并发-失败释放')
    active = projectA.id
    const harness = heldDesktop(['flush'], { failWith: 'DESKTOP_REJECTED' })
    withDesktop(harness.desktop)
    const failing = call(
      'project.save',
      { projectId: projectA.id, expectedGraphVersion: getProject(projectA.id)!.graphVersion },
      key()
    )
    await harness.waitEntered('flush')
    harness.state.fail = true
    harness.release('flush')
    const failed = await failing
    expect(failed.status).toBe('failed')
    // 同一项目下一次写入不能被"泄漏的锁"永久堵住。
    const retried = await call(
      'media.import',
      { projectId: projectA.id, filePath: join(directory, 'import-a.png') },
      key()
    )
    expect(retried.status, JSON.stringify(retried.error)).toBe('completed')
    expect(listMedia(projectA.id)).toHaveLength(1)
  })

  it('两个项目并发导入媒体：都完成且各自归属正确（无锁泄漏、无跨项目串用）', async () => {
    const projectA = createProject('并发-并行A')
    const projectB = createProject('并发-并行B')
    active = projectA.id
    withDesktop(undefined)
    const results = await Promise.all([
      call('media.import', { projectId: projectA.id, filePath: join(directory, 'import-a.png') }, key()),
      call('media.import', { projectId: projectB.id, filePath: join(directory, 'import-b.png') }, key())
    ])
    for (const result of results) expect(result.status, JSON.stringify(result.error)).toBe('completed')
    expect(listMedia(projectA.id)).toHaveLength(1)
    expect(listMedia(projectB.id)).toHaveLength(1)
    // 串用检查：A 的媒体路径必须落在 A 的目录下。
    for (const asset of listMedia(projectA.id))
      expect(asset.path.startsWith(`projects/${projectA.id}/media/`)).toBe(true)
    for (const asset of listMedia(projectB.id))
      expect(asset.path.startsWith(`projects/${projectB.id}/media/`)).toBe(true)
  })
})
