import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, utimesSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const directories: string[] = [],
  children = new Set<ChildProcess>()
function isolated() {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-combined-'))
  directories.push(directory)
  return directory
}
let worker: string
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  worker = join(isolated(), 'worker.cjs')
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
      throw new Error('COMBINED_CLEANUP_REJECTED')
    rmSync(directory, { recursive: true, force: true })
  }
})
interface State {
  status: string
  phase: string | null
  version: number
  dbVersion: number
  stopped: boolean
  downloads: number
  queries: number
  mutations: number
  unexpected: number
  tasks: number
  locks: number
  redacted: boolean
  controls: number
  unpairedControls: number
  duplicateControlEnds: number
  unpairedMedia: number
  unpairedDownloads: number
  snapshot: { taskId: string; phase: string; mediaId?: string }
  media: { id: string; valid: boolean }[]
  error?: string
}
async function run(
  directory: string,
  mode: string,
  kill = false,
  onHeld?: () => Promise<void>
): Promise<State> {
  const child = spawn(process.execPath, [worker, directory, mode], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.add(child)
  let output = '',
    terminated = false,
    held = false
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  try {
    return await new Promise((done, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (onHeld && !held && output.includes('"held":true')) {
          held = true
          void onHeld().catch(reject)
        }
        if (kill && !terminated && output.includes('"cut":true')) {
          terminated = true
          child.kill('SIGKILL')
        }
      })
      child.once('error', reject)
      child.once('close', (code) => {
        children.delete(child)
        if (kill && terminated) done({} as State)
        else if (!kill && output.trim()) {
          const result = JSON.parse(output.trim().split('\n').at(-1)!) as State
          if (code === 0 || mode === 'changed-input') done(result)
          else reject(new Error(`COMBINED_${mode}_${result.error ?? 'FAILED'}`))
        } else reject(new Error(`COMBINED_${mode}_EXIT_${code}`))
      })
    })
  } finally {
    clearTimeout(timer)
  }
}
function ageProjectLock(directory: string) {
  const projectId = readFileSync(join(directory, 'project-id'), 'utf8')
  const old = new Date(Date.now() - 60000)
  utimesSync(join(directory, 'projects', projectId, 'project.json.write-lock'), old, old)
}
async function preparedAndStopped(directory: string) {
  await run(directory, 'init')
  expect(await run(directory, 'query-drop')).toMatchObject({
    status: 'unknown',
    downloads: 0,
    tasks: 1,
    mutations: 0
  })
  await run(directory, 'prepared', true)
  expect(await run(directory, 'stop')).toMatchObject({
    status: 'unknown',
    stopped: true,
    phase: 'prepared',
    media: [],
    downloads: 1,
    mutations: 0
  })
}
describe('C4 combined failure acceptance', () => {
  it('diagnostic sink failure during explicit offline recovery preserves one committed result', async () => {
    const directory = isolated()
    await preparedAndStopped(directory)
    const result = await run(directory, 'resume-logger-failure')
    expect(result).toMatchObject({
      status: 'success',
      phase: 'committed',
      downloads: 1,
      tasks: 1,
      mutations: 0
    })
    expect(result.media).toHaveLength(1)
    expect(result.media[0].valid).toBe(true)
    const saved = await run(directory, 'publish')
    expect(saved.snapshot.mediaId).toBe(result.media[0].id)
    expect(saved.locks).toBe(0)
  }, 45000)
  it('stop arriving during recovered-file promotion prevents media commit until explicit resume', async () => {
    const directory = isolated()
    await preparedAndStopped(directory)
    const stopped = await run(directory, 'resume-hold', false, async () => {
      expect(await run(directory, 'stop-release')).toMatchObject({ stopped: true })
    })
    expect(stopped).toMatchObject({
      status: 'unknown',
      stopped: true,
      phase: 'prepared',
      media: [],
      downloads: 1,
      mutations: 0
    })
    expect(await run(directory, 'resume')).toMatchObject({
      status: 'success',
      downloads: 1,
      mutations: 0
    })
    expect((await run(directory, 'inspect')).media).toHaveLength(1)
  }, 45000)
  it.each(['tmp', 'promoted', 'transaction'])(
    'unknown + stopped prepared + save %s crash + concurrent resume retains one result and editable snapshot',
    async (boundary) => {
      const directory = isolated()
      await preparedAndStopped(directory)
      await run(directory, `save-${boundary}`, true)
      ageProjectLock(directory)
      const stopped = await Promise.all([run(directory, 'control'), run(directory, 'control')])
      for (const state of stopped)
        expect(state).toMatchObject({
          status: 'unknown',
          stopped: true,
          media: [],
          phase: 'prepared',
          downloads: 1,
          mutations: 0
        })
      expect(stopped[1].version).toBe(boundary === 'tmp' ? 1 : 2)
      expect(stopped[1].dbVersion).toBe(stopped[1].version)
      expect(await run(directory, 'changed-input')).toEqual({ error: 'TASK_OUTCOME_UNKNOWN' })
      await Promise.all([run(directory, 'resume'), run(directory, 'control')])
      const recovered = await run(directory, 'control')
      expect(recovered).toMatchObject({
        status: 'success',
        phase: 'committed',
        stopped: false,
        downloads: 1,
        tasks: 1,
        mutations: 0,
        unexpected: 0,
        redacted: true,
        duplicateControlEnds: 0,
        unpairedControls: 1,
        unpairedMedia: 1,
        unpairedDownloads: 0
      })
      expect(recovered.media).toHaveLength(1)
      expect(recovered.media[0].valid).toBe(true)
      const published = await run(directory, 'publish')
      expect(published.snapshot).toEqual({
        taskId: 'task',
        phase: 'success',
        mediaId: recovered.media[0].id
      })
      expect(published).toMatchObject({
        version: recovered.version + 1,
        dbVersion: recovered.version + 1,
        locks: 0,
        downloads: 1,
        tasks: 1,
        mutations: 0
      })
      const reopened = await run(directory, 'inspect')
      expect(reopened.snapshot).toEqual(published.snapshot)
      expect(reopened.media).toEqual(published.media)
      expect((await run(directory, 'control')).queries).toBe(reopened.queries)
    },
    45000
  )
  it('corrupted prepared + stop + save crash never falls back to generation or publishes unverified bytes', async () => {
    const directory = isolated()
    await preparedAndStopped(directory)
    await run(directory, 'save-promoted', true)
    ageProjectLock(directory)
    await run(directory, 'corrupt')
    await Promise.all([run(directory, 'resume'), run(directory, 'control')])
    const state = await run(directory, 'control')
    expect(state).toMatchObject({
      status: 'unknown',
      phase: 'prepared',
      media: [],
      tasks: 1,
      downloads: 1,
      mutations: 0,
      unexpected: 0,
      redacted: true,
      unpairedControls: 1,
      duplicateControlEnds: 0
    })
    expect(state.snapshot).toEqual({ taskId: 'task', phase: 'stopped' })
    expect(state.dbVersion).toBe(state.version)
  }, 45000)
})
