import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

const directories: string[] = [],
  children: ChildProcessWithoutNullStreams[] = []
function isolated() {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-contention-'))
  directories.push(directory)
  return directory
}
let worker: string
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  worker = join(isolated(), 'worker.cjs')
  await build({
    entryPoints: [resolve('test/fixtures/recovery-contention-worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3', 'electron'],
    alias: { '@shared': resolve('src/shared') },
    logLevel: 'silent'
  })
})
afterAll(async () => {
  await Promise.all(
    children
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map(
        (child) =>
          new Promise<void>((done) => {
            child.once('close', () => done())
            child.kill('SIGKILL')
          })
      )
  )
  for (const directory of directories) {
    if (
      resolve(directory, '..') !== resolve(tmpdir()) ||
      !basename(directory).startsWith('canvas-contention-')
    )
      throw new Error('CONTENTION_CLEANUP_REJECTED')
    rmSync(directory, { recursive: true, force: true })
  }
})
function start(directory: string, mode: string, label = mode) {
  const child = spawn(process.execPath, [worker, directory, mode, label], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  children.push(child)
  let pending = '',
    closed = false
  const records: Array<Record<string, unknown>> = [],
    listeners = new Set<() => void>()
  child.stdout.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop()!
    for (const line of lines) if (line.trim()) records.push(JSON.parse(line))
    for (const listener of listeners) listener()
  })
  const exited = new Promise<void>((done) =>
    child.once('close', () => {
      closed = true
      for (const listener of listeners) listener()
      done()
    })
  )
  const wait = (key: string): Promise<Record<string, unknown>> =>
    new Promise((done, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check)
        child.kill('SIGKILL')
        reject(new Error(`WAIT_${mode}_${key}`))
      }, 12000)
      function check() {
        const record = records.find((item) => key in item)
        if (record || closed) {
          clearTimeout(timer)
          listeners.delete(check)
          if (record) done(record)
          else reject(new Error(`EARLY_EXIT_${mode}_${key}`))
        }
      }
      listeners.add(check)
      check()
    })
  return {
    child,
    wait,
    exited,
    go: () => child.stdin.write('go\n'),
    release: () => writeFileSync(join(directory, `release-${label}`), 'release'),
    kill: async () => {
      child.kill('SIGKILL')
      await exited
    }
  }
}
function withDb<T>(directory: string, work: (db: Database.Database) => T): T {
  const db = new Database(join(directory, 'app.db'))
  try {
    return work(db)
  } finally {
    db.close()
  }
}
async function setup() {
  const directory = isolated(),
    init = start(directory, 'init')
  await init.wait('initialized')
  await init.exited
  return directory
}
async function execute(directory: string, mode: string, label = mode) {
  const process = start(directory, mode, label)
  await process.wait('ready')
  process.go()
  const result = await process.wait('result')
  await process.exited
  return result.result as string
}
const id = (directory: string) => readFileSync(join(directory, 'project-id'), 'utf8')
describe('C4 independent process recovery contention', () => {
  it('never steals a paused live project writer even when the legacy file is old', async () => {
    const directory = await setup(),
      owner = start(directory, 'project-hold', 'owner')
    await owner.wait('ready')
    owner.go()
    await owner.wait('held')
    const lockFile = join(directory, 'projects', id(directory), 'project.json.write-lock')
    const old = new Date(Date.now() - 60000)
    utimesSync(lockFile, old, old)
    expect(await execute(directory, 'project-save', 'contender')).toContain(
      'GraphWriteInProgressError'
    )
    owner.release()
    expect((await owner.wait('result')).result).toBe('success')
    await owner.exited
    expect(
      JSON.parse(readFileSync(join(directory, 'projects', id(directory), 'project.json'), 'utf8'))
        .meta.graphVersion
    ).toBe(2)
    expect(existsSync(lockFile)).toBe(false)
  }, 30000)
  it.each(['empty', 'dead-owner'])(
    'two recoverers serialize %s legacy-file reclamation and preserve optimistic versions',
    async (kind) => {
      const directory = await setup()
      const path = join(directory, 'projects', id(directory), 'project.json.write-lock')
      if (kind === 'dead-owner') {
        const owner = start(directory, 'project-hold', 'killed')
        await owner.wait('ready')
        owner.go()
        await owner.wait('held')
        await owner.kill()
      } else writeFileSync(path, '')
      const old = new Date(Date.now() - 60000)
      utimesSync(path, old, old)
      const a = start(directory, 'project-save', 'a'),
        b = start(directory, 'project-save', 'b')
      await Promise.all([a.wait('ready'), b.wait('ready')])
      a.go()
      b.go()
      const results = await Promise.all([a.wait('result'), b.wait('result')])
      await Promise.all([a.exited, b.exited])
      expect(results.filter((result) => result.result === 'success')).toHaveLength(1)
      expect(String(results.find((result) => result.result !== 'success')?.result)).toMatch(
        /GraphWriteInProgressError|GraphVersionConflictError/
      )
      expect(
        JSON.parse(readFileSync(join(directory, 'projects', id(directory), 'project.json'), 'utf8'))
          .meta.graphVersion
      ).toBe(2)
      expect(
        withDb(directory, (db) => db.prepare('SELECT count(*) AS n FROM process_locks').get())
      ).toEqual({ n: 0 })
    },
    30000
  )
  it('only one live materializer writes the staging file; successor reuses one committed media', async () => {
    const directory = await setup(),
      owner = start(directory, 'video-hold', 'owner')
    await owner.wait('ready')
    owner.go()
    await owner.wait('held')
    expect(await execute(directory, 'video-save', 'other')).toContain('GraphWriteInProgressError')
    owner.release()
    expect((await owner.wait('result')).result).toBe('success')
    await owner.exited
    expect(await execute(directory, 'video-save', 'retry')).toBe('success')
    expect(withDb(directory, (db) => db.prepare('SELECT count(*) AS n FROM media').get())).toEqual({
      n: 1
    })
    expect(
      withDb(directory, (db) =>
        db.prepare("SELECT value FROM settings WHERE key='downloads'").get()
      )
    ).toEqual({ value: '1' })
  }, 30000)
  it.each(['video-hold', 'video-prepared'])(
    'after killing %s two recoverers commit a single fixed media identity',
    async (mode) => {
      const directory = await setup(),
        owner = start(directory, mode, 'owner')
      await owner.wait('ready')
      owner.go()
      await owner.wait('held')
      await owner.kill()
      const a = start(directory, 'video-save', 'a'),
        b = start(directory, 'video-save', 'b')
      await Promise.all([a.wait('ready'), b.wait('ready')])
      a.go()
      b.go()
      const results = await Promise.all([a.wait('result'), b.wait('result')])
      await Promise.all([a.exited, b.exited])
      const reclaimed = results.some((result) => result.result === 'success')
      const reusedPid = [a.child.pid, b.child.pid].includes(owner.child.pid)
      if (!reclaimed && reusedPid) {
        // A new process with the killed owner's PID must remain protected.
        expect(
          results.every((result) => String(result.result).includes('GraphWriteInProgressError'))
        ).toBe(true)
        expect(
          withDb(directory, (db) => db.prepare('SELECT count(*) AS n FROM media').get())
        ).toEqual({ n: 0 })
        expect(await execute(directory, 'video-save', 'after-reused-owner-exit')).toBe('success')
      } else {
        expect(
          reclaimed,
          JSON.stringify({
            results,
            ownerPid: owner.child.pid,
            contenders: [a.child.pid, b.child.pid]
          })
        ).toBe(true)
      }
      expect(await execute(directory, 'video-recover')).toBe('success')
      expect(
        withDb(directory, (db) => db.prepare('SELECT count(*) AS n FROM media').get())
      ).toEqual({ n: 1 })
      expect(
        withDb(directory, (db) =>
          db.prepare("SELECT value FROM settings WHERE key='downloads'").get()
        )
      ).toEqual({ value: mode === 'video-hold' ? '2' : '1' })
    },
    30000
  )
  it('stale token holders cannot write or release a successor lock', async () => {
    const directory = await setup(),
      owner = start(directory, 'lease-hold', 'owner')
    await owner.wait('ready')
    owner.go()
    await owner.wait('held')
    withDb(directory, (db) =>
      db
        .prepare(
          "UPDATE process_locks SET token='successor',pid=? WHERE resource='fixture-resource'"
        )
        .run(process.pid)
    )
    owner.release()
    expect((await owner.wait('fenced')).fenced).toBe(true)
    await owner.exited
    expect(
      withDb(directory, (db) =>
        db.prepare("SELECT token FROM process_locks WHERE resource='fixture-resource'").get()
      )
    ).toEqual({ token: 'successor' })
  }, 30000)
  it('inspection of an occupied task does not overwrite the active owner state', async () => {
    const directory = await setup(),
      owner = start(directory, 'video-hold', 'owner')
    await owner.wait('ready')
    owner.go()
    await owner.wait('held')
    withDb(directory, (db) => db.prepare("UPDATE tasks SET status='running' WHERE id='task'").run())
    expect(await execute(directory, 'video-control')).toBe('success')
    expect(
      withDb(directory, (db) => db.prepare("SELECT status FROM tasks WHERE id='task'").get())
    ).toEqual({ status: 'running' })
    owner.release()
    await owner.wait('result')
    await owner.exited
  }, 30000)
  it('a late materializer with a replaced token cannot publish or release the successor', async () => {
    const directory = await setup(),
      owner = start(directory, 'video-hold', 'owner')
    await owner.wait('ready')
    owner.go()
    await owner.wait('held')
    withDb(directory, (db) =>
      db
        .prepare("UPDATE process_locks SET token='successor',pid=? WHERE resource LIKE 'video:%'")
        .run(process.pid)
    )
    owner.release()
    expect(String((await owner.wait('result')).result)).toContain('GraphWriteInProgressError')
    await owner.exited
    expect(withDb(directory, (db) => db.prepare('SELECT count(*) AS n FROM media').get())).toEqual({
      n: 0
    })
    expect(
      withDb(directory, (db) =>
        db.prepare("SELECT token FROM process_locks WHERE resource LIKE 'video:%'").get()
      )
    ).toEqual({ token: 'successor' })
  }, 30000)
  it('a persistent stop during materialization blocks promotion, then explicit resume recovers once', async () => {
    const directory = await setup(),
      owner = start(directory, 'video-hold', 'owner')
    await owner.wait('ready')
    owner.go()
    await owner.wait('held')
    withDb(directory, (db) =>
      db
        .prepare("UPDATE tasks SET input=? WHERE id='task'")
        .run(JSON.stringify({ upstreamTaskId: 'remote', cancelRequested: true }))
    )
    owner.release()
    expect(String((await owner.wait('result')).result)).toContain('VIDEO_MATERIALIZATION_STOPPED')
    await owner.exited
    expect(await execute(directory, 'video-control')).toBe('success')
    expect(withDb(directory, (db) => db.prepare('SELECT count(*) AS n FROM media').get())).toEqual({
      n: 0
    })
    withDb(directory, (db) =>
      db
        .prepare("UPDATE tasks SET input=? WHERE id='task'")
        .run(JSON.stringify({ upstreamTaskId: 'remote', cancelRequested: false }))
    )
    expect(await execute(directory, 'video-control')).toBe('success')
    expect(withDb(directory, (db) => db.prepare('SELECT count(*) AS n FROM media').get())).toEqual({
      n: 1
    })
    expect(
      withDb(directory, (db) =>
        db.prepare("SELECT value FROM settings WHERE key='downloads'").get()
      )
    ).toEqual({ value: '1' })
  }, 30000)
  it('concurrent v16 starters recheck schema inside the migration write lock', async () => {
    const directory = await setup()
    withDb(directory, (db) => {
      db.exec('DROP TABLE process_locks')
      db.pragma('user_version=16')
    })
    const a = start(directory, 'migrate', 'a'),
      b = start(directory, 'migrate', 'b')
    await Promise.all([a.wait('held'), b.wait('held')])
    a.release()
    b.release()
    expect((await a.wait('result')).result).toBe('success')
    expect((await b.wait('result')).result).toBe('success')
    await Promise.all([a.exited, b.exited])
    expect(withDb(directory, (db) => db.pragma('user_version', { simple: true }))).toBe(17)
    expect(
      withDb(directory, (db) => db.prepare('SELECT count(*) AS n FROM process_locks').get())
    ).toEqual({ n: 0 })
  }, 30000)
  it.each([null, 0, 9007199254740991, process.pid])(
    'indeterminate or live owner %s remains occupied',
    async (pid) => {
      const directory = await setup()
      withDb(directory, (db) =>
        db
          .prepare('INSERT INTO process_locks VALUES (?,?,?)')
          .run('fixture-resource', 'blocked', pid ?? 'invalid')
      )
      expect(await execute(directory, 'lease-hold')).toContain('GraphWriteInProgressError')
    },
    30000
  )
})
