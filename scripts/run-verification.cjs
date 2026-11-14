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
    // 完整 verify 内含 agent-flow 桌面验收，其前置是自用版构建（CANVAS_OWNER=1，
    // 见 scripts/acceptance/* 与 edition.ts）：跳过授权门禁、保留全部节点。这里在
    // verify 入口统一注入，使 `npm run verify` 无需手工设环境变量即可端到端跑绿；
    // 该开关是构建期 define，仅影响 electron-vite build 产物，对其余检查无副作用。
    env: { ...process.env, CANVAS_QA_OUTPUT_ROOT: evidence, CANVAS_OWNER: '1' },
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
