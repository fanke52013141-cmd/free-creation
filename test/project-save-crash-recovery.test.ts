import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

const directories: string[] = []
function isolated() {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-save-main-'))
  directories.push(directory)
  return directory
}
let worker: string
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  worker = join(isolated(), 'worker.cjs')
  await build({
    entryPoints: [resolve('test/fixtures/project-save-crash-worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3', 'electron'],
    alias: { '@shared': resolve('src/shared') },
    logLevel: 'silent'
  })
})
afterAll(() => {
  for (const directory of directories) {
    if (
      resolve(directory, '..') !== resolve(tmpdir()) ||
      !basename(directory).startsWith('canvas-save-main-')
    )
      throw new Error('SAVE_CLEANUP_REJECTED')
    rmSync(directory, { recursive: true, force: true })
  }
})
async function run(directory: string, boundary: string, kill = false): Promise<string> {
  const child = spawn(process.execPath, [worker, directory, boundary], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = '',
    errors = '',
    terminated = false
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  try {
    return await new Promise((done, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (kill && !terminated && output.includes('cut-ready\n')) {
          terminated = true
          child.kill('SIGKILL')
        }
      })
      child.stderr.on('data', (chunk) => {
        errors += chunk
      })
      child.once('error', reject)
      child.once('close', (code) => {
        if (kill ? terminated : code === 0) done(output)
        else reject(new Error('SAVE_FIXTURE_FAILED:' + boundary + ':' + errors))
      })
    })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}
function lockPath(directory: string) {
  return join(
    directory,
    'projects',
    readFileSync(join(directory, 'project-id'), 'utf8'),
    'project.json.write-lock'
  )
}
function ageLock(path: string) {
  const old = new Date(Date.now() - 60000)
  utimesSync(path, old, old)
}
describe('C4 main project save hard termination', () => {
  it.each(['tmp', 'flushed', 'bak', 'promoted', 'transaction', 'committed'])(
    'preserves the last promoted snapshot after termination at %s without replay',
    async (boundary) => {
      const directory = isolated()
      await run(directory, boundary, true)
      const id = readFileSync(join(directory, 'project-id'), 'utf8')
      const db = new Database(join(directory, 'app.db'))
      try {
        expect(db.prepare('SELECT graph_version FROM projects WHERE id = ?').get(id)).toEqual({
          graph_version: boundary === 'committed' ? 2 : 1
        })
      } finally {
        db.close()
      }
      const version = ['tmp', 'flushed', 'bak'].includes(boundary) ? 1 : 2
      const restored = JSON.parse(await run(directory, 'recover'))
      expect(restored).toMatchObject({
        version,
        snapshot: { material: version === 1 ? 'last-valid-edit' : 'new-valid-edit' },
        row: { graph_version: version },
        blocked: false
      })
      expect(JSON.parse(await run(directory, 'recover'))).toEqual(restored)
      expect(JSON.parse(await run(directory, 'continue'))).toMatchObject({ blocked: true })
      ageLock(lockPath(directory))
      expect(JSON.parse(await run(directory, 'stale-edit'))).toMatchObject({ conflict: true })
      expect(JSON.parse(await run(directory, 'recover'))).toEqual(restored)
      expect(existsSync(lockPath(directory))).toBe(false)
      expect(JSON.parse(await run(directory, 'continue'))).toMatchObject({
        version,
        saved: version + 1,
        blocked: false
      })
      expect(existsSync(lockPath(directory))).toBe(false)
      expect(JSON.parse(await run(directory, 'recover'))).toMatchObject({
        version: version + 1,
        snapshot: { material: 'explicit-next-edit' }
      })
    },
    45000
  )
  it.each(['live', 'legacy', 'invalid', 'unprobeable'])(
    'handles aged %s locks conservatively',
    async (kind) => {
      const directory = isolated()
      await run(directory, 'tmp', true)
      const path = lockPath(directory)
      writeFileSync(
        path,
        kind === 'legacy'
          ? ''
          : kind === 'invalid'
            ? '{broken'
            : JSON.stringify({ pid: kind === 'live' ? process.pid : 9007199254740991 })
      )
      ageLock(path)
      expect(JSON.parse(await run(directory, 'continue'))).toMatchObject({
        blocked: kind !== 'legacy',
        ...(kind === 'legacy' ? { saved: 2 } : {})
      })
      expect(existsSync(path)).toBe(kind !== 'legacy')
    },
    45000
  )
})
