import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import type { ProjectFile } from '../src/shared/types'
import type { AssetSubmit } from '../src/shared/agent-flow/assets'
import type { NodeShape } from '../src/shared/engine/executor-types'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function fixture(): {
  db: Database.Database
  file: ProjectFile
  store: FlowAssetStore
  shape: NodeShape
  input: AssetSubmit
} {
  const db = new Database(':memory:')
  databases.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id, name, created_at, updated_at) VALUES (?, ?, 0, 0)').run(
    'project-a',
    'fixture'
  )
  const shape = {
    id: 'shape:a',
    type: 'node-card',
    props: {
      nodeType: 'text',
      title: '材料',
      config: '',
      text: ' v1 ',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      w: 340,
      h: 260
    },
    meta: {}
  }
  const file: ProjectFile = {
    version: 1,
    meta: { id: 'project-a', name: 'fixture', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes: [],
    edges: [],
    groups: [],
    tldrawSnapshot: { store: { 'shape:a': shape } }
  }
  const store = new FlowAssetStore(db, (id) =>
    id === file.meta.id && db.prepare('SELECT id FROM projects WHERE id = ?').get(id) ? file : null
  )
  const input: AssetSubmit = {
    projectId: 'project-a',
    nodeId: 'shape:a',
    portId: 'out-text',
    submissionId: 'submit-a',
    expectedGraphVersion: 1,
    traceId: 'trace-a',
    spanId: 'span-a'
  }
  return { db, file, store, shape, input }
}

describe('production immutable text/JSON asset versions', () => {
  it('submits the formal trimmed output and keeps v1 fixed after draft edits/v2', () => {
    const { store, shape, input, file } = fixture()
    const v1 = store.submit(input)
    expect(v1.value).toEqual({ kind: 'text', text: 'v1' })
    shape.props.text = 'v2'
    file.meta.graphVersion = 2
    const v2 = store.submit({ ...input, submissionId: 'submit-b', expectedGraphVersion: 2 })
    expect(v2.ordinal).toBe(2)
    expect(v2.ref.assetId).toBe(v1.ref.assetId)
    expect(v2.ref.versionId).not.toBe(v1.ref.versionId)
    expect(store.resolveInputs('project-a', [v1.ref, v2.ref]).map((item) => item.value)).toEqual([
      { kind: 'text', text: 'v1' },
      { kind: 'text', text: 'v2' }
    ])
  })
  it('replays a completed submission even after graph revision changes; no third copy', () => {
    const { store, input, file } = fixture()
    const version = store.submit(input)
    file.meta.graphVersion = 3
    expect(store.submit({ ...input, traceId: 'retry-trace' })).toEqual(version)
    expect(store.list('project-a', 'shape:a', 'out-text')).toHaveLength(1)
  })
  it('rejects reused submission ids with changed intent and stale graph revisions', () => {
    const { store, input, file } = fixture()
    store.submit(input)
    expect(() => store.submit({ ...input, portId: 'out-json' })).toThrow(
      'ASSET_SUBMISSION_CONFLICT'
    )
    file.meta.graphVersion = 2
    expect(() => store.submit({ ...input, submissionId: 'new' })).toThrow('ASSET_REVISION_CONFLICT')
  })
  it('rejects unknown ports, missing shapes and unsupported node types', () => {
    const { store, shape, input } = fixture()
    expect(() => store.submit({ ...input, portId: 'invented' })).toThrow('ASSET_PORT_INVALID')
    expect(() => store.submit({ ...input, nodeId: 'shape:missing' })).toThrow('ASSET_NODE_MISSING')
    shape.props.nodeType = 'agent'
    expect(() => store.submit(input)).toThrow('ASSET_TYPE_UNSUPPORTED')
  })
  it('keeps valid JSON false/zero/null, and rejects malformed document JSON', () => {
    const { store, shape, input } = fixture()
    shape.props.nodeType = 'json'
    shape.props.text = '{"zero":0,"flag":false,"empty":null}'
    expect(store.submit({ ...input, portId: 'out-json' }).value).toEqual({
      kind: 'json',
      data: { zero: 0, flag: false, empty: null }
    })
    shape.props.text = '{bad'
    expect(() => store.submit({ ...input, submissionId: 'bad-json', portId: 'out-json' })).toThrow(
      'ASSET_OUTPUT_UNAVAILABLE'
    )
  })
  it('uses persisted processor results only when the latest run succeeded', () => {
    const { store, shape, input } = fixture()
    shape.props.nodeType = 'processor'
    shape.meta = {
      nodeResult: JSON.stringify({ kind: 'json', data: [1, 2] }),
      nodeRun: { runId: 'fixture-run', status: 'failed', startedAt: 0, inputs: {} }
    }
    expect(() => store.submit({ ...input, portId: 'out-value' })).toThrow(
      'ASSET_OUTPUT_UNAVAILABLE'
    )
    shape.meta.nodeRun = { runId: 'fixture-run', status: 'success', startedAt: 0, inputs: {} }
    expect(store.submit({ ...input, portId: 'out-value' }).value).toEqual({
      kind: 'json',
      data: [1, 2]
    })
  })
  it('document values survive failed runs and pinned outputs override changed text', () => {
    const { store, shape, input } = fixture()
    shape.meta = { nodeRun: JSON.stringify({ status: 'failed' }) }
    expect(store.submit(input).value).toEqual({ kind: 'text', text: 'v1' })
    Object.assign(shape.meta, {
      pinnedOutput: JSON.stringify({
        version: 1,
        outputs: { 'out-text': { kind: 'text', text: 'frozen' } }
      })
    })
    shape.props.text = 'edited'
    expect(store.submit({ ...input, submissionId: 'pinned' }).value).toEqual({
      kind: 'text',
      text: 'frozen'
    })
  })
  it('never accepts caller-supplied body, and rejects overlarge persisted values', () => {
    const { store, shape, input } = fixture()
    expect(() => store.submit({ ...input, value: 'invented' } as AssetSubmit)).toThrow()
    shape.props.text = 'x'.repeat(1024 * 1024)
    expect(() => store.submit(input)).toThrow('ASSET_VALUE_TOO_LARGE')
  })
  it('rejects pinned values that violate the declared document output type', () => {
    const { store, shape, input } = fixture()
    Object.assign(shape.meta, {
      pinnedOutput: JSON.stringify({
        version: 1,
        outputs: { 'out-text': { kind: 'json', data: 1 } }
      })
    })
    expect(() => store.submit(input)).toThrow('ASSET_OUTPUT_INVALID')
  })
  it('rolls back a created version when receipt persistence fails', () => {
    const { db, store, input } = fixture()
    db.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON flow_asset_submissions BEGIN SELECT RAISE(ABORT, 'injected'); END;"
    )
    expect(() => store.submit(input)).toThrow('ASSET_STORAGE_FAILED')
    try {
      store.submit(input)
    } catch (error) {
      expect(error).toHaveProperty('phase', 'receipt-persist')
    }
    expect(store.list('project-a', 'shape:a', 'out-text')).toHaveLength(0)
    db.exec('DROP TRIGGER fail_receipt')
    expect(store.submit(input).ordinal).toBe(1)
  })
  it('checks project, full ref identity, manifest bounds and body integrity', () => {
    const { db, store, input } = fixture()
    const version = store.submit(input)
    expect(() => store.read('other-project', version.ref.versionId)).toThrow(
      'ASSET_PROJECT_MISSING'
    )
    expect(() =>
      store.resolveInputs('project-a', [{ ...version.ref, sourcePortId: 'out-wrong' }])
    ).toThrow('ASSET_REFERENCE_MISMATCH')
    expect(() => store.resolveInputs('project-a', Array(129).fill(version.ref))).toThrow(
      'ASSET_INPUT_LIMIT'
    )
    db.prepare('UPDATE flow_asset_versions SET value_json = ?').run(
      '{"kind":"text","text":"tampered"}'
    )
    expect(() => store.read('project-a', version.ref.versionId)).toThrow('ASSET_INTEGRITY_FAILED')
  })
  it('deleting a project cascades versions/receipts; node deletion keeps history readable', () => {
    const { db, store, file, input } = fixture()
    const version = store.submit(input)
    file.tldrawSnapshot = { store: {} }
    expect(store.read('project-a', version.ref.versionId)).toEqual(version)
    db.prepare('DELETE FROM projects WHERE id = ?').run('project-a')
    expect(db.prepare('SELECT COUNT(*) AS count FROM flow_asset_versions').get()).toEqual({
      count: 0
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM flow_asset_submissions').get()).toEqual({
      count: 0
    })
  })
  it('list is metadata-only, sorted newest first, and mutations of returned objects do not alter storage', () => {
    const { store, input } = fixture()
    const version = store.submit(input)
    if (version.value.kind === 'text') version.value.text = 'local change'
    expect(store.read('project-a', version.ref.versionId).value).toEqual({
      kind: 'text',
      text: 'v1'
    })
    const list = store.list('project-a', 'shape:a', 'out-text')
    expect(list[0]).not.toHaveProperty('value')
    expect(list[0].ref.versionId).toBe(version.ref.versionId)
  })
})
