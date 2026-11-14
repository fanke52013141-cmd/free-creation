/* eslint-disable @typescript-eslint/no-require-imports */
// ⑤ 真实模型图流程样片：真实模型（智谱 GLM）跑 capability 图流程。
// key 经环境变量 CANVAS_AGENT_PROBE_KEY 传入（不写入代码/不提交）。
// 运行：$env:CANVAS_AGENT_PROBE_KEY='<key>'; node scripts/test-agent-flow-real-graph.cjs
const { spawn } = require('node:child_process')
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
  const key = process.env.CANVAS_AGENT_PROBE_KEY
  if (!key) throw new Error('CANVAS_AGENT_PROBE_KEY required')
  const baseUrl = process.env.CANVAS_AGENT_PROBE_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4'
  const model = process.env.CANVAS_AGENT_PROBE_MODEL || 'glm-5.3'
  const directory = await mkdtemp(join(tmpdir(), 'canvas-flow-agent-'))
  const evidence = qaOutputPath('qa/agent-real-graph/desktop')
  await mkdir(evidence, { recursive: true })
  const rendererPort = await reserveLoopbackPort()
  const rendererUrl = `http://127.0.0.1:${rendererPort}`
  const server = spawn(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--config', 'vite.browser.config.ts', '--host', '127.0.0.1', '--port', String(rendererPort), '--strictPort'], { stdio: 'ignore', windowsHide: true })
  try {
    const deadline = Date.now() + 30000
    while (true) {
      if (server.exitCode !== null) throw new Error('REAL_VITE_UNAVAILABLE')
      try {
        const [indexResponse, editorModuleResponse] = await Promise.all([fetch(rendererUrl), fetch(`${rendererUrl}/src/stores/editor.ts`)])
        const moduleType = editorModuleResponse.headers.get('content-type') ?? ''
        if (indexResponse.ok && editorModuleResponse.ok && !moduleType.includes('text/html')) break
      } catch { /* readiness */ }
      if (Date.now() > deadline) throw new Error('REAL_VITE_TIMEOUT')
      await new Promise((done) => setTimeout(done, 250))
    }
    const env = { ...process.env, CANVAS_AGENT_RENDERER_URL: rendererUrl, CANVAS_AGENT_PROBE_KEY: key, CANVAS_AGENT_PROBE_BASE_URL: baseUrl, CANVAS_AGENT_PROBE_MODEL: model }
    delete env.ELECTRON_RUN_AS_NODE
    const exit = await new Promise((done, reject) => {
      const child = spawn(require('electron'), [resolve('out/main/agent-flow-desktop.js'), `--agent-directory=${directory}`, '--agent-phase=execute', '--capability-graph', '--real-model'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const timer = setTimeout(() => { child.kill(); reject(new Error('REAL_ELECTRON_TIMEOUT')) }, 300000)
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('exit', (code, signal) => { clearTimeout(timer); if (stderr) require('node:fs').writeFileSync(join(directory, 'harness-stderr.log'), stderr); done({ code, signal }) })
    })
    const report = JSON.parse(await readFile(join(directory, 'execute-report.json'), 'utf8'))
    await writeFile(join(evidence, 'execute-report.json'), JSON.stringify({ ...report, model, baseUrl }, null, 2))
    if (exit.code !== 0 || report.status !== 'pass') throw new Error(`REAL_GRAPH_FAILED: code=${exit.code} report=${JSON.stringify(report).slice(0, 400)}`)
    console.log(`Real-model graph desktop passed: ${evidence} (model=${model})`)
  } finally {
    server.kill()
  }
})().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })