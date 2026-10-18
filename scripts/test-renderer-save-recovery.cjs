/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const {spawn}=require('node:child_process')
const {qaOutputPath}=require('./qa-output.cjs')
const r09=process.argv.includes('--r09')
const r09AgentClose=process.argv.includes('--r09-agent-close-conflict')
const {mkdtemp,mkdir,readFile,writeFile,cp,rm,readdir}=require('node:fs/promises')
const {tmpdir}=require('node:os')
const {join,resolve,basename,dirname}=require('node:path')
async function clean(directory){if(resolve(directory,'..')!==resolve(tmpdir())||!basename(directory).startsWith('canvas-save-crash-'))throw new Error('SAVE_CLEANUP_REJECTED');await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:250})}
;(async()=>{
  if(r09&&r09AgentClose)throw new Error('SAVE_TEST_MODE_CONFLICT')
  const evidence=qaOutputPath(r09AgentClose?'qa/agent-comprehensive/run-20261017-rec09-running-close-conflict-v1':r09?'qa/r09-local-20261016/renderer':'qa/c4-import-renderer-20261014/renderer')
  await mkdir(evidence,{recursive:true})
  const server=spawn(process.execPath,[join(dirname(require.resolve('vite/package.json')),'bin/vite.js'),'--config','vite.browser.config.ts','--host','127.0.0.1','--port','5197','--strictPort'],{stdio:'ignore',windowsHide:true})
  const reports=[]
  let reusableDirectory
  try {
    const deadline=Date.now()+30000
    while(true){if(server.exitCode!==null)throw new Error('SAVE_VITE_UNAVAILABLE');try{if((await fetch('http://127.0.0.1:5197')).ok)break}catch{/* Bounded readiness. */}if(Date.now()>deadline)throw new Error('SAVE_VITE_TIMEOUT');await new Promise(done=>setTimeout(done,250))}
    for(const boundary of r09AgentClose?['agent-close-conflict','agent-close-conflict-reopen']:r09?['storage-retry']:['unsent','before-save','after-save','failed-save']){
      const directory=reusableDirectory||await mkdtemp(join(tmpdir(),'canvas-save-crash-'))
      if(r09AgentClose)reusableDirectory=directory
      try {
        const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
        const code=await new Promise((done,reject)=>{
          const child=spawn(require('electron'),[resolve('out/main/save-recovery.js'),`--save-directory=${directory}`,`--save-boundary=${boundary}`],{env,stdio:'ignore',windowsHide:true})
          const timer=setTimeout(()=>{child.kill();reject(new Error('SAVE_ELECTRON_TIMEOUT'))},180000)
          child.once('error',error=>{clearTimeout(timer);reject(error)})
          child.once('exit',code=>{clearTimeout(timer);done(code)})
        })
        const report=JSON.parse(await readFile(join(directory,'report.json'),'utf8'))
        const events=[]
        async function scan(path){for(const file of await readdir(path,{withFileTypes:true})){const target=join(path,file.name);if(file.isDirectory())await scan(target);else{const text=await readFile(target,'utf8');if(text.includes('private-save-'))throw new Error('SAVE_DIAGNOSTICS_REDACTION_FAILED');if(file.name.endsWith('.jsonl'))for(const line of text.trim().split('\n'))if(line.trim())events.push(JSON.parse(line))}}}
        await scan(join(directory,'diagnostics'))
        await mkdir(join(evidence,boundary),{recursive:true})
        await cp(join(directory,'diagnostics'),join(evidence,boundary,'diagnostics'),{recursive:true})
        await writeFile(join(evidence,boundary,'report.json'),JSON.stringify(report,null,2))
        if(code!==0||report.status!=='pass')throw new Error(`${boundary}:${report.result.code}`)
        const starts=events.filter(event=>event.event==='project.save.started').length
        const terminals=events.filter(event=>['project.save.completed','project.save.failed','project.save.conflict'].includes(event.event)).length
        if(!starts||starts!==terminals)throw new Error('SAVE_LIFECYCLE_UNPAIRED')
        if(events.some(event=>event.event==='model.request.started'))throw new Error('SAVE_UNEXPECTED_MODEL_REQUEST')
        if(boundary==='failed-save'&&!events.some(event=>event.event==='project.save.failed'))throw new Error('SAVE_FAILURE_LOG_MISSING')
        if(r09){
          for(const start of events.filter(e=>e.event==='project.save.started')){
            const ends=events.filter(e=>['project.save.completed','project.save.failed','project.save.conflict'].includes(e.event)&&e.traceId===start.traceId&&e.spanId===start.spanId)
            if(!start.traceId||!start.spanId||ends.length!==1)throw new Error('R09_SAVE_TRACE_UNPAIRED')
          }
          const failures=events.filter(e=>e.event==='project.save.failed')
          for(const phase of ['write-tmp','flush-tmp','promote-tmp','update-db'])if(!failures.some(e=>e.attributes.phase===phase&&e.attributes.backupUsed===true&&e.error.code==='STORAGE_WRITE_FAILED'))throw new Error('R09_SAVE_FAILURE_PHASE_MISSING')
          if(!failures.some(e=>e.attributes.operation==='workspace-profile'))throw new Error('R09_WORKSPACE_DIAGNOSTIC_MISSING')
          for(const name of ['disk-failure.png','disk-recovered.png'])await cp(join(directory,name),join(evidence,boundary,name))
        }
        if(r09AgentClose){
          if(boundary==='agent-close-conflict'&&(!events.some(event=>event.event==='project.save.conflict')||!events.some(event=>event.event==='project.save.completed'&&event.status==='success')))throw new Error('REC09_CONFLICT_OR_RECOVERY_SAVE_DIAGNOSTIC_MISSING')
          if(boundary==='agent-close-conflict-reopen'&&!events.some(event=>event.event==='project.save.completed'&&event.status==='success'))throw new Error('REC09_RESTORE_OR_RETRY_SAVE_DIAGNOSTIC_MISSING')
          for(const start of events.filter(event=>event.event==='project.save.started')){
            const ends=events.filter(event=>['project.save.completed','project.save.failed','project.save.conflict'].includes(event.event)&&event.traceId===start.traceId&&event.spanId===start.spanId)
            if(!start.traceId||!start.spanId||ends.length!==1)throw new Error('REC09_SAVE_TRACE_UNPAIRED')
          }
          if(boundary==='agent-close-conflict'&&events.filter(event=>event.event==='project.save.conflict').length!==1)throw new Error('REC09_SYNC_CONFLICT_COUNT_INVALID')
          if((report.result.externalHttpRequests||[]).length!==0)throw new Error('REC09_EXTERNAL_HTTP_REQUEST_OBSERVED')
          for(const privateText of ['本地未保存目标 v1','并发工作台目标 v2','本地未保存目标 v3','恢复后重试保存 v4'])if(events.some(event=>JSON.stringify(event).includes(privateText)))throw new Error('REC09_PRIVATE_AGENT_GOAL_LEAKED')
        }
        reports.push({...report.result,starts,terminals,diagnosticRedaction:true})
      } finally {if(!r09AgentClose)await clean(directory)}
    }
    await writeFile(join(evidence,'results.json'),JSON.stringify({reports,boundary:r09AgentClose?'real Electron Agent runtime with deterministic in-process model port, real hidden renderer beforeunload/save IPC, cross-process recovery prompt and public retry; isolated data; no provider/supplier/external HTTP calls': 'real hidden renderer crash, public save IPC and project repository; isolated data; no model calls'},null,2))
    process.stdout.write(r09AgentClose?'REC-09 Agent close conflict: running task, concurrent project/workspace edit, synchronous conflict recovery copy, second-process recovery choice and retry passed.\n':r09?'R09 renderer: repeated write/flush failures preserve backup, failed state, four renderer restarts, workspace save and explicit retry passed.\n':'Renderer save recovery: unsent, accepted before save, committed before reply, write failure, reload and continued editing passed.\n')
  }finally{server.kill();if(reusableDirectory)await clean(reusableDirectory)}
})().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1})
