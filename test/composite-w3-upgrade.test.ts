// W3：实例升级预检（引用形态实例）与执行器固定版本引用解析。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { CompositeManifest } from '../src/shared/composite/manifest'
import type { ProjectFile } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  project: null as unknown as ProjectFile | null
}))
vi.mock('../src/main/store/db', () => ({ getDb: () => fixture.db }))
vi.mock('../src/main/store/projects.repo', () => ({
  openProject: () => fixture.project
}))

import {
  previewCompositeUpgrade,
  runCompositeOperation
} from '../src/main/agent-access/composite-ops'
import { compositeExecutor } from '../src/shared/engine/executors/composite'
import type { NodeExecutionContext } from '../src/shared/engine/executor-types'

function manifest(patch: Partial<CompositeManifest> = {}): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'copy-polish',
    version: '1.0',
    name: '文案整理',
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
            { id: 'in-text', name: '输入', dir: 'in', type: 'text', required: true, cardinality: 'one' },
            { id: 'out-text', name: '输出', dir: 'out', type: 'text', required: true, cardinality: 'one' }
          ]
        }
      ],
      edges: []
    },
    dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }],
    ...patch
  }
}

function projectWithInstance(config: string, meta?: Record<string, unknown>): ProjectFile {
  return {
    meta: { id: 'p1', name: '测试', graphVersion: 1 },
    nodes: [
      {
        id: 'shape:inst',
        type: 'composite',
        contractVersion: 1,
        title: '文案整理',
        x: 0,
        y: 0,
        w: 340,
        h: 260,
        ports: [],
        params: { config },
        content: { kind: 'empty' },
        exec: { status: 'idle' },
        meta: { source: 'input', createdAt: 0, ...(meta ?? {}) }
      }
    ],
    edges: [],
    groups: []
  } as unknown as ProjectFile
}

beforeEach(() => {
  fixture.db = new Database(':memory:')
  fixture.project = null
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

describe('W3 升级预检 · 引用形态实例', () => {
  it('config 只存引用时从 meta 快照读取当前版本并给出兼容结论', async () => {
    await runCompositeOperation('composite.publish', { manifest: manifest() }, {})
    const next = manifest({ version: '2.0' })
    await runCompositeOperation('composite.publish', { manifest: next }, {})
    fixture.project = projectWithInstance(
      JSON.stringify({ capabilityId: 'copy-polish', version: '1.0', contentHash: 'x' }),
      { compositeManifest: manifest() }
    )
    const preview = previewCompositeUpgrade('p1', 'shape:inst', next)
    expect(preview.previousVersion).toBe('1.0')
    expect(preview.nextVersion).toBe('2.0')
    expect(preview.ok).toBe(true)
    expect(preview.impact?.addedInputs).toEqual([])
  })

  it('新增必填输入对引用形态实例同样阻断', async () => {
    await runCompositeOperation('composite.publish', { manifest: manifest() }, {})
    const base = manifest()
    const next = manifest({
      version: '2.0',
      graph: {
        nodes: [
          ...base.graph.nodes,
          { ...base.graph.nodes[0], id: 'n2', title: '额外', dx: 400, text: '' }
        ],
        edges: []
      },
      inputs: [
        ...base.inputs,
        {
          id: 'extra',
          label: '额外',
          type: 'text',
          required: true,
          cardinality: 'one',
          targets: [{ nodeId: 'n2', portId: 'in-text' }]
        }
      ]
    })
    fixture.project = projectWithInstance(
      JSON.stringify({ capabilityId: 'copy-polish', version: '1.0' }),
      { compositeManifest: manifest() }
    )
    const preview = previewCompositeUpgrade('p1', 'shape:inst', next)
    expect(preview.ok).toBe(false)
    expect(preview.impact?.addedRequiredInputs).toContain('in-extra')
  })
})

describe('W3 执行器 · 固定版本引用解析', () => {
  function ctx(config: string, extra: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
    return {
      node: { id: 'shape:inst' } as never,
      shape: { props: { config }, meta: {} } as never,
      inputs: new Map(),
      runId: 'r1',
      updateMeta: vi.fn(),
      updateResult: vi.fn(),
      runComposite: vi.fn(async () => ({ status: 'done', outputs: {}, stepCount: 1 })),
      ...extra
    } as unknown as NodeExecutionContext
  }

  it('引用形态经宿主解析发布仓库后执行；解析失败明确拒绝', async () => {
    const resolved = manifest()
    const resolve = vi.fn(async () => resolved)
    const context = ctx(
      JSON.stringify({ capabilityId: 'copy-polish', version: '1.0', contentHash: 'h' }),
      { resolveCompositeManifest: resolve }
    )
    const outcome = await compositeExecutor(context)
    expect(outcome.status).toBe('done')
    expect(resolve).toHaveBeenCalledWith({
      capabilityId: 'copy-polish',
      version: '1.0',
      contentHash: 'h'
    })
    expect((context.runComposite as ReturnType<typeof vi.fn>).mock.calls[0][0].manifest).toEqual(
      resolved
    )

    const missing = ctx(
      JSON.stringify({ capabilityId: 'copy-polish', version: '9.0' }),
      { resolveCompositeManifest: async () => null }
    )
    const failed = await compositeExecutor(missing)
    expect(failed.status).toBe('failed')
    expect(failed.reason).toContain('引用无法解析')
  })

  it('meta 缓存快照优先于仓库解析；内嵌 manifest 历史实例不受影响', async () => {
    const cached = manifest({ name: '缓存版本' })
    const resolve = vi.fn(async () => manifest())
    const context = ctx(JSON.stringify({ capabilityId: 'copy-polish', version: '1.0' }), {
      resolveCompositeManifest: resolve
    })
    ;(context.shape as { meta: Record<string, unknown> }).meta = { compositeManifest: cached }
    const outcome = await compositeExecutor(context)
    expect(outcome.status).toBe('done')
    expect(resolve).not.toHaveBeenCalled()
    expect((context.runComposite as ReturnType<typeof vi.fn>).mock.calls[0][0].manifest.name).toBe(
      '缓存版本'
    )

    const legacy = ctx(JSON.stringify({ manifest: manifest({ name: '历史内嵌' }) }))
    const legacyOutcome = await compositeExecutor(legacy)
    expect(legacyOutcome.status).toBe('done')
    expect((legacy.runComposite as ReturnType<typeof vi.fn>).mock.calls[0][0].manifest.name).toBe(
      '历史内嵌'
    )
  })

  it('嵌套调用传递祖先上下文（递归/深度/预算守卫入口）', async () => {
    const parentContext = {
      chain: [{ capabilityId: 'outer', version: '1.0' }],
      expandedNodes: 3
    }
    const context = ctx(JSON.stringify({ manifest: manifest() }), {
      compositeRunContext: parentContext
    })
    await compositeExecutor(context)
    expect(
      (context.runComposite as ReturnType<typeof vi.fn>).mock.calls[0][0].parentContext
    ).toEqual(parentContext)
  })
})