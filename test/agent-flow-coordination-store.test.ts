import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { CoordinationStore, type CoordinationRun } from '../src/main/agent-flow/coordination-store'
import {
  AgentNodeConfigSchema,
  StateMachineNodeConfigSchema
} from '../src/shared/agent-flow/node-contracts'
import { buildContextManifest } from '../src/shared/agent-flow/context-manifest'

const dbs: Database.Database[] = []
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close())
})

function fixture() {
  const db = new Database(':memory:')
  dbs.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('p', 'isolated')
  const store = new CoordinationStore(db)
  const run: CoordinationRun = {
    projectId: 'p',
    nodeId: 'main',
    taskId: 'run',
    goal: 'goal',
    config: AgentNodeConfigSchema.parse({
      schemaVersion: 1,
      role: 'coordinator',
      interactionMode: 'autonomous',
      skills: [],
      tools: [{ id: 'agent.dispatch', version: '1' }],
      allowedNodeIds: ['child'],
      maxSteps: 8,
      relations: []
    }),
    stateNodeId: 'state',
    stateConfig: StateMachineNodeConfigSchema.parse({
      schemaVersion: 1,
      initialState: 'idle',
      states: ['idle', 'completed'],
      transitions: [{ from: 'idle', event: 'flow.completed', to: 'completed' }],
      relations: []
    }),
    scopeIds: ['main', 'child'],
    scopeRevision: 'a'.repeat(64),
    childIds: ['child'],
    state: 'running',
    phase: 'idle',
    revision: 0,
    waitRevision: 0,
    decisions: 0,
    paused: false,
    traceId: 'trace',
    spanId: 'span',
    children: [],
    outputs: []
  }
  store.create(run, [])
  return { db, store, run }
}

function largeManifest(marker: string, bytes = 1024 * 1024) {
  const text = marker + 'x'.repeat(Math.max(0, bytes - marker.length))
  return buildContextManifest('child', {
    selectors: [{ sourceStageKey: 'source', path: 'text', required: true }],
    budgetBytes: 1024 * 1024
  }, [{
    stageKey: 'source',
    nodeId: 'source',
    outputs: [{ kind: 'text', text }],
    humanDecided: false
  }])
}

describe('CoordinationStore context persistence', () => {
  it('splits large manifests out of the run body and restores them without truncation', () => {
    const { db, store, run } = fixture()
    const manifests = [1, 2, 3, 4].map((index) => largeManifest(`large-${index}:`))
    run.children = manifests.map((manifest, index) => ({
      nodeId: `child-${index}`,
      taskId: `task-${index}`,
      goal: 'goal',
      completion: 'done',
      inputs: [],
      state: 'completed',
      outputs: [],
      contextManifest: manifest
    }))
    store.save(run)

    const row = db.prepare(
      "SELECT body_json FROM flow_coordination_runs WHERE project_id='p' AND task_id='run'"
    ).get() as { body_json: string }
    expect(row.body_json).not.toContain('large-1:')
    expect(Buffer.byteLength(row.body_json, 'utf8')).toBeLessThan(100_000)
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_coordination_contexts').get()).toEqual({ n: 4 })

    const restored = new CoordinationStore(db).latest('p', 'main')!
    expect(restored.children.map((child) => child.contextManifest?.entries[0]?.value)).toEqual(
      manifests.map((manifest) => manifest.entries[0]?.value)
    )
  })

  it('keeps small manifests embedded for compatibility with existing overview evidence', () => {
    const { db, store, run } = fixture()
    const manifest = largeManifest('small-marker:', 1024)
    run.children = [{
      nodeId: 'child',
      taskId: 'task-small',
      goal: 'goal',
      completion: 'done',
      inputs: [],
      state: 'completed',
      outputs: [],
      contextManifest: manifest
    }]
    store.save(run)
    const row = db.prepare(
      "SELECT body_json FROM flow_coordination_runs WHERE project_id='p' AND task_id='run'"
    ).get() as { body_json: string }
    expect(row.body_json).toContain('small-marker:')
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_coordination_contexts').get()).toEqual({ n: 0 })
  })

  it('rejects an oversized manifest explicitly without replacing the last good snapshot', () => {
    const { db, store, run } = fixture()
    const manifest = largeManifest('good:', 1024)
    run.children = [{
      nodeId: 'child',
      taskId: 'task-good',
      goal: 'goal',
      completion: 'done',
      inputs: [],
      state: 'completed',
      outputs: [],
      contextManifest: manifest
    }]
    store.save(run)

    const oversized = {
      ...manifest,
      entries: [{
        ...manifest.entries[0]!,
        value: 'x'.repeat(4 * 1024 * 1024 + 1)
      }]
    }
    run.children = [{
      nodeId: 'child',
      taskId: 'task-bad',
      goal: 'goal',
      completion: 'done',
      inputs: [],
      state: 'completed',
      outputs: [],
      contextManifest: oversized
    }]
    expect(() => store.save(run)).toThrow('AGENT_CONTEXT_TOO_LARGE')
    expect(new CoordinationStore(db).latest('p', 'main')!.children[0]?.taskId).toBe('task-good')
  })
})
