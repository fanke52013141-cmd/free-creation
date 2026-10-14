import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { stopAgentVideos } from '../src/main/agent-flow/video-tasks'
const fixture = vi.hoisted(() => ({ db: null as unknown as Database.Database }))
vi.mock('../src/main/store/db', () => ({ getDb: () => fixture.db }))
afterEach(async () => {
  await Promise.resolve()
  fixture.db.close()
})
describe('Agent video stop propagation', () => {
  it('persists stop on original bound tasks while preserving unknown occupancy and unrelated tasks', async () => {
    const db = (fixture.db = new Database(':memory:'))
    migrateDatabase(db)
    for (const id of ['project-a', 'project-b'])
      db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run(id, id)
    for (const [project, command, owner] of [
      ['project-a', 'owned', 'agent-task'],
      ['project-a', 'other', 'other-task'],
      ['project-b', 'owned', 'agent-task']
    ]) {
      db.prepare('INSERT OR IGNORE INTO flow_command_tasks VALUES (?,?,?,?)').run(
        owner,
        project,
        'shape:agent',
        4
      )
      db.prepare(
        "INSERT INTO flow_commands(project_id,command_id,signature,command_json,target_node_id,task_id,lease_id,owner_session,run_id,state,receipt_json,created_at) VALUES (?,?,'signature','{}',?,?,'lease','session','run','unknown','{}',0)"
      ).run(project, command, `node-${command}`, owner)
    }
    for (const [id, project, command, status] of [
      ['original', 'project-a', 'owned', 'unknown'],
      ['foreign', 'project-a', 'other', 'unknown'],
      ['other-project', 'project-b', 'owned', 'unknown'],
      ['finished', 'project-a', 'owned', 'success']
    ]) {
      db.prepare(
        "INSERT INTO tasks(id,provider_id,model_id,node_id,project_id,kind,status,input,created_at,updated_at) VALUES (?,'provider','model',?,?,'video',?,?,0,0)"
      ).run(
        id,
        `node-${command}`,
        project,
        status,
        JSON.stringify({ flowCommandId: command, upstreamTaskId: 'remote' })
      )
    }
    db.prepare(
      "INSERT INTO tasks(id,provider_id,model_id,node_id,project_id,kind,status,input,created_at,updated_at) VALUES ('malformed','provider','model','node','project-a','video','unknown','broken-json',0,0)"
    ).run()
    stopAgentVideos(db, 'project-a', 'agent-task')
    const row = db.prepare("SELECT status,input FROM tasks WHERE id='original'").get() as {
      status: string
      input: string
    }
    expect(row.status).toBe('unknown')
    expect(JSON.parse(row.input)).toMatchObject({ upstreamTaskId: 'remote', cancelRequested: true })
    expect(
      db
        .prepare(
          "SELECT state FROM flow_commands WHERE project_id='project-a' AND command_id='owned'"
        )
        .get()
    ).toEqual({ state: 'unknown' })
    for (const id of ['foreign', 'other-project', 'finished']) {
      const input = (db.prepare('SELECT input FROM tasks WHERE id=?').get(id) as { input: string })
        .input
      expect(JSON.parse(input).cancelRequested).toBeUndefined()
    }
    await Promise.resolve()
  })
})
