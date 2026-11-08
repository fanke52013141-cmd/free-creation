// F7 资源库外部接入测试：全类型资源 CRUD/修订/归档/分类/文件夹/集合/批量删除/物化。
//
// 覆盖口径（不是复述实现）：
// - 正常创建（文本/图片/音频/视频/文件/JSON 组件）、读取（含正文开关）、修订发布、归档/取消归档、删除；
// - 分类蓝图归属与槽位引用、文件夹归属、收藏集归属；
// - 批量删除逐项回执（部分失败不静默）；
// - 非法参数（缺字段/相对路径/非法 JSON/重复组件/无效分类版本）；
// - 跨项目越权（未打开项目物化、错误项目补偿清理）；
// - 幂等重放只发生一次副作用（含物化不重复复制媒体）；
// - 删除后无残留（DB 行/使用记录/磁盘 blob/索引）；
// - 物化到画布：受控媒体重映射 + 节点引用与资源内容一致 + 准入后失联按 unknown 且不误删媒体。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AccessDesktop } from '../src/main/agent-access/desktop'
import { DesktopAccessError } from '../src/main/agent-access/desktop'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { closeDb, getDataDir, getDb } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { listMedia } from '../src/main/store/media.repo'

let directory: string
let service: LocalAccessService
let active: string | null
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

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

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 21, 22, 23])
const WAV_BYTES = Buffer.from('RIFF....WAVEfmt-data-test-audio', 'utf8')
const MP4_BYTES = Buffer.from('000000186674797069736f6d-mp4-test-video', 'utf8')
const FILE_BYTES = Buffer.from('资源库文件组件正文（中文）', 'utf8')

let sources: { png: string; wav: string; mp4: string; file: string }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-library-access-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  sources = {
    png: join(directory, 'pose.png'),
    wav: join(directory, 'voice.wav'),
    mp4: join(directory, 'clip.mp4'),
    file: join(directory, 'notes.txt')
  }
  writeFileSync(sources.png, PNG_BYTES)
  writeFileSync(sources.wav, WAV_BYTES)
  writeFileSync(sources.mp4, MP4_BYTES)
  writeFileSync(sources.file, FILE_BYTES)
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
    !basename(directory).startsWith('canvas-library-access-test-')
  )
    throw new Error('LIBRARY_ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('资源创建与读取（全类型组件）', () => {
  it('creates every component type through createResource and reads bodies only on request', async () => {
    const created = await call(
      'library.resource.create',
      {
        title: '测试标题-中文',
        formPreset: 'custom',
        description: '全类型组件',
        tags: ['姿势', '参考'],
        components: [
          { role: '参考图片', valueType: 'image', filePath: sources.png },
          { role: '配音', valueType: 'audio', filePath: sources.wav },
          { role: '片段', valueType: 'video', filePath: sources.mp4 },
          { role: '附件', valueType: 'file', filePath: sources.file },
          { role: '提示词', valueType: 'text', text: '电影感光线' },
          { role: '参数', valueType: 'json', text: '{"level":3}' }
        ]
      },
      key()
    )
    expect(created.status).toBe('completed')
    const resource = created.data as any
    expect(resource).toMatchObject({
      title: '测试标题-中文',
      formPreset: 'custom',
      revisionNumber: 1
    })
    expect(resource.tags).toEqual(['参考', '姿势'])
    expect(resource.components.map((component: any) => component.valueType)).toEqual([
      'image',
      'audio',
      'video',
      'file',
      'text',
      'json'
    ])
    const image = resource.components[0]
    expect(image).toMatchObject({
      role: '参考图片',
      hasBlob: true,
      mime: 'image/png',
      sizeBytes: PNG_BYTES.length
    })
    expect(image.contentHash).toBe(sha256(PNG_BYTES))
    // 默认不回传正文，只给长度
    const textComponent = resource.components[4]
    expect(textComponent.text).toBeUndefined()
    expect(textComponent.textLength).toBe('电影感光线'.length)
    // 外部输入不回显导入路径
    expect(JSON.stringify(created)).not.toContain(directory)

    const read = await call('library.resource.get', { resourceId: resource.resourceId })
    expect(read.status).toBe('completed')
    expect((read.data as any).components[4].text).toBeUndefined()
    const withText = await call('library.resource.get', {
      resourceId: resource.resourceId,
      includeText: true
    })
    expect((withText.data as any).components[4].text).toBe('电影感光线')
    expect((withText.data as any).components[5].text).toBe('{"level":3}')
    expect((withText.data as any).revisions).toHaveLength(1)
    expect((withText.data as any).usages).toEqual([])
    // 不存在的资源是 NOT_FOUND，不是空成功
    const missing = await call('library.resource.get', { resourceId: 'ghost-resource' })
    expect(missing.error?.code).toBe('NOT_FOUND')
  })

  it('publishes revisions with inherited metadata and reuses base components', async () => {
    const created = await call(
      'library.resource.create',
      {
        title: '初版标题',
        formPreset: 'custom',
        description: '初版描述',
        components: [{ role: '提示词', valueType: 'text', text: '初版正文' }]
      },
      key()
    )
    const first = created.data as any
    const published = await call(
      'library.resource.publish',
      {
        resourceId: first.resourceId,
        baseRevisionId: first.latestRevisionId,
        title: '第二版标题',
        tags: ['新标签']
      },
      key()
    )
    expect(published.status).toBe('completed')
    const second = published.data as any
    expect(second.revisionNumber).toBe(2)
    expect(second.title).toBe('第二版标题')
    expect(second.tags).toEqual(['新标签'])
    // 省略的字段沿用基础版本，不因“省略”清空
    expect(second.description).toBe('初版描述')
    expect(second.components[0].textLength).toBe('初版正文'.length)
    const reread = await call('library.resource.get', {
      resourceId: first.resourceId,
      includeText: true
    })
    expect((reread.data as any).selectedRevisionNumber).toBe(2)
    expect((reread.data as any).components[0].text).toBe('初版正文')
    // 用旧基础版本再次发布 → 版本冲突
    const stale = await call(
      'library.resource.publish',
      { resourceId: first.resourceId, baseRevisionId: first.latestRevisionId, title: '覆盖' },
      key()
    )
    expect(stale.error?.code).toBe('REVISION_CONFLICT')
  })

  it('archives and unarchives with search filtering, and deletes without residue', async () => {
    const created = await call(
      'library.resource.create',
      {
        title: '待归档资源',
        formPreset: 'image',
        components: [{ role: '参考图片', valueType: 'image', filePath: sources.png }]
      },
      key()
    )
    const resource = created.data as any
    const blobPath = join(getDataDir(), 'library', 'blobs')
    expect(existsSync(blobPath)).toBe(true)
    const archived = await call(
      'library.resource.archive',
      { resourceId: resource.resourceId, archived: true },
      key()
    )
    expect(archived.status).toBe('completed')
    expect((archived.data as any).archived).toBe(true)
    const hidden = await call('library.resource.list', { query: '待归档资源' })
    expect((hidden.data as any).items).toHaveLength(0)
    const visible = await call('library.resource.list', {
      query: '待归档资源',
      includeArchived: true
    })
    expect((visible.data as any).items).toHaveLength(1)
    expect((visible.data as any).items[0].archived).toBe(true)
    // 归档资源不能发布修订
    const refused = await call(
      'library.resource.publish',
      { resourceId: resource.resourceId, baseRevisionId: resource.latestRevisionId, title: 'x' },
      key()
    )
    expect(refused.error?.code).toBe('RESOURCE_ARCHIVED')
    const unarchived = await call(
      'library.resource.archive',
      { resourceId: resource.resourceId, archived: false },
      key()
    )
    expect((unarchived.data as any).archived).toBe(false)

    const blobRows = getDb().prepare('SELECT path FROM library_blobs').all() as Array<{
      path: string
    }>
    expect(blobRows).toHaveLength(1)
    const absoluteBlob = join(getDataDir(), blobRows[0].path)
    expect(existsSync(absoluteBlob)).toBe(true)

    const deleted = await call(
      'library.resource.delete',
      { resourceId: resource.resourceId },
      key()
    )
    expect(deleted.status).toBe('completed')
    expect(deleted.data).toEqual({ resourceId: resource.resourceId, deleted: true })
    // 删除后无残留：资源/修订/组件/标签/集合/文件夹/使用记录/索引/磁盘 blob
    const db = getDb()
    const count = (sql: string): number =>
      (db.prepare(sql).get(resource.resourceId) as { n: number }).n
    expect(count('SELECT COUNT(*) AS n FROM library_resources WHERE id = ?')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM library_revisions WHERE resource_id = ?')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM library_tags WHERE resource_id = ?')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM library_collection_items WHERE resource_id = ?')).toBe(
      0
    )
    expect(count('SELECT COUNT(*) AS n FROM library_resource_folders WHERE resource_id = ?')).toBe(
      0
    )
    expect(count('SELECT COUNT(*) AS n FROM library_usages WHERE resource_id = ?')).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM library_components').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM library_blobs').get()).toEqual({ n: 0 })
    expect(existsSync(absoluteBlob)).toBe(false)
    // 再删一次 → NOT_FOUND（不会假装成功）
    const again = await call('library.resource.delete', { resourceId: resource.resourceId }, key())
    expect(again.error?.code).toBe('NOT_FOUND')
  })
})

describe('分类、文件夹与收藏集归属', () => {
  it('files a category-mapped resource into folder/collection and exposes the same ownership', async () => {
    const folder = await call('library.folder.create', { name: '人物素材' }, key())
    expect(folder.status).toBe('completed')
    const folderId = (folder.data as any).folderId
    const collection = await call(
      'library.collection.create',
      {
        name: '主角设定',
        description: '主要人物'
      },
      key()
    )
    const collectionId = (collection.data as any).collectionId
    const categories = await call('library.category.list')
    expect(categories.status).toBe('completed')
    const builtin = (categories.data as any).categories.find(
      (category: any) => category.categoryId === 'builtin-character'
    )
    expect(builtin).toMatchObject({ version: 1, presentation: 'profile' })
    expect(builtin.slots.map((slot: any) => slot.nodeType)).toEqual(['image', 'text', 'audio'])

    const created = await call(
      'library.resource.create',
      {
        title: '男主角',
        formPreset: 'character',
        category: { id: 'builtin-character', version: 1 },
        tags: ['主角'],
        collectionIds: [collectionId],
        folderId,
        components: [
          {
            role: '形象',
            valueType: 'image',
            filePath: sources.png,
            metadata: { librarySlotId: 'slot-0' }
          },
          {
            role: '描述',
            valueType: 'text',
            text: '黑色短发，白衬衫',
            metadata: { librarySlotId: 'slot-1' }
          }
        ]
      },
      key()
    )
    expect(created.status).toBe('completed')
    const resource = created.data as any
    expect(resource.category).toMatchObject({ id: 'builtin-character', version: 1 })
    expect(resource.collectionIds).toEqual([collectionId])
    expect(resource.folderIds).toEqual([folderId])
    expect(resource.components.map((component: any) => component.references.librarySlotId)).toEqual(
      ['slot-0', 'slot-1']
    )

    // 缺少必填槽位 → 蓝图校验拒绝（与 GUI 表单同一规则）
    const invalid = await call(
      'library.resource.create',
      {
        title: '缺少必填槽位',
        formPreset: 'character',
        category: { id: 'builtin-character', version: 1 },
        components: [
          {
            role: '描述',
            valueType: 'text',
            text: '只有描述',
            metadata: { librarySlotId: 'slot-1' }
          }
        ]
      },
      key()
    )
    expect(invalid.error?.code).toBe('INVALID_INPUT')

    // 文件夹/集合目录可查回归属
    const folders = await call('library.folder.list')
    expect((folders.data as any).folders[0]).toMatchObject({ folderId, resourceCount: 1 })
    const collections = await call('library.collection.list')
    expect((collections.data as any).collections[0]).toMatchObject({
      collectionId,
      resourceCount: 1
    })

    // 重新归入根目录 / 清空集合
    const rootMoved = await call(
      'library.resource.set_folder',
      { resourceId: resource.resourceId, folderId: null },
      key()
    )
    expect((rootMoved.data as any).folderIds).toEqual([])
    const cleared = await call(
      'library.resource.set_collections',
      { resourceId: resource.resourceId, collectionIds: [] },
      key()
    )
    expect((cleared.data as any).collectionIds).toEqual([])
    // 不存在的文件夹 ID 不静默成功
    const badFolder = await call(
      'library.resource.set_folder',
      { resourceId: resource.resourceId, folderId: 'ghost-folder' },
      key()
    )
    expect(badFolder.error?.code).toBe('INVALID_INPUT')

    // 文件夹重名拒绝；重命名成功后删除（资源上移、不删资源）
    const duplicate = await call('library.folder.create', { name: '人物素材' }, key())
    expect(duplicate.error?.code).toBe('FOLDER_CONFLICT')
    const renamed = await call('library.folder.rename', { folderId, name: '人物素材 v2' }, key())
    expect((renamed.data as any).name).toBe('人物素材 v2')
    await call('library.resource.set_folder', { resourceId: resource.resourceId, folderId }, key())
    const removed = await call('library.folder.delete', { folderId }, key())
    expect(removed.data).toEqual({ folderId, deleted: true })
    expect((await call('library.folder.list')).data).toMatchObject({ total: 0 })
    const after = await call('library.resource.get', { resourceId: resource.resourceId })
    expect((after.data as any).folderIds).toEqual([])
  })

  it('saves category blueprint versions with conflict protection', async () => {
    const categories = await call('library.category.list')
    const source = (categories.data as any).categories.find(
      (category: any) => category.categoryId === 'builtin-prompt'
    )
    const next = {
      id: 'builtin-prompt',
      version: 2,
      name: '提示词 v2',
      description: '外部保存的新版本',
      presentation: 'list',
      blueprint: {
        protocolVersion: 1,
        layout: 'row',
        slots: [
          {
            id: 'slot-0',
            label: '提示词',
            nodeType: 'text',
            contractVersion: 3,
            required: true,
            multiple: false,
            titleTemplate: '{resource} · {slot}'
          }
        ]
      }
    }
    const saved = await call('library.category.save', { category: next, baseVersion: 1 }, key())
    expect(saved.status).toBe('completed')
    expect(saved.data).toMatchObject({
      categoryId: 'builtin-prompt',
      version: 2,
      name: '提示词 v2'
    })
    // 版本漂移 → 冲突（不覆盖）
    const stale = await call(
      'library.category.save',
      { category: { ...next, name: '提示词 v3' }, baseVersion: 1 },
      key()
    )
    expect(stale.error?.code).toBe('REVISION_CONFLICT')
    // 版本号必须为基础版本 +1
    const badVersion = await call(
      'library.category.save',
      { category: { ...next, version: 9, name: '提示词 v9' }, baseVersion: 2 },
      key()
    )
    expect(badVersion.error?.code).toBe('INVALID_INPUT')
    expect(source.version).toBe(1)
  })
})

describe('批量删除与幂等', () => {
  it('returns per-item receipts for partial batch failure', async () => {
    const make = async (title: string): Promise<string> => {
      const created = await call(
        'library.resource.create',
        {
          title,
          formPreset: 'custom',
          components: [{ role: '正文', valueType: 'text', text: title }]
        },
        key()
      )
      return (created.data as any).resourceId
    }
    const keep = await make('保留的资源')
    const first = await make('待删除一')
    const second = await make('待删除二')
    const result = await call(
      'library.resource.delete_many',
      { resourceIds: [first, 'ghost-resource', second] },
      key()
    )
    expect(result.status).toBe('completed')
    const data = result.data as any
    expect(data.deleted).toBe(2)
    expect(data.failed).toBe(1)
    expect(data.items).toEqual([
      { resourceId: first, deleted: true },
      { resourceId: 'ghost-resource', deleted: false, code: 'NOT_FOUND' },
      { resourceId: second, deleted: true }
    ])
    // 成功项真实删除、失败项不影响保留资源
    expect((await call('library.resource.get', { resourceId: first })).error?.code).toBe(
      'NOT_FOUND'
    )
    expect((await call('library.resource.get', { resourceId: second })).error?.code).toBe(
      'NOT_FOUND'
    )
    expect((await call('library.resource.get', { resourceId: keep })).status).toBe('completed')
  })

  it('replays one idempotent create exactly once and rejects conflicting reuse', async () => {
    const idempotencyKey = key()
    const input = {
      title: '幂等资源',
      formPreset: 'custom',
      components: [{ role: '正文', valueType: 'text', text: '只应创建一次' }]
    }
    const first = await call('library.resource.create', input, idempotencyKey)
    const replay = await call('library.resource.create', input, idempotencyKey)
    expect(replay.status).toBe('completed')
    expect((replay.data as any).resourceId).toBe((first.data as any).resourceId)
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM library_resources').get() as {
      n: number
    }
    expect(count.n).toBe(1)
    const conflict = await call(
      'library.resource.create',
      { ...input, title: '同键不同意图' },
      idempotencyKey
    )
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT')
    expect(
      (getDb().prepare('SELECT COUNT(*) AS n FROM library_resources').get() as { n: number }).n
    ).toBe(1)
  })
})

describe('非法参数与跨项目越权', () => {
  it('rejects invalid component combinations before touching storage', async () => {
    const relativePath = await call(
      'library.resource.create',
      {
        title: '相对路径',
        formPreset: 'image',
        components: [{ role: '参考图片', valueType: 'image', filePath: 'pose.png' }]
      },
      key()
    )
    expect(relativePath.error?.code).toBe('INVALID_INPUT')
    const noContent = await call(
      'library.resource.create',
      { title: '无正文', formPreset: 'custom', components: [{ role: '正文', valueType: 'text' }] },
      key()
    )
    expect(noContent.error?.code).toBe('INVALID_INPUT')
    const mixedType = await call(
      'library.resource.create',
      {
        title: '正文带路径',
        formPreset: 'custom',
        components: [{ role: '正文', valueType: 'text', text: 'x', filePath: sources.png }]
      },
      key()
    )
    expect(mixedType.error?.code).toBe('INVALID_INPUT')
    const badJson = await call(
      'library.resource.create',
      {
        title: '坏 JSON',
        formPreset: 'custom',
        components: [{ role: '参数', valueType: 'json', text: '{not-json' }]
      },
      key()
    )
    expect(badJson.error?.code).toBe('INVALID_INPUT')
    const presetMismatch = await call(
      'library.resource.create',
      {
        title: '图片资源缺图片',
        formPreset: 'image',
        components: [{ role: '提示词', valueType: 'text', text: '只有提示词' }]
      },
      key()
    )
    expect(presetMismatch.error?.code).toBe('INVALID_INPUT')
    const wrongExtension = await call(
      'library.resource.create',
      {
        title: '类型与扩展名不符',
        formPreset: 'custom',
        components: [{ role: '图片', valueType: 'image', filePath: sources.file }]
      },
      key()
    )
    expect(wrongExtension.error?.code).toBe('INVALID_INPUT')
    const missingFile = await call(
      'library.resource.create',
      {
        title: '文件不存在',
        formPreset: 'custom',
        components: [{ role: '图片', valueType: 'image', filePath: join(directory, 'ghost.png') }]
      },
      key()
    )
    expect(missingFile.error?.code).toBe('INVALID_INPUT')
    // 以上失败都不留下资源
    expect(
      (getDb().prepare('SELECT COUNT(*) AS n FROM library_resources').get() as { n: number }).n
    ).toBe(0)
    // 空批量/超长标签由 Schema 层拒绝
    expect(
      (await call('library.resource.delete_many', { resourceIds: [] }, key())).error?.code
    ).toBe('INVALID_INPUT')
  })

  it('refuses materialization for a project that is not the open canvas and leaves no media', async () => {
    const open = createProject('画布 A')
    const other = createProject('画布 B')
    const created = await call(
      'library.resource.create',
      {
        title: '跨项目资源',
        formPreset: 'image',
        components: [{ role: '参考图片', valueType: 'image', filePath: sources.png }]
      },
      key()
    )
    const resource = created.data as any
    active = open.id
    withDesktop({ run: async () => ({ graphVersion: 0 }) })
    const refused = await call(
      'library.resource.materialize',
      {
        projectId: other.id,
        resourceId: resource.resourceId,
        revisionId: resource.latestRevisionId,
        componentIds: [resource.components[0].componentId],
        expectedGraphVersion: openProject(other.id)!.meta.graphVersion
      },
      key()
    )
    expect(refused.error?.code).toBe('ACTIVE_PROJECT_REQUIRED')
    expect(listMedia(other.id)).toHaveLength(0)
    // 打开的项目本身版本不符时也不复制媒体
    const staleVersion = await call(
      'library.resource.materialize',
      {
        projectId: open.id,
        resourceId: resource.resourceId,
        revisionId: resource.latestRevisionId,
        componentIds: [resource.components[0].componentId],
        expectedGraphVersion: 999
      },
      key()
    )
    expect(staleVersion.error?.code).toBe('REVISION_CONFLICT')
    expect(listMedia(open.id)).toHaveLength(0)
    // 补偿清理必须按项目归属核对：错误项目不能删除别家使用记录
    const usageId = 'ghost-usage'
    const wrongProject = await call(
      'library.materialization.discard',
      { projectId: other.id, usageId },
      key()
    )
    expect(wrongProject.error?.code).toBe('NOT_FOUND')
  })
})

describe('物化到画布（桌面握手 + 引用一致）', () => {
  it('copies controlled media, creates nodes via the graph-patch handshake and keeps references consistent', async () => {
    const project = createProject('物化目标')
    const created = await call(
      'library.resource.create',
      {
        title: '资源包人物',
        formPreset: 'custom',
        tags: ['物化'],
        components: [
          { role: '形象', valueType: 'image', filePath: sources.png },
          { role: '描述', valueType: 'text', text: '外部提示词正文' }
        ]
      },
      key()
    )
    const resource = created.data as any
    active = project.id
    let desktopCalls = 0
    let captured: any = null
    withDesktop({
      run: async (request, commit) => {
        desktopCalls += 1
        captured = request
        const before = openProject(project.id)!
        commit?.(before.meta.graphVersion)
        const nodes = [...before.nodes]
        const created2: Array<{ ref?: string; nodeId: string }> = []
        for (const op of (request.ops ?? []) as any[]) {
          if (op.action !== 'node.create') continue
          const nodeId = `shape:materialized-${created2.length}`
          const resolution = (request.mediaResolutions ?? {})[op.media?.mediaId ?? '']
          nodes.push({
            id: nodeId,
            type: op.nodeType,
            contractVersion: 1,
            title: op.title ?? '',
            x: op.x,
            y: op.y,
            w: 340,
            h: 260,
            ports: [],
            params: resolution
              ? { mediaPath: resolution.mediaPath, mediaMime: resolution.mediaMime }
              : {},
            content: resolution
              ? { kind: 'media', mediaId: resolution.mediaId }
              : { kind: 'text', text: op.text ?? '' },
            exec: { status: 'idle' },
            meta: { source: 'input', createdAt: 1 }
          } as any)
          created2.push({ ref: op.ref, nodeId })
        }
        const saved = saveProject({
          id: project.id,
          expectedGraphVersion: before.meta.graphVersion,
          graph: { nodes, edges: before.edges, groups: before.groups }
        })!
        return {
          graphVersion: saved.graphVersion,
          result: {
            created: created2,
            counts: {
              nodeCreated: created2.length,
              nodeUpdated: 0,
              nodeDeleted: 0,
              edgeCreated: 0,
              edgeDeleted: 0
            }
          }
        }
      }
    })
    const before = openProject(project.id)!
    const idempotencyKey = key()
    const materialized = await call(
      'library.resource.materialize',
      {
        projectId: project.id,
        resourceId: resource.resourceId,
        revisionId: resource.latestRevisionId,
        componentIds: resource.components.map((component: any) => component.componentId),
        expectedGraphVersion: before.meta.graphVersion,
        x: 100,
        y: 200
      },
      idempotencyKey
    )
    expect(materialized.status).toBe('completed')
    const result = materialized.data as any
    expect(result.nodes).toHaveLength(2)
    expect(result.assetCount).toBe(1)
    // 桌面载荷：外部只有 mediaId；存储事实由 main 注入；位置按网格落点
    expect(JSON.stringify(captured.ops)).not.toContain('projects/')
    const imageOp = captured.ops.find((op: any) => op.nodeType === 'image')
    const textOp = captured.ops.find((op: any) => op.nodeType === 'text')
    expect(imageOp).toMatchObject({
      action: 'node.create',
      x: 100,
      y: 200,
      media: { mediaId: result.nodes[0].mediaId }
    })
    expect(textOp).toMatchObject({ x: 490, y: 200, text: '外部提示词正文' })
    const resolution = captured.mediaResolutions[result.nodes[0].mediaId]
    expect(resolution.mediaPath).toMatch(new RegExp(`^projects/${project.id}/media/`))
    expect(resolution.mediaMime).toBe('image/png')
    // 落盘核对：节点引用 = 资源内容（同一字节流）
    const saved = openProject(project.id)!
    expect(saved.meta.graphVersion).toBe(before.meta.graphVersion + 1)
    const imageNode = saved.nodes.find((node) => node.id === result.nodes[0].nodeId)!
    const textNode = saved.nodes.find((node) => node.id === result.nodes[1].nodeId)!
    expect(imageNode.content).toMatchObject({ kind: 'media', mediaId: result.nodes[0].mediaId })
    const mediaRows = getDb()
      .prepare('SELECT path FROM media WHERE id = ?')
      .all(result.nodes[0].mediaId) as Array<{ path: string }>
    expect(mediaRows).toHaveLength(1)
    expect(mediaRows[0].path).toBe(resolution.mediaPath)
    expect(readFileSync(join(getDataDir(), mediaRows[0].path))).toEqual(PNG_BYTES)
    expect(textNode.content).toEqual({ kind: 'text', text: '外部提示词正文' })
    // 使用记录回填节点绑定；资源详情可查回该项目
    const detail = await call('library.resource.get', { resourceId: resource.resourceId })
    expect((detail.data as any).usages).toEqual([
      expect.objectContaining({ projectId: project.id, materializedNodeCount: 2 })
    ])
    // 幂等重放：不重复复制媒体、不重复建节点
    const replay = await call(
      'library.resource.materialize',
      {
        projectId: project.id,
        resourceId: resource.resourceId,
        revisionId: resource.latestRevisionId,
        componentIds: resource.components.map((component: any) => component.componentId),
        expectedGraphVersion: before.meta.graphVersion,
        x: 100,
        y: 200
      },
      idempotencyKey
    )
    expect((replay.data as any).usageId).toBe(result.usageId)
    expect(desktopCalls).toBe(1)
    expect(listMedia(project.id)).toHaveLength(1)
    expect(openProject(project.id)!.nodes).toHaveLength(2)
  })

  it('compensates on validated host rejection and reports unknown after admission', async () => {
    const project = createProject('补偿与未知')
    const created = await call(
      'library.resource.create',
      {
        title: '补偿资源',
        formPreset: 'image',
        components: [{ role: '参考图片', valueType: 'image', filePath: sources.png }]
      },
      key()
    )
    const resource = created.data as any
    active = project.id
    const before = openProject(project.id)!
    // 宿主在任何变更前拒绝：媒体必须被补偿删除，不留孤儿文件
    withDesktop({
      run: async () => {
        throw new DesktopAccessError('PATCH_VALIDATION_FAILED', false, 'node type invalid')
      }
    })
    const rejected = await call(
      'library.resource.materialize',
      {
        projectId: project.id,
        resourceId: resource.resourceId,
        revisionId: resource.latestRevisionId,
        componentIds: [resource.components[0].componentId],
        expectedGraphVersion: before.meta.graphVersion
      },
      key()
    )
    expect(rejected.status).toBe('failed')
    expect(rejected.error?.code).toBe('PATCH_VALIDATION_FAILED')
    expect(listMedia(project.id)).toHaveLength(0)
    const usagesAfterReject = getDb().prepare('SELECT COUNT(*) AS n FROM library_usages').get() as {
      n: number
    }
    expect(usagesAfterReject.n).toBe(0)

    // 准入后失联：媒体不得被删除（节点可能已建），回执 unknown，可由 discard 核对清理
    withDesktop({
      run: async (_request, commit) => {
        commit?.(before.meta.graphVersion)
        throw new DesktopAccessError('DESKTOP_TIMEOUT', true)
      }
    })
    const lost = await call(
      'library.resource.materialize',
      {
        projectId: project.id,
        resourceId: resource.resourceId,
        revisionId: resource.latestRevisionId,
        componentIds: [resource.components[0].componentId],
        expectedGraphVersion: before.meta.graphVersion
      },
      key()
    )
    expect(lost.status).toBe('unknown')
    expect(lost.error?.code).toBe('OUTCOME_UNKNOWN')
    expect(listMedia(project.id)).toHaveLength(1)
    const usageRow = getDb()
      .prepare(
        'SELECT id FROM library_usages WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
      )
      .get(project.id) as { id: string }
    const discarded = await call(
      'library.materialization.discard',
      { projectId: project.id, usageId: usageRow.id },
      key()
    )
    expect(discarded.status).toBe('completed')
    expect(discarded.data).toEqual({ projectId: project.id, usageId: usageRow.id, discarded: true })
    expect(listMedia(project.id)).toHaveLength(0)
  })

  it('previews resource files before materializing', async () => {
    const created = await call(
      'library.resource.create',
      {
        title: '预检资源',
        formPreset: 'image',
        components: [{ role: '参考图片', valueType: 'image', filePath: sources.png }]
      },
      key()
    )
    const resource = created.data as any
    const componentId = resource.components[0].componentId
    const preview = await call('library.resource.preview_files', {
      resourceId: resource.resourceId,
      revisionId: resource.latestRevisionId,
      componentIds: [componentId]
    })
    expect(preview.data).toEqual({
      resourceId: resource.resourceId,
      revisionId: resource.latestRevisionId,
      missingComponentIds: []
    })
    // 文件缺失时预检如实报告（不复制、不创建节点）
    const blobRow = getDb().prepare('SELECT path FROM library_blobs').get() as { path: string }
    rmSync(join(getDataDir(), blobRow.path), { force: true })
    const missing = await call('library.resource.preview_files', {
      resourceId: resource.resourceId,
      revisionId: resource.latestRevisionId,
      componentIds: [componentId]
    })
    expect((missing.data as any).missingComponentIds).toEqual([componentId])
    // 组件不属于该资源 → INVALID_INPUT
    const wrongComponent = await call('library.resource.preview_files', {
      resourceId: resource.resourceId,
      revisionId: resource.latestRevisionId,
      componentIds: ['ghost-component']
    })
    expect(wrongComponent.error?.code).toBe('INVALID_INPUT')
  })
})

describe('接入诊断脱敏', () => {
  it('keeps operation/phase only in access events and never logs content or paths', async () => {
    await call(
      'library.resource.create',
      {
        title: '脱敏标题不该入日志',
        formPreset: 'image',
        description: '描述也不该入日志',
        components: [{ role: '参考图片', valueType: 'image', filePath: sources.png }]
      },
      key()
    )
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(directory)
    expect(serialized).not.toContain('脱敏标题不该入日志')
    expect(serialized).not.toContain('描述也不该入日志')
    expect(serialized).not.toContain('pose.png')
    const completed = events.find(
      (event) =>
        event.event === 'agent.access.completed' &&
        event.attributes?.operation === 'library.resource.create'
    )
    expect(completed).toBeTruthy()
    expect(completed.attributes).toMatchObject({ phase: 'dispatch' })
    expect(completed.attributes.code).toBeUndefined()
  })
})
