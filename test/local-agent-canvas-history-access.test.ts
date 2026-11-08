// F2：撤销/重做 + 关闭项目的验收。
//
// 断言重点（都是"假成功"的高发区）：
// 1) 两个操作只作用于**当前打开**的画布——对没打开的项目必须拒绝，不能"以为发生了"；
// 2) 撤销/重做必须把期望版本透传给权威宿主，版本不符如实 REVISION_CONFLICT；
// 3) 关闭项目成功后才清 lastProjectId（半途失败不能把"上次打开"也清掉）；
// 4) 宿主不可用（DESKTOP_UNAVAILABLE）如实失败，不降级成本地替身。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDataDir, getSetting } from '../src/main/store/db'
import { createProject } from '../src/main/store/projects.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { DesktopAccessError, type AccessDesktop } from '../src/main/agent-access/desktop'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory: string
let service: LocalAccessService
let active: string | null
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

function write(operationId: string, input: unknown, idempotencyKey = key()) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    idempotencyKey
  })
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

function desktopStub(options: {
  graphVersion?: number
  failWith?: string
  rejectUnknown?: boolean
}): { desktop: AccessDesktop; calls: Array<{ action: string; direction?: string }> } {
  const calls: Array<{ action: string; direction?: string }> = []
  const desktop: AccessDesktop = {
    async run(request) {
      const typed = request as { action: string; direction?: string }
      calls.push({ action: typed.action, direction: typed.direction })
      if (options.failWith)
        throw new DesktopAccessError(options.failWith, options.rejectUnknown === true)
      return { graphVersion: options.graphVersion ?? 1 }
    },
    async ask() {
      return { authorized: false, code: 'NOT_USED' }
    }
  }
  return { desktop, calls }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-history-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  setGatewayEventSink({ emit: () => undefined })
})

afterEach(() => {
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('canvas.history 撤销/重做', () => {
  it('对未打开的画布拒绝（不能撤销一个没打开的图）', async () => {
    const project = createProject('历史-未打开')
    withDesktop(desktopStub({ graphVersion: 3 }).desktop)
    const response = await write('canvas.history', {
      projectId: project.id,
      expectedGraphVersion: 1,
      direction: 'undo'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('ACTIVE_PROJECT_REQUIRED')
  })

  it('把方向与期望版本透传给权威宿主，并返回宿主报告的图版本', async () => {
    const project = createProject('历史-正常')
    active = project.id
    const stub = desktopStub({ graphVersion: 7 })
    withDesktop(stub.desktop)
    const response = await write('canvas.history', {
      projectId: project.id,
      expectedGraphVersion: 6,
      direction: 'undo'
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    expect((response.data as { graphVersion: number }).graphVersion).toBe(7)
    expect((response.data as { direction: string }).direction).toBe('undo')
    expect(stub.calls).toEqual([{ action: 'history', direction: 'undo' }])

    const redo = await write('canvas.history', {
      projectId: project.id,
      expectedGraphVersion: 7,
      direction: 'redo'
    })
    expect(redo.status).toBe('completed')
    expect(stub.calls.at(-1)).toEqual({ action: 'history', direction: 'redo' })
  })

  it('宿主拒绝时如实失败；未知结果不被说成成功', async () => {
    const project = createProject('历史-宿主失败')
    active = project.id
    withDesktop(desktopStub({ failWith: 'REVISION_CONFLICT' }).desktop)
    const rejected = await write('canvas.history', {
      projectId: project.id,
      expectedGraphVersion: 1,
      direction: 'undo'
    })
    expect(rejected.status).toBe('failed')
    expect(rejected.error?.code).toBe('REVISION_CONFLICT')

    // unknownOutcome=true：准入后失联，不能表述成"没发生过"
    withDesktop(desktopStub({ failWith: 'DESKTOP_LOST', rejectUnknown: true }).desktop)
    const unknown = await write('canvas.history', {
      projectId: project.id,
      expectedGraphVersion: 1,
      direction: 'redo'
    })
    expect(unknown.status).toBe('unknown')
    expect(unknown.error?.code).toBe('OUTCOME_UNKNOWN')
  })

  it('非法方向被 Schema 拒绝', async () => {
    const project = createProject('历史-非法方向')
    active = project.id
    withDesktop(desktopStub({ graphVersion: 1 }).desktop)
    const response = await write('canvas.history', {
      projectId: project.id,
      expectedGraphVersion: 1,
      direction: 'rewind'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('INVALID_INPUT')
  })
})

describe('project.close 关闭项目', () => {
  it('对未打开的画布拒绝（不能关一个没开的项目）', async () => {
    const project = createProject('关闭-未打开')
    withDesktop(desktopStub({ graphVersion: 1 }).desktop)
    const response = await write('project.close', { projectId: project.id })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('ACTIVE_PROJECT_REQUIRED')
  })

  it('成功后清 lastProjectId（下次启动不再自动打开）', async () => {
    const project = createProject('关闭-成功')
    active = project.id
    const stub = desktopStub({ graphVersion: 2 })
    withDesktop(stub.desktop)
    // 模拟"上次打开"状态
    const { setSetting } = await import('../src/main/store/db')
    setSetting('lastProjectId', project.id)
    expect(getSetting('lastProjectId')).toBe(project.id)

    const response = await write('project.close', { projectId: project.id })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    expect((response.data as { closed: boolean }).closed).toBe(true)
    expect(getSetting('lastProjectId')).toBe('')
    expect(stub.calls).toEqual([{ action: 'close-project', direction: undefined }])
  })

  it('宿主失败时不清 lastProjectId（半途失败不能伪装成已关闭）', async () => {
    const project = createProject('关闭-失败')
    active = project.id
    withDesktop(desktopStub({ failWith: 'DESKTOP_TIMEOUT' }).desktop)
    const { setSetting } = await import('../src/main/store/db')
    setSetting('lastProjectId', project.id)

    const response = await write('project.close', { projectId: project.id })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('DESKTOP_TIMEOUT')
    expect(getSetting('lastProjectId')).toBe(project.id)
  })
})
