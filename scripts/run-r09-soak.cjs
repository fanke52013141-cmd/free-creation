/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Development acceptance only. No application entry point imports this runner.
const fs = require('node:fs')
const { join, resolve, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { performance } = require('node:perf_hooks')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const { createRequire } = require('node:module')
const { qaOutputPath } = require('./qa-output.cjs')

const phases = ['write-tmp', 'flush-tmp', 'promote-tmp', 'update-db']
function check(condition, code) {
  if (!condition) throw new Error(code)
}
function safeFailureCode(error) {
  if (/^R09_[A-Z_]+$/.test(error?.message)) return error.message
  const ioCode = String(error?.code ?? '')
  if (
    [
      'EACCES',
      'EPERM',
      'EBUSY',
      'EIO',
      'ENOSPC',
      'EMFILE',
      'ENFILE',
      'EAGAIN',
      'ENOENT',
      'EEXIST',
      'ENOTEMPTY',
      'SQLITE_BUSY',
      'SQLITE_FULL',
      'SQLITE_IOERR'
    ].includes(ioCode)
  )
    return `R09_${ioCode}`
  const errorName = String(error?.name ?? '')
  if (['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(errorName))
    return `R09_INTERNAL_${errorName.replace('Error', '').toUpperCase()}_ERROR`
  return 'R09_RUN_FAILED'
}
function withTransientFsRetry(
  operation,
  pause = (milliseconds) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
) {
  let retries = 0
  while (true) {
    try {
      return operation()
    } catch (error) {
      if (!['EACCES', 'EPERM', 'EBUSY'].includes(String(error?.code ?? '')) || retries >= 6)
        throw error
      pause(Math.min(25 * 2 ** retries++, 250))
    }
  }
}
function parseOptions(args) {
  const options = { durationSeconds: 5400, maxEpochs: 10000, intervalMs: 1000, retainBatches: 16 }
  const names = {
    'duration-seconds': ['durationSeconds', 1, 86400],
    'max-epochs': ['maxEpochs', 1, 10000],
    'interval-ms': ['intervalMs', 0, 60000],
    'retain-batches': ['retainBatches', 1, 128]
  }
  const seen = new Set()
  for (const arg of args) {
    const match = /^--([a-z-]+)=(\d+)$/.exec(arg)
    check(match && names[match[1]] && !seen.has(match[1]), 'R09_OPTIONS_INVALID')
    const [key, min, max] = names[match[1]]
    const value = Number(match[2])
    check(Number.isSafeInteger(value) && value >= min && value <= max, 'R09_OPTIONS_INVALID')
    options[key] = value
    seen.add(match[1])
  }
  return options
}
function validateEpoch(state, epoch) {
  check(
    state.status === 'unknown' && state.phase === 'prepared' && state.stopped === true,
    'R09_TASK_AUTHORITY_CHANGED'
  )
  check(
    state.tasks === 1 &&
      state.downloads === 1 &&
      state.mutations === 0 &&
      state.unexpected === 0 &&
      state.locks === 0 &&
      state.media.length === 0,
    'R09_IDENTITY_OR_LOCK_CHANGED'
  )
  check(
    state.soakCycles === (epoch + 1) * 8 && state.version === 1 && state.dbVersion === 1,
    'R09_SNAPSHOT_CHANGED'
  )
  check(
    JSON.stringify(state.snapshot) === JSON.stringify({ taskId: 'task', phase: 'pending' }),
    'R09_SNAPSHOT_CHANGED'
  )
  check(
    JSON.stringify(state.storageFailurePhases) === JSON.stringify([...phases, ...phases]),
    'R09_FAILURE_COVERAGE_MISSING'
  )
  check(
    state.redacted === true &&
      state.unpairedControls === 0 &&
      state.unpairedMedia === 0 &&
      state.unpairedDownloads === 0 &&
      state.duplicateControlEnds === 0,
    'R09_DIAGNOSTICS_INVALID'
  )
  check(
    epoch % 6 === 2 ? state.diagnosticDrops > 0 : state.diagnosticDrops === 0,
    'R09_LOGGER_FAILURE_NOT_EXERCISED'
  )
}

async function runSoak(options, { signal, onCheckpoint } = {}) {
  // Validate programmatic callers too; evidence and temporary data must not be
  // created until every bound has been checked.
  const config = parseOptions([
    `--duration-seconds=${options.durationSeconds}`,
    `--max-epochs=${options.maxEpochs}`,
    `--interval-ms=${options.intervalMs}`,
    `--retain-batches=${options.retainBatches}`
  ])
  const parent = qaOutputPath('qa/r09-soak')
  fs.mkdirSync(parent, { recursive: true })
  const evidence = fs.mkdtempSync(join(parent, 'run-'))
  const directory = fs.mkdtempSync(join(tmpdir(), 'canvas-combined-'))
  const started = performance.now()
  const report = {
    schemaVersion: 1,
    runnerPid: process.pid,
    status: 'running',
    startedAt: new Date().toISOString(),
    config,
    epochs: 0,
    cycles: 0,
    diagnosticDrops: 0,
    archivedBatches: 0,
    prunedBatches: 0,
    retainedBytes: 0,
    durationTargetMet: false,
    cleanupCompleted: false,
    diagnosticRedaction: false,
    scope:
      'isolated repository/gateway fixture, fresh processes; no physical power loss or supplier requests'
  }
  let active = null
  let activeOperation = 'setup'
  let sequence = 0
  const retained = []
  const fsOperation = (stage, operation) => {
    activeOperation = stage
    return withTransientFsRetry(operation)
  }
  const saveReport = () => {
    report.elapsedSeconds = (performance.now() - started) / 1000
    fsOperation('report-write', () =>
      fs.writeFileSync(join(evidence, 'report.json.tmp'), JSON.stringify(report, null, 2))
    )
    fsOperation('report-promote', () =>
      fs.renameSync(join(evidence, 'report.json.tmp'), join(evidence, 'report.json'))
    )
  }
  const archive = () => {
    const files = fsOperation('archive-list', () => fs.readdirSync(directory)).filter((name) =>
      /^diagnostics-\d+\.jsonl$/.test(name)
    )
    check(
      files.reduce(
        (total, name) =>
          total + fsOperation('archive-stat', () => fs.statSync(join(directory, name))).size,
        0
      ) <=
        2 * 1024 * 1024,
      'R09_BATCH_EVIDENCE_TOO_LARGE'
    )
    const records = files.map((name) => ({
      name,
      text: fsOperation('archive-read', () => fs.readFileSync(join(directory, name), 'utf8'))
    }))
    if (!records.length) return
    let bytes = 0
    for (const { text } of records) {
      bytes += Buffer.byteLength(text)
      check(
        !['combined-private-', 'private-signature', 'private-corrupt', directory].some((sentinel) =>
          text.includes(sentinel)
        ),
        'R09_DIAGNOSTICS_REDACTION_FAILED'
      )
      for (const line of text.trim().split('\n').filter(Boolean)) JSON.parse(line)
    }
    check(bytes <= 2 * 1024 * 1024, 'R09_BATCH_EVIDENCE_TOO_LARGE')
    const bucket = join(evidence, `batch-${String(sequence++).padStart(6, '0')}`)
    fsOperation('archive-create', () => fs.mkdirSync(bucket))
    for (const { name, text } of records) {
      fsOperation('archive-write', () => fs.writeFileSync(join(bucket, name), text))
      fsOperation('archive-remove-source', () => fs.unlinkSync(join(directory, name)))
    }
    retained.push({ bucket, bytes })
    report.archivedBatches++
    report.retainedBytes += bytes
    while (retained.length > config.retainBatches) {
      const previous = retained.shift()
      // These exact child paths were created above, never accepted from CLI or logs.
      check(
        resolve(previous.bucket, '..') === resolve(evidence) &&
          /^batch-\d{6}$/.test(basename(previous.bucket)),
        'R09_EVIDENCE_CLEANUP_REJECTED'
      )
      fsOperation('archive-prune', () =>
        fs.rmSync(previous.bucket, {
          recursive: true,
          force: true,
          maxRetries: 6,
          retryDelay: 100
        })
      )
      report.retainedBytes -= previous.bytes
      report.prunedBatches++
    }
    report.diagnosticRedaction = true
  }
  const worker = join(directory, 'soak-worker.cjs')
  const run = (mode, cut = false) =>
    new Promise((done, reject) => {
      check(!signal?.aborted, 'R09_INTERRUPTED')
      report.activeStage = mode
      activeOperation = `launch-${mode}`
      saveReport()
      activeOperation = `worker-${mode}`
      const child = spawn(require('electron'), [worker, directory, mode], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      active = child
      let output = '',
        killedAtCut = false,
        failure = null
      const stop = () => {
        failure = 'R09_INTERRUPTED'
        child.kill('SIGKILL')
      }
      signal?.addEventListener('abort', stop, { once: true })
      const timer = setTimeout(() => {
        failure = 'R09_WORKER_TIMEOUT'
        child.kill('SIGKILL')
      }, 30000)
      child.stderr.resume() // Never copy raw process output into evidence.
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (output.length > 1024 * 1024) {
          failure = 'R09_WORKER_OUTPUT_LIMIT'
          child.kill('SIGKILL')
        }
        if (cut && !killedAtCut && output.includes('"cut":true')) {
          killedAtCut = true
          child.kill('SIGKILL')
        }
      })
      child.once('error', () => {
        failure = 'R09_WORKER_START_FAILED'
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', stop)
        active = null
        if (failure) return reject(new Error(failure))
        if (cut && killedAtCut) return done(null)
        if (cut || code !== 0) return reject(new Error('R09_WORKER_FAILED'))
        try {
          done(JSON.parse(output.trim().split('\n').at(-1)))
        } catch {
          reject(new Error('R09_WORKER_OUTPUT_INVALID'))
        }
      })
    })
  try {
    saveReport()
    activeOperation = 'build-worker'
    const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
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
    await run('init')
    const offline = await run('query-drop')
    check(offline.status === 'unknown' && offline.downloads === 0, 'R09_OFFLINE_SETUP_INVALID')
    await run('prepared', true)
    const prepared = await run('inspect')
    check(
      prepared.unpairedControls === 1 &&
        prepared.unpairedMedia === 1 &&
        prepared.unpairedDownloads === 0 &&
        prepared.redacted,
      'R09_INTERRUPTED_GAPS_INVALID'
    )
    report.interruptedGaps = { controls: 1, mediaPersist: 1 }
    archive()
    let state
    const loopStarted = performance.now()
    for (let epoch = 0; epoch < config.maxEpochs; epoch++) {
      const mode = `soak-long-${epoch}`
      state = await run(mode)
      activeOperation = `validate-${mode}`
      validateEpoch(state, epoch)
      report.epochs++
      report.cycles = state.soakCycles
      report.activeFaultSeconds = (performance.now() - loopStarted) / 1000
      report.diagnosticDrops += state.diagnosticDrops
      archive()
      fsOperation('checkpoint-append', () =>
        fs.appendFileSync(
          join(evidence, 'checkpoints.jsonl'),
          JSON.stringify({
            epoch: report.epochs,
            cycles: report.cycles,
            elapsedSeconds: (performance.now() - started) / 1000,
            downloads: state.downloads,
            tasks: state.tasks,
            locks: state.locks,
            diagnosticDrops: state.diagnosticDrops,
            retainedBytes: report.retainedBytes,
            workerRssBytes: state.workerRssBytes,
            parentRssBytes: process.memoryUsage().rss
          }) + '\n'
        )
      )
      saveReport()
      activeOperation = 'checkpoint-callback'
      await onCheckpoint?.(report)
      check(!signal?.aborted, 'R09_INTERRUPTED')
      if (report.activeFaultSeconds >= config.durationSeconds) {
        report.durationTargetMet = true
        break
      }
      if (epoch + 1 < config.maxEpochs) {
        activeOperation = 'pacing-delay'
        await delay(config.intervalMs, undefined, { signal })
      }
    }
    report.completionReason = report.durationTargetMet ? 'duration' : 'epoch-limit'
    const recovered = await run('resume')
    check(
      recovered.status === 'success' &&
        recovered.phase === 'committed' &&
        recovered.tasks === 1 &&
        recovered.downloads === 1 &&
        recovered.queries === state.queries &&
        recovered.mutations === 0 &&
        recovered.unexpected === 0 &&
        recovered.media.length === 1 &&
        recovered.media[0].valid &&
        recovered.redacted,
      'R09_FINAL_RECOVERY_INVALID'
    )
    const saved = await run('publish')
    check(
      saved.version === 2 &&
        saved.dbVersion === 2 &&
        saved.locks === 0 &&
        saved.snapshot.mediaId === recovered.media[0].id,
      'R09_FINAL_PUBLISH_INVALID'
    )
    for (let repeat = 0; repeat < 3; repeat++) {
      const reopened = await run('control')
      check(
        JSON.stringify(reopened.snapshot) === JSON.stringify(saved.snapshot) &&
          JSON.stringify(reopened.media) === JSON.stringify(saved.media) &&
          reopened.tasks === 1 &&
          reopened.downloads === 1 &&
          reopened.queries === saved.queries &&
          reopened.mutations === 0 &&
          reopened.unexpected === 0 &&
          reopened.locks === 0 &&
          reopened.redacted,
        'R09_FINAL_REOPEN_INVALID'
      )
    }
    archive()
    report.final = { tasks: 1, downloads: 1, media: 1, graphVersion: 2, reopenProcesses: 3 }
    report.status = 'passed'
  } catch (error) {
    report.status = signal?.aborted ? 'interrupted' : 'failed'
    report.failureCode = safeFailureCode(error)
    report.failureStage = /^[a-z0-9-]+$/.test(activeOperation) ? activeOperation : 'unknown'
    try {
      archive()
    } catch {
      report.diagnosticRedaction = false
    }
  } finally {
    // run() settles only after its child closes; never remove an active worker's DB.
    try {
      check(!active, 'R09_WORKER_STILL_ACTIVE')
      check(
        resolve(directory, '..') === resolve(tmpdir()) &&
          basename(directory).startsWith('canvas-combined-'),
        'R09_CLEANUP_REJECTED'
      )
      activeOperation = 'cleanup-temp'
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      report.cleanupCompleted = true
    } catch {
      report.status = 'failed'
      report.failureCode = active ? 'R09_WORKER_STILL_ACTIVE' : 'R09_CLEANUP_FAILED'
    }
    report.finishedAt = new Date().toISOString()
    saveReport()
  }
  return { evidence, report }
}
module.exports = { parseOptions, validateEpoch, runSoak, safeFailureCode, withTransientFsRetry }
if (require.main === module) {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  Promise.resolve()
    .then(() => runSoak(parseOptions(process.argv.slice(2)), { signal: controller.signal }))
    .then(({ evidence, report }) => {
      process.stdout.write(
        `R09 soak ${basename(evidence)}: ${report.status}, ${report.cycles} cycles; durationTargetMet=${report.durationTargetMet}.\n`
      )
      process.exitCode = report.status === 'passed' ? 0 : report.status === 'interrupted' ? 130 : 1
    })
    .catch(() => {
      process.stderr.write(
        'R09 soak could not start; check bounded CLI options and local QA storage.\n'
      )
      process.exitCode = 1
    })
    .finally(() => {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    })
}
