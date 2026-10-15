// Isolated desktop fixture. Never imported by the application entry point.
import type { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../store/db'
import { assertVideoReviewEvidence } from './video-review'
import type { ReviewDecision } from '../../shared/agent-flow/node-contracts'

export function installParallelReviewSupplier(directory: string, phase: string): void {
  const db = getDb()
  if (phase === 'execute') {
    db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?)').run(
      'parallel-review-test',
      '隔离并行审核',
      'seedance',
      'https://ark.cn-beijing.volces.com/api/v3',
      'private-c3-parallel-review-key',
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
    for (const key of ['parallel-review-posts', 'parallel-review-downloads'])
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
              db.prepare("SELECT value FROM settings WHERE key='parallel-review-posts'").get() as {
                value: string
              }
            ).value
          ) + 1
        const content = JSON.parse(String(options.body)).content as Array<{
          type: string
          text?: string
        }>
        const text = content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
        if (
          count > 4 ||
          phase !== 'execute' ||
          !text.includes('private-c3-parallel-review-prompt') ||
          (count > 2 &&
            (!text.includes('修改反馈：') ||
              !text.includes('抽样画面不是红色') ||
              !text.includes('private-c3-revision-proposal')))
        )
          throw new Error('PARALLEL_REVIEW_SUBMISSION_INVALID')
        db.prepare("UPDATE settings SET value=? WHERE key='parallel-review-posts'").run(
          String(count)
        )
        if (count === 1) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('PARALLEL_REVIEW_NOT_CONCURRENT')),
              10000
            )
            releaseFirst = () => {
              clearTimeout(timer)
              resolve()
            }
          })
        } else if (count === 2) {
          if (!releaseFirst) throw new Error('PARALLEL_REVIEW_BARRIER_MISSING')
          releaseFirst()
        }
        return new Response(JSON.stringify({ id: `parallel-review-${count}` }), {
          headers: { 'Content-Type': 'application/json' }
        })
      }
      const index = Number(address.split('-').at(-1))
      return new Response(
        JSON.stringify({
          id: `parallel-review-${index}`,
          status: phase === 'execute' && index === 3 ? 'unknown' : 'succeeded',
          content: { video_url: `https://fixture.example/parallel-review/${index}` }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (address.startsWith('https://fixture.example/parallel-review/')) {
      db.prepare(
        "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='parallel-review-downloads'"
      ).run()
      const index = Number(address.split('/').at(-1))
      return new Response(
        readFileSync(join(directory, index > 2 ? 'review-red.mp4' : 'review-blue.mp4'))
      )
    }
    return native(url, options)
  }
}

export async function acceptParallelReview(input: {
  window: BrowserWindow
  directory: string
  projectId: string
  phase: string
  common: string
}): Promise<unknown> {
  const { window, directory, phase, common } = input
  const report = await window.webContents.executeJavaScript(`(async()=>{${common}
    const id=s=>'shape:pr-'+s;
    const read=async(s)=>value(await window.api.inspectFlowAgent({projectId,nodeId:id(s)}));
    const run=async(s)=>{const current=await read(s);if(current)editor.updateShape({id:id(s),type:'node-card',meta:{...editor.getShape(id(s)).meta,agentTask:JSON.stringify(current)}});await ensureCanvasSaved();const result=await(await import('/src/engine/executor.ts')).runNodeManually(editor,projectId,(await import('/src/stores/gateway.ts')).useGatewayStore.getState().providers,id(s));await ensureCanvasSaved();const task=await read(s);if(task?.state==='completed'&&result.status!=='done')throw new Error('PARALLEL_REVIEW_PROJECTION_FAILED');return task;};
    const gated=async()=>{const result=await window.api.checkFlowNodeAvailability({projectId,nodeId:id('downstream')});if(result.ok||result.error.code!=='FLOW_REVIEW_NOT_READY')throw new Error('PARALLEL_REVIEW_GATE_BYPASSED');};
    if(${phase === 'execute'}){
      const config=(role,ids)=>JSON.stringify({schemaVersion:1,role,interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:role==='coordinator'?'agent.dispatch':'node.execute',version:'1'},...(role==='coordinator'?[{id:'review.execute',version:'1'}]:[])],allowedNodeIds:ids,maxSteps:32,...(role==='coordinator'?{maxParallelTasks:2}:{}),relations:role==='coordinator'?[{relationId:'pr-state',kind:'observes',sourceNodeId:id('main'),targetNodeId:id('state')}]:[]});
      editor.createShape({id:id('main'),type:'node-card',x:100,y:100,props:{nodeType:'agent',title:'并行审核返工主控',text:'并行生成两路视频，分别通过红色审核后才执行下游',config:config('coordinator',[id('agent1'),id('agent2'),id('downstream'),id('review1'),id('review2')])}});
      editor.createShape({id:id('prompt'),type:'node-card',x:100,y:750,props:{nodeType:'text',title:'固定生成材料',text:'private-c3-parallel-review-prompt'}});
      for(const n of [1,2]){
        editor.createShape({id:id('agent'+n),type:'node-card',x:530+(n-1)*430,y:100,props:{nodeType:'agent',title:'视频专业 '+n,text:'执行一次视频生成，返工用原节点和固定反馈，交付真实固定成果',config:config('specialist',[id('video'+n)])}});
        editor.createShape({id:id('video'+n),type:'node-card',x:530+(n-1)*430,y:750,props:{nodeType:'video',title:'视频 '+n,config:JSON.stringify({mode:'text',modelKey:'parallel-review-test::doubao-seedance-2-0',params:{}})}});
        editor.createShape({id:id('review'+n),type:'node-card',x:530+(n-1)*430,y:1400,props:{nodeType:'ai-review',title:'独立抽帧审核 '+n,text:'四张样本必须均为红色，其他颜色拒绝，不判断音轨或完整时序。',config:JSON.stringify({schemaVersion:1,reviewMode:'sampled-video',modelDefinitionId:'agent-test-model',rulesVersion:'pr-visual-1',rejectPolicy:'rework',maxReworks:1,responsibleNodeId:id('agent'+n),subjectSources:[{nodeId:id('video'+n),portId:'out-video'}],gatedNodeIds:[id('downstream'),id('process')],relations:[]})}});
      }
      editor.createShape({id:id('downstream'),type:'node-card',x:1390,y:100,props:{nodeType:'agent',title:'双审核后的下游',text:'执行数据处理并交付已批准视频信息',config:config('specialist',[id('process')])}});
      editor.createShape({id:id('process'),type:'node-card',x:1390,y:750,props:{nodeType:'processor',title:'已批准视频信息',config:JSON.stringify({operation:'pass'})}});
      editor.createShape({id:id('state'),type:'node-card',x:100,y:1400,props:{nodeType:'state-machine',title:'并行审核状态',config:JSON.stringify({schemaVersion:1,initialState:'draft',states:['draft','working','waiting','completed'],transitions:[{from:'draft',event:'flow.started',to:'working'},...['agent.dispatched','agent.completed','human.wait','flow.paused','flow.completed','review.started','review.passed','review.rejected','rework.created'].map(event=>({from:'working',event,to:event==='flow.completed'?'completed':['human.wait','flow.paused'].includes(event)?'waiting':'working'})),{from:'waiting',event:'human.continue',to:'working'}],relations:[]})}});
      const {createEdge}=await import('/src/canvas/graph.ts');
      const edge=(from,out,to,port)=>{if(!createEdge(editor,{shapeId:id(from),portId:out},{shapeId:id(to),portId:port}))throw new Error('PARALLEL_REVIEW_EDGE_MISSING');};
      for(const n of [1,2]){for(const target of ['agent'+n,'video'+n])edge('prompt','out-text',target,'in-text');edge('video'+n,'out-video','review'+n,'in-video');}
      edge('agent2','out-json','downstream','in-json');edge('agent2','out-json','process','in-value');await ensureCanvasSaved();await gated();
      const root=await run('main');
      if(root.state!=='waiting')throw new Error('PARALLEL_REVIEW_UNKNOWN_NOT_HELD');
      const decisions=[1,2].map(n=>JSON.parse(editor.getShape(id('review'+n)).meta.nodeResult));
      if(decisions.filter(d=>d.passed).length!==1)throw new Error('PARALLEL_REVIEW_SIBLING_STARVED');
      if(editor.getShape(id('process')).meta.nodeRun)throw new Error('PARALLEL_REVIEW_DOWNSTREAM_EARLY');await gated();
      return {projectId,taskId:root.taskId,checks:['initial supplier POSTs overlap','two independent negative sampled reviews create two new rework tasks','one unknown rework does not starve sibling approval','both review gates hold downstream']};
    }
    await gated();const before=await read('main');
    const waiting=before.children.filter(c=>c.state==='waiting');if(waiting.length!==1)throw new Error('PARALLEL_REVIEW_WAIT_COUNT');
    const name=waiting[0].nodeId.replace('shape:pr-',''),child=await read(name);
    const reconciled=value(await window.api.runFlowAgent({projectId,nodeId:waiting[0].nodeId,action:'reconcile',requestId:crypto.randomUUID(),eventId:crypto.randomUUID(),expectedTaskId:child.taskId,expectedWaitRevision:child.waitRevision,traceId:crypto.randomUUID(),spanId:crypto.randomUUID()}));if(reconciled.task.code!=='FLOW_VIDEO_RECONCILE_READY')throw new Error('PARALLEL_REVIEW_RECONCILE_FAILED');
    if((await run(name)).state!=='completed')throw new Error('PARALLEL_REVIEW_CHILD_NOT_COMPLETED');
    const root=await run('main');if(root.state!=='completed')throw new Error('PARALLEL_REVIEW_JOIN_FAILED');
    for(const n of [1,2]){const decision=JSON.parse(editor.getShape(id('review'+n)).meta.nodeResult);if(!decision.passed||decision.reviewRevision!==1)throw new Error('PARALLEL_REVIEW_APPROVAL_MISSING');}
    if(editor.getShape(id('process')).meta.nodeRun?.status!=='success')throw new Error('PARALLEL_REVIEW_DOWNSTREAM_MISSING');
    const fixed=editor.getCurrentPageShapes().filter(s=>s.props?.nodeType==='video-asset'&&s.meta?.pinnedOutput);if(fixed.length!==4)throw new Error('PARALLEL_REVIEW_FIXED_HISTORY_MISSING');
    editor.centerOnPoint(editor.getShapePageBounds(id('main')).center,{animation:{duration:0}});await ensureCanvasSaved();
    let displayed=false;for(let i=0;i<100;i++){const element=document.querySelector('[data-node-id="'+id('main')+'"]');if(element?.textContent.includes('资产已完成')&&element.textContent.includes('阶段：completed')){displayed=true;break;}await new Promise(done=>setTimeout(done,50));}if(!displayed)throw new Error('PARALLEL_REVIEW_COMPLETED_UI_NOT_SETTLED');
    return {projectId,taskId:root.taskId,checks:['reopen resumes the original unknown task without POST replay','both same-version approvals release actual downstream execution','two rejected and two approved immutable video assets remain']};
  })()`)
  const db = getDb()
  const count = (key: string): number =>
    Number(
      (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string }).value
    )
  if (
    count('parallel-review-posts') !== 4 ||
    count('parallel-review-downloads') !== (phase === 'execute' ? 3 : 4)
  )
    throw new Error('PARALLEL_REVIEW_SUPPLIER_REPLAY')
  const rows = db
    .prepare('SELECT body_json FROM flow_reviews WHERE project_id=? ORDER BY rowid')
    .all(input.projectId) as { body_json: string }[]
  const decisions = rows.map((row) => JSON.parse(row.body_json).decision as ReviewDecision)
  if (decisions.length !== (phase === 'execute' ? 3 : 4))
    throw new Error('PARALLEL_REVIEW_REPORT_REPLAY')
  for (const decision of decisions) assertVideoReviewEvidence(db, input.projectId, decision)
  if (phase === 'reopen') {
    for (const nodeId of ['shape:pr-agent1', 'shape:pr-agent2']) {
      const rows = db
        .prepare(
          'SELECT snapshot_json FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=? ORDER BY rowid'
        )
        .all(input.projectId, nodeId) as { snapshot_json: string }[]
      const tasks = rows.map((row) => JSON.parse(row.snapshot_json))
      if (
        tasks.length !== 2 ||
        tasks[1].parentTaskId !== tasks[0].taskId ||
        !tasks[1].rework ||
        JSON.stringify(tasks[0].directInputs) !== JSON.stringify(tasks[1].directInputs) ||
        JSON.stringify(tasks[0].targets) !== JSON.stringify(tasks[1].targets)
      )
        throw new Error('PARALLEL_REVIEW_TASK_DRIFT')
      const rejected = decisions.find((decision) => decision.reviewId === tasks[1].rework.reviewId)
      if (
        !rejected ||
        rejected.passed ||
        JSON.stringify(tasks[1].rework.rejectedOutputs) !== JSON.stringify(rejected.subjects)
      )
        throw new Error('PARALLEL_REVIEW_FEEDBACK_DRIFT')
    }
    await window.webContents.executeJavaScript(
      'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'
    )
    window.webContents.invalidate()
    writeFileSync(
      join(directory, 'parallel-review.png'),
      (await window.webContents.capturePage()).toPNG()
    )
  }
  return { ...(report as object), supplierPosts: 4, downloads: count('parallel-review-downloads') }
}
