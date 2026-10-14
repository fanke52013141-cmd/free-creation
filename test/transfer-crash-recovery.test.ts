import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

const directories: string[] = []
const isolated = () => {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-transfer-crash-'))
  directories.push(directory)
  return directory
}
let worker: string
beforeAll(async () => {
  const require = createRequire(import.meta.url),
    { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  worker = join(isolated(), 'worker.cjs')
  await build({
    entryPoints: [resolve('test/fixtures/transfer-crash-worker.ts')],
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
      !basename(directory).startsWith('canvas-transfer-crash-')
    )
      throw new Error('TRANSFER_CLEANUP_REJECTED')
    rmSync(directory, { recursive: true, force: true })
  }
})
async function run(directory: string, boundary: string, kill: boolean): Promise<string> {
  const child = spawn(process.execPath, [worker, directory, boundary], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = '',
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
      child.once('error', reject)
      child.once('close', (code) => {
        if (kill ? terminated : code === 0) done(output)
        else reject(new Error('TRANSFER_CRASH_FIXTURE_FAILED:' + boundary))
      })
    })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}
describe('C4 real import directory and SQLite transaction termination', () => {
  it.each(['staging', 'promoted', 'transaction', 'committed'])(
    'recovers import after hard kill at %s without a visible incomplete project',
    async (boundary) => {
      const directory = isolated()
      await run(directory, boundary, true)
      const db = new Database(join(directory, 'app.db'))
      const source = readFileSync(join(directory, 'source-id'), 'utf8')
      try {
        expect(db.prepare('SELECT count(*) AS n FROM projects WHERE id!=?').get(source)).toEqual({
          n: boundary === 'committed' ? 1 : 0
        })
        expect(
          db
            .prepare('SELECT count(*) AS n FROM flow_asset_versions WHERE project_id!=?')
            .get(source)
        ).toEqual({ n: boundary === 'committed' ? 1 : 0 })
      } finally {
        db.close()
      }
      const projectRoot = join(directory, 'projects')
      const residual = readdirSync(projectRoot).filter((id) => id !== source)
      expect(residual).toHaveLength(1)
      expect(existsSync(join(projectRoot, residual[0], 'project.json'))).toBe(true)
      const recovered = JSON.parse(await run(directory, 'recover', false))
      expect(recovered).toMatchObject({
        visibleImported: boundary === 'committed' ? 1 : 0,
        assets: boundary === 'committed' ? 1 : 0,
        readable: true,
        missing: 0,
        pending: 0,
        recovered: boundary === 'staging' ? 1 : 0,
        unlisted: ['promoted', 'transaction'].includes(boundary) ? 1 : 0
      })
      const again = JSON.parse(await run(directory, 'recover', false))
      expect(again).toEqual({ ...recovered, recovered: 0 })
      if (boundary === 'staging')
        expect(readdirSync(join(projectRoot, '.recovery'))).toHaveLength(1)
      else expect(existsSync(join(projectRoot, residual[0], 'project.json'))).toBe(true)
    },
    45000
  )
})
