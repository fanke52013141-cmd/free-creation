/* eslint-disable @typescript-eslint/no-require-imports */
// ② capability 图节点桌面验收：真实渲染器执行 capability 图节点（复用 node.execute 账本端口）。
// 确定性夹具模型，无真实供应商、无费用。运行：node scripts/test-agent-flow-capability-graph.cjs
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdtemp, readFile, writeFile, mkdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname } = require('node:path')
const { qaOutputPath } = require('./qa-output.cjs')

function reserveLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const probe = require('node:net').createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close((error) => (error ? reject(error) : resolvePort(port)))
    })
  })
}
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-flow-agent-'))
  const evidence = qaOutputPath('qa/agent-capability-graph/desktop')
  await mkdir(evidence, { recursive: true })
  let requests = 0
  const provider = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      if (++requests > 40) throw new Error('FIXTURE_BUDGET')
      const json = JSON.parse(body)
      const names = (json.tools ?? []).map((tool) => tool.function.name)
      const userContent = json.messages.filter((message) => message.role === 'user').at(-1).content
      const input = JSON.parse(userContent)
      let name, args
      if (names.includes('dispatch_agent')) {
        // 图模式协调器不应调用主控决策模型；若调用则直接完成（验收会断言 modelCalls）。
        name = 'finish_flow'
        args = { outputs: input.completed?.at(-1)?.outputs ?? [] }
      } else if (input.receipts.length < 2) {
        name = 'execute_node'
        args = { targetNodeId: input.targets[0].nodeId }
      } else {
        name = 'finish_task'
        args = { outputs: input.receipts.at(-1).outputRefs }
      }
      const chunks = [
        { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
        { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ]
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
    } catch {
      response.writeHead(400)
      response.end('{}')
    }
  })
  const rendererPort = await reserveLoopbackPort()
  const rendererUrl = `http://127.0.0.1:${rendererPort}`
  const server = spawn(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--config', 'vite.browser.config.ts', '--host', '127.0.0.1', '--port', String(rendererPort), '--strictPort'], { stdio: 'ignore', windowsHide: true })
  try {
    await new Promise((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done) })
    const deadline = Date.now() + 30000
    while (true) {
      if (server.exitCode !== null) throw new Error('CAP_VITE_UNAVAILABLE')
      try {
        const [indexResponse, editorModuleResponse] = await Promise.all([fetch(rendererUrl), fetch(`${rendererUrl}/src/stores/editor.ts`)])
        const moduleType = editorModuleResponse.headers.get('content-type') ?? ''
        if (indexResponse.ok && editorModuleResponse.ok && !moduleType.includes('text/html')) break
      } catch { /* readiness */ }
      if (Date.now() > deadline) throw new Error('CAP_VITE_TIMEOUT')
      await new Promise((done) => setTimeout(done, 250))
    }
    const env = { ...process.env, CANVAS_AGENT_RENDERER_URL: rendererUrl, CANVAS_AGENT_FIXTURE_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1` }
    delete env.ELECTRON_RUN_AS_NODE
    const exit = await new Promise((done, reject) => {
      const child = spawn(require('electron'), [resolve('out/main/agent-flow-desktop.js'), `--agent-directory=${directory}`, '--agent-phase=execute', '--capability-graph'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const timer = setTimeout(() => { child.kill(); reject(new Error('CAP_ELECTRON_TIMEOUT')) }, 240000)
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('exit', (code, signal) => { clearTimeout(timer); if (stderr) require('node:fs').writeFileSync(join(directory, 'harness-stderr.log'), stderr); done({ code, signal }) })
    })
    const report = JSON.parse(await readFile(join(directory, 'execute-report.json'), 'utf8'))
    await writeFile(join(evidence, 'execute-report.json'), JSON.stringify(report, null, 2))
    if (exit.code !== 0 || report.status !== 'pass') throw new Error(`CAP_ACCEPTANCE_FAILED: code=${exit.code} report=${JSON.stringify(report).slice(0, 300)}`)
    console.log(`Capability graph desktop passed: ${evidence}`)
  } finally {
    server.kill()
    provider.close()
  }
})().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })