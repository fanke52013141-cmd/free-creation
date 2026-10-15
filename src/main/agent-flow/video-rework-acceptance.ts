// Isolated real-desktop acceptance. Not imported by the application entry point.
import type { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../store/db'
import { assertVideoReviewEvidence } from './video-review'
import type { ReviewDecision } from '../../shared/agent-flow/node-contracts'

export function installVideoReworkSupplier(directory: string, phase: string): void {
  const db = getDb()
  if (phase === 'execute') {
    db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?)').run(
      'video-test',
      '隔离返工视频',
      'seedance',
      'https://ark.cn-beijing.volces.com/api/v3',
      'private-c3-video-key',
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
    for (const key of ['video-rework-posts', 'video-rework-downloads'])
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
              db.prepare('SELECT value FROM settings WHERE key=?').get('video-rework-posts') as {
                value: string
              }
            ).value
          ) + 1
        const content = JSON.parse(String(options.body)).content
        const text = content
          .filter((part: { type: string }) => part.type === 'text')
          .map((part: { text: string }) => part.text)
          .join('\n')
        if (
          count > 2 ||
          !text.includes('private-c3-video-prompt') ||
          (count === 2 &&
            (!text.includes('private-c3-video-rule') ||
              !text.includes('修改反馈：') ||
              !text.includes('抽样画面不是红色') ||
              !text.includes('private-c3-revision-proposal')))
        )
          throw new Error('VIDEO_REWORK_PROMPT_NOT_BOUND')
        db.prepare('UPDATE settings SET value=? WHERE key=?').run(
          String(count),
          'video-rework-posts'
        )
        return new Response(JSON.stringify({ id: `video-rework-${count}` }), {
          headers: { 'Content-Type': 'application/json' }
        })
      }
      const second = address.endsWith('video-rework-2')
      return new Response(
        JSON.stringify({
          id: second ? 'video-rework-2' : 'video-rework-1',
          status: phase === 'execute' && second ? 'unknown' : 'succeeded',
          content: { video_url: `https://fixture.example/rework/${second ? 2 : 1}` }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (address.startsWith('https://fixture.example/rework/')) {
      db.prepare(
        "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='video-rework-downloads'"
      ).run()
      return new Response(
        readFileSync(join(directory, address.endsWith('/2') ? 'review-red.mp4' : 'review-blue.mp4'))
      )
    }
    return native(url, options)
  }
}

export async function acceptVideoRework(input: {
  window: BrowserWindow
  directory: string
  projectId: string
  phase: string
  common: string
}): Promise<unknown> {
  const { window, directory, phase, common } = input
  const report = await window.webContents.executeJavaScript(`(async()=>{${common}
    const read=async(id)=>value(await window.api.inspectFlowAgent({projectId,nodeId:id}));
    const run=async(id)=>{const current=await read(id);if(current)editor.updateShape({id,type:'node-card',meta:{...editor.getShape(id).meta,agentTask:JSON.stringify(current)}});await ensureCanvasSaved();const result=await(await import('/src/engine/executor.ts')).runNodeManually(editor,projectId,(await import('/src/stores/gateway.ts')).useGatewayStore.getState().providers,id);await ensureCanvasSaved();const task=await read(id);if(task?.state==='completed'&&result.status!=='done')throw new Error('VIDEO_REWORK_PROJECTION_FAILED');return task;};
    const blocked=async()=>{const r=await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:approved-agent'});if(r.ok||r.error.code!=='FLOW_REVIEW_NOT_READY')throw new Error('VIDEO_REWORK_GATE_BYPASSED');};
    if(${phase === 'execute'}){
      const config=(role,allowedNodeIds)=>JSON.stringify({schemaVersion:1,role,interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:role==='coordinator'?'agent.dispatch':'node.execute',version:'1'},...(role==='coordinator'?[{id:'review.execute',version:'1'}]:[])],allowedNodeIds,maxSteps:20,relations:role==='coordinator'?[{relationId:'state',kind:'observes',sourceNodeId:'shape:c3-agent',targetNodeId:'shape:rework-state'}]:[]});
      const nodes=[{id:'shape:c3-agent',nodeType:'agent',title:'主 Agent',text:'按审核反馈返工并交付视频',config:config('coordinator',['shape:video-agent','shape:approved-agent','shape:visual-review'])},{id:'shape:video-agent',nodeType:'agent',title:'视频专业 Agent',text:'调用视频节点生成一次视频并交付；返工只执行同一个视频节点',config:config('specialist',['shape:video-target'])},{id:'shape:approved-agent',nodeType:'agent',title:'审核后处理',text:'调用数据处理节点并交付已批准视频信息',config:config('specialist',['shape:approved-process'])},{id:'shape:video-target',nodeType:'video',title:'视频生成',text:'',config:JSON.stringify({mode:'text',modelKey:'video-test::doubao-seedance-2-0',params:{}})},{id:'shape:video-prompt',nodeType:'text',title:'视频目标',text:'private-c3-video-prompt'},{id:'shape:approved-process',nodeType:'processor',title:'已批准视频信息',config:JSON.stringify({operation:'pass'})},{id:'shape:visual-review',nodeType:'ai-review',title:'抽帧审核与有界返工',text:'private-c3-video-rule：四张样本必须均为红色画面；其他颜色拒绝并要求重新生成红色视频，不判断音轨与完整时序。',config:JSON.stringify({schemaVersion:1,reviewMode:'sampled-video',modelDefinitionId:'agent-test-model',rulesVersion:'visual-1',rejectPolicy:'rework',maxReworks:1,responsibleNodeId:'shape:video-agent',subjectSources:[{nodeId:'shape:video-target',portId:'out-video'}],gatedNodeIds:['shape:approved-agent','shape:approved-process'],relations:[]})}];
      nodes.forEach(({id,...props},i)=>editor.createShape({id,type:'node-card',x:100+(i%4)*430,y:100+Math.floor(i/4)*650,props}));
      editor.createShape({id:'shape:rework-state',type:'node-card',x:100,y:1450,props:{nodeType:'state-machine',title:'流程状态',config:JSON.stringify({schemaVersion:1,initialState:'draft',states:['draft','working','waiting','completed'],transitions:[{from:'draft',event:'flow.started',to:'working'},...['agent.dispatched','agent.completed','human.wait','flow.paused','flow.completed','review.started','review.passed','review.rejected','rework.created'].map(event=>({from:'working',event,to:event==='flow.completed'?'completed':['human.wait','flow.paused'].includes(event)?'waiting':'working'})),{from:'waiting',event:'human.continue',to:'working'}],relations:[]})}});
      const {createEdge}=await import('/src/canvas/graph.ts');
      for(const to of ['shape:video-agent','shape:video-target'])if(!createEdge(editor,{shapeId:'shape:video-prompt',portId:'out-text'},{shapeId:to,portId:'in-text'}))throw new Error('VIDEO_REWORK_EDGE_MISSING');
      for(const [from,port,to,input] of [['shape:video-target','out-video','shape:visual-review','in-video'],['shape:video-agent','out-json','shape:approved-agent','in-json'],['shape:video-agent','out-json','shape:approved-process','in-value']])if(!createEdge(editor,{shapeId:from,portId:port},{shapeId:to,portId:input}))throw new Error('VIDEO_REWORK_EDGE_MISSING');
      await ensureCanvasSaved();await blocked();const root=await run('shape:c3-agent'),child=await read('shape:video-agent');
      if(root.state!=='waiting'||child?.state!=='waiting'||child.waitKind!=='reconcile'){window.__reviewAcceptanceStage=JSON.stringify({root:root.state,rootCode:root.code,child:child?.state,childCode:child?.code,wait:child?.waitKind});throw new Error('VIDEO_REWORK_UNKNOWN_NOT_HELD');}
      const decision=JSON.parse(editor.getShape('shape:visual-review').meta.nodeResult);if(decision.passed||decision.evidenceScope!=='sampled')throw new Error('VIDEO_REWORK_NEGATIVE_MISSING');await blocked();
      if(editor.getShape('shape:approved-process').meta.nodeRun)throw new Error('VIDEO_REWORK_DOWNSTREAM_EARLY');
      return {projectId,taskId:root.taskId,rejectedReviewId:decision.reviewId,rejectedVersionId:decision.subjects[0].versionId,checks:['main dispatches real video generation and sampled review','negative review creates a new immutable rework task','frozen feedback reaches the second supplier POST','unknown rework holds original command and blocks downstream']};
    }
    await blocked();let child=await read('shape:video-agent');
    const reconciled=value(await window.api.runFlowAgent({projectId,nodeId:'shape:video-agent',action:'reconcile',eventId:crypto.randomUUID(),requestId:crypto.randomUUID(),expectedTaskId:child.taskId,expectedWaitRevision:child.waitRevision,traceId:crypto.randomUUID(),spanId:crypto.randomUUID()}));
    if(reconciled.task.code!=='FLOW_VIDEO_RECONCILE_READY')throw new Error('VIDEO_REWORK_RECOVERY_NOT_READY');
    child=await run('shape:video-agent');if(child.state!=='completed')throw new Error('VIDEO_REWORK_CHILD_NOT_COMPLETED');
    const root=await run('shape:c3-agent');if(root.state!=='completed')throw new Error('VIDEO_REWORK_MAIN_NOT_COMPLETED');
    const decision=JSON.parse(editor.getShape('shape:visual-review').meta.nodeResult);if(!decision.passed||decision.evidenceScope!=='sampled'||decision.reviewRevision!==1)throw new Error('VIDEO_REWORK_APPROVAL_MISSING');
    if(editor.getShape('shape:approved-process').meta.nodeRun?.status!=='success')throw new Error('VIDEO_REWORK_DOWNSTREAM_MISSING');
    editor.centerOnPoint(editor.getShapePageBounds('shape:visual-review').center,{animation:{duration:0}});
    return {projectId,taskId:root.taskId,reviewId:decision.reviewId,approvedVersionId:decision.subjects[0].versionId,checks:['two-process recovery resumes original unknown supplier task','no third POST or duplicate download','new generated fixed version passes second sampled review','same main control loop releases actual downstream processing','old rejected video remains a separate immutable asset']};
  })()`)
  const db = getDb(),
    count = (key: string): number =>
      Number(
        (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string }).value
      )
  if (
    count('video-rework-posts') !== 2 ||
    count('video-rework-downloads') !== (phase === 'execute' ? 1 : 2)
  )
    throw new Error('VIDEO_REWORK_SUPPLIER_DUPLICATED')
  await window.webContents.executeJavaScript(
    `(async()=>{const d=await import('/src/engine/diagnosticsReporter.ts');while(d.pendingDiagnosticsEventCount())d.flushDiagnosticsEvents();await new Promise(done=>setTimeout(done,100));if(d.diagnosticsTransportDropCount())throw new Error('VIDEO_REWORK_DIAGNOSTICS_DROPPED');})()`
  )
  if (phase === 'reopen') {
    const reviews = (
      db
        .prepare(
          "SELECT body_json FROM flow_reviews WHERE project_id=? AND node_id='shape:visual-review' ORDER BY rowid"
        )
        .all(input.projectId) as { body_json: string }[]
    ).map((row) => JSON.parse(row.body_json).decision as ReviewDecision)
    if (
      reviews.length !== 2 ||
      reviews[0].passed ||
      !reviews[1].passed ||
      reviews[0].subjects[0].versionId === reviews[1].subjects[0].versionId
    )
      throw new Error('VIDEO_REWORK_REVIEW_HISTORY_INVALID')
    for (const review of reviews) assertVideoReviewEvidence(db, input.projectId, review)
    const tasks = db
      .prepare(
        "SELECT snapshot_json FROM flow_agent_tasks WHERE agent_node_id='shape:video-agent' ORDER BY rowid"
      )
      .all() as { snapshot_json: string }[]
    const snapshots = tasks.map((row) => JSON.parse(row.snapshot_json))
    if (
      snapshots.length !== 2 ||
      !snapshots[1].rework ||
      snapshots[1].parentTaskId !== snapshots[0].taskId ||
      JSON.stringify(snapshots[0].targets) !== JSON.stringify(snapshots[1].targets) ||
      JSON.stringify(snapshots[0].directInputs) !== JSON.stringify(snapshots[1].directInputs)
    )
      throw new Error('VIDEO_REWORK_SNAPSHOT_DRIFT')
    if (JSON.stringify(snapshots[1].rework.rejectedOutputs) !== JSON.stringify(reviews[0].subjects))
      throw new Error('VIDEO_REWORK_REJECTED_VERSION_DRIFT')
    await window.webContents.executeJavaScript(
      'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'
    )
    window.webContents.invalidate()
    await new Promise((done) => setTimeout(done, 300))
    writeFileSync(
      join(directory, 'video-review.png'),
      (await window.webContents.capturePage()).toPNG()
    )
  }
  return { ...(report as object), supplierPosts: 2, downloads: count('video-rework-downloads') }
}
