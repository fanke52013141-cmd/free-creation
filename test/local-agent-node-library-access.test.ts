// F7 节点库外部接入测试：node.library.compose / update / delete / get / search / insert。
//
// 覆盖：全类型组合保存（含连线拓扑与媒体引用、排除聊天历史）、旧 chat 预设保存兼容、
// 跨项目实例化（节点 ID/连线/媒体全部重映射，不跨项目串用媒体）、幂等重放不产生第二份、
// 删除后不再返回且插入报 NOT_FOUND、非法参数与不存在目标明确拒绝、准入前失败的媒体补偿。
// 权威宿主用受控 AccessDesktop 替身（与 local-agent-graph-access 同一做法）：它模拟
// renderer 的 node.create/edge.create 应用与正式保存，不模拟点击或绕过保存屏障。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasNode } from '../src/shared/types'
import { closeDb, getDataDir } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { listMedia } from '../src/main/store/media.repo'
import { getWorkflowTemplate, saveWorkflowTemplate } from '../src/main/store/workspace-state.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { DesktopAccessError, type AccessDesktop } from '../src/main/agent-access/desktop'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory: string
let service: LocalAccessService
let active: string | null
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

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

function node(
  id: string,
  type: CanvasNode['type'],
  options: Partial<CanvasNode> & { config?: string; text?: string }
): CanvasNode {
  return {
    id: `shape:${id}`,
    type,
    contractVersion: 1,
    title: options.title ?? id,
    x: options.x ?? 0,
    y: options.y ?? 0,
    w: options.w ?? 340,
    h: options.h ?? 260,
    ports: options.ports ?? [],
    params: { ...(options.config ? { config: options.config } : {}) },
    content: options.content ?? (options.text ? { kind: 'text', text: options.text } : { kind: 'empty' }),
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  }
}

/** 受控权威宿主：按 graph.patch 载荷应用节点/连线并经正式保存落盘，随后回执 ID 映射。 */
function createFakeHost(options: {
  failBeforeCommit?: DesktopAccessError
  failAfterCommit?: DesktopAccessError
} = {}): { host: AccessDesktop; calls: any[] } {
  const calls: any[] = []
  const host: AccessDesktop = {
    run: async (request, commit) => {
      calls.push(request)
      if (request.action !== 'graph-patch')
        throw new DesktopAccessError('UNEXPECTED_ACTION', false)
      const projectId = String(request.projectId)
      const before = openProject(projectId)!
      if (options.failBeforeCommit) throw options.failBeforeCommit
      commit?.(before.meta.graphVersion)
      if (options.failAfterCommit) throw options.failAfterCommit
      const nodes = [...before.nodes]
      const edges = [...before.edges]
      const refs = new Map<string, string>()
      const created: Array<{ ref?: string; nodeId: string }> = []
      let nodeCreated = 0
      let edgeCreated = 0
      let counter = 0
      for (const raw of (request.ops ?? []) as any[]) {
        counter += 1
        if (raw.action === 'node.create') {
          const id = `shape:host-${counter}`
          if (raw.ref) refs.set(raw.ref, id)
          const config = raw.config ? JSON.stringify(raw.config) : ''
          nodes.push({
            id,
            type: raw.nodeType,
            contractVersion: 1,
            title: raw.title ?? raw.nodeType,
            x: raw.x,
            y: raw.y,
            w: raw.w ?? 340,
            h: raw.h ?? 260,
            ports: [],
            params: {
              ...(config ? { config } : {}),
              ...(raw.media ? { mediaMime: 'image/png' } : {})
            },
            content: raw.media
              ? { kind: 'media', mediaId: raw.media.mediaId }
              : raw.text
                ? { kind: 'text', text: raw.text }
                : { kind: 'empty' },
            exec: { status: 'idle' },
            meta: { source: 'input', createdAt: 2 }
          } as CanvasNode)
          created.push({ ...(raw.ref ? { ref: raw.ref } : {}), nodeId: id })
          nodeCreated += 1
          continue
        }
        if (raw.action === 'edge.create') {
          const id = `shape:host-edge-${counter}`
          edges.push({
            id,
            from: { nodeId: refs.get(raw.from.nodeId) ?? raw.from.nodeId, portId: raw.from.portId },
            to: { nodeId: refs.get(raw.to.nodeId) ?? raw.to.nodeId, portId: raw.to.portId },
            ...(raw.connectOrder ? { connectOrder: raw.connectOrder } : {})
          })
          created.push({ ...(raw.ref ? { ref: raw.ref } : {}), nodeId: id })
          edgeCreated += 1
          continue
        }
        throw new DesktopAccessError('UNEXPECTED_OP', false)
      }
      const saved = saveProject({
        id: projectId,
        expectedGraphVersion: before.meta.graphVersion,
        graph: { nodes, edges, groups: before.groups }
      })!
      return {
        graphVersion: saved.graphVersion,
        result: { created, counts: { nodeCreated, nodeUpdated: 0, nodeDeleted: 0, edgeCreated, edgeDeleted: 0 } }
      }
    }
  }
  return { host, calls }
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

function writeImageFile(name: string): string {
  const path = join(directory, name)
  writeFileSync(
    path,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9])
  )
  return path
}

/** 直接读条目原始 payload（核对“节点库里真实存了什么”，而不是只看回执）。 */
function saveWorkflowTemplateRecord(entryId: string): { nodes: unknown[]; edges: unknown[] } {
  const record = getWorkflowTemplate(entryId)
  if (!record) throw new Error('ENTRY_NOT_STORED')
  return record
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-node-library-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
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
    !basename(directory).startsWith('canvas-node-library-test-')
  )
    throw new Error('NODE_LIBRARY_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

/** 建源项目：图片(带媒体)+裁剪+文本，图片→裁剪一条连线，图片配置里再引用第二张媒体。 */
async function seedSourceProject(): Promise<{
  sourceId: string
  contentMediaId: string
  configMediaId: string
  version: number
}> {
  const p = createProject('源画布')
  const importedA = await call('media.import', { projectId: p.id, filePath: writeImageFile('a.png') }, key())
  const importedB = await call('media.import', { projectId: p.id, filePath: writeImageFile('b.png') }, key())
  expect(importedA.status).toBe('completed')
  expect(importedB.status).toBe('completed')
  const contentMediaId = (importedA.data as any).mediaId as string
  const configMediaId = (importedB.data as any).mediaId as string
  const imageNode = node('img', 'image', {
    title: '参考图',
    x: 100,
    y: 100,
    config: JSON.stringify({ referenceMediaId: configMediaId }),
    content: { kind: 'media', mediaId: contentMediaId }
  })
  const cropNode = node('crop', 'image-crop', {
    title: '裁剪',
    x: 520,
    y: 100,
    text: '',
    config: JSON.stringify({ mode: 'rect', ratio: '1:1' })
  })
  const textNode = node('txt', 'text', { title: '说明', x: 520, y: 500, text: '多节点组合说明' })
  const version = saveProject({
    id: p.id,
    graph: {
      nodes: [imageNode, cropNode, textNode],
      edges: [
        {
          id: 'shape:e1',
          from: { nodeId: 'shape:img', portId: 'out-image' },
          to: { nodeId: 'shape:crop', portId: 'in-image' }
        }
      ],
      groups: []
    },
    tldrawSnapshot: {
      store: {
        'shape:img': {
          type: 'node-card',
          props: {
            nodeType: 'image',
            title: '参考图',
            w: 340,
            h: 260,
            text: '生图提示词',
            config: JSON.stringify({ referenceMediaId: configMediaId }),
            mediaId: contentMediaId,
            mediaPath: '',
            mediaMime: 'image/png'
          }
        }
      }
    }
  })!.graphVersion
  return { sourceId: p.id, contentMediaId, configMediaId, version }
}

describe('local Agent node library access', () => {
  it('composes an all-type selection with topology and media, then inserts it into another canvas', async () => {
    const source = await seedSourceProject()
    const composed = await call(
      'node.library.compose',
      {
        projectId: source.sourceId,
        expectedGraphVersion: source.version,
        name: '图片处理组合',
        nodeIds: ['shape:img', 'shape:crop', 'shape:txt']
      },
      key()
    )
    expect(composed.status).toBe('completed')
    const entryId = (composed.data as any).id as string
    expect(composed.data).toMatchObject({ name: '图片处理组合', nodeCount: 3 })

    // 条目详情：不返回配置正文，只给存在性与媒体引用。
    const detail = await call('node.library.get', { entryId })
    expect(detail.status).toBe('completed')
    const entry = detail.data as any
    expect(entry.impact).toEqual({ nodeCount: 3, edgeCount: 1, groupCount: 0 })
    expect(entry.nodes.map((item: any) => item.nodeType)).toEqual(['image', 'image-crop', 'text'])
    expect(entry.nodes[0]).toMatchObject({ hasText: true, mediaId: source.contentMediaId, mediaRefCount: 1 })
    expect(entry.nodes[1]).toMatchObject({ hasText: false })
    expect(entry.edges).toEqual([
      { fromIdx: 0, toIdx: 1, fromPort: 'out-image', toPort: 'in-image' }
    ])
    // 详情不回显配置正文
    expect(JSON.stringify(detail)).not.toContain('1:1')

    // 目标画布：空项目，作为当前打开画布。
    const target = createProject('目标画布')
    const targetVersion = openProject(target.id)!.meta.graphVersion
    active = target.id
    const fake = createFakeHost()
    withDesktop(fake.host)
    const insertKey = key()
    const inserted = await call(
      'node.library.insert',
      { projectId: target.id, expectedGraphVersion: targetVersion, entryId, x: 1000, y: 2000 },
      insertKey
    )
    expect(inserted.status).toBe('completed')
    const receipt = inserted.data as any
    expect(receipt).toMatchObject({
      projectId: target.id,
      entryId,
      saved: true,
      applied: { nodeCreated: 3, edgeCreated: 1 },
      skippedEdges: 0
    })
    // 媒体全部重映射：每个条目媒体各复制一份到目标项目。
    expect(receipt.media).toHaveLength(2)
    const remap = new Map<string, string>(
      receipt.media.map((item: any) => [item.entryMediaId, item.mediaId])
    )
    expect(remap.get(source.contentMediaId)).toBeTruthy()
    expect(remap.get(source.configMediaId)).toBeTruthy()
    expect(remap.get(source.contentMediaId)).not.toBe(source.contentMediaId)

    const targetFile = openProject(target.id)!
    expect(targetFile.nodes).toHaveLength(3)
    expect(targetFile.edges).toHaveLength(1)
    // 节点 ID 全部重映射（不是源项目 ID）
    const sourceIds = new Set(['shape:img', 'shape:crop', 'shape:txt', 'shape:e1'])
    for (const created of targetFile.nodes) expect(sourceIds.has(created.id)).toBe(false)
    expect(sourceIds.has(targetFile.edges[0].id)).toBe(false)
    // 连线指向新 ID
    expect(targetFile.edges[0].from.portId).toBe('out-image')
    expect(targetFile.edges[0].to.portId).toBe('in-image')
    expect(targetFile.nodes.some((item) => item.id === targetFile.edges[0].from.nodeId)).toBe(true)
    expect(targetFile.nodes.some((item) => item.id === targetFile.edges[0].to.nodeId)).toBe(true)
    // 媒体归属：目标节点的媒体 ID 是目标项目的新媒体，源媒体不被引用
    const imageNode = targetFile.nodes.find((item) => item.type === 'image')!
    expect(imageNode.content.kind).toBe('media')
    expect((imageNode.content as { mediaId: string }).mediaId).toBe(remap.get(source.contentMediaId))
    const config = JSON.parse(String(imageNode.params.config))
    expect(config.referenceMediaId).toBe(remap.get(source.configMediaId))
    const targetMediaIds = new Set(listMedia(target.id).map((asset) => asset.id))
    for (const [sourceMedia] of remap) expect(targetMediaIds.has(sourceMedia)).toBe(false)
    for (const mediaId of remap.values()) expect(targetMediaIds.has(mediaId)).toBe(true)
    // 媒体文件落在目标项目作用域（不跨项目串用）
    for (const mediaId of remap.values()) {
      const asset = listMedia(target.id).find((candidate) => candidate.id === mediaId)!
      expect(asset.path.startsWith(`projects/${target.id}/media/`)).toBe(true)
    }
    // 位置 = 落点 + 保存时的相对偏移（源项目三点相对质心的偏移被保留）
    const textNode = targetFile.nodes.find((item) => item.type === 'text')!
    expect([textNode.x, textNode.y]).toEqual([1140, 2266.67])
    // 参数与正文一致
    expect(textNode.content).toEqual({ kind: 'text', text: '多节点组合说明' })
    expect(JSON.parse(String(targetFile.nodes.find((item) => item.type === 'image-crop')!.params.config))).toEqual({
      mode: 'rect',
      ratio: '1:1'
    })
    // 手给宿主的是 mediaId 事实（media 操作里没有路径），且媒体已在目标项目登记
    const sent = fake.calls[0]
    expect(sent.action).toBe('graph-patch')
    expect(JSON.stringify(sent.ops)).not.toContain('projects/')
    for (const op of sent.ops.filter((item: any) => item.media)) {
      expect(sent.mediaResolutions[op.media.mediaId]).toMatchObject({ mediaId: op.media.mediaId })
    }
    // 图片节点保存的提示词经 props 带入 op.text（媒体节点的正文不会被内容投影吞掉）
    const imageOp = sent.ops.find((op: any) => op.nodeType === 'image')
    expect(imageOp.text).toBe('生图提示词')
    // 条目引用的源媒体仍在源项目，未被搬走或删除
    expect(listMedia(source.sourceId)).toHaveLength(2)

    // 幂等重放：同一幂等键返回原回执，画布不产生第二份。
    const replay = await call(
      'node.library.insert',
      { projectId: target.id, expectedGraphVersion: targetVersion, entryId, x: 1000, y: 2000 },
      insertKey
    )
    expect(replay.data).toEqual(receipt)
    expect(openProject(target.id)!.nodes).toHaveLength(3)
    expect(fake.calls).toHaveLength(1)
    expect(listMedia(target.id)).toHaveLength(2)
  })

  it('keeps the legacy chat skill preset save working and inserts it too', async () => {
    const p = createProject('对话项目')
    const agent = {
      skills: [
        {
          schemaVersion: 1,
          id: 's1',
          version: '1.0.0',
          name: '角色设计技能',
          description: '按角色设定给出提示词',
          instructions: '只输出提示词',
          requiredTools: [],
          resources: {}
        }
      ],
      maxSteps: 6
    }
    const chat = node('chat1', 'chat', {
      title: '技能助手',
      w: 360,
      h: 300,
      text: JSON.stringify({
        system: '私有系统提示词',
        conversations: [
          {
            id: 'conv-1',
            title: '历史',
            messages: [{ role: 'user', content: '私有聊天记录' }],
            createdAt: 1,
            updatedAt: 2
          }
        ],
        activeConversationId: 'conv-1'
      }),
      config: JSON.stringify({ modelKey: 'private-model', agent })
    })
    const version = saveProject({ id: p.id, graph: { nodes: [chat], edges: [], groups: [] } })!
      .graphVersion
    // 旧操作原样可用：单 chat 节点技能预设。
    const saved = await call(
      'node.library.save',
      { projectId: p.id, expectedGraphVersion: version, nodeId: 'shape:chat1', name: '旧技能预设' },
      key()
    )
    expect(saved.status).toBe('completed')
    const entryId = (saved.data as any).id as string
    const listed = await call('node.library.list', {})
    expect((listed.data as any).items.map((item: any) => item.id)).toContain(entryId)
    const detail = await call('node.library.get', { entryId })
    expect(detail.status).toBe('completed')
    const entry = detail.data as any
    expect(entry.nodes).toHaveLength(1)
    expect(entry.nodes[0]).toMatchObject({ nodeType: 'chat', hasText: false })
    // 聊天历史/附件/模型选择不进节点库
    const stored = JSON.stringify(detail)
    expect(stored).not.toContain('私有聊天记录')
    expect(stored).not.toContain('私有系统提示词')
    expect(stored).not.toContain('private-model')
    const chatEntry = saveWorkflowTemplateRecord(entryId)
    const storedConfig = JSON.parse(String((chatEntry.nodes[0] as any).config))
    expect(storedConfig.agent.skills[0]).toMatchObject({ id: 's1', version: '1.0.0' })
    expect((chatEntry.nodes[0] as any).text).toBe('')

    // 旧条目也能被实例化到另一张画布（同一 insert 通道）
    const target = createProject('目标画布')
    active = target.id
    const fake = createFakeHost()
    withDesktop(fake.host)
    const inserted = await call(
      'node.library.insert',
      {
        projectId: target.id,
        expectedGraphVersion: openProject(target.id)!.meta.graphVersion,
        entryId
      },
      key()
    )
    expect(inserted.status).toBe('completed')
    const file = openProject(target.id)!
    expect(file.nodes).toHaveLength(1)
    expect(file.nodes[0].type).toBe('chat')
    expect(JSON.parse(String(file.nodes[0].params.config))).toMatchObject({
      agent: {
        skills: [{ id: 's1', version: '1.0.0' }],
        maxSteps: 6
      }
    })
  })

  it('deletes entries without ghosts, renames them and searches by name/title/type', async () => {
    const source = await seedSourceProject()
    const composed = await call(
      'node.library.compose',
      {
        projectId: source.sourceId,
        expectedGraphVersion: source.version,
        name: '分镜组合',
        nodeIds: ['shape:img', 'shape:txt']
      },
      key()
    )
    const entryId = (composed.data as any).id as string
    const renamed = await call('node.library.update', { entryId, name: '分镜组合 v2' }, key())
    expect(renamed.data).toMatchObject({ id: entryId, name: '分镜组合 v2', nodeCount: 2 })
    expect((await call('node.library.update', { entryId: 'missing-entry', name: 'x' }, key())).error?.code).toBe(
      'NOT_FOUND'
    )
    // 按类型 + 名称/标题过滤
    expect((await call('node.library.search', { nodeType: 'image' })).data).toMatchObject({ total: 1 })
    expect((await call('node.library.search', { nodeType: 'video' })).data).toMatchObject({ total: 0 })
    expect((await call('node.library.search', { query: 'v2' })).data).toMatchObject({ total: 1 })
    expect((await call('node.library.search', { query: '说明' })).data).toMatchObject({ total: 1 })
    const page = await call('node.library.search', { query: '分镜', offset: 0, limit: 10 })
    expect((page.data as any).items[0]).toMatchObject({
      id: entryId,
      nodeCount: 2,
      nodeTypes: ['image', 'text']
    })
    // 删除后条目不再出现在 list/search，插入已删除条目报 NOT_FOUND
    expect((await call('node.library.delete', { entryId }, key())).data).toEqual({
      entryId,
      deleted: true
    })
    expect((await call('node.library.delete', { entryId }, key())).error?.code).toBe('NOT_FOUND')
    const listed = await call('node.library.list', {})
    expect((listed.data as any).items.map((item: any) => item.id)).not.toContain(entryId)
    expect((await call('node.library.search', { query: '分镜' })).data).toMatchObject({ total: 0 })
    const target = createProject('目标画布')
    active = target.id
    withDesktop(createFakeHost().host)
    const ghost = await call(
      'node.library.insert',
      {
        projectId: target.id,
        expectedGraphVersion: openProject(target.id)!.meta.graphVersion,
        entryId
      },
      key()
    )
    expect(ghost.status).toBe('failed')
    expect(ghost.error?.code).toBe('NOT_FOUND')
  })

  it('rejects invalid parameters, wrong versions, non-active targets and corrupt entries', async () => {
    const source = await seedSourceProject()
    expect(
      (
        await call(
          'node.library.compose',
          {
            projectId: source.sourceId,
            expectedGraphVersion: source.version,
            name: 'x',
            nodeIds: ['shape:missing']
          },
          key()
        )
      ).error?.code
    ).toBe('NODE_NOT_FOUND')
    expect(
      (
        await call(
          'node.library.compose',
          {
            projectId: source.sourceId,
            expectedGraphVersion: source.version + 5,
            name: 'x',
            nodeIds: ['shape:img']
          },
          key()
        )
      ).error?.code
    ).toBe('REVISION_CONFLICT')
    // 空 nodeIds / 超界坐标等 Schema 级拒绝
    expect(
      (
        await call(
          'node.library.compose',
          { projectId: source.sourceId, expectedGraphVersion: source.version, name: 'x', nodeIds: [] },
          key()
        )
      ).error?.code
    ).toBe('INVALID_INPUT')
    const composed = await call(
      'node.library.compose',
      {
        projectId: source.sourceId,
        expectedGraphVersion: source.version,
        name: '合法条目',
        nodeIds: ['shape:img']
      },
      key()
    )
    const entryId = (composed.data as any).id as string
    const target = createProject('未打开目标')
    // 目标画布不在桌面打开 → 与 graph.patch 同一等待动作
    withDesktop(createFakeHost().host)
    active = null
    expect(
      (
        await call(
          'node.library.insert',
          {
            projectId: target.id,
            expectedGraphVersion: openProject(target.id)!.meta.graphVersion,
            entryId
          },
          key()
        )
      ).error?.code
    ).toBe('ACTIVE_PROJECT_REQUIRED')
    active = target.id
    withDesktop(createFakeHost().host)
    expect(
      (
        await call(
          'node.library.insert',
          { projectId: target.id, expectedGraphVersion: 99, entryId },
          key()
        )
      ).error?.code
    ).toBe('REVISION_CONFLICT')
    // 条目 payload 损坏：明确拒绝，不按空条目插入
    const corrupt = saveWorkflowTemplate({
      name: '损坏条目',
      nodes: [{ nodeType: 'text' }],
      edges: [],
      nodeCount: 1
    })
    expect(
      (
        await call(
          'node.library.insert',
          {
            projectId: target.id,
            expectedGraphVersion: openProject(target.id)!.meta.graphVersion,
            entryId: corrupt.id
          },
          key()
        )
      ).error?.code
    ).toBe('ENTRY_INVALID')
    expect(openProject(target.id)!.nodes).toHaveLength(0)
  })

  it('compensates copied media when the host refuses before admission and keeps it after unknown', async () => {
    const source = await seedSourceProject()
    const composed = await call(
      'node.library.compose',
      {
        projectId: source.sourceId,
        expectedGraphVersion: source.version,
        name: '媒体组合',
        nodeIds: ['shape:img']
      },
      key()
    )
    const entryId = (composed.data as any).id as string
    const target = createProject('补偿目标')
    active = target.id
    // 准入前失败：媒体已复制但画布未改 → 复制必须回滚（目标项目不留下孤儿媒体）。
    withDesktop(
      createFakeHost({ failBeforeCommit: new DesktopAccessError('PATCH_NOT_ADMITTED', false) }).host
    )
    const refused = await call(
      'node.library.insert',
      {
        projectId: target.id,
        expectedGraphVersion: openProject(target.id)!.meta.graphVersion,
        entryId
      },
      key()
    )
    expect(refused.status).toBe('failed')
    expect(refused.error?.code).toBe('PATCH_NOT_ADMITTED')
    expect(listMedia(target.id)).toHaveLength(0)
    expect(openProject(target.id)!.nodes).toHaveLength(0)

    // 准入后失败：按 unknown 处理，媒体保留（可能已被宿主引用），不盲目重放。
    const afterCommit = createFakeHost({
      failAfterCommit: new DesktopAccessError('APPLY_CRASHED', true)
    })
    withDesktop(afterCommit.host)
    const unknown = await call(
      'node.library.insert',
      {
        projectId: target.id,
        expectedGraphVersion: openProject(target.id)!.meta.graphVersion,
        entryId
      },
      key()
    )
    expect(unknown.status).toBe('unknown')
    expect(unknown.error?.code).toBe('OUTCOME_UNKNOWN')
    expect(listMedia(target.id)).toHaveLength(2)
  })
})
