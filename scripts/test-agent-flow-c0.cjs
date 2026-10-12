/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, readFile, writeFile, cp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const electron = require('electron')

async function clean(directory) {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('canvas-agent-c0-')) throw new Error('Unsafe cleanup path')
  await rm(directory, { recursive: true, force: true })
}

async function run() {
  const root = resolve(__dirname, '..')
  const directory = await mkdtemp(join(tmpdir(), 'canvas-agent-c0-'))
  const reports = []
  try {
    for (const phase of ['pause', 'resume']) {
      const env = { ...process.env, LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' }
      delete env.ELECTRON_RUN_AS_NODE
      const code = await new Promise((resolveExit, reject) => {
        const child = spawn(electron, [join(root, 'out/main/agent-flow-c0.js'), `--c0-directory=${directory}`, `--c0-phase=${phase}`], { env, windowsHide: true, stdio: 'ignore' })
        const timer = setTimeout(() => { child.kill(); reject(new Error('C0 process timeout')) }, 30_000)
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('exit', (exitCode) => { clearTimeout(timer); resolveExit(exitCode) })
      })
      const report = JSON.parse(await readFile(join(directory, `${phase}-report.json`), 'utf8'))
      reports.push(report)
      if (code !== 0 || report.status !== 'pass') throw new Error(`C0 ${phase} failed: ${report.code ?? 'process'}`)
    }
  } finally {
    const evidence = join(root, 'qa/canvas-agent-flow/C0')
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'electron-results.json'), JSON.stringify({ reports, boundary: 'isolated renderer fixture and deterministic model; no product node or real model acceptance' }, null, 2))
    await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true }).catch(() => undefined)
    // Delete only this mkdtemp directory, after checking its resolved parent and prefix.
    await clean(directory)
  }
  process.stdout.write('C0 Electron: separate pause/resume processes passed; tool effect count = 1.\n')
}
run().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
