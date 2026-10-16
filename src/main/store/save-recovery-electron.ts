// Isolated hidden acceptance only; never imported by the application.
import { app, BrowserWindow, ipcMain } from 'electron'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { createProject, openProject } from './projects.repo'
import { getDb, closeDb, setSetting } from './db'
import { registerProjectIpc } from '../ipc/project.ipc'
import { registerLibraryIpc } from '../ipc/library.ipc'
import { registerMediaIpc } from '../ipc/media.ipc'
import { registerWorkspaceStateIpc } from '../ipc/workspace-state.ipc'
import { registerGatewayIpc } from '../ipc/gateway.ipc'
import { registerModelIpc } from '../ipc/models.ipc'
import { registerDiagnosticsIpc, setDiagnosticsService } from '../ipc/diagnostics.ipc'
import { registerFlowCommandsIpc } from '../ipc/flow-commands.ipc'
import { registerFlowAgentsIpc } from '../ipc/flow-agents.ipc'
import { registerFlowAssetsIpc } from '../ipc/flow-assets.ipc'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { createDesktopModelRuntime } from '../model-host/runtime'
import { initDiagnosticsService } from '../diagnostics/service'
import { setGatewayEventSink } from '../diagnostics/gateway-events'
import { IPC } from '../../shared/contracts'
import { verifyStorageRecovery } from './save-storage-acceptance'

const argument = (key: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3)
const directory = argument('save-directory'),
  boundary = argument('save-boundary')
if (
  !directory ||
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-save-crash-') ||
  !boundary ||
  !['unsent', 'before-save', 'after-save', 'failed-save', 'storage-retry'].includes(boundary)
)
  app.exit(2)
else {
  process.env.CANVAS_DATA_DIR = directory
  app.setPath('userData', directory)
  app.on('window-all-closed', () => {})
  void app.whenReady().then(async () => {
    const diagnostics = await initDiagnosticsService({ dataDir: directory, disableTimers: true })
    setGatewayEventSink(diagnostics)
    setDiagnosticsService(diagnostics)
    let window: BrowserWindow | undefined,
      failed = false,
      stage = 'setup'
    let result: unknown
    const mutableFs = createRequire(__filename)('fs') as typeof fs,
      originalWrite = mutableFs.writeFileSync
    const originalHandle = ipcMain.handle.bind(ipcMain)
    let armed = false,
      accepted = 0,
      settled = false
    let release = (): void => {}
    const gate = new Promise<void>((done) => {
      release = done
    })
    try {
      const project = createProject('测试：renderer 保存中断')
      setSetting('lastProjectId', project.id)
      const host = new SqliteModelHost(getDb())
      window = new BrowserWindow({
        show: false,
        width: 1500,
        height: 900,
        webPreferences: {
          preload: resolve(__dirname, '../preload/index.js'),
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })
      const active = window
      // Wrap registered production handlers only inside this acceptance host.
      ipcMain.handle = ((channel, listener) =>
        originalHandle(channel, async (event, ...args) => {
          if (armed && channel === IPC.project.open && args[0] === 'fixture-renderer-cut') {
            active.webContents.forcefullyCrashRenderer()
            return { ok: true, data: null }
          }
          if (!armed || channel !== IPC.project.save) return listener(event, ...args)
          accepted++
          if (boundary === 'before-save') await gate
          const reply = await listener(event, ...args)
          settled = true
          if (boundary === 'after-save' || boundary === 'failed-save') await gate
          return reply
        })) as typeof ipcMain.handle
      try {
        registerProjectIpc()
      } finally {
        ipcMain.handle = originalHandle
      }
      registerLibraryIpc()
      registerMediaIpc()
      registerWorkspaceStateIpc()
      registerDiagnosticsIpc()
      registerModelIpc(host, createDesktopModelRuntime(host))
      registerGatewayIpc(active)
      registerFlowAssetsIpc(() => active)
      registerFlowCommandsIpc(
        () => active,
        (desktop) => registerFlowAgentsIpc(() => active, desktop)
      )
      const waitFor = async (check: () => Promise<boolean>): Promise<void> => {
        const deadline = Date.now() + 60000
        while (!(await check())) {
          if (Date.now() > deadline) throw new Error('SAVE_FIXTURE_TIMEOUT')
          await new Promise((done) => setTimeout(done, 50))
        }
      }
      const ready = (): Promise<boolean> =>
        active.webContents.executeJavaScript(
          "(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor,save=(await import('/src/stores/save-coordinator.ts')).useSaveCoordinator.getState();return !!editor&&!!save.deps&&!save.inFlight&&save.phase==='saved'})()"
        ) as Promise<boolean>
      await active.loadURL('http://127.0.0.1:5197')
      await waitFor(ready)
      await active.webContents.executeJavaScript(
        "(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;editor.createShape({id:'shape:save-source',type:'node-card',x:100,y:100,props:{nodeType:'text',title:'测试材料',text:'private-save-original'}});await(await import('/src/canvas/flow-asset-actions.ts')).ensureCanvasSaved()})()"
      )
      if (boundary === 'storage-retry') {
        await waitFor(
          () =>
            active.webContents.executeJavaScript(
              "!!document.querySelector('.tl-canvas')&&!document.body.innerText.includes('正在打开本地创作空间')"
            ) as Promise<boolean>
        )
        await waitFor(ready)
      }
      const baseline = openProject(project.id)!.meta.graphVersion
      if (boundary === 'storage-retry') {
        stage = 'storage-retry'
        result = await verifyStorageRecovery(
          active,
          directory,
          project.id,
          baseline,
          ready,
          waitFor
        )
        return
      }
      stage = 'interrupt'
      armed = true
      mutableFs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
        if (armed && boundary === 'failed-save' && String(args[0]).endsWith('project.json.tmp'))
          throw Object.assign(new Error('FIXTURE_WRITE_FAILED'), { code: 'EIO' })
        return originalWrite(...args)
      }) as typeof fs.writeFileSync
      const gone = new Promise<string>((done) =>
        active.webContents.once('render-process-gone', (_event, details) => done(details.reason))
      )
      if (boundary === 'unsent') {
        void active.webContents
          .executeJavaScript(
            "(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;editor.updateShape({id:'shape:save-source',type:'node-card',props:{text:'private-save-next'}});await window.api.openProject('fixture-renderer-cut')})()"
          )
          .catch(() => undefined)
      } else {
        void active.webContents
          .executeJavaScript(
            "(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;editor.updateShape({id:'shape:save-source',type:'node-card',props:{text:'private-save-next'}});await(await import('/src/canvas/flow-asset-actions.ts')).ensureCanvasSaved()})()"
          )
          .catch(() => undefined)
        await waitFor(async () => (boundary === 'before-save' ? accepted > 0 : settled))
        active.webContents.forcefullyCrashRenderer()
      }
      const reason = await Promise.race([
        gone,
        new Promise<never>((_done, reject) =>
          setTimeout(() => reject(new Error('SAVE_RENDERER_CRASH_TIMEOUT')), 15000)
        )
      ])
      release()
      if (boundary !== 'unsent') await waitFor(async () => settled)
      armed = false
      mutableFs.writeFileSync = originalWrite
      const stored = openProject(project.id)!
      const readText = (file: typeof stored): unknown =>
        (file.tldrawSnapshot as { store: Record<string, { props: { text: string } }> }).store[
          'shape:save-source'
        ].props.text
      const expected = ['unsent', 'failed-save'].includes(boundary)
        ? 'private-save-original'
        : 'private-save-next'
      if (readText(stored) !== expected) throw new Error('SAVE_CRASH_STORED_CONTENT_INVALID')
      if (accepted !== (boundary === 'unsent' ? 0 : 1))
        throw new Error('SAVE_CRASH_DUPLICATE_REQUEST')
      if (
        stored.meta.graphVersion !==
        baseline + (['unsent', 'failed-save'].includes(boundary) ? 0 : 1)
      )
        throw new Error('SAVE_CRASH_VERSION_INVALID')
      stage = 'reopen'
      await active.loadURL('http://127.0.0.1:5197')
      await waitFor(ready)
      const reopened = await active.webContents.executeJavaScript(
        "(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;return editor.getShape('shape:save-source')?.props.text})()"
      )
      if (reopened !== expected) throw new Error('SAVE_CRASH_REOPEN_CONTENT_INVALID')
      await active.webContents.executeJavaScript(
        "(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;editor.updateShape({id:'shape:save-source',type:'node-card',props:{text:'private-save-resumed'}});await(await import('/src/canvas/flow-asset-actions.ts')).ensureCanvasSaved()})()"
      )
      if (readText(openProject(project.id)!) !== 'private-save-resumed')
        throw new Error('SAVE_CRASH_RESUME_NOT_SAVED')
      result = {
        boundary,
        reason,
        accepted,
        checks: [
          'actual renderer crash without beforeunload',
          'stored content and graph version verified',
          'new renderer loads authoritative snapshot',
          'editing and public IPC saving work after reopen'
        ]
      }
    } catch (error) {
      failed = true
      result = {
        stage,
        code:
          error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : 'SAVE_ACCEPTANCE_FAILED'
      }
    } finally {
      armed = false
      release()
      mutableFs.writeFileSync = originalWrite
      ipcMain.handle = originalHandle
      window?.destroy()
      await diagnostics.flushOnQuit()
      closeDb()
      fs.writeFileSync(
        join(directory, 'report.json'),
        JSON.stringify({ status: failed ? 'failed' : 'pass', result })
      )
      app.exit(failed ? 1 : 0)
    }
  })
}
