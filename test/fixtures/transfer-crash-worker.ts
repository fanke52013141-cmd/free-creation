// Runs real repository/transfer code in an isolated process; fs hooks are test-only.
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { getDb, getProjectsDir, closeDb } from '../../src/main/store/db'
import {
  createProject,
  saveProject,
  openProject,
  listProjects
} from '../../src/main/store/projects.repo'
import { exportProject, importProject } from '../../src/main/store/transfer'
import { FlowAssetStore } from '../../src/main/agent-flow/asset-store'
import { reconcileWorkspace } from '../../src/main/store/workspace-health'

const directory = process.argv[2],
  boundary = process.argv[3]
if (
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-transfer-crash-')
)
  throw new Error('TRANSFER_FIXTURE_DIRECTORY_REJECTED')
process.env.CANVAS_DATA_DIR = directory
const db = getDb()
db.pragma('synchronous = FULL')
const cut = (): never => {
  fs.writeSync(1, 'cut-ready\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  throw new Error('CUT_NOT_TERMINATED')
}
if (boundary === 'recover') {
  const ids = listProjects().map((project) => project.id)
  const health = reconcileWorkspace({ projectsDir: getProjectsDir(), projectIds: ids })
  const imported = ids.filter((id) => id !== fs.readFileSync(join(directory, 'source-id'), 'utf8'))
  const readable = imported.every((id) => Boolean(openProject(id)))
  const assets = (
    db
      .prepare('SELECT count(*) AS n FROM flow_asset_versions WHERE project_id != ?')
      .get(fs.readFileSync(join(directory, 'source-id'), 'utf8')) as { n: number }
  ).n
  fs.writeSync(
    1,
    JSON.stringify({
      visibleImported: imported.length,
      readable,
      assets,
      recovered: health.recoveredImports.length,
      missing: health.orphanedProjectIds.length,
      unlisted: health.unlistedProjectIds.length,
      pending: health.temporaryFiles.length
    }) + '\n'
  )
  closeDb()
} else {
  const meta = createProject('测试：导入强杀')
  const shape = {
    id: 'shape:source',
    typeName: 'shape',
    type: 'node-card',
    props: { nodeType: 'text', text: 'private-transfer-material', config: '', exec: 'idle' },
    meta: {} as Record<string, unknown>
  }
  const graph = {
    nodes: [
      {
        id: shape.id,
        type: 'text',
        contractVersion: 1,
        params: {},
        ports: [{ id: 'out-text', dir: 'out', type: 'text', required: true, cardinality: 'one' }]
      }
    ],
    edges: [],
    groups: []
  }
  saveProject({
    id: meta.id,
    graph,
    tldrawSnapshot: { store: { [shape.id]: shape } },
    expectedGraphVersion: 0
  })
  const file = openProject(meta.id)!
  const asset = new FlowAssetStore(db, () => file).submit({
    projectId: meta.id,
    nodeId: shape.id,
    portId: 'out-text',
    submissionId: 'source',
    expectedGraphVersion: file.meta.graphVersion,
    traceId: 'trace',
    spanId: 'span'
  })
  shape.meta.flowAssetRef = JSON.stringify(asset.ref)
  saveProject({
    id: meta.id,
    graph,
    tldrawSnapshot: { store: { [shape.id]: shape } },
    expectedGraphVersion: file.meta.graphVersion
  })
  fs.writeFileSync(join(directory, 'source-id'), meta.id)
  const bundle = exportProject(meta.id, join(directory, 'portable')).path
  // Use the same CommonJS fs object as the bundled repository modules.
  const mutableFs = createRequire(__filename)('fs') as typeof fs
  const originalWrite = mutableFs.writeFileSync,
    originalRename = mutableFs.renameSync
  mutableFs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
    originalWrite(...args)
    if (
      boundary === 'staging' &&
      String(args[0]).replaceAll('\\', '/').endsWith('.importing/project.json')
    )
      cut()
  }) as typeof fs.writeFileSync
  mutableFs.renameSync = ((from, to) => {
    originalRename(from, to)
    if (boundary === 'promoted' && String(from).endsWith('.importing')) cut()
  }) as typeof fs.renameSync
  if (boundary === 'transaction') {
    db.function('cut_import_asset', cut)
    db.exec(
      `CREATE TEMP TRIGGER import_cut AFTER INSERT ON flow_asset_versions WHEN NEW.project_id != '${meta.id}' BEGIN SELECT cut_import_asset(); END`
    )
  }
  importProject(bundle)
  cut()
}
