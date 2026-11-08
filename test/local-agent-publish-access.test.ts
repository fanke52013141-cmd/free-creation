// F6 收尾：导演台外部发布授权协议测试（director.publish.prepare/status/continue）。
//
// 覆盖：manual-publish 不得由外部伪造（node.execute 仍只读最近一次一致发布记录）、
// 必须由人在 GUI 授权、授权与画布版本绑定、未授权/已拒绝/已过期一律拒绝、
// 执行经权威宿主且保存屏障后核对正式发布记录、幂等重放不重复发布、跨项目不可读。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasNode } from '../src/shared/types'
import { closeDb, getDataDir } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { importMedia } from '../src/main/store/media.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import type { AccessDesktop, DesktopAskResult } from '../src/main/agent-access/desktop'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import {
  createDirectorProject,
  createDirectorPublishRecord,
  parseDirectorProject
} from '../src/shared/director-data'
import { directorExecutor } from '../src/shared/engine/executors/director'
import { readSnapshotShapeMeta } from '../src/shared/agent-access/run-ops'

let directory: string
let service: LocalAccessService
let active: string | null
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

/** 写入类操作必须带幂等键；测试里默认给每个新调用生成一个。 */
const WRITE_OPERATIONS = new Set(['director.publish.prepare', 'director.publish.continue'])

function call(operationId: string, input: unknown = {}, idempotencyKey?: string) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    ...(idempotencyKey
      ? { idempotencyKey }
      : WRITE_OPERATIONS.has(operationId)
        ? { idempotencyKey: key() }
        : {})
  })
}

function directorNode(id: string, config = JSON.stringify(createDirectorProject())): CanvasNode {
  return {
    id: `shape:${id}`,
    type: 'director',
    contractVersion: 3,
    title: `预演${id}`,
    x: 0,
    y: 0,
    w: 360,
    h: 260,
    ports: [],
    params: { config },
    content: { kind: 'empty' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  }
}

function textNode(id: string): CanvasNode {
  return {
    id: `shape:${id}`,
    type: 'text',
    contractVersion: 3,
    title: '文本',
    x: 0,
    y: 0,
    w: 320,
    h: 240,
    ports: [],
    params: { config: '{}' },
    content: { kind: 'text', text: 'hi' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  }
}

function seed(projectId: string, nodes: CanvasNode[]): number {
  const saved = saveProject({ id: projectId, graph: { nodes, edges: [], groups: [] } })
  if (!saved) throw new Error('seed failed')
  return saved.graphVersion
}

/** 1x1 PNG：媒体导入必须是真实文件。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gAB3x0dAAAAAElFTkSuQmCC',
  'base64'
)

interface PublishDesktop {
  desktop: AccessDesktop
  state: {
    asks: Array<Record<string, unknown>>
    publishCalls: number
    decide: ((result: DesktopAskResult) => void) | null
  }
  /** 模拟人在 GUI 上点「允许/拒绝」。 */
  decide(authorized: boolean): Promise<void>
}

/**
 * 模拟权威宿主：
 * - ask：把授权请求交给"人"，由测试显式 decide；
 * - run(director-publish)：像真实 renderer 一样导入受控媒体、写正式发布记录并保存。
 */
function publishDesktop(
  projectId: string,
  mode: 'ok' | 'bad-result' | 'reject' = 'ok'
): PublishDesktop {
  const state: PublishDesktop['state'] = { asks: [], publishCalls: 0, decide: null }
  const desktop: AccessDesktop = {
    async run(request, commit) {
      if (request.action !== 'director-publish') return { graphVersion: 1 }
      state.publishCalls += 1
      const file = openProject(String(request.projectId))
      if (!file) throw new Error('project missing')
      const node = file.nodes.find((candidate) => candidate.id === request.nodeId)
      if (!node) throw new Error('node missing')
      if (commit) commit(file.meta.graphVersion)
      if (mode === 'reject') throw new Error('DESKTOP_REJECTED')
      if (mode === 'bad-result')
        return { graphVersion: file.meta.graphVersion, result: { nope: true } }
      const imported = await importMedia(projectId, join(directory, 'publish-frame.png'))
      if (!imported.ok) throw new Error(imported.reason)
      const project = parseDirectorProject(String(node.params.config ?? ''))
      const shot = project.shots[0]
      const record = createDirectorPublishRecord(project, shot, null, {
        frame: {
          mediaId: imported.asset.id,
          mediaPath: imported.asset.path,
          mime: imported.asset.mime
        }
      })
      // 与真实 renderer 一致：运行事实/发布记录写在 tldraw 快照的 shape meta 里，
      // 不在 project.json 的节点字段上（output.get 也是从快照 meta 投影）。
      const saved = saveProject({
        id: projectId,
        tldrawSnapshot: {
          schema: { schemaVersion: 2, sequences: {} },
          store: { [node.id]: { type: 'node-card', id: node.id, meta: { nodeResult: JSON.stringify(record) } } }
        },
        graph: { nodes: file.nodes, edges: file.edges, groups: file.groups }
      })
      if (!saved) throw new Error('save failed')
      return {
        graphVersion: saved.graphVersion,
        result: {
          mediaId: imported.asset.id,
          mediaPath: imported.asset.path,
          mime: imported.asset.mime,
          shotId: shot.id
        }
      }
    },
    ask(input) {
      state.asks.push(input as Record<string, unknown>)
      return new Promise<DesktopAskResult>((resolve) => {
        state.decide = resolve
      })
    }
  }
  return {
    desktop,
    state,
    async decide(authorized: boolean) {
      if (!state.decide) throw new Error('no pending authorization')
      state.decide({ authorized })
      state.decide = null
      // 等 main 侧 then 回调把授权写进账本。
      await new Promise((resolve) => setTimeout(resolve, 0))
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
  directory = mkdtempSync(join(tmpdir(), 'canvas-publish-access-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  events.length = 0
  writeFileSync(join(directory, 'publish-frame.png'), PNG_1X1)
  setGatewayEventSink({ emit: (event) => void events.push(event) })
})

afterEach(() => {
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('director.publish 授权协议', () => {
  it('没有打开的桌面画布时拒绝申请（发布必须在权威宿主上进行）', async () => {
    const project = createProject('发布-未打开')
    const version = seed(project.id, [directorNode('d1')])
    withDesktop(undefined)
    const prepared = await call('director.publish.prepare', {
      projectId: project.id,
      nodeId: 'shape:d1',
      expectedGraphVersion: version
    })
    expect(prepared.status).toBe('failed')
    expect(prepared.error?.code).toBe('ACTIVE_PROJECT_REQUIRED')
  })

  it('非导演台节点、缺失镜头与过期版本都被明确拒绝', async () => {
    const project = createProject('发布-类型')
    const version = seed(project.id, [directorNode('d1'), textNode('t1')])
    active = project.id
    const mock = publishDesktop(project.id)
    withDesktop(mock.desktop)
    const wrongType = await call('director.publish.prepare', {
      projectId: project.id,
      nodeId: 'shape:t1',
      expectedGraphVersion: version
    })
    expect(wrongType.error?.code).toBe('DIRECTOR_NODE_REQUIRED')

    const badShot = await call('director.publish.prepare', {
      projectId: project.id,
      nodeId: 'shape:d1',
      shotId: 'shot-missing',
      expectedGraphVersion: version
    })
    expect(badShot.error?.code).toBe('SHOT_NOT_FOUND')

    const staleVersion = await call('director.publish.prepare', {
      projectId: project.id,
      nodeId: 'shape:d1',
      expectedGraphVersion: version - 1
    })
    expect(staleVersion.error?.code).toBe('REVISION_CONFLICT')
  })

  it('申请只创建待授权请求：不渲染、不改画布，且把授权交给 GUI 中的人', async () => {
    const project = createProject('发布-申请')
    const version = seed(project.id, [directorNode('d1')])
    active = project.id
    const mock = publishDesktop(project.id)
    withDesktop(mock.desktop)
    const prepared = await call(
      'director.publish.prepare',
      { projectId: project.id, nodeId: 'shape:d1', mode: 'frame', expectedGraphVersion: version },
      key()
    )
    expect(prepared.status).toBe('completed')
    const data = prepared.data as any
    expect(data.status).toBe('awaiting-authorization')
    expect(data.authorizationRequired).toBe(true)
    expect(data.publishRequestId).toMatch(/^pub_/)
    // 授权请求确实发给了 GUI，且没有发生任何渲染/发布。
    expect(mock.state.asks).toHaveLength(1)
    expect(mock.state.asks[0].action).toBe('publish-authorize')
    expect(mock.state.asks[0].publishRequestId).toBe(data.publishRequestId)
    expect(mock.state.publishCalls).toBe(0)
    // 画布未被申请动作修改。
    expect(openProject(project.id)!.meta.graphVersion).toBe(version)

    const status = await call('director.publish.status', {
      projectId: project.id,
      publishRequestId: data.publishRequestId
    })
    expect(status.status).toBe('completed')
    expect((status.data as any).status).toBe('awaiting-authorization')
  })

  it('未授权时 continue 被拒绝，且不会调用宿主发布', async () => {
    const project = createProject('发布-未授权')
    const version = seed(project.id, [directorNode('d1')])
    active = project.id
    const mock = publishDesktop(project.id)
    withDesktop(mock.desktop)
    const prepared = await call('director.publish.prepare', {
      projectId: project.id,
      nodeId: 'shape:d1',
      expectedGraphVersion: version
    })
    const continueCall = await call('director.publish.continue', {
      projectId: project.id,
      publishRequestId: (prepared.data as any).publishRequestId,
      expectedGraphVersion: version
    })
    expect(continueCall.status).toBe('failed')
    expect(continueCall.error?.code).toBe('PUBLISH_NOT_AUTHORIZED')
    expect(mock.state.publishCalls).toBe(0)
  })

  it('人拒绝后请求作废，continue 得到 PUBLISH_DENIED', async () => {
    const project = createProject('发布-拒绝')
    const version = seed(project.id, [directorNode('d1')])
    active = project.id
    const mock = publishDesktop(project.id)
    withDesktop(mock.desktop)
    const prepared = await call('director.publish.prepare', {
      projectId: project.id,
      nodeId: 'shape:d1',
      expectedGraphVersion: version
    })
    const publishRequestId = (prepared.data as any).publishRequestId
    await mock.decide(false)
    const status = await call('director.publish.status', {
      projectId: project.id,
      publishRequestId
    })
    expect((status.data as any).status).toBe('denied')
    const continueCall = await call('director.publish.continue', {
      projectId: project.id,
      publishRequestId,
      expectedGraphVersion: version
    })
    expect(continueCall.error?.code).toBe('PUBLISH_DENIED')
    expect(mock.state.publishCalls).toBe(0)
  })

  it('人允许后执行发布：正式产物落盘、节点发布记录可核对、幂等重放不重复发布', async () => {
    const project = createProject('发布-允许')
    const version = seed(project.id, [directorNode('d1')])
    active = project.id
    const mock = publishDesktop(project.id)
    withDesktop(mock.desktop)
    const prepared = await call('director.publish.prepare', {
      projectId: project.id,
      nodeId: 'shape:d1',
      expectedGraphVersion: version
    })
    const publishRequestId = (prepared.data as any).publishRequestId
    await mock.decide(true)

    const idempotency = key()
    const done = await call(
      'director.publish.continue',
      { projectId: project.id, publishRequestId, expectedGraphVersion: version },
      idempotency
    )
    expect(done.status, JSON.stringify(done.error)).toBe('completed')
    const data = done.data as any
    expect(data.status).toBe('completed')
    expect(data.artifact.mediaId).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(data.artifact.mime).toBe('image/png')
    expect(mock.state.publishCalls).toBe(1)
    // 正式发布记录确实写进了持久化数据（快照 shape meta，与 output.get 同一来源），
    // 而不是只停留在回执里。
    const savedFile = openProject(project.id)!
    const snapshotMeta = readSnapshotShapeMeta(savedFile, 'shape:d1') ?? {}
    const record = JSON.parse(String(snapshotMeta.nodeResult))
    expect(record.frame.mediaId).toBe(data.artifact.mediaId)
    // 同幂等键重放：同一份回执，不再调用宿主。
    const replay = await call(
      'director.publish.continue',
      { projectId: project.id, publishRequestId, expectedGraphVersion: version },
      idempotency
    )
    expect(replay.status).toBe('completed')
    expect((replay.data as any).artifact.mediaId).toBe(data.artifact.mediaId)
    expect(mock.state.publishCalls).toBe(1)
    // 不同幂等键再次 continue：已完成请求只回执，不二次渲染。
    const again = await call('director.publish.continue', {
      projectId: project.id,
      publishRequestId,
      expectedGraphVersion: version
    })
    expect(again.status).toBe('completed')
    expect((again.data as any).artifact.mediaId).toBe(data.artifact.mediaId)
    expect(mock.state.publishCalls).toBe(1)
  })

  it('授权绑定画布版本：申请后画布又变化时必须重新申请', async () => {
    const project = createProject('发布-版本漂移')
    const version = seed(project.id, [directorNode('d1')])
    active = project.id
    const mock = publishDesktop(project.id)
    withDesktop(mock.desktop)
    const prepared = await call('director.publish.prepare', {
      projectId: project.id,
      nodeId: 'shape:d1',
      expectedGraphVersion: version
    })
    await mock.decide(true)
    // 用户在 GUI 里继续编辑并保存：图版本前进。
    const advanced = seed(project.id, [directorNode('d1'), textNode('t2')])
    expect(advanced).toBeGreaterThan(version)
    const continueCall = await call('director.publish.continue', {
      projectId: project.id,
      publishRequestId: (prepared.data as any).publishRequestId,
      expectedGraphVersion: advanced
    })
    expect(continueCall.status).toBe('failed')
    expect(continueCall.error?.code).toBe('REVISION_CONFLICT')
    expect(mock.state.publishCalls).toBe(0)
  })

  it('宿主回执不可核对时按未知结果处理，不谎报完成', async () => {
    const project = createProject('发布-宿主异常')
    const version = seed(project.id, [directorNode('d1')])
    active = project.id
    const mock = publishDesktop(project.id, 'bad-result')
    withDesktop(mock.desktop)
    const prepared = await call('director.publish.prepare', {
      projectId: project.id,
      nodeId: 'shape:d1',
      expectedGraphVersion: version
    })
    await mock.decide(true)
    const continueCall = await call(
      'director.publish.continue',
      {
        projectId: project.id,
        publishRequestId: (prepared.data as any).publishRequestId,
        expectedGraphVersion: version
      },
      key()
    )
    expect(continueCall.status).not.toBe('completed')
    // 准入后失败必须是 unknown，不能表述成"没发生过"。
    expect(continueCall.status).toBe('unknown')
    expect(continueCall.error?.code).toBe('OUTCOME_UNKNOWN')
  })

  it('跨项目读取发布请求按 NOT_FOUND 拒绝', async () => {
    const project = createProject('发布-归属')
    const other = createProject('发布-其他')
    const version = seed(project.id, [directorNode('d1')])
    seed(other.id, [])
    active = project.id
    const mock = publishDesktop(project.id)
    withDesktop(mock.desktop)
    const prepared = await call('director.publish.prepare', {
      projectId: project.id,
      nodeId: 'shape:d1',
      expectedGraphVersion: version
    })
    const status = await call('director.publish.status', {
      projectId: other.id,
      publishRequestId: (prepared.data as any).publishRequestId
    })
    expect(status.status).toBe('failed')
    expect(status.error?.code).toBe('NOT_FOUND')
  })

  it('node.execute 不是发布路径：导演台只读取最近一次一致发布记录', () => {
    // 未发布：skipped 并说明原因，绝不生成媒体。
    const unpublished = directorExecutor({
      shape: {
        id: 'shape:d1',
        type: 'node-card',
        props: { config: JSON.stringify(createDirectorProject()) },
        meta: {}
      },
      inputs: new Map()
    } as never) as { status: string; reason?: string }
    expect(unpublished.status).toBe('skipped')
    expect(unpublished.reason).toContain('尚未发布过输出')

    // 已发布的工程在修订变化后被判为过期，也不能被当成可复用输出。
    const project = createDirectorProject()
    const record = createDirectorPublishRecord(project, project.shots[0], null, {
      frame: { mediaId: 'media-1', mediaPath: 'projects/p/media/m.png', mime: 'image/png' }
    })
    const stale = directorExecutor({
      shape: {
        id: 'shape:d1',
        type: 'node-card',
        props: { config: JSON.stringify({ ...project, revision: project.revision + 1 }) },
        meta: { nodeResult: JSON.stringify(record) }
      },
      inputs: new Map()
    } as never) as { status: string; reason?: string }
    expect(stale.status).toBe('skipped')
    expect(stale.reason).toContain('发布内容与当前工程不一致')
  })
})
