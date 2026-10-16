/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process')
const { mkdirSync, mkdtempSync, writeFileSync, createWriteStream } = require('node:fs')
const { resolve, join } = require('node:path')

const parent = resolve('qa/verification')
mkdirSync(parent, { recursive: true })
const evidence = mkdtempSync(join(parent, 'run-'))
const startedAt = new Date().toISOString()
const report = join(evidence, 'status.json')
writeFileSync(report, JSON.stringify({ status: 'running', startedAt }, null, 2))
process.stdout.write(`Verification evidence: ${evidence}\n`)
const log = createWriteStream(join(evidence, 'verify.log'))
const child = spawn(
  process.execPath,
  [process.env.npm_execpath || require.resolve('npm/bin/npm-cli.js'), 'run', 'verify:checks'],
  {
    env: { ...process.env, CANVAS_QA_OUTPUT_ROOT: evidence },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }
)
child.stdout.on('data', (data) => {
  process.stdout.write(data)
  log.write(data)
})
child.stderr.on('data', (data) => {
  process.stderr.write(data)
  log.write(data)
})
child.on('error', () => {
  process.stderr.write('Verification process could not start.\n')
})
child.on('close', (code, signal) => {
  const exitCode = code ?? 1
  log.end()
  writeFileSync(
    report,
    JSON.stringify(
      {
        status: exitCode === 0 ? 'passed' : 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        signal
      },
      null,
      2
    )
  )
  process.exitCode = exitCode
})
