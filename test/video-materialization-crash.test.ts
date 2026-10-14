import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const directories: string[] = []
function isolated() {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-video-crash-'))
  directories.push(directory)
  return directory
}
let worker: string
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  worker = join(isolated(), 'worker.cjs')
  await build({
    entryPoints: [resolve('test/fixtures/video-materialization-crash-worker.ts')],
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
      !basename(directory).startsWith('canvas-video-crash-')
    )
      throw new Error('VIDEO_CLEANUP_REJECTED')
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
    terminated = false,
    errors = ''
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
        else reject(new Error(`VIDEO_FIXTURE_FAILED:${boundary}:${errors}`))
      })
    })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}
describe('C4 video materialization process termination', () => {
  it.each(['prepared', 'promoted', 'transaction', 'committed', 'published'])(
    'recovers %s with one media identity and no network or redownload',
    async (boundary) => {
      const directory = isolated()
      await run(directory, boundary, true)
      const before = JSON.parse(await run(directory, 'inspect'))
      expect(before.media).toHaveLength(['committed', 'published'].includes(boundary) ? 1 : 0)
      const recovered = JSON.parse(await run(directory, 'recover'))
      expect(recovered).toMatchObject({
        status: 'success',
        downloads: 1,
        network: 0,
        bytes: ['verified-video-material'],
        diagnosticRedaction: true,
        lifecyclePaired: true,
        output: { videoMaterialization: { phase: 'committed' } }
      })
      expect(recovered.media).toHaveLength(1)
      expect(JSON.parse(await run(directory, 'recover'))).toEqual(recovered)
      expect(JSON.parse(await run(directory, 'retry'))).toEqual(recovered)
    },
    45000
  )
  it('never promotes partial download bytes; explicit retry keeps one media identity', async () => {
    const directory = isolated()
    await run(directory, 'partial', true)
    expect(JSON.parse(await run(directory, 'recover'))).toMatchObject({
      status: 'unknown',
      media: [],
      downloads: 1,
      network: 0
    })
    const result = JSON.parse(await run(directory, 'retry'))
    expect(result).toMatchObject({
      status: 'success',
      downloads: 2,
      bytes: ['verified-video-material']
    })
    expect(result.media).toHaveLength(1)
  }, 45000)
  it.each(['prepared', 'promoted', 'committed'])(
    'preserves corrupted %s bytes as unknown without new media or network',
    async (boundary) => {
      const directory = isolated()
      await run(directory, boundary, true)
      const result = JSON.parse(await run(directory, 'corrupt'))
      expect(result).toMatchObject({ status: 'unknown', downloads: 1, network: 0 })
      expect(result.media).toHaveLength(boundary === 'committed' ? 1 : 0)
    },
    45000
  )
  it('complete bytes without a committed receipt remain unknown until explicit download retry', async () => {
    const directory = isolated()
    await run(directory, 'unverified', true)
    expect(JSON.parse(await run(directory, 'recover'))).toMatchObject({
      status: 'unknown',
      media: [],
      downloads: 1,
      network: 0
    })
    const retried = JSON.parse(await run(directory, 'retry'))
    expect(retried).toMatchObject({
      status: 'success',
      downloads: 2,
      bytes: ['verified-video-material']
    })
    expect(retried.media).toHaveLength(1)
  }, 45000)
  it.each(['identity', 'missing', 'metadata', 'binding'])(
    'blocks %s conflicts without overwriting or contacting suppliers',
    async (mode) => {
      const directory = isolated()
      await run(directory, mode === 'metadata' ? 'promoted' : 'prepared', true)
      const result = JSON.parse(await run(directory, mode))
      expect(result).toMatchObject({
        status: 'unknown',
        downloads: 1,
        network: 0,
        lifecyclePaired: true,
        diagnosticRedaction: true
      })
      expect(result.media).toHaveLength(mode === 'metadata' ? 1 : 0)
    },
    45000
  )
})
