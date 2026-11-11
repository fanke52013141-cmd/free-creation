// W3：归档/删除引用保护 —— 画布实例（内嵌/引用两形态）+ 发布版本嵌套依赖。
// GUI/CLI/MCP 共用 findCompositeReferences / deleteCompositeCapabilityChecked。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { CanvasEdge, CanvasNode, ProjectFile } from '../src/shared/types'
import type { CompositeManifest } from '../src/shared/composite/manifest'
import { buildCompositeManifestFromGraph } from '../src/renderer/src/composite/build-manifest'

const fixture = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  projects: [] as Array<{ meta: { id: string; name: string }; file: ProjectFile }>
}))
vi.mock('../src/main/store/db', () => ({ getDb: () => fixture.db }))
vi.mock('../src/main/store/projects.repo', () => ({
  listProjects: () => fixture.projects.map((entry) => entry.meta),
  openProject: (id: string) => fixture.projects.find((entry) => entry.meta.id === id)?.file ?? null
}))

import {
  deleteCompositeCapability,
  getCompositeCapability,
  getCompositeDraft,
  getCompositeVersion,
  listCompositeCapabilities,
  publishCompositeVersion,
  saveCompositeDraft
} from '../src/main/store/composite.repo'
import {
  deleteCompositeCapabilityChecked,
  findCompositeReferences,
  runCompositeOperation
} from '../src/main/agent-access/composite-ops'

function textManifest(
  capabilityId: string,
  name: string,
  version = '1.0'
): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId,
    version,
    name,
    inputs: [
      {
        id: 'copy',
        label: '文案',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'n1', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'polished',
        label: '整理结果',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n1', portId: 'out-text' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'n1',
          nodeType: 'text',
          contractVersion: 3,
          title: '文案',
          dx: 0,
          dy: 0,
          w: 340,
          h: 300,
          text: '内部说明',
          ports: [
            { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: true, cardinality: 'many' },
            { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }
          ]
        }
      ],
      edges: []
    },
    dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }]
  }
}

function port(id: string, dir: 'in' | 'out') {
  return { id, name: id, dir, type: 'text' as const, required: dir === 'in', cardinality: 'one' as const }
}

function canvasNode(id: string, type: string, title: string, ports: ReturnType<typeof port>[], x = 0): CanvasNode {
  return {
    id,
    type,
    contractVersion: type === 'composite' ? 1 : 3,
    title,
    x,
    y: 0,
    w: 340,
    h: 300,
    ports,
    params: {},
    content: { kind: 'text', text: '' },
    exec: { status: 'idle' },
    meta: {}
  } as unknown as CanvasNode
}

/** 用真实封装路径构造外层节点流（嵌套固定引用内层 1.0）。 */
async function publishOuterWithNested(inner: CompositeManifest): Promise<void> {
  const text = canvasNode('shape:text', 'text', '标题', [port('in-text', 'in'), port('out-text', 'out')])
  const nested = canvasNode(
    'shape:nested',
    'composite',
    inner.name,
    [port('in-copy', 'in'), port('out-polished', 'out')],
    380
  )
  nested.params = { config: JSON.stringify({ manifest: inner }) }
  const edges: CanvasEdge[] = [
    {
      id: 'e1',
      from: { nodeId: 'shape:text', portId: 'out-text' },
      to: { nodeId: 'shape:nested', portId: 'in-copy' }
    }
  ]
  const built = buildCompositeManifestFromGraph({
    capabilityId: 'title-polish',
    name: '标题整理',
    version: '1.0',
    nodes: [text, nested],
    edges,
    selectedNodeIds: ['shape:text', 'shape:nested']
  })
  if (!built.ok) throw new Error('外层封装失败')
  await publishCompositeVersion(built.manifest)
}

function instanceNode(id: string, config: string, meta?: Record<string, unknown>): CanvasNode {
  const node = canvasNode(id, 'composite', '文案整理', [port('in-copy', 'in'), port('out-polished', 'out')])
  node.params = { config }
  if (meta) node.meta = meta as CanvasNode['meta']
  return node
}

function addProject(id: string, name: string, nodes: CanvasNode[]): void {
  fixture.projects.push({
    meta: { id, name },
    file: {
      meta: { id, name, graphVersion: 1 },
      nodes,
      edges: [],
      groups: []
    } as unknown as ProjectFile
  })
}

beforeEach(() => {
  fixture.db = new Database(':memory:')
  fixture.projects = []
  fixture.db.exec(`
    CREATE TABLE composite_capabilities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]', latest_version TEXT, archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE composite_versions (
      capability_id TEXT NOT NULL, version TEXT NOT NULL, manifest TEXT NOT NULL,
      content_hash TEXT NOT NULL, published_at INTEGER NOT NULL,
      published_by TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (capability_id, version)
    );
    CREATE TABLE composite_drafts (
      capability_id TEXT PRIMARY KEY, manifest TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
  `)
})
afterEach(() => fixture.db.close())

describe('W3 引用检查 · 画布实例与嵌套依赖', () => {
  it('同时识别内嵌 manifest 与固定版本引用两种实例形态', async () => {
    const inner = textManifest('copy-polish', '文案整理')
    await publishCompositeVersion(inner)
    addProject('p-embedded', '内嵌项目', [
      instanceNode('shape:a', JSON.stringify({ manifest: inner }))
    ])
    addProject('p-ref', '引用项目', [
      instanceNode(
        'shape:b',
        JSON.stringify({ capabilityId: 'copy-polish', version: '1.0', contentHash: 'h' }),
        { compositeManifest: inner }
      )
    ])
    addProject('p-other', '无关项目', [
      instanceNode('shape:c', JSON.stringify({ manifest: textManifest('another-cap', '另一个') }))
    ])
    const report = findCompositeReferences('copy-polish')
    expect(report.projectInstances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: 'p-embedded', nodeId: 'shape:a', version: '1.0' }),
        expect.objectContaining({ projectId: 'p-ref', nodeId: 'shape:b', version: '1.0' })
      ])
    )
    expect(report.projectInstances).toHaveLength(2)
    expect(report.nestedVersions).toEqual([])
  })

  it('识别其他节点流发布版本的嵌套固定引用（草稿不算引用）', async () => {
    const inner = textManifest('copy-polish', '文案整理')
    await publishCompositeVersion(inner)
    await publishOuterWithNested(inner)
    // 草稿引用不构成运行绑定：仅保存草稿的外层不进入引用清单。
    await saveCompositeDraft(textManifest('draft-only', '草稿外层'))
    const report = findCompositeReferences('copy-polish')
    expect(report.nestedVersions).toEqual([
      { capabilityId: 'title-polish', version: '1.0', refVersion: '1.0' }
    ])
    expect(report.projectInstances).toEqual([])
  })
})

describe('W3 删除保护 · 三入口同一实现', () => {
  it('存在画布实例时拒绝删除且数据不变', async () => {
    const inner = textManifest('copy-polish', '文案整理')
    await publishCompositeVersion(inner)
    addProject('p1', '项目一', [
      instanceNode('shape:a', JSON.stringify({ capabilityId: 'copy-polish', version: '1.0' }), {
        compositeManifest: inner
      })
    ])
    await expect(
      runCompositeOperation('composite.delete', { capabilityId: 'copy-polish' }, {})
    ).rejects.toMatchObject({ code: 'CAPABILITY_IN_USE' })
    expect(getCompositeCapability('copy-polish')).not.toBeNull()
    expect(getCompositeVersion('copy-polish', '1.0')).not.toBeNull()
  })

  it('仅存在嵌套引用时同样拒绝删除', async () => {
    const inner = textManifest('copy-polish', '文案整理')
    await publishCompositeVersion(inner)
    await publishOuterWithNested(inner)
    expect(() => deleteCompositeCapabilityChecked('copy-polish')).toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_IN_USE' })
    )
    expect(getCompositeVersion('copy-polish', '1.0')).not.toBeNull()
    expect(getCompositeVersion('title-polish', '1.0')).not.toBeNull()
  })

  it('无引用时物理删除能力、全部版本与草稿', async () => {
    const inner = textManifest('copy-polish', '文案整理')
    await publishCompositeVersion(inner)
    await publishCompositeVersion(textManifest('copy-polish', '文案整理', '2.0'))
    await saveCompositeDraft(textManifest('copy-polish', '文案整理', '3.0'))
    const result = await runCompositeOperation('composite.delete', { capabilityId: 'copy-polish' }, {})
    expect(result).toEqual({ capabilityId: 'copy-polish', deleted: true })
    expect(getCompositeCapability('copy-polish')).toBeNull()
    expect(getCompositeVersion('copy-polish', '1.0')).toBeNull()
    expect(getCompositeVersion('copy-polish', '2.0')).toBeNull()
    expect(getCompositeDraft('copy-polish')).toBeNull()
  })

  it('移除实例后嵌套引用仍阻断；引用全部清除后才可删除', async () => {
    const inner = textManifest('copy-polish', '文案整理')
    await publishCompositeVersion(inner)
    await publishOuterWithNested(inner)
    addProject('p1', '项目一', [
      instanceNode('shape:a', JSON.stringify({ manifest: inner }))
    ])
    expect(() => deleteCompositeCapabilityChecked('copy-polish')).toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_IN_USE' })
    )
    // 移除画布实例后，外层发布版本的嵌套引用仍在。
    fixture.projects = []
    expect(() => deleteCompositeCapabilityChecked('copy-polish')).toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_IN_USE' })
    )
    // 外层能力删除后（其自身无引用），内层才可删。
    expect(deleteCompositeCapabilityChecked('title-polish').deleted).toBe(true)
    expect(deleteCompositeCapabilityChecked('copy-polish').deleted).toBe(true)
  })

  it('未知能力返回 NOT_FOUND；references 与 delete 走同一外部入口', async () => {
    await expect(
      runCompositeOperation('composite.references', { capabilityId: 'missing' }, {})
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      runCompositeOperation('composite.delete', { capabilityId: 'missing' }, {})
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await publishCompositeVersion(textManifest('copy-polish', '文案整理'))
    const report = await runCompositeOperation('composite.references', { capabilityId: 'copy-polish' }, {})
    expect(report).toEqual({ capabilityId: 'copy-polish', projectInstances: [], nestedVersions: [] })
  })

  it('repo 层直接删除不做引用检查（保护在统一入口）', async () => {
    const inner = textManifest('copy-polish', '文案整理')
    await publishCompositeVersion(inner)
    addProject('p1', '项目一', [instanceNode('shape:a', JSON.stringify({ manifest: inner }))])
    // 仓库函数只负责事务删除；引用保护由 deleteCompositeCapabilityChecked 统一承担。
    expect(deleteCompositeCapability('copy-polish')).toBe(true)
    expect(getCompositeCapability('copy-polish')).toBeNull()
  })
})

describe('W3 归档 · 隐藏发现入口但绑定实例不受影响', () => {
  it('归档后默认搜索不可见、includeArchived 可见、固定版本仍可读取', async () => {
    const inner = textManifest('copy-polish', '文案整理')
    await publishCompositeVersion(inner)
    addProject('p1', '项目一', [
      instanceNode('shape:a', JSON.stringify({ capabilityId: 'copy-polish', version: '1.0' }), {
        compositeManifest: inner
      })
    ])
    const archived = await runCompositeOperation('composite.archive', { capabilityId: 'copy-polish' }, {})
    expect(archived).toEqual({ capabilityId: 'copy-polish', archived: true })
    expect(listCompositeCapabilities().map((item) => item.id)).not.toContain('copy-polish')
    expect(
      listCompositeCapabilities({ includeArchived: true }).map((item) => item.id)
    ).toContain('copy-polish')
    // 已绑定实例按固定版本继续可用：版本读取不受归档影响。
    expect(getCompositeVersion('copy-polish', '1.0')?.manifest.name).toBe('文案整理')
    // 归档不阻断删除保护判定：实例引用仍在。
    expect(findCompositeReferences('copy-polish').projectInstances).toHaveLength(1)
    const restored = await runCompositeOperation(
      'composite.archive',
      { capabilityId: 'copy-polish', archived: false },
      {}
    )
    expect(restored).toEqual({ capabilityId: 'copy-polish', archived: false })
    expect(listCompositeCapabilities().map((item) => item.id)).toContain('copy-polish')
  })
})