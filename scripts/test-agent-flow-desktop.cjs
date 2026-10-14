/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, basename, dirname } = require('node:path')
const real = process.argv.includes('--real-model')
const firstFrame = process.argv.includes('--video-first-frame')
const video = firstFrame || process.argv.includes('--video')
if(video && real) throw new Error('VIDEO_ACCEPTANCE_FIXTURE_ONLY')
if(video && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR=firstFrame ? 'qa/agent-video-first-frame-20261015/desktop' : 'qa/agent-video-20261015/desktop'
const collaboration = process.argv.includes('--collaboration')
const recovery = process.argv.includes('--recovery')
const coordination = process.argv.includes('--coordination') || recovery
if (recovery && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR = 'qa/canvas-agent-flow/C4/desktop-recovery-fixture'
const builder = process.argv.includes('--builder')
const review = process.argv.includes('--review')
const rework = process.argv.includes('--rework')
const reworkModeArgument = process.argv.find(arg => arg.startsWith('--rework-mode='))
if (reworkModeArgument) process.env.CANVAS_AGENT_REWORK_MODE = reworkModeArgument.split('=')[1]
if (rework && !['autonomous', 'collaborative', 'manual'].includes(process.env.CANVAS_AGENT_REWORK_MODE || 'autonomous')) throw new Error('AGENT_REWORK_MODE_INVALID')
async function cleanDirectory(directory) {
  if (resolve(directory, '..') !== resolve(tmpdir()) || !basename(directory).startsWith('canvas-flow-agent-')) throw new Error('AGENT_CLEANUP_REJECTED')
  await rm(directory, { recursive: true, force: true })
}
if (process.argv.slice(2).some(arg => !['--real-model','--collaboration','--coordination','--builder','--review','--rework','--recovery','--video','--video-first-frame'].includes(arg) && arg !== reworkModeArgument)) throw new Error('AGENT_TEST_ARGUMENT_INVALID')
if (real && (!process.env.CANVAS_AGENT_PROBE_KEY || !process.env.CANVAS_AGENT_PROBE_MODEL)) throw new Error('AGENT_REAL_CREDENTIAL_REQUIRED')
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-flow-agent-'))
  const evidence = resolve(process.env.CANVAS_AGENT_EVIDENCE_DIR || `qa/canvas-agent-flow/C3/desktop-${rework ? 'rework-' + (process.env.CANVAS_AGENT_REWORK_MODE || 'autonomous') + '-' : review ? 'review-' : builder ? 'builder-' : coordination ? 'coordination-' : collaboration ? 'collaboration-' : ''}${real ? 'real' : 'fixture'}`)
  if (!evidence.startsWith(resolve('qa') + require('node:path').sep)) throw new Error('AGENT_EVIDENCE_PATH_INVALID')
  await mkdir(evidence, { recursive: true })
  let requests = 0
  const provider = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      if (++requests > 40 || body.length > 300000) throw new Error('FIXTURE_BUDGET')
      const json = JSON.parse(body)
      if (!json.tools?.length) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end('data: '+JSON.stringify({ id:'discussion',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{content:'private-c3-discussion-reply'},finish_reason:null}] })+'\n\ndata: '+JSON.stringify({id:'discussion',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
        return
      }
      let name, args
      const names = json.tools.map(tool => tool.function.name)
      if (names.includes('probe_echo') || names.includes('probe_done')) {
        name = names[0]; args = name === 'probe_done'
          ? JSON.parse(json.messages.find(message => message.role === 'tool').content)
          : { marker: 'probe-ok', count: 7 }
      } else {
        const userContent = json.messages.filter(message => message.role === 'user').at(-1).content
        const input = names.includes('review_assets') ? {subjects:[{kind:'text',text:userContent}]} : JSON.parse(userContent)
        if (names.includes('review_assets')) { const passed=input.subjects.every(v=>v.text?.startsWith('交付：'));name='review_assets';args={passed,feedback:passed?'标准满足':'缺交付标题，请在人工材料节点补上交付：',issues:passed?[]:[{subjectIndex:0,feedback:'补交付标题'}]}; } else if (names.includes('propose_flow')) { name='propose_flow'; args={ title:'整理交付流程', steps:[{title:'整理',goal:'使用授权的数据处理节点添加整理标题，再交付真实资产。',mode:'autonomous',template:'整理：{{value}}'},{title:'交付',goal:'使用授权的数据处理节点添加交付标题，再交付真实资产。',mode:'autonomous',template:'交付：{{value}}'}] }; } else if (names.includes('dispatch_agent')) {
          const candidate = input.available[0]
          if (candidate) { name = 'dispatch_agent'; args = { nodeId: candidate.nodeId, goal: candidate.goal, completion: video ? '完成一次视频生成并交付固定视频版本' : '完成两次公共处理，固定真实成果', inputs: candidate.inputs } }
          else { name = 'finish_flow'; args = { outputs: input.completed.at(-1).outputs } }
        } else {
        if (!input.directInputs?.length || !input.fixedInputs?.length) throw new Error('FIXTURE_DECLARED_INPUT_MISSING')
        if (input.goal === 'cancel-fixture') await new Promise(done => setTimeout(done, 10000))
        if (input.skills.length && !Object.keys(input.loaded).length) { name = 'load_skill'; args = { skillId: 'result-check' } }
        else if (input.receipts.length < (video ? 1 : 2)) { name = 'execute_node'; args = { targetNodeId: input.rework ? input.targets.find(target => target.nodeId === 'shape:rw-repair').nodeId : input.targets[0].nodeId } }
        else if (input.mode === 'collaborative' && !input.humanAccepted) { name = 'wait_for_human'; args = {} }
        else { name = 'finish_task'; args = { outputs: input.selectedOutputs?.length ? input.selectedOutputs : input.receipts.at(-1).outputRefs } }
        }
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
    if(firstFrame) await writeFile(join(directory,'first-frame.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYawAAAAASUVORK5CYII=','base64'))
    if(video) await cp(resolve('test/fixtures/agent-video.mp4'),join(directory,'fixture.mp4'))
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
        const child = spawn(require('electron'), [resolve('out/main/agent-flow-desktop.js'), `--agent-directory=${directory}`, `--agent-phase=${phase}`, ...(real ? ['--real-model'] : []), ...(collaboration ? ['--collaboration'] : []), ...(coordination ? ['--coordination'] : []), ...(builder ? ['--builder'] : []), ...(review ? ['--review'] : []), ...(rework ? ['--rework'] : []), ...(recovery ? ['--recovery'] : []), ...(video ? ['--video'] : []), ...(firstFrame ? ['--video-first-frame'] : [])],
          { env, stdio: 'ignore', windowsHide: true })
        const timer = setTimeout(() => { child.kill(); reject(new Error('AGENT_ELECTRON_TIMEOUT')) }, 240000)
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('exit', code => { clearTimeout(timer); done(code) })
      })
      const report = JSON.parse(await readFile(join(directory, `${phase}-report.json`), 'utf8'))
      await writeFile(join(evidence, `${phase}-report.json`), JSON.stringify(report, null, 2))
      reports.push(report)
      if(video && phase==='reopen' && report.status==='pass') {
        await cp(join(directory,'video-fixed.png'),join(evidence,'video-fixed.png'))
        if(firstFrame) await cp(join(directory,'image-fixed.png'),join(evidence,'image-fixed.png'))
      }
      if (code !== 0 || report.status !== 'pass') {
        await cp(join(directory,'pointer-failure.png'),join(evidence,'pointer-failure.png')).catch(()=>{})
        await scan(join(directory, 'diagnostics'))
        await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
        await writeFile(join(evidence, 'failure-reasons.json'), JSON.stringify(events.filter(event => event.event.endsWith('.failed')).map(event => ({ event: event.event, phase: event.attributes?.phase, action: event.attributes?.action, code: event.attributes?.code || event.error?.code })), null, 2))
        throw new Error(`AGENT_${phase.toUpperCase()}_${report.report?.code || 'FAILED'}`)
      }
    }
    async function scan(path) {
      for (const file of await readdir(path, { withFileTypes: true })) {
        const target = join(path, file.name)
        if (file.isDirectory()) await scan(target)
        else {
          const text = await readFile(target, 'utf8')
          if (text.includes('private-c3') || text.includes('data:image/') || text.includes('iVBORw0KGgoAAAANSUhEUg') || (process.env.CANVAS_AGENT_PROBE_KEY && text.includes(process.env.CANVAS_AGENT_PROBE_KEY))) throw new Error('AGENT_DIAGNOSTICS_REDACTION_FAILED')
          if (file.name.endsWith('.jsonl')) for (const line of text.trim().split('\n')) if (line.trim()) events.push(JSON.parse(line))
        }
      }
    }
    await scan(join(directory, 'diagnostics'))
    const started = events.filter(event => event.event === 'agent.desktop.started')
    const ended = events.filter(event => ['agent.desktop.completed', 'agent.desktop.failed'].includes(event.event))
    if (!started.length || started.length !== ended.length) throw new Error('AGENT_DESKTOP_LIFECYCLE_FAILED')
    for (const event of started) if (ended.filter(end => end.traceId === event.traceId && end.spanId === event.spanId).length !== 1) throw new Error('AGENT_DESKTOP_TERMINAL_DUPLICATED')
    if (!builder && !review && !rework && !events.some(event => event.event === 'agent.runtime.resumed' && event.attributes?.resumesTraceId)) throw new Error('AGENT_RESUME_TRACE_MISSING')
    if (recovery) {
      const transfers = events.filter(event => event.event === 'project.transfer.started')
      if (transfers.length !== 2) throw new Error('C4_TRANSFER_LIFECYCLE_MISSING')
      for (const event of transfers) if (events.filter(end => ['project.transfer.committed', 'project.transfer.failed'].includes(end.event) && end.traceId === event.traceId && end.spanId === event.spanId).length !== 1) throw new Error('C4_TRANSFER_TERMINAL_INVALID')
      const reconciled = events.filter(event => event.event === 'agent.coordination.started' && event.attributes?.phase === 'reconcile')
      if (reconciled.length !== 1 || !reconciled[0].attributes?.resumesTraceId) throw new Error('C4_RECONCILE_TRACE_MISSING')
      for (const event of reconciled) if (events.filter(end => ['agent.coordination.completed', 'agent.coordination.failed'].includes(end.event) && end.traceId === event.traceId && end.spanId === event.spanId).length !== 1) throw new Error('C4_RECONCILE_TERMINAL_INVALID')
    }
    await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
    const modelRequests = events.filter(event => event.event === 'model.request.started').length
    await writeFile(join(evidence, 'results.json'), JSON.stringify({ reports, modelRequests, diagnosticRedaction: true,
      boundary: 'real desktop canvas/executor/IPC/model catalog/SDK/two process checkpoint/fixed assets', model: real ? process.env.CANVAS_AGENT_PROBE_MODEL : 'synthetic fixture' }, null, 2))
    process.stdout.write(video ? 'Agent video desktop: main dispatch, unknown/reopen/explicit continue, one supplier task, one download, fixed playable video asset and diagnostics passed.\n' : `Agent desktop ${real ? 'real model' : 'fixture'}: start, two tools, human wait/reopen/continue, declared fixed assets and diagnostics passed.\n`)
  } finally {
    try {
      server.kill()
      await new Promise((done, reject) => {
        if (server.exitCode !== null || server.signalCode !== null) return done()
        const timer = setTimeout(() => reject(new Error('AGENT_VITE_CLEANUP_FAILED')), 5000)
        server.once('exit', () => { clearTimeout(timer); done() })
      })
    } finally {
      provider.closeAllConnections(); provider.close()
      await cleanDirectory(directory)
    }
  }
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
