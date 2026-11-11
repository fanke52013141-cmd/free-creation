import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { CompositeManifest } from '../src/shared/composite/manifest'
import type { DiagnosticsEventInput } from '../src/shared/observability'

const fixture = vi.hoisted(() => ({ db: null as unknown as Database.Database }))
vi.mock('../src/main/store/db', () => ({ getDb: () => fixture.db }))

import { setGatewayEventSink, emitGatewayEvent } from '../src/main/diagnostics/gateway-events'
import { publishCompositeVersion } from '../src/main/store/composite.repo'

function manifest(name = '文案整理'): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'copy-polish',
    version: '1.0',
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
          text: '不应进入日志的正文',
          ports: [
            { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: true, cardinality: 'one' },
            { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }
          ]
        }
      ],
      edges: []
    },
    dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }]
  }
}

let events: DiagnosticsEventInput[] = []

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
  events = []
  setGatewayEventSink({ emit: (event) => events.push(event) })
})
afterEach(() => {
  setGatewayEventSink(null)
  fixture.db.close()
})

describe('节点流 W1 诊断事件（脱敏）', () => {
  it('发布记录 started + 唯一 completed，且不包含正文/名称', async () => {
    await publishCompositeVersion(manifest())
    expect(events.map((event) => event.event)).toEqual([
      'composite.publish.started',
      'composite.publish.completed'
    ])
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('不应进入日志的正文')
    expect(serialized).not.toContain('文案整理')
    expect(events[1].attributes).toMatchObject({
      capabilityId: 'copy-polish',
      version: '1.0',
      created: true
    })
  })

  it('同版本覆盖失败记录稳定 code，不复制异常正文', async () => {
    await publishCompositeVersion(manifest())
    events = []
    await expect(publishCompositeVersion(manifest('改名但同版本'))).rejects.toMatchObject({
      code: 'VERSION_IMMUTABLE'
    })
    expect(events.map((event) => event.event)).toEqual([
      'composite.publish.started',
      'composite.publish.failed'
    ])
    expect(events[1].attributes).toMatchObject({ code: 'VERSION_IMMUTABLE' })
    expect(JSON.stringify(events)).not.toContain('改名但同版本')
  })

  it('运行事件登记父子关联与失败阶段，不含正文', () => {
    emitGatewayEvent(
      'composite.run.started',
      '节点流运行开始',
      { traceId: 'run-1', spanId: 'span-1', projectId: 'p1', nodeId: 'shape:instance' },
      {
        phase: 'run',
        attributes: {
          capabilityId: 'copy-polish',
          capabilityVersion: '1.0',
          parentRunId: 'run-parent'
        }
      }
    )
    emitGatewayEvent(
      'composite.run.failed',
      '节点流运行结束',
      { traceId: 'run-1', spanId: 'span-2', projectId: 'p1', nodeId: 'shape:instance' },
      {
        phase: 'output',
        attributes: { code: 'REQUIRED_OUTPUT_MISSING', capabilityId: 'copy-polish' }
      }
    )
    expect(events.map((event) => event.event)).toEqual([
      'composite.run.started',
      'composite.run.failed'
    ])
    expect(events[0].attributes).toMatchObject({ parentRunId: 'run-parent' })
    expect(events[1]).toMatchObject({ phase: 'output' })
    expect(events[1].attributes).toMatchObject({ code: 'REQUIRED_OUTPUT_MISSING' })
  })
})
