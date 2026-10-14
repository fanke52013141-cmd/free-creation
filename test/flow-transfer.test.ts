import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { migrateDatabase } from '../src/main/store/db-migrations'
import type { ProjectFile } from '../src/shared/types'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import {
  exportFlowVersions,
  parseFlowVersions,
  prepareFlowImport,
  completeTransferMediaMap
} from '../src/main/store/flow-transfer'
const state = vi.hoisted(() => ({ db: null as Database.Database | null, root: '' }))
vi.mock('../src/main/store/db', () => ({
  getDb: () => state.db!,
  getProjectsDir: () => state.root
}))
import { exportProject, importProject } from '../src/main/store/transfer'
import {
  exportCanvasStructure,
  importCanvasStructure
} from '../src/main/store/canvas-structure-transfer'
import * as projects from '../src/main/store/projects.repo'

beforeEach(() => {
  state.db = new Database(':memory:')
  migrateDatabase(state.db)
  state.root = mkdtempSync(join(tmpdir(), 'canvas-flow-transfer-'))
})
afterEach(() => {
  state.db?.close()
  rmSync(state.root, { recursive: true, force: true })
})
function fixture() {
  const shape = {
    id: 'shape:source',
    type: 'node-card',
    typeName: 'shape',
    props: { nodeType: 'text', config: '', text: 'private-asset-material', exec: 'success' },
    meta: {} as Record<string, unknown>
  }
  const file = {
    version: 1,
    meta: { id: 'source', name: 'isolated', createdAt: 0, updatedAt: 0, graphVersion: 0 },
    nodes: [
      {
        id: shape.id,
        type: 'text',
        contractVersion: 3,
        ports: [{ id: 'out-text', dir: 'out', type: 'text', required: true, cardinality: 'one' }],
        params: {}
      }
    ],
    edges: [],
    groups: [],
    tldrawSnapshot: { store: { [shape.id]: shape } }
  } as unknown as ProjectFile
  state
    .db!.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)')
    .run('source', 'isolated')
  const asset = new FlowAssetStore(state.db!, () => file).submit({
    projectId: 'source',
    nodeId: shape.id,
    portId: 'out-text',
    submissionId: 'submit',
    expectedGraphVersion: 0,
    traceId: 'trace',
    spanId: 'span'
  })
  shape.meta.flowAssetRef = JSON.stringify(asset.ref)
  shape.meta.pinnedOutput = JSON.stringify({ version: 1, outputs: { 'out-text': asset.value } })
  shape.meta.agentTask = JSON.stringify({ taskId: 'old-task', state: 'completed' })
  shape.meta.nodeRun = { runId: 'old-run', status: 'success', startedAt: 0, inputs: [] }
  return { file, shape, asset }
}
describe('portable immutable Flow assets and graph references', () => {
  it('maps missing media to new missing identities instead of resolving into the source project', () => {
    const f = fixture()
    f.shape.props.config = JSON.stringify({
      referenceMediaIds: ['missing'],
      frame: { mediaPath: 'projects/source/media/missing.png' }
    })
    const maps = completeTransferMediaMap(
      f.file,
      { ids: new Map(), paths: new Map() },
      'new-project'
    )
    expect(maps.ids.get('missing')).not.toBe('missing')
    expect(maps.paths.get('projects/source/media/missing.png')).toBe(
      `projects/new-project/media/${maps.ids.get('missing')}.png`
    )
    expect(state.db!.prepare('SELECT count(*) AS count FROM media').get()).toEqual({ count: 0 })
  })
  it('imports a reusable template with fresh graph identities and rolls back the invisible project if saving fails', () => {
    const f = fixture(),
      snapshot = f.file.tldrawSnapshot as { store: Record<string, unknown> }
    snapshot.store['document:document'] = { id: 'document:document', typeName: 'document' }
    snapshot.store['page:page'] = { id: 'page:page', typeName: 'page' }
    const path = join(state.root, 'template.canvasflow')
    exportCanvasStructure(path, {
      id: 'source',
      name: 'isolated',
      snapshot,
      graph: { nodes: f.file.nodes, edges: [], groups: [] }
    })
    const meta = importCanvasStructure(path)
    const imported = JSON.parse(readFileSync(join(state.root, meta.id, 'project.json'), 'utf8'))
    expect(imported.nodes[0].id).not.toBe(f.shape.id)
    expect(imported.tldrawSnapshot.store[imported.nodes[0].id].meta).toEqual({})
    expect(
      state
        .db!.prepare('SELECT count(*) AS count FROM flow_asset_versions WHERE project_id=?')
        .get(meta.id)
    ).toEqual({ count: 0 })
    const failing = vi.spyOn(projects, 'saveProject').mockImplementation(() => {
      throw new Error('disk failure')
    })
    expect(() => importCanvasStructure(path)).toThrow('disk failure')
    failing.mockRestore()
    expect(state.db!.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({ count: 2 })
  })
  it('imports a real self-contained bundle with new node/version identity and readable fixed output, without old execution authority', () => {
    const f = fixture()
    const directory = join(state.root, 'source')
    mkdirSync(directory)
    writeFileSync(join(directory, 'project.json'), JSON.stringify(f.file))
    const bundle = exportProject('source', join(state.root, 'copy')).path
    const meta = importProject(bundle)
    const file = JSON.parse(
      readFileSync(join(state.root, meta.id, 'project.json'), 'utf8')
    ) as ProjectFile
    const node = file.nodes[0]
    expect(node.id).not.toBe(f.shape.id)
    const shape = (file.tldrawSnapshot as { store: Record<string, typeof f.shape> }).store[node.id]
    expect(shape.id).toBe(node.id)
    const ref = JSON.parse(String(shape.meta.flowAssetRef))
    expect(ref.versionId).not.toBe(f.asset.ref.versionId)
    expect(ref.assetId).not.toBe(f.asset.ref.assetId)
    expect(ref.sourceNodeId).toBe(node.id)
    expect(
      new FlowAssetStore(state.db!, () => file).resolveInputs(meta.id, [ref])[0].value
    ).toEqual(f.asset.value)
    expect(shape.meta.agentTask).toBeUndefined()
    expect(shape.meta.nodeRun).toBeUndefined()
    expect(shape.props.exec).toBe('idle')
    expect(
      new FlowAssetStore(state.db!, () => f.file).read('source', f.asset.ref.versionId).value
    ).toEqual(f.asset.value)
    expect(state.db!.prepare('SELECT count(*) AS count FROM flow_agent_tasks').get()).toEqual({
      count: 0
    })
  })
  it('keeps graph controls and relation endpoints aligned with remapped snapshot store keys, and strips nested credentials', () => {
    const f = fixture()
    f.shape.props.config = JSON.stringify({
      apiKey: 'fake-secret',
      initialState: 'control',
      states: ['control'],
      allowedNodeIds: [f.shape.id],
      relations: [{ relationId: 'control', sourceNodeId: f.shape.id, targetNodeId: f.shape.id }]
    })
    f.file.nodes[0].params.config = f.shape.props.config
    const imported = prepareFlowImport(
      f.file,
      exportFlowVersions(state.db!, 'source'),
      'destination'
    )
    const node = imported.file.nodes[0]
    const shape = (imported.file.tldrawSnapshot as { store: Record<string, typeof f.shape> }).store[
      node.id
    ]
    const config = JSON.parse(shape.props.config)
    expect(config.allowedNodeIds).toEqual([node.id])
    expect(config.relations[0].sourceNodeId).toBe(node.id)
    expect(config.relations[0].relationId).not.toBe('control')
    expect(config.initialState).toBe('control')
    expect(config.states).toEqual(['control'])
    expect(JSON.stringify(imported)).not.toContain('fake-secret')
    expect(shape.props.text).toBe('private-asset-material')
  })
  it('rejects a bundle whose referenced fixed version is absent or whose value digest was tampered, before it creates a project', () => {
    const f = fixture(),
      rows = exportFlowVersions(state.db!, 'source')
    expect(() => prepareFlowImport(f.file, [], 'destination')).toThrow(
      'FLOW_TRANSFER_REFERENCE_MISSING'
    )
    const nested = {
      ...rows[0],
      value_json: JSON.stringify({ kind: 'json', data: { ...f.asset.ref, versionId: 'absent' } })
    }
    expect(() => prepareFlowImport(f.file, [nested], 'destination')).toThrow(
      'FLOW_TRANSFER_REFERENCE_MISSING'
    )
    expect(() =>
      parseFlowVersions([{ ...rows[0], value_json: '{"kind":"text","text":"forged"}' }], 'source')
    ).toThrow('FLOW_TRANSFER_ASSET_INVALID')
    const directory = join(state.root, 'source')
    mkdirSync(directory)
    writeFileSync(join(directory, 'project.json'), JSON.stringify(f.file))
    const path = exportProject('source', join(state.root, 'bad')).path
    const zip = new AdmZip(path)
    zip.deleteFile('flow-assets.json')
    zip.writeZip(path)
    expect(() => importProject(path)).toThrow('FLOW_TRANSFER_REFERENCE_MISSING')
    expect(state.db!.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({ count: 1 })
  })
})
