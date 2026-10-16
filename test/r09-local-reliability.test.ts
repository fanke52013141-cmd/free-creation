import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const directories: string[] = [],
  children = new Set<ChildProcess>()
const require = createRequire(import.meta.url)
const { qaOutputPath } = require('../scripts/qa-output.cjs')
function isolated() {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-combined-'))
  directories.push(directory)
  return directory
}
let worker: string
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  worker = join(isolated(), 'r09-worker.cjs')
  await build({
    entryPoints: [resolve('test/fixtures/c4-combined-worker.ts')],
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
    [...children].map(
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
      !basename(directory).startsWith('canvas-combined-')
    )
      throw new Error('R09_CLEANUP_REJECTED')
    rmSync(directory, { recursive: true, force: true })
  }
})
async function run(directory: string, mode: string, kill = false): Promise<any> {
  const child = spawn(process.execPath, [worker, directory, mode], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  children.add(child)
  let output = '',
    cut = false
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  try {
    return await new Promise((done, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (kill && !cut && output.includes('"cut":true')) {
          cut = true
          child.kill('SIGKILL')
        }
      })
      child.once('error', reject)
      child.once('close', (code) => {
        children.delete(child)
        if (cut) return done({})
        if (code !== 0 || !output.trim()) return reject(new Error(`R09_${mode}_FAILED_${code}`))
        try {
          done(JSON.parse(output.trim().split('\n').at(-1)!))
        } catch (error) {
          reject(error)
        }
      })
    })
  } finally {
    clearTimeout(timer)
  }
}
describe('R09 bounded repeated local failures across process restarts', () => {
  it('keeps one unknown task and one download through 36 disk-failure cycles, then publishes once', async () => {
    const directory = isolated()
    await run(directory, 'init')
    expect(await run(directory, 'query-drop')).toMatchObject({ status: 'unknown', downloads: 0 })
    await run(directory, 'prepared', true)
    const parent = qaOutputPath('qa/r09-local-20261016/soak')
    mkdirSync(parent, { recursive: true })
    const evidence = mkdtempSync(join(parent, 'run-'))
    const epochs: unknown[] = []
    let state: any
    for (let epoch = 0; epoch < 6; epoch++) {
      state = await run(directory, `soak-${epoch}`)
      expect(state).toMatchObject({
        status: 'unknown',
        phase: 'prepared',
        stopped: true,
        media: [],
        tasks: 1,
        downloads: 1,
        mutations: 0,
        unexpected: 0,
        locks: 0,
        soakCycles: (epoch + 1) * 6,
        version: 1,
        dbVersion: 1,
        redacted: true,
        unpairedControls: 1,
        duplicateControlEnds: 0,
        unpairedMedia: 1,
        unpairedDownloads: 0
      })
      expect(state.storageFailurePhases).toEqual([
        'write-tmp',
        'promote-tmp',
        'update-db',
        'write-tmp',
        'promote-tmp',
        'update-db'
      ])
      if (epoch === 2) expect(state.diagnosticDrops).toBeGreaterThan(0)
      else expect(state.diagnosticDrops).toBe(0)
      epochs.push(state)
    }
    const recovered = await run(directory, 'resume')
    expect(recovered).toMatchObject({
      status: 'success',
      phase: 'committed',
      tasks: 1,
      downloads: 1,
      mutations: 0,
      unexpected: 0,
      soakCycles: 36,
      redacted: true,
      queries: state.queries
    })
    expect(recovered.media).toHaveLength(1)
    expect(recovered.media[0].valid).toBe(true)
    const saved = await run(directory, 'publish')
    expect(saved).toMatchObject({
      version: 2,
      dbVersion: 2,
      locks: 0,
      snapshot: { taskId: 'task', phase: 'success', mediaId: recovered.media[0].id }
    })
    for (let repeat = 0; repeat < 3; repeat++) {
      const reopened = await run(directory, 'control')
      expect(reopened.snapshot).toEqual(saved.snapshot)
      expect(reopened.media).toEqual(saved.media)
      expect(reopened).toMatchObject({
        downloads: 1,
        tasks: 1,
        mutations: 0,
        queries: saved.queries,
        locks: 0
      })
    }
    const projectId = readFileSync(join(directory, 'project-id'), 'utf8')
    expect(
      JSON.parse(readFileSync(join(directory, 'projects', projectId, 'project.json'), 'utf8'))
        .tldrawSnapshot
    ).toEqual(saved.snapshot)
    for (const name of readdirSync(directory).filter((name) =>
      /^diagnostics-\d+\.jsonl$/.test(name)
    )) {
      cpSync(join(directory, name), join(evidence, name))
    }
    writeFileSync(
      join(evidence, 'soak-report.json'),
      JSON.stringify(
        {
          status: 'passed',
          cycles: 36,
          epochs,
          recovered,
          saved,
          scope: 'bounded repeated injections; no physical power loss or supplier calls'
        },
        null,
        2
      )
    )
  }, 180000)
})
