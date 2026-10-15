import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { CoordinatorReviews } from '../src/main/agent-flow/coordinator-reviews'
import { CoordinationStore, type CoordinationRun } from '../src/main/agent-flow/coordination-store'
import type { FlowAgentDesktopHost } from '../src/main/agent-flow/desktop-host'
import type { ProjectFile } from '../src/shared/types'

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

function fixture(firstKind: 'human-wait' | 'manual-wait') {
  const db = new Database(':memory:')
  databases.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run(
    'p',
    'join'
  )
  const review = (owner: string) => ({
    schemaVersion: 1,
    rulesVersion: 'rules',
    modelDefinitionId: 'model',
    rejectPolicy: 'rework',
    maxReworks: 2,
    responsibleNodeId: owner,
    subjectSources: [{ nodeId: owner, portId: 'out-text' }],
    gatedNodeIds: ['downstream'],
    relations: []
  })
  const shape = (nodeType: string, config = {}) => ({
    props: { nodeType, config: JSON.stringify(config), text: '' }
  })
  const file = {
    meta: { id: 'p' },
    nodes: [],
    edges: [],
    tldrawSnapshot: {
      store: {
        'review-first': shape('ai-review', review('first')),
        'review-second': shape('ai-review', review('second')),
        first: shape(firstKind === 'manual-wait' ? 'text' : 'agent'),
        second: shape('agent')
      }
    }
  } as unknown as ProjectFile
  const output = {
    assetId: 'second-asset',
    versionId: 'second-fixed-version',
    sourceNodeId: 'second',
    sourcePortId: 'out-text'
  }
  const children = ['first', 'second'].map((nodeId) => ({
    nodeId,
    taskId: `${nodeId}-rework`,
    goal: 'independent rework',
    completion: 'fixed output',
    inputs: [],
    state: 'waiting',
    outputs: []
  }))
  const run: CoordinationRun = {
    projectId: 'p',
    nodeId: 'main',
    taskId: 'flow',
    goal: 'join independent reviews',
    config: {
      schemaVersion: 1,
      role: 'coordinator',
      interactionMode: 'autonomous',
      allowedNodeIds: [],
      skills: [],
      tools: [],
      maxSteps: 24,
      maxParallelTasks: 2,
      relations: []
    },
    stateNodeId: 'state',
    stateConfig: {
      schemaVersion: 1,
      initialState: 'working',
      states: ['working'],
      transitions: [],
      relations: []
    },
    scopeIds: [],
    scopeRevision: 'fixed',
    childIds: ['first', 'second'],
    state: 'running',
    phase: 'working',
    revision: 0,
    waitRevision: 0,
    decisions: 1,
    paused: false,
    traceId: 'trace',
    spanId: 'span',
    outputs: [],
    children,
    reviews: ['first', 'second'].map((nodeId) => ({
      nodeId: `review-${nodeId}`,
      responsibleNodeId: nodeId,
      requestId: `review-${nodeId}-round-1`,
      state: nodeId === 'first' ? firstKind : 'human-wait',
      round: 1,
      reworkTaskId: `${nodeId}-rework`
    }))
  }
  const store = new CoordinationStore(db)
  store.create(run, [])
  const assignment = vi.fn((identity: { nodeId: string }) => ({
    snapshot: { taskId: `${identity.nodeId}-rework` },
    state: identity.nodeId === 'first' ? 'waiting' : 'completed',
    outputRefs: identity.nodeId === 'first' ? [] : [output]
  }))
  const start = vi.fn(),
    prepareRework = vi.fn(),
    publish = vi.fn(async () => {})
  const controller = new CoordinatorReviews(
    db,
    () => file,
    { assignment, run: start, prepareRework } as unknown as FlowAgentDesktopHost,
    publish,
    () => file
  )
  return { controller, store, run, publish, assignment, start, prepareRework, output }
}

describe('independent review and rework joins', () => {
  it.each(['human-wait', 'manual-wait'] as const)(
    'collects a completed sibling past a %s without consuming another model or control step',
    async (kind) => {
      const f = fixture(kind)
      expect(await f.controller.step(f.run, new AbortController().signal)).toBe('again')
      const stored = f.store.latest('p', 'main')!
      expect(stored.reviews!.map((cycle) => cycle.state)).toEqual([kind, 'ready'])
      expect(stored.children.map((child) => child.state)).toEqual(['waiting', 'completed'])
      expect(stored.children[1].outputs).toEqual([f.output])
      expect(stored.children[0].outputs).toEqual([])
      expect(stored.reviews![0].requestId).toBe('review-first-round-1')
      expect(stored.decisions).toBe(1)
      expect(stored.controlSteps).toBeUndefined()
      expect(f.publish).toHaveBeenCalledTimes(1)
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'second', taskId: 'second-rework' }),
        expect.any(AbortSignal)
      )
      expect(f.start).not.toHaveBeenCalled()
      expect(f.prepareRework).not.toHaveBeenCalled()
    }
  )

  it('returns waiting after examining all blocked siblings without publishing or starting tasks', async () => {
    const f = fixture('human-wait')
    f.assignment
      .mockReturnValueOnce({
        snapshot: { taskId: 'first-rework' },
        state: 'waiting',
        outputRefs: []
      })
      .mockReturnValueOnce({
        snapshot: { taskId: 'second-rework' },
        state: 'waiting',
        outputRefs: []
      })
    expect(await f.controller.step(f.run, new AbortController().signal)).toBe('wait')
    expect(f.assignment).toHaveBeenCalledTimes(2)
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.store.latest('p', 'main')!.children.every((child) => child.state === 'waiting')).toBe(
      true
    )
  })

  it('rejects a sibling with an unrelated replacement task instead of adopting its result', async () => {
    const f = fixture('manual-wait')
    f.assignment.mockReturnValue({
      snapshot: { taskId: 'foreign-rework' },
      state: 'completed',
      outputRefs: [f.output]
    })
    await expect(f.controller.step(f.run, new AbortController().signal)).rejects.toMatchObject({
      code: 'RESUME_CONFLICT'
    })
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.store.latest('p', 'main')!.children[1].outputs).toEqual([])
  })

  it('does not collect a late result after a stop during sibling publication', async () => {
    const f = fixture('human-wait')
    f.publish.mockImplementation(async () => {
      const stopped = f.store.latest('p', 'main')!
      stopped.state = 'cancelled'
      f.store.save(stopped)
    })
    await expect(f.controller.step(f.run, new AbortController().signal)).rejects.toMatchObject({
      code: 'AGENT_CANCELLED'
    })
    const stored = f.store.latest('p', 'main')!
    expect(stored.state).toBe('cancelled')
    expect(stored.children[1].outputs).toEqual([])
    expect(stored.reviews![1].state).toBe('human-wait')
  })
})
