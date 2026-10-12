/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, basename, dirname } = require('node:path')
async function clean(directory) {
  if (resolve(directory, '..') !== resolve(tmpdir()) || !basename(directory).startsWith('canvas-flow-commands-')) throw new Error('cleanup target rejected')
  await rm(directory, { recursive: true, force: true })
}
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-flow-commands-'))
  const url = 'http://127.0.0.1:5198'
  const evidence = resolve('qa/canvas-agent-flow/C2/commands')
  await mkdir(evidence, { recursive: true })
  const server = spawn(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--config', 'vite.browser.config.ts', '--host', '127.0.0.1', '--port', '5198', '--strictPort'], { stdio: 'ignore', windowsHide: true })
  const reports = [], events = []
  try {
    const deadline = Date.now() + 30000
    while (true) {
      if (server.exitCode !== null) throw new Error('bridge Vite fixture unavailable')
      try { if ((await fetch(url)).ok) break } catch { /* bounded readiness */ }
      if (Date.now() > deadline) throw new Error('bridge Vite fixture timed out')
      await new Promise(done => setTimeout(done, 250))
    }
    for (const phase of ['execute', 'reopen']) {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const exitCode = await new Promise((done, reject) => {
        const child = spawn(require('electron'), [resolve('out/main/agent-flow-commands.js'), `--commands-directory=${directory}`, `--commands-phase=${phase}`, `--commands-url=${url}`], { env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
        const timer = setTimeout(() => { child.kill(); reject(new Error('bridge Electron timed out')) }, 150000)
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('exit', code => { clearTimeout(timer); done(code) })
      })
      const report = JSON.parse(await readFile(join(directory, `${phase}-report.json`), 'utf8'))
      await writeFile(join(evidence, `${phase}-report.json`), JSON.stringify(report, null, 2))
      reports.push(report)
      if (exitCode !== 0 || report.status !== 'pass') throw new Error(`bridge ${phase} acceptance failed (${report.report?.code || 'process'})`)
    }
    async function scan(path) {
      for (const file of await readdir(path, { withFileTypes: true })) {
        const target = join(path, file.name)
        if (file.isDirectory()) await scan(target)
        else {
          const text = await readFile(target, 'utf8')
          if (text.includes('private-fixture') || text.includes('fake-secret-key')) throw new Error('bridge diagnostic redaction failed')
          if (file.name.endsWith('.jsonl')) for (const line of text.trim().split('\n')) if (line.trim()) events.push(JSON.parse(line))
        }
      }
    }
    await scan(join(directory, 'diagnostics'))
    const starts = events.filter(event => event.event === 'command.operation.started')
    const terminals = events.filter(event => ['command.operation.completed', 'command.operation.failed'].includes(event.event))
    if (!starts.length || starts.length !== terminals.length) throw new Error('bridge diagnostic lifecycle count failed')
    for (const start of starts) {
      if (terminals.filter(event => event.traceId === start.traceId && event.spanId === start.spanId).length !== 1) throw new Error('bridge diagnostic terminal uniqueness failed')
    }
    for (const id of ['bridge-first', 'bridge-saved-unknown']) {
      if (events.filter(event => event.event === 'node.started' && event.traceId === `trace-${id}`).length !== 1) throw new Error('bridge business execution effect count failed')
    }
    if (!events.some(event => event.event === 'command.recovered' && event.attributes?.state === 'unknown')) throw new Error('bridge startup recovery log absent')
    if (!terminals.some(event => event.attributes?.phase === 'saved-receipt' && event.attributes?.versionId)) throw new Error('bridge output receipt log absent')
    await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
    await writeFile(join(evidence, 'results.json'), JSON.stringify({ reports, operations: starts.length, diagnosticRedaction: true,
      boundary: 'real desktop preload/IPC/canvas/shared executor/save/SQLite; two processes; deterministic processor only; no model calls' }, null, 2))
    process.stdout.write('Command Electron: manual/Agent parity, durable receipts, replay, unknown reconciliation and diagnostic redaction passed.\n')
  } finally {
    server.kill()
    await clean(directory)
  }
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
