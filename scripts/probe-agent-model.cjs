/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readFileSync, cpSync, rmSync } = require('node:fs')
const { resolve, join, basename } = require('node:path')
const { tmpdir } = require('node:os')
const root = resolve(__dirname, '..')
const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--allow-cost' && !/^--target-id=[a-zA-Z0-9_.:-]+$/.test(arg))) {
  throw new Error('PROBE_ARGUMENT_INVALID')
}
const directory = mkdtempSync(join(tmpdir(), 'canvas-agent-probe-'))
try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [
    join(root, 'out/main/agent-flow-model-probe.js'), `--probe-dir=${directory}`, ...args
  ], { cwd: root, env, windowsHide: true, timeout: 75000, stdio: 'ignore' })
  const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'))
  // Copy only the safe report and diagnostic events, never DBs/credentials.
  const evidence = join(root, 'qa/canvas-agent-flow/model-probe', new Date().toISOString().replace(/[:.]/g, '-'))
  cpSync(join(directory, 'report.json'), join(evidence, 'report.json'), { recursive: true })
  const { existsSync } = require('node:fs')
  if (existsSync(join(directory, 'diagnostics'))) cpSync(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = result.status ?? 1
} catch {
  process.stdout.write(JSON.stringify({ status: 'probe-unavailable', code: 'PROBE_REPORT_UNAVAILABLE' }) + '\n')
  process.exitCode = 1
} finally {
  if (resolve(directory, '..') === resolve(tmpdir()) && basename(directory).startsWith('canvas-agent-probe-')) {
    rmSync(directory, { recursive: true, force: true })
  } else process.exitCode = 2
}
