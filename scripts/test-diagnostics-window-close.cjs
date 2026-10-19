/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Source-app acceptance only: inject transport faults before loading the unchanged main bundle.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { _electron: electron } = require('playwright')
const { qaOutputPath } = require('./qa-output.cjs')

async function filesUnder(directory) {
  const output = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await filesUnder(target))
    else output.push(target)
  }
  return output
}

;(async () => {
  const parent = qaOutputPath('qa/diagnostics-window-close')
  await fs.mkdir(parent, { recursive: true })
  const evidence = await fs.mkdtemp(path.join(parent, 'run-'))
  const server = spawn(process.execPath, [
    path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
    '--config', 'vite.browser.config.ts', '--host', '127.0.0.1', '--port', '5203', '--strictPort'
  ], { stdio: 'ignore', windowsHide: true })
  const results = []
  try {
    const deadline = Date.now() + 30000
    while (true) {
      if (server.exitCode !== null) throw new Error('QA_VITE_EXITED')
      try { if ((await fetch('http://127.0.0.1:5203')).ok) break } catch { /* readiness */ }
      assert(Date.now() < deadline, 'QA_VITE_TIMEOUT')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    for (const mode of ['slow', 'reject', 'unavailable', 'partial', 'timeout', 'write-failure', 'prior-unclean']) {
      const directory = path.join(evidence, mode)
      const data = path.join(directory, 'data')
      await fs.mkdir(data, { recursive: true })
      await fs.mkdir(path.join(directory, 'profile'), { recursive: true })
      if (mode === 'prior-unclean') {
        const sessions = path.join(data, 'diagnostics', 'sessions')
        await fs.mkdir(sessions, { recursive: true })
        await fs.writeFile(path.join(sessions, 'session-qa-prior.json'), JSON.stringify({
          sessionId: 'qa-prior', startedAt: '2026-10-18T00:00:00.000Z', ended: false
        }))
      }
      const bootstrap = path.join(directory, 'bootstrap.cjs')
      await fs.writeFile(bootstrap, `
const { app, BrowserWindow, ipcMain } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
BrowserWindow.prototype.show = function () { this.setTitle('测试：诊断关窗 ${mode}'); };
const state = globalThis.__qaShutdown = { armed: false, started: false, acknowledged: false };
const filePromises = require('node:fs/promises');
const append = filePromises.appendFile.bind(filePromises);
filePromises.appendFile = (file, ...args) => {
  if (state.armed && ${JSON.stringify(mode)} === 'write-failure' && String(file).startsWith(${JSON.stringify(path.join(data, 'diagnostics', 'events'))})) {
    return Promise.reject(Object.assign(new Error('QA_DIAGNOSTICS_WRITE_FAILED'), { code: 'EIO' }));
  }
  return append(file, ...args);
};
app.on('browser-window-created', (_event, window) => {
  const execute = window.webContents.executeJavaScript.bind(window.webContents);
  window.webContents.executeJavaScript = async (code, ...rest) => {
    const result = await execute(code, ...rest);
    if (code.includes('__canvasDrainDiagnosticsForShutdown')) {
      require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'drain.json'))}, JSON.stringify(result));
    }
    return result;
  };
});
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, async (...args) => {
  if (channel !== 'diagnostics:event' || !state.armed) return callback(...args);
  state.started = true;
  await new Promise(resolve => setTimeout(resolve, ${mode === 'timeout' ? 5000 : 600}));
  state.acknowledged = true;
  if (${JSON.stringify(mode)} === 'reject') throw new Error('QA_DIAGNOSTICS_REJECTED');
  if (${JSON.stringify(mode)} === 'unavailable') return { ok: false, error: { code: 'DIAGNOSTICS_UNAVAILABLE' } };
  if (${JSON.stringify(mode)} === 'partial') {
    const input = args[1];
    return callback(args[0], { ...input, events: input.events.slice(0, 1) });
  }
  return callback(...args);
});
require(${JSON.stringify(path.resolve('out/main/index.js'))});
`)
      let application
      try {
        const env = { ...process.env, CANVAS_DATA_DIR: data, ELECTRON_RENDERER_URL: 'http://127.0.0.1:5203' }
        delete env.ELECTRON_RUN_AS_NODE
        application = await electron.launch({ executablePath: require('electron'), args: [bootstrap], env, timeout: 30000 })
        const page = await application.firstWindow()
        await page.waitForLoadState('load', { timeout: 60000 })
        await page.waitForFunction(() => typeof window.api?.createProject === 'function')
        const business = await page.evaluate(async () => {
          const created = await window.api.createProject({ name: '测试：关窗诊断隔离项目' })
          if (!created.ok) throw new Error('QA_PROJECT_CREATE_FAILED')
          const saved = await window.api.saveProject({
            id: created.data.id, expectedGraphVersion: 0,
            tldrawSnapshot: { sentinel: 'qa-private-shutdown-body' }
          })
          if (!saved.ok || saved.data?.graphVersion !== 1) throw new Error('QA_PROJECT_SAVE_FAILED')
          return { id: created.data.id, version: saved.data.graphVersion }
        })
        await page.evaluate(async (projectId) => {
          const reporter = await import('/src/engine/diagnosticsReporter.ts')
          await reporter.drainDiagnosticsEvents()
          const deadline = Date.now() + 5000
          while (true) {
            const queried = await window.api.queryDiagnostics({ limit: 2000 })
            if (!queried.ok) throw new Error('QA_DIAGNOSTICS_QUERY_FAILED')
            if (queried.data.events.some(event => event.event === 'project.save.completed' && event.projectId === projectId)) break
            if (Date.now() > deadline) throw new Error('QA_BASELINE_SAVE_LOG_NOT_PERSISTED')
            await new Promise(resolve => setTimeout(resolve, 25))
          }
        }, business.id)
        await application.evaluate(() => { globalThis.__qaShutdown.armed = true })
        await page.evaluate(async (sharedModuleUrl) => {
          const reporter = await import('/src/engine/diagnosticsReporter.ts')
          const { DiagnosticsProducer } = await import(sharedModuleUrl)
          const producer = new DiagnosticsProducer({ process: 'renderer', producerId: 'renderer-close-qa' })
          for (let index = 0; index < 2; index++) {
            reporter.emitDiagnosticsEvent(producer.build('node.completed', undefined, '隔离关窗传输探针', {
              traceId: 'trace-shutdown-probe', spanId: 'span-shutdown-' + index,
              projectId: 'qa-shutdown-probe', nodeId: 'qa-probe', nodeType: 'text'
            }, { status: 'success', privateValues: ['qa-private-shutdown-body'] }))
          }
          reporter.flushDiagnosticsEvents()
        }, '/@fs/' + path.resolve('src/shared/observability/index.ts').replaceAll('\\', '/'))
        const started = Date.now()
        while (!(await application.evaluate(() => globalThis.__qaShutdown.started))) {
          assert(Date.now() - started < 5000, 'QA_DIAGNOSTICS_NOT_SENT')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        const closeStarted = Date.now()
        const closed = application.waitForEvent('close', { timeout: 15000 })
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
        await closed
        application = null
        const durationMs = Date.now() - closeStarted
        assert(durationMs < 6000, 'QA_CLOSE_UNBOUNDED')
        if (mode !== 'timeout') assert(durationMs >= 350, 'QA_CLOSE_DID_NOT_WAIT_FOR_ACK')
        const files = await filesUnder(path.join(data, 'diagnostics'))
        const sessions = []
        const events = []
        for (const file of files) {
          const text = await fs.readFile(file, 'utf8')
          assert(!text.includes('qa-private-shutdown-body'), 'QA_PRIVATE_BODY_IN_DIAGNOSTICS')
          if (file.endsWith('.jsonl')) events.push(...text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
          else if (file.endsWith('.json') && file.includes(`${path.sep}sessions${path.sep}`)) sessions.push(JSON.parse(text))
        }
        const current = sessions.filter(session => session.sessionId !== 'qa-prior')
        assert.equal(current.length, 1)
        assert.equal(current[0].env.platform, process.platform)
        assert.equal(current[0].env.electron, require('electron/package.json').version)
        assert.equal(current[0].env.packaged, false)
        const complete = mode === 'slow' || mode === 'prior-unclean'
        assert.equal(current[0].ended, complete)
        assert.equal(events.filter(event => event.event === 'app.previous_session_unclean').length, mode === 'prior-unclean' ? 1 : 0)
        if (mode === 'prior-unclean') assert.equal(sessions.find(session => session.sessionId === 'qa-prior').ended, false)
        const delivered = events.filter(event => event.traceId === 'trace-shutdown-probe')
        assert.equal(delivered.length, complete ? 2 : mode === 'partial' ? 1 : 0)
        assert.equal(events.filter(event => event.event === 'model.request.started').length, 0)
        const saves = events.filter(event => event.event === 'project.save.started')
        assert(saves.length > 0)
        for (const start of saves) assert.equal(events.filter(event => event.event === 'project.save.completed' && event.traceId === start.traceId && event.spanId === start.spanId).length, 1)
        const projectFiles = (await filesUnder(path.join(data, 'projects'))).filter(file => path.basename(file) === 'project.json')
        assert.equal(projectFiles.length, 1)
        assert((await fs.readFile(projectFiles[0], 'utf8')).includes('qa-private-shutdown-body'))
        const drain = mode === 'timeout' ? null : JSON.parse(await fs.readFile(path.join(directory, 'drain.json'), 'utf8'))
        if (drain) assert.equal(drain.dropped, mode === 'partial' ? 1 : ['reject', 'unavailable'].includes(mode) ? 2 : 0)
        results.push({ mode, durationMs, ended: current[0].ended, delivered: delivered.length, transportDropped: drain?.dropped ?? null, previousUnclean: mode === 'prior-unclean', environmentPreserved: true, businessVersion: business.version, businessPreserved: true, redacted: true })
      } finally {
        if (application) await application.close()
      }
    }
    await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'passed', results, boundary: 'Source production main/preload + Vite renderer; real hidden BrowserWindow.close; IPC fault injection. Probe events are synthetic, not Agent execution facts. No installer or supplier calls.' }, null, 2))
    process.stdout.write(`Diagnostics real window close passed: ${evidence}\n`)
  } catch (error) {
    await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'failed', results, code: error.code || 'QA_WINDOW_CLOSE_FAILED' }, null, 2))
    throw error
  } finally { server.kill() }
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
