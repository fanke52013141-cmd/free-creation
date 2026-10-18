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

/** Serialized provider fixture for a completed/unknown/queued shared-target checkpoint. */
export function installParallelQueueMediaSupplier(directory: string, phase: string): void {
  const db = getDb()
  if (phase === 'execute') {
    db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?)').run(
      'parallel-test',
      '隔离并行视频队列',
      'seedance',
      'https://ark.cn-beijing.volces.com/api/v3',
      'private-c3-parallel-queue-key',
      JSON.stringify([
        {
          id: 'doubao-seedance-2-0',
          name: '隔离视频队列',
          modality: 'video',
          operations: ['video.generate']
        }
      ]),
      0
    )
    for (const key of ['parallel-queue-posts', 'parallel-queue-downloads'])
      db.prepare('INSERT INTO settings VALUES (?,?)').run(key, '0')
  }
  const native = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const address = String(url)
    if (address.startsWith('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')) {
      if (options?.method === 'POST') {
        const count =
          Number(
            (
              db.prepare("SELECT value FROM settings WHERE key='parallel-queue-posts'").get() as {
                value: string
              }
            ).value
          ) + 1
        // Two commands exist at the forced-exit checkpoint. The third is only
        // admitted after the unknown second branch is reconciled and the queue advances.
        if (
          (phase === 'execute' && count > 2) ||
          (phase === 'reopen' && count !== 3) ||
          count > 3
        )
          throw new Error('PARALLEL_QUEUE_DUPLICATE_OR_UNEXPECTED_POST')
        db.prepare("UPDATE settings SET value=? WHERE key='parallel-queue-posts'").run(String(count))
        return new Response(JSON.stringify({ id: `parallel-queue-${count}` }), {
          headers: { 'Content-Type': 'application/json' }
        })
      }
      const id = address.split('/').at(-1)!
      const index = Number(id.split('-').at(-1))
      return new Response(
        JSON.stringify({
          id,
          status: phase === 'execute' && index === 2 ? 'unknown' : 'succeeded',
          content: { video_url: `https://fixture.example/parallel-queue/${index}` }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (address.startsWith('https://fixture.example/parallel-queue/')) {
      db.prepare(
        "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='parallel-queue-downloads'"
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
  const priorCheckpoint =
    phase === 'reopen' ? JSON.parse(readFileSync(join(directory, 'agent-state.json'), 'utf8')) : null
  const commandLedger = (): Array<{
    commandId: string
    targetNodeId: string
    commandTaskId: string
    leaseId: string
    runId: string
    state: string
    admitted: number
  }> =>
    getDb()
      .prepare(
        `SELECT command_id AS commandId, target_node_id AS targetNodeId,
          task_id AS commandTaskId, lease_id AS leaseId, run_id AS runId, state, admitted
         FROM flow_commands WHERE project_id=? AND target_node_id IN (?,?)
         ORDER BY target_node_id, created_at, command_id`
      )
      .all(input.projectId, 'shape:parallel-video1', 'shape:parallel-video2') as Array<{
      commandId: string
      targetNodeId: string
      commandTaskId: string
      leaseId: string
      runId: string
      state: string
      admitted: number
    }>
  const commandLedgerBefore = phase === 'reopen' ? commandLedger() : null
  if (
    phase === 'reopen' &&
    (!priorCheckpoint?.commandLedger ||
      JSON.stringify(commandLedgerBefore) !== JSON.stringify(priorCheckpoint.commandLedger))
  )
    throw new Error('PARALLEL_COMMAND_LEDGER_CHECKPOINT_DRIFT')
  const report = await window.webContents.executeJavaScript(`(async()=>{${common}
    const priorCheckpoint=${JSON.stringify(priorCheckpoint)};
    const read=async(id)=>value(await window.api.inspectFlowAgent({projectId,nodeId:id}));
    const run=async(id)=>{const current=await read(id);if(current)editor.updateShape({id,type:'node-card',meta:{...editor.getShape(id).meta,agentTask:JSON.stringify(current)}});await ensureCanvasSaved();const result=await(await import('/src/engine/executor.ts')).runNodeManually(editor,projectId,(await import('/src/stores/gateway.ts')).useGatewayStore.getState().providers,id);await ensureCanvasSaved();const task=await read(id);if(task?.state==='completed'&&result.status!=='done')throw new Error('PARALLEL_PROJECTION_FAILED');return task;};
    const budgetSnapshot=async(nodeId)=>{const task=await read(nodeId);if(!task)throw new Error('PARALLEL_TASK_MISSING');const config=JSON.parse(editor.getShape(nodeId).props.config);const maxSteps=config.maxSteps??12,maxTools=20;if(task.decisions>maxSteps||task.tools>maxTools)throw new Error('PARALLEL_BUDGET_EXCEEDED');return {nodeId,taskId:task.taskId,state:task.state,decisions:task.decisions,tools:task.tools,waitRevision:task.waitRevision,maxSteps,maxTools};};
    const commandLock=async(nodeId)=>{const result=await window.api.checkFlowNodeAvailability({projectId,nodeId});return {nodeId,ok:result.ok,code:result.error?.code??null};};
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
      const parallelChildren=await Promise.all(root.children.map(async item=>{const snapshot=await budgetSnapshot(item.nodeId);if(snapshot.taskId!==item.taskId||snapshot.state!==item.state)throw new Error('PARALLEL_CHILD_CHECKPOINT_DRIFT');return snapshot;}));
      if(root.decisions>12||root.tools>20)throw new Error('PARALLEL_COORDINATOR_BUDGET_EXCEEDED');
      const parallelRoot={taskId:root.taskId,state:root.state,decisions:root.decisions,tools:root.tools,maxSteps:12,maxTools:20,children:root.children.map(({nodeId,taskId,state})=>({nodeId,taskId,state}))};
      const commandLocks=await Promise.all(root.children.map(item=>commandLock(item.nodeId.replace('agent','video'))));
      const waitingChild=root.children.find(item=>item.state==='waiting');
      if(!waitingChild||commandLocks.find(lock=>lock.nodeId===waitingChild.nodeId.replace('agent','video'))?.ok)throw new Error('PARALLEL_UNKNOWN_COMMAND_SCOPE_NOT_BLOCKED');
      const stoppedRoot=await run('shape:stop-main');if(stoppedRoot.state!=='waiting')throw new Error('PARALLEL_STOP_NOT_WAITING');
      const stopped=value(await window.api.stopFlowAgent({projectId,nodeId:'shape:stop-main'}));if(stopped.state!=='cancelled'||stopped.children.some(c=>c.state!=='cancelled'))throw new Error('PARALLEL_STOP_INCOMPLETE');await ensureCanvasSaved();
      return {projectId,taskId:root.taskId,parallelRoot,parallelChildren,commandLocks,checks:['two real supplier POSTs must overlap to pass barrier','completed sibling published while other task unknown','Agent decision/tool budgets recorded within configured caps','unknown video command scope remains blocked before forced exit','separate two-unknown flow stops both children','original unknown commands remain reserved']};
    }
    const before=await read('shape:parallel-main');if(before.state!=='waiting')throw new Error('PARALLEL_WAIT_LOST');
    if(!priorCheckpoint?.parallelRoot||priorCheckpoint.parallelRoot.taskId!==before.taskId||priorCheckpoint.parallelRoot.decisions!==before.decisions||priorCheckpoint.parallelRoot.tools!==before.tools)throw new Error('PARALLEL_ROOT_CHECKPOINT_DRIFT');
    const beforeChildren=await Promise.all(priorCheckpoint.parallelChildren.map(async previous=>{const current=await budgetSnapshot(previous.nodeId);if(current.taskId!==previous.taskId||current.state!==previous.state||current.decisions!==previous.decisions||current.tools!==previous.tools||current.waitRevision!==previous.waitRevision)throw new Error('PARALLEL_CHILD_CHECKPOINT_DRIFT');return current;}));
    const beforeLocks=await Promise.all(priorCheckpoint.commandLocks.map(item=>commandLock(item.nodeId)));
    if(JSON.stringify(beforeLocks)!==JSON.stringify(priorCheckpoint.commandLocks))throw new Error('PARALLEL_COMMAND_RESERVATION_DRIFT');
    for(const item of before.children.filter(c=>c.state==='waiting')){
      const child=await read(item.nodeId);const fixed=value(await window.api.runFlowAgent({projectId,nodeId:item.nodeId,action:'reconcile',requestId:crypto.randomUUID(),eventId:crypto.randomUUID(),expectedTaskId:child.taskId,expectedWaitRevision:child.waitRevision,traceId:crypto.randomUUID(),spanId:crypto.randomUUID()}));if(fixed.task.code!=='FLOW_VIDEO_RECONCILE_READY')throw new Error('PARALLEL_RECONCILE_FAILED');if((await run(item.nodeId)).state!=='completed')throw new Error('PARALLEL_CHILD_NOT_COMPLETED');
    }
    const root=await run('shape:parallel-main');if(root.state!=='completed'||root.children.some(c=>c.state!=='completed'))throw new Error('PARALLEL_JOIN_FAILED');
    const stopped=await read('shape:stop-main');if(stopped.state!=='cancelled')throw new Error('PARALLEL_STOP_REVIVED');
    const reply=value(await window.api.runFlowAgent({projectId,nodeId:'shape:stop-main',action:'reconcile',requestId:crypto.randomUUID(),eventId:crypto.randomUUID(),expectedTaskId:stopped.taskId,expectedWaitRevision:stopped.waitRevision,traceId:crypto.randomUUID(),spanId:crypto.randomUUID()}));if(reply.task.state!=='cancelled')throw new Error('PARALLEL_STOP_REPLAYED');
    for(const id of ['shape:stop-video1','shape:stop-video2']){const available=await window.api.checkFlowNodeAvailability({projectId,nodeId:id});if(available.ok)throw new Error('PARALLEL_UNKNOWN_LOCK_RELEASED');if(editor.getShape(id).meta.nodeRun?.status==='success')throw new Error('PARALLEL_STOP_FALSE_SUCCESS');}
    const fixed=editor.getCurrentPageShapes().filter(s=>s.props?.nodeType==='video-asset'&&s.meta?.pinnedOutput);if(fixed.length!==2)throw new Error('PARALLEL_FIXED_VIDEOS_MISSING');
    const afterChildren=await Promise.all(beforeChildren.map(async previous=>{const current=await budgetSnapshot(previous.nodeId);if(current.taskId!==previous.taskId||current.decisions<previous.decisions||current.tools<previous.tools||current.decisions>current.maxSteps||current.tools>current.maxTools)throw new Error('PARALLEL_RECOVERED_BUDGET_INVALID');if(previous.state==='completed'&&(current.state!=='completed'||current.decisions!==previous.decisions||current.tools!==previous.tools))throw new Error('PARALLEL_COMPLETED_SIBLING_REPLAYED');return current;}));
    for(const asset of fixed){const projected=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(asset)['out-video'];if(projected?.kind!=='video')throw new Error('PARALLEL_VIDEO_PORT_MISSING');editor.centerOnPoint(editor.getShapePageBounds(asset.id).center,{animation:{duration:0}});let video;for(let i=0;i<200;i++){video=document.querySelector('[data-node-id="'+asset.id+'"] video');if(video?.videoWidth>0)break;await new Promise(done=>setTimeout(done,25));}if(!(video?.videoWidth>0))throw new Error('PARALLEL_VIDEO_NOT_PLAYABLE');}
    editor.centerOnPoint(editor.getShapePageBounds('shape:parallel-main').center,{animation:{duration:0}});await ensureCanvasSaved();
    let displayed=false;for(let i=0;i<100;i++){const element=document.querySelector('[data-node-id="shape:parallel-main"]');if(element?.textContent.includes('资产已完成')&&element.textContent.includes('阶段：completed')){displayed=true;break;}await new Promise(done=>setTimeout(done,50));}if(!displayed)throw new Error('PARALLEL_COMPLETED_UI_NOT_SETTLED');
    return {projectId,taskId:root.taskId,recoveryAudit:{rootTaskIdBefore:priorCheckpoint.parallelRoot.taskId,rootTaskIdAfter:root.taskId,childrenBefore:beforeChildren,childrenAfter:afterChildren,commandLocksBefore:priorCheckpoint.commandLocks,commandLocksAfter:beforeLocks},checks:['forced-exit checkpoint reopened in a new process','original coordinator and child task IDs retained','pre-recovery command reservations unchanged','decision/tool counters remained within limits','completed sibling counters unchanged and sibling not replayed','reopened flow joins original tasks with no repeated supplier POST','two independent immutable playable video assets','explicit stop remains terminal after reopen','unknown command reservations survive stop']};
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
  const ledgerAfter = commandLedger()
  if (ledgerAfter.length !== 2) throw new Error('PARALLEL_COMMAND_LEDGER_COUNT_INVALID')
  if (phase === 'execute') {
    const completedChild = (report as { parallelChildren: Array<{ nodeId: string; state: string }> }).parallelChildren.find(
      (child) => child.state === 'completed'
    )
    const waitingChild = (report as { parallelChildren: Array<{ nodeId: string; state: string }> }).parallelChildren.find(
      (child) => child.state === 'waiting'
    )
    if (
      !completedChild ||
      !waitingChild ||
      ledgerAfter.find((item) => item.targetNodeId === completedChild.nodeId.replace('agent', 'video'))?.state !== 'committed' ||
      ledgerAfter.find((item) => item.targetNodeId === waitingChild.nodeId.replace('agent', 'video'))?.state !== 'unknown'
    )
      throw new Error('PARALLEL_COMMAND_LEDGER_STATE_INVALID')
    return { ...(report as object), commandLedger: ledgerAfter, supplierPosts: count('parallel-posts'), downloads: count('parallel-downloads') }
  }
  const identity = (items: typeof ledgerAfter): string[] =>
    items.map(({ commandId, targetNodeId, commandTaskId, leaseId, runId }) =>
      [commandId, targetNodeId, commandTaskId, leaseId, runId].join('|')
    ).sort()
  if (
    !commandLedgerBefore ||
    JSON.stringify(identity(ledgerAfter)) !== JSON.stringify(identity(commandLedgerBefore)) ||
    ledgerAfter.some((item) => item.state !== 'committed')
  )
    throw new Error('PARALLEL_COMMAND_IDENTITY_CHANGED')
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
    recoveryAudit: {
      ...((report as { recoveryAudit?: object }).recoveryAudit ?? {}),
      commandLedgerBefore,
      commandLedgerAfter: ledgerAfter
    },
    commandLedger: ledgerAfter,
    supplierPosts: count('parallel-posts'),
    downloads: count('parallel-downloads')
  }
}

export async function acceptParallelQueueMedia(input: {
  window: BrowserWindow
  directory: string
  projectId: string
  phase: string
  common: string
}): Promise<unknown> {
  const { window, directory, phase, common } = input
  const checkpoint =
    phase === 'reopen' ? JSON.parse(readFileSync(join(directory, 'agent-state.json'), 'utf8')) : null
  const ledger = (): Array<{
    commandId: string
    targetNodeId: string
    commandTaskId: string
    leaseId: string
    runId: string
    state: string
    admitted: number
  }> =>
    getDb()
      .prepare(
        `SELECT command_id AS commandId, target_node_id AS targetNodeId,
          task_id AS commandTaskId, lease_id AS leaseId, run_id AS runId, state, admitted
         FROM flow_commands WHERE project_id=? AND target_node_id=?
         ORDER BY rowid`
      )
      .all(input.projectId, 'shape:queue-video') as Array<{
      commandId: string
      targetNodeId: string
      commandTaskId: string
      leaseId: string
      runId: string
      state: string
      admitted: number
    }>
  const ledgerAtOpen = phase === 'reopen' ? ledger() : null
  if (
    phase === 'reopen' &&
    (!checkpoint?.commandLedger || JSON.stringify(ledgerAtOpen) !== JSON.stringify(checkpoint.commandLedger))
  )
    throw new Error('PARALLEL_QUEUE_COMMAND_LEDGER_CHECKPOINT_DRIFT')
  const report = await window.webContents.executeJavaScript(`(async()=>{${common}
    const checkpoint=${JSON.stringify(checkpoint)};
    const read=async(id)=>value(await window.api.inspectFlowAgent({projectId,nodeId:id}));
    const run=async(id)=>{const current=await read(id);if(current)editor.updateShape({id,type:'node-card',meta:{...editor.getShape(id).meta,agentTask:JSON.stringify(current)}});await ensureCanvasSaved();const result=await(await import('/src/engine/executor.ts')).runNodeManually(editor,projectId,(await import('/src/stores/gateway.ts')).useGatewayStore.getState().providers,id);await ensureCanvasSaved();const task=await read(id);if(task?.state==='completed'&&result.status!=='done')throw new Error('PARALLEL_QUEUE_PROJECTION_FAILED');return task;};
    const budget=async(nodeId)=>{const task=await read(nodeId);if(!task)throw new Error('PARALLEL_QUEUE_TASK_MISSING');const config=JSON.parse(editor.getShape(nodeId).props.config);const maxSteps=config.maxSteps??12,maxTools=20;if(task.decisions>maxSteps||task.tools>maxTools)throw new Error('PARALLEL_QUEUE_BUDGET_EXCEEDED');return {nodeId,taskId:task.taskId,state:task.state,decisions:task.decisions,tools:task.tools,waitRevision:task.waitRevision,maxSteps,maxTools};};
    const identity=(items)=>items.map(({commandId,targetNodeId,commandTaskId,leaseId,runId})=>[commandId,targetNodeId,commandTaskId,leaseId,runId].join('|')).sort();
    const create=async()=>{
      const id=(suffix)=>'shape:queue-'+suffix;
      const config=(role,ids)=>JSON.stringify({schemaVersion:1,role,interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:role==='coordinator'?'agent.dispatch':'node.execute',version:'1'}],allowedNodeIds:ids,maxSteps:16,...(role==='coordinator'?{maxParallelTasks:3}:{}),relations:role==='coordinator'?[{relationId:'queue-state',kind:'observes',sourceNodeId:id('main'),targetNodeId:id('state')}]:[]});
      const {createEdge}=await import('/src/canvas/graph.ts');
      editor.createShape({id:id('main'),type:'node-card',x:100,y:100,props:{nodeType:'agent',title:'共享目标队列主控',text:'按顺序完成三个共享视频目标分支并汇总固定成果',config:config('coordinator',[id('agent1'),id('agent2'),id('agent3')])}});
      editor.createShape({id:id('prompt'),type:'node-card',x:100,y:700,props:{nodeType:'text',title:'队列共同材料',text:'private-c3-parallel-queue-prompt'}});
      for(const n of [1,2,3]){
        editor.createShape({id:id('agent'+n),type:'node-card',x:520+(n-1)*360,y:100,props:{nodeType:'agent',title:'共享目标分支 '+n,text:'执行一次视频生成并交付固定成果',config:config('specialist',[id('video')])}});
        if(!createEdge(editor,{shapeId:id('prompt'),portId:'out-text'},{shapeId:id('agent'+n),portId:'in-text'}))throw new Error('PARALLEL_QUEUE_AGENT_EDGE_MISSING');
      }
      editor.createShape({id:id('video'),type:'node-card',x:880,y:700,props:{nodeType:'video',title:'FIFO共享视频目标',config:JSON.stringify({mode:'text',modelKey:'parallel-test::doubao-seedance-2-0',params:{}})}});
      editor.createShape({id:id('state'),type:'node-card',x:1480,y:100,props:{nodeType:'state-machine',title:'队列流程状态',config:JSON.stringify({schemaVersion:1,initialState:'draft',states:['draft','working','waiting','completed'],transitions:[{from:'draft',event:'flow.started',to:'working'},...['agent.dispatched','agent.completed','human.wait','flow.paused','flow.completed'].map(event=>({from:'working',event,to:event==='flow.completed'?'completed':['human.wait','flow.paused'].includes(event)?'waiting':'working'})),{from:'waiting',event:'human.continue',to:'working'}],relations:[]})}});
      if(!createEdge(editor,{shapeId:id('prompt'),portId:'out-text'},{shapeId:id('video'),portId:'in-text'}))throw new Error('PARALLEL_QUEUE_VIDEO_EDGE_MISSING');
      await ensureCanvasSaved();
    };
    if(${phase === 'execute'}){
      await create();
      const root=await run('shape:queue-main');
      const states=root.children.map(child=>child.state);
      if(root.state!=='waiting'||JSON.stringify(states)!==JSON.stringify(['completed','waiting','queued']))throw new Error('PARALLEL_QUEUE_MIXED_CHECKPOINT_INVALID:'+JSON.stringify(states));
      const children=await Promise.all(root.children.map(child=>budget(child.nodeId)));
      if(root.decisions>16||root.tools>20)throw new Error('PARALLEL_QUEUE_COORDINATOR_BUDGET_EXCEEDED');
      const lock=await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:queue-video'});
      if(lock.ok)throw new Error('PARALLEL_QUEUE_UNKNOWN_SCOPE_NOT_LOCKED');
      return {projectId,taskId:root.taskId,parallelRoot:{taskId:root.taskId,state:root.state,decisions:root.decisions,tools:root.tools,maxSteps:16,maxTools:20},parallelChildren:children,commandLock:{nodeId:'shape:queue-video',ok:lock.ok,code:lock.error?.code??null},checks:['same-target dispatch order creates completed/waiting/queued checkpoint','first two command identities and unknown reservation saved before forced exit','queued third branch has task identity but no command side effect','root and child budgets recorded within configured caps']};
    }
    const rootBefore=await read('shape:queue-main');
    if(rootBefore.state!=='waiting'||rootBefore.taskId!==checkpoint.parallelRoot.taskId||JSON.stringify(rootBefore.children.map(child=>child.state))!==JSON.stringify(['completed','waiting','queued']))throw new Error('PARALLEL_QUEUE_ROOT_IDENTITY_OR_FIFO_CHECKPOINT_CHANGED:'+JSON.stringify(rootBefore.children.map(child=>child.state)));
    const lockBefore=await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:queue-video'});
    if(lockBefore.ok!==checkpoint.commandLock.ok||lockBefore.error?.code!==(checkpoint.commandLock.code??null))throw new Error('PARALLEL_QUEUE_LOCK_CHECKPOINT_DRIFT');
    const before=await Promise.all(checkpoint.parallelChildren.map(async previous=>{const current=await budget(previous.nodeId);if(current.taskId!==previous.taskId||current.state!==previous.state||current.decisions!==previous.decisions||current.tools!==previous.tools||current.waitRevision!==previous.waitRevision)throw new Error('PARALLEL_QUEUE_CHILD_CHECKPOINT_DRIFT');return current;}));
    const unknown=before.find(child=>child.state==='waiting');
    if(!unknown)throw new Error('PARALLEL_QUEUE_UNKNOWN_CHILD_MISSING');
    const reconciled=value(await window.api.runFlowAgent({projectId,nodeId:unknown.nodeId,action:'reconcile',requestId:crypto.randomUUID(),eventId:crypto.randomUUID(),expectedTaskId:unknown.taskId,expectedWaitRevision:unknown.waitRevision,traceId:crypto.randomUUID(),spanId:crypto.randomUUID()}));
    if(reconciled.task.code!=='FLOW_VIDEO_RECONCILE_READY')throw new Error('PARALLEL_QUEUE_RECONCILE_FAILED');
    const recovered=await run(unknown.nodeId);
    if(recovered.state!=='completed')throw new Error('PARALLEL_QUEUE_UNKNOWN_BRANCH_NOT_COMPLETED');
    const parentBeforeContinue=await read('shape:queue-main');
    const statesBeforeContinue=parentBeforeContinue.children.map(child=>child.state);
    if(parentBeforeContinue.taskId!==checkpoint.parallelRoot.taskId||parentBeforeContinue.state!=='waiting'||JSON.stringify(statesBeforeContinue)!==JSON.stringify(['completed','waiting','queued']))throw new Error('PARALLEL_QUEUE_PARENT_WAIT_SNAPSHOT_DRIFT:'+JSON.stringify(statesBeforeContinue));
    const root=await run('shape:queue-main');
    if(root.taskId!==checkpoint.parallelRoot.taskId||root.state!=='completed'||JSON.stringify(root.children.map(child=>child.state))!==JSON.stringify(['completed','completed','completed']))throw new Error('PARALLEL_QUEUE_FINAL_JOIN_INVALID');
    if(root.decisions>16||root.tools>20)throw new Error('PARALLEL_QUEUE_FINAL_COORDINATOR_BUDGET_EXCEEDED');
    const after=await Promise.all(before.map(async previous=>{const current=await budget(previous.nodeId);if(current.taskId!==previous.taskId||current.decisions<previous.decisions||current.tools<previous.tools||current.decisions>current.maxSteps||current.tools>current.maxTools)throw new Error('PARALLEL_QUEUE_RECOVERED_BUDGET_INVALID');if(previous.state==='completed'&&(current.state!=='completed'||current.decisions!==previous.decisions||current.tools!==previous.tools))throw new Error('PARALLEL_QUEUE_COMPLETED_BRANCH_REPLAYED');return current;}));
    const summaryOutputs=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(editor.getShape('shape:queue-main'));
    if(!Object.keys(summaryOutputs).length)throw new Error('PARALLEL_QUEUE_SUMMARY_OUTPUT_MISSING');
    const targetAvailable=await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:queue-video'});
    if(!targetAvailable.ok)throw new Error('PARALLEL_QUEUE_TERMINAL_LOCK_LEAKED');
    await ensureCanvasSaved();
    return {projectId,taskId:root.taskId,parallelRoot:{taskId:root.taskId,state:root.state,decisions:root.decisions,tools:root.tools,maxSteps:16,maxTools:20},summaryOutputPorts:Object.keys(summaryOutputs),recoveryAudit:{rootTaskIdBefore:checkpoint.parallelRoot.taskId,rootTaskIdAfter:root.taskId,childrenBefore:before,childrenAfter:after,parentBeforeContinue:parentBeforeContinue.children.map(child=>({nodeId:child.nodeId,taskId:child.taskId,state:child.state})),commandLockBefore:checkpoint.commandLock,commandLockAfter:{nodeId:'shape:queue-video',ok:targetAvailable.ok}},checks:['new process reopened original coordinator and child identities','unknown branch reconciled without repeating its supplier POST','completed first branch counters stayed unchanged','parent retained its original waiting snapshot until explicit continue','queued third branch ran only after the recovered branch became terminal','shared target lock released after FIFO queue drained','coordinator and all three branches stayed within decision/tool budgets','all three branches completed and the main Agent produced a verified summary output']};
  })()`)
  const db = getDb()
  const count = (key: string): number =>
    Number((db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string }).value)
  const posts = count('parallel-queue-posts')
  const downloads = count('parallel-queue-downloads')
  const commandLedger = ledger()
  const commandIdentity = (items: typeof commandLedger): string[] =>
    items.map(({ commandId, targetNodeId, commandTaskId, leaseId, runId }) =>
      [commandId, targetNodeId, commandTaskId, leaseId, runId].join('|')
    ).sort()
  if (phase === 'execute') {
    const children = (report as { parallelChildren: Array<{ taskId: string }> }).parallelChildren
    if (posts !== 2 || downloads !== 1 || commandLedger.length !== 2 || commandLedger[0]?.state !== 'committed' || commandLedger[1]?.state !== 'unknown' || commandLedger[0]?.commandTaskId !== children[0]?.taskId || commandLedger[1]?.commandTaskId !== children[1]?.taskId || children[2]?.taskId === commandLedger[0]?.commandTaskId || children[2]?.taskId === commandLedger[1]?.commandTaskId)
      throw new Error('PARALLEL_QUEUE_INITIAL_LEDGER_INVALID')
    return { ...(report as object), commandLedger, supplierPosts: posts, downloads }
  }
  if (posts !== 3 || downloads !== 3 || commandLedger.length !== 3 || commandLedger.some(item => item.state !== 'committed'))
    throw new Error('PARALLEL_QUEUE_RECOVERY_SIDE_EFFECTS_INVALID')
  if (!ledgerAtOpen || JSON.stringify(commandIdentity(commandLedger.slice(0, 2))) !== JSON.stringify(commandIdentity(ledgerAtOpen)))
    throw new Error('PARALLEL_QUEUE_COMMAND_IDENTITY_CHANGED')
  if ((report as { recoveryAudit?: { childrenAfter?: Array<{ taskId: string }> } }).recoveryAudit?.childrenAfter?.[2]?.taskId !== commandLedger[2]?.commandTaskId)
    throw new Error('PARALLEL_QUEUE_NEW_COMMAND_NOT_BOUND_TO_QUEUED_BRANCH')
  const final = { ...(report as object), commandLedger, supplierPosts: posts, downloads }
  writeFileSync(join(directory, 'parallel-queue-media.png'), (await window.webContents.capturePage()).toPNG())
  return final
}
