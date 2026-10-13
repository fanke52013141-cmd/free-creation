/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, basename, dirname } = require('node:path')
const real = process.argv.includes('--real-model')
async function cleanDirectory(directory) {
  if (resolve(directory, '..') !== resolve(tmpdir()) || !basename(directory).startsWith('canvas-flow-agent-')) throw new Error('AGENT_CLEANUP_REJECTED')
  await rm(directory, { recursive: true, force: true })
}
if (process.argv.slice(2).some(arg => arg !== '--real-model')) throw new Error('AGENT_TEST_ARGUMENT_INVALID')
if (real && (!process.env.CANVAS_AGENT_PROBE_KEY || !process.env.CANVAS_AGENT_PROBE_MODEL)) throw new Error('AGENT_REAL_CREDENTIAL_REQUIRED')
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-flow-agent-'))
  const evidence = resolve(`qa/canvas-agent-flow/C3/desktop-${real ? 'real' : 'fixture'}`)
  await mkdir(evidence, { recursive: true })
  let requests = 0
  const provider = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      if (++requests > 40 || body.length > 300000) throw new Error('FIXTURE_BUDGET')
      const json = JSON.parse(body)
      let name, args
      const names = json.tools.map(tool => tool.function.name)
      if (names.includes('probe_echo') || names.includes('probe_done')) {
        name = names[0]; args = name === 'probe_done'
          ? JSON.parse(json.messages.find(message => message.role === 'tool').content)
          : { marker: 'probe-ok', count: 7 }
      } else {
        const input = JSON.parse(json.messages.filter(message => message.role === 'user').at(-1).content)
        if (!input.directInputs?.length || !input.fixedInputs?.length) throw new Error('FIXTURE_DECLARED_INPUT_MISSING')
        if (input.goal === 'cancel-fixture') await new Promise(done => setTimeout(done, 10000))
        if (!Object.keys(input.loaded).length) { name = 'load_skill'; args = { skillId: 'result-check' } }
        else if (input.receipts.length < 2) { name = 'execute_node'; args = { targetNodeId: input.targets[0].nodeId } }
        else if (input.mode === 'collaborative' && !input.humanAccepted) { name = 'wait_for_human'; args = {} }
        else { name = 'finish_task'; args = { outputs: input.receipts.at(-1).outputRefs } }
      }
      const chunks = [{ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function',
          function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
        { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
    } catch { response.writeHead(400); response.end('{}') }
  })
  const server = spawn(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--config', 'vite.browser.config.ts', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { stdio: 'ignore', windowsHide: true })
  const reports = [], events = []
  try {
    if (!real) await new Promise((done, reject) => { provider.once('error', reject); provider.listen(5200, '127.0.0.1', done) })
    const deadline = Date.now() + 30000
    while (true) {
      if (server.exitCode !== null) throw new Error('AGENT_VITE_UNAVAILABLE')
      try { if ((await fetch('http://127.0.0.1:5199')).ok) break } catch { /* Bounded readiness. */ }
      if (Date.now() > deadline) throw new Error('AGENT_VITE_TIMEOUT')
      await new Promise(done => setTimeout(done, 250))
    }
    for (const phase of ['execute', 'reopen']) {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const code = await new Promise((done, reject) => {
        const child = spawn(require('electron'), [resolve('out/main/agent-flow-desktop.js'), `--agent-directory=${directory}`, `--agent-phase=${phase}`, ...(real ? ['--real-model'] : [])],
          { env, stdio: 'ignore', windowsHide: true })
        const timer = setTimeout(() => { child.kill(); reject(new Error('AGENT_ELECTRON_TIMEOUT')) }, 240000)
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('exit', code => { clearTimeout(timer); done(code) })
      })
      const report = JSON.parse(await readFile(join(directory, `${phase}-report.json`), 'utf8'))
      await writeFile(join(evidence, `${phase}-report.json`), JSON.stringify(report, null, 2))
      reports.push(report)
      if (code !== 0 || report.status !== 'pass') throw new Error(`AGENT_${phase.toUpperCase()}_${report.report?.code || 'FAILED'}`)
    }
    async function scan(path) {
      for (const file of await readdir(path, { withFileTypes: true })) {
        const target = join(path, file.name)
        if (file.isDirectory()) await scan(target)
        else {
          const text = await readFile(target, 'utf8')
          if (text.includes('private-c3') || (process.env.CANVAS_AGENT_PROBE_KEY && text.includes(process.env.CANVAS_AGENT_PROBE_KEY))) throw new Error('AGENT_DIAGNOSTICS_REDACTION_FAILED')
          if (file.name.endsWith('.jsonl')) for (const line of text.trim().split('\n')) if (line.trim()) events.push(JSON.parse(line))
        }
      }
    }
    await scan(join(directory, 'diagnostics'))
    const started = events.filter(event => event.event === 'agent.desktop.started')
    const ended = events.filter(event => ['agent.desktop.completed', 'agent.desktop.failed'].includes(event.event))
    if (!started.length || started.length !== ended.length) throw new Error('AGENT_DESKTOP_LIFECYCLE_FAILED')
    for (const event of started) if (ended.filter(end => end.traceId === event.traceId && end.spanId === event.spanId).length !== 1) throw new Error('AGENT_DESKTOP_TERMINAL_DUPLICATED')
    if (!events.some(event => event.event === 'agent.runtime.resumed' && event.attributes?.resumesTraceId)) throw new Error('AGENT_RESUME_TRACE_MISSING')
    await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
    const modelRequests = events.filter(event => event.event === 'model.request.started').length
    await writeFile(join(evidence, 'results.json'), JSON.stringify({ reports, modelRequests, diagnosticRedaction: true,
      boundary: 'real desktop canvas/executor/IPC/model catalog/SDK/two process checkpoint/fixed assets', model: real ? process.env.CANVAS_AGENT_PROBE_MODEL : 'synthetic fixture' }, null, 2))
    process.stdout.write(`Agent desktop ${real ? 'real model' : 'fixture'}: start, two tools, human wait/reopen/continue, declared fixed assets and diagnostics passed.\n`)
  } finally {
    server.kill(); provider.closeAllConnections(); provider.close()
    await cleanDirectory(directory)
  }
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
