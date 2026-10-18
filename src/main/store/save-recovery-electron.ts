// Isolated hidden acceptance only; never imported by the application.
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import {
  createProject,
  openProject,
  readRecoveryCopy,
  saveProject
} from './projects.repo'
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
import { FlowAgentDesktopHost } from '../agent-flow/desktop-host'
import { FlowCommandLedger } from '../agent-flow/command-ledger'

const argument = (key: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3)
const directory = argument('save-directory'),
  boundary = argument('save-boundary')
if (
  !directory ||
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-save-crash-') ||
  !boundary ||
  ![
    'unsent',
    'before-save',
    'after-save',
    'failed-save',
    'storage-retry',
    'agent-close-conflict',
    'agent-close-conflict-reopen'
  ].includes(boundary)
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
    const externalHttpRequests: string[] = []
    if (boundary.startsWith('agent-close-conflict')) {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, done) => {
        try {
          const address = new URL(details.url)
          if (!['localhost', '127.0.0.1', '[::1]'].includes(address.hostname))
            externalHttpRequests.push(`${address.origin}${address.pathname}`)
        } catch {
          externalHttpRequests.push('INVALID_EXTERNAL_URL')
        }
        done({})
      })
    }
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
      const prior =
        boundary === 'agent-close-conflict-reopen'
          ? JSON.parse(fs.readFileSync(join(directory, 'agent-close-state.json'), 'utf8'))
          : undefined
      const project = prior
        ? openProject(prior.projectId)?.meta
        : createProject('测试：Agent 运行时关窗冲突恢复')
      if (!project) throw new Error('SAVE_PROJECT_MISSING')
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
      if (boundary === 'agent-close-conflict-reopen') {
        await waitFor(async () =>
          (await active.webContents.executeJavaScript(
            `!!document.querySelector('[role="dialog"][aria-label="检测到未保存副本"]')`
          )) as boolean
        )
      } else {
        await waitFor(ready)
      }
      if (boundary === 'agent-close-conflict' || boundary === 'agent-close-conflict-reopen') {
        const agentNodeId = 'shape:rec09-agent'
        const textOf = (file: NonNullable<ReturnType<typeof openProject>>, id = agentNodeId): string =>
          String(
            (
              file.tldrawSnapshot as {
                store: Record<string, { props?: { text?: string } }>
              }
            ).store[id]?.props?.text ?? ''
          )
        const waitForClosed = (target: BrowserWindow): Promise<void> =>
          new Promise((done) => target.once('closed', () => done()))
        if (boundary === 'agent-close-conflict') {
          stage = 'agent-setup'
          const config = JSON.stringify({
            schemaVersion: 1,
            role: 'specialist',
            interactionMode: 'collaborative',
            modelDefinitionId: 'fixture-local-only',
            skills: [],
            tools: [{ id: 'node.execute', version: '1' }],
            allowedNodeIds: ['shape:rec09-processor'],
            maxSteps: 4,
            relations: []
          })
          await active.webContents.executeJavaScript(
            `(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;editor.createShape({id:'${agentNodeId}',type:'node-card',x:120,y:120,props:{nodeType:'agent',title:'REC-09 Agent',text:'本地未保存目标 v1',config:${JSON.stringify(config)}}});editor.createShape({id:'shape:rec09-processor',type:'node-card',x:520,y:120,props:{nodeType:'processor',title:'REC-09 授权处理器',config:JSON.stringify({operation:'pick',valueType:'any',fallback:'',path:'',template:''})}});await(await import('/src/canvas/flow-asset-actions.ts')).ensureCanvasSaved()})()`
          )
          const initial = openProject(project.id)!
          const initialVersion = initial.meta.graphVersion
          let modelCalls = 0
          const neverResolve = new Promise<never>(() => {})
          const desktop = {
            ledger: new FlowCommandLedger(getDb(), openProject),
            isActive: (projectId: string): boolean => projectId === project.id,
            deliver: async (): Promise<void> => {
              throw new Error('REC09_UNEXPECTED_TOOL_DISPATCH')
            }
          }
          const host = new FlowAgentDesktopHost(getDb(), openProject, desktop, async () => ({
            decide: async () => {
              modelCalls++
              return neverResolve
            }
          }))
          const task = host
            .run({
              projectId: project.id,
              nodeId: agentNodeId,
              requestId: 'rec09-running-agent-task',
              traceId: 'rec09-running-trace',
              spanId: 'rec09-running-span',
              action: 'start'
            })
            .catch(() => undefined)
          await waitFor(async () => {
            const row = getDb()
              .prepare('SELECT state,decisions FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=?')
              .get(project.id, agentNodeId) as { state: string; decisions: number } | undefined
            return modelCalls === 1 && row?.state === 'running' && row.decisions === 1
          })
          stage = 'external-concurrent-save'
          const current = openProject(project.id)!
          const externalSnapshot = structuredClone(
            current.tldrawSnapshot as { store: Record<string, { props: Record<string, unknown> }> }
          )
          externalSnapshot.store[agentNodeId].props.text = '并发工作台目标 v2'
          const externalSave = saveProject({
            id: project.id,
            tldrawSnapshot: externalSnapshot,
            expectedGraphVersion: current.meta.graphVersion
          })
          if (!externalSave) throw new Error('REC09_EXTERNAL_SAVE_FAILED')
          const workspace = await active.webContents.executeJavaScript(
            `(async()=>{const saved=await window.api.saveWorkspaceProfile({projectId:'${project.id}',workspaceProfile:{schemaVersion:1,presetId:'custom',visibleNodeTypeIds:['agent','text']}});if(!saved.ok||!saved.data)throw new Error('REC09_WORKSPACE_SAVE_FAILED');return saved.data.id})()`
          ) as string
          if (workspace !== project.id) throw new Error('REC09_WORKSPACE_SAVE_FAILED')
          await active.webContents.executeJavaScript(
            `(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;editor.updateShape({id:'${agentNodeId}',type:'node-card',props:{text:'本地未保存目标 v3'}})})()`
          )
          stage = 'beforeunload-conflict'
          const closed = waitForClosed(active)
          active.close()
          await Promise.race([
            closed,
            new Promise<never>((_done, reject) =>
              setTimeout(() => reject(new Error('REC09_BEFOREUNLOAD_CLOSE_TIMEOUT')), 15000)
            )
          ])
          const disk = openProject(project.id)!
          const recovery = readRecoveryCopy(project.id)
          const taskRow = getDb()
            .prepare('SELECT state,decisions FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=?')
            .get(project.id, agentNodeId) as { state: string; decisions: number }
          const report = {
            projectId: project.id,
            agentNodeId,
            initialVersion,
            externalVersion: externalSave.graphVersion,
            diskVersionAfterClose: disk.meta.graphVersion,
            recoveryCopyVersion: recovery?.meta.graphVersion ?? null,
            diskGoal: textOf(disk),
            recoveryGoal: recovery ? textOf(recovery) : null,
            diskWorkspaceProfile: disk.workspaceProfile,
            recoveryWorkspaceProfile: recovery?.workspaceProfile ?? null,
            recoveryCopyExists: !!recovery,
            modelCalls,
            externalHttpRequests,
            taskStateBeforeRestart: taskRow.state,
            taskDecisionsBeforeRestart: taskRow.decisions,
            checks: {
              realAgentRuntimeWasRunningAtClose: taskRow.state === 'running' && taskRow.decisions === 1,
              externalGraphVersionWasPreserved: disk.meta.graphVersion === externalSave.graphVersion,
              localEditWasSavedToRecoveryCopy: textOf(disk) === '并发工作台目标 v2' && !!recovery && textOf(recovery) === '本地未保存目标 v3',
              workspaceEditWasPresentInCanonicalAndRecovery: disk.workspaceProfile?.visibleNodeTypeIds.join(',') === 'agent,text' && recovery?.workspaceProfile?.visibleNodeTypeIds.join(',') === 'agent,text',
              syncConflictRecoveryCopyCreated: !!recovery,
              oneDeterministicModelCallNoToolDispatch: modelCalls === 1,
              realSupplierAndExternalHttpCalls: externalHttpRequests.length
            }
          }
          if (Object.values(report.checks).some((check) => check !== true && check !== 0))
            throw new Error('REC09_CLOSE_CONFLICT_ASSERTION_FAILED')
          fs.writeFileSync(
            join(directory, 'agent-close-state.json'),
            JSON.stringify({ projectId: project.id, agentNodeId, initialVersion })
          )
          void task
          result = report
          return
        }
        stage = 'agent-reopen-inspect'
        const state = prior as { projectId: string; agentNodeId: string; initialVersion: number }
        let modelCalls = 0
        const desktop = {
          ledger: new FlowCommandLedger(getDb(), openProject),
          isActive: (projectId: string): boolean => projectId === state.projectId,
          deliver: async (): Promise<void> => {
            throw new Error('REC09_UNEXPECTED_TOOL_DISPATCH')
          }
        }
        const host = new FlowAgentDesktopHost(getDb(), openProject, desktop, async () => ({
          decide: async () => {
            modelCalls++
            throw new Error('REC09_RECOVERY_MUST_NOT_REPLAY_MODEL')
          }
        }))
        const interrupted = host.inspect({ projectId: state.projectId, nodeId: state.agentNodeId })
        const blocked = interrupted?.state === 'blocked' && interrupted.code === 'AGENT_SESSION_LOST'
        const beforeRestore = openProject(state.projectId)!
        const copy = readRecoveryCopy(state.projectId)
        if (!copy || !blocked) throw new Error('REC09_RECOVERY_OR_SESSION_STATE_MISSING')
        stage = 'recovery-choice-and-save-retry'
        const recoveryChoice = await active.webContents.executeJavaScript(
          `(()=>{const dialog=document.querySelector('[role="dialog"][aria-label="检测到未保存副本"]');const button=[...dialog?.querySelectorAll('button')??[]].find(item=>item.textContent?.trim()==='使用恢复副本');if(!button)return false;button.click();return true})()`
        ) as boolean
        if (!recoveryChoice) throw new Error('REC09_RECOVERY_CHOICE_BUTTON_MISSING')
        await waitFor(ready)
        const restored = openProject(state.projectId)!.meta.graphVersion
        const afterRestore = openProject(state.projectId)!
        const reopenedGoal = textOf(afterRestore, state.agentNodeId)
        const reopenedProfile = afterRestore.workspaceProfile
        await active.loadURL('http://127.0.0.1:5197')
        await waitFor(async () =>
          (await active.webContents.executeJavaScript(
            `(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;return editor?.getShape('${state.agentNodeId}')?.props.text==='本地未保存目标 v3'})()`
          )) as boolean
        )
        await waitFor(ready)
        const retryBaseVersion = openProject(state.projectId)!.meta.graphVersion
        await active.webContents.executeJavaScript(
          `(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;editor.updateShape({id:'${state.agentNodeId}',type:'node-card',props:{text:'恢复后重试保存 v4'}});await(await import('/src/canvas/flow-asset-actions.ts')).ensureCanvasSaved()})()`
        )
        await waitFor(async () => {
          const file = openProject(state.projectId)
          return !!file && file.meta.graphVersion > restored && textOf(file, state.agentNodeId) === '恢复后重试保存 v4'
        })
        const finalFile = openProject(state.projectId)!
        const finalGoal = textOf(finalFile, state.agentNodeId)
        const report = {
          projectId: state.projectId,
          task: interrupted,
          diskGoalBeforeRestore: textOf(beforeRestore, state.agentNodeId),
          recoveryGoalBeforeRestore: textOf(copy, state.agentNodeId),
          restoredVersion: restored,
          reopenedGoal,
          workspaceProfileAfterRestore: reopenedProfile,
          retryVersion: finalFile.meta.graphVersion,
          finalVersion: finalFile.meta.graphVersion,
          finalGoal,
          recoveryCopyRemoved: !readRecoveryCopy(state.projectId),
          modelCallsAfterRestart: modelCalls,
          externalHttpRequests,
          checks: {
            runningTaskSafelyMarkedInterrupted: blocked,
            originalTaskIdentityAndDecisionCountRetained: interrupted?.taskId === 'rec09-running-agent-task' && interrupted.decisions === 1,
            recoveryRestoreUsedPublicIpc: restored === beforeRestore.meta.graphVersion + 1,
            recoveryChoiceMadeThroughReopenDialog: recoveryChoice,
            restoredCanvasReopenedWithLocalLastEdit: reopenedGoal === '本地未保存目标 v3',
            workspaceProfilePreservedAfterRecovery: reopenedProfile?.visibleNodeTypeIds.join(',') === 'agent,text',
          retrySaveAcceptedAfterRestore: finalGoal === '恢复后重试保存 v4' && finalFile.meta.graphVersion === retryBaseVersion + 1,
            recoveryCopyConsumedAfterRestore: !readRecoveryCopy(state.projectId),
            modelNotReplayedOrToolDispatched: modelCalls === 0,
            realSupplierAndExternalHttpCalls: externalHttpRequests.length
          }
        }
        result = report
        if (Object.values(report.checks).some((check) => check !== true && check !== 0))
          throw new Error('REC09_REOPEN_RETRY_ASSERTION_FAILED')
        return
      }
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
            : 'SAVE_ACCEPTANCE_FAILED',
        ...(result && typeof result === 'object' && 'checks' in result ? { details: result } : {})
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
