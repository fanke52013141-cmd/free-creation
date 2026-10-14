import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { getDb, closeDb } from '../../src/main/store/db'
import { createProject, saveProject } from '../../src/main/store/projects.repo'
import {
  materializeVideoAsset,
  recoverVideoAsset
} from '../../src/main/gateway/video-materialization'
import { acquireProcessLock } from '../../src/main/store/process-lock'
import { controlVideoTask } from '../../src/main/gateway/video'
import { migrateDatabase } from '../../src/main/store/db-migrations'
import Database from 'better-sqlite3'

const [directory, mode, label = 'worker'] = process.argv.slice(2)
if (
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-contention-')
)
  throw new Error('CONTENTION_FIXTURE_PATH_REJECTED')
process.env.CANVAS_DATA_DIR = directory
function sayMigration(): void {
  const database = new Database(join(directory, 'app.db'))
  const originalPragma = database.pragma.bind(database)
  let first = true
  database.pragma = ((statement: string, options?: { simple?: boolean }) => {
    const result = originalPragma(statement, options)
    if (first && statement === 'user_version') {
      first = false
      fs.writeSync(1, JSON.stringify({ held: true }) + '\n')
      const end = Date.now() + 15000
      while (!fs.existsSync(join(directory, `release-${label}`))) {
        if (Date.now() > end) throw new Error('MIGRATION_TIMEOUT')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      }
    }
    return result
  }) as typeof database.pragma
  try {
    migrateDatabase(database)
    fs.writeSync(1, JSON.stringify({ result: 'success' }) + '\n')
  } finally {
    database.close()
  }
  process.stdin.destroy()
}
let db: ReturnType<typeof getDb>
if (mode !== 'migrate') {
  db = getDb()
  db.pragma('synchronous = FULL')
}
const say = (value: unknown): void => {
  fs.writeSync(1, JSON.stringify(value) + '\n')
}
function hold() {
  say({ held: true })
  const end = Date.now() + 15000
  while (!fs.existsSync(join(directory, `release-${label}`))) {
    if (Date.now() > end) throw new Error('HOLD_TIMEOUT')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
}
async function main() {
  if (mode === 'init') {
    const project = createProject('测试：跨进程恢复竞争')
    saveProject({ id: project.id, expectedGraphVersion: 0, tldrawSnapshot: { edit: 'base' } })
    fs.writeFileSync(join(directory, 'project-id'), project.id)
    db.prepare(
      `INSERT INTO tasks(id,provider_id,model_id,node_id,project_id,kind,status,input,created_at,updated_at)
      VALUES ('task','provider','model','node',?,'video','unknown','{"upstreamTaskId":"remote"}',0,0)`
    ).run(project.id)
    db.prepare('INSERT INTO settings VALUES (?,?)').run('downloads', '0')
    say({ initialized: true })
    closeDb()
    return
  }
  const projectId = fs.readFileSync(join(directory, 'project-id'), 'utf8')
  say({ ready: true })
  await new Promise<void>((done) => process.stdin.once('data', () => done()))
  try {
    if (mode.startsWith('project')) {
      const mutableFs = createRequire(__filename)('fs') as typeof fs
      const write = mutableFs.writeFileSync
      if (mode === 'project-hold')
        mutableFs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
          write(...args)
          if (String(args[0]).endsWith('project.json.tmp')) hold()
        }) as typeof fs.writeFileSync
      saveProject({ id: projectId, expectedGraphVersion: 1, tldrawSnapshot: { edit: label } })
    } else if (mode.startsWith('lease')) {
      const lock = acquireProcessLock('fixture-resource')
      hold()
      try {
        lock.assertOwned()
        say({ fenced: false })
      } catch {
        say({ fenced: true })
      }
      lock.release()
    } else {
      if (mode === 'video-prepared') {
        const prepare = db.prepare.bind(db)
        db.prepare = ((sql: string) => {
          const statement = prepare(sql)
          if (sql.startsWith('UPDATE tasks SET output=')) {
            const run = statement.run.bind(statement)
            statement.run = ((...args: unknown[]) => {
              const result = run(...args)
              if (JSON.parse(String(args[0])).videoMaterialization.phase === 'prepared') hold()
              return result
            }) as typeof statement.run
          }
          return statement
        }) as typeof db.prepare
      }
      if (mode === 'video-control') await controlVideoTask('task')
      else if (mode === 'video-recover') await recoverVideoAsset('task', projectId)
      else
        await materializeVideoAsset(
          'task',
          projectId,
          async (target) => {
            db.prepare(
              "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='downloads'"
            ).run()
            fs.writeFileSync(target, 'complete-video-material')
            if (mode === 'video-hold') hold()
          },
          () =>
            Boolean(
              JSON.parse(
                (db.prepare("SELECT input FROM tasks WHERE id='task'").get() as { input: string })
                  .input
              ).cancelRequested
            )
        )
    }
    say({ result: 'success' })
  } catch (error) {
    say({ result: error instanceof Error ? error.name + ':' + error.message : 'unexpected' })
  } finally {
    closeDb()
    process.stdin.destroy()
  }
}
if (mode === 'migrate') sayMigration()
else
  void main().catch(() => {
    say({ result: 'FIXTURE_FAILED' })
    closeDb()
    process.stdin.destroy()
    process.exitCode = 1
  })
