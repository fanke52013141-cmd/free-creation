// Isolated subprocess fixture. No production fault switches or user data access.
import Database from 'better-sqlite3'
import { readFileSync, writeFileSync, writeSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateDatabase } from '../../src/main/store/db-migrations'
import { FlowCommandLedger } from '../../src/main/agent-flow/command-ledger'
import { FlowAssetStore } from '../../src/main/agent-flow/asset-store'
import { PROCESSOR_PORTS } from '../../src/shared/agent-flow/processor-contract'
import { projectSemanticRevision } from '../../src/main/agent-flow/command-intent'
import { computeInputFingerprint } from '../../src/shared/engine/input-fingerprint'
import type { ProjectFile, CanvasNode } from '../../src/shared/types'
import type { NodeExecuteCommand, FlowCommandGrant } from '../../src/shared/agent-flow/commands'

export function crashFixture(directory: string, initialize: boolean) {
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-flow-crash-')
  )
    throw new Error('CRASH_FIXTURE_DIRECTORY_REJECTED')
  const db = new Database(join(directory, 'flow.sqlite'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  migrateDatabase(db)
  const projectPath = join(directory, 'project.json')
  const shape = (id: string, type: string, text: string, config: string) => ({
    id,
    type: 'node-card',
    props: { nodeType: type, text, config },
    meta: {} as Record<string, unknown>
  })
  const source = shape('shape:source', 'text', 'private-crash-input', '')
  const agent = shape(
    'shape:agent',
    'agent',
    'private-crash-goal',
    JSON.stringify({
      schemaVersion: 1,
      role: 'specialist',
      interactionMode: 'autonomous',
      skills: [],
      tools: [],
      allowedNodeIds: ['shape:target'],
      maxSteps: 3,
      relations: []
    })
  )
  const target = shape('shape:target', 'processor', '', '{"operation":"pass"}')
  const file: ProjectFile = initialize
    ? {
        version: 1,
        meta: { id: 'isolated', name: 'test', createdAt: 0, updatedAt: 0, graphVersion: 1 },
        nodes: [source, agent, target].map(
          (s) =>
            ({
              id: s.id,
              type: s.props.nodeType,
              contractVersion: 1,
              ports: s === target ? [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out] : [],
              params: { config: s.props.config },
              content: { kind: 'text', text: s.props.text },
              exec: { status: 'idle' }
            }) as CanvasNode
        ),
        edges: [
          {
            id: 'edge',
            from: { nodeId: source.id, portId: 'out-text' },
            to: { nodeId: target.id, portId: 'in-value' }
          }
        ],
        groups: [],
        tldrawSnapshot: { store: Object.fromEntries([source, agent, target].map((s) => [s.id, s])) }
      }
    : JSON.parse(readFileSync(projectPath, 'utf8'))
  if (initialize)
    db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?, ?, 0, 0)').run(
      'isolated',
      'test'
    )
  const project = () => file
  const assets = new FlowAssetStore(db, project),
    ledger = new FlowCommandLedger(db, project)
  const version = initialize
    ? assets.submit({
        projectId: 'isolated',
        nodeId: source.id,
        portId: 'out-text',
        submissionId: 'source',
        expectedGraphVersion: 1,
        traceId: 'trace',
        spanId: 'span'
      })
    : assets.list('isolated', source.id, 'out-text')[0]
  const command: NodeExecuteCommand = {
    schemaVersion: 1,
    kind: 'node.execute',
    projectId: 'isolated',
    commandId: 'cut-command',
    taskId: 'cut-task',
    agentNodeId: agent.id,
    targetNodeId: target.id,
    contractVersion: 1,
    expectedSemanticRevision: projectSemanticRevision(file),
    inputs: [{ targetPortId: 'in-value', assets: [version.ref] }],
    traceId: 'trace',
    spanId: 'span'
  }
  if (!initialize)
    Object.assign(
      command,
      JSON.parse(
        (
          db
            .prepare('SELECT command_json FROM flow_commands WHERE command_id=?')
            .get('cut-command') as { command_json: string }
        ).command_json
      )
    )
  const save = () => writeFileSync(projectPath, JSON.stringify(file))
  const effect = () => {
    const path = join(directory, 'effect-count')
    let count = 0
    try {
      count = Number(readFileSync(path, 'utf8'))
    } catch {
      /* First effect. */
    }
    writeFileSync(path, String(count + 1))
  }
  const saveRun = (grant: FlowCommandGrant, status = 'success') => {
    const record = (file.tldrawSnapshot as { store: Record<string, typeof target> }).store[
      target.id
    ]
    record.meta.nodeRun = {
      runId: grant.runId,
      status,
      startedAt: 0,
      finishedAt: 1,
      commandId: command.commandId,
      commandLeaseId: grant.leaseId,
      nodeExecutionId: 'execution',
      fixedInputs: command.inputs,
      inputs: {
        'in-value': [
          {
            nodeId: source.id,
            portId: 'out-text',
            assetId: version.ref.assetId,
            versionId: version.ref.versionId
          }
        ]
      },
      inputFingerprint: computeInputFingerprint({
        contractVersion: 1,
        config: record.props.config,
        text: record.props.text,
        sources: [
          {
            portId: 'in-value',
            nodeId: source.id,
            sourcePortId: 'out-text',
            value: assets.read('isolated', version.ref.versionId).value
          }
        ]
      }),
      outputPorts: status === 'success' ? ['out-value'] : []
    }
    record.meta.nodeResult = JSON.stringify({ kind: 'text', text: 'private-crash-output' })
    file.meta.graphVersion++
    save()
  }
  if (initialize) save()
  return { db, ledger, command, file, assets, save, saveRun, effect }
}

if (process.argv[2] === '--worker') {
  const directory = process.argv[3],
    boundary = process.argv[4]
  const lookup = { projectId: 'isolated', commandId: 'cut-command' }
  const f = crashFixture(directory, boundary !== 'recover')
  const cut = (): never => {
    writeSync(1, 'cut-ready\n')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    throw new Error('CUT_NOT_TERMINATED')
  }
  if (boundary === 'recover') {
    f.ledger.recoverAbandoned()
    let reason: string | undefined
    try {
      f.ledger.commit(lookup)
    } catch (error) {
      reason = (error as { code?: string }).code
    }
    const replay = f.ledger.prepare(f.command)
    let occupied = false
    try {
      f.ledger.prepare({
        ...f.command,
        commandId: 'new-command',
        expectedSemanticRevision: projectSemanticRevision(f.file)
      })
    } catch (error) {
      occupied = (error as { code?: string }).code === 'FLOW_NODE_OCCUPIED'
    }
    const outputCount = (
      f.db
        .prepare('SELECT count(*) AS n FROM flow_asset_versions WHERE node_id=?')
        .get('shape:target') as { n: number }
    ).n
    writeSync(
      1,
      JSON.stringify({
        receipt: f.ledger.lookup(lookup),
        replay: replay.state,
        reason,
        occupied,
        outputCount
      }) + '\n'
    )
    f.db.close()
  } else {
    const prepared = f.ledger.prepare(f.command)
    if (prepared.state !== 'ready') throw new Error('CUT_GRANT_MISSING')
    const grant = prepared.grant
    if (boundary === 'prepared') cut()
    f.ledger.check({ ...lookup, leaseId: grant.leaseId })
    if (boundary === 'admitted') cut()
    f.effect()
    if (boundary === 'effect-unsaved') cut()
    const status =
      boundary === 'saved-failure'
        ? 'failed'
        : boundary === 'saved-cancelled'
          ? 'cancelled'
          : boundary === 'saved-skipped'
            ? 'skipped'
            : 'success'
    f.saveRun(grant, status)
    if (['saved-success', 'saved-failure', 'saved-cancelled', 'saved-skipped'].includes(boundary))
      cut()
    if (boundary === 'changed-revision') {
      f.file.nodes.find((node) => node.id === 'shape:target')!.params.config =
        '{"operation":"template","template":"changed"}'
      ;(f.file.tldrawSnapshot as { store: Record<string, { props: { config: string } }> }).store[
        'shape:target'
      ].props.config = '{"operation":"template","template":"changed"}'
      f.save()
      cut()
    }
    if (boundary === 'tampered-input') {
      const target = (
        f.file.tldrawSnapshot as {
          store: Record<string, { meta: { nodeRun: { inputFingerprint: string } } }>
        }
      ).store['shape:target']
      target.meta.nodeRun.inputFingerprint = 'tampered'
      f.save()
      cut()
    }
    if (boundary === 'receipt-transaction') {
      f.db.function('cut_before_receipt', cut)
      f.db.exec(
        "CREATE TEMP TRIGGER crash_cut BEFORE UPDATE ON flow_commands WHEN NEW.state='committed' BEGIN SELECT cut_before_receipt(); END"
      )
    }
    f.ledger.commit(lookup)
    cut()
  }
}
