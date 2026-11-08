// F7 包传输外部接入测试：project.import / project.importStructure / library.import / library.export
//
// 覆盖本包独立验收要求：
// - 导出→导入往返：节点/连线/分组/参数/配方/媒体一致，媒体在新项目下真实可读且不与源项目混用；
// - 密钥剥离：含 provider/API Key 字段的项目包在导出与导入两侧都不带明文凭据；
// - 损坏包：缺清单/版本不兼容/条目哈希不符被拒，且不留项目、暂存目录或半成品资源；
// - 失败清理：导入中途失败后 projects.list 无新项目、`*.importing` 暂存目录被清理；
// - 幂等重放：同一 idempotencyKey 只产生一个项目；
// - 边界：包文件只接受受控导出目录内的路径，目录外/穿越路径被拒绝（PATH_NOT_ALLOWED）；
// - 资源包：导出回执 sha256/字节数、不覆盖已有文件、导入重复包拒绝、损坏包回滚。
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { CanvasEdge, CanvasNode } from '../src/shared/types'
import { closeDb, getDataDir, getDb } from '../src/main/store/db'
import {
  createProject,
  getProject,
  openProject,
  saveProject
} from '../src/main/store/projects.repo'
import { listMedia } from '../src/main/store/media.repo'
import { listArtifactRecipes, saveArtifactRecipe } from '../src/main/store/artifact-recipes.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory: string
let service: LocalAccessService
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = (): string => `${Date.now()}:${randomUUID()}`

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
])

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

function exportRoot(): string {
  return join(getDataDir(), 'agent-exports')
}

function projectsDir(): string {
  return join(getDataDir(), 'projects')
}

function stagedDirectories(): string[] {
  if (!existsSync(projectsDir())) return []
  return readdirSync(projectsDir()).filter((name) => name.includes('.importing'))
}

function projectTotal(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM projects WHERE deleted = 0').get() as { n: number })
    .n
}

function libraryResourceTotal(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM library_resources').get() as { n: number }).n
}

function libraryImportTotal(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM library_imports').get() as { n: number }).n
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 在受控导出目录内写一个 zip 包（外部导入只接受这个目录内的文件）。 */
function writePackageInExportRoot(
  fileName: string,
  entries: Array<[string, Buffer | string]>
): string {
  mkdirSync(exportRoot(), { recursive: true })
  const zip = new AdmZip()
  for (const [entryName, data] of entries) {
    zip.addFile(entryName, Buffer.isBuffer(data) ? data : Buffer.from(data))
  }
  const destination = join(exportRoot(), fileName)
  zip.writeZip(destination)
  return destination
}

function imageNode(id: string, mediaId: string, mediaPath: string): CanvasNode {
  return {
    id: `shape:${id}`,
    type: 'image',
    contractVersion: 2,
    title: '图片',
    x: 0,
    y: 0,
    w: 240,
    h: 180,
    ports: [],
    params: { mediaPath, mediaMime: 'image/png' },
    content: { kind: 'media', mediaId },
    exec: { status: 'idle' },
    meta: { source: 'upload', createdAt: 1 }
  }
}

function directorNode(id: string, mediaId: string): CanvasNode {
  return {
    id: `shape:${id}`,
    type: 'director',
    contractVersion: 1,
    title: '导演台',
    x: 320,
    y: 0,
    w: 320,
    h: 240,
    ports: [],
    params: { config: JSON.stringify({ shots: [{ referenceMediaIds: [mediaId] }] }) },
    content: { kind: 'empty' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  }
}

function roundTripEdge(): CanvasEdge {
  return {
    id: 'shape:edge1',
    from: { nodeId: 'shape:image1', portId: 'out-image' },
    to: { nodeId: 'shape:director1', portId: 'in-reference' }
  }
}

/** tldraw 快照：媒体引用同时出现在 node-card props、meta.nodeResult 与 binding 端点。 */
function roundTripSnapshot(mediaId: string, mediaPath: string): unknown {
  return {
    store: {
      'document:doc': { typeName: 'document', id: 'document:doc' },
      'page:page': { typeName: 'page', id: 'page:page' },
      'shape:image1': {
        typeName: 'shape',
        type: 'node-card',
        props: {
          nodeType: 'image',
          mediaId,
          mediaPath,
          mediaMime: 'image/png',
          config: JSON.stringify({ modelKey: 'test-model', referenceMediaIds: [mediaId] }),
          exec: 'success'
        },
        meta: {
          nodeResult: {
            kind: 'image',
            frame: { mediaId, mediaPath },
            referenceMediaIds: [mediaId]
          }
        }
      },
      'shape:director1': {
        typeName: 'shape',
        type: 'node-card',
        props: { nodeType: 'director', mediaId: '', mediaPath: '', config: '{}' },
        meta: {}
      },
      'binding:b1': {
        typeName: 'binding',
        fromId: 'shape:image1',
        toId: 'shape:director1',
        props: {}
      },
      'camera:c1': { typeName: 'camera', x: 0, y: 0, z: 1 }
    }
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-transfer-access-test-'))
  process.env.CANVAS_DATA_DIR = directory
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
    activeProjectId: () => null
  })
})

afterEach(() => {
  closeDb()
  setGatewayEventSink(null)
  process.env.CANVAS_DATA_DIR = originalDirectory
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-transfer-access-test-')
  )
    throw new Error('TRANSFER_ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('project.export → project.import round trip', () => {
  it('remaps nodes/edges/groups/snapshot/recipe media into a readable, editable new project', async () => {
    const project = createProject('往返源项目')
    const sourceImage = join(directory, 'roundtrip.png')
    writeFileSync(sourceImage, PNG_BYTES)
    const mediaImport = await call('media.import', { projectId: project.id, filePath: sourceImage }, key())
    expect(mediaImport.status).toBe('completed')
    const media = mediaImport.data as { mediaId: string; path: string }
    const image = imageNode('image1', media.mediaId, media.path)
    const director = directorNode('director1', media.mediaId)
    const saved = saveProject({
      id: project.id,
      graph: {
        nodes: [image, director],
        edges: [roundTripEdge()],
        groups: [{ id: 'shape:group1', name: '分组', nodeIds: ['shape:image1'], kind: 'plain' }]
      },
      tldrawSnapshot: roundTripSnapshot(media.mediaId, media.path)
    })!
    saveArtifactRecipe({
      projectId: project.id,
      mediaId: media.mediaId,
      runId: 'run:source',
      producerNodeId: 'shape:image1',
      nodeType: 'image',
      contractVersion: 2,
      fullPrompt: '提示词保持原样',
      paramsJson: JSON.stringify({ referenceMediaIds: [media.mediaId] }),
      inputMediaIds: [media.mediaId],
      createdAt: 1
    })

    const exported = await call(
      'project.export',
      {
        projectId: project.id,
        expectedGraphVersion: saved.graphVersion,
        fileName: 'roundtrip.canvasbundle'
      },
      key()
    )
    expect(exported.status).toBe('completed')
    const exportReceipt = exported.data as { sha256: string; byteSize: number; path: string }
    expect(existsSync(exportReceipt.path)).toBe(true)

    const imported = await call('project.import', { filePath: 'roundtrip.canvasbundle' }, key())
    expect(imported.status).toBe('completed')
    const receipt = imported.data as any
    expect(receipt.meta.id).not.toBe(project.id)
    expect(receipt.sha256).toBe(exportReceipt.sha256)
    expect(receipt.byteSize).toBe(exportReceipt.byteSize)
    expect(receipt).toMatchObject({
      nodeCount: 2,
      edgeCount: 1,
      groupCount: 1,
      mediaCount: 1,
      missingMediaCount: 0,
      committed: true
    })

    const newProjectId = receipt.meta.id as string
    const file = openProject(newProjectId)!
    expect(file.meta.graphVersion).toBe(0)
    const newImage = file.nodes.find((node) => node.type === 'image')!
    const newDirector = file.nodes.find((node) => node.type === 'director')!
    // 节点 ID、连线端点、分组成员全部重映射到新项目身份。
    expect(newImage.id).not.toBe(image.id)
    expect(newDirector.id).not.toBe(director.id)
    expect(file.edges).toHaveLength(1)
    expect(file.edges[0].id).not.toBe('shape:edge1')
    expect(file.edges[0].from.nodeId).toBe(newImage.id)
    expect(file.edges[0].to.nodeId).toBe(newDirector.id)
    expect(file.groups[0].id).not.toBe('shape:group1')
    expect(file.groups[0].nodeIds).toEqual([newImage.id])

    // 媒体 ID 与相对路径全量重映射，且新项目目录下真实可读、字节与源一致。
    const newMediaId = (newImage.content as { kind: 'media'; mediaId: string }).mediaId
    expect(newMediaId).not.toBe(media.mediaId)
    const newMediaPath = `projects/${newProjectId}/media/${newMediaId}.png`
    expect(newImage.params.mediaPath).toBe(newMediaPath)
    const newMediaAbs = join(getDataDir(), newMediaPath)
    expect(existsSync(newMediaAbs)).toBe(true)
    expect(readFileSync(newMediaAbs).equals(PNG_BYTES)).toBe(true)

    const importedMedia = listMedia(newProjectId)
    expect(importedMedia).toHaveLength(1)
    expect(importedMedia[0]).toMatchObject({
      id: newMediaId,
      path: newMediaPath,
      sizeBytes: PNG_BYTES.byteLength
    })

    // 源项目媒体保持独立可读，新包没有复用/覆盖源项目的相对路径。
    expect(listMedia(project.id)[0].path).toBe(media.path)
    expect(existsSync(join(getDataDir(), media.path))).toBe(true)
    expect(newMediaPath).not.toBe(media.path)

    // 导演台引用（config 内嵌 JSON 字符串）与 tldrawSnapshot nodeResult 引用都被重映射。
    const directorConfig = JSON.parse(String(newDirector.params.config)) as {
      shots: Array<{ referenceMediaIds: string[] }>
    }
    expect(directorConfig.shots[0].referenceMediaIds).toEqual([newMediaId])
    const snapshotStore = (file.tldrawSnapshot as any).store as Record<string, any>
    expect(snapshotStore['shape:image1']).toBeUndefined()
    const snapshotImage = Object.values(snapshotStore).find(
      (record) => record?.type === 'node-card' && record?.props?.nodeType === 'image'
    )!
    expect(snapshotImage.props.mediaId).toBe(newMediaId)
    expect(snapshotImage.props.mediaPath).toBe(newMediaPath)
    expect(snapshotImage.meta.nodeResult.frame.mediaId).toBe(newMediaId)
    expect(snapshotImage.meta.nodeResult.frame.mediaPath).toBe(newMediaPath)
    expect(snapshotImage.meta.nodeResult.referenceMediaIds).toEqual([newMediaId])

    // 产物配方随包迁移：媒体引用重映射，提示词原样保留。
    const recipes = listArtifactRecipes(newProjectId)
    expect(recipes).toHaveLength(1)
    expect(recipes[0].mediaId).toBe(newMediaId)
    expect(JSON.parse(recipes[0].paramsJson).referenceMediaIds).toEqual([newMediaId])
    expect(recipes[0].inputMediaIds).toEqual([newMediaId])
    expect(recipes[0].fullPrompt).toBe('提示词保持原样')

    // 导入的项目可继续编辑：以导入版本为乐观锁保存成功。
    const edited = saveProject({
      id: newProjectId,
      graph: { nodes: file.nodes, edges: file.edges, groups: file.groups },
      expectedGraphVersion: file.meta.graphVersion
    })!
    expect(edited.graphVersion).toBe(1)
    expect(getProject(newProjectId)!.graphVersion).toBe(1)
    expect(projectTotal()).toBe(2)
    expect(stagedDirectories()).toEqual([])

    // 日志只携带操作/阶段/代码等受控字段，不带包内容或路径。
    const accessEvents = events.filter((event) => event.event?.startsWith('agent.access.'))
    expect(accessEvents.some((event) => event.event === 'agent.access.started')).toBe(true)
    expect(accessEvents.some((event) => event.event === 'agent.access.completed')).toBe(true)
    expect(JSON.stringify(events)).not.toContain('roundtrip.canvasbundle')
    expect(JSON.stringify(events)).not.toContain('提示词保持原样')
  })

  it('creates one project per package and never shares media identities across projects', async () => {
    const project = createProject('跨项目媒体')
    const sourceImage = join(directory, 'cross.png')
    writeFileSync(sourceImage, PNG_BYTES)
    const mediaImport = await call('media.import', { projectId: project.id, filePath: sourceImage }, key())
    const media = mediaImport.data as { mediaId: string; path: string }
    const saved = saveProject({
      id: project.id,
      graph: {
        nodes: [imageNode('image1', media.mediaId, media.path)],
        edges: [],
        groups: []
      }
    })!
    const exported = await call(
      'project.export',
      { projectId: project.id, expectedGraphVersion: saved.graphVersion, fileName: 'cross.canvasbundle' },
      key()
    )
    expect(exported.status).toBe('completed')

    const first = (await call('project.import', { filePath: 'cross.canvasbundle' }, key())).data as any
    const second = (await call('project.import', { filePath: 'cross.canvasbundle' }, key())).data as any
    expect(first.meta.id).not.toBe(second.meta.id)
    const firstMedia = listMedia(first.meta.id)
    const secondMedia = listMedia(second.meta.id)
    expect(firstMedia).toHaveLength(1)
    expect(secondMedia).toHaveLength(1)
    expect(firstMedia[0].id).not.toBe(secondMedia[0].id)
    expect(firstMedia[0].path).not.toBe(secondMedia[0].path)
    expect(firstMedia[0].path.startsWith(`projects/${first.meta.id}/media/`)).toBe(true)
    expect(secondMedia[0].path.startsWith(`projects/${second.meta.id}/media/`)).toBe(true)
    expect(existsSync(join(getDataDir(), firstMedia[0].path))).toBe(true)
    expect(existsSync(join(getDataDir(), secondMedia[0].path))).toBe(true)
    expect(existsSync(join(getDataDir(), media.path))).toBe(true)
    expect(projectTotal()).toBe(3)
  })

  it('replays the same idempotency key into exactly one project', async () => {
    const project = createProject('幂等源')
    const sourceImage = join(directory, 'idem.png')
    writeFileSync(sourceImage, PNG_BYTES)
    const mediaImport = await call('media.import', { projectId: project.id, filePath: sourceImage }, key())
    const media = mediaImport.data as { mediaId: string; path: string }
    const saved = saveProject({
      id: project.id,
      graph: { nodes: [imageNode('image1', media.mediaId, media.path)], edges: [], groups: [] }
    })!
    await call(
      'project.export',
      { projectId: project.id, expectedGraphVersion: saved.graphVersion, fileName: 'idem.canvasbundle' },
      key()
    )
    const replayKey = key()
    const first = await call('project.import', { filePath: 'idem.canvasbundle' }, replayKey)
    expect(first.status).toBe('completed')
    const second = await call('project.import', { filePath: 'idem.canvasbundle' }, replayKey)
    expect(second.status).toBe('completed')
    expect(second.data).toEqual(first.data)
    // 源项目 + 唯一一次导入。
    expect(projectTotal()).toBe(2)
    expect(stagedDirectories()).toEqual([])
  })
})

describe('project.import security boundaries', () => {
  it('strips provider credentials from exported and imported packages', async () => {
    const project = createProject('密钥源')
    const secret = 'sk-test-plaintext-credential-123456'
    const sourceImage = join(directory, 'secret.png')
    writeFileSync(sourceImage, PNG_BYTES)
    const mediaImport = await call('media.import', { projectId: project.id, filePath: sourceImage }, key())
    const media = mediaImport.data as { mediaId: string; path: string }
    const node = imageNode('image1', media.mediaId, media.path)
    node.params = {
      ...node.params,
      config: JSON.stringify({ modelKey: 'm', apiKey: secret, provider: { api_token: secret } })
    }
    const saved = saveProject({
      id: project.id,
      graph: { nodes: [node], edges: [], groups: [] },
      tldrawSnapshot: {
        store: {
          'document:doc': { typeName: 'document' },
          'page:page': { typeName: 'page' },
          'shape:image1': {
            typeName: 'shape',
            type: 'node-card',
            props: {
              nodeType: 'image',
              mediaId: media.mediaId,
              mediaPath: media.path,
              config: JSON.stringify({ apiKey: secret })
            },
            meta: { nodeResult: JSON.stringify({ apiKey: secret, mediaId: media.mediaId }) }
          }
        }
      }
    })!
    const exported = await call(
      'project.export',
      { projectId: project.id, expectedGraphVersion: saved.graphVersion, fileName: 'secret.canvasbundle' },
      key()
    )
    expect(exported.status).toBe('completed')
    const bundlePath = join(exportRoot(), 'secret.canvasbundle')
    const zip = new AdmZip(bundlePath)
    for (const entry of zip.getEntries()) {
      expect(entry.getData().toString('utf8')).not.toContain(secret)
    }

    // 防御性验证导入侧：手工构造一个"恶意"项目包（其他工具产出），导入后同样不得保留凭据。
    const malicious = JSON.stringify({
      version: 1,
      meta: { id: 'evil-source', name: '恶意包', createdAt: 1, updatedAt: 1, graphVersion: 3 },
      nodes: [
        {
          ...imageNode('evil', 'old-media', 'projects/evil-source/media/old-media.png'),
          params: { config: JSON.stringify({ apiKey: secret }) }
        }
      ],
      edges: [],
      groups: [],
      providers: [{ apiKey: secret }],
      tldrawSnapshot: {
        store: {
          'shape:evil': {
            typeName: 'shape',
            type: 'node-card',
            props: {
              nodeType: 'image',
              mediaId: 'old-media',
              mediaPath: 'projects/evil-source/media/old-media.png',
              config: JSON.stringify({ apiKey: secret }),
              text: JSON.stringify({ authorization: `Bearer ${secret}` })
            },
            meta: { nodeResult: JSON.stringify({ apiKey: secret }) }
          }
        }
      }
    })
    writePackageInExportRoot('malicious.canvasbundle', [['project.json', malicious]])
    const imported = await call('project.import', { filePath: 'malicious.canvasbundle' }, key())
    expect(imported.status).toBe('completed')
    const importedId = (imported.data as any).meta.id as string
    const projectJson = readFileSync(join(projectsDir(), importedId, 'project.json'), 'utf-8')
    expect(projectJson).not.toContain(secret)
    expect(projectJson).not.toContain('Bearer')
    // 日志同样不得出现明文凭据。
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it('rejects damaged or incompatible project packages without leaving a half project', async () => {
    expect(projectTotal()).toBe(0)
    expect(stagedDirectories()).toEqual([])

    // 缺 project.json。
    writePackageInExportRoot('no-manifest.canvasbundle', [['bundle.json', '{"projectName":"x"}']])
    const missing = await call('project.import', { filePath: 'no-manifest.canvasbundle' }, key())
    expect(missing.status).toBe('failed')
    expect(missing.error?.code).toBe('PACKAGE_INVALID')

    // 版本不兼容。
    writePackageInExportRoot('old-version.canvasbundle', [
      [
        'project.json',
        JSON.stringify({
          version: 99,
          meta: { id: 'bad', name: '坏包', createdAt: 1, updatedAt: 1, graphVersion: 0 },
          nodes: [],
          edges: [],
          groups: []
        })
      ]
    ])
    const incompatible = await call('project.import', { filePath: 'old-version.canvasbundle' }, key())
    expect(incompatible.error?.code).toBe('PACKAGE_VERSION_UNSUPPORTED')

    // 条目哈希不符（flow 资产 digest 与 value_json 不匹配）。
    writePackageInExportRoot('bad-digest.canvasbundle', [
      [
        'project.json',
        JSON.stringify({
          version: 1,
          meta: { id: 'src', name: '哈希包', createdAt: 1, updatedAt: 1, graphVersion: 0 },
          nodes: [],
          edges: [],
          groups: []
        })
      ],
      [
        'flow-assets.json',
        JSON.stringify([
          {
            version_id: 'v1',
            asset_id: 'a1',
            project_id: 'src',
            node_id: 'shape:x',
            port_id: 'out',
            ordinal: 1,
            graph_version: 0,
            created_at: 1,
            digest: '0'.repeat(64),
            value_json: '{"kind":"text","text":"x"}'
          }
        ])
      ]
    ])
    const digestMismatch = await call('project.import', { filePath: 'bad-digest.canvasbundle' }, key())
    expect(digestMismatch.error?.code).toBe('PACKAGE_CONTENT_INVALID')

    // 非法媒体路径（子目录）与重复媒体 ID：失败发生在暂存阶段，必须清理暂存目录。
    const minimalProject = JSON.stringify({
      version: 1,
      meta: { id: 'src', name: '媒体包', createdAt: 1, updatedAt: 1, graphVersion: 0 },
      nodes: [],
      edges: [],
      groups: []
    })
    writePackageInExportRoot('bad-media-path.canvasbundle', [
      ['project.json', minimalProject],
      ['media/sub/a.png', PNG_BYTES]
    ])
    const badPath = await call('project.import', { filePath: 'bad-media-path.canvasbundle' }, key())
    expect(badPath.error?.code).toBe('PACKAGE_PATH_INVALID')

    writePackageInExportRoot('duplicate-media.canvasbundle', [
      ['project.json', minimalProject],
      ['media/dup.png', PNG_BYTES],
      ['media/dup.jpg', PNG_BYTES]
    ])
    const duplicate = await call('project.import', { filePath: 'duplicate-media.canvasbundle' }, key())
    expect(duplicate.error?.code).toBe('PACKAGE_CONTENT_INVALID')
    expect(duplicate.error?.detail).toBe('FLOW_TRANSFER_MEDIA_DUPLICATE')

    // 全部失败后：无新项目、无暂存残留、projects.list 与磁盘一致。
    expect(projectTotal()).toBe(0)
    expect(stagedDirectories()).toEqual([])
    expect((await call('project.list')).data).toMatchObject({ total: 0 })
    const failed = events.filter((event) => event.event === 'agent.access.failed')
    expect(failed.length).toBeGreaterThanOrEqual(5)
    expect(failed.every((event) => event.attributes?.operation === 'project.import')).toBe(true)
  })

  it('rejects package paths outside the controlled export directory and invalid inputs', async () => {
    mkdirSync(exportRoot(), { recursive: true })
    const outside = join(directory, 'outside.canvasbundle')
    writeFileSync(outside, 'not-a-package')

    // 绝对路径在受控目录外 → 拒绝（不暴露目录外文件是否存在）。
    expect((await call('project.import', { filePath: outside }, key())).error?.code).toBe(
      'PATH_NOT_ALLOWED'
    )
    // 相对穿越路径即使文件不存在也按越界拒绝。
    expect(
      (await call('project.import', { filePath: '../outside.canvasbundle' }, key())).error?.code
    ).toBe('PATH_NOT_ALLOWED')
    expect(
      (await call('project.import', { filePath: 'nested/../../outside.canvasbundle' }, key())).error
        ?.code
    ).toBe('PATH_NOT_ALLOWED')
    // 目录内但包不存在 / 扩展名不符 / 空输入。
    expect((await call('project.import', { filePath: 'missing.canvasbundle' }, key())).error?.code).toBe(
      'NOT_FOUND'
    )
    writePackageInExportRoot('wrong-extension.canvaslib', [['project.json', '{}']])
    expect((await call('project.import', { filePath: 'wrong-extension.canvaslib' }, key())).error?.code).toBe(
      'INVALID_INPUT'
    )
    expect((await call('project.import', {}, key())).error?.code).toBe('INVALID_INPUT')
    // 结构包与资源包同样只接受受控目录内的对应扩展名。
    expect(
      (await call('project.importStructure', { filePath: outside }, key())).error?.code
    ).toBe('PATH_NOT_ALLOWED')
    expect(
      (await call('library.import', { filePath: '../outside.canvaslib' }, key())).error?.code
    ).toBe('PATH_NOT_ALLOWED')
    expect(projectTotal()).toBe(0)
    expect(stagedDirectories()).toEqual([])
  })
})

describe('project.importStructure', () => {
  it('imports a cleaned structure package as a new project and rejects damaged structures', async () => {
    const structure = {
      format: 'canvas-studio-canvas-structure',
      version: 1,
      projectName: '结构样本',
      exportedAt: 1,
      graph: {
        nodes: [
          {
            id: 'shape:text1',
            type: 'text',
            contractVersion: 1,
            title: '文本',
            x: 0,
            y: 0,
            w: 200,
            h: 120,
            ports: [],
            params: {
              config: JSON.stringify({ apiKey: 'sk-structure-secret', mediaId: 'evil-media' }),
              mediaPath: 'projects/evil/media/evil.png'
            },
            content: { kind: 'text', text: '不应迁移的正文' },
            exec: { status: 'success' },
            meta: { source: 'upload', createdAt: 9 }
          }
        ],
        edges: [],
        groups: []
      },
      tldrawSnapshot: {
        store: {
          'document:doc': { typeName: 'document' },
          'page:page': { typeName: 'page' },
          'shape:text1': {
            typeName: 'shape',
            type: 'node-card',
            props: {
              nodeType: 'text',
              mediaId: 'evil-media',
              mediaPath: 'projects/evil/media/evil.png',
              config: JSON.stringify({ apiKey: 'sk-structure-secret' })
            },
            meta: { nodeResult: JSON.stringify({ apiKey: 'sk-structure-secret' }) }
          },
          'shape:image-evil': {
            typeName: 'shape',
            type: 'image',
            props: { assetId: 'evil-asset' }
          },
          'asset:evil': { typeName: 'asset', props: { src: 'data:image/png;base64,AAAA' } }
        }
      }
    }
    mkdirSync(exportRoot(), { recursive: true })
    writeFileSync(join(exportRoot(), 'structure.canvasflow'), JSON.stringify(structure))
    writeFileSync(join(exportRoot(), 'structure.json'), '{}')
    // 扩展名必须是 .canvasflow：先验证错误扩展名被拒。
    expect(
      (await call('project.importStructure', { filePath: 'structure.json' }, key())).error?.code
    ).toBe('INVALID_INPUT')

    const imported = await call('project.importStructure', { filePath: 'structure.canvasflow' }, key())
    expect(imported.status).toBe('completed')
    const receipt = imported.data as any
    expect(receipt).toMatchObject({
      nodeCount: 1,
      edgeCount: 0,
      groupCount: 0,
      committed: true
    })
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.byteSize).toBeGreaterThan(0)
    expect(receipt.meta.name.endsWith('（导入）')).toBe(true)
    const file = openProject(receipt.meta.id)!
    expect(file.meta.graphVersion).toBe(1)
    expect(file.nodes).toHaveLength(1)
    const newNode = file.nodes[0]
    expect(newNode.id).not.toBe('shape:text1')
    expect(newNode.content.kind).toBe('empty')
    expect(newNode.exec.status).toBe('idle')
    const projectJson = readFileSync(join(projectsDir(), receipt.meta.id, 'project.json'), 'utf-8')
    expect(projectJson).not.toContain('sk-structure-secret')
    expect(projectJson).not.toContain('projects/evil')
    expect(projectJson).not.toContain('不应迁移的正文')
    const store = (file.tldrawSnapshot as any).store as Record<string, any>
    expect(store['shape:image-evil']).toBeUndefined()
    expect(store['asset:evil']).toBeUndefined()
    const card = Object.values(store).find((record) => record?.type === 'node-card')!
    expect(card.props.mediaId).toBe('')
    expect(card.props.mediaPath).toBe('')
    expect(card.meta).toEqual({})

    const totalAfterImport = projectTotal()

    // 损坏的结构包：版本不兼容 / 非 JSON / 图数据无效，都必须拒绝且不新增项目。
    writeFileSync(
      join(exportRoot(), 'structure-version.canvasflow'),
      JSON.stringify({ ...structure, version: 2 })
    )
    expect(
      (await call('project.importStructure', { filePath: 'structure-version.canvasflow' }, key()))
        .error?.code
    ).toBe('PACKAGE_VERSION_UNSUPPORTED')
    writeFileSync(join(exportRoot(), 'structure-json.canvasflow'), '{not-json')
    expect(
      (await call('project.importStructure', { filePath: 'structure-json.canvasflow' }, key()))
        .error?.code
    ).toBe('PACKAGE_INVALID')
    writeFileSync(
      join(exportRoot(), 'structure-graph.canvasflow'),
      JSON.stringify({
        format: 'canvas-studio-canvas-structure',
        version: 1,
        projectName: '坏结构',
        exportedAt: 1,
        graph: { nodes: 'not-an-array', edges: [], groups: [] },
        tldrawSnapshot: structure.tldrawSnapshot
      })
    )
    expect(
      (await call('project.importStructure', { filePath: 'structure-graph.canvasflow' }, key()))
        .error?.code
    ).toBe('PACKAGE_CONTENT_INVALID')
    expect(projectTotal()).toBe(totalAfterImport)
  })
})

describe('library package transfer', () => {
  it('exports a resource package with hash receipt and re-imports it as new resources', async () => {
    const imagePath = join(directory, 'library.png')
    writeFileSync(imagePath, PNG_BYTES)
    const created = await call(
      'library.create_resource',
      { title: '资源包样本', imagePath, tags: ['标签'] },
      key()
    )
    expect(created.status).toBe('completed')
    const createdData = created.data as any

    const exported = await call(
      'library.export',
      { fileName: 'lib.canvaslib', resourceIds: [createdData.resourceId] },
      key()
    )
    expect(exported.status).toBe('completed')
    const receipt = exported.data as any
    expect(receipt.overwritten).toBe(false)
    expect(receipt.resourceCount).toBe(1)
    expect(existsSync(receipt.path)).toBe(true)
    expect(receipt.path.startsWith(exportRoot())).toBe(true)
    expect(statSync(receipt.path).size).toBe(receipt.byteSize)
    expect(sha256(readFileSync(receipt.path))).toBe(receipt.sha256)
    expect(receipt.sha256).toMatch(/[a-f0-9]{64}/)

    // 不覆盖已有文件；非法文件名/未知资源被拒绝。
    expect(
      (await call('library.export', { fileName: 'lib.canvaslib' }, key())).error?.code
    ).toBe('OUTPUT_EXISTS')
    expect(
      (await call('library.export', { fileName: '../escape.canvaslib' }, key())).error?.code
    ).toBe('INVALID_INPUT')
    expect(
      (await call('library.export', { fileName: 'ghost.canvaslib', resourceIds: ['ghostres'] }, key()))
        .error?.code
    ).toBe('NOT_FOUND')

    // 受控目录内绝对路径同样被接受（边界是目录归属，不是相对/绝对写法）。
    const imported = await call('library.import', { filePath: receipt.path }, key())
    expect(imported.status).toBe('completed')
    const importedData = imported.data as any
    expect(importedData.imported).toBe(1)
    expect(importedData.packageSha256).toBe(receipt.sha256)
    expect(importedData.committed).toBe(true)
    expect(libraryResourceTotal()).toBe(2)
    const search = await call('library.search', { query: '资源包样本', limit: 10 })
    expect(search.status).toBe('completed')
    const titles = ((search.data as any).items as Array<{ title: string; id: string }>).filter(
      (item) => item.title === '资源包样本'
    )
    expect(titles.length).toBe(2)
    expect(titles[0].id).not.toBe(createdData.resourceId)

    // 同一内容包重复导入按包哈希拒绝，资源数不增加。
    const duplicate = await call('library.import', { filePath: 'lib.canvaslib' }, key())
    expect(duplicate.error?.code).toBe('PACKAGE_DUPLICATE')
    expect(libraryResourceTotal()).toBe(2)
  })

  it('rejects corrupted resource packages and leaves no partial resources or import records', async () => {
    const imagePath = join(directory, 'library-corrupt.png')
    writeFileSync(imagePath, PNG_BYTES)
    const created = await call('library.create_resource', { title: '损坏包样本', imagePath }, key())
    expect(created.status).toBe('completed')
    const exported = await call('library.export', { fileName: 'corrupt.canvaslib' }, key())
    expect(exported.status).toBe('completed')
    const source = (exported.data as any).path as string
    expect(libraryResourceTotal()).toBe(1)
    expect(libraryImportTotal()).toBe(0)

    // 清单版本不兼容。
    const versionZip = new AdmZip(readFileSync(source))
    const manifest = JSON.parse(versionZip.getEntry('manifest.json')!.getData().toString('utf8')) as {
      version: number
    }
    manifest.version = 99
    versionZip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    versionZip.writeZip(join(exportRoot(), 'bad-version.canvaslib'))
    const badVersion = await call('library.import', { filePath: 'bad-version.canvaslib' }, key())
    expect(badVersion.error?.code).toBe('PACKAGE_VERSION_UNSUPPORTED')
    expect(libraryResourceTotal()).toBe(1)
    expect(libraryImportTotal()).toBe(0)

    // 清单缺失。
    const noManifestZip = new AdmZip()
    noManifestZip.addFile('blobs/x', Buffer.from([1]))
    noManifestZip.writeZip(join(exportRoot(), 'no-manifest.canvaslib'))
    expect(
      (await call('library.import', { filePath: 'no-manifest.canvaslib' }, key())).error?.code
    ).toBe('PACKAGE_INVALID')

    // 文件哈希不符（同长度篡改一字节）。
    const hashZip = new AdmZip(readFileSync(source))
    const blobEntry = hashZip.getEntries().find((entry) => entry.entryName.startsWith('blobs/'))!
    const blobBytes = blobEntry.getData()
    blobBytes[0] = blobBytes[0] ^ 0xff
    hashZip.updateFile(blobEntry.entryName, blobBytes)
    hashZip.writeZip(join(exportRoot(), 'bad-hash.canvaslib'))
    const badHash = await call('library.import', { filePath: 'bad-hash.canvaslib' }, key())
    expect(badHash.error?.code).toBe('PACKAGE_HASH_MISMATCH')
    expect(libraryResourceTotal()).toBe(1)
    expect(libraryImportTotal()).toBe(0)
    expect(stagedDirectories()).toEqual([])
  })
})
