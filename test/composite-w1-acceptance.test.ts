import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { CanvasEdge, CanvasNode } from '../src/shared/types'
import type { CompositeManifest } from '../src/shared/composite/manifest'
import { compositeRuntimeVersion } from '../src/shared/composite/manifest'
import { collectCompositeOutputs, planCompositeInputBindings } from '../src/shared/composite/runtime'
import { planCompositeUpgrade } from '../src/shared/composite/upgrade'
import { buildCompositeManifestFromGraph } from '../src/renderer/src/composite/build-manifest'
import { textExecutor } from '../src/shared/engine/executors/text'

const fixture = vi.hoisted(() => ({ db: null as unknown as Database.Database }))
vi.mock('../src/main/store/db', () => ({ getDb: () => fixture.db }))

import {
  getCompositeVersion,
  publishCompositeVersion,
  saveCompositeDraft
} from '../src/main/store/composite.repo'

function textManifest(
  capabilityId: string,
  name: string,
  body: string,
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
          text: body,
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

function port(id: string, dir: 'in' | 'out', type: 'text' = 'text') {
  return { id, name: id, dir, type, required: dir === 'in', cardinality: 'one' as const }
}

function node(id: string, type: string, title: string, ports: ReturnType<typeof port>[], x = 0): CanvasNode {
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
afterEach(() => fixture.db.close())

describe('W1 验收：文案整理 1.0 / 标题整理 1.0', () => {
  it('普通节点传入接收、嵌套固定 1.0、内层发 2.0 后外层不变、不兼容升级被拦截', async () => {
    const inner = textManifest('copy-polish', '文案整理', '内部说明')
    await publishCompositeVersion(inner)

    const text = node('shape:text', 'text', '标题', [port('in-text', 'in'), port('out-text', 'out')])
    const nested = node(
      'shape:nested',
      'composite',
      '文案整理',
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
    expect(built.ok).toBe(true)
    if (!built.ok) return
    await publishCompositeVersion(built.manifest)

    const outer = getCompositeVersion('title-polish', '1.0')!.manifest
    expect(outer.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'capability', id: 'copy-polish', version: '1.0' })
      ])
    )
    const outerNested = outer.graph.nodes.find((item) => item.nodeType === 'composite')!
    expect(JSON.parse(outerNested.config!).manifest.version).toBe('1.0')

    // 普通节点调用：外部文本作为 in-text 上游，文本节点合并正文并输出。
    const bindings = planCompositeInputBindings(inner, new Map([
      [
        'in-copy',
        [
          {
            type: 'text' as const,
            value: { kind: 'text' as const, text: '外部文案' },
            source: { nodeId: 'shape:outer', portId: 'out-text', runId: 'r1' },
            createdAt: 1
          }
        ]
      ]
    ]))
    expect(bindings.issues).toEqual([])
    const updated: string[] = []
    const ctx = {
      node: { id: 'shape:n1', type: 'text', title: '文案', contractVersion: 3 },
      shape: {
        props: {
          nodeType: 'text',
          title: '文案',
          config: '',
          text: '内部说明',
          mediaId: '',
          mediaPath: '',
          mediaMime: '',
          exec: 'idle',
          w: 340,
          h: 300
        },
        meta: {}
      },
      inputs: new Map([
        [
          'in-text',
          [
            {
              type: 'text',
              value: { kind: 'text', text: '外部文案' },
              source: { nodeId: 'src', portId: 'out-text', runId: 'r1' },
              createdAt: 1
            }
          ]
        ]
      ]),
      projectId: 'p',
      providers: [],
      signal: { cancelled: false, paused: false, onCancel: () => () => undefined },
      gateway: {},
      updateProps: (patch: { text?: string }) => {
        if (patch.text !== undefined) updated.push(patch.text)
      },
      updateResult: () => undefined
    }
    const run = textExecutor(ctx as never)
    expect(run.status).toBe('done')
    expect(updated[0]).toBe('外部文案\n$$$\n内部说明')
    const output = collectCompositeOutputs(inner, () => ({
      kind: 'text',
      text: updated[0]!
    }))
    expect(output.issues).toEqual([])
    expect(output.outputs.polished).toEqual({ kind: 'text', text: '外部文案\n$$$\n内部说明' })

    // 内层编辑保存并发布 2.0；外层仍固定 1.0。
    await saveCompositeDraft(textManifest('copy-polish', '文案整理（改）', '新正文', '2.0'))
    await publishCompositeVersion(textManifest('copy-polish', '文案整理（改）', '新正文', '2.0'))
    expect(getCompositeVersion('copy-polish', '2.0')?.manifest.name).toBe('文案整理（改）')
    const outerAfter = getCompositeVersion('title-polish', '1.0')!.manifest
    const outerNestedAfter = outerAfter.graph.nodes.find((item) => item.nodeType === 'composite')!
    expect(JSON.parse(outerNestedAfter.config!).manifest.version).toBe('1.0')
    expect(JSON.parse(outerNestedAfter.config!).manifest.name).toBe('文案整理')
    expect(compositeRuntimeVersion(inner)).toBe(2)

    // 不兼容升级：删除已连接输出应被预检拦截。
    const nextInner = textManifest('copy-polish', '文案整理（改）', '新正文', '3.0')
    nextInner.outputs = [
      {
        id: 'other',
        label: '其他',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n1', portId: 'out-text' }
      }
    ]
    const plan = planCompositeUpgrade(inner, nextInner, [
      { dir: 'out', portId: 'out-polished', type: 'text', cardinality: 'one' }
    ])
    expect(plan.ok).toBe(false)
    expect(plan.impact.removedOutputs).toEqual(['out-polished'])
  })
})
