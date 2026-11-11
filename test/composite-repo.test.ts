import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { CompositeManifest } from '../src/shared/composite/manifest'

const fixture = vi.hoisted(() => ({ db: null as unknown as Database.Database }))
vi.mock('../src/main/store/db', () => ({ getDb: () => fixture.db }))

import {
  archiveCompositeCapability,
  deleteCompositeDraft,
  getCompositeDraft,
  getCompositeVersion,
  listCompositeCapabilities,
  publishCompositeVersion,
  saveCompositeDraft,
  verifyCompositeVersion
} from '../src/main/store/composite.repo'

function manifest(patch: Partial<CompositeManifest> = {}): CompositeManifest {
  return {
    schemaVersion: 1,
    capabilityId: 'character-design',
    version: '1.0',
    name: '人物设计',
    description: '输入人物要求，输出人物设计图',
    tags: ['人物'],
    inputs: [
      {
        id: 'requirements',
        label: '人物要求',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'requirements', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'portrait',
        label: '人物设计图',
        type: 'image',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'generate-image', portId: 'out-image' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'requirements',
          nodeType: 'text',
          contractVersion: 1,
          title: '人物要求',
          dx: 0,
          dy: 0,
          w: 340,
          h: 260,
          ports: [
            { id: 'in-text', name: '人物要求', dir: 'in', type: 'text', required: true, cardinality: 'one' },
            { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }
          ]
        },
        {
          id: 'generate-image',
          nodeType: 'image-gen',
          contractVersion: 1,
          title: '生成人物图',
          dx: 380,
          dy: 0,
          w: 340,
          h: 260,
          ports: [
            { id: 'in-prompt', name: '提示词', dir: 'in', type: 'text', required: true, cardinality: 'one' },
            { id: 'out-image', name: '人物设计图', dir: 'out', type: 'image', required: true, cardinality: 'one' }
          ]
        }
      ],
      edges: [
        {
          from: { nodeId: 'requirements', portId: 'out-text' },
          to: { nodeId: 'generate-image', portId: 'in-prompt' }
        }
      ]
    },
    dependencies: [
      { kind: 'node', id: 'text', contractVersion: 1 },
      { kind: 'node', id: 'image-gen', contractVersion: 1 }
    ],
    ...patch
  }
}

beforeEach(() => {
  fixture.db = new Database(':memory:')
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
afterEach(() => {
  fixture.db.close()
})

describe('组合能力存储（P1）', () => {
  it('草稿 revision 自增，过期修订被拒绝', async () => {
    const first = await saveCompositeDraft(manifest())
    expect(first.revision).toBe(1)
    expect(getCompositeDraft('character-design')?.manifest.name).toBe('人物设计')
    const second = await saveCompositeDraft(manifest({ name: '人物设计 2' }), 1)
    expect(second.revision).toBe(2)
    await expect(saveCompositeDraft(manifest({ name: '冲突' }), 1)).rejects.toThrow('修订冲突')
    expect(deleteCompositeDraft('character-design')).toBe(true)
    expect(getCompositeDraft('character-design')).toBeNull()
  })

  it('W1：发布不可变、同内容幂等、版本必须递增，失败保留草稿', async () => {
    const published = await publishCompositeVersion(manifest())
    expect(published.created).toBe(true)
    expect(published.record.contentHash).toMatch(/^[a-f0-9]{64}$/)
    const repeat = await publishCompositeVersion(manifest())
    expect(repeat.created).toBe(false)

    // 同版本不同内容拒绝覆盖，旧版本内容与摘要保持原样。
    await expect(
      publishCompositeVersion(manifest({ name: '修改后的人物设计' }))
    ).rejects.toMatchObject({ code: 'VERSION_IMMUTABLE' })
    expect(getCompositeVersion('character-design', '1.0')?.manifest.name).toBe('人物设计')

    // 新版本必须大于当前最新。
    await expect(publishCompositeVersion(manifest({ version: '2.0' }))).resolves.toMatchObject({
      created: true
    })
    await expect(
      publishCompositeVersion(manifest({ version: '2.0', name: '覆盖 2.0' }))
    ).rejects.toMatchObject({ code: 'VERSION_IMMUTABLE' })
    expect(getCompositeVersion('character-design', '1.0')?.manifest.name).toBe('人物设计')
    expect(getCompositeVersion('character-design', '2.0')?.manifest.version).toBe('2.0')
    expect(listCompositeCapabilities()[0].latestVersion).toBe('2.0')
    await expect(verifyCompositeVersion('character-design', '1.0')).resolves.toEqual({ ok: true })

    // expectedRevision 过期时拒绝发布，草稿仍保留。
    const draft = await saveCompositeDraft(manifest({ version: '3.0' }))
    await expect(
      publishCompositeVersion(manifest({ version: '3.0' }), {
        expectedRevision: draft.revision - 1
      })
    ).rejects.toMatchObject({ code: 'DRAFT_REVISION_CONFLICT' })
    expect(getCompositeDraft('character-design')?.revision).toBe(draft.revision)
    expect(getCompositeVersion('character-design', '3.0')).toBeNull()
  })

  it('按名称/标签搜索，归档后默认不可见但版本仍可读', async () => {
    await publishCompositeVersion(manifest())
    expect(listCompositeCapabilities({ query: '人物' })).toHaveLength(1)
    expect(listCompositeCapabilities({ query: '不存在的名字' })).toHaveLength(0)
    expect(archiveCompositeCapability('character-design')).toBe(true)
    expect(listCompositeCapabilities()).toHaveLength(0)
    expect(listCompositeCapabilities({ includeArchived: true })).toHaveLength(1)
    expect(getCompositeVersion('character-design', '1.0')).not.toBeNull()
  })

  it('损坏 manifest 不能保存或发布', async () => {
    const bad = manifest()
    bad.graph.nodes = []
    await expect(saveCompositeDraft(bad)).rejects.toThrow('组合契约无效')
    await expect(publishCompositeVersion(bad)).rejects.toThrow('组合契约无效')
  })
})
