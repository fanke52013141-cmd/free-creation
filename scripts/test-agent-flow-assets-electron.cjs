/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, basename } = require('node:path')
async function clean(directory) {
  if (resolve(directory, '..') !== resolve(tmpdir()) || !basename(directory).startsWith('canvas-flow-assets-')) throw new Error('cleanup target rejected')
  await rm(directory, { recursive: true, force: true })
}
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-flow-assets-'))
  const reports = []
  const events = []
  const evidence = resolve('qa/canvas-agent-flow/C2')
  await mkdir(evidence, { recursive: true })
  try {
    for (const phase of ['submit', 'reopen']) {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const code = await new Promise((done, reject) => {
        const child = spawn(require('electron'), [resolve('out/main/agent-flow-assets.js'), `--assets-directory=${directory}`, `--assets-phase=${phase}`], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
        let stderr = ''
        child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-2000) })
        const timer = setTimeout(() => { child.kill(); reject(new Error('asset Electron acceptance timed out')) }, 45000)
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('exit', (exitCode) => { clearTimeout(timer); if (exitCode !== 0) process.stderr.write(`Isolated asset fixture exit ${exitCode}: ${stderr}\n`); done(exitCode) })
      })
      const report = JSON.parse(await readFile(join(directory, `${phase}-report.json`), 'utf8'))
      reports.push(report)
      if (code !== 0 || report.status !== 'pass') throw new Error(`asset ${phase} acceptance failed`)
    }
    async function scan(path) {
      for (const file of await readdir(path, { withFileTypes: true })) {
        const target = join(path, file.name)
        if (file.isDirectory()) await scan(target)
        else {
          const text = await readFile(target, 'utf8')
          if (text.includes('private-fixture-body') || text.includes('fake-secret-key')) throw new Error('asset diagnostic redaction failed')
          if (file.name.endsWith('.jsonl')) for (const line of text.trim().split('\n')) { if (line.trim()) events.push(JSON.parse(line)) }
        }
      }
    }
    await scan(join(directory, 'diagnostics'))
    const started = events.filter((event) => event.event === 'asset.operation.started')
    const terminals = events.filter((event) => ['asset.operation.completed', 'asset.operation.failed'].includes(event.event))
    if (started.length !== 9 || terminals.length !== 9) throw new Error('asset diagnostic lifecycle coverage failed')
    for (const begin of started) {
      if (!terminals.some((terminal) => terminal.traceId === begin.traceId && terminal.spanId === begin.spanId)) throw new Error('asset diagnostic correlation failed')
    }
    const commit = terminals.find((event) => event.event === 'asset.operation.completed' && event.attributes?.phase === 'submit')
    if (!commit?.attributes.assetId || !commit.attributes.versionId || !commit.attributes.submissionId || !commit.nodeId) throw new Error('asset diagnostic output refs missing')
    await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
    await writeFile(join(evidence, 'electron-assets-results.json'), JSON.stringify({ reports, diagnosticRedaction: true, boundary: 'production preload + IPC + project save + SQLite; hidden isolated windows; no Agent execution bridge or paid model' }, null, 2))
    process.stdout.write('Asset Electron IPC: submit/reopen, replay, conflicts, sender guard and diagnostic redaction passed.\n')
  } finally {
    await clean(directory)
  }
})().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
