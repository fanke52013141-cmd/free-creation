// F4 媒体接入测试：media.import 登记受控媒体、media.list 摘要、
// graph.patch 素材引用的归属预检（main 解析、外部不可携带路径）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDataDir, getDb } from '../src/main/store/db'
import { createProject, openProject } from '../src/main/store/projects.repo'
import { listMedia } from '../src/main/store/media.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { AccessDesktop } from '../src/main/agent-access/desktop'

let directory: string
let service: LocalAccessService
let active: string | null
let lastDesktopRequest: any = null
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`
const controlledPath = (name: string) => join(getDataDir(), 'agent-exports', name)

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

function withDesktop(desktop?: AccessDesktop): void {
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active,
    desktop
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-media-access-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  lastDesktopRequest = null
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active
  })
})

afterEach(() => {
  closeDb()
  setGatewayEventSink(null)
  process.env.CANVAS_DATA_DIR = originalDirectory
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-media-access-test-')
  )
    throw new Error('MEDIA_ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('local Agent media access', () => {
  it('imports a local file as project-controlled media and lists it without absolute paths', async () => {
    const p = createProject('素材')
    const source = controlledPath('pose.png')
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))
    const imported = await call('media.import', { projectId: p.id, filePath: source, name: '姿势图' }, key())
    expect(imported.status).toBe('completed')
    const data = imported.data as any
    expect(data).toMatchObject({ projectId: p.id, kind: 'image', mime: 'image/png', name: '姿势图' })
    expect(data.path).toMatch(/^projects\/.+\/media\//)
    expect(JSON.stringify(imported)).not.toContain(directory)
    const listed = await call('media.list', { projectId: p.id })
    expect(listed.data).toMatchObject({ projectId: p.id, total: 1 })
    expect((listed.data as any).items[0].mediaId).toBe(data.mediaId)
    expect(JSON.stringify(listed)).not.toContain(directory)
    // 文件真实落库到项目媒体目录
    const saved = openProject(p.id)!
    void saved
  })

  it('rejects files outside the controlled import root without leaking their contents', async () => {
    const p = createProject('目录边界')
    const secret = 'PRIVATE_OUTSIDE_ROOT_TEXT_DO_NOT_LEAK'
    const outside = join(directory, 'outside.txt')
    writeFileSync(outside, secret)
    const idempotencyKey = key()
    const refused = await call(
      'media.import',
      { projectId: p.id, filePath: outside },
      idempotencyKey
    )
    expect(refused.status).toBe('failed')
    expect(refused.error?.code).toBe('PATH_NOT_ALLOWED')
    expect(JSON.stringify(refused)).not.toContain(secret)
    expect(JSON.stringify(refused)).not.toContain(outside)
    const receipt = getDb()
      .prepare('SELECT receipt_json FROM local_agent_operations WHERE idempotency_key=?')
      .get(idempotencyKey) as { receipt_json: string }
    expect(receipt.receipt_json).not.toContain(secret)
    expect(listMedia(p.id)).toHaveLength(0)
  })

  it('never returns or stores text bodies for external media imports', async () => {
    const p = createProject('正文边界')
    const secret = 'PRIVATE_CONTROLLED_TEXT_DO_NOT_LEAK'
    const source = controlledPath('note.md')
    writeFileSync(source, `# title\n${secret}`)
    const idempotencyKey = key()
    const imported = await call(
      'media.import',
      { projectId: p.id, filePath: source },
      idempotencyKey
    )
    expect(imported.status).toBe('completed')
    expect(imported.data).not.toHaveProperty('textContent')
    expect(JSON.stringify(imported)).not.toContain(secret)
    const receipt = getDb()
      .prepare('SELECT receipt_json FROM local_agent_operations WHERE idempotency_key=?')
      .get(idempotencyKey) as { receipt_json: string }
    expect(receipt.receipt_json).not.toContain(secret)
  })

  it('rejects imports for missing projects and invalid files without touching storage', async () => {
    const missing = await call('media.import', { projectId: 'ghost', filePath: controlledPath('x.png') }, key())
    expect(missing.error?.code).toBe('NOT_FOUND')
    const bad = createProject('坏文件')
    const refused = await call('media.import', { projectId: bad.id, filePath: controlledPath('missing.png') }, key())
    expect(refused.error?.code).toBe('INPUT_NOT_FOUND')
  })

  it('resolves media ownership in graph.patch precheck and injects storage facts to the host only', async () => {
    const p = createProject('引用')
    const source = controlledPath('sheet.png')
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]))
    const imported = await call('media.import', { projectId: p.id, filePath: source }, key())
    const mediaId = (imported.data as any).mediaId
    active = p.id
    let captured: any = null
    withDesktop({
      run: async (request, commit) => {
        captured = request
        // 模拟宿主：真实落盘一个引用该素材的图片节点
        const { saveProject } = await import('../src/main/store/projects.repo')
        const before = (await import('../src/main/store/projects.repo')).openProject(p.id)!
        commit?.(before.meta.graphVersion)
        const saved = saveProject({
          id: p.id,
          expectedGraphVersion: before.meta.graphVersion,
          graph: {
            nodes: [
              ...before.nodes,
              {
                id: 'shape:agent-img-1',
                type: 'image',
                contractVersion: 3,
                title: '外部素材节点',
                x: 0,
                y: 0,
                w: 340,
                h: 260,
                ports: [],
                params: { mediaPath: (request.mediaResolutions ?? {})[mediaId]?.mediaPath ?? '' },
                content: { kind: 'media', mediaId },
                exec: { status: 'idle' },
                meta: { source: 'upload', createdAt: 1 }
              }
            ],
            edges: [],
            groups: []
          }
        })!
        return {
          graphVersion: saved.graphVersion,
          result: {
            created: [{ ref: 'img', nodeId: 'shape:agent-img-1' }],
            counts: { nodeCreated: 1, nodeUpdated: 0, nodeDeleted: 0, edgeCreated: 0, edgeDeleted: 0 }
          }
        }
      }
    })
    const patched = await call(
      'graph.patch',
      {
        projectId: p.id,
        expectedGraphVersion: 1,
        ops: [
          { action: 'node.create', ref: 'img', nodeType: 'image', x: 0, y: 0, media: { mediaId } }
        ]
      },
      key()
    )
    expect(patched.status).toBe('completed')
    expect(captured.mediaResolutions[mediaId]).toMatchObject({ mediaId, mediaMime: 'image/png' })
    expect(captured.mediaResolutions[mediaId].mediaPath).toMatch(/^projects\//)
    // 外部输入不可携带路径：op 只有 mediaId
    expect(JSON.stringify((captured.ops ?? [])[0])).not.toContain('projects/')
    // 未登记的 mediaId 拒绝
    const unknown = await call(
      'graph.patch',
      {
        projectId: p.id,
        expectedGraphVersion: 2,
        ops: [{ action: 'node.create', nodeType: 'image', x: 0, y: 0, media: { mediaId: 'ghost-media' } }]
      },
      key()
    )
    expect(unknown.error?.code).toBe('MEDIA_NOT_FOUND')
    // 跨项目引用拒绝：B 项目引用 A 的素材
    const other = createProject('别家')
    active = other.id
    withDesktop({
      run: async () => ({ graphVersion: 0 })
    })
    const crossProject = await call(
      'graph.patch',
      {
        projectId: other.id,
        expectedGraphVersion: 0,
        ops: [{ action: 'node.create', nodeType: 'image', x: 0, y: 0, media: { mediaId } }]
      },
      key()
    )
    expect(crossProject.error?.code).toBe('MEDIA_NOT_FOUND')
    expect(lastDesktopRequest).toBeNull()
  })
})

describe('local Agent media delete', () => {
  it('deletes project-owned media with reference count and rejects cross-project or unknown ids', async () => {
    const p = createProject('删除素材')
    const source = controlledPath('del.png')
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5, 5]))
    const imported = await call('media.import', { projectId: p.id, filePath: source }, key())
    const mediaId = (imported.data as any).mediaId
    const deleted = await call('media.delete', { projectId: p.id, mediaId }, key())
    expect(deleted.status).toBe('completed')
    expect(deleted.data).toMatchObject({ projectId: p.id, deleted: true, mediaId, referencedBySavedNodes: 0 })
    // 重复删除同一 mediaId（新幂等键）→ NOT_FOUND，不误删别家
    const again = await call('media.delete', { projectId: p.id, mediaId }, key())
    expect(again.error?.code).toBe('MEDIA_NOT_FOUND')
    // 跨项目删除拒绝
    const source2 = controlledPath('del2.png')
    writeFileSync(source2, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 6, 6, 6]))
    const other = createProject('别家删除')
    const imported2 = await call('media.import', { projectId: other.id, filePath: source2 }, key())
    const otherMediaId = (imported2.data as any).mediaId
    const cross = await call('media.delete', { projectId: p.id, mediaId: otherMediaId }, key())
    expect(cross.error?.code).toBe('MEDIA_NOT_FOUND')
    // B 项目的素材仍然存在
    const listed = await call('media.list', { projectId: other.id })
    expect((listed.data as any).items.some((m: any) => m.mediaId === otherMediaId)).toBe(true)
  })
})
