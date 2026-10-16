import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseOptions,
  validateEpoch,
  runSoak,
  safeFailureCode,
  withTransientFsRetry
} = require('../scripts/run-r09-soak.cjs')
let root: string
let previousRoot: string | undefined
beforeEach(() => {
  previousRoot = process.env.CANVAS_QA_OUTPUT_ROOT
  root = mkdtempSync(join(tmpdir(), 'canvas-soak-test-'))
  process.env.CANVAS_QA_OUTPUT_ROOT = root
})
afterEach(() => {
  if (previousRoot === undefined) delete process.env.CANVAS_QA_OUTPUT_ROOT
  else process.env.CANVAS_QA_OUTPUT_ROOT = previousRoot
  if (resolve(root, '..') !== resolve(tmpdir()) || !basename(root).startsWith('canvas-soak-test-'))
    throw new Error('SOAK_TEST_CLEANUP_REJECTED')
  rmSync(root, { recursive: true, force: true })
})

describe('R09 duration soak runner and truthful checkpoints', () => {
  it('reduces unexpected failures to safe diagnostic codes', () => {
    expect(safeFailureCode(new Error('private path /token/secret'))).toBe('R09_RUN_FAILED')
    expect(safeFailureCode(Object.assign(new Error('private path'), { code: 'EPERM' }))).toBe(
      'R09_EPERM'
    )
    expect(safeFailureCode(new TypeError('private value'))).toBe('R09_INTERNAL_TYPE_ERROR')
  })

  it('retries transient Windows file locks and leaves persistent errors visible', () => {
    let attempts = 0
    const pauses: number[] = []
    expect(
      withTransientFsRetry(() => {
        attempts++
        if (attempts < 3) throw Object.assign(new Error('private path'), { code: 'EPERM' })
        return 'written'
      }, (milliseconds) => pauses.push(milliseconds))
    ).toBe('written')
    expect(attempts).toBe(3)
    expect(pauses).toEqual([25, 50])

    attempts = 0
    expect(() =>
      withTransientFsRetry(() => {
        attempts++
        throw Object.assign(new Error('private full disk'), { code: 'ENOSPC' })
      }, () => pauses.push(0))
    ).toThrow('private full disk')
    expect(attempts).toBe(1)
  })

  it('bounds duration, iteration, pacing and retention before creating evidence', () => {
    expect(parseOptions([])).toEqual({
      durationSeconds: 5400,
      maxEpochs: 10000,
      intervalMs: 1000,
      retainBatches: 16
    })
    for (const args of [
      ['--duration-seconds=0'],
      ['--duration-seconds=86401'],
      ['--max-epochs=10001'],
      ['--interval-ms=60001'],
      ['--retain-batches=0'],
      ['--output=../user-data'],
      ['--duration-seconds=1', '--duration-seconds=2'],
      ['--duration-seconds=1.5']
    ])
      expect(() => parseOptions(args)).toThrow('R09_OPTIONS_INVALID')
    expect(readdirSync(root)).toEqual([])
  })

  it('rejects a changed task, version or falsely complete diagnostics', () => {
    const epoch = {
      status: 'unknown',
      phase: 'prepared',
      stopped: true,
      tasks: 1,
      downloads: 1,
      mutations: 0,
      unexpected: 0,
      locks: 0,
      media: [],
      soakCycles: 8,
      version: 1,
      dbVersion: 1,
      snapshot: { taskId: 'task', phase: 'pending' },
      storageFailurePhases: [
        'write-tmp',
        'flush-tmp',
        'promote-tmp',
        'update-db',
        'write-tmp',
        'flush-tmp',
        'promote-tmp',
        'update-db'
      ],
      redacted: true,
      unpairedControls: 0,
      unpairedMedia: 0,
      unpairedDownloads: 0,
      duplicateControlEnds: 0,
      diagnosticDrops: 0
    }
    expect(() => validateEpoch(epoch, 0)).not.toThrow()
    for (const changed of [
      { tasks: 2 },
      { downloads: 2 },
      { mutations: 1 },
      { locks: 1 },
      { version: 2 },
      { dbVersion: 2 },
      { redacted: false },
      { unpairedControls: 1 },
      { snapshot: { taskId: 'task', phase: 'success' } },
      { storageFailurePhases: [] }
    ])
      expect(() => validateEpoch({ ...epoch, ...changed }, 0)).toThrow(/^R09_/)
  })

  it('retains bounded diagnostics and reports an epoch cap without claiming the duration passed', async () => {
    const { evidence, report } = await runSoak(
      parseOptions([
        '--duration-seconds=60',
        '--max-epochs=3',
        '--interval-ms=0',
        '--retain-batches=1'
      ])
    )
    expect(report).toMatchObject({
      status: 'passed',
      epochs: 3,
      cycles: 24,
      durationTargetMet: false,
      completionReason: 'epoch-limit',
      cleanupCompleted: true,
      diagnosticRedaction: true,
      interruptedGaps: { controls: 1, mediaPersist: 1 },
      final: { tasks: 1, downloads: 1, media: 1, graphVersion: 2, reopenProcesses: 3 }
    })
    expect(report.diagnosticDrops).toBeGreaterThan(0)
    expect(report.prunedBatches).toBeGreaterThan(0)
    expect(report.retainedBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(readdirSync(evidence).filter((name) => name.startsWith('batch-'))).toHaveLength(1)
    const checkpoints = readFileSync(join(evidence, 'checkpoints.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(checkpoints.map((c) => c.cycles)).toEqual([8, 16, 24])
    expect(checkpoints.every((c) => c.tasks === 1 && c.downloads === 1 && c.locks === 0)).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(
      /combined-private|private-signature|canvas-combined-/
    )
    expect(JSON.parse(readFileSync(join(evidence, 'report.json'), 'utf8'))).toEqual(report)
  }, 60000)

  it('measures actual elapsed duration and performs final offline publication', async () => {
    const { report } = await runSoak(
      parseOptions(['--duration-seconds=1', '--max-epochs=100', '--interval-ms=0'])
    )
    expect(report).toMatchObject({
      status: 'passed',
      durationTargetMet: true,
      completionReason: 'duration',
      cleanupCompleted: true
    })
    expect(report.elapsedSeconds).toBeGreaterThanOrEqual(1)
    expect(report.activeFaultSeconds).toBeGreaterThanOrEqual(1)
  }, 60000)

  it.each(['interrupt', 'active-interrupt', 'failure'])(
    'preserves completed checkpoints and cleans isolated data on %s',
    async (mode) => {
      const controller = new AbortController()
      const { evidence, report } = await runSoak(
        parseOptions(['--duration-seconds=60', '--max-epochs=3', '--interval-ms=0']),
        {
          signal: controller.signal,
          onCheckpoint: () => {
            if (mode === 'active-interrupt') setTimeout(() => controller.abort(), 25)
            else if (mode === 'interrupt') controller.abort()
            else throw new Error('private-failure /private/path')
          }
        }
      )
      expect(report).toMatchObject({
        status: mode !== 'failure' ? 'interrupted' : 'failed',
        cycles: 8,
        epochs: 1,
        cleanupCompleted: true,
        durationTargetMet: false,
        failureCode: mode !== 'failure' ? 'R09_INTERRUPTED' : 'R09_RUN_FAILED'
      })
      if (mode === 'failure') expect(report.failureStage).toBe('checkpoint-callback')
      expect(report.final).toBeUndefined()
      if (mode === 'active-interrupt') expect(report.activeStage).toBe('soak-long-1')
      expect(
        readFileSync(join(evidence, 'checkpoints.jsonl'), 'utf8').trim().split('\n')
      ).toHaveLength(1)
      expect(readFileSync(join(evidence, 'report.json'), 'utf8')).not.toMatch(
        /private-failure|private\/path/
      )
    },
    60000
  )
})
