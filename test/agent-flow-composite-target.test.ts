import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowCommandLedger } from '../src/main/agent-flow/command-ledger'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import { resolveCompositeTarget } from '../src/main/agent-flow/composite-target'
import { projectSemanticRevision } from '../src/main/agent-flow/command-intent'
import { computeInputFingerprint } from '../src/shared/engine/input-fingerprint'
import type { ProjectFile, CanvasNode } from '../src/shared/types'
import type { CompositeManifest } from '../src/shared/composite/manifest'
import type { NodeExecuteCommand, FlowCommandGrant } from '../src/shared/agent-flow/commands'

const dbs: Database.Database[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

const manifest: CompositeManifest = {
  schemaVersion: 1,
  runtimeVersion: 2,
  capabilityId: 'legacy-composite',
  version: '1.0',
  name: '历史组合',
  inputs: [{ id: 'text', label: '文本', type: 'text', required: true, cardinality: 'one', targets: [{ nodeId: 'n1', portId: 'in-text' }] }],
  outputs: [{ id: 'result', label: '结果', type: 'text', required: true, cardinality: 'one', source: { nodeId: 'n1', portId: 'out-text' } }],
  graph: {
    nodes: [{
      id: 'n1', nodeType: 'text', contractVersion: 3, title: '文本', dx: 0, dy: 0, w: 340, h: 300,
      ports: [
        { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: false, cardinality: 'many' },
        { id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }
      ]
    }],
    edges: []
  }
}

function fixture(kind: 'inline' | 'meta' | 'flat' | 'ref') {
  const db = new Database(':memory:')
  dbs.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('p', 'fixture')
  const digest = 'a'.repeat(64)
  if (kind === 'flat' || kind === 'ref') {
    db.prepare("INSERT INTO composite_capabilities (id,name,description,tags,latest_version,archived,created_at,updated_at) VALUES (?,?,?,'[]',?,0,0,0)")
      .run(manifest.capabilityId, manifest.name, '', manifest.version)
    db.prepare('INSERT INTO composite_versions (capability_id,version,manifest,content_hash,published_at,published_by) VALUES (?,?,?,?,0,\'test\')')
      .run(manifest.capabilityId, manifest.version, JSON.stringify(manifest), digest)
  }
  const shape = (id: string, type: string, text = '', config = '') => ({
    id, type: 'node-card',
    props: { nodeType: type, title: type, config, text, mediaId: '', mediaPath: '', mediaMime: '', exec: 'idle', w: 340, h: 260 },
    meta: {} as Record<string, unknown>
  })
  const source = shape('source', 'text', 'fixed source')
  const agent = shape('agent', 'agent', 'goal', JSON.stringify({
    schemaVersion: 1, role: 'specialist', interactionMode: 'autonomous', skills: [], tools: [],
    allowedNodeIds: ['target'], maxSteps: 3, relations: []
  }))
  const config = kind === 'inline'
    ? JSON.stringify({ manifest })
    : kind === 'flat'
      ? JSON.stringify({ capabilityId: manifest.capabilityId, version: manifest.version })
      : kind === 'ref'
        ? JSON.stringify({ ref: { capabilityId: manifest.capabilityId, version: manifest.version } })
        : '{}'
  const target = shape('target', 'composite', '', config)
  if (kind === 'meta') target.meta.compositeManifest = manifest
  const asNode = (record: typeof source): CanvasNode => ({
    id: record.id,
    type: record.props.nodeType as CanvasNode['type'],
    contractVersion: record === target ? 1 : record.props.nodeType === 'text' ? 3 : 1,
    title: record.props.title,
    x: 0, y: 0, w: 340, h: 260,
    ports: record === target
      ? [
          { id: 'in-text', name: '文本', dir: 'in', type: 'text', required: true, cardinality: 'one' },
          { id: 'out-result', name: '结果', dir: 'out', type: 'text', required: true, cardinality: 'one' }
        ]
      : record.props.nodeType === 'text'
        ? [{ id: 'out-text', name: '文本', dir: 'out', type: 'text', required: true, cardinality: 'one' }]
        : [],
    params: { config: record.props.config },
    content: record.props.text ? { kind: 'text', text: record.props.text } : { kind: 'empty' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 0 }
  })
  const file: ProjectFile = {
    version: 1,
    meta: { id: 'p', name: 'fixture', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes: [source, agent, target].map(asNode),
    edges: [{ id: 'edge', from: { nodeId: 'source', portId: 'out-text' }, to: { nodeId: 'target', portId: 'in-text' } }],
    groups: [],
    tldrawSnapshot: { store: Object.fromEntries([source, agent, target].map((record) => [record.id, record])) }
  }
  const project = () => file
  const assets = new FlowAssetStore(db, project)
  const version = assets.submit({
    projectId: 'p', nodeId: 'source', portId: 'out-text', submissionId: 'source-v1',
    expectedGraphVersion: 1, traceId: 'trace', spanId: 'span'
  })
  const ledger = new FlowCommandLedger(db, project)
  const command: NodeExecuteCommand = {
    schemaVersion: 1, kind: 'node.execute', commandId: 'command', projectId: 'p', taskId: 'task',
    agentNodeId: 'agent', targetNodeId: 'target', contractVersion: 1,
    expectedSemanticRevision: projectSemanticRevision(file),
    inputs: [{ targetPortId: 'in-text', assets: [version.ref] }], traceId: 'trace', spanId: 'span'
  }
  const save = (grant: FlowCommandGrant) => {
    ledger.check({ projectId: 'p', commandId: 'command', leaseId: grant.leaseId })
    target.meta.nodeRun = {
      runId: grant.runId, status: 'success', startedAt: 0, finishedAt: 1,
      commandId: 'command', commandLeaseId: grant.leaseId, nodeExecutionId: 'execution',
      fixedInputs: command.inputs,
      inputs: {
        'in-text': [{ nodeId: 'source', portId: 'out-text', assetId: version.ref.assetId, versionId: version.ref.versionId }]
      },
      inputFingerprint: computeInputFingerprint({
        contractVersion: 1, config: target.props.config, text: target.props.text,
        sources: [{ portId: 'in-text', nodeId: 'source', sourcePortId: 'out-text', value: version.value }]
      }),
      outputPorts: ['out-result']
    }
    target.meta.nodeExtra = JSON.stringify({ 'out-result': { kind: 'text', text: 'committed output' } })
    file.meta.graphVersion++
  }
  return { db, file, target, ledger, command, save, manifest }
}

describe('composite target immutable shapes', () => {
  it.each(['inline', 'meta', 'flat', 'ref'] as const)('prepares and commits %s without replacing immutable input', (kind) => {
    const f = fixture(kind)
    const resolved = resolveCompositeTarget(f.db, f.target.props.config, f.target.meta)
    expect(resolved?.manifest).toEqual(manifest)
    const prepared = f.ledger.prepare(f.command)
    if (prepared.state !== 'ready') throw new Error('expected ready grant')
    f.save(prepared.grant)
    expect(f.ledger.commit({ projectId: 'p', commandId: 'command' }).state).toBe('committed')
  })

  it('rejects a declared mismatched hash before prepare', () => {
    const f = fixture('ref')
    f.target.props.config = JSON.stringify({
      ref: { capabilityId: manifest.capabilityId, version: manifest.version, contentHash: 'b'.repeat(64) }
    })
    expect(resolveCompositeTarget(f.db, f.target.props.config, f.target.meta)).toBeNull()
    f.command.expectedSemanticRevision = projectSemanticRevision(f.file)
    expect(() => f.ledger.prepare(f.command)).toThrow('FLOW_TYPE_UNSUPPORTED')
  })
})
