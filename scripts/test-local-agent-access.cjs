/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, readFile, writeFile, rm, cp, readdir } = require('node:fs/promises')
const { resolve, join, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const AdmZip = require('adm-zip')
const { qaOutputPath } = require('./qa-output.cjs')
const key = () => `${Date.now()}:${randomUUID()}`
const installedRoot = process.env.CANVAS_LOCAL_AGENT_INSTALL_ROOT
const electron = installedRoot ? join(installedRoot,'canvas-studio.exe') : require('electron')
const appRoot = installedRoot ? join(installedRoot,'resources','app') : resolve('.')
const cliPath = join(appRoot,'out/main/local-agent.js')
async function runCli(directory,args,input) {
  const file = join(directory,`input-${randomUUID()}.json`)
  if(input) await writeFile(file,JSON.stringify(input))
  return await new Promise((resolveCall,reject)=>{
    const child=spawn(electron,[cliPath,...args,'--data-dir',directory,...(input?['--input-file',file]:[])],{
      env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true
    })
    let output=''; let error=''
    const timer=setTimeout(()=>{child.kill();reject(new Error('CLI_TIMEOUT'))},30000)
    child.stdout.on('data',chunk=>{output+=chunk})
    child.stderr.on('data',chunk=>{error=(error+chunk).slice(-1000)})
    child.once('error',reject)
    child.once('exit',code=>{clearTimeout(timer);try{resolveCall({code,response:JSON.parse(output)})}catch{reject(new Error(`CLI_INVALID_RESULT:${code}:${error}`))}})
  })
}
function check(ok,code){if(!ok)throw new Error(code)}
async function captureDesktop(app,file){
  const encoded=await app.evaluate(async({BrowserWindow})=>{
    const window=BrowserWindow.getAllWindows()[0]
    window.webContents.invalidate()
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(file,Buffer.from(encoded,'base64'))
}
;(async()=>{
  const directory=await mkdtemp(join(tmpdir(),'canvas-local-agent-desktop-'))
  const evidence=qaOutputPath(installedRoot?'qa/local-agent-access/installed-vertical-slice':'qa/local-agent-access/vertical-slice')
  await mkdir(evidence,{recursive:true})
  let app; let client; let transport
  const env={...process.env,CANVAS_DATA_DIR:directory};delete env.ELECTRON_RUN_AS_NODE
  const receipt={status:'running',mode:installedRoot?'installed':'source-build',checks:[]}
  try{
    app=await _electron.launch({executablePath:electron,args:[...(installedRoot?[]:[appRoot]),'--local-agent-access'],env})
    const page=await app.firstWindow()
    await page.waitForLoadState()
    await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.setTitle('[TEST] Local Agent Access')})
    for(let i=0;i<100;i++){
      try{await readFile(join(directory,'agent-access/connection.json'));break}catch{await new Promise(done=>setTimeout(done,200))}
    }
    const created=await runCli(directory,['project','create'],{input:{name:'Agent vertical slice'},idempotencyKey:key()})
    check(created.code===0,'CLI_CREATE_FAILED')
    const projectId=created.response.data.meta.id
    receipt.checks.push('CLI create')
    const duplicateExit=await new Promise((done,reject)=>{
      const child=spawn(electron,[...(installedRoot?[]:[appRoot]),'--local-agent-access'],{env,stdio:'ignore',windowsHide:true})
      const timer=setTimeout(()=>{child.kill();reject(new Error('DUPLICATE_DESKTOP_TIMEOUT'))},15000)
      child.once('error',reject)
      child.once('exit',code=>{clearTimeout(timer);done(code)})
    })
    check(duplicateExit===1,'SECOND_DESKTOP_OWNER_NOT_REJECTED')
    receipt.checks.push('second desktop on same data store rejected before creating a window')
    const nodeTypes=await runCli(directory,['node','type','list'])
    check(nodeTypes.code===0&&nodeTypes.response.data.nodes.length===31,'CLI_NODE_DIRECTORY_FAILED')
    receipt.checks.push('CLI node type list: 31 planned nodes')
    const repeated=await runCli(directory,['project','create'],{input:{name:'Agent vertical slice'},idempotencyKey:created.response.idempotencyKey})
    check(repeated.response.data.meta.id===projectId,'CREATE_DUPLICATED')
    const mcpEnv={...process.env,ELECTRON_RUN_AS_NODE:'1'}
    transport=new StdioClientTransport({command:electron,args:[cliPath,'mcp','serve','--stdio','--data-dir',directory],env:mcpEnv,stderr:'pipe'})
    client=new Client({name:'canvas-local-acceptance',version:'1.0.0'},{capabilities:{}})
    await client.connect(transport)
    const tools=await client.listTools()
    check(tools.tools.length===18&&!tools.tools.some(t=>/import|invoke|execute/.test(t.name)),'MCP_TOOL_DIRECTORY_INVALID')
    const queryFixture=await page.evaluate(async()=>{
      const connection=await window.api.models.saveConnection({id:'a14-connection',name:'A14 private connection',protocol:'openai-compatible',baseUrl:'https://a14-private.invalid',headers:{Authorization:'Bearer a14-fake-secret'},enabled:false})
      const model=await window.api.models.saveDefinition({id:'a14-model',connectionId:'a14-connection',modelId:'a14-model',name:'A14 private model',capabilities:[{operation:'text.generate',asynchronous:false,streaming:false,acceptedAssetKinds:[],producedAssetKinds:[],controls:{}}]})
      const resource=await window.api.createLibraryResource({title:'A14 query resource',formPreset:'prompt',components:[{role:'prompt',valueType:'text',text:'a14-private-prompt'}]})
      return {ok:connection.ok&&model.ok&&resource.ok,resourceId:resource.data?.id}
    })
    check(queryFixture.ok,'QUERY_UI_FIXTURE_FAILED')
    for (const [name,input] of [['model_list',{limit:1}],['library_search',{limit:1}],['diagnostics_summary',{}]]) {
      const mcp=await client.callTool({name,arguments:{input}})
      const cli=await runCli(directory,name.split('_'),{input})
      check(mcp.structuredContent.status==='completed'&&cli.response.status==='completed',`QUERY_FAILED:${name}`)
      if(name!=='diagnostics_summary') check(JSON.stringify(mcp.structuredContent.data)===JSON.stringify(cli.response.data),`QUERY_PARITY:${name}`)
      else check(mcp.structuredContent.data.available===true&&cli.response.data.available===true,'DIAGNOSTICS_NOT_AVAILABLE')
      if(name==='model_list') check(mcp.structuredContent.data.models[0]?.id==='a14-model'&&mcp.structuredContent.data.models[0]?.connectionEnabled===false,'MODEL_SHARED_FACT_MISMATCH')
      if(name==='library_search') check(mcp.structuredContent.data.items[0]?.id===queryFixture.resourceId,'LIBRARY_SHARED_FACT_MISMATCH')
      check(!/a14-private\.invalid|a14-fake-secret|a14-private-prompt/.test(JSON.stringify([mcp,cli])),'QUERY_CONTENT_LEAK')
    }
    const missingRun=await client.callTool({name:'run_get',arguments:{input:{projectId,taskId:'missing-task'}}})
    check(missingRun.structuredContent.error?.code==='NOT_FOUND','RUN_QUERY_SCOPE_INVALID')
    receipt.checks.push('A1.4 read-only model/library parity, diagnostic health and scoped missing run via real CLI/MCP')
    const same=await client.callTool({name:'project_create',arguments:{input:{name:'Agent vertical slice'},idempotencyKey:created.response.idempotencyKey}})
    check(same.structuredContent.data.meta.id===projectId,'CROSS_TRANSPORT_DUPLICATION')
    receipt.checks.push('MCP SDK initialize/list/call; cross-transport idempotency')
    const renamed=await client.callTool({name:'project_rename',arguments:{input:{projectId,name:'Agent renamed project',expectedGraphVersion:0},idempotencyKey:key()}})
    check(renamed.structuredContent.status==='completed','MCP_RENAME_FAILED')
    const saved=await runCli(directory,['project','save'],{input:{projectId,expectedGraphVersion:1},idempotencyKey:key()})
    check(saved.response.data.graphVersion===2,'CLI_SAVE_FAILED')
    const exported=await runCli(directory,['project','export'],{input:{projectId,expectedGraphVersion:2,fileName:'vertical-slice.canvasbundle'},idempotencyKey:key()})
    check(exported.response.status==='completed','CLI_EXPORT_FAILED')
    const zip=new AdmZip(exported.response.data.path)
    const bundled=JSON.parse(zip.readAsText('project.json'))
    check(bundled.meta.name==='Agent renamed project'&&bundled.meta.graphVersion===2,'BUNDLE_FACT_MISMATCH')
    receipt.checks.push('MCP rename → CLI save/export; bundle same revision/name')
    const uiRename=await page.evaluate(async id=>await window.api.renameProject({id,name:'UI renamed project'}),projectId)
    check(uiRename.ok&&uiRename.data.graphVersion===3,'CLOSED_UI_RENAME_NOT_VERSIONED')
    const stale=await runCli(directory,['project','save'],{input:{projectId,expectedGraphVersion:2},idempotencyKey:key()})
    check(stale.response.error.code==='REVISION_CONFLICT','UI_RENAME_STALE_EXTERNAL_WRITE_ACCEPTED')
    receipt.checks.push('closed UI rename shares snapshot transaction; stale external revision rejected')
    const openKey=key()
    const desktopOpen=await runCli(directory,['project','open'],{input:{projectId},idempotencyKey:openKey})
    check(desktopOpen.response.status==='completed'&&desktopOpen.response.data.opened,'AGENT_DESKTOP_OPEN_FAILED')
    await page.locator('.node-palette').waitFor({timeout:30000})
    const opened=await page.evaluate(async id=>await window.api.openProject(id),projectId)
    check(opened.ok&&opened.data.meta.name==='UI renamed project'&&opened.data.meta.graphVersion===3,'DESKTOP_READBACK_FAILED')
    await captureDesktop(app,join(evidence,'desktop-readback.png'))
    await page.getByRole('button',{name:'展开输入与 AI节点',exact:true}).click()
    await page.getByRole('button',{name:'添加文本节点',exact:true}).click()
    await page.locator('.node-text').first().dblclick()
    await page.locator('textarea.node-textarea').fill('private-a11-unsaved-text')
    await page.keyboard.press('Control+Enter')
    await page.waitForTimeout(1100)
    const baseline=await runCli(directory,['project','get'],{input:{projectId}})
    const activeUpdated=await client.callTool({name:'project_update',arguments:{input:{projectId,name:'A11 active project',expectedGraphVersion:baseline.response.data.meta.graphVersion},idempotencyKey:key()}})
    check(activeUpdated.structuredContent.status==='completed','ACTIVE_METADATA_UPDATE_FAILED')
    await page.getByText('A11 active project',{exact:true}).first().waitFor()
    const saveBaseline=await runCli(directory,['project','get'],{input:{projectId}})
    const activeSaved=await runCli(directory,['project','save'],{input:{projectId,expectedGraphVersion:saveBaseline.response.data.meta.graphVersion},idempotencyKey:key()})
    check(activeSaved.response.status==='completed','ACTIVE_SAVE_FAILED')
    const clockNow=Date.now()
    await page.clock.install({time:clockNow-60000})
    await page.clock.pauseAt(clockNow)
    await page.locator('.node-text').first().dblclick()
    await page.locator('textarea.node-textarea').fill('private-a11-latest-unsaved-text')
    await page.keyboard.press('Control+Enter')
    const preFlush=await runCli(directory,['project','get'],{input:{projectId}})
    const activeExport=await runCli(directory,['project','export'],{input:{projectId,expectedGraphVersion:preFlush.response.data.meta.graphVersion,fileName:'active-latest.canvasbundle'},idempotencyKey:key()})
    receipt.activeExport={status:activeExport.response.status,error:activeExport.response.error}
    check(activeExport.response.status==='completed','ACTIVE_EXPORT_FLUSH_FAILED')
    const latest=JSON.parse(new AdmZip(activeExport.response.data.path).readAsText('project.json'))
    check(JSON.stringify(latest).includes('private-a11-latest-unsaved-text')&&latest.meta.name==='A11 active project','ACTIVE_EXPORT_LOST_DIRTY_EDIT')
    check(latest.meta.graphVersion===activeExport.response.data.sourceGraphVersion,'ACTIVE_EXPORT_REVISION_MISMATCH')
    receipt.activeExport.sourceGraphVersion=latest.meta.graphVersion
    receipt.activeExport.latestUnsavedTextVerified=true
    await page.clock.resume()
    receipt.checks.push('Agent opens desktop; active MCP metadata update; export flushes unsaved UI text at acknowledged revision')
    const next=await runCli(directory,['project','create'],{input:{name:'Switch destination'},idempotencyKey:key()})
    const switched=await runCli(directory,['project','open'],{input:{projectId:next.response.data.meta.id},idempotencyKey:key()})
    check(switched.response.status==='completed','AGENT_PROJECT_SWITCH_FAILED')
    const returned=await runCli(directory,['project','open'],{input:{projectId},idempotencyKey:key()})
    check(returned.response.status==='completed','AGENT_PROJECT_REOPEN_FAILED')
    await page.getByText('private-a11-latest-unsaved-text',{exact:true}).first().waitFor()
    await captureDesktop(app,join(evidence,'a11-reopened-canvas.png'))
    receipt.checks.push('Agent switches projects after flush and reopens preserved UI text')
    const cloneBase=await runCli(directory,['project','get'],{input:{projectId}})
    const cloneKey=key()
    const cloneInput={input:{projectId,name:'A11 cloned slice',expectedGraphVersion:cloneBase.response.data.meta.graphVersion},idempotencyKey:cloneKey}
    const cloned=await runCli(directory,['project','clone'],cloneInput)
    check(cloned.response.status==='completed'&&cloned.response.data.meta.graphVersion===0,'AGENT_CLONE_FAILED')
    const cloneId=cloned.response.data.meta.id
    const cloneReplay=await runCli(directory,['project','clone'],cloneInput)
    check(cloneReplay.response.data.meta.id===cloneId,'CLONE_DUPLICATED')
    const clonePre=await runCli(directory,['project','delete','precheck'],{input:{projectId:cloneId}})
    check(clonePre.response.status==='completed'&&clonePre.response.data.blockers.length===0&&typeof clonePre.response.data.impactToken==='string','CLONE_PRECHECK_FAILED')
    const noConfirm=await runCli(directory,['project','delete'],{input:{projectId:cloneId},idempotencyKey:key()})
    check(noConfirm.response.error.code==='IMPACT_CONFIRM_REQUIRED','DELETE_WITHOUT_CONFIRM_ACCEPTED')
    const forged=await runCli(directory,['project','delete'],{input:{projectId:cloneId,impactToken:`${'9'.repeat(13)}.${'0'.repeat(64)}`},idempotencyKey:key()})
    check(forged.response.error.code==='IMPACT_TOKEN_INVALID','FORGED_TOKEN_ACCEPTED')
    const deleteKey=key()
    const deleted=await runCli(directory,['project','delete'],{input:{projectId:cloneId,impactToken:clonePre.response.data.impactToken},idempotencyKey:deleteKey})
    check(deleted.response.status==='completed'&&deleted.response.data.deleted===true,'AGENT_DELETE_FAILED')
    const deleteReplay=await runCli(directory,['project','delete'],{input:{projectId:cloneId,impactToken:clonePre.response.data.impactToken},idempotencyKey:deleteKey})
    check(deleteReplay.response.data.deleted===true,'DELETE_RECEIPT_LOST')
    const gone=await runCli(directory,['project','get'],{input:{projectId:cloneId}})
    check(gone.response.error.code==='NOT_FOUND','DELETED_STILL_LISTED')
    const originalAlive=await runCli(directory,['project','get'],{input:{projectId}})
    check(originalAlive.response.status==='completed'&&originalAlive.response.data.meta.id===projectId,'SOURCE_PROJECT_HARMED')
    receipt.checks.push('CLI clone at flushed revision; precheck token guards; confirmed delete with durable receipt')
    await client.close();client=undefined
    await app.close();app=undefined
    const offline=await runCli(directory,['status'])
    check(offline.response.error.code==='APP_NOT_RUNNING','OFFLINE_NOT_REJECTED')
    app=await _electron.launch({executablePath:electron,args:[...(installedRoot?[]:[appRoot]),'--local-agent-access'],env})
    const reopenedPage=await app.firstWindow();await reopenedPage.waitForLoadState()
    await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.setTitle('[TEST] Local Agent Access Reopen')})
    for(let i=0;i<100;i++){
      try{await readFile(join(directory,'agent-access/connection.json'));break}catch{await new Promise(done=>setTimeout(done,200))}
    }
    const replay=await runCli(directory,['project','create'],{input:{name:'Agent vertical slice'},idempotencyKey:created.response.idempotencyKey})
    check(replay.response.data.meta.id===projectId,'RESTART_RECEIPT_LOST')
    await app.close();app=undefined
    receipt.checks.push('offline error + durable receipt after app restart')
    const events=[]
    async function scan(path){for(const item of await readdir(path,{withFileTypes:true})){const target=join(path,item.name);if(item.isDirectory())await scan(target);else if(item.name.endsWith('.jsonl')){for(const line of (await readFile(target,'utf8')).split('\n'))if(line.trim())events.push(JSON.parse(line))}}}
    await scan(join(directory,'diagnostics'))
    const starts=events.filter(e=>e.event==='agent.access.started')
    check(starts.length>=5,'ACCESS_LOGS_MISSING')
    for(const start of starts)check(events.filter(e=>e.traceId===start.traceId&&['agent.access.completed','agent.access.failed','agent.access.unknown'].includes(e.event)).length===1,'DUPLICATE_OR_MISSING_TERMINAL')
    check(!['Agent renamed project','UI renamed project','A11 active project','private-a11-latest-unsaved-text','A11 cloned slice','A14 private connection','A14 private model','a14-private.invalid','a14-fake-secret','a14-private-prompt'].some(value=>JSON.stringify(events).includes(value)),'LOG_CONTENT_LEAK')
    await cp(join(directory,'diagnostics'),join(evidence,'diagnostics'),{recursive:true})
    receipt.checks.push('actual JSONL lifecycle + content redaction')
    receipt.status='passed'
  }catch(error){receipt.status='failed';receipt.error=String(error.message);throw error}
  finally{
    if(client)await client.close().catch(()=>{});if(transport)await transport.close().catch(()=>{});if(app)await app.close().catch(()=>{})
    if(receipt.status==='failed')await cp(join(directory,'diagnostics'),join(evidence,'failed-diagnostics'),{recursive:true}).catch(()=>{})
    await writeFile(join(evidence,'report.json'),JSON.stringify(receipt,null,2))
    if(resolve(directory,'..')===resolve(tmpdir())&&basename(directory).startsWith('canvas-local-agent-desktop-'))await rm(directory,{recursive:true,force:true})
  }
  process.stdout.write(`Local Agent desktop acceptance passed: ${evidence}\n`)
})().catch(error=>{process.stderr.write(String(error.message)+'\n');process.exitCode=1})
