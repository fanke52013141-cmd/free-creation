// Isolated desktop fixture; never loaded by the application entry point.
import type { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../store/db'

export function installParallelMediaSupplier(directory: string, phase: string): void {
  const db = getDb()
  if (phase === 'execute') {
    db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?)').run(
      'parallel-test',
      '隔离并行视频',
      'seedance',
      'https://ark.cn-beijing.volces.com/api/v3',
      'private-c3-parallel-key',
      JSON.stringify([
        {
          id: 'doubao-seedance-2-0',
          name: '隔离视频',
          modality: 'video',
          operations: ['video.generate']
        }
      ]),
      0
    )
    for (const key of ['parallel-posts', 'parallel-downloads'])
      db.prepare('INSERT INTO settings VALUES (?,?)').run(key, '0')
  }
  const native = globalThis.fetch
  let releaseFirst: (() => void) | undefined
  globalThis.fetch = async (url, options) => {
    const address = String(url)
    if (address.startsWith('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')) {
      if (options?.method === 'POST') {
        const count =
          Number(
            (
              db.prepare("SELECT value FROM settings WHERE key='parallel-posts'").get() as {
                value: string
              }
            ).value
          ) + 1
        if (count > 4 || phase !== 'execute') throw new Error('PARALLEL_DUPLICATE_POST')
        db.prepare("UPDATE settings SET value=? WHERE key='parallel-posts'").run(String(count))
        // Sequential dispatch cannot pass this barrier: both POSTs must be in flight.
        if (count % 2 === 1) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('PARALLEL_NOT_CONCURRENT')), 10000)
            releaseFirst = () => {
              clearTimeout(timer)
              resolve()
            }
          })
        } else {
          if (!releaseFirst) throw new Error('PARALLEL_BARRIER_MISSING')
          releaseFirst()
          releaseFirst = undefined
        }
        return new Response(JSON.stringify({ id: `parallel-${count}` }), {
          headers: { 'Content-Type': 'application/json' }
        })
      }
      const id = address.split('/').at(-1)!,
        index = Number(id.split('-').at(-1))
      return new Response(
        JSON.stringify({
          id,
          status: index > 2 || (phase === 'execute' && index === 2) ? 'unknown' : 'succeeded',
          content: { video_url: `https://fixture.example/parallel/${index}` }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (address.startsWith('https://fixture.example/parallel/')) {
      db.prepare(
        "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='parallel-downloads'"
      ).run()
      return new Response(readFileSync(join(directory, 'parallel.mp4')))
    }
    return native(url, options)
  }
}

export async function acceptParallelMedia(input: {
  window: BrowserWindow
  directory: string
  projectId: string
  phase: string
  common: string
}): Promise<unknown> {
  const { window, directory, phase, common } = input
  const report = await window.webContents.executeJavaScript(`(async()=>{${common}
    const read=async(id)=>value(await window.api.inspectFlowAgent({projectId,nodeId:id}));
    const run=async(id)=>{const current=await read(id);if(current)editor.updateShape({id,type:'node-card',meta:{...editor.getShape(id).meta,agentTask:JSON.stringify(current)}});await ensureCanvasSaved();const result=await(await import('/src/engine/executor.ts')).runNodeManually(editor,projectId,(await import('/src/stores/gateway.ts')).useGatewayStore.getState().providers,id);await ensureCanvasSaved();const task=await read(id);if(task?.state==='completed'&&result.status!=='done')throw new Error('PARALLEL_PROJECTION_FAILED');return task;};
    const create=async(prefix,y)=>{
      const id=(suffix)=>'shape:'+prefix+suffix;
      const config=(role,ids)=>JSON.stringify({schemaVersion:1,role,interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:role==='coordinator'?'agent.dispatch':'node.execute',version:'1'}],allowedNodeIds:ids,maxSteps:12,...(role==='coordinator'?{maxParallelTasks:2}:{}),relations:role==='coordinator'?[{relationId:prefix+'state',kind:'observes',sourceNodeId:id('main'),targetNodeId:id('state')}]:[]});
      editor.createShape({id:id('main'),type:'node-card',x:100,y,props:{nodeType:'agent',title:'两路视频主控',text:'并行生成两个独立视频，交付第二路固定成果',config:config('coordinator',[id('agent1'),id('agent2')])}});
      editor.createShape({id:id('prompt'),type:'node-card',x:100,y:y+600,props:{nodeType:'text',title:'共同材料',text:'private-c3-parallel-prompt'}});
      for(const n of [1,2]){
        editor.createShape({id:id('agent'+n),type:'node-card',x:530+(n-1)*430,y,props:{nodeType:'agent',title:'视频专业 '+n,text:'生成一次独立视频并交付固定成果',config:config('specialist',[id('video'+n)])}});
        editor.createShape({id:id('video'+n),type:'node-card',x:530+(n-1)*430,y:y+600,props:{nodeType:'video',title:'视频 '+n,config:JSON.stringify({mode:'text',modelKey:'parallel-test::doubao-seedance-2-0',params:{}})}});
      }
      editor.createShape({id:id('state'),type:'node-card',x:1390,y,props:{nodeType:'state-machine',title:'并行流程状态',config:JSON.stringify({schemaVersion:1,initialState:'draft',states:['draft','working','waiting','completed'],transitions:[{from:'draft',event:'flow.started',to:'working'},...['agent.dispatched','agent.completed','human.wait','flow.paused','flow.completed'].map(event=>({from:'working',event,to:event==='flow.completed'?'completed':['human.wait','flow.paused'].includes(event)?'waiting':'working'})),{from:'waiting',event:'human.continue',to:'working'}],relations:[]})}});
      const {createEdge}=await import('/src/canvas/graph.ts');for(const n of [1,2])for(const target of [id('agent'+n),id('video'+n)])if(!createEdge(editor,{shapeId:id('prompt'),portId:'out-text'},{shapeId:target,portId:'in-text'}))throw new Error('PARALLEL_EDGE_MISSING');await ensureCanvasSaved();
    };
    if(${phase === 'execute'}) {
      await create('parallel-',100);await create('stop-',1600);
      const root=await run('shape:parallel-main');
      if(root.state!=='waiting'||root.children.filter(c=>c.state==='completed').length!==1||root.children.filter(c=>c.state==='waiting').length!==1)throw new Error('PARALLEL_PARTIAL_RESULT_LOST');
      const completed=root.children.find(c=>c.state==='completed');if(!editor.getShape(completed.nodeId).meta.nodeResult)throw new Error('PARALLEL_COMPLETED_NOT_PUBLISHED');
      const stoppedRoot=await run('shape:stop-main');if(stoppedRoot.state!=='waiting')throw new Error('PARALLEL_STOP_NOT_WAITING');
      const stopped=value(await window.api.stopFlowAgent({projectId,nodeId:'shape:stop-main'}));if(stopped.state!=='cancelled'||stopped.children.some(c=>c.state!=='cancelled'))throw new Error('PARALLEL_STOP_INCOMPLETE');await ensureCanvasSaved();
      return {projectId,taskId:root.taskId,checks:['two real supplier POSTs must overlap to pass barrier','completed sibling published while other task unknown','separate two-unknown flow stops both children','original unknown commands remain reserved']};
    }
    const before=await read('shape:parallel-main');if(before.state!=='waiting')throw new Error('PARALLEL_WAIT_LOST');
    for(const item of before.children.filter(c=>c.state==='waiting')){
      const child=await read(item.nodeId);const fixed=value(await window.api.runFlowAgent({projectId,nodeId:item.nodeId,action:'reconcile',requestId:crypto.randomUUID(),eventId:crypto.randomUUID(),expectedTaskId:child.taskId,expectedWaitRevision:child.waitRevision,traceId:crypto.randomUUID(),spanId:crypto.randomUUID()}));if(fixed.task.code!=='FLOW_VIDEO_RECONCILE_READY')throw new Error('PARALLEL_RECONCILE_FAILED');if((await run(item.nodeId)).state!=='completed')throw new Error('PARALLEL_CHILD_NOT_COMPLETED');
    }
    const root=await run('shape:parallel-main');if(root.state!=='completed'||root.children.some(c=>c.state!=='completed'))throw new Error('PARALLEL_JOIN_FAILED');
    const stopped=await read('shape:stop-main');if(stopped.state!=='cancelled')throw new Error('PARALLEL_STOP_REVIVED');
    const reply=value(await window.api.runFlowAgent({projectId,nodeId:'shape:stop-main',action:'reconcile',requestId:crypto.randomUUID(),eventId:crypto.randomUUID(),expectedTaskId:stopped.taskId,expectedWaitRevision:stopped.waitRevision,traceId:crypto.randomUUID(),spanId:crypto.randomUUID()}));if(reply.task.state!=='cancelled')throw new Error('PARALLEL_STOP_REPLAYED');
    for(const id of ['shape:stop-video1','shape:stop-video2']){const available=await window.api.checkFlowNodeAvailability({projectId,nodeId:id});if(available.ok)throw new Error('PARALLEL_UNKNOWN_LOCK_RELEASED');if(editor.getShape(id).meta.nodeRun?.status==='success')throw new Error('PARALLEL_STOP_FALSE_SUCCESS');}
    const fixed=editor.getCurrentPageShapes().filter(s=>s.props?.nodeType==='video-asset'&&s.meta?.pinnedOutput);if(fixed.length!==2)throw new Error('PARALLEL_FIXED_VIDEOS_MISSING');
    for(const asset of fixed){const projected=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(asset)['out-video'];if(projected?.kind!=='video')throw new Error('PARALLEL_VIDEO_PORT_MISSING');editor.centerOnPoint(editor.getShapePageBounds(asset.id).center,{animation:{duration:0}});let video;for(let i=0;i<200;i++){video=document.querySelector('[data-node-id="'+asset.id+'"] video');if(video?.videoWidth>0)break;await new Promise(done=>setTimeout(done,25));}if(!(video?.videoWidth>0))throw new Error('PARALLEL_VIDEO_NOT_PLAYABLE');}
    editor.centerOnPoint(editor.getShapePageBounds('shape:parallel-main').center,{animation:{duration:0}});await ensureCanvasSaved();
    let displayed=false;for(let i=0;i<100;i++){const element=document.querySelector('[data-node-id="shape:parallel-main"]');if(element?.textContent.includes('资产已完成')&&element.textContent.includes('阶段：completed')){displayed=true;break;}await new Promise(done=>setTimeout(done,50));}if(!displayed)throw new Error('PARALLEL_COMPLETED_UI_NOT_SETTLED');
    return {projectId,taskId:root.taskId,checks:['reopened flow joins original tasks with no repeated supplier POST','two independent immutable playable video assets','completed sibling is not rerun','explicit stop remains terminal after reopen','unknown command reservations survive stop']};
  })()`)
  const db = getDb(),
    count = (key: string): number =>
      Number(
        (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string }).value
      )
  if (
    count('parallel-posts') !== 4 ||
    count('parallel-downloads') !== (phase === 'execute' ? 1 : 2)
  )
    throw new Error('PARALLEL_SUPPLIER_REPLAY')
  await window.webContents.executeJavaScript(
    `(async()=>{const d=await import('/src/engine/diagnosticsReporter.ts');while(d.pendingDiagnosticsEventCount())d.flushDiagnosticsEvents();await new Promise(done=>setTimeout(done,100));if(d.diagnosticsTransportDropCount())throw new Error('PARALLEL_DIAGNOSTICS_DROPPED');})()`
  )
  if (phase === 'reopen') {
    await window.webContents.executeJavaScript(
      'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'
    )
    await new Promise((done) => setTimeout(done, 300))
    window.webContents.invalidate()
    writeFileSync(
      join(directory, 'parallel-media.png'),
      (await window.webContents.capturePage()).toPNG()
    )
  }
  return {
    ...(report as object),
    supplierPosts: count('parallel-posts'),
    downloads: count('parallel-downloads')
  }
}
