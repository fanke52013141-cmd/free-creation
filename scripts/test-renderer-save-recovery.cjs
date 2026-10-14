/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const {spawn}=require('node:child_process')
const {mkdtemp,mkdir,readFile,writeFile,cp,rm,readdir}=require('node:fs/promises')
const {tmpdir}=require('node:os')
const {join,resolve,basename,dirname}=require('node:path')
async function clean(directory){if(resolve(directory,'..')!==resolve(tmpdir())||!basename(directory).startsWith('canvas-save-crash-'))throw new Error('SAVE_CLEANUP_REJECTED');await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:250})}
;(async()=>{
  const evidence=resolve('qa/c4-import-renderer-20261014/renderer')
  await mkdir(evidence,{recursive:true})
  const server=spawn(process.execPath,[join(dirname(require.resolve('vite/package.json')),'bin/vite.js'),'--config','vite.browser.config.ts','--host','127.0.0.1','--port','5197','--strictPort'],{stdio:'ignore',windowsHide:true})
  const reports=[]
  try {
    const deadline=Date.now()+30000
    while(true){if(server.exitCode!==null)throw new Error('SAVE_VITE_UNAVAILABLE');try{if((await fetch('http://127.0.0.1:5197')).ok)break}catch{/* Bounded readiness. */}if(Date.now()>deadline)throw new Error('SAVE_VITE_TIMEOUT');await new Promise(done=>setTimeout(done,250))}
    for(const boundary of ['unsent','before-save','after-save','failed-save']){
      const directory=await mkdtemp(join(tmpdir(),'canvas-save-crash-'))
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
        reports.push({...report.result,starts,terminals,diagnosticRedaction:true})
      } finally {await clean(directory)}
    }
    await writeFile(join(evidence,'results.json'),JSON.stringify({reports,boundary:'real hidden renderer crash, public save IPC and project repository; isolated data; no model calls'},null,2))
    process.stdout.write('Renderer save recovery: unsent, accepted before save, committed before reply, write failure, reload and continued editing passed.\n')
  }finally{server.kill()}
})().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1})
