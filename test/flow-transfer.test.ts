import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { createHash } from 'node:crypto'
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
  getDataDir: () => dirname(state.root),
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
  state.root = join(mkdtempSync(join(tmpdir(), 'canvas-flow-transfer-')), 'projects')
  mkdirSync(state.root)
})
afterEach(() => {
  state.db?.close()
  const root = dirname(state.root)
  if (
    resolve(root, '..') !== resolve(tmpdir()) ||
    !basename(root).startsWith('canvas-flow-transfer-')
  )
    throw new Error('FLOW_TRANSFER_CLEANUP_REJECTED')
  rmSync(root, { recursive: true, force: true })
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
  it('keeps the fixed presentation port distinct from the original processor output port', () => {
    const f = fixture()
    f.file.nodes[0].type = 'processor'
    f.file.nodes[0].ports[0].id = 'out-value'
    f.shape.props.nodeType = 'processor'
    f.shape.meta = {}
    state.db!.prepare('UPDATE flow_asset_versions SET port_id=?').run('out-value')
    const placed = {
      ...f.shape,
      id: 'shape:placed',
      props: { ...f.shape.props, nodeType: 'text' },
      meta: {
        flowAssetRef: JSON.stringify({ ...f.asset.ref, sourcePortId: 'out-value' }),
        pinnedOutput: JSON.stringify({ version: 1, outputs: { 'out-text': f.asset.value } })
      }
    }
    f.file.nodes.push({
      ...f.file.nodes[0],
      id: placed.id,
      type: 'text',
      ports: [{ ...f.file.nodes[0].ports[0], id: 'out-text' }]
    })
    ;(f.file.tldrawSnapshot as { store: Record<string, unknown> }).store[placed.id] = placed
    const portable = prepareFlowImport(f.file, exportFlowVersions(state.db!, 'source'), 'target')
    const records = Object.values(
      (portable.file.tldrawSnapshot as { store: Record<string, typeof placed> }).store
    )
    const imported = records.find((record) => record.props.nodeType === 'text')!
    expect(JSON.parse(imported.meta.pinnedOutput).outputs).toEqual({ 'out-text': f.asset.value })
    expect(JSON.parse(imported.meta.flowAssetRef).sourcePortId).toBe('out-value')
  })
  function mediaFixture(kind: 'image' | 'video', fixed = true) {
    const f = fixture(),
      id = 'fixture-media',
      ext = kind === 'image' ? '.png' : '.mp4',
      mime = kind === 'image' ? 'image/png' : 'video/mp4'
    const bytes =
      kind === 'video'
        ? readFileSync(join('test', 'fixtures', 'agent-video.mp4'))
        : Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYawAAAAASUVORK5CYII=',
            'base64'
          )
    const mediaPath = `projects/source/media/${id}${ext}`
    const value = {
      kind,
      mediaId: id,
      mediaPath,
      mime,
      ...(fixed ? { contentSha256: createHash('sha256').update(bytes).digest('hex') } : {})
    }
    const body = JSON.stringify(value),
      port = kind === 'image' ? 'out-image' : 'out-video'
    state
      .db!.prepare('UPDATE flow_asset_versions SET port_id=?,value_json=?,digest=?')
      .run(port, body, createHash('sha256').update(body).digest('hex'))
    f.file.nodes[0].type = kind === 'image' ? 'image' : 'video-asset'
    f.file.nodes[0].ports = [
      { id: port, dir: 'out', type: kind, required: true, cardinality: 'one' }
    ]
    Object.assign(f.shape.props, {
      nodeType: kind === 'image' ? 'image' : 'video-asset',
      mediaId: id,
      mediaPath,
      mediaMime: mime
    })
    const ref = { ...f.asset.ref, sourcePortId: port }
    f.shape.meta.flowAssetRef = JSON.stringify(ref)
    f.shape.meta.pinnedOutput = JSON.stringify({ version: 1, outputs: { [port]: value } })
    f.shape.meta.nodeResult = JSON.stringify({
      kind: 'media-source',
      results: [{ mediaId: id, mediaPath, mime }]
    })
    const directory = join(state.root, 'source')
    mkdirSync(join(directory, 'media'), { recursive: true })
    writeFileSync(join(directory, 'media', id + ext), bytes)
    state
      .db!.prepare(
        'INSERT INTO media(id,kind,mime,path,size_bytes,created_at) VALUES (?,?,?,?,?,0)'
      )
      .run(id, kind, mime, mediaPath, bytes.length)
    writeFileSync(join(directory, 'project.json'), JSON.stringify(f.file))
    return { ...f, value, ref, bytes, port, ext }
  }
  it.each(['image', 'video'] as const)(
    'round trips fixed %s bytes, ports, snapshot and result with fresh media/version identities',
    (kind) => {
      const f = mediaFixture(kind),
        bundle = exportProject('source', join(state.root, 'portable')).path
      const meta = importProject(bundle),
        file = JSON.parse(
          readFileSync(join(state.root, meta.id, 'project.json'), 'utf8')
        ) as ProjectFile
      const shape = (file.tldrawSnapshot as { store: Record<string, typeof f.shape> }).store[
        file.nodes[0].id
      ]
      const ref = JSON.parse(String(shape.meta.flowAssetRef)),
        pinned = JSON.parse(String(shape.meta.pinnedOutput)).outputs[f.port]
      const version = new FlowAssetStore(state.db!, () => file).resolveInputs(meta.id, [ref])[0]
      expect(ref.versionId).not.toBe(f.ref.versionId)
      expect(pinned).toEqual(version.value)
      expect(pinned.mediaId).not.toBe(f.value.mediaId)
      expect(pinned.mediaPath).toBe(`projects/${meta.id}/media/${pinned.mediaId}${f.ext}`)
      expect(pinned.contentSha256).toBe(f.value.contentSha256)
      expect(readFileSync(join(dirname(state.root), pinned.mediaPath))).toEqual(f.bytes)
      const result = JSON.parse(String(shape.meta.nodeResult)).results[0]
      expect(result.mediaId).toBe(pinned.mediaId)
      expect(result.mediaPath).toBe(pinned.mediaPath)
      expect(shape.meta.agentTask).toBeUndefined()
      expect(shape.meta.nodeRun).toBeUndefined()
      expect(exportProject(meta.id, join(state.root, 'again')).missingMediaCount).toBe(0)
    }
  )
  it('preserves legacy generated video versions without inventing a content digest', () => {
    const f = mediaFixture('video', false),
      meta = importProject(exportProject('source', join(state.root, 'legacy')).path)
    const rows = exportFlowVersions(state.db!, meta.id)
    expect(JSON.parse(rows[0].value_json).contentSha256).toBeUndefined()
    expect(f.value.kind).toBe('video')
  })
  it.each(['missing', 'changed', 'path', 'mime', 'pinned', 'duplicate'] as const)(
    'rejects %s fixed media bundles before project visibility and rolls back files',
    (failure) => {
      const f = mediaFixture('image'),
        path = exportProject('source', join(state.root, 'bad-media')).path,
        zip = new AdmZip(path)
      if (failure === 'missing') zip.deleteFile('media/fixture-media.png')
      if (failure === 'changed') zip.updateFile('media/fixture-media.png', Buffer.from('different'))
      if (failure === 'duplicate') zip.addFile('media/fixture-media.mp4', f.bytes)
      if (failure === 'pinned') {
        const file = JSON.parse(zip.readAsText('project.json'))
        file.tldrawSnapshot.store[f.shape.id].meta.pinnedOutput = JSON.stringify({
          version: 1,
          outputs: { [f.port]: { ...f.value, contentSha256: 'a'.repeat(64) } }
        })
        zip.updateFile('project.json', Buffer.from(JSON.stringify(file)))
      }
      if (failure === 'path' || failure === 'mime') {
        const rows = JSON.parse(zip.readAsText('flow-assets.json')),
          value = JSON.parse(rows[0].value_json)
        if (failure === 'path') value.mediaPath = 'projects/foreign/media/fixture-media.png'
        else value.mime = 'video/mp4'
        rows[0].value_json = JSON.stringify(value)
        rows[0].digest = createHash('sha256').update(rows[0].value_json).digest('hex')
        zip.updateFile('flow-assets.json', Buffer.from(JSON.stringify(rows)))
      }
      zip.writeZip(path)
      const before = readdirSync(state.root).sort()
      expect(() => importProject(path)).toThrow()
      expect(readdirSync(state.root).sort()).toEqual(before)
      expect(state.db!.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({
        count: 1
      })
      expect(state.db!.prepare('SELECT count(*) AS count FROM media').get()).toEqual({ count: 1 })
      expect(state.db!.prepare('SELECT count(*) AS count FROM flow_asset_versions').get()).toEqual({
        count: 1
      })
    }
  )
  it('rolls back fixed media files and all rows when version insertion fails after directory promotion', () => {
    mediaFixture('video')
    const path = exportProject('source', join(state.root, 'transaction-failure')).path
    const before = readdirSync(state.root).sort()
    state.db!.exec(`CREATE TRIGGER reject_import_version BEFORE INSERT ON flow_asset_versions
      WHEN NEW.project_id != 'source' BEGIN SELECT RAISE(ABORT, 'fixture-version-write-failed'); END`)
    expect(() => importProject(path)).toThrow('fixture-version-write-failed')
    expect(readdirSync(state.root).sort()).toEqual(before)
    for (const table of ['projects', 'media', 'flow_asset_versions'])
      expect(state.db!.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
        count: 1
      })
  })
  it('rejects export when fixed media bytes change instead of writing a portable lie', () => {
    const f = mediaFixture('video')
    writeFileSync(
      join(state.root, 'source', 'media', 'fixture-media.mp4'),
      Buffer.alloc(f.bytes.length)
    )
    expect(() => exportProject('source', join(state.root, 'changed-export'))).toThrow(
      'FLOW_TRANSFER_MEDIA_INVALID'
    )
  })
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
