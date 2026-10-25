/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { mkdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { launchQaBrowser } = require('./qa-browser.cjs')
const { qaOutputPath } = require('./qa-output.cjs')
;(async () => {
  const browser = await launchQaBrowser()
  const evidence = qaOutputPath('qa/local-reliability/edit-restore-diagnostics')
  await mkdir(evidence, { recursive: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5194')
    await page.locator('.node-palette').waitFor()
    const report = await page.evaluate(async () => {
      document.title = '[TEST] Local consistency and recovery'
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const engine = await import('/src/engine/executor.ts')
      const graph = await import('/src/canvas/graph.ts')
      const { getNodePorts, getNodeType } = await import('/src/nodes/registry.tsx')
      const recovery = await import('/src/canvas/snapshot-restore.ts')
      const events = []
      window.api.reportDiagnosticsEvents = async ({ events: batch }) => { events.push(...batch); return { ok: true, data: { accepted: batch.length } } }
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      for (const [id, type, x, text, config] of [
        ['shape:l2-text','text',150,'first input',''],
        ['shape:l2-processor','processor',560,'',JSON.stringify({operation:'template',template:'processed:{{value}}'})],
        ['shape:l2-code','code',970,'',JSON.stringify({source:'async function main(args) { return args.input + ":code" }',inputName:'input',inputType:'string',outputType:'string',outputMode:'single'})]
      ]) editor.createShape({id,type:'node-card',x,y:170,props:{nodeType:type,text,config}})
      const code = editor.getShape('shape:l2-code')
      const input = getNodePorts(getNodeType('code'),code).in.find(port=>port.type==='text')
      if (!graph.createEdge(editor,{shapeId:'shape:l2-text',portId:'out-text'},{shapeId:'shape:l2-processor',portId:'in-value'})) throw new Error('TEXT_EDGE')
      if (!graph.createEdge(editor,{shapeId:'shape:l2-processor',portId:'out-value'},{shapeId:code.id,portId:input.id})) throw new Error('CODE_EDGE')
      const output = () => String(editor.getShape(code.id).meta.nodeResult)
      await engine.runWorkflow(editor,'demo',[])
      const initial = output()
      if (!initial.includes('processed:first input:code')) throw new Error('INITIAL_RESULT:'+initial)
      editor.updateShape({id:'shape:l2-text',type:'node-card',props:{text:'edited input'}})
      const confirmStore = (await import('/src/stores/confirm.ts')).useConfirmStore
      const originalConfirm = confirmStore.getState().confirm
      confirmStore.setState({confirm: async () => true})
      try { await engine.runWorkflowForNodes(editor,'demo',[],[code.id]) } finally { confirmStore.setState({confirm: originalConfirm}) }
      const edited = output()
      if (!edited.includes('processed:edited input:code')) throw new Error('EDIT_RESULT:'+edited)
      const middle = editor.getShape('shape:l2-processor')
      const pinned = JSON.stringify({version:1,outputs:{'out-value':{kind:'text',text:'fixed prior result'}}})
      editor.updateShape({id:middle.id,type:'node-card',meta:{...middle.meta,pinnedOutput:pinned,nodeRun:{runId:'failed-retry',status:'failed',startedAt:1,inputs:{}}}})
      const saved = JSON.parse(JSON.stringify(editor.store.getStoreSnapshot('document')))
      editor.store.loadStoreSnapshot(saved)
      recovery.verifyRestoredSnapshot(saved,editor.store.getStoreSnapshot('document'))
      await engine.runNodeManually(editor,'demo',[],code.id)
      const fixed = output()
      if (!fixed.includes('fixed prior result:code')) throw new Error('FIXED_RESULT:'+fixed)
      const current = JSON.parse(JSON.stringify(editor.store.getStoreSnapshot('document')))
      const observations = []
      let count = 0
      const restored = await recovery.restoreSnapshotSafely({target:saved,current,
        prepare:snapshot=>editor.store.migrateSnapshot(snapshot),listAvailableMedia:async()=>new Set(),
        confirm:async()=>true,saveCheckpoint:async()=>{},isCurrent:()=>true,isUnchanged:()=>true,
        apply:snapshot=>{editor.store.loadStoreSnapshot(snapshot);if(++count===1)editor.updateShape({id:'shape:l2-text',type:'node-card',props:{text:'corrupted restoration'}})},
        verify:snapshot=>recovery.verifyRestoredSnapshot(snapshot,editor.store.getStoreSnapshot('document')),
        observe:event=>observations.push(event)})
      if(restored.rollback!=='succeeded')throw new Error('ROLLBACK_NOT_VERIFIED:'+JSON.stringify(restored))
      recovery.verifyRestoredSnapshot(current,editor.store.getStoreSnapshot('document'))
      const unpinnedMeta = {...editor.getShape(middle.id).meta}
      unpinnedMeta.pinnedOutput = null
      editor.updateShape({id:middle.id,type:'node-card',meta:unpinnedMeta})
      const rejected = await engine.runNodeManually(editor,'demo',[],code.id)
      if(rejected.status!=='failed')throw new Error('UNPINNED_FAILED_RESULT_EXPOSED')
      editor.store.loadStoreSnapshot(current)
      delete window.__localL2
      window.__localL2={events}
      await (await import('/src/engine/diagnosticsReporter.ts')).drainDiagnosticsEvents()
      editor.setCamera({x:0,y:0,z:0.8},{immediate:true})
      return {initial,edited,fixed,restored,observations,eventCount:events.length}
    })
    assert.equal(report.restored.rollback, 'succeeded')
    await page.screenshot({ path: join(evidence, 'chain-and-recovery.png') })
    await page.evaluate(async () => {
      const moduleSource = await (await fetch('/src/canvas/RunTimeline.tsx')).text()
      const reactPath = moduleSource.match(/"([^"]+\/react\.js[^"]*)"/)[1]
      const React = (await import(reactPath)).default
      const mainModule = await (await fetch('/src/main.tsx')).text()
      const domPath = mainModule.match(/"([^"]+\/react-dom_client\.js[^"]*)"/)[1]
      const {createRoot} = (await import(domPath)).default
      const {RunTimeline} = await import('/src/canvas/RunTimeline.tsx')
      const failures=window.__localL2.events.filter(event=>event.event==='node.failed')
      if(!failures.length)throw new Error('ACTUAL_FAILURE_EVENT_MISSING')
      window.api.queryDiagnostics=async()=>({ok:true,data:{events:failures,truncated:true,badLines:1}})
      const host=document.createElement('div');host.id='local-diagnostic-proof';Object.assign(host.style,{position:'fixed',right:'20px',top:'90px',width:'500px',padding:'20px',background:'#222',zIndex:'99999'});document.body.append(host)
      createRoot(host).render(React.createElement(RunTimeline,{traceId:'local-failure-trace'}))
    })
    await page.locator('#local-diagnostic-proof').getByText(/已截断/).waitFor()
    assert.ok(await page.locator('#local-diagnostic-proof li').count())
    await page.screenshot({path:join(evidence,'partial-diagnostic-timeline.png')})
    await writeFile(join(evidence,'report.json'),JSON.stringify({status:'passed',...report},null,2))
    process.stdout.write('Local consistency: text/processor/code edit and scoped execution, pinned output reopen, content rollback and partial diagnostic timeline passed.\n')
  } finally {await browser.close()}
})().catch(error=>{process.stderr.write(String(error));process.exitCode=1})
