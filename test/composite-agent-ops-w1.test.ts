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

import { runCompositeOperation } from '../src/main/agent-access/composite-ops'

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

describe('节点流 W1 Agent 入口（CLI/MCP 共用）', () => {
  it('发布不可变：同版本覆盖返回稳定错误码', async () => {
    await expect(
      runCompositeOperation('composite.publish', { manifest: manifest() }, {})
    ).resolves.toMatchObject({ version: '1.0', created: true })
    await expect(
      runCompositeOperation(
        'composite.publish',
        { manifest: manifest({ name: '改名' }) },
        {}
      )
    ).rejects.toMatchObject({ code: 'VERSION_IMMUTABLE' })
  })

  it('expectedRevision 冲突时拒绝发布，草稿保留', async () => {
    const saved = (await runCompositeOperation(
      'composite.draft.save',
      { manifest: manifest({ version: '1.0' }) },
      {}
    )) as { revision: number }
    expect(saved.revision).toBe(1)
    await expect(
      runCompositeOperation(
        'composite.publish',
        { manifest: manifest({ version: '1.0' }), expectedRevision: 0 },
        {}
      )
    ).rejects.toMatchObject({ code: 'DRAFT_REVISION_CONFLICT' })
    const draft = (await runCompositeOperation(
      'composite.draft.get',
      { capabilityId: 'copy-polish' },
      {}
    )) as { revision: number }
    expect(draft.revision).toBe(1)
  })

  it('升级预检按项目实际连线阻断删除输出与新增必填输入', async () => {
    await runCompositeOperation('composite.publish', { manifest: manifest() }, {})
    fixture.project = {
      version: 1,
      meta: { id: 'p1', name: '项目', createdAt: 1, updatedAt: 1, graphVersion: 1 },
      nodes: [
        {
          id: 'shape:instance',
          type: 'composite',
          contractVersion: 1,
          title: '文案整理',
          x: 0,
          y: 0,
          w: 340,
          h: 260,
          ports: [],
          params: { config: JSON.stringify({ manifest: manifest() }) },
          content: { kind: 'empty' },
          exec: { status: 'idle' },
          meta: { source: 'input', createdAt: 1 }
        }
      ],
      edges: [
        {
          id: 'edge-out',
          from: { nodeId: 'shape:instance', portId: 'out-polished' },
          to: { nodeId: 'shape:downstream', portId: 'in-text' }
        }
      ],
      groups: []
    }
    const removed = manifest({
      version: '2.0',
      outputs: [
        {
          id: 'other',
          label: '其他输出',
          type: 'text',
          required: true,
          cardinality: 'one',
          source: { nodeId: 'n1', portId: 'out-text' }
        }
      ]
    })
    const removedResult = (await runCompositeOperation(
      'composite.upgrade.preview',
      { projectId: 'p1', nodeId: 'shape:instance', nextManifest: removed },
      {}
    )) as { ok: boolean; impact: { breaking: Array<{ portId: string; edgeId?: string }> } }
    expect(removedResult.ok).toBe(false)
    expect(removedResult.impact.breaking[0]).toMatchObject({
      portId: 'out-polished',
      edgeId: 'edge-out'
    })

    const addedRequired = manifest({
      version: '2.0',
      inputs: [
        ...manifest().inputs,
        {
          id: 'style',
          label: '风格',
          type: 'text',
          required: true,
          cardinality: 'one',
          targets: [{ nodeId: 'n2', portId: 'in-text' }]
        }
      ],
      graph: {
        nodes: [
          ...manifest().graph.nodes,
          {
            id: 'n2',
            nodeType: 'text',
            contractVersion: 3,
            title: '风格',
            dx: 380,
            dy: 0,
            w: 340,
            h: 300,
            ports: [
              { id: 'in-text', name: '输入', dir: 'in', type: 'text', required: true, cardinality: 'one' }
            ]
          }
        ],
        edges: []
      }
    })
    const addedResult = (await runCompositeOperation(
      'composite.upgrade.preview',
      { projectId: 'p1', nodeId: 'shape:instance', nextManifest: addedRequired },
      {}
    )) as { ok: boolean; impact: { addedRequiredInputs: string[] } }
    expect(addedResult.ok).toBe(false)
    expect(addedResult.impact.addedRequiredInputs).toEqual(['in-style'])
  })
})
