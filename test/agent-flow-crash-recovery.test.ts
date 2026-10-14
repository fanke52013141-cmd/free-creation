import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createServer } from 'node:http'
import Database from 'better-sqlite3'
import { crashFixture } from './fixtures/flow-crash-worker'
import { createLedgerToolPort } from '../src/main/agent-flow/ledger-tool'

const directories: string[] = []
let worker: string
const isolated = () => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-flow-crash-'))
  directories.push(dir)
  return dir
}
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  worker = join(isolated(), 'worker.cjs')
  await build({
    entryPoints: [resolve('test/fixtures/flow-crash-worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
    logLevel: 'silent'
  })
})
afterAll(() => {
  for (const dir of directories) {
    if (resolve(dir, '..') !== resolve(tmpdir()) || !basename(dir).startsWith('canvas-flow-crash-'))
      throw new Error('CRASH_CLEANUP_REJECTED')
    rmSync(dir, { recursive: true, force: true })
  }
})
async function subprocess(
  directory: string,
  boundary: string,
  terminate: boolean
): Promise<string> {
  const child = spawn(process.execPath, [worker, '--worker', directory, boundary], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = '',
    stderr = '',
    killed = false
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  try {
    return await new Promise((done, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (terminate && !killed && output.includes('cut-ready\n')) {
          killed = true
          child.kill('SIGKILL')
        }
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (code) => {
        if (terminate ? killed : code === 0) done(output)
        else
          reject(
            new Error(
              `CRASH_FIXTURE_FAILED:${boundary}:${stderr.includes('MODULE_NOT_FOUND') ? 'MODULE_NOT_FOUND' : 'PROCESS'}`
            )
          )
      })
    })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

describe('C4 real process termination and cross-store receipts', () => {
  it.each([
    ['prepared', 'unknown', 0, 0, 'FLOW_SAVED_RUN_MISMATCH'],
    ['admitted', 'unknown', 0, 0, 'FLOW_SAVED_RUN_MISMATCH'],
    ['effect-unsaved', 'unknown', 1, 0, 'FLOW_SAVED_RUN_MISMATCH'],
    ['saved-success', 'committed', 1, 1, undefined],
    ['saved-failure', 'failed', 1, 0, undefined],
    ['saved-cancelled', 'cancelled', 1, 0, undefined],
    ['saved-skipped', 'skipped', 1, 0, undefined],
    ['tampered-input', 'unknown', 1, 0, 'FLOW_SAVED_INPUT_MISMATCH'],
    ['changed-revision', 'unknown', 1, 0, 'FLOW_REVISION_CONFLICT'],
    ['receipt-transaction', 'committed', 1, 1, undefined],
    ['committed', 'committed', 1, 1, undefined]
  ])(
    'survives a hard kill at %s without replaying effects',
    async (boundary, state, effects, outputs, reason) => {
      const directory = isolated()
      await subprocess(directory, String(boundary), true)
      const interrupted = new Database(join(directory, 'flow.sqlite'))
      try {
        // Observe rollback before reconciliation can recreate an output asset.
        expect(
          interrupted
            .prepare('SELECT state FROM flow_commands WHERE command_id=?')
            .get('cut-command')
        ).toEqual({ state: boundary === 'committed' ? 'committed' : 'pending' })
        expect(
          interrupted
            .prepare('SELECT count(*) AS n FROM flow_asset_versions WHERE node_id=?')
            .get('shape:target')
        ).toEqual({ n: boundary === 'committed' ? 1 : 0 })
      } finally {
        interrupted.close()
      }
      const result = JSON.parse(await subprocess(directory, 'recover', false))
      expect(result.receipt.state).toBe(state)
      expect(result.replay).toBe(state)
      expect(result.reason).toBe(reason)
      expect(result.occupied).toBe(state === 'unknown')
      expect(result.outputCount).toBe(outputs)
      let count = 0
      try {
        count = Number(readFileSync(join(directory, 'effect-count'), 'utf8'))
      } catch {
        /* Before effect. */
      }
      expect(count).toBe(effects)
      // Repeated recovery is idempotent across another fresh process, including asset ordinal.
      const again = JSON.parse(await subprocess(directory, 'recover', false))
      expect(again.receipt).toEqual(result.receipt)
      expect(again.outputCount).toBe(outputs)
    },
    45000
  )

  it('keeps a remotely accepted request unknown after connection loss and never submits twice', async () => {
    const directory = isolated(),
      f = crashFixture(directory, true)
    let accepted = 0,
      deliveries = 0
    const server = createServer((_request, response) => {
      accepted++
      f.effect()
      response.destroy()
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    try {
      const address = server.address() as { port: number }
      const port = createLedgerToolPort(f.ledger, async (grant) => {
        deliveries++
        f.ledger.check({
          projectId: 'isolated',
          commandId: grant.command.commandId,
          leaseId: grant.leaseId
        })
        await fetch(`http://127.0.0.1:${address.port}`, {
          method: 'POST',
          body: 'private-crash-request',
          signal: AbortSignal.timeout(3000)
        })
      })
      const receipt = await port.execute(f.command, new AbortController().signal)
      expect(receipt.state).toBe('unknown')
      expect(await port.execute(f.command, new AbortController().signal)).toEqual(receipt)
      expect(deliveries).toBe(1)
      expect(accepted).toBe(1)
      expect(() => f.ledger.commit({ projectId: 'isolated', commandId: 'cut-command' })).toThrow(
        'FLOW_SAVED_RUN_MISMATCH'
      )
      expect(() => f.ledger.prepare({ ...f.command, commandId: 'new-command' })).toThrow(
        'FLOW_NODE_OCCUPIED'
      )
      expect(f.assets.list('isolated', 'shape:target', 'out-value')).toHaveLength(0)
      expect(readFileSync(join(directory, 'effect-count'), 'utf8')).toBe('1')
      writeFileSync(
        join(directory, 'verified-summary.json'),
        JSON.stringify({ accepted, deliveries, state: receipt.state })
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      f.db.close()
    }
  })
})
