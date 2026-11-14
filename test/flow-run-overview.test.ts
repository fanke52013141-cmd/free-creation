// O3 流程运行统一总览（只读投影）：聚合运行状态/阶段/修订/子任务 + 可回放事件时间线，
// 事件来源归因（human.* → user，其余协调器可信事件 → agent）。不写任何状态。
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { CoordinationStore } from '../src/main/agent-flow/coordination-store'

function setup(): Database.Database {
  const db = new Database(':memory:')
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run(
    'p',
    'isolated'
  )
  return db
}

function seedRun(db: Database.Database): void {
  const run = {
    projectId: 'p',
    nodeId: 'main',
    taskId: 'run-1',
    goal: '写一篇公众号文章',
    config: {},
    stateNodeId: 'state',
    stateConfig: {},
    scopeIds: [],
    scopeRevision: '',
    childIds: ['first'],
    state: 'running',
    phase: 'working',
    revision: 2,
    waitRevision: 0,
    decisions: 0,
    paused: false,
    children: [{ nodeId: 'first', taskId: 't1', state: 'completed' }],
    outputs: [],
    traceId: 'tr',
    spanId: 'sp'
  }
  db.prepare('INSERT INTO flow_coordination_runs VALUES (?,?,?,?)').run(
    'p',
    'main',
    'run-1',
    JSON.stringify(run)
  )
  const ins = db.prepare('INSERT INTO flow_coordination_events VALUES (?,?,?,?,?,?)')
  ins.run('p', 'run-1', 'e1', 1, JSON.stringify({ event: 'flow.started', expectedRevision: 0 }), 'working')
  ins.run('p', 'run-1', 'e2', 2, JSON.stringify({ event: 'human.wait', expectedRevision: 1 }), 'waiting')
}

describe('O3 流程运行统一总览', () => {
  it('聚合运行状态/子任务与事件时间线（来源归因）', () => {
    const db = setup()
    seedRun(db)
    const overview = new CoordinationStore(db).overview('p', 'main')
    expect(overview).toMatchObject({
      projectId: 'p',
      nodeId: 'main',
      taskId: 'run-1',
      state: 'running',
      phase: 'working',
      revision: 2,
      goal: '写一篇公众号文章',
      paused: false
    })
    expect(overview!.children).toEqual([{ nodeId: 'first', taskId: 't1', state: 'completed' }])
    expect(overview!.events).toEqual([
      { eventId: 'e1', revision: 1, event: 'flow.started', state: 'working', source: 'agent' },
      { eventId: 'e2', revision: 2, event: 'human.wait', state: 'waiting', source: 'user' }
    ])
    db.close()
  })

  it('按 stateNodeId 也能定位运行（observes 关系）', () => {
    const db = setup()
    seedRun(db)
    expect(new CoordinationStore(db).overview('p', 'state')?.taskId).toBe('run-1')
    db.close()
  })

  it('无运行返回 null', () => {
    const db = setup()
    expect(new CoordinationStore(db).overview('p', 'main')).toBeNull()
    db.close()
  })
})