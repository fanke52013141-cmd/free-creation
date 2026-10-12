// Opt-in real desktop bridge acceptance. Isolated data, hidden windows, no model requests.
import { app, BrowserWindow } from 'electron'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { registerFlowCommandsIpc } from '../ipc/flow-commands.ipc'
import { registerFlowAssetsIpc } from '../ipc/flow-assets.ipc'
import { registerProjectIpc } from '../ipc/project.ipc'
import { registerLibraryIpc } from '../ipc/library.ipc'
import { registerMediaIpc } from '../ipc/media.ipc'
import { registerWorkspaceStateIpc } from '../ipc/workspace-state.ipc'
import { registerGatewayIpc } from '../ipc/gateway.ipc'
import { registerModelIpc } from '../ipc/models.ipc'
import { registerDiagnosticsIpc, setDiagnosticsService } from '../ipc/diagnostics.ipc'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { createDesktopModelRuntime } from '../model-host/runtime'
import { createProject } from '../store/projects.repo'
import { closeDb, getDb, setSetting } from '../store/db'
import { initDiagnosticsService } from '../diagnostics/service'
import { setGatewayEventSink } from '../diagnostics/gateway-events'

const arg = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const directory = arg('commands-directory'),
  phase = arg('commands-phase'),
  url = arg('commands-url')
if (
  !directory ||
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-flow-commands-') ||
  !['execute', 'reopen'].includes(phase ?? '') ||
  url !== 'http://127.0.0.1:5198'
) {
  app.exit(2)
} else {
  process.env.CANVAS_DATA_DIR = directory
  app.setPath('userData', directory)
  app.on('window-all-closed', () => {
    /* Write evidence before exit. */
  })
  void app.whenReady().then(async () => {
    const diagnostics = await initDiagnosticsService({ dataDir: directory, disableTimers: true })
    setGatewayEventSink(diagnostics)
    setDiagnosticsService(diagnostics)
    let window: BrowserWindow | null = null,
      foreign: BrowserWindow | null = null
    let failed = false
    let report: unknown = null
    let stage = 'initialize'
    try {
      const database = getDb()
      const statePath = join(directory, 'bridge-state.json')
      const projectId =
        phase === 'execute'
          ? createProject('测试：生产命令桥').id
          : JSON.parse(readFileSync(statePath, 'utf8')).projectId
      setSetting('lastProjectId', projectId)
      registerProjectIpc()
      registerLibraryIpc()
      registerMediaIpc()
      registerWorkspaceStateIpc()
      registerDiagnosticsIpc()
      const host = new SqliteModelHost(database)
      registerModelIpc(host, createDesktopModelRuntime(host))
      window = new BrowserWindow({
        show: false,
        width: 1900,
        height: 1050,
        webPreferences: {
          preload: resolve(__dirname, '../preload/index.js'),
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false
        }
      })
      const active = window
      registerGatewayIpc(active)
      registerFlowAssetsIpc(() => active)
      registerFlowCommandsIpc(() => active)
      await active.loadURL(url)
      stage = 'canvas-ready'
      const readyDeadline = Date.now() + 60000
      while (
        !(await active.webContents.executeJavaScript(
          "import('/src/stores/editor.ts').then(m=>!!m.useEditorStore.getState().editor)"
        ))
      ) {
        if (Date.now() > readyDeadline) throw new Error('FIXTURE_CANVAS_NOT_READY')
        await new Promise((done) => setTimeout(done, 100))
      }
      if (phase === 'execute') {
        stage = 'execute-fixture'
        report = await active.webContents.executeJavaScript(`(async () => {
          const projectId = ${JSON.stringify(projectId)}
          window.__bridgePhase='create'
          const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
          const { ensureCanvasSaved, placeFlowAsset } = await import('/src/canvas/flow-asset-actions.ts')
          const { deriveGraph, createEdge } = await import('/src/canvas/graph.ts')
          const { runNodeManually } = await import('/src/engine/executor.ts')
          const bridge = await import('/src/engine/flow-command-bridge.ts')
          const value = (response) => { if (!response.ok) throw new Error(response.error.code); return response.data }
          const waitReceipt = async (commandId) => {
            for (let index=0; index<200; index++) {
              const receipt=value(await window.api.lookupFlowCommand({projectId,commandId}))
              if (!['pending','unknown'].includes(receipt.state)) return receipt
              await new Promise(done=>setTimeout(done,50))
            }
            throw new Error('FIXTURE_RECEIPT_TIMEOUT')
          }
          editor.createShape({id:'shape:bridge-source',type:'node-card',x:100,y:100,props:{nodeType:'text',title:'人工材料',text:'private-fixture-body-v1'}})
          editor.createShape({id:'shape:bridge-target',type:'node-card',x:1050,y:100,props:{nodeType:'processor',title:'处理资产',config:JSON.stringify({operation:'template',template:'结果：{{value}}'})}})
          editor.createShape({id:'shape:bridge-orphan',type:'node-card',x:1050,y:450,props:{nodeType:'processor',title:'等待核对',config:JSON.stringify({operation:'pass',fallback:'private-fixture-fallback'})}})
          editor.createShape({id:'shape:bridge-agent',type:'node-card',x:100,y:450,props:{nodeType:'agent',title:'执行 Agent',text:'private-fixture-goal',config:JSON.stringify({schemaVersion:1,role:'specialist',interactionMode:'autonomous',skills:[],tools:[],allowedNodeIds:['shape:bridge-target','shape:bridge-orphan'],maxSteps:8,relations:[]})}})
          await ensureCanvasSaved()
          window.__bridgePhase='submit-asset'
          let file=value(await window.api.openProject(projectId))
          const asset=value(await window.api.submitFlowAsset({projectId,nodeId:'shape:bridge-source',portId:'out-text',submissionId:'bridge-source-v1',expectedGraphVersion:file.meta.graphVersion,traceId:'trace-source',spanId:'span-source'}))
          const pinnedId=placeFlowAsset(editor,asset,'shape:bridge-source')
          if (!createEdge(editor,{shapeId:pinnedId,portId:'out-text'},{shapeId:'shape:bridge-target',portId:'in-value'})) throw new Error('FIXTURE_EDGE_FAILED')
          editor.updateShape({id:'shape:bridge-source',type:'node-card',props:{text:'private-fixture-body-v2'}})
          await ensureCanvasSaved()
          const manual=await runNodeManually(editor,projectId,[],'shape:bridge-target')
          window.__bridgePhase='manual-run'
          if(manual.status!=='done') throw new Error('FIXTURE_MANUAL_FAILED')
          const manualRecord=structuredClone(editor.getShape('shape:bridge-target').meta.nodeRun)
          const manualValue=editor.getShape('shape:bridge-target').meta.nodeResult
          await ensureCanvasSaved()
          const command=async (commandId, targetNodeId='shape:bridge-target') => {
            await ensureCanvasSaved(); const saved=value(await window.api.openProject(projectId))
            return {schemaVersion:1,kind:'node.execute',commandId,projectId,taskId:'bridge-task',agentNodeId:'shape:bridge-agent',targetNodeId,contractVersion:1,
              expectedSemanticRevision:await bridge.canvasSemanticRevision(editor,saved),inputs:targetNodeId==='shape:bridge-target'?[{targetPortId:'in-value',assets:[asset.ref]}]:[],traceId:'trace-'+commandId,spanId:'span-'+commandId}
          }
          const first=await command('bridge-first')
          window.__bridgePhase='dispatch'
          value(await window.api.dispatchFlowCommand(first))
          const receipt=await waitReceipt(first.commandId)
          window.__bridgePhase='parity'
          const commandRecord=editor.getShape('shape:bridge-target').meta.nodeRun
          if(receipt.state!=='committed'||manualValue!==editor.getShape('shape:bridge-target').meta.nodeResult||manualRecord.inputFingerprint!==receipt.inputFingerprint||JSON.stringify(manualRecord.inputs)!==JSON.stringify(commandRecord.inputs)) throw new Error('FIXTURE_PARITY_FAILED')
          const committedAsset=value(await window.api.readFlowAsset({projectId,versionId:receipt.outputRefs[0].versionId}))
          if(JSON.stringify(committedAsset.value)!==manualValue) throw new Error('FIXTURE_OUTPUT_ASSET_FAILED')
          const count=editor.getShape('shape:bridge-target').meta.nodeRunHistory.length
          window.__bridgePhase='replay'
          const replay=value(await window.api.dispatchFlowCommand({...first,traceId:'retry-trace'}))
          if(replay.state!=='committed'||editor.getShape('shape:bridge-target').meta.nodeRunHistory.length!==count) throw new Error('FIXTURE_REPLAY_FAILED')
          const conflict=await window.api.dispatchFlowCommand({...first,taskId:'other-task'})
          if(conflict.ok||conflict.error.code!=='FLOW_COMMAND_CONFLICT') throw new Error('FIXTURE_CONFLICT_FAILED')
          const invalid=await window.api.prepareFlowCommand({...first,body:'fake-secret-key'})
          if(invalid.ok) throw new Error('FIXTURE_BODY_ACCEPTED')
          editor.updateShape({id:'shape:bridge-target',type:'node-card',x:1100})
          window.__bridgePhase='position'
          await ensureCanvasSaved()
          const saved=value(await window.api.openProject(projectId))
          if(await bridge.canvasSemanticRevision(editor,saved)!==first.expectedSemanticRevision) throw new Error('FIXTURE_POSITION_REVISION_FAILED')
          editor.updateShape({id:'shape:bridge-target',type:'node-card',props:{config:JSON.stringify({operation:'pick',path:'missing'})}})
          await ensureCanvasSaved()
          const stale=await window.api.dispatchFlowCommand({...first,commandId:'bridge-stale'})
          if(stale.ok||stale.error.code!=='FLOW_REVISION_CONFLICT') throw new Error('FIXTURE_REVISION_FAILED')
          const manualFailed=await runNodeManually(editor,projectId,[],'shape:bridge-target')
          window.__bridgePhase='failure'
          const fail=await command('bridge-failed')
          value(await window.api.dispatchFlowCommand(fail))
          const failed=await waitReceipt(fail.commandId)
          if(manualFailed.status!=='failed'||failed.state!=='failed'||failed.outputRefs.length) throw new Error('FIXTURE_FAILURE_PARITY_FAILED')
          editor.updateShape({id:'shape:bridge-target',type:'node-card',props:{config:JSON.stringify({operation:'template',template:'结果：{{value}}'})}})
          await ensureCanvasSaved()
          const unknown=await command('bridge-saved-unknown')
          window.__bridgePhase='cancel'
          const queue=await import('/src/engine/resource-queue.ts')
          queue.setResourceLimit('local',1)
          const release=await queue.acquireNodeResource({projectId,nodeId:'fixture-blocker',label:'fixture',resource:'local',cancel:()=>{}})
          const waitQueue=async()=>{for(let i=0;i<200;i++){const task=queue.useResourceQueue.getState().tasks.find(t=>t.key===projectId+'/shape:bridge-target'&&t.status==='queued');if(task)return task;await new Promise(done=>setTimeout(done,20))}throw new Error('FIXTURE_QUEUE_TIMEOUT')}
          const manualCancelPromise=runNodeManually(editor,projectId,[],'shape:bridge-target')
          ;(await waitQueue()).cancel()
          const manualCancel=await manualCancelPromise
          const cancel=await command('bridge-cancel')
          value(await window.api.dispatchFlowCommand(cancel))
          ;(await waitQueue()).cancel()
          const cancelled=await waitReceipt(cancel.commandId)
          release();queue.setResourceLimit('local',4)
          if(manualCancel.status!=='skipped'||cancelled.state!=='skipped'||cancelled.outputRefs.length)throw new Error('FIXTURE_CANCEL_PARITY_FAILED')
          window.__bridgePhase='unknown'
          const prepared=value(await window.api.prepareFlowCommand(unknown))
          if(prepared.state!=='ready') throw new Error('FIXTURE_GRANT_FAILED')
          await bridge.executeFlowCommandGrant(editor,projectId,[],prepared.grant,value(await window.api.openProject(projectId)))
          await ensureCanvasSaved()
          const orphan=await command('bridge-no-run','shape:bridge-orphan')
          value(await window.api.prepareFlowCommand(orphan))
          const snapshot=editor.store.getStoreSnapshot('document')
          return {projectId,first,unknown,orphan,historyCount:editor.getShape('shape:bridge-target').meta.nodeRunHistory.length,
            checks:['real desktop dispatch','manual/command value + fingerprint + asset source parity','saved immutable output receipt','same command replay has no effect','different intent rejected','body injection rejected','position allowed; semantic edit rejected','failed execution parity; no stale output','queued cancellation parity; no effect','saved-run pending; unsent pending'],nodeCount:deriveGraph(editor).nodes.length}
        })()`)
        writeFileSync(statePath, JSON.stringify(report))
        foreign = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: resolve(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false
          }
        })
        await foreign.loadURL('data:text/html,<title>foreign bridge</title>')
        const rejected = await foreign.webContents.executeJavaScript(
          `window.api.lookupFlowCommand(${JSON.stringify({ projectId, commandId: 'bridge-first' })})`
        )
        if (rejected.ok || rejected.error.code !== 'FLOW_SENDER_REJECTED')
          throw new Error('FIXTURE_FOREIGN_WINDOW_FAILED')
        report = { checks: [...(report as { checks: string[] }).checks, 'foreign window rejected'] }
      } else {
        const state = JSON.parse(readFileSync(statePath, 'utf8'))
        report = await active.webContents.executeJavaScript(`(async()=>{
          const state=${JSON.stringify(state)}
          const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
          const bridge=await import('/src/engine/flow-command-bridge.ts')
          const value=r=>{if(!r.ok)throw new Error(r.error.code);return r.data}
          const saved=value(await window.api.lookupFlowCommand({projectId:state.projectId,commandId:state.unknown.commandId}))
          const orphan=value(await window.api.lookupFlowCommand({projectId:state.projectId,commandId:state.orphan.commandId}))
          if(saved.state!=='unknown'||orphan.state!=='unknown')throw new Error('FIXTURE_UNKNOWN_RECOVERY_FAILED')
          const manualBlocked=await (await import('/src/engine/executor.ts')).runNodeManually(editor,state.projectId,[],'shape:bridge-target')
          if(manualBlocked.status!=='skipped')throw new Error('FIXTURE_MANUAL_OCCUPANCY_FAILED')
          await (await import('/src/canvas/flow-asset-actions.ts')).ensureCanvasSaved()
          const file=value(await window.api.openProject(state.projectId))
          const assetBlocked=await window.api.submitFlowAsset({projectId:state.projectId,nodeId:'shape:bridge-target',portId:'out-value',submissionId:'manual-unconfirmed',expectedGraphVersion:file.meta.graphVersion,traceId:'trace-blocked',spanId:'span-blocked'})
          if(assetBlocked.ok||assetBlocked.error.code!=='ASSET_SOURCE_OCCUPIED')throw new Error('FIXTURE_ASSET_OCCUPANCY_FAILED')
          const receipt=await bridge.reconcileFlowNodeCommand({projectId:state.projectId,commandId:state.unknown.commandId})
          if(receipt.state!=='committed'||editor.getShape('shape:bridge-target').meta.nodeRunHistory.length!==state.historyCount)throw new Error('FIXTURE_RECONCILE_FAILED')
          const unresolved=await bridge.reconcileFlowNodeCommand({projectId:state.projectId,commandId:state.orphan.commandId})
          if(unresolved.state!=='unknown')throw new Error('FIXTURE_ORPHAN_REPLAYED')
          const replay=value(await window.api.dispatchFlowCommand(state.unknown))
          if(replay.state!=='committed')throw new Error('FIXTURE_REOPEN_REPLAY_FAILED')
          return {checks:['new process pending -> unknown','manual execution and publication blocked by unknown occupancy','saved-run reconciliation without execution','absent saved run stays unknown','committed receipt replay after restart']}
        })()`)
      }
    } catch (error) {
      failed = true
      // Only static fixture codes; never print raw UI errors, model data or project snapshots.
      const code =
        error instanceof Error
          ? error.message.match(/\b(?:FIXTURE|FLOW|ASSET)_[A-Z_]+\b/)?.[0]
          : undefined
      let fixtureStage: unknown
      try {
        fixtureStage = await window?.webContents.executeJavaScript('window.__bridgePhase')
      } catch {
        fixtureStage = undefined
      }
      report = {
        code: code ?? 'FIXTURE_BRIDGE_FAILED',
        stage,
        fixtureStage: typeof fixtureStage === 'string' ? fixtureStage : undefined
      }
    } finally {
      foreign?.destroy()
      window?.destroy()
      await diagnostics.flushOnQuit()
      closeDb()
      writeFileSync(
        join(directory, `${phase}-report.json`),
        JSON.stringify({ status: failed ? 'failed' : 'pass', report })
      )
      app.exit(failed ? 1 : 0)
    }
  })
}
